/**
 * testing/deferred.js — 备用机（standby）不本地做云端快照：
 *   - submitGateRun 在 standby 分支把 codeDiff 落 deferred_submissions，返回 deferred:true
 *   - 主机 host-worker 每 tick 认领 pending 行 → 用配置的 repository workspace 调 submitGateRun 生成真 submission
 *   - 客户端 loop_wait 通过 deferred_id 反查 processed_submission_id 继续
 * 目的：跨机不依赖备用机 E:\ 上的仓库状态，保证主机是唯一「代码基线 + 快照」源。
 *
 * 幂等：(repo_id, client_request_id) UNIQUE。相同 diff+taskId+base 会命中同一 client_request_id
 * （sha256），客户端超时重试不会产生重复 VM。
 */
import { createHash, randomUUID } from 'node:crypto'

const PENDING = 'pending'
const CLAIMED = 'claimed'
const PROCESSED = 'processed'
const FAILED = 'failed'

function nowIso() { return new Date().toISOString() }

function isUniqueViolation(err) {
  const msg = String(err?.message || '')
  return /UNIQUE constraint failed|duplicate key value|ConstraintViolation|23505/i.test(msg)
}

/**
 * 派生一个稳定 client_request_id：内容相同 → 相同 ID → 天然去重。
 * 若调用方显式传了 clientRequestId，直接用（更严格语义）。
 */
export function deriveClientRequestId({
  explicitId = null, repoId, taskId, codeCommitOid = null, codeDiff = '',
  side = 'auto', sourceRef = null,
}) {
  if (explicitId) return String(explicitId)
  const h = createHash('sha256')
  h.update(JSON.stringify({
    repoId, taskId, codeCommitOid: codeCommitOid || null, sourceRef: sourceRef || null, side,
    diffSha: createHash('sha256').update(String(codeDiff || '')).digest('hex'),
  }))
  return `derived:${h.digest('hex').slice(0, 40)}`
}

/**
 * 记录一条延迟单：standby MCP 收到 test_run 后调用。
 * 已存在同 (repo_id, client_request_id) 时返回原行，不重复插入（幂等）。
 *
 * @returns {Promise<{deferredId: string, status: string, created: boolean}>}
 */
