/**
 * Run artifact 生命周期（§12 / §14.8）：
 *   prepare（lease fencing + 幂等） -> 流式上传（内容寻址 quarantine） -> 独立 scanner -> 一次性下载。
 * 控制面永不解压 artifact.zip；扫描由独立 scanner 进程调用 scanArtifact 完成。
 */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { ApiError, rejectUnknownFields } from './errors.js'
import { canonicalize, documentSha256 } from '../contracts/version.mjs'
import { uuidv7 } from './ids.js'
import { requireRepoPermission } from './auth.js'
import { loadActiveLease, rememberWorkerOp } from './leases.js'
import { readZipCentralEntries } from '../scanner/zipscan.mjs'

export const ARCHIVE_MAX_BYTES = 500 * 1024 * 1024
export const FILE_MAX_BYTES = 10 * 1024 * 1024
export const ARTIFACT_RETENTION_DAYS = 14
export const DOWNLOAD_TTL_SECONDS = 300

const TEXT_EXT = /\.(xml|json|log|txt|md)$/i
const ALLOWED_EXT = /\.(xml|json|log|txt|png|jpg|jpeg|webm|zip|har)$/i
const MAX_ENTRIES = 1000

function sha256HexBuf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function hmacKeyFile(dataRoot) {
  const dir = dataRoot || path.join(process.cwd(), 'data')
  mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'artifact-url-hmac.key')
  if (!existsSync(p)) {
    writeFileSync(p, createHash('sha256').update(String(process.pid) + String(Date.now())).digest('hex'), { mode: 0o600 })
  }
  try { chmodSync(p, 0o600) } catch { /* 只读卷时忽略 */ }
  return readFileSync(p, 'utf8').trim()
}

