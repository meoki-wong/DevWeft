import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import express from 'express'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer, createPrincipal, grantRepoPermissions, issueToken } from '../testing/auth.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'
import { documentSha256 } from '../contracts/version.mjs'
import {
  acquireLease, acceptLease, completeLease, heartbeatLease,
} from '../testing/leases.js'
import { generateEd25519Pem, publicKeySha256, signCanonical } from '../testing/signing.js'
import { executeAcceptedRunInProcess } from '../runner/host-worker/index.mjs'
import { verifyGuestSidecar } from '../runner/host-worker/sidecar-verify.mjs'
import { executeGuestAttempt } from '../runner/guest-agent/index.mjs'
import { buildArtifact, buildJunitXml, redactText } from '../runner/guest-agent/artifact.mjs'
import { createZip } from '../runner/guest-agent/zip.mjs'
import { readZipCentralEntries } from '../scanner/zipscan.mjs'
import {
  prepareRunArtifact, markArtifactUploaded, issueArtifactDownloadUrl, consumeArtifactDownload, scanArtifact,
} from '../testing/artifacts.js'
import { mountTestingRoutes } from '../testing/routes.js'
import { ApiError } from '../testing/errors.js'
import { utcNow } from '../testing/ids.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-art-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const OID = 'b'.repeat(40)

