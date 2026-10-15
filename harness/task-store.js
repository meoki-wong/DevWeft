/**
 * task-store.js — 任务写入唯一入口
 *
 * 目标：
 *   1. phase 变更带 CAS（WHERE phase = fromPhase），并发 advance 只允许一个成功
 *   2. tasks / task_versions / gate_loops / task_sessions 同事务
 *   3. 失败不产生版本快照、不改 loop、不放 session
 *
 * 注意：本模块只做写入，不做门禁判定。判定在 state-machine / transition-evaluator。
 */
import { updateGateLoop, releaseTaskSession } from './loop.js'
import { projectPhase, phaseToActivity } from './activity-plan.js'

/**
 * tasks.phase 允许写入的活动名全集（方案决定 3）。
 * task_instances.phase 继续只存旧名，仅 projectPhase 负责投影。
 */
const ALLOWED_STORED_PHASES = new Set([
  'receive', 'classify', 'retrieve', 'plan', 'execute', 'static', 'smoke', 'distill', 'done', 'aborted',
])

export async function saveTaskVersion(db, taskId, repo, phase, snapshot, author) {
  await db.prepare(
    `INSERT INTO task_versions (task_id, repo, tenant_id, phase, snapshot, author, created_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?)`
  ).run(taskId, repo, repo, phase, JSON.stringify(snapshot), author, new Date().toISOString())
}

/**
 * 原子推进任务 phase。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} input
 * @param {string} input.repo
 * @param {string} input.taskId
 * @param {string} input.fromPhase  期望的当前 phase（CAS）
 * @param {string} input.to         目标 phase
 * @param {object} input.merged     要写入的字段（size/type/completed/pending/decisions/meta/requirement）
 * @param {string} input.author
 * @param {object} [input.snapshot] 版本快照内容
 * @param {object} [input.loopPatch] 传给 updateGateLoop 的 patch
 * @param {boolean} [input.releaseSession]
 * @returns {{ok: true}} 成功
 * @throws {Error & {code:'PHASE_CONFLICT'}} CAS 失败（phase 已被他人改掉）
 */
export async function transitionTask(db, {
  repo,
  taskId,
  fromPhase,
  to,
  merged,
  author,
  snapshot,
  loopPatch = null,
  releaseSession = false,
}) {
  const now = new Date().toISOString()
  // 方案 §6.1：写入 tasks.phase 前先得到活动名；不在允许列表（方案决定 3）→ INVALID_PHASE
  const storedTo = phaseToActivity(to)
  if (!ALLOWED_STORED_PHASES.has(storedTo)) {
    const err = new Error(`INVALID_PHASE: ${to}`)
    err.code = 'INVALID_PHASE'
    throw err
  }
  const size = merged.size ?? null
  const completed = JSON.stringify(merged.completed || [])
  const pending = JSON.stringify(merged.pending || [])
  const decisions = JSON.stringify(merged.decisions || [])
  const meta = JSON.stringify(merged.meta || {})

  const tx = async (tx) => {
    let updated
    if (storedTo === 'done') {
      updated = await tx.prepare(
        `UPDATE tasks SET phase = 'done', size = ?, completed = ?, pending = ?, decisions = ?, meta = ?, updated_at = ?, closed_at = ?
         WHERE repo = ? AND task_id = ? AND phase = ?`
      ).run(size, completed, pending, decisions, meta, now, now, repo, taskId, fromPhase)
    } else if (storedTo === 'aborted') {
      updated = await tx.prepare(
        `UPDATE tasks SET phase = 'aborted', meta = ?, updated_at = ?, closed_at = ?
         WHERE repo = ? AND task_id = ? AND phase = ?`
      ).run(meta, now, now, repo, taskId, fromPhase)
    } else {
      // 列集合与历史行为对齐：一般路径不写 requirement/type
      updated = await tx.prepare(
        `UPDATE tasks SET phase = ?, size = ?, completed = ?, pending = ?, decisions = ?, meta = ?, updated_at = ?
         WHERE repo = ? AND task_id = ? AND phase = ?`
      ).run(storedTo, size, completed, pending, decisions, meta, now, repo, taskId, fromPhase)
    }

    if (updated.changes !== 1) {
      const err = new Error(
        `PHASE_CONFLICT: task ${taskId} expected phase=${fromPhase}, 0 rows updated（可能已被并发 advance）`
      )
      err.code = 'PHASE_CONFLICT'
      throw err
    }

    await saveTaskVersion(
      tx,
      taskId,
      repo,
      storedTo,
      snapshot ?? {
        phase: storedTo,
        size: merged.size,
        completed: merged.completed,
        pending: merged.pending,
        decisions: merged.decisions,
      },
      author
    )

    if (loopPatch) {
      await updateGateLoop(tx, { repo, taskId, patch: loopPatch })
    }

    await syncTaskInstanceFields(tx, {
      repo,
      taskId,
      phase: storedTo,
      size: merged.size ?? null,
      type: merged.type ?? null,
    })

    if (releaseSession) {
      await releaseTaskSession(tx, { repo, taskId })
    }

    return { ok: true, from: fromPhase, to: storedTo }
  }

  return await db.tx(tx)
}

async function syncTaskInstanceFields(db, { repo, taskId, phase, size, type }) {
  try {
    const repoRow = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repo)
    if (!repoRow) return
    await db.prepare(
      `UPDATE task_instances
       SET phase = ?,
           size = COALESCE(?, size),
           type = COALESCE(?, type),
           updated_at = ?
       WHERE repo_id = ? AND external_task_id = ? AND status = 'open'`
    ).run(projectPhase(phase), size, type, new Date().toISOString(), repoRow.repo_id, taskId)
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return
    const err = new Error(`INSTANCE_SYNC_FAILED: ${e.message}`)
    err.code = 'INSTANCE_SYNC_FAILED'
    throw err
  }
}
