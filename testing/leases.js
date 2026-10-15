import { randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError, rejectUnknownFields } from './errors.js'
import { canonicalize, documentSha256, RUNSPEC_AUDIENCE } from '../contracts/version.mjs'
import { uuidv7, utcNow } from './ids.js'
import { publicKeySha256, signRunSpec } from './signing.js'
import { parseProfileJson, NETWORK_POLICY_ID } from './execution-profiles.js'
import { hashToken } from './auth.js'
import { createGrantsForLease } from './secrets.js'
import { writebackRunFailures } from './failure-writeback.js'
import { changedFilesForBinding } from './impact.js'
import { recordSpecF2p, countDistinctSurvivedPoints } from './f2p.js'
import { promoteTaskDraftSpecsToActive } from './test-specs.js'
import { computeCoverageComplete, lockedSpecByFeature } from './asset-lock.js'
import { columnExists } from '../db/dialect-helpers.js'

/** 旁路生命周期事件：动态 import，避免 scanner 等旁路进程经 leases→audit→db 拉起全局 team.db */
function emitLifecycle(payload) {
  try {
    import('../audit/index.js')
      .then((m) => {
        try { m.recordLifecycleEvent(payload) } catch { /* ignore */ }
      })
      .catch(() => {})
  } catch {
    /* ignore */
  }
}

/** leases.js 内用的 changed-files 读取（复用 impact.js，异常降级 null） */
async function changedFilesForBindingLease(db, bindingId) {
  try {
    return await changedFilesForBinding(db, bindingId)
  } catch {
    return null
  }
}

const RESERVATION_MS = 30 * 1000
const LEASE_TTL_MS = 45 * 1000

export async function authenticateWorker(db, { workerId, certificateThumbprint }) {
  if (!workerId || !certificateThumbprint) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId)
  if (!row || row.status !== 'active') throw new ApiError('INVALID_SCHEMA')
  const a = Buffer.from(String(row.certificate_thumbprint).toLowerCase().replace(/:/g, ''))
  const b = Buffer.from(String(certificateThumbprint).toLowerCase().replace(/:/g, ''))
  if (a.length !== b.length || a.length < 8 || !timingSafeEqual(a, b)) {
    throw new ApiError('CROSS_REPO_REFERENCE')
  }
  return row
}