async function submitS(db, boot, { taskId = 'T-A-1' } = {}) {
  const now = new Date().toISOString()
  const taskInstanceId = `018f0000-0000-7000-8000-0000000000${taskId.slice(-2)}`
  await db.prepare(
    `INSERT INTO task_instances(
       task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'S', 'open', ?, ?, ?)`
  ).run(taskInstanceId, boot.repoId, taskId, boot.principalId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)`
  ).run(boot.repoId, taskId, taskInstanceId, now)
  const principal = await authenticateBearer(db, `Bearer ${boot.token}`)
  const blobDir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
  const blobs = createBlobStore(blobDir)
  const payload = Buffer.from('git-bundle-bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const prep = blobs.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
  await blobs.writeUpload(prep.uploadId, payload)
  const created = await createTestSubmission(db, blobs, {
    clientRequestId: `018f0000-0000-7000-8000-00000000${Math.random().toString(16).slice(2, 10)}`,
    repoId: boot.repoId,
    sourceRemoteId: boot.remoteId,
    branchIncarnationId: null,
    taskInstanceId: taskId,
    expectedTaskRevision: 1,
    git: {
      objectFormat: 'sha1',
      sourceRef: 'refs/heads/feature-x',
      headCommitOid: OID,
      snapshotCommitOid: OID,
      snapshotTreeOid: OID,
      changedPathsSha256: documentSha256([]),
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
    },
    bundle: { sha256: sha, size: payload.length },
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
  return { created, blobDir, blobs }
}

async function leaseAndAccept(db, created) {
  const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'art-worker' })
  const reservation = await acquireLease(db, worker)
  const guest = generateEd25519Pem()
  const accepted = await acceptLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    guestPublicKey: guest.publicKeyPem,
    guestKeySha256: publicKeySha256(guest.publicKeyPem),
  })
  return { worker, reservation, guest, accepted }
}

async function readArtifactFromDb(db, runId) {
  return await db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY attempt DESC').get(runId)
}

describe('M3.4 zip, redaction and sidecar signing', () => {
  it('zip writer output is deterministic and readable by the scanner', async () => {
    const entries = [
      { name: 'junit.xml', data: Buffer.from('<testsuites/>') },
      { name: 'logs/中文日志.log', data: Buffer.from('hello awp\n') },
    ]
    const a = createZip(entries)
    const b = createZip([...entries].reverse())
    expect(a.equals(b)).toBe(true)
    const parsed = readZipCentralEntries(a)
    expect(parsed.map((e) => e.name)).toEqual(['junit.xml', 'logs/中文日志.log'])
    expect(parsed[0].uncompressedSize).toBe(13)
    expect(parsed[0].inflate().toString()).toBe('<testsuites/>')
  })

  it('redacts npm tokens, bearer headers and passwords from text output', async () => {
    const text = [
      '//_authToken=npm_0123456789abcdefghij0123456789abcd',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
      'password=hunter2secret',
      'const n = 1',
    ].join('\n')
    const out = redactText(text)
    expect(out).not.toContain('npm_0123456789')
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).not.toContain('hunter2secret')
    expect(out).toContain('//_authToken=[REDACTED]')
    expect(out).toContain('const n = 1')
  })

  it('builds artifact zip with junit results and enforces per-file caps', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'awp-artout-'))
    const outDir = join(runDir, 'output')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'install.log'), 'npm warn deprecated x\n'.repeat(10))
    const checks = [
      { caseKey: 'test:static/eslint', status: 'passed', durationMs: 12 },
      { caseKey: 'test:static/eslint2', status: 'failed', durationMs: 34 },
    ]
    const small = buildArtifact({ runDir, checks })
    expect(small.artifactTruncated).toBe(false)
    const entries = readZipCentralEntries(small.archive)
    expect(entries.map((e) => e.name)).toContain('junit.xml')
    expect(entries.map((e) => e.name)).toContain('resource-usage.json')
    expect(entries.map((e) => e.name)).toContain('install.log')
    const junit = entries.find((e) => e.name === 'junit.xml').inflate().toString()
    expect(junit).toContain('test:static/eslint')
    expect(junit).toContain('failure')
    const truncated = buildArtifact({
      runDir, checks, fileMaxBytes: 32, archiveMaxBytes: 4096,
    })
    expect(truncated.artifactTruncated).toBe(true)
    const logEntry = readZipCentralEntries(truncated.archive).find((e) => e.name === 'install.log')
    expect(logEntry.uncompressedSize).toBeLessThanOrEqual(64)
    rmSync(runDir, { recursive: true, force: true })
  })

  it('signs sidecar documents and rejects tampering', async () => {
    const runSpec = {
      runId: 'r', attempt: 1, leaseEpoch: 1, bindingId: 'b', sourceBlobSha256: 's',
      suiteLockSha256: 'l', runnerImageId: 'i', runnerImageManifestSha256: 'im',
    }
    const guest = generateEd25519Pem()
    const result = { schemaVersion: 1, runId: 'r', attempt: 1, leaseEpoch: 1, bindingId: 'b', status: 'passed', checks: [] }
    const archiveSha = createHash('sha256').update('x').digest('hex')
    const manifest = {
      schemaVersion: 1, runId: 'r', attempt: 1, leaseEpoch: 1, bindingId: 'b',
      sourceSha256: 's', suiteLockSha256: 'l', imageId: 'i', imageManifestSha256: 'im',
      resultSha256: documentSha256(result), archiveSha256: archiveSha, files: [], totalSize: 0, artifactTruncated: false,
    }
    const resultSig = signCanonical(guest.privateKeyPem, result)
    const manifestSig = signCanonical(guest.privateKeyPem, manifest)
    // 归档哈希不匹配：Guest 合法签署的 manifest 声称的 archiveSha256 与实际归档不符
    const manifestBad = { ...manifest, archiveSha256: 'a'.repeat(64) }
    expect(() => verifyGuestSidecar({
      runSpec, result, manifest: manifestBad,
      resultSig,
      manifestSig: signCanonical(guest.privateKeyPem, manifestBad),
      guestPublicKeyPem: guest.publicKeyPem,
      archiveBuffer: Buffer.from('x'),
    })).toThrow('ARTIFACT_HASH_MISMATCH')
    // 签名被替换（其他 key 签的 manifest）
    const outsider = generateEd25519Pem()
    expect(() => verifyGuestSidecar({
      runSpec, result, manifest,
      resultSig,
      manifestSig: signCanonical(outsider.privateKeyPem, manifest),
      guestPublicKeyPem: guest.publicKeyPem,
      archiveBuffer: Buffer.from('x'),
    })).toThrow('RUNSPEC_SIGNATURE_INVALID')
    // 文档被篡改（签名还是旧的）
    expect(() => verifyGuestSidecar({
      runSpec, result,
      manifest: { ...manifest, totalSize: 1 },
      resultSig, manifestSig,
      guestPublicKeyPem: guest.publicKeyPem,
      archiveBuffer: Buffer.from('x'),
    })).toThrow('RUNSPEC_SIGNATURE_INVALID')
    const good = verifyGuestSidecar({
      runSpec, result, manifest, resultSig, manifestSig,
      guestPublicKeyPem: guest.publicKeyPem,
      archiveBuffer: Buffer.from('x'),
    })
    expect(good).toBe(true)
  })
})

describe('M3.4 guest + control-plane artifact flow', () => {
  it('guest attempt produces signed sidecar and a real artifact.zip', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created } = await submitS(db, boot)
    const { worker, reservation, guest, accepted } = await leaseAndAccept(db, created)
    await heartbeatLease(db, worker, reservation.leaseId, {
      runId: reservation.runId, workerId: worker.worker_id, attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch, leaseToken: reservation.leaseToken, operationSeq: 1,
    })
    const runDir = mkdtempSync(join(tmpdir(), 'awp-artguest-'))
    mkdirSync(join(runDir, 'workspace'), { recursive: true })
    writeFileSync(join(runDir, 'workspace', 'ok.js'), 'const n = 1\n')
    const plan = await db.prepare('SELECT canonical_lock_json FROM suite_plans WHERE suite_plan_id=?').get(created.suitePlanId)
    const sidecar = await executeGuestAttempt({
      runDir,
      runSpec: accepted.runSpec,
      runSpecSignature: accepted.runSpecSignature,
      runspecPublicKeyPem: (await db.prepare('SELECT public_key_pem FROM signing_keys WHERE key_id=?').get(accepted.signingKeyId)).public_key_pem,
      cases: JSON.parse(plan.canonical_lock_json).cases || [],
      guestPrivateKeyPem: guest.privateKeyPem,
    })
    const zipPath = join(runDir, 'output', 'artifact.zip')
    expect(existsSync(zipPath)).toBe(true)
    expect(existsSync(join(runDir, 'output', 'result.sig'))).toBe(true)
    expect(existsSync(join(runDir, 'output', 'manifest.sig'))).toBe(true)
    const archive = readFileSync(zipPath)
    const junit = readZipCentralEntries(archive).find((e) => e.name === 'junit.xml')
    expect(junit).toBeTruthy()
    expect(junit.inflate().toString()).toContain('testsuite')
    expect(sidecar.manifest.archiveSha256).toBe(createHash('sha256').update(archive).digest('hex'))
    rmSync(runDir, { recursive: true, force: true })
  })

  it('prepare/upload/complete marks the run passed and quarantines the artifact', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { worker, reservation, accepted } = await leaseAndAccept(db, created)
    await heartbeatLease(db, worker, reservation.leaseId, {
      runId: reservation.runId, workerId: worker.worker_id, attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch, leaseToken: reservation.leaseToken, operationSeq: 1,
    })
    const runDir = mkdtempSync(join(tmpdir(), 'awp-artflow-'))
    mkdirSync(join(runDir, 'workspace'), { recursive: true })
    mkdirSync(join(runDir, 'suite', 'fixtures'), { recursive: true })
    writeFileSync(join(runDir, 'workspace', 'ok.js'), 'const n = 1\n')
    copyFileSync(
      join(process.cwd(), 'suites', 'example-app', 'repo', 'fixtures', 'i18n.json'),
      join(runDir, 'suite', 'fixtures', 'i18n.json')
    )
    const plan = await db.prepare('SELECT canonical_lock_json FROM suite_plans WHERE suite_plan_id=?').get(created.suitePlanId)
    const sidecar = await executeGuestAttempt({
      runDir,
      runSpec: accepted.runSpec,
      runSpecSignature: accepted.runSpecSignature,
      runspecPublicKeyPem: (await db.prepare('SELECT public_key_pem FROM signing_keys WHERE key_id=?').get(accepted.signingKeyId)).public_key_pem,
      cases: JSON.parse(plan.canonical_lock_json).cases || [],
      guestPrivateKeyPem: generateEd25519Pem().privateKeyPem,
    })
    // 未 prepare 就 complete 必须拒绝
    await expect(completeLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      bindingId: accepted.runSpec.bindingId,
      status: sidecar.result.status,
      resultSha256: sidecar.resultSha256,
      runnerImageId: accepted.runSpec.runnerImageId,
      runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
      checks: sidecar.result.checks,
      artifactManifestSha256: sidecar.manifestSha256,
    })).rejects.toThrow('ARTIFACT_HASH_MISMATCH')

    const blobs = createBlobStore(blobDir)
    const archive = readFileSync(join(runDir, 'output', 'artifact.zip'))
    const artifactSha = createHash('sha256').update(archive).digest('hex')
    const prep = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      artifactSha256: artifactSha,
      artifactManifestSha256: sidecar.manifestSha256,
      size: archive.length,
      artifactTruncated: 0,
    })
    expect(prep.uploadId).toBeTruthy()
    await blobs.writeUpload(prep.uploadId, archive)
    await markArtifactUploaded(db, blobs, worker, { archiveSha256: artifactSha, size: archive.length })

    await completeLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      bindingId: accepted.runSpec.bindingId,
      status: sidecar.result.status,
      resultSha256: sidecar.resultSha256,
      runnerImageId: accepted.runSpec.runnerImageId,
      runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
      checks: sidecar.result.checks,
      artifactManifestSha256: sidecar.manifestSha256,
    })
    const run = await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)
    expect(run.status).toBe('passed')
    const row = await readArtifactFromDb(db, reservation.runId)
    expect(row).toBeTruthy()
    expect(row.archive_sha256).toBe(artifactSha)
    expect(row.manifest_sha256).toBe(sidecar.manifestSha256)
    expect(row.scan_state).toBe('pending')
    expect(row.storage_key).toContain(row.artifact_id)
    const att = await db.prepare('SELECT * FROM run_attestations WHERE run_id=?').get(reservation.runId)
    expect(att.artifact_sha256).toBe(artifactSha)
    rmSync(runDir, { recursive: true, force: true })
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('artifact prepare is fenced, replayed identically and rejects differing payloads', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { worker, reservation } = await leaseAndAccept(db, created)
    const blobs = createBlobStore(blobDir)
    const body = {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      artifactSha256: 'a'.repeat(64),
      artifactManifestSha256: 'c'.repeat(64),
      size: 123,
      artifactTruncated: 0,
    }
    const first = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, body)
    expect(first.uploadId).toBeTruthy()
    const replay = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, body)
    expect(replay.artifactId).toBe(first.artifactId)
    // §14.9：同 key 不同 payload 一律 409（包含换 token 的情况，fencing 由幂等记录承载）
    await expect(prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
      ...body, size: 456,
    })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED')
    await expect(prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
      ...body, leaseToken: 'wrong-token-wrong-token-wrong-token12',
    })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED')
    rmSync(blobDir, { recursive: true, force: true })
  })
})

describe('M3.4 independent scanner', () => {
  // 一次 attempt 只允许一个 artifact（prepare 幂等 + (run,attempt) 唯一），故每个 zip 变体独立提交
  async function stagedArtifact(db, boot, taskId, zipBuf, manifestSha) {
    const { created, blobDir, blobs } = await submitS(db, boot, { taskId })
    const { worker, reservation } = await leaseAndAccept(db, created)
    const sha = createHash('sha256').update(zipBuf).digest('hex')
    const prep = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      artifactSha256: sha,
      artifactManifestSha256: manifestSha,
      size: zipBuf.length,
      artifactTruncated: 0,
    })
    if (prep.uploadId) await blobs.writeUpload(prep.uploadId, zipBuf)
    await markArtifactUploaded(db, blobs, worker, { archiveSha256: sha, size: zipBuf.length })
    const row = await db.prepare('SELECT * FROM artifacts WHERE manifest_sha256=?').get(manifestSha)
    expect(row).toBeTruthy()
    return { blobs, row, blobDir }
  }

  it('passes a clean artifact and rejects zip-slip and secret leaks', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })

    const cleanZip = createZip([{ name: 'logs/install.log', data: Buffer.from('npm warn deprecated x\n') }])
    const clean = await stagedArtifact(db, boot, 'T-A-9', cleanZip, 'd'.repeat(64))
    const cleanReport = await scanArtifact(db, clean.blobs, clean.row.artifact_id)
    expect(cleanReport.verdict).toBe('pass')
    expect((await db.prepare('SELECT scan_state FROM artifacts WHERE artifact_id=?').get(clean.row.artifact_id)).scan_state).toBe('passed')
    expect(cleanReport.reportSha256).toBeTruthy()
    rmSync(clean.blobDir, { recursive: true, force: true })

    // scanner 测试需要构造 guest writer 正常情况下拒绝产生的恶意条目
    const slipZip = createZip([{ name: '../evil.txt', data: Buffer.from('x') }], { validateNames: false })
    const slip = await stagedArtifact(db, boot, 'T-A-8', slipZip, 'e'.repeat(64))
    const slipReport = await scanArtifact(db, slip.blobs, slip.row.artifact_id)
    expect(slipReport.verdict).toBe('reject')
    expect(slipReport.violations.join(' ')).toMatch(/\.\./)
    rmSync(slip.blobDir, { recursive: true, force: true })

    const leakZip = createZip([{ name: 'logs/install.log', data: Buffer.from('token=npm_0123456789abcdefghij0123456789abcd\n') }])
    const leak = await stagedArtifact(db, boot, 'T-A-7', leakZip, 'f'.repeat(64))
    const leakReport = await scanArtifact(db, leak.blobs, leak.row.artifact_id)
    expect(leakReport.verdict).toBe('reject')
    expect(leakReport.violations.join(' ')).toMatch(/secret/)
    rmSync(leak.blobDir, { recursive: true, force: true })
  })
})

describe('M3.4 artifact download', () => {
  it('issues a 5-minute one-time ACL-checked URL and streams the archive once', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-A-3' })
    const { worker, reservation } = await leaseAndAccept(db, created)
    const blobs = createBlobStore(blobDir)
    const archive = createZip([{ name: 'junit.xml', data: Buffer.from('<testsuites/>') }])
    const sha = createHash('sha256').update(archive).digest('hex')
    const manifestSha = '1'.repeat(64)
    const prep = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      artifactSha256: sha,
      artifactManifestSha256: manifestSha,
      size: archive.length,
      artifactTruncated: 0,
    })
    await blobs.writeUpload(prep.uploadId, archive)
    await markArtifactUploaded(db, blobs, worker, { archiveSha256: sha, size: archive.length })
    const row = await db.prepare('SELECT * FROM artifacts WHERE manifest_sha256=?').get(manifestSha)
    await scanArtifact(db, blobs, row.artifact_id)
    const scanned = await db.prepare('SELECT * FROM artifacts WHERE artifact_id=?').get(row.artifact_id)

    const admin = await authenticateBearer(db, `Bearer ${boot.token}`)
    const issued = issueArtifactDownloadUrl(db, { artifact: scanned, principal: admin, now: new Date() })
    expect(issued.url).toMatch(/\?token=/)
    const tokenValue = issued.url.split('token=')[1]
    const payload = JSON.parse(Buffer.from(tokenValue.split('.')[0], 'base64url').toString('utf8'))
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300)

    const consumed = await consumeArtifactDownload(db, { runId: reservation.runId, token: tokenValue, now: new Date() })
    expect(consumed.archive_sha256).toBe(sha)
    await expect(consumeArtifactDownload(db, {
      runId: reservation.runId, token: tokenValue, now: new Date(),
    })).rejects.toThrow('IDEMPOTENCY_KEY_REUSED')

    // 无 read_result 权限的 principal 不能签发下载 URL
    const otherPrincipalId = await createPrincipal(db, { subject: 'dev-art', displayName: 'Dev Art' })
    const otherToken = await issueToken(db, { principalId: otherPrincipalId })
    const otherPrincipal = await authenticateBearer(db, `Bearer ${otherToken.token}`)
    expect(() => issueArtifactDownloadUrl(db, {
      artifact: scanned,
      principal: otherPrincipal,
      now: new Date(),
    })).toThrow(ApiError)
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('serves prepare/upload/complete over HTTP runner routes', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-A-4' })
    const { worker, reservation, accepted } = await leaseAndAccept(db, created)
    const blobRoot = blobDir
    const app = express()
    app.use(express.json({ limit: '50mb' }))
    mountTestingRoutes(app, { database: db, blobRoot })
    const server = app.listen(0)
    await new Promise((r) => server.on('listening', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const headers = {
      'content-type': 'application/json',
      'x-worker-id': worker.worker_id,
      'x-worker-cert-thumbprint': worker.certificate_thumbprint,
    }

    const hb = await fetch(`${base}/v1/runner/leases/${reservation.leaseId}:heartbeat`, {
      method: 'POST', headers,
      body: JSON.stringify({
        runId: reservation.runId, workerId: worker.worker_id, attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch, leaseToken: reservation.leaseToken, operationSeq: 1,
      }),
    })
    expect(hb.status).toBe(200)

    const archive = createZip([{ name: 'junit.xml', data: Buffer.from('<testsuites/>') }])
    const sha = createHash('sha256').update(archive).digest('hex')
    const manifestSha = '2'.repeat(64)
    const prepRes = await fetch(`${base}/v1/runner/leases/${reservation.leaseId}/artifact:prepare`, {
      method: 'POST', headers,
      body: JSON.stringify({
        runId: reservation.runId, workerId: worker.worker_id, attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch, leaseToken: reservation.leaseToken,
        artifactSha256: sha, artifactManifestSha256: manifestSha,
        size: archive.length, artifactTruncated: 0,
      }),
    })
    expect(prepRes.status).toBe(200)
    const prepBody = (await prepRes.json()).data
    expect(prepBody.uploadUrl).toContain('/v1/runner/artifact-uploads/')

    const upRes = await fetch(`${base}${prepBody.uploadUrl}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-worker-id': worker.worker_id,
        'x-worker-cert-thumbprint': worker.certificate_thumbprint,
      },
      body: archive,
    })
    expect(upRes.status).toBe(200)

    // 严格断言：错误摘要必须被精确拒绝（400/ARTIFACT_HASH_MISMATCH），随后正确摘要必须 200。
    // （旧断言 [200,400] 掩盖了"错误摘要被接受"的假绿路径。）
    const resultDoc = {
      schemaVersion: 1,
      runId: reservation.runId,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      bindingId: accepted.runSpec.bindingId,
      status: 'passed',
      checks: [],
    }
    const wrongRes = await fetch(`${base}/v1/runner/leases/${reservation.leaseId}:complete`, {
      method: 'POST', headers,
      body: JSON.stringify({
        workerId: worker.worker_id, leaseToken: reservation.leaseToken,
        ...resultDocFields(resultDoc),
        resultSha256: '3'.repeat(64),
        runnerImageId: accepted.runSpec.runnerImageId,
        runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
        artifactManifestSha256: manifestSha,
      }),
    })
    console.log('BIND-DBG run:', (await db.prepare('SELECT binding_id FROM test_runs WHERE run_id=?').get(reservation.runId))?.binding_id, 'spec:', accepted.runSpec.bindingId)
    console.log('WRONG-DBG status=', wrongRes.status, JSON.stringify(await wrongRes.clone().json().catch(() => null)))
    expect(wrongRes.status).toBe(400) // ARTIFACT_HASH_MISMATCH 映射 409 Conflict
    const wrongBody = await wrongRes.json()
    expect(JSON.stringify(wrongBody)).toContain('ARTIFACT_HASH_MISMATCH')

    const completeRes = await fetch(`${base}/v1/runner/leases/${reservation.leaseId}:complete`, {
      method: 'POST', headers,
      body: JSON.stringify({
        workerId: worker.worker_id, leaseToken: reservation.leaseToken,
        ...resultDocFields(resultDoc),
        resultSha256: documentSha256(resultDoc),
        runnerImageId: accepted.runSpec.runnerImageId,
        runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
        artifactManifestSha256: manifestSha,
      }),
    })
    expect(completeRes.status).toBe(200)
    // complete 后 run 终态必须为 passed
    const runRow = await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)
    expect(runRow.status).toBe('passed')
    server.close()
    rmSync(blobDir, { recursive: true, force: true })
  })
})

