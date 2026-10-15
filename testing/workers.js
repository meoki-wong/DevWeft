/**
 * Worker 心跳与运行管理（§11.2/§11.3）：
 *   worker 层心跳 15s/离线阈值 60s；cancel 通过 desired_state 下发。
 */
import { ApiError } from './errors.js'
import { utcNow } from './ids.js'

export const WORKER_OFFLINE_AFTER_MS = 60 * 1000

export async function touchWorkerHeartbeat(db, workerId, { now = new Date() } = {}) {
  const row = await db.prepare('SELECT status FROM workers WHERE worker_id=?').get(workerId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  const status = row.status === 'offline' ? 'active' : row.status
  await db.prepare('UPDATE workers SET last_heartbeat_at=?, status=? WHERE worker_id=?')
    .run(now.toISOString(), status, workerId)
  return { workerId, status }
}

export async function sweepWorkerHeartbeats(db, { now = new Date(), offlineAfterMs = WORKER_OFFLINE_AFTER_MS } = {}) {
  const deadline = new Date(now.getTime() - offlineAfterMs).toISOString()
  const rows = await db.prepare(
    `SELECT worker_id FROM workers
     WHERE status='active'
       AND last_heartbeat_at IS NOT NULL
       AND last_heartbeat_at < ?`
  ).all(deadline)
  for (const { worker_id: workerId } of rows) {
    await db.prepare(`UPDATE workers SET status='offline' WHERE worker_id=? AND status='active'`).run(workerId)
  }
  return rows.map((r) => r.worker_id)
}

/** 除 self 外仍活跃（心跳未过期）的 worker 数；standby 据此判断"主机 worker 是否疑似停摆"再决定是否接管。 */
export async function countOtherActiveWorkers(db, selfWorkerId, { now = new Date(), ttlMs = WORKER_OFFLINE_AFTER_MS } = {}) {
  const cutoff = new Date(now.getTime() - ttlMs).toISOString()
  const row = await db.prepare(
    `SELECT COUNT(*) AS c FROM workers WHERE worker_id <> ? AND status='active' AND last_heartbeat_at IS NOT NULL AND last_heartbeat_at >= ?`
  ).get(selfWorkerId, cutoff)
  return Number(row?.c || 0)
}

export async function cancelRun(db, { runId, now = new Date() } = {}) {
  const row = await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get(runId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (['queued', 'active'].includes(row.status)) {
    await db.prepare(
      `UPDATE test_runs SET desired_state='canceled' WHERE run_id=?`
    ).run(runId)
  }
  return { runId, desiredState: 'canceled' }
}