export async function rememberWorkerOp(db, { workerId, leaseId, operation, operationSeq, requestBody, produce, now }) {
  const payloadSha256 = documentSha256(requestBody)
  const existing = await db.prepare(
    `SELECT * FROM worker_idempotency_records
     WHERE worker_id=? AND lease_id=? AND operation=? AND operation_seq=?`
  ).get(workerId, leaseId, operation, operationSeq)
  if (existing) {
    if (existing.payload_sha256 !== payloadSha256) throw new ApiError('IDEMPOTENCY_KEY_REUSED')
    return { replay: true, status: existing.response_status, data: JSON.parse(existing.response_json) }
  }
  const produced = await produce()
  await db.prepare(
    `INSERT INTO worker_idempotency_records(
       worker_id, lease_id, operation, operation_seq, payload_sha256, response_status, response_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(workerId, leaseId, operation, operationSeq, payloadSha256, produced.status, JSON.stringify(produced.data), now)
  return { replay: false, ...produced }
}

async function requeueExpiredReservations(db, nowIso, requeuedRuns = []) {
  const expired = await db.prepare(
    `SELECT l.*, a.status AS attempt_status, r.max_attempts, r.next_attempt
     FROM runner_leases l
     JOIN run_attempts a ON a.run_id=l.run_id AND a.attempt=l.attempt
     JOIN test_runs r ON r.run_id=l.run_id
     WHERE l.revoked_at IS NULL AND l.expires_at < ? AND a.status='reserved'`
  ).all(nowIso)
  for (const row of expired) {
    await db.prepare(`UPDATE runner_leases SET revoked_at=? WHERE lease_id=?`).run(nowIso, row.lease_id)
    await db.prepare(
      `UPDATE run_attempts SET status='error', error_code='LEASE_EXPIRED', finished_at=? WHERE run_id=? AND attempt=?`
    ).run(nowIso, row.run_id, row.attempt)
    if (row.next_attempt < row.max_attempts) {
      await db.prepare(`UPDATE test_runs SET status='queued' WHERE run_id=? AND status='active'`).run(row.run_id)
      requeuedRuns.push(row.run_id)
    } else {
      await db.prepare(
        `UPDATE test_runs SET status='error', terminal_reason='timed_out', finished_at=? WHERE run_id=?`
      ).run(nowIso, row.run_id)
    }
  }
  return requeuedRuns
}

async function finishOrRequeue(db, row, terminalReason, nowIso, requeuedRuns) {
  if (row.next_attempt < row.max_attempts) {
    await db.prepare(`UPDATE test_runs SET status='queued' WHERE run_id=? AND status='active'`).run(row.run_id)
    requeuedRuns.push(row.run_id)
  } else {
    await db.prepare(
      `UPDATE test_runs SET status='error', terminal_reason=?, finished_at=? WHERE run_id=? AND status='active'`
    ).run(terminalReason, nowIso, row.run_id)
  }
  // 可重试期间 group/submission 保持 running（§13.5），终态后聚合
  await refreshGroupStatus(db, row.run_group_id, nowIso)
}

/**
 * 重启对账 / 后台清扫（§11.2 §11.4 §13.5）：
 *   1) reserved 且 reservation 过期 -> 撤销并按重试上限 requeue；
 *   2) leased/provisioning/running 静默超 TTL -> lease 撤销、attempt=lost，
 *      可重试时 run 回 queued（重试恰一次），耗尽则终态 error+lost（禁止映射成 failed）；
 *   3) desired_state=canceled 的 run -> lease 撤销、attempt 与 run 置 canceled。
 * 幂等：终态行不会重复匹配。
 */
export async function reconcileRuns(db, { now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const requeuedRuns = []
  const expiredLeases = []
  const canceledRuns = []
  await db.tx(async (tx) => {
    await requeueExpiredReservations(tx, nowIso, requeuedRuns)
    for (const rid of requeuedRuns) {
      emitLifecycle({ runId: rid, eventType: 'requeue', detail: { reason: 'lease_expired' } })
    }
    for (const row of await tx.prepare(
      `SELECT l.*, a.status AS attempt_status, r.max_attempts, r.next_attempt, r.run_group_id
       FROM runner_leases l
       JOIN run_attempts a ON a.run_id=l.run_id AND a.attempt=l.attempt
       JOIN test_runs r ON r.run_id=l.run_id
       WHERE l.revoked_at IS NULL AND l.expires_at < ?
         AND a.status IN ('leased','provisioning','running')`
    ).all(nowIso)) {
      await tx.prepare(`UPDATE runner_leases SET revoked_at=? WHERE lease_id=? AND revoked_at IS NULL`)
        .run(nowIso, row.lease_id)
      await tx.prepare(
        `UPDATE run_attempts SET status='lost', error_code='HEARTBEAT_LOST', finished_at=?
         WHERE run_id=? AND attempt=? AND status IN ('leased','provisioning','running')`
      ).run(nowIso, row.run_id, row.attempt)
      expiredLeases.push({ runId: row.run_id, attempt: row.attempt })
      await finishOrRequeue(tx, row, 'lost', nowIso, requeuedRuns)
    }
    for (const run of await tx.prepare(
      `SELECT * FROM test_runs WHERE desired_state='canceled' AND status IN ('queued','active')`
    ).all()) {
      await tx.prepare(`UPDATE runner_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL`)
        .run(nowIso, run.run_id)
      await tx.prepare(
        `UPDATE run_attempts SET status='canceled', finished_at=?
         WHERE run_id=? AND status IN ('reserved','leased','provisioning','running')`
      ).run(nowIso, run.run_id)
      await tx.prepare(
        `UPDATE test_runs SET status='canceled', terminal_reason='canceled', finished_at=? WHERE run_id=?`
      ).run(nowIso, run.run_id)
      canceledRuns.push(run.run_id)
      await refreshGroupStatus(tx, run.run_group_id, nowIso)
    }
  })
  return { requeuedRuns, expiredLeases, canceledRuns }
}

// QUERY_CLASS: WORKER —— 全局工人队列：按 priority/created_at 取队首，不按租户过滤（方案 §2.7/§7.1）
export async function acquireLease(db, worker, { now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const tx = async (tx) => {
    await requeueExpiredReservations(tx, nowIso)
    const queued = await tx.prepare(
      `SELECT * FROM test_runs
       WHERE status='queued' AND desired_state='running'
       ORDER BY priority ASC, created_at ASC LIMIT 1`
    ).get()
    if (!queued) return null
    const updated = await tx.prepare(
      `UPDATE test_runs
       SET next_attempt=next_attempt+1, lease_epoch=lease_epoch+1, status='active', started_at=COALESCE(started_at, ?)
       WHERE run_id=? AND status='queued' AND desired_state='running'
       RETURNING *`
    ).get(nowIso, queued.run_id)
    if (!updated) return null
    // attempt 序号与重试预算解耦：序号 = 历史最大 + 1（永久递增），预算另由 next_attempt/max_attempts 管。
    // 旧实现直接拿 next_attempt 当序号，人工重推清零后会重插 attempt=1 → 主键冲突（重推链路必炸）。
    const attemptNo = (await tx.prepare(
      'SELECT COALESCE(MAX(attempt), 0) + 1 AS n FROM run_attempts WHERE run_id=?'
    ).get(updated.run_id))?.n || 1
    const binding = await tx.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(updated.binding_id)
    const leaseId = uuidv7()
    const leaseToken = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + RESERVATION_MS).toISOString()
    await tx.prepare(
      `INSERT INTO run_attempts(
         repo_id, run_id, attempt, worker_id, lease_epoch, status, image_id, started_at
       ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`
    ).run(
      updated.repo_id,
      updated.run_id,
      attemptNo,
      worker.worker_id,
      updated.lease_epoch,
      binding.runner_image_id,
      nowIso
    )
    await tx.prepare(
      `INSERT INTO runner_leases(
         lease_id, repo_id, run_id, attempt, worker_id, lease_epoch, lease_token_hash, expires_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      leaseId,
      updated.repo_id,
      updated.run_id,
      attemptNo,
      worker.worker_id,
      updated.lease_epoch,
      hashToken(leaseToken),
      expiresAt,
      nowIso
    )
    await tx.prepare(`UPDATE workers SET last_heartbeat_at=? WHERE worker_id=?`).run(nowIso, worker.worker_id)
    return {
      runId: updated.run_id,
      attempt: attemptNo,
      leaseEpoch: updated.lease_epoch,
      leaseId,
      leaseToken,
      reservationExpiresAt: expiresAt,
    }
  }
  const out = await db.tx(tx)
  if (out?.runId) {
    emitLifecycle({
      runId: out.runId,
      attempt: out.attempt,
      leaseEpoch: out.leaseEpoch,
      eventType: 'acquire',
      detail: { leaseId: out.leaseId },
      repoId: null,
    })
  }
  return out
}

export async function loadActiveLease(db, { leaseId, workerId, runId, attempt, leaseEpoch, leaseToken, nowIso, allowExpired = false }) {
  const lease = await db.prepare('SELECT * FROM runner_leases WHERE lease_id=?').get(leaseId)
  if (!lease) throw new ApiError('STALE_LEASE')
  if (lease.revoked_at) throw new ApiError('STALE_LEASE')
  if (lease.worker_id !== workerId || lease.run_id !== runId || lease.attempt !== attempt || lease.lease_epoch !== leaseEpoch) {
    throw new ApiError('STALE_LEASE')
  }
  const tokenHash = hashToken(leaseToken)
  const a = Buffer.from(lease.lease_token_hash, 'hex')
  const b = Buffer.from(tokenHash, 'hex')
  if (a.length !== 32 || b.length !== 32 || !timingSafeEqual(a, b)) throw new ApiError('STALE_LEASE')
  if (!allowExpired && Date.parse(lease.expires_at) <= Date.parse(nowIso)) throw new ApiError('LEASE_EXPIRED')
  return lease
}

async function buildRunSpec(db, { run, attemptRow, lease, guestPublicKey, guestKeySha256, nonce, nowIso, secretRefs = [] }) {
  const binding = await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(run.binding_id)
  const snapshot = await db.prepare('SELECT * FROM business_snapshots WHERE snapshot_id=?').get(binding.snapshot_id)
  const plan = await db.prepare('SELECT * FROM suite_plans WHERE suite_plan_id=?').get(binding.suite_plan_id)
  const profile = await db.prepare(
    'SELECT * FROM execution_profile_revisions WHERE profile_revision_id=?'
  ).get(binding.execution_profile_revision_id)
  const profileDoc = parseProfileJson(profile.profile_json) || {}
  const timeouts = profileDoc.timeouts || {
    provisionSeconds: 300,
    installSeconds: 900,
    staticSeconds: 600,
    viteReadySeconds: 120,
    smokeSeconds: 720,
    artifactSeconds: 300,
    totalSeconds: 2400,
  }
  const expiresAt = new Date(Date.parse(nowIso) + timeouts.totalSeconds * 1000).toISOString()
  return {
    schemaVersion: 1,
    runId: run.run_id,
    attempt: attemptRow.attempt,
    leaseEpoch: lease.lease_epoch,
    bindingId: binding.binding_id,
    sourceBlobSha256: snapshot.bundle_sha256,
    suiteLockSha256: plan.lock_sha256,
    suiteBlobSha256: documentSha256(JSON.parse(plan.canonical_lock_json)),
    profileRevisionId: binding.execution_profile_revision_id,
    policyRevisionId: binding.policy_revision_id,
    runnerImageId: binding.runner_image_id,
    runnerImageManifestSha256: binding.runner_image_manifest_sha256,
    unit: run.unit,
    side: run.side,
    purpose: run.purpose,
    resourceLimits: { vcpu: 4, memoryGiB: 8 },
    timeouts,
    networkPolicyId: profileDoc.networkPolicyId || NETWORK_POLICY_ID,
    secretRefs,
    nonce,
    issuedAt: nowIso,
    expiresAt,
    audience: RUNSPEC_AUDIENCE,
    guestPublicKey,
    guestKeySha256,
  }
}

export async function acceptLease(db, worker, leaseId, body, { now = new Date(), broker = null } = {}) {
  rejectUnknownFields(body, [
    'runId', 'workerId', 'attempt', 'leaseEpoch', 'leaseToken', 'guestPublicKey', 'guestKeySha256',
  ])
  if (body.workerId !== worker.worker_id) throw new ApiError('STALE_LEASE')
  if (!Number.isInteger(body.attempt) || !Number.isInteger(body.leaseEpoch)) throw new ApiError('INVALID_SCHEMA')
  if (body.guestKeySha256 !== publicKeySha256(body.guestPublicKey)) throw new ApiError('INVALID_SCHEMA')
  const nowIso = now.toISOString()
  // 幂等重放先行：避免重复 accept 时向 broker 重复创建 grant（§14.9）
  const payloadSha256 = documentSha256(body)
  const replayed = await db.prepare(
    `SELECT * FROM worker_idempotency_records
     WHERE worker_id=? AND lease_id=? AND operation='accept' AND operation_seq=0`
  ).get(worker.worker_id, leaseId)
  if (replayed) {
    if (replayed.payload_sha256 !== payloadSha256) throw new ApiError('IDEMPOTENCY_KEY_REUSED')
    return JSON.parse(replayed.response_json)
  }
  // grant 创建在事务外（网络 I/O），失败即 accept 失败，禁止静默降级
  let secretGrants = []
  if (broker) {
    const peekLease = await db.prepare('SELECT * FROM runner_leases WHERE lease_id=?').get(leaseId)
    const run = peekLease ? await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get(peekLease.run_id) : null
    const binding = run ? await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(run.binding_id) : null
    const profile = binding ? await db.prepare(
      'SELECT * FROM execution_profile_revisions WHERE profile_revision_id=?'
    ).get(binding.execution_profile_revision_id) : null
    secretGrants = await createGrantsForLease(db, {
      lease: peekLease,
      profile: profile ? parseProfileJson(profile.profile_json) : null,
      workerId: worker.worker_id,
      broker,
      now,
    })
  }
  const tx = async (tx) => {
    const remembered = await rememberWorkerOp(tx, {
      workerId: worker.worker_id,
      leaseId,
      operation: 'accept',
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
        const attemptRow = await tx.prepare(
          `SELECT * FROM run_attempts WHERE run_id=? AND attempt=?`
        ).get(lease.run_id, lease.attempt)
        if (!attemptRow || attemptRow.status !== 'reserved') throw new ApiError('STALE_LEASE')
        const run = await tx.prepare('SELECT * FROM test_runs WHERE run_id=?').get(lease.run_id)
        const nonce = randomBytes(16).toString('base64url')
        await tx.prepare(
          `UPDATE run_attempts SET status='leased', guest_public_key=?, guest_key_sha256=? WHERE run_id=? AND attempt=?`
        ).run(body.guestPublicKey, body.guestKeySha256, lease.run_id, lease.attempt)
        await tx.prepare(
          `INSERT INTO runspec_nonces(
             nonce_id, repo_id, run_id, attempt, nonce_hash, issued_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuidv7(),
          lease.repo_id,
          lease.run_id,
          lease.attempt,
          hashToken(nonce),
          nowIso,
          new Date(now.getTime() + LEASE_TTL_MS).toISOString()
        )
        await tx.prepare(
          `UPDATE runner_leases SET expires_at=? WHERE lease_id=?`
        ).run(new Date(now.getTime() + LEASE_TTL_MS).toISOString(), leaseId)
        const runSpec = await buildRunSpec(tx, {
          run,
          attemptRow: { ...attemptRow, attempt: lease.attempt },
          lease,
          guestPublicKey: body.guestPublicKey,
          guestKeySha256: body.guestKeySha256,
          nonce,
          nowIso,
          secretRefs: secretGrants.map((g) => g.secretRef),
        })
        const signed = await signRunSpec(tx, runSpec)
        return {
          status: 200,
          data: {
            runSpec,
            runSpecSignature: signed.signature,
            signingKeyId: signed.keyId,
            sourceBlobSha256: runSpec.sourceBlobSha256,
            suiteBlobSha256: runSpec.suiteBlobSha256,
            secretRefs: runSpec.secretRefs,
            secretGrants,
          },
        }
      },
    })
    return remembered.data
  }
  return await db.tx(tx)
}

export async function consumeRunspecNonce(db, { runId, attempt, nonce, nowIso }) {
  const nonceHash = hashToken(nonce)
  const row = await db.prepare(
    `SELECT * FROM runspec_nonces WHERE run_id=? AND attempt=? AND nonce_hash=?`
  ).get(runId, attempt, nonceHash)
  if (!row) throw new ApiError('RUNSPEC_SIGNATURE_INVALID')
  if (row.consumed_at) throw new ApiError('STALE_LEASE')
  if (Date.parse(row.expires_at) <= Date.parse(nowIso)) throw new ApiError('LEASE_EXPIRED')
  const info = await db.prepare(
    `UPDATE runspec_nonces SET consumed_at=? WHERE nonce_id=? AND consumed_at IS NULL`
  ).run(nowIso, row.nonce_id)
  if (info.changes !== 1) throw new ApiError('STALE_LEASE')
}

export async function heartbeatLease(db, worker, leaseId, body, { now = new Date() } = {}) {
  rejectUnknownFields(body, [
    'runId', 'workerId', 'attempt', 'leaseEpoch', 'leaseToken', 'operationSeq',
  ])
  if (!Number.isInteger(body.operationSeq) || body.operationSeq < 1) throw new ApiError('INVALID_SCHEMA')
  const nowIso = now.toISOString()
  const tx = async (tx) => {
    const remembered = await rememberWorkerOp(tx, {
      workerId: worker.worker_id,
      leaseId,
      operation: 'heartbeat',
      operationSeq: body.operationSeq,
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
        const nonceRow = await tx.prepare(
          `SELECT * FROM runspec_nonces WHERE run_id=? AND attempt=?`
        ).get(lease.run_id, lease.attempt)
        if (nonceRow && !nonceRow.consumed_at) {
          await tx.prepare(`UPDATE runspec_nonces SET consumed_at=? WHERE nonce_id=? AND consumed_at IS NULL`)
            .run(nowIso, nonceRow.nonce_id)
        }
        await tx.prepare(
          `UPDATE run_attempts SET heartbeat_at=?, status=CASE WHEN status='leased' THEN 'provisioning' ELSE status END
           WHERE run_id=? AND attempt=?`
        ).run(nowIso, lease.run_id, lease.attempt)
        await tx.prepare(`UPDATE runner_leases SET expires_at=? WHERE lease_id=?`)
          .run(new Date(now.getTime() + LEASE_TTL_MS).toISOString(), leaseId)
        await tx.prepare(`UPDATE workers SET last_heartbeat_at=? WHERE worker_id=?`).run(nowIso, worker.worker_id)
        return { status: 200, data: { desiredState: run.desired_state } }
      },
    })
    return remembered.data
  }
  return await db.tx(tx)
}

function resultDocument(body) {
  return {
    schemaVersion: 1,
    runId: body.runId,
    attempt: body.attempt,
    leaseEpoch: body.leaseEpoch,
    bindingId: body.bindingId,
    status: body.status,
    checks: body.checks,
  }
}

function attestationDocument({
  bindingId, runId, attempt, leaseEpoch, workerId, workerCertThumbprint,
  runnerImageId, runnerImageManifestSha256, resultSha256, artifactSha256, artifactManifestSha256, completedAt,
}) {
  return {
    bindingId,
    runId,
    attempt,
    leaseEpoch,
    workerId,
    workerCertThumbprint,
    runnerImageId,
    runnerImageManifestSha256,
    resultSha256,
    artifactSha256,
    artifactManifestSha256,
    completedAt,
  }
}

export async function completeLease(db, worker, leaseId, body, { now = new Date() } = {}) {
  rejectUnknownFields(body, [
    'runId', 'workerId', 'attempt', 'leaseEpoch', 'leaseToken', 'bindingId', 'status',
    'resultSha256', 'runnerImageId', 'runnerImageManifestSha256', 'checks', 'artifactManifestSha256',
  ])
  const nowIso = now.toISOString()
  const tx = async (tx) => {
    const remembered = await rememberWorkerOp(tx, {
      workerId: worker.worker_id,
      leaseId,
      operation: 'complete',
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
        if (run.binding_id !== body.bindingId) throw new ApiError('STALE_LEASE')
        const binding = await tx.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(run.binding_id)
        if (binding.runner_image_id !== body.runnerImageId
          || binding.runner_image_manifest_sha256 !== body.runnerImageManifestSha256) {
          throw new ApiError('IMAGE_CHANGED')
        }
        const result = resultDocument(body)
        if (documentSha256(result) !== body.resultSha256) throw new ApiError('ARTIFACT_HASH_MISMATCH')
        if (!body.artifactManifestSha256 || !/^[a-f0-9]{64}$/.test(body.artifactManifestSha256)) {
          throw new ApiError('ARTIFACT_HASH_MISMATCH')
        }
        // complete 只认可本 run/attempt 已 prepare 的 artifact manifest（§12：只有当前 lease epoch 可发布）
        const artifactRow = await tx.prepare(
          'SELECT * FROM artifacts WHERE run_id=? AND attempt=? AND manifest_sha256=?'
        ).get(lease.run_id, lease.attempt, body.artifactManifestSha256)
        if (!artifactRow) throw new ApiError('ARTIFACT_HASH_MISMATCH')
        await tx.prepare(
          `INSERT INTO accepted_run_results(run_id, attempt, lease_epoch, result_sha256, accepted_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(lease.run_id, lease.attempt, lease.lease_epoch, body.resultSha256, nowIso)
        const att = attestationDocument({
          bindingId: body.bindingId,
          runId: body.runId,
          attempt: body.attempt,
          leaseEpoch: body.leaseEpoch,
          workerId: worker.worker_id,
          workerCertThumbprint: worker.certificate_thumbprint,
          runnerImageId: body.runnerImageId,
          runnerImageManifestSha256: body.runnerImageManifestSha256,
          resultSha256: body.resultSha256,
          artifactSha256: artifactRow.archive_sha256,
          artifactManifestSha256: body.artifactManifestSha256,
          completedAt: nowIso,
        })
        const canonicalSha = documentSha256(att)
        await tx.prepare(
          `INSERT INTO run_attestations(
             run_attestation_id, repo_id, run_id, attempt, lease_epoch, binding_id, worker_id,
             worker_cert_thumbprint, image_id, image_manifest_sha256, result_sha256, artifact_sha256,
             canonical_sha256, signature, completed_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          uuidv7(),
          lease.repo_id,
          lease.run_id,
          lease.attempt,
          lease.lease_epoch,
          body.bindingId,
          worker.worker_id,
          worker.certificate_thumbprint,
          body.runnerImageId,
          body.runnerImageManifestSha256,
          body.resultSha256,
          att.artifactSha256,
          canonicalSha,
          canonicalSha,
          nowIso
        )
        const terminal = ['passed', 'failed', 'error', 'canceled', 'timed_out', 'lost'].includes(body.status)
          ? body.status
          : 'error'
        const reason = terminal === 'failed' ? 'assertion_failed' : terminal === 'passed' ? null : 'infra_error'
        // 证据完整性标记（纯数据列，**不改 run 终态/不写非枚举值**；try/catch 保证任何异常只留 NULL、不影响事务）。
        // 仅对 gate run 计算；mutation/candidate 等按设计只跑子集 → NULL（不适用），杜绝上一轮把 mutation run 误判的错。
        let coverageComplete = null
        try {
          coverageComplete = computeCoverageComplete({
            purpose: run.purpose,
            lock: JSON.parse(binding.canonical_binding_json || '{}')?.assetLock,
            unit: run.unit,
            side: run.side || null,
            checks: body.checks || [],
          })
        } catch { coverageComplete = null }
        await tx.prepare(
          `UPDATE run_attempts SET status=?, finished_at=? WHERE run_id=? AND attempt=?`
        ).run(terminal, nowIso, lease.run_id, lease.attempt)
        await tx.prepare(
          `UPDATE test_runs SET status=?, result_sha256=?, report_json=?, terminal_reason=?, finished_at=?, total_ms=?, coverage_complete=?
           WHERE run_id=?`
        ).run(
          terminal,
          body.resultSha256,
          canonicalize(result),
          reason,
          nowIso,
          Date.parse(nowIso) - Date.parse(run.created_at),
          coverageComplete,
          lease.run_id
        )
        await tx.prepare(`UPDATE runner_leases SET revoked_at=? WHERE lease_id=?`).run(nowIso, leaseId)
        await refreshGroupStatus(tx, run.run_group_id, nowIso)
        emitLifecycle({
          runId: lease.run_id,
          attempt: lease.attempt,
          leaseEpoch: lease.lease_epoch,
          eventType: 'run_complete',
          detail: { status: terminal, reason, totalMs: Date.parse(nowIso) - Date.parse(run.created_at) },
          repoId: lease.repo_id,
        })
        // 看板实时性：worker 独立进程，不走 MCP SSE；写审计供服务端 poll 桥转发
        // 关键：PG 里 tx 中一条 SQL 失败会把主事务推到 aborted 态，之前的裸 try/catch 会让上面
        // 4 个 UPDATE（run_attempts / test_runs / runner_leases / run_group）在 COMMIT 时被静默回滚
        // —— run 看起来还在 queued/running、事实层已丢。用 SAVEPOINT 隔离：审计失败只回滚到 SAVEPOINT，
        // 判卷写入照常提交。
        const auditIsolate = async (fn) => {
          if (tx && typeof tx.savepoint === 'function') {
            try { await tx.savepoint(fn) } catch { /* 审计失败不影响判卷 */ }
            return
          }
          try { await fn() } catch { /* 审计失败不影响判卷 */ }
        }
        await auditIsolate(async () => {
          const meta = await tx.prepare(
            `SELECT r.unit, r.side, ti.external_task_id AS task_id, rep.slug AS repo
             FROM test_runs r
             LEFT JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
             LEFT JOIN repositories rep ON rep.repo_id = r.repo_id
             WHERE r.run_id = ?`
          ).get(lease.run_id)
          await tx.prepare(
            `INSERT INTO audit_events
               (event_type, session_id, tool_name, method, author, repo, task_id, client_name, args_preview, status, duration_ms, detail, created_at)
             VALUES ('worker_run_complete', NULL, 'test_run_status', 'completeLease', 'host-worker', ?, ?, 'host-worker', ?, 'ok', ?, ?, ?)`
          ).run(
            meta?.repo || null,
            meta?.task_id || null,
            String(lease.run_id).slice(0, 12),
            Date.parse(nowIso) - Date.parse(run.created_at),
            `run ${String(lease.run_id).slice(0, 12)} ${meta?.unit || '?'}/${meta?.side || '-'} → ${terminal}${reason ? ` (${reason})` : ''}`,
            nowIso
          )
        })
        return { status: 200, data: {} }
      },
    })
    return remembered.data
  }
  const out = await db.tx(tx)
  // M5 旁路：失败自动立案（recordFailure + experience_pending），不依赖 agent distill
  try {
    const run = await db
      .prepare(
        `SELECT run_id, repo_id, task_instance_id, binding_id, status, terminal_reason, report_json, purpose
         FROM test_runs WHERE run_id=?`
      )
      .get(body.runId)
    // mutation 失败是「考卷有效」的证明，不是产品缺陷；不得进普通失败立案/经验 pending
    if (run && run.purpose !== 'mutation' && (run.status === 'failed' || run.status === 'error')) {
      let checks = Array.isArray(body.checks) && body.checks.length ? body.checks : null
      if (!checks) {
        try {
          checks = JSON.parse(run.report_json || 'null')?.checks || []
        } catch {
          checks = []
        }
      }
      await writebackRunFailures(db, {
        runId: run.run_id,
        status: run.status,
        terminalReason: run.terminal_reason,
        bindingId: run.binding_id,
        taskInstanceId: run.task_instance_id,
        repoId: run.repo_id,
        checks,
      })
    }
  } catch (err) {
    process.stderr.write(`failure-writeback skip: ${err.message}\n`)
  }
  // 变异验卷编排：formal 全绿 → 自动排暗题考试；mutation 终态 → 回写考卷有效性
  try {
    const run = await db.prepare('SELECT purpose, status, repo_id, binding_id, payload_json FROM test_runs WHERE run_id=?').get(body.runId)
    if (run?.purpose === 'gate' && run.status === 'passed') {
      if (await isNightlyRun(db, body.runId)) {
        // 夜间全量回归：全绿不排变异（否则 N 张卷 = N 个变异 run，VM 成本失控）
        process.stdout.write(`[mutation] nightly run ${body.runId}: 跳过变异验卷编排\n`)
      } else {
        await ensureMutationRuns(db, body.runId)
      }
      // 任务私有草稿卷：整组 formal 全绿才晋升 draft → active（避免 static 过 smoke 未过就提前生效）
      try {
        const meta = await db.prepare(
          `SELECT t.external_task_id AS tid, r.repo_id, r.run_group_id FROM test_runs r
           JOIN task_instances t ON t.task_instance_id = r.task_instance_id
           WHERE r.run_id = ?`
        ).get(body.runId)
        const grp = await db.prepare('SELECT status FROM run_groups WHERE run_group_id=?').get(meta?.run_group_id)
        if (meta?.tid && grp?.status === 'passed') {
          const p = await promoteTaskDraftSpecsToActive(meta.repo_id, meta.tid)
          if (p.promoted) {
            process.stdout.write(`[specs] promoted ${p.promoted} draft → active for task ${meta.tid}\n`)
          }
        }
      } catch (promoteErr) {
        process.stderr.write(`[specs] promote skip: ${promoteErr.message}\n`)
      }
    } else if (run?.purpose === 'mutation') {
      let payload = {}
      try {
        payload = JSON.parse(run.payload_json || '{}')
      } catch { }
      const fk = payload.featureKey
      const specVersion = payload.specVersion ?? null
      const specId = payload.specId ?? null
      // 只有"考卷本身真的跑到了并给出结论"才算验卷结果：
      //   考卷 check failed → 抓到暗改（有效卷）；考卷 check passed → 抓不到（废卷候选）
      // 构建失败/装包失败/环境错误时报告里没有考卷 check——那是"没考成"，不是"考卷有效"，
      // 旧实现拿 run.status==='failed' 当 caught，会把 BUILD_FAILED 记成有效卷（假证明）。
      const checksForVerdict = Array.isArray(body.checks) ? body.checks : []
      const specCheck = checksForVerdict.find((c) => String(c?.caseKey || '') === `test:spec/${fk}`)
      const specFailed = specCheck?.status === 'failed'
      const specPassed = specCheck?.status === 'passed'
      const inconclusive = !specFailed && !specPassed
      const caught = specFailed
      // R6 三分判卷（修「每张卷必杀随机一题」的死锁）：guest 回传暗题锚点 mut.mode —
      //   skipped=改动行无可翻算子/diff 上下文缺失 → not_covered：豁免放行（warn 留痕），不再误判废卷；
      //   diff-line 且卷仍 pass=survived：严格判废卷，但 24h 内 survived≥cap（默认2，platform_settings
      //   mutation_reroll_cap）→ 疑似等价变异，豁免放行（warn 留痕）；重掷由「卷版本进 seed」保证换落点。
      //   无 mutation 字段（旧版 guest 在飞 run）→ 维持旧严格语义，零回归。
      const mut = specCheck?.mutation || null
      const notCovered = !inconclusive && mut?.mode === 'skipped'
      let survivedCapExempt = false
      if (inconclusive) {
        process.stderr.write(
          `[mutation] ${fk}: 无效验卷（无考卷执行结论，run=${body.status}/${run.status || '?'}）→ 不判卷，保持未验证\n`
        )
      } else if (notCovered) {
        // 豁免放行（防死锁），但 verdict 记 not_applicable：没有证明，不计入有效通过率
        await markMutationVerified(db, { repoId: run.repo_id, featureKey: fk, caught: true, specId, specVersion, verdict: 'not_applicable' })
        process.stdout.write(`[mutation] ${fk}: not_covered (${mut.reason}) → 豁免通过（warn 留痕，未计入有效变异通过率）\n`)
      } else if (specPassed) {
        const capRow = await db.prepare(`SELECT value, value_json FROM platform_settings WHERE key='mutation_reroll_cap'`).get()
        const cap = Number(capRow?.value ?? capRow?.value_json) || 2
        const cutoffIso = new Date(Date.now() - 86400000).toISOString()
        // B（防「原地空转熬豁免」）：只认「不同变异点」的有效重试——同一变异点（考卷版本+业务代码都没变→seed 不变→
        // 暗改点相同）反复 survived 属无效重复，不累计；必须升考卷版本/改代码换落点才算新的有效重试。见 countDistinctSurvivedPoints。
        const priorSurvived = await countDistinctSurvivedPoints(db, { repoId: run.repo_id, featureKey: fk, sinceIso: cutoffIso })
        if (priorSurvived >= cap) {
          survivedCapExempt = true
          await markMutationVerified(db, { repoId: run.repo_id, featureKey: fk, caught: true, specId, specVersion, verdict: 'exempt_equiv' })
          process.stdout.write(`[mutation] ${fk}: survived 计数 ${priorSurvived} ≥ cap ${cap} → 疑似等价变异，豁免通过（warn 留痕，未计入有效变异通过率）\n`)
        } else {
          await markMutationVerified(db, { repoId: run.repo_id, featureKey: fk, caught: false, specId, specVersion, verdict: 'survived' })
        }
      } else {
        // specFailed：真跑且抓住了暗题 —— 唯一算「变异有效性证明成立」的分支
        await markMutationVerified(db, { repoId: run.repo_id, featureKey: fk, caught: true, specId, specVersion, verdict: 'caught' })
      }
      // F2P：formal 已在改动后 snapshot 上 passed；mutation 世界近似「改动前/被破坏」。
      // failed+passed → ok；passed+passed → always_pass（废卷）。无独立 baseline VM 时的等价证明。
      // inconclusive（构建/环境失败，考卷没跑到）→ baseline 记 skipped，保持 unknown，不产假结论。
      try {
        if (fk) {
          // 版本以 payload 冻结值为准（本轮实际验的那一版）；缺省（在飞旧 run）回退查当前 active
          let f2pVersion = specVersion
          if (f2pVersion == null) {
            const spec = await db.prepare(
              `SELECT version FROM test_specs WHERE repo_id=? AND feature_key=? AND review_status='active' ORDER BY version DESC LIMIT 1`
            ).get(run.repo_id, fk)
            f2pVersion = spec?.version ?? null
          }
          const snap = await db.prepare(
            `SELECT s.snapshot_commit_oid, s.head_commit_oid FROM test_bindings b
             JOIN business_snapshots s ON s.snapshot_id=b.snapshot_id WHERE b.binding_id=?`
          ).get(run.binding_id)
          // snapshot oid / 版本任一未就绪时跳过落库（列 NOT NULL，硬写必炸且此前静默丢失）：
          // 不产出结果即保持 unknown，待补齐后随下次验卷回写，优于回写半截脏数据
          if (!snap?.head_commit_oid || !snap?.snapshot_commit_oid || f2pVersion == null) {
            process.stderr.write(
              `[f2p] skip ${fk}: snapshot oid 未就绪（head=${snap?.head_commit_oid || 'NULL'}, ` +
              `snapshot=${snap?.snapshot_commit_oid || 'NULL'}），保持 unknown 待补齐\n`
            )
          } else {
            const anchor = mut?.file ? ` @${mut.file}:${mut.line ?? '?'} ${mut.find}->${mut.replace}` : ''
            const baselineResult = inconclusive || notCovered || survivedCapExempt ? 'skipped' : caught ? 'failed' : 'passed'
            await recordSpecF2p(db, {
              runId: body.runId,
              repoId: run.repo_id,
              featureKey: fk,
              version: f2pVersion,
              baselineOid: snap.head_commit_oid,
              snapshotOid: snap.snapshot_commit_oid,
              baselineResult,
              snapshotResult: 'passed',
              detail: inconclusive
                ? `mutation run ${body.status} without spec verdict (build/infra) — not a paper verdict`
                : notCovered
                  ? `mutation not-covered (${mut.reason}) — 改动行无可翻算子，豁免`
                  : survivedCapExempt
                    ? `mutation survived-cap-exempt${anchor} — 疑似等价变异，豁免留痕`
                    : `mutation ${caught ? 'killed' : 'survived'}${anchor}`,
            })
            process.stdout.write(`[f2p] recorded ${fk} from mutation ${body.status}${inconclusive ? ' (inconclusive→skipped)' : ''}\n`)
            // always_pass 废卷：自动建议加强断言（正反馈：考卷质量自动抬升）
            if (specPassed && !notCovered && !survivedCapExempt) {
              try {
                await db.prepare(
                  `INSERT INTO experiences(id, repo, tenant_id, content, source, status, category, author, module, task_id, rule_ref, tags, created_at, updated_at)
                   VALUES (?, (SELECT slug FROM repositories WHERE repo_id = ?), ?, ?, 'auto', 'pending', 'test', 'test-platform', NULL, NULL, NULL, ?, ?, ?)`
                ).run(
                  `exp-weakspec-${Date.now()}`,
                  run.repo_id,
                  run.repo_id,
                  `【考卷偏弱·变异未抓住】featureKey=${fk}\n` +
                  `${mut?.file ? `暗题落点：${mut.file}:${mut.line ?? '?'} 「${mut.find}」→「${mut.replace}」（埋在本轮改动行）\n` : ''}` +
                  '平台暗改代码后 spec 仍通过（survived）。\n' +
                  '请在暗题落点一带补断言：接口契约（请求/响应字段）、数据状态、可见 DOM 结果；\n' +
                  '重提考卷会自动重掷新暗题（seed 绑定卷版本）；连续 survived 达上限将按疑似等价变异豁免并留 warn。\n' +
                  '禁止只 waitForSelector 空壳，禁止为绕题删既有断言。',
                  JSON.stringify(['auto-exam', 'weak-spec']),
                  utcNow(),
                  utcNow()
                )
                process.stdout.write(`[spec-quality] weak-spec hint queued for ${fk}\n`)
              } catch (hintErr) {
                process.stderr.write(`[spec-quality] hint skip: ${hintErr.message}\n`)
              }
            }
          }
        }
      } catch (f2pErr) {
        process.stderr.write(`f2p writeback skip: ${f2pErr.message}\n`)
      }
    }
  } catch (err) {
    process.stderr.write(`mutation orchestration skip: ${err.message}\n`)
  }
  return out
}

/**
 * rejectLease：worker 主动放弃租约（基础设施错误）。
 * body.noRetry=true 或 body.terminalReason 为不可恢复类型时，直接终态 error，不重试。
 * 不可恢复错误类型：SNAPSHOT_HASH_MISMATCH（bundle 不在本机，重试无意义）。
 */
export async function rejectLease(db, worker, leaseId, body, { now = new Date() } = {}) {
  rejectUnknownFields(body, [
    'runId', 'workerId', 'attempt', 'leaseEpoch', 'leaseToken', 'operationSeq',
    'noRetry', 'terminalReason', 'errorCode',
  ])
  const nowIso = now.toISOString()
  // 不可恢复错误类型：直接终态，不重试。工件内容缺失类（考卷 blob 不在主机）重试无意义——
  // 内容不会自己长出来，空烧 attempt 只会把可读的 SPEC_CONTENT_MISSING/ASSET_LOCK_UNRESOLVED 洗成 lost。
  const NO_RETRY_REASONS = new Set(['SNAPSHOT_HASH_MISMATCH', 'BUNDLE_NOT_FOUND', 'IMAGE_CHANGED', 'ASSET_LOCK_UNRESOLVED', 'SPEC_CONTENT_MISSING'])
  const terminalReason = body.terminalReason || 'infra_error'
  const errorCode = body.errorCode || terminalReason
  const noRetry = body.noRetry === true || NO_RETRY_REASONS.has(terminalReason)
  const tx = async (tx) => {
    const remembered = await rememberWorkerOp(tx, {
      workerId: worker.worker_id,
      leaseId,
      operation: 'reject',
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
          allowExpired: true,
        })
        const run = await tx.prepare('SELECT * FROM test_runs WHERE run_id=?').get(lease.run_id)
        await tx.prepare(
          `UPDATE run_attempts SET status='error', error_code=?, finished_at=? WHERE run_id=? AND attempt=?`
        ).run(errorCode, nowIso, lease.run_id, lease.attempt)
        await tx.prepare(`UPDATE runner_leases SET revoked_at=? WHERE lease_id=?`).run(nowIso, leaseId)
        // §11.4：基础设施错误自动重试一次（新建 attempt/lease/VM 由下次 acquire 完成）
        // 不可恢复错误（noRetry=true）直接终态，不重试
        if (!noRetry && run.next_attempt < run.max_attempts) {
          await tx.prepare(`UPDATE test_runs SET status='queued' WHERE run_id=? AND status='active'`).run(lease.run_id)
        } else {
          await tx.prepare(
            `UPDATE test_runs SET status='error', terminal_reason=?, finished_at=? WHERE run_id=? AND status='active'`
          ).run(terminalReason, nowIso, lease.run_id)
        }
        await refreshGroupStatus(tx, run.run_group_id, nowIso)
        emitLifecycle({
          runId: lease.run_id,
          attempt: lease.attempt,
          leaseEpoch: lease.lease_epoch,
          eventType: 'reject',
          detail: { reason: terminalReason, noRetry },
          repoId: lease.repo_id,
        })
        return { status: 200, data: {} }
      },
    })
    return remembered.data
  }
  return await db.tx(tx)
}

async function refreshGroupStatus(db, runGroupId, nowIso) {
  const group = await db.prepare('SELECT * FROM run_groups WHERE run_group_id=?').get(runGroupId)
  const runs = await db.prepare('SELECT status FROM test_runs WHERE run_group_id=?').all(runGroupId)
  const required = JSON.parse(group.required_units_json)
  if (!required.length) return
  const allTerminal = runs.every((r) => !['queued', 'active'].includes(r.status))
  if (!allTerminal) {
    await db.prepare(`UPDATE run_groups SET status='running' WHERE run_group_id=?`).run(runGroupId)
    // candidate 组（如变异验卷）只刷新组自身，禁止污染正式提交的状态账本
    if (group.kind !== 'candidate') {
      await db.prepare(`UPDATE test_submissions SET status='running', started_at=COALESCE(started_at, ?) WHERE submission_id=?`)
        .run(nowIso, group.submission_id)
    }
    return
  }
  const anyError = runs.some((r) => ['error', 'lost', 'timed_out', 'canceled'].includes(r.status))
  const anyFailed = runs.some((r) => r.status === 'failed')
  const allPassed = runs.every((r) => r.status === 'passed')
  const status = allPassed ? 'passed' : anyFailed ? 'failed' : anyError ? 'error' : 'failed'
  await db.prepare(`UPDATE run_groups SET status=? WHERE run_group_id=?`).run(status, runGroupId)
  if (group.kind !== 'candidate') {
    await db.prepare(`UPDATE test_submissions SET status=?, finished_at=? WHERE submission_id=?`)
      .run(status, nowIso, group.submission_id)
  }
}

/**
 * 变异验卷编排：formal 全绿后，对报告里每个 spec 考卷排一场"暗题考试"。
 * candidate 组 + gate_eligible=0 + purpose='mutation'：门禁评估天然不认，不计 AI 迭代。
 */
/** 该 run 所属任务是否为夜间回归合成任务（tasks.meta.nightly）；查询失败按 false 处理 */
export async function isNightlyRun(db, runId) {
  try {
    const row = await db.prepare(
      `SELECT ta.meta AS meta FROM test_runs r
       JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
       JOIN repositories rep ON rep.repo_id = ti.repo_id
       JOIN tasks ta ON ta.repo = rep.slug AND ta.task_id = ti.external_task_id
       WHERE r.run_id = ?`
    ).get(runId)
    return Boolean(JSON.parse(row?.meta || '{}')?.nightly)
  } catch {
    return false
  }
}

export async function ensureMutationRuns(db, sourceRunId) {
  const src = await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get(sourceRunId)
  if (!src || src.purpose !== 'gate' || src.status !== 'passed') return []
  let checks = []
  try {
    checks = JSON.parse(src.report_json || '{}').checks || []
  } catch {
    checks = []
  }
  const featureKeys = checks
    .filter((c) => String(c.caseKey || '').startsWith('test:spec/'))
    .map((c) => String(c.caseKey).slice('test:spec/'.length))
  // 单一真相：本轮实际执行的考卷版本以 source run 所属 binding 的 assetLock 冻结清单为准。
  // 据此定位（含本任务 draft 卷），杜绝旧实现「只认 active」导致 draft 覆盖卷永不被派发验卷的死结。
  // 旧 binding / 极简 fixture 无 canonical_binding_json 列 → 降级为空 map，回退 active 语义（零回归）。
  let lockMap = new Map()
  try {
    lockMap = lockedSpecByFeature(
      JSON.parse(
        (await db.prepare('SELECT canonical_binding_json FROM test_bindings WHERE binding_id=?').get(src.binding_id))
          ?.canonical_binding_json || '{}'
      )?.assetLock
    )
  } catch { lockMap = new Map() }
  const out = []
  const nowIso = new Date().toISOString()
  for (const featureKey of featureKeys) {
    const locked = lockMap.get(featureKey) || null
    let spec = null
    if (locked) {
      // 按冻结版本精确取行（不限 review_status）：draft 覆盖卷同样可被派发验卷
      spec = await db
        .prepare(
          `SELECT spec_id, mutation_verified, version FROM test_specs
           WHERE repo_id=? AND feature_key=? AND version=? ORDER BY spec_id LIMIT 1`
        )
        .get(src.repo_id, featureKey, locked.version)
    }
    if (!spec) {
      // 无 lock 条目（旧 binding / 不在清单的回归卷）：回退旧「取当前 active」语义，不改历史行为
      spec = await db
        .prepare(
          `SELECT spec_id, mutation_verified, version FROM test_specs
           WHERE repo_id=? AND feature_key=? AND review_status='active' ORDER BY version DESC LIMIT 1`
        )
        .get(src.repo_id, featureKey)
    }
    if (!spec || Number(spec.mutation_verified) === 1) continue
    const specVersion = locked?.version ?? spec.version ?? null
    const specId = locked?.specId ?? spec.spec_id ?? null
    // 去重（2026-09-27 修复语义漂移回归）：仅两类历史变异卷阻止重复派卷——
    //   ① 在飞（queued/active/running）：防止重复排队；
    //   ② 已完成且「验证通过」的（killed=f2p_status='ok'、not-covered 豁免、survived-cap 豁免）。
    // survived（run 状态 passed 但 f2p_status='always_pass' 且未豁免）= 验证未通过（考卷偏弱），
    // 不得阻止重新派卷——否则 R6 收敛路径（增强断言→升版本→换暗题落点重跑）被永久堵死
    // （2026-09-27 historical production 生产死锁根因：09-22 引入 survived 语义时未同步 09-12 的去重）。
    // 旧库/极简 fixture 无 spec_f2p_results 表 → 回退旧去重语义（status 含 passed），零回归。
    let dup = null
    try {
      dup = await db
        .prepare(
          `SELECT r.run_id FROM test_runs r
           WHERE r.binding_id=? AND r.purpose='mutation' AND r.payload_json LIKE ?
             AND (
               r.status IN ('queued','active','running')
               OR (
                 r.status = 'passed'
                 AND EXISTS (
                   SELECT 1 FROM spec_f2p_results f
                   WHERE f.run_id = r.run_id
                     AND (
                       f.f2p_status = 'ok'
                       OR (f.f2p_status = 'skipped' AND f.detail LIKE '%not-covered%')
                       OR f.detail LIKE '%survived-cap-exempt%'
                     )
                   )
                 )
               )`
        )
        .get(src.binding_id, `%"featureKey":"${featureKey}"%`)
    } catch {
      dup = await db
        .prepare(
          `SELECT run_id FROM test_runs
           WHERE binding_id=? AND purpose='mutation' AND payload_json LIKE ? AND status IN ('queued','active','running','passed')`
        )
        .get(src.binding_id, `%"featureKey":"${featureKey}"%`)
    }
    if (dup) continue
    // 变异免 VM 静态预筛（platform_settings.mutation_static_skip，默认 on）：
    // spec 的 pages 声明与 changed-files 无任何交集 → 变异点不在考卷观测路径上，
    // 真跑也抓不到 → 直接判 mutation_verified=1（省一轮 VM）。豁免语义自完成侧移到派发侧。
    // 显式设为 'off' 可关闭（回退真跑复核，宁可多跑不错判）；无 pages 声明 → 走真跑。
    try {
        const skipRow = await db
          .prepare(`SELECT value, value_json FROM platform_settings WHERE key='mutation_static_skip'`)
          .get()
        const skipVal =
          skipRow?.value ??
          (skipRow?.value_json
            ? (() => {
                try {
                  const p = JSON.parse(skipRow.value_json)
                  return typeof p === 'string' ? p : String(p)
                } catch {
                  return skipRow.value_json
                }
              })()
            : null)
        const staticSkip = skipVal == null ? true : skipVal === 'on'
      if (staticSkip) {
        const changedFiles = await changedFilesForBindingLease(db, src.binding_id)
        const pagesJson = (await db.prepare('SELECT pages_json FROM test_specs WHERE spec_id = ?').get(spec.spec_id))?.pages_json
        const pages = pagesJson ? JSON.parse(pagesJson) : []
        const overlap = Array.isArray(changedFiles) && Array.isArray(pages) && pages.some((p) =>
          changedFiles.some((f) => String(f).toLowerCase().includes(String(p).toLowerCase()))
        )
        if (Array.isArray(changedFiles) && Array.isArray(pages) && pages.length && !overlap) {
          // 静态预筛：卷与本轮改动无关，跳过 VM 省一轮。verdict 记 not_applicable——
          // 它没有对任何代码做过变异，不构成「考卷有效性证明」，只是这一轮不适用。
          await markMutationVerified(db, { repoId: src.repo_id, featureKey, caught: true, specId, specVersion, verdict: 'not_applicable' })
          process.stdout.write(`[mutation] static-skip: ${featureKey}（pages 与改动无交集，跳过 VM 验卷；未计入有效变异通过率）\n`)
          continue
        }
      }
    } catch { /* 静态预筛不可用 → 走真跑 */ }
    const runId = uuidv7()
    const groupId = uuidv7()
    // test_runs 没有 submission_id 列；必须从 run_group 回查，否则 INSERT NOT NULL 永远失败、
    // 变异验卷静默丢失（mutation orchestration skip: run_groups.submission_id）
    const submissionId = (await db
      .prepare('SELECT submission_id FROM run_groups WHERE run_group_id=?')
      .get(src.run_group_id))?.submission_id
    if (!submissionId) {
      process.stdout.write(`[mutation] skip ${featureKey}: source run_group ${src.run_group_id} 无 submission_id\n`)
      continue
    }
    await db.prepare(
      `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible, required_units_json, status, created_at)
       VALUES (?, ?, ?, ?, 'candidate', 0, ?, 'queued', ?)`
    ).run(groupId, src.repo_id, submissionId, src.binding_id, JSON.stringify([`smoke:${src.side || 'na'}`]), nowIso)
    await db.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
         unit, side, purpose, status, desired_state, max_attempts, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'smoke', ?, 'mutation', 'queued', 'running', 2, ?, ?)`
    ).run(runId, groupId, src.binding_id, src.repo_id, src.task_instance_id, src.side || 'na', JSON.stringify({ featureKey, specVersion, specId }), nowIso)
    out.push(runId)
    process.stdout.write(`[mutation] queued ${featureKey} run=${runId} group=${groupId}\n`)
  }
  return out
}

/**
 * 变异结果回写：考卷在暗题版上 failed = 有效（verified），passed = 废卷。repoId 兼容 id/slug 寻址
 *
 * verdict（v37 起）：真实结论三态，与 mutation_verified 正交。
 *   'caught'          —— spec 真跑且抓住了暗题，唯一算「变异有效性证明成立」的情况
 *   'survived'        —— 造出了变异但 spec 仍 pass，考卷偏弱（mutation_verified=0）
 *   'not_applicable'  —— 压根没造出可翻算子/无可用变异点，没有证明（豁免放行，但仍写 verified=1 防死锁）
 *   'exempt_equiv'    —— survived 次数达 cap，疑似等价变异，豁免放行（同理仍写 verified=1）
 *
 * 关键：mutation_verified 的 0/1 语义刻意保持不变（派卷去重 + 门禁判定都读它，
 * 改语义会触发 2026-09-27 那类生产死锁）；verdict 只负责让统计/看板能区分
 * 「有效通过」与「没考也通过」。不传 verdict 时保持旧行为，向后兼容。
 */
export async function markMutationVerified(db, { repoId, featureKey, caught, specId = null, specVersion = null, verdict = null }) {
  const repo = await db.prepare('SELECT repo_id FROM repositories WHERE repo_id=? OR slug=?').get(repoId, repoId)
  if (!repo) return
  const nowIso = new Date().toISOString()
  const mv = caught ? 1 : 0
  // verdict 列不存在（v37 迁移未跑 / 极简 fixture）时降级为旧行为，不阻断判卷
  const hasVerdict = await columnExists(db, 'test_specs', 'mutation_verdict')
  const setClause = hasVerdict ? 'mutation_verified = ?, mutation_verdict = ?, updated_at = ?' : 'mutation_verified = ?, updated_at = ?'
  const args = hasVerdict ? [mv, verdict, nowIso] : [mv, nowIso]
  // 优先回写到「本轮实际被变异执行的那一版」（payload 冻结），与 AI 中途改版/归档竞态解耦；
  // 该版即便已非 active，mv 也应记在它自己行上（晋升后随行携带），不会误盖到另一版本造成假绿。
  if (specId != null) {
    // PG 方言(§10 后):(? IS NOT NULL) 无法推断参数类型,按 specId 精确回写(冻结行更准)
    await db.prepare(
      `UPDATE test_specs SET ${setClause}
       WHERE repo_id = ? AND feature_key = ? AND spec_id = ?`
    ).run(...args, repo.repo_id, featureKey, specId)
    return
  }
  if (specVersion != null) {
    await db.prepare(
      `UPDATE test_specs SET ${setClause}
       WHERE repo_id = ? AND feature_key = ? AND version = ?`
    ).run(...args, repo.repo_id, featureKey, specVersion)
    return
  }
  // 无冻结版本（在飞旧 run / 无 lock）：维持旧行为，只回写当前 active 行
  await db.prepare(
    `UPDATE test_specs SET ${setClause}
     WHERE repo_id = ? AND feature_key = ? AND review_status = 'active'`
  ).run(...args, repo.repo_id, featureKey)
}

export { publicKeySha256, resultDocument }

/**
 * 人工重推：infra_error/lost 终态的 run 重新入队（重置重试预算）。
 * 业务失败（assertion_failed）禁止重推——那是 AI 的考卷，走修复回环。
 * attempt 序号走「历史最大 + 1」（acquireLease 负责），因此清零预算不会撞 run_attempts 主键；
 * accepted_run_results 为 (run_id, attempt, lease_epoch) 复合主键，旧 attempts 的验收结果保留为审计。
 * 重置后由 refreshGroupStatus 语义把组/提交拉回 running。
 */
export async function requeueRun(db, runId, { actor = 'dashboard', now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const run = await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get(runId)
  if (!run) throw new Error('RUN_NOT_FOUND')
  if (run.status !== 'error' || !['infra_error', 'lost'].includes(run.terminal_reason || '')) {
    throw new Error(
      `REQUEUE_NOT_ALLOWED: 仅 infra_error/lost 终态可重推（当前 ${run.status}/${run.terminal_reason || '-'}）`
    )
  }
  await db.tx(async (tx) => {
    await tx.prepare(
      `UPDATE test_runs
       SET status='queued', desired_state='running', terminal_reason=NULL, finished_at=NULL,
           next_attempt=0, lease_epoch=lease_epoch+1
       WHERE run_id=?`
    ).run(runId)
  })
  await refreshGroupStatus(db, run.run_group_id, nowIso)
  return { runId, status: 'queued', repoId: run.repo_id, actor }
}