export async function prepareRunArtifact(db, blobs, worker, leaseId, body, { now = new Date() } = {}) {
  rejectUnknownFields(body, [
    'runId', 'workerId', 'attempt', 'leaseEpoch', 'leaseToken',
    'artifactSha256', 'artifactManifestSha256', 'size', 'artifactTruncated',
  ])
  if (body.workerId !== worker.worker_id) throw new ApiError('STALE_LEASE')
  if (!/^[a-f0-9]{64}$/.test(body.artifactSha256) || !/^[a-f0-9]{64}$/.test(body.artifactManifestSha256)) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (!Number.isInteger(body.size) || body.size < 1 || body.size > ARCHIVE_MAX_BYTES) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (body.artifactTruncated !== 0 && body.artifactTruncated !== 1) throw new ApiError('INVALID_SCHEMA')
  const nowIso = now.toISOString()
  const tx = async (tx) => {
    const remembered = await rememberWorkerOp(tx, {
      workerId: worker.worker_id,
      leaseId,
      operation: 'artifact_prepare',
      operationSeq: 0,
      requestBody: body,
      now: nowIso,
      produce: async () => {
        const lease = await loadActiveLease(tx, {
          leaseId,
          workerId: worker.worker_id,
          runId: body.runId,
          attempt: body.attempt,
          leaseEpoch: body.leaseEpoch,
          leaseToken: body.leaseToken,
          nowIso,
        })
        const run = await tx.prepare('SELECT * FROM test_runs WHERE run_id=?').get(lease.run_id)
        if (!run) throw new ApiError('STALE_LEASE')
        const existing = await tx.prepare(
          'SELECT * FROM artifacts WHERE run_id=? AND attempt=?'
        ).get(lease.run_id, lease.attempt)
        if (existing) {
          if (existing.manifest_sha256 !== body.artifactManifestSha256
            || existing.archive_sha256 !== body.artifactSha256
            || existing.size !== body.size) {
            throw new ApiError('ARTIFACT_HASH_MISMATCH')
          }
          return { status: 200, data: { artifactId: existing.artifact_id, uploadId: null, uploadUrl: null, expiresAt: null } }
        }
        const prep = blobs.prepare({
          kind: 'run-artifact', sha256: body.artifactSha256, size: body.size,
        })
        const artifactId = uuidv7()
        await tx.prepare(
          `INSERT INTO artifacts(
             artifact_id, run_id, attempt, repo_id, binding_id, storage_key,
             manifest_sha256, archive_sha256, size, artifact_truncated, scan_state,
             created_at, expire_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).run(
          artifactId,
          lease.run_id,
          lease.attempt,
          lease.repo_id,
          run.binding_id,
          `artifacts/${artifactId}`,
          body.artifactManifestSha256,
          body.artifactSha256,
          body.size,
          body.artifactTruncated,
          nowIso,
          new Date(Date.parse(nowIso) + ARTIFACT_RETENTION_DAYS * 24 * 3600 * 1000).toISOString()
        )
        return {
          status: 200,
          data: {
            artifactId,
            uploadId: prep.uploadId,
            uploadUrl: prep.uploadId ? `/v1/runner/artifact-uploads/${prep.uploadId}` : null,
            expiresAt: prep.expiresAt,
          },
        }
      },
    })
    return remembered.data
  }
  return await db.tx(tx)
}

export async function markArtifactUploaded(db, blobs, worker, { archiveSha256, size }, { now = new Date() } = {}) {
  void blobs
  void now
  const rows = await db.prepare(
    `SELECT a.artifact_id, ra.worker_id
     FROM artifacts a
     JOIN run_attempts ra ON ra.run_id=a.run_id AND ra.attempt=a.attempt
     WHERE a.archive_sha256=? AND a.size=? AND a.scan_state='pending'`
  ).all(archiveSha256, size)
  const mine = rows.filter((r) => r.worker_id === worker.worker_id).map((r) => r.artifact_id)
  if (!mine.length) throw new ApiError('ARTIFACT_HASH_MISMATCH')
  return mine
}

export function artifactContentReady(db, blobs, artifactRow) {
  void db
  if (artifactRow.scan_state === 'rejected') return false
  return existsSync(blobs.contentPath(artifactRow.archive_sha256))
}

export async function scanArtifact(db, blobs, artifactId, { now = new Date() } = {}) {
  const row = await db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(artifactId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (row.scan_state !== 'pending') {
    return {
      artifactId,
      verdict: row.scan_state === 'passed' ? 'pass' : 'reject',
      violations: [],
      entryCount: 0,
      reportSha256: row.scanner_report_sha256,
    }
  }
  const contentPath = blobs.contentPath(row.archive_sha256)
  const violations = []
  let entryCount = 0
  if (!existsSync(contentPath)) {
    violations.push('archive-missing')
  } else {
    let entries = []
    try {
      entries = readZipCentralEntries(readFileSync(contentPath))
    } catch (err) {
      violations.push(`zip-parse:${err.code || err.message}`)
    }
    entryCount = entries.length
    if (entries.length > MAX_ENTRIES) violations.push('too-many-entries')
    const seen = new Set()
    let totalUncompressed = 0
    for (const e of entries) {
      if (seen.has(e.name)) violations.push(`dup-entry:${e.name}`)
      seen.add(e.name)
      if (e.name.includes('\\') || e.name.startsWith('/') || /^[a-zA-Z]:/.test(e.name)
        || e.name.split('/').some((p) => p === '..' || p === '')) {
        violations.push(`zip-slip:${e.name}`)
        continue
      }
      if (!ALLOWED_EXT.test(e.name)) violations.push(`extension:${e.name}`)
      if (e.encrypted) violations.push(`encrypted:${e.name}`)
      if (e.method !== 0 && e.method !== 8) violations.push(`method:${e.name}`)
      if (e.uncompressedSize > FILE_MAX_BYTES) violations.push(`file-too-large:${e.name}`)
      totalUncompressed += e.uncompressedSize
      if (TEXT_EXT.test(e.name) && e.uncompressedSize <= 1024 * 1024) {
        try {
          const text = e.inflate().toString('utf8')
          if (/npm_[0-9a-zA-Z]{20,}/.test(text)
            || /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/.test(text)) {
            violations.push(`secret-leak:${e.name}`)
          }
        } catch { violations.push(`inflate:${e.name}`) }
      }
    }
    if (totalUncompressed > ARCHIVE_MAX_BYTES) violations.push('archive-too-large')
  }
  const verdict = violations.length ? 'reject' : 'pass'
  const reportJson = canonicalize({
    schemaVersion: 1,
    artifactId,
    verdict,
    violations,
    entryCount,
    scannedAt: now.toISOString(),
  })
  const reportSha = sha256HexBuf(Buffer.from(reportJson, 'utf8'))
  const reportPrep = blobs.prepare({
    kind: 'scanner-report',
    sha256: reportSha,
    size: Buffer.byteLength(reportJson, 'utf8'),
  })
  if (reportPrep.uploadId) blobs.writeUploadBuffer(reportPrep.uploadId, Buffer.from(reportJson, 'utf8'))
  await db.prepare(
    `UPDATE artifacts SET scan_state=?, scanner_report_sha256=? WHERE artifact_id=? AND scan_state='pending'`
  ).run(verdict === 'pass' ? 'passed' : 'rejected', reportSha, artifactId)
  return { artifactId, verdict, violations, entryCount, scannedAt: now.toISOString(), reportSha256: reportSha }
}

export function issueArtifactDownloadUrl(db, { artifact, principal, now = new Date(), dataRoot } = {}) {
  if (!artifact || artifact.deleted_at) throw new ApiError('INVALID_SCHEMA')
  if (artifact.scan_state !== 'passed') throw new ApiError('PRECONDITION_FAILED')
  requireRepoPermission(principal, artifact.repo_id, 'read_result')
  const exp = Math.floor(now.getTime() / 1000) + DOWNLOAD_TTL_SECONDS
  const payload = { artifactId: artifact.artifact_id, runId: artifact.run_id, principalId: principal.principalId, exp }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const sig = createHmac('sha256', hmacKeyFile(dataRoot)).update(body).digest('base64url')
  return {
    artifactId: artifact.artifact_id,
    url: `/v1/test-runs/${artifact.run_id}/artifact/content?token=${body}.${sig}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  }
}

export async function consumeArtifactDownload(db, { runId, token, now = new Date(), dataRoot } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) throw new ApiError('INVALID_SCHEMA')
  const body = token.slice(0, token.lastIndexOf('.'))
  const sig = token.slice(token.lastIndexOf('.') + 1)
  const expected = createHmac('sha256', hmacKeyFile(dataRoot)).update(body).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError('INVALID_SCHEMA')
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (payload.runId !== runId || !payload.exp || payload.exp * 1000 <= now.getTime()) {
    throw new ApiError('INVALID_SCHEMA')
  }
  const tokenHash = sha256HexBuf(Buffer.from(token, 'utf8'))
  try {
    await db.prepare(
      `INSERT INTO idempotency_records(
         principal_id, repo_id, route, idempotency_key, request_sha256, response_status, response_json,
         created_at, expire_at
       ) VALUES (?, NULL, 'artifact-download', ?, ?, 200, ?, ?, ?)`
    ).run(
      payload.principalId,
      tokenHash,
      tokenHash,
      JSON.stringify({ artifactId: payload.artifactId }),
      now.toISOString(),
      new Date(now.getTime() + 24 * 3600 * 1000).toISOString()
    )
  } catch {
    throw new ApiError('IDEMPOTENCY_KEY_REUSED')
  }
  const row = await db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(payload.artifactId)
  if (!row || row.run_id !== runId || row.deleted_at) throw new ApiError('INVALID_SCHEMA')
  if (row.scan_state !== 'passed') throw new ApiError('PRECONDITION_FAILED')
  return row
}
