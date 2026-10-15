import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import express from 'express'
import https from 'node:https'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer } from '../testing/auth.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'
import { documentSha256 } from '../contracts/version.mjs'
import { acquireLease, acceptLease, heartbeatLease, completeLease, rejectLease, reconcileRuns } from '../testing/leases.js'
import { generateEd25519Pem, publicKeySha256 } from '../testing/signing.js'
import { touchWorkerHeartbeat, sweepWorkerHeartbeats, cancelRun } from '../testing/workers.js'
import { runJanitor, janitorPlan } from '../runner/host-worker/janitor.mjs'
import { startGuestHeartbeat, readGuestHeartbeatAgeMs } from '../runner/guest-agent/guest-heartbeat.mjs'
import { generateDevPki } from '../scripts/gen-dev-pki.mjs'
import { certificateFingerprint256, loadOrCreateWorkerIdentity } from '../runner/host-worker/identity.mjs'
import { mountTestingRoutes } from '../testing/routes.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-hb-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const OID = 'b'.repeat(40)

async function submitS(db, boot, { taskId = 'T-H-1' } = {}) {
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO task_instances(
       task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'S', 'open', ?, ?, ?)`
  ).run(`018f0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`, boot.repoId, taskId, boot.principalId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)`
  ).run(boot.repoId, taskId, (await db.prepare('SELECT task_instance_id FROM task_instances WHERE external_task_id=?').get(taskId)).task_instance_id, now)
  const principal = await authenticateBearer(db, `Bearer ${boot.token}`)
  const blobDir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
  const blobs = createBlobStore(blobDir)
  const payload = Buffer.from('git-bundle-bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const prep = blobs.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
  await blobs.writeUpload(prep.uploadId, payload)
  const created = await createTestSubmission(db, blobs, {
    clientRequestId: `018f0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`,
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
      mr: null,
    },
    bundle: { sha256: sha, size: payload.length },
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
  return { created, blobDir, blobs }
}

async function acceptOnly(db, created) {
  const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'hb-worker' })
  const reservation = await acquireLease(db, worker)
  const guest = generateEd25519Pem()
  await acceptLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    guestPublicKey: guest.publicKeyPem,
    guestKeySha256: publicKeySha256(guest.publicKeyPem),
  })
  return { worker, reservation, guest }
}

describe('M3.2 worker heartbeat sweep', () => {
  it('marks workers offline after 60s silence and back active on heartbeat', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'w1' })
    const t0 = new Date('2026-09-05T08:00:00Z')
    await touchWorkerHeartbeat(db, worker.worker_id, { now: t0 })
    expect((await db.prepare('SELECT status FROM workers WHERE worker_id=?').get(worker.worker_id)).status).toBe('active')
    // 59 秒：仍在线
    await sweepWorkerHeartbeats(db, { now: new Date(t0.getTime() + 59_000) })
    expect((await db.prepare('SELECT status FROM workers WHERE worker_id=?').get(worker.worker_id)).status).toBe('active')
    // 61 秒：离线
    const swept = await sweepWorkerHeartbeats(db, { now: new Date(t0.getTime() + 61_000) })
    expect(swept).toContain(worker.worker_id)
    expect((await db.prepare('SELECT status FROM workers WHERE worker_id=?').get(worker.worker_id)).status).toBe('offline')
    // 心跳恢复
    await touchWorkerHeartbeat(db, worker.worker_id, { now: new Date(t0.getTime() + 120_000) })
    expect((await db.prepare('SELECT status FROM workers WHERE worker_id=?').get(worker.worker_id)).status).toBe('active')
  })
})

