import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import https from 'node:https'
import express from 'express'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer } from '../testing/auth.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'
import { documentSha256 } from '../contracts/version.mjs'
import { acquireLease, acceptLease, heartbeatLease } from '../testing/leases.js'
import { generateEd25519Pem, publicKeySha256 } from '../testing/signing.js'
import { generateDevPki } from '../scripts/gen-dev-pki.mjs'
import { openBrokerDb, putSecret, fetchGrant } from '../secret-broker/store.mjs'
import { createBrokerApp, loadTrust, certThumbprint } from '../secret-broker/server.mjs'
import { SECRET_CAPABILITY_SETS, createGrantsForLease, markGrantsRevoked } from '../testing/secrets.js'
import { createBrokerTransports } from '../runner/host-worker/broker-client.mjs'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-sec-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const OID = 'b'.repeat(40)

async function submitS(db, boot, { taskId = 'T-S-1' } = {}) {
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
    },
    bundle: { sha256: sha, size: payload.length },
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
  return { created, blobDir }
}

async function startBroker() {
  const pkiDir = mkdtempSync(join(tmpdir(), 'awp-secpki-'))
  generateDevPki(pkiDir)
  const brokerTrust = loadTrust(join(pkiDir, 'trust.json'))
  const brokerDb = openBrokerDb(join(mkdtempSync(join(tmpdir(), 'awp-secdb-')), 'broker.db'))
  const canaryValue = `canary-plaintext-${randomBytes(8).toString('hex')}`
  putSecret(brokerDb, 'canary/awp-secret-canary', canaryValue)
  const app = createBrokerApp({ db: brokerDb, trust: brokerTrust })
  const server = https.createServer({
    cert: readFileSync(join(pkiDir, 'broker.crt')),
    key: readFileSync(join(pkiDir, 'broker.key')),
    ca: readFileSync(join(pkiDir, 'ca.crt')),
    requestCert: true,
    // dev PKI 为手写 X.509，Node 严格链校验不通过；身份由 app 层 thumbprint 钉扎保证
    rejectUnauthorized: false,
  }, app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const brokerUrl = `https://127.0.0.1:${server.address().port}`
  return { pkiDir, brokerDb, server, brokerUrl, brokerTrust, canaryValue }
}

describe('M3.3 secret_ref end to end', () => {
  it('creates lease-bound grants at accept, worker fetches once via mTLS, revoke closes it', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot)
    const { pkiDir, brokerDb, server, brokerUrl, brokerTrust, canaryValue } = await startBroker()

    // canary capability set：把 project 集合临时指向 canary ref（真实 project 走 npm 代理，集合为空）
    const original = SECRET_CAPABILITY_SETS['npm-readonly-v1']
    SECRET_CAPABILITY_SETS['npm-readonly-v1'] = [
      { capability: 'secret-canary', secretRef: 'canary/awp-secret-canary' },
    ]
    try {
      const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'sec-worker' })
      // broker 信任表里的 workerId 必须与控制面 worker 一致，否则 fetch 身份不匹配
      brokerTrust.workers = [{ workerId: worker.worker_id, thumbprint: brokerTrust.workers[0].thumbprint }]
      const reservation = await acquireLease(db, worker)
      const guest = generateEd25519Pem()
      const transports = createBrokerTransports({ pkiDir, brokerUrl })
      const accepted = await acceptLease(db, worker, reservation.leaseId, {
        runId: reservation.runId,
        workerId: worker.worker_id,
        attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch,
        leaseToken: reservation.leaseToken,
        guestPublicKey: guest.publicKeyPem,
        guestKeySha256: publicKeySha256(guest.publicKeyPem),
      }, { broker: transports.controlPlane })

      expect(accepted.runSpec.secretRefs).toEqual(['canary/awp-secret-canary'])
      // RunSpec 只有 ref，绝无明文
      expect(JSON.stringify(accepted.runSpec)).not.toContain(canaryValue)
      expect(accepted.secretGrants).toHaveLength(1)
      const grant = accepted.secretGrants[0]
      expect(grant.secretRef).toBe('canary/awp-secret-canary')
      expect(grant.capability).toBe('secret-canary')
      // TTL ≤ 15 分钟
      expect(Date.parse(grant.expiresAt) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000)
      // 控制面记录 grant（无明文列）
      const cpRow = await db.prepare('SELECT * FROM secret_grants WHERE secret_grant_id=?').get(grant.secretGrantId)
      expect(cpRow.status).toBe('issued')
      expect(cpRow.lease_id).toBe(reservation.leaseId)

      // worker 通过 mTLS 一次性 fetch
      const fetched = await transports.worker.fetchGrant({
        secretGrantId: grant.secretGrantId,
        workerId: worker.worker_id,
        leaseId: reservation.leaseId,
        capability: grant.capability,
      })
      expect(fetched.plaintext).toBe(canaryValue)
      await expect(transports.worker.fetchGrant({
        secretGrantId: grant.secretGrantId,
        workerId: worker.worker_id,
        leaseId: reservation.leaseId,
        capability: grant.capability,
      })).rejects.toThrow(/GRANT_ALREADY_FETCHED/)

      // 明文只进 Guest run-local 临时文件，用后即删
      const guestFile = join(mkdtempSync(join(tmpdir(), 'awp-guestrun-')), 'secret-canary')
      writeFileSync(guestFile, fetched.plaintext, { mode: 0o600 })
      expect(readFileSync(guestFile, 'utf8')).toBe(canaryValue)
      rmSync(guestFile, { force: true })
      expect(existsSync(guestFile)).toBe(false)

      // attempt 结束 revoke：broker 与控制面同步
      await transports.worker.revokeGrant({
        secretGrantId: grant.secretGrantId,
        workerId: worker.worker_id,
        leaseId: reservation.leaseId,
      })
      await markGrantsRevoked(db, { leaseId: reservation.leaseId })
      expect((await db.prepare('SELECT status FROM secret_grants WHERE secret_grant_id=?').get(grant.secretGrantId)).status).toBe('revoked')
      const brokerRow = await brokerDb.prepare('SELECT status FROM grants WHERE secret_grant_id=?').get(grant.secretGrantId)
      expect(brokerRow.status).toBe('revoked')
      await expect(transports.worker.fetchGrant({
        secretGrantId: grant.secretGrantId,
        workerId: worker.worker_id,
        leaseId: reservation.leaseId,
        capability: grant.capability,
      })).rejects.toThrow()

      // 心跳不受影响
      await heartbeatLease(db, worker, reservation.leaseId, {
        runId: reservation.runId,
        workerId: worker.worker_id,
        attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch,
        leaseToken: reservation.leaseToken,
        operationSeq: 1,
      })
      void created
      rmSync(blobDir, { recursive: true, force: true })
    } finally {
      SECRET_CAPABILITY_SETS['npm-readonly-v1'] = original
      server.close()
      rmSync(pkiDir, { recursive: true, force: true })
    }
  })

  it('rejects grant fetch when worker identity does not match the grant', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-S-2' })
    const { pkiDir, server, brokerUrl, brokerTrust, brokerDb } = await startBroker()
    const original = SECRET_CAPABILITY_SETS['npm-readonly-v1']
    SECRET_CAPABILITY_SETS['npm-readonly-v1'] = [
      { capability: 'secret-canary', secretRef: 'canary/awp-secret-canary' },
    ]
    try {
      const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'sec-w2' })
      brokerTrust.workers = [{ workerId: worker.worker_id, thumbprint: brokerTrust.workers[0].thumbprint }]
      const reservation = await acquireLease(db, worker)
      const guest = generateEd25519Pem()
      const transports = createBrokerTransports({ pkiDir, brokerUrl })
      const accepted = await acceptLease(db, worker, reservation.leaseId, {
        runId: reservation.runId,
        workerId: worker.worker_id,
        attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch,
        leaseToken: reservation.leaseToken,
        guestPublicKey: guest.publicKeyPem,
        guestKeySha256: publicKeySha256(guest.publicKeyPem),
      }, { broker: transports.controlPlane })
      const grant = accepted.secretGrants[0]

      // 非授权 worker 身份无法 fetch（§14.10：broker 同时校验 worker、lease、capability）
      await expect((async () => {
        // 直接用 store 层模拟“非授权 worker”身份请求
        fetchGrant(brokerDb, {
          secretGrantId: grant.secretGrantId,
          workerId: '018f0000-0000-7000-8000-0000000000000',
          leaseId: reservation.leaseId,
          capability: grant.capability,
        })
      })()).rejects.toThrow(/GRANT_IDENTITY_MISMATCH/)
      void brokerUrl
      rmSync(blobDir, { recursive: true, force: true })
    } finally {
      SECRET_CAPABILITY_SETS['npm-readonly-v1'] = original
      server.close()
      rmSync(pkiDir, { recursive: true, force: true })
    }
  })
})