function resultDocFields(doc) {
  return {
    runId: doc.runId, attempt: doc.attempt, leaseEpoch: doc.leaseEpoch,
    bindingId: doc.bindingId, status: doc.status, checks: doc.checks,
  }
}

// 与 testing-m2.test.mjs 的 S 级闭环对齐：in-process host worker 全链路
describe('M3.4 in-process host worker keeps gate green with artifacts', () => {
  it('executeAcceptedRunInProcess prepares, uploads and completes', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-A-5' })
    const { worker, reservation, guest, accepted } = await leaseAndAccept(db, created)
    const runDir = mkdtempSync(join(tmpdir(), 'awp-artproc-'))
    mkdirSync(join(runDir, 'workspace'), { recursive: true })
    writeFileSync(join(runDir, 'workspace', 'ok.js'), 'const n = 1\n')
    const plan = await db.prepare('SELECT canonical_lock_json FROM suite_plans WHERE suite_plan_id=?').get(created.suitePlanId)
    const sidecar = await executeAcceptedRunInProcess({
      db, worker, reservation, accepted,
      cases: JSON.parse(plan.canonical_lock_json).cases || [],
      runDir,
      guestPrivateKeyPem: guest.privateKeyPem,
      blobRoot: blobDir,
    })
    expect(sidecar.result.status).toBe('passed')
    const row = await readArtifactFromDb(db, reservation.runId)
    expect(row.scan_state).toBe('pending')
    const run = await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)
    expect(run.status).toBe('passed')
    rmSync(runDir, { recursive: true, force: true })
    rmSync(blobDir, { recursive: true, force: true })
  })
})

// keep utcNow import used in one place to avoid lint noise
void utcNow