describe('M3.2 restart reconciliation', () => {
  it('requeues reserved attempts whose reservation expired, honoring retry limits', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'w2' })
    const reservation = await acquireLease(db, worker)
    // 不 accept，等 reservation 过期（30s）
    const report = await reconcileRuns(db, { now: new Date(Date.parse(reservation.reservationExpiresAt) + 1000) })
    expect(report.requeuedRuns).toContain(reservation.runId)
    expect((await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)).status).toBe('queued')
    // 第二个 worker 能领到（attempt=2, epoch=2）
    const worker2 = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'w3' })
    const second = await acquireLease(db, worker2)
    expect(second.runId).toBe(reservation.runId)
    expect(second.attempt).toBe(2)
    expect(second.leaseEpoch).toBe(2)
    // idempotent：再 reconcile 不动它
    const again = await reconcileRuns(db, { now: new Date() })
    expect(again.requeuedRuns).not.toContain(reservation.runId)
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('expires silent leased runs: retry twice then terminal error with lost reason', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { worker, reservation, guest } = await acceptOnly(db, created)
    // lease TTL 45s 后静默
    const report = await reconcileRuns(db, { now: new Date(Date.now() + 60_000) })
    expect(report.expiredLeases.map((r) => r.runId)).toContain(reservation.runId)
    // 可重试（next_attempt=1 < max_attempts=3）→ queued
    expect((await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)).status).toBe('queued')
    expect((await db.prepare('SELECT status FROM run_groups WHERE run_group_id=?').get(created.formalRunGroupId)).status).toBe('running')
    // 旧 lease complete 必须被拒绝（故障注入：僵死 worker 复活）
    await expect(completeLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      bindingId: created.bindingId,
      status: 'passed',
      resultSha256: 'a'.repeat(64),
      runnerImageId: 'win2025-pw-node22-20260903.1',
      runnerImageManifestSha256: 'b'.repeat(64),
      checks: [],
      artifactManifestSha256: 'c'.repeat(64),
    })).rejects.toThrow('STALE_LEASE')
    // 第二次静默（next_attempt=2 < 3）→ 仍 queued 继续重试
    const { reservation: r2 } = await acceptOnly(db, created)
    await reconcileRuns(db, { now: new Date(Date.now() + 200_000) })
    expect((await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(r2.runId)).status).toBe('queued')
    // 第三次静默耗尽重试：run 终态 error + lost，绝不映射成 failed
    const { reservation: r3 } = await acceptOnly(db, created)
    await reconcileRuns(db, { now: new Date(Date.now() + 200_000) })
    const runRow = await db.prepare('SELECT status, terminal_reason FROM test_runs WHERE run_id=?').get(r3.runId)
    expect(runRow.status).toBe('error')
    expect(runRow.terminal_reason).toBe('lost')
    expect((await db.prepare('SELECT status FROM run_groups WHERE run_group_id=?').get(created.formalRunGroupId)).status).toBe('error')
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('cancels runs via desired_state and revokes the active lease', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { worker, reservation, guest } = await acceptOnly(db, created)
    // 心跳仍会返回 desiredState=canceled（取消指令先于强制回收）
    const hb = await heartbeatLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      operationSeq: 1,
    })
    await cancelRun(db, { runId: reservation.runId })
    const hb2 = await heartbeatLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      operationSeq: 2,
    })
    expect(hb2.desiredState).toBe('canceled')
    await reconcileRuns(db, { now: new Date(Date.now() + 60_000) })
    const runRow = await db.prepare('SELECT status, terminal_reason FROM test_runs WHERE run_id=?').get(reservation.runId)
    expect(runRow.status).toBe('canceled')
    expect(runRow.terminal_reason).toBe('canceled')
    expect((await db.prepare('SELECT revoked_at FROM runner_leases WHERE lease_id=?').get(reservation.leaseId)).revoked_at).toBeTruthy()
    void hb
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('does not requeue canceled or gate-irrelevant terminal runs', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { worker, reservation, guest } = await acceptOnly(db, created)
    await rejectLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
    })
    const before = (await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)).status
    await reconcileRuns(db, { now: new Date(Date.now() + 120_000) })
    expect((await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(reservation.runId)).status).toBe(before)
    rmSync(blobDir, { recursive: true, force: true })
  })
})

describe('M3.2 janitor', () => {
  it('purges expired artifacts, idempotency and nonces; keeps active attempt dirs', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const runnerRoot = mkdtempSync(join(tmpdir(), 'awp-jan-'))
    const attemptDir = join(runnerRoot, 'attempts', 'run-gone')
    mkdirSync(attemptDir, { recursive: true })
    writeFileSync(join(attemptDir, 'diff.vhdx'), 'x')
    const past = new Date(Date.now() - 1000).toISOString()
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-H-9' })
    const { worker, reservation, guest } = await acceptOnly(db, created)
    const runRow = await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get(reservation.runId)
    const now = new Date()
    await db.prepare(`INSERT INTO artifacts(
        artifact_id, run_id, attempt, repo_id, binding_id, storage_key, manifest_sha256,
        archive_sha256, size, artifact_truncated, scan_state, created_at, expire_at
      ) VALUES ('018f0000-0000-7000-8000-0000000000j1', ?, 1, ?, ?, 'k', ?, ?, 1, 0, 'passed', ?, ?)`)
      .run(reservation.runId, runRow.repo_id, runRow.binding_id, '1'.repeat(64), '2'.repeat(64), past, past)
    void worker
    const plan = await janitorPlan(db, { runnerRoot, now })
    expect(plan.expiredArtifacts).toContain('018f0000-0000-7000-8000-0000000000j1')
    expect(plan.attemptDirResidue.map((p) => p.endsWith('run-gone'))).toContain(true)
    const result = await runJanitor(db, { runnerRoot, now })
    expect(result.artifactsMarkedDeleted).toBeGreaterThanOrEqual(1)
    expect((await db.prepare('SELECT deleted_at FROM artifacts WHERE artifact_id=?').get('018f0000-0000-7000-8000-0000000000j1')).deleted_at).toBeTruthy()
    expect(existsSync(attemptDir)).toBe(false)
    void created
    rmSync(runnerRoot, { recursive: true, force: true })
    rmSync(blobDir, { recursive: true, force: true })
  })
})

