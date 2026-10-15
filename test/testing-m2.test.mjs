import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer } from '../testing/auth.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'
import { previewSuitePlan } from '../testing/suite-plan.js'
import { documentSha256 } from '../contracts/version.mjs'
import { acquireLease, acceptLease, completeLease } from '../testing/leases.js'
import { generateEd25519Pem, publicKeySha256, verifyRunSpecSignature } from '../testing/signing.js'
import { executeAcceptedRunInProcess } from '../runner/host-worker/index.mjs'
import { evaluateNewGate } from '../harness/testing-gate.js'
import { mergeSuiteCases } from '../testing/suite-selector.js'
import { ApiError } from '../testing/errors.js'
import { utcNow } from '../testing/ids.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m2-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const OID = 'b'.repeat(40)

async function submitS(db, boot, { size = 'S', taskId = 'T-S-1' } = {}) {
  const now = new Date().toISOString()
  const taskInstanceId = '018f0000-0000-7000-8000-0000000000s1'
  await db.prepare(
    `INSERT INTO task_instances(
       task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, 'EXECUTE', ?, 'open', ?, ?, ?)`
  ).run(taskInstanceId, boot.repoId, taskId, size, boot.principalId, now, now)
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
  const emptyPathsSha = documentSha256([])
  const created = await createTestSubmission(db, blobs, {
    clientRequestId: '018f0000-0000-7000-8000-0000000000c9',
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
      changedPathsSha256: emptyPathsSha,
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      mr: null,
    },
    bundle: { sha256: sha, size: payload.length },
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
  return { created, blobDir, emptyPathsSha, taskInstanceId, principal }
}

describe('M2 suite registry and static lease', () => {
  it('locks stable+repo overlays and rejects case-key conflicts', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      rotateToken: true,
    })
    const now = utcNow()
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at)
       VALUES ('018f0000-0000-7000-8000-0000000000p1', ?, 'T-P', 1, 1, 'EXECUTE', 'S', 'open', ?, ?, ?)`
    ).run(boot.repoId, boot.principalId, now, now)
    const preview = await previewSuitePlan(db, {
      repoId: boot.repoId,
      taskInstanceId: 'T-P',
      expectedTaskRevision: 1,
      branchIncarnationId: null,
      headCommitOid: OID,
      snapshotTreeOid: OID,
      changedPaths: [],
      changedPathsSha256: documentSha256([]),
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      candidateRevisionIds: [],
      requestedProfileName: 'auto',
      requestedSides: 'auto',
    })
    expect([...preview.requiredCaseKeys].sort()).toEqual([
      'test:smoke/fun',
      'test:smoke/store',
      'test:static/eslint',
      'test:static/hard-rules',
      'test:static/translation-fixture',
      'test:static/vitest',
    ])
    expect(() => mergeSuiteCases([
      {
        overlay: { overlay_id: 'a', layer: 'stable' },
        revision: { suite_revision_id: 'r1', manifest_json: JSON.stringify({
          schemaVersion: 1, title: 'x', requiredCapabilities: [], cases: [{
            caseKey: 'dup', title: 'a', tags: [], protected: false, replacesCaseKey: null, requiredCapabilities: [],
          }],
        }) },
      },
      {
        overlay: { overlay_id: 'b', layer: 'repo' },
        revision: { suite_revision_id: 'r2', manifest_json: JSON.stringify({
          schemaVersion: 1, title: 'y', requiredCapabilities: [], cases: [{
            caseKey: 'dup', title: 'b', tags: [], protected: false, replacesCaseKey: null, requiredCapabilities: [],
          }],
        }) },
      },
    ])).toThrow(ApiError)
  })

  it('runs S formal static:na through lease + guest sidecar + observe gate', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      rotateToken: true,
    })
    const { created, blobDir, taskInstanceId } = await submitS(db, boot)
    const group = await db.prepare('SELECT * FROM run_groups WHERE run_group_id=?').get(created.formalRunGroupId)
    expect(group.gate_eligible).toBe(1)
    expect(JSON.parse(group.required_units_json)).toEqual(['static:na'])
    const run = await db.prepare('SELECT * FROM test_runs WHERE run_group_id=?').get(created.formalRunGroupId)
    expect(run.unit).toBe('static')
    expect(run.side).toBe('na')
    expect(run.status).toBe('queued')

    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'poc-worker' })
    const reservation = await acquireLease(db, worker)
    expect(reservation.runId).toBe(run.run_id)
    expect(reservation.attempt).toBe(1)
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
    expect(accepted.runSpec.unit).toBe('static')
    expect(accepted.runSpec.side).toBe('na')
    expect(accepted.runSpec.audience).toBe('awp-guest-agent')
    expect(await verifyRunSpecSignature(db, accepted.runSpec, accepted.runSpecSignature, accepted.signingKeyId)).toBe(true)

    const runDir = mkdtempSync(join(tmpdir(), 'awp-guest-'))
    mkdirSync(join(runDir, 'workspace'), { recursive: true })
    writeFileSync(join(runDir, 'workspace', 'ok.js'), 'const n = 1\n')
    const plan = await db.prepare('SELECT canonical_lock_json FROM suite_plans WHERE suite_plan_id=?').get(created.suitePlanId)
    const cases = JSON.parse(plan.canonical_lock_json).cases
    const sidecar = await executeAcceptedRunInProcess({ db, worker, reservation, accepted, cases, runDir, guestPrivateKeyPem: guest.privateKeyPem, blobRoot: blobDir })
    expect(sidecar.result.status).toBe('passed')
    expect(sidecar.result.checks.map((c) => c.caseKey).sort()).toEqual([
      'test:static/eslint',
      'test:static/hard-rules',
      'test:static/translation-fixture',
      'test:static/vitest',
    ])

    const done = await db.prepare('SELECT status FROM test_runs WHERE run_id=?').get(run.run_id)
    expect(done.status).toBe('passed')
    const evaluation = await evaluateNewGate(db, {
      repoSlug: 'demo-app',
      taskId: 'T-S-1',
      size: 'S',
      gateBindingId: created.bindingId,
      expectedTaskRevision: created.taskRevision,
    })
    expect(evaluation.wouldBlock).toBe(false)
    expect(taskInstanceId).toBeTruthy()
    rmSync(blobDir, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  it('rejects stale lease complete', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      rotateToken: true,
    })
    const { created, blobDir } = await submitS(db, boot, { taskId: 'T-S-2' })
    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex') })
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
    await expect(completeLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: 'not-the-token-value-at-all!!',
      bindingId: created.bindingId,
      status: 'passed',
      resultSha256: 'a'.repeat(64),
      runnerImageId: 'win2025-pw-node22-20260903.1',
      runnerImageManifestSha256: 'b'.repeat(64),
      checks: [],
      artifactManifestSha256: 'c'.repeat(64),
    })).rejects.toThrow(/STALE_LEASE/)
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('stages a guest pack and creates a platform canary static run', async () => {
    const db = await memdb()
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
    const packDir = mkdtempSync(join(tmpdir(), 'awp-pack-'))
    const { stageGuestPack } = await import('../runner/guest-agent/stage-pack.mjs')
    const { ensureCanaryStaticRun } = await import('../runner/host-worker/canary.mjs')
    stageGuestPack(packDir)
    expect(existsSync(join(packDir, 'index.mjs'))).toBe(true)
    expect(existsSync(join(packDir, 'canonical.mjs'))).toBe(true)
    expect(existsSync(join(packDir, 'unbundle.mjs'))).toBe(true)
    expect(existsSync(join(packDir, 'install.mjs'))).toBe(true)
    // 回归护栏：guest 包平铺后 smoke.mjs 依赖 report-steps；漏打会让 agent 链接期秒崩 + VM 不关拖成 45min 超时
    expect(existsSync(join(packDir, 'report-steps.mjs'))).toBe(true)
    expect(readFileSync(join(packDir, 'smoke.mjs'), 'utf8')).not.toContain('../report-steps.js')
    const created = await ensureCanaryStaticRun(db, {
      blobRoot: blobDir,
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
    })
    expect(created.runId).toMatch(/^[0-9a-f-]{36}$/)
    const run = await db.prepare('SELECT unit, side, status FROM test_runs WHERE run_id=?').get(created.runId)
    expect(run).toMatchObject({ unit: 'static', side: 'na', status: 'queued' })
    const again = await ensureCanaryStaticRun(db, { blobRoot: blobDir, remoteUrl: 'https://gitlab.example/Web/demo-app.git' })
    expect(again.reused).toBe(true)
    expect(again.runId).toBe(created.runId)
    rmSync(blobDir, { recursive: true, force: true })
    rmSync(packDir, { recursive: true, force: true })
  })
})