export async function recordDeferredSubmission(db, {
  repoId, taskId, author, side, sideReason = null,
  sourceRef = null, codeCommitOid = null, codeDiff,
  triggerReason = null, productFixed = false, suiteFixed = false,
  clientRequestId = null,
}) {
  if (!codeDiff || typeof codeDiff !== 'string' || !codeDiff.trim()) {
    throw new Error('DEFERRED_REQUIRES_DIFF: 延迟单必须有 codeDiff')
  }
  const cri = deriveClientRequestId({
    explicitId: clientRequestId, repoId, taskId, codeCommitOid, codeDiff, side, sourceRef,
  })
  const now = nowIso()
  const deferredId = randomUUID()
  const stmt = db.prepare(
    `INSERT INTO deferred_submissions
       (deferred_id, client_request_id, repo_id, task_id, author, side, side_reason,
        source_ref, code_commit_oid, code_diff, trigger_reason,
        product_fixed, suite_fixed, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  try {
    await stmt.run(
      deferredId, cri, repoId, taskId, author, side, sideReason,
      sourceRef, codeCommitOid, codeDiff, triggerReason,
      productFixed ? 1 : 0, suiteFixed ? 1 : 0, PENDING, now, now,
    )
    return { deferredId, status: PENDING, created: true, clientRequestId: cri }
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    // 命中重复：返回既有行，让上层判断状态决定后续动作
    const existing = await db.prepare(
      `SELECT deferred_id, status FROM deferred_submissions WHERE repo_id=? AND client_request_id=?`
    ).get(repoId, cri)
    if (!existing) throw err
    return { deferredId: existing.deferred_id, status: existing.status, created: false, clientRequestId: cri }
  }
}

/** 主机 host-worker 认领最早的 pending 一条；行锁靠事务原子性。 */
export async function claimPendingDeferred(db, workerId) {
  return db.tx(async (tx) => {
    const now = nowIso()
    // 只取到期未重试的 pending（transient 退避中的行 next_retry_at 未到 → 不认领）
    const row = await tx.prepare(
      `SELECT * FROM deferred_submissions
        WHERE status='${PENDING}' AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC LIMIT 1`
    ).get(now)
    if (!row) return null
    await tx.prepare(
      `UPDATE deferred_submissions
         SET status='${CLAIMED}', claimed_by_worker=?, claimed_at=?, updated_at=?
       WHERE deferred_id=? AND status='${PENDING}'`
    ).run(workerId, now, now, row.deferred_id)
    return row
  })
}

/** 主机处理成功后：写入 processed_submission_id 关联真 submission。 */
export async function completeDeferred(db, { deferredId, processedSubmissionId }) {
  const now = nowIso()
  await db.prepare(
    `UPDATE deferred_submissions
       SET status='${PROCESSED}', processed_submission_id=?, updated_at=?
     WHERE deferred_id=?`
  ).run(processedSubmissionId, now, deferredId)
}

/**
 * 主机处理失败：按 errorClass 分类。
 *   transient 且未超 max_attempts → 退回 pending + attempts+1 + next_retry_at（指数退避），下轮自动重试；
 *   permanent 或超上限 → 终态 failed。
 * @returns {Promise<{status:string, willRetry:boolean, attempts:number}>}
 */
export async function failDeferred(db, { deferredId, errorMessage, errorClass = 'permanent' }) {
  const now = nowIso()
  const msg = String(errorMessage || '').slice(0, 2000)
  const row = await db.prepare('SELECT attempts, max_attempts FROM deferred_submissions WHERE deferred_id=?').get(deferredId)
  const attempts = Number(row?.attempts ?? 0)
  const maxAttempts = Number(row?.max_attempts ?? 3) || 3
  if (errorClass === 'transient' && attempts + 1 < maxAttempts) {
    const nextAt = new Date(Date.now() + backoffMs(attempts + 1)).toISOString()
    await db.prepare(
      `UPDATE deferred_submissions
         SET status='${PENDING}', attempts=?, next_retry_at=?, last_error_class='transient',
             error_message=?, claimed_by_worker=NULL, claimed_at=NULL, updated_at=?
       WHERE deferred_id=?`
    ).run(attempts + 1, nextAt, msg, now, deferredId)
    return { status: PENDING, willRetry: true, attempts: attempts + 1 }
  }
  await db.prepare(
    `UPDATE deferred_submissions
       SET status='${FAILED}', attempts=?, last_error_class=?, error_message=?, updated_at=?
     WHERE deferred_id=?`
  ).run(attempts + 1, errorClass, msg, now, deferredId)
  return { status: FAILED, willRetry: false, attempts: attempts + 1 }
}

/** 崩溃/host-worker 失联后：claimed 超时回退到 pending（复用 lease TTL 语义）。 */
export async function sweepStaleClaimed(db, { ttlMs = 10 * 60 * 1000 } = {}) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString()
  return db.prepare(
    `UPDATE deferred_submissions
       SET status='${PENDING}', claimed_by_worker=NULL, claimed_at=NULL, updated_at=?
     WHERE status='${CLAIMED}' AND claimed_at < ?`
  ).run(nowIso(), cutoff)
}

/** 退避：5s→10s→20s…（上限 60s），host-worker 每 tick(15s) 自然在到期后重认领。 */
function backoffMs(attempt) {
  return Math.min(60000, 5000 * Math.pow(2, Math.max(1, attempt) - 1))
}

/**
 * 失败分类：permanent 直接终态；transient 退避重试。
 * corrupt/空/非法/未知仓/无工作区/base 不匹配（P0-1 后 drain 用钉死 base，仍失败即真不匹配）→ permanent。
 * 锁超时/worktree 创建失败/网络/PG 抖动 → transient。未知默认 transient（保守重试，抖动不自杀）。
 */
export function classifyDeferredError(err) {
  if (err && err.permanent === true) return 'permanent'
  const code = String((err && (err.code || err.message)) || err || '')
  if (/SOURCE_DIFF_CORRUPT|SOURCE_DIFF_EMPTY|SOURCE_DIFF_MALFORMED|DEFERRED_REPO_UNKNOWN|DEFERRED_REQUIRES_DIFF|UNRESOLVED_REPO|UNRESOLVED_REMOTE|SECRET_FILES_DETECTED|INVALID_SCHEMA|WORKSPACE_NOT_FOUND|UNCONFIGURED_REPO|SOURCE_SYNC_FAILED|SOURCE_DIFF_APPLY_FAILED|SYNC_REF_NOT_FOUND/.test(code)) return 'permanent'
  if (/WORKSPACE_LOCK_TIMEOUT|WORKTREE_ADD_FAILED|ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|current transaction|deadlock|timeout|temporar|内存水位/i.test(code)) return 'transient'
  return 'transient'
}

/** 运维/工具显式重投：把 failed 复位 pending、attempts 归零，替代手工 UPDATE。 */
export async function retryDeferredSubmission(db, { deferredId }) {
  const now = nowIso()
  const r = await db.prepare(
    `UPDATE deferred_submissions
       SET status='${PENDING}', attempts=0, next_retry_at=NULL, last_error_class=NULL,
           error_message=NULL, claimed_by_worker=NULL, claimed_at=NULL, updated_at=?
     WHERE deferred_id=?`
  ).run(now, deferredId)
  const row = await db.prepare('SELECT status FROM deferred_submissions WHERE deferred_id=?').get(deferredId)
  return { changed: (r?.changes ?? 0) > 0, status: row?.status || null }
}

export async function getDeferredById(db, { deferredId }) {
  return db.prepare(`SELECT * FROM deferred_submissions WHERE deferred_id=?`).get(deferredId)
}

export async function getDeferredByClientRequestId(db, { repoId, clientRequestId }) {
  return db.prepare(`SELECT * FROM deferred_submissions WHERE repo_id=? AND client_request_id=?`).get(repoId, clientRequestId)
}

/** 供 tools/test-run.js：查同任务的最新 pending/claimed 行（客户端超时重连可复用）。 */
export async function findRecentDeferredForTask(db, { repoId, taskId, withinMs = 15 * 60 * 1000 }) {
  const since = new Date(Date.now() - withinMs).toISOString()
  return db.prepare(
    `SELECT * FROM deferred_submissions
     WHERE repo_id=? AND task_id=? AND status IN ('${PENDING}','${CLAIMED}') AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(repoId, taskId, since)
}

/**
 * P0-2b：deferred 队列健康快照（把"主机停摆→云测静默无限排队"变显式红灯）。
 * 表未建时返回全 0，不抛（供看板无侵入轮询）。
 */
export async function getDeferredHealth(db) {
  const nowMs = Date.now()
  const counts = { pending: 0, claimed: 0, processed: 0, failed: 0 }
  let oldestPendingAgeMs = 0
  let retryScheduled = 0
  try {
    const rows = await db.prepare(
      'SELECT status, COUNT(*) AS c, MIN(created_at) AS oldest FROM deferred_submissions GROUP BY status'
    ).all()
    for (const r of rows) {
      const s = String(r.status)
      if (counts[s] != null) counts[s] = Number(r.c || 0)
      if (s === PENDING && r.oldest) oldestPendingAgeMs = Math.max(oldestPendingAgeMs, nowMs - Date.parse(r.oldest))
    }
    const rs = await db.prepare(
      `SELECT COUNT(*) AS c FROM deferred_submissions WHERE status='${PENDING}' AND next_retry_at IS NOT NULL AND next_retry_at > ?`
    ).get(new Date(nowMs).toISOString())
    retryScheduled = Number(rs?.c || 0)
  } catch { /* 表未建 */ }
  const stallMs = Number(process.env.AWP_DEFERRED_STALL_MS || 120000)
  const redFlag = counts.pending > 0 && oldestPendingAgeMs > stallMs
  return {
    counts, oldestPendingAgeMs, retryScheduled, stallMs,
    standbyTakeoverEnabled: String(process.env.AWP_STANDBY_DRAIN_TAKEOVER || '').trim() === '1',
    redFlag,
    hint: redFlag
      ? `deferred 已积压且最老 pending ${Math.round(oldestPendingAgeMs / 1000)}s 未消（阈值 ${Math.round(stallMs / 1000)}s）：疑似主机 host-worker 停摆/整机故障，云测将无限排队`
      : null,
  }
}

export const DEFERRED_STATUS = Object.freeze({ PENDING, CLAIMED, PROCESSED, FAILED })