describe('M3.2 guest heartbeat', () => {
  it('writes heartbeat file with monotonic age', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-guesthb-'))
    const stop = startGuestHeartbeat(dir, { intervalMs: 10 })
    await new Promise((r) => setTimeout(r, 60))
    const age = readGuestHeartbeatAgeMs(dir, new Date())
    expect(age).toBeGreaterThanOrEqual(0)
    expect(age).toBeLessThan(5000)
    stop()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('M3.2 worker identity from mTLS certificate', () => {
  it('rebinds thumbprint when worker_id exists with a rotated certificate', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const pkiDir = mkdtempSync(join(tmpdir(), 'awp-pki3-'))
    generateDevPki(pkiDir)
    const certPem = readFileSync(join(pkiDir, 'worker.crt'), 'utf8')
    const runnerRoot = mkdtempSync(join(tmpdir(), 'awp-wid2-'))
    // 旧身份文件 + 旧指纹行（历史随机指纹）
    const knownId = '01a06bb8-bf56-7f41-a6d7-00f2ed975583'
    writeFileSync(join(runnerRoot, 'worker-identity.json'), `${JSON.stringify({
      workerId: knownId, certificateThumbprint: 'f'.repeat(64), hostname: 'legacy',
    })}\n`)
    await db.prepare(
      `INSERT INTO workers(worker_id, certificate_thumbprint, hostname, capabilities_json, status, created_at)
       VALUES (?, ?, 'legacy-host', '{}', 'offline', ?)`
    ).run(knownId, 'f'.repeat(64), new Date().toISOString())
    const identity = await loadOrCreateWorkerIdentity(db, {
      runnerRoot,
      certificatePem: certPem,
    })
    expect(identity.worker_id).toBe(knownId)
    expect(identity.certificate_thumbprint).toBe(certificateFingerprint256(certPem))
    expect(identity.status).toBe('offline') // 重绑不改运行状态，由心跳恢复
    rmSync(pkiDir, { recursive: true, force: true })
    rmSync(runnerRoot, { recursive: true, force: true })
  })

  it('derives sha256 fingerprint from worker.crt and rebinds identity', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const pkiDir = mkdtempSync(join(tmpdir(), 'awp-pki-'))
    generateDevPki(pkiDir)
    const certPem = readFileSync(join(pkiDir, 'worker.crt'), 'utf8')
    const fingerprint = certificateFingerprint256(certPem)
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    const runnerRoot = mkdtempSync(join(tmpdir(), 'awp-wid-'))
    const identity = await loadOrCreateWorkerIdentity(db, {
      runnerRoot,
      hostname: 'hb-host',
      certificatePem: certPem,
    })
    expect(identity.certificate_thumbprint).toBe(fingerprint)
    const row = await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(identity.worker_id)
    expect(row.certificate_thumbprint).toBe(fingerprint)
    expect(row.status).toBe('active')
    rmSync(pkiDir, { recursive: true, force: true })
    rmSync(runnerRoot, { recursive: true, force: true })
  })
})

describe('M3.2 runner API mTLS', () => {
  it('accepts worker cert over HTTPS and rejects header fallback when TLS enforced', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const pkiDir = mkdtempSync(join(tmpdir(), 'awp-pki2-'))
    generateDevPki(pkiDir)
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    mountTestingRoutes(app, { database: db, blobRoot: mkdtempSync(join(tmpdir(), 'awp-mtlsblob-')), tlsRequired: true })
    const server = https.createServer({
      cert: readFileSync(join(pkiDir, 'control-plane.crt')),
      key: readFileSync(join(pkiDir, 'control-plane.key')),
      ca: readFileSync(join(pkiDir, 'ca.crt')),
      requestCert: true,
      rejectUnauthorized: false,
    }, app)
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port

    // 注册一个带 worker.crt 指纹的 worker
    const certPem = readFileSync(join(pkiDir, 'worker.crt'), 'utf8')
    const fingerprint = certificateFingerprint256(certPem)
    const worker = await registerWorker(db, { certificateThumbprint: fingerprint, hostname: 'tls-worker' })
    const workerCert = readFileSync(join(pkiDir, 'worker.crt'), 'utf8')
    const workerKey = readFileSync(join(pkiDir, 'worker.key'), 'utf8')
    const caPem = readFileSync(join(pkiDir, 'ca.crt'), 'utf8')

    function post(path, body, { withCert = true } = {}) {
      return new Promise((resolve, reject) => {
        const req = https.request({
          host: '127.0.0.1', port, path, method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-worker-id': worker.worker_id,
            'x-worker-cert-thumbprint': fingerprint,
          },
          ...(withCert ? { cert: workerCert, key: workerKey } : {}),
          ca: caPem,
          rejectUnauthorized: false,
        }, (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || '{}') }))
        })
        req.on('error', reject)
        req.end(JSON.stringify(body))
      })
    }

    const noCert = await post('/v1/runner/leases:acquire', {}, { withCert: false })
    expect(noCert.status).toBe(403)
    const ok = await post('/v1/runner/leases:acquire', {})
    expect(ok.status).toBe(200)
    server.close()
    rmSync(pkiDir, { recursive: true, force: true })
    void boot
  })
})
