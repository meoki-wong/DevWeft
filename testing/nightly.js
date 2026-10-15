/**
 * testing/nightly.js — 每日夜间全量回归（2026-09-26）
 *
 * 形态：合成 harness 任务（nightly-<date>），复用生产状态机/门禁/执行全链路——
 * receive→retrieve→plan→execute 正常推进（M 级带 AC），submitGateRun 下单后不等终态。
 *
 * 三个关键约束（可靠性审计结论）：
 *   1) tasks.meta.nightly=1 标记 → ①每日05:00清扫豁免（nightly 任务由下一轮清理）
 *      ②completeLease 跳过 ensureMutationRuns（否则全量全绿=自动排 N 个变异 run，VM 成本失控）
 *   2) 上一轮未结束的 nightly 任务在新一轮启动时由 forceStopTask 清理（取消在飞 run + 销毁 VM）
 *   3) 全量考卷注入依赖仓 e2e 注入模式（与正常送测同源，不做特殊通道）
 */
import db from '../db.js'
import { harnessStart, harnessAdvance } from '../harness/state-machine.js'
import { submitGateRun } from './submit-run.js'
import { forceStopTask } from '../harness/stop-task.js'
import { recordAuditEvent } from '../audit/index.js'

export const NIGHTLY_TASK_PREFIX = 'nightly-'
// AC id 有格式校验（须形如 AC-1），夜间合成任务的验收项沿用该形态
export const NIGHTLY_ACCEPTANCE_ID = 'AC-1'

export async function runNightlyRegression({ repoSlug = 'demo-app', author = 'system:nightly' } = {}) {
  const date = new Date().toISOString().slice(0, 10)
  // 任务 id 带时分秒+毫秒：同日/同秒重跑不撞主键；上一轮由下方清理逻辑 ABORT
  const now = new Date()
  const hhmmss = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}${String(now.getMilliseconds()).padStart(3, '0')}`
  const taskId = `${NIGHTLY_TASK_PREFIX}${date}-${hhmmss}`

  // 1) 清理上一轮 nightly（未结束的：ABORTED + 取消在飞 run + 销毁 VM）
  let cleanedPrev = 0
  try {
    const prev = await db.prepare(
      `SELECT task_id FROM tasks WHERE repo=? AND task_id LIKE ? AND phase NOT IN ('DONE','ABORTED','done','aborted')`
    ).all(repoSlug, `${NIGHTLY_TASK_PREFIX}%`)
    for (const p of prev) {
      try {
        await forceStopTask({ taskId: p.task_id, repo: repoSlug, author, reason: '新一轮夜间回归启动：清理上一轮 nightly', destroyVm: true })
        cleanedPrev++
      } catch { /* 尽力清理，不阻断本轮 */ }
    }
  } catch { /* 查询失败不阻断 */ }

  // 2) 合成任务（真实 harness 任务：forceNew 防同名拦；UI_DEV → 活动计划含 retrieve/plan/smoke，size=M）
  const started = await harnessStart({
    taskId,
    requirement: `夜间全量回归 ${date}（系统合成任务：全量 active 考卷回归，非业务需求）`,
    type: 'UI_DEV',
    author,
    repo: repoSlug,
    forceNew: true,
  })
  if (!started.ok) {
    return { ok: false, code: started.code || 'START_FAILED', detail: String(started.error || '').slice(0, 300) }
  }
  try {
    const row = await db.prepare('SELECT meta FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId)
    const meta = JSON.parse(row?.meta || '{}')
    meta.nightly = true
    await db.prepare('UPDATE tasks SET meta=? WHERE repo=? AND task_id=?').run(JSON.stringify(meta), repoSlug, taskId)
  } catch { /* 标记失败只影响清扫豁免/变异排除兜底 */ }

  // 3) 按状态机正常推进：receive→retrieve→plan→execute（M 级带 AC；size 显式 M 保证 static+smoke 双端）
  const step = async (to, data) => await harnessAdvance({ taskId, to, data, author, repo: repoSlug })
  const a1 = await step('retrieve', { size: 'M', decisions: ['夜间例行：全量 active 考卷回归'] })
  if (!a1?.ok) return { ok: false, code: 'ADVANCE_RETRIEVE_FAILED', detail: JSON.stringify(a1?.blockedBy || a1?.error || '').slice(0, 300) }
  const a2 = await step('plan', { pending: ['全量考卷回归'] })
  if (!a2?.ok) return { ok: false, code: 'ADVANCE_PLAN_FAILED', detail: JSON.stringify(a2?.blockedBy || a2?.error || '').slice(0, 300) }
  const a3 = await step('execute', { acceptance: [{ id: NIGHTLY_ACCEPTANCE_ID, text: '夜间全量回归：全部 active 考卷执行通过', type: 'data' }] })
  if (!a3?.ok) return { ok: false, code: 'ADVANCE_EXECUTE_FAILED', detail: JSON.stringify(a3?.blockedBy || a3?.error || '').slice(0, 300) }

  // 4) 下单（不等终态；worker 空闲时段自然消费）
  let out
  try {
    out = await submitGateRun(db, { taskId, author, repoSlug, side: 'both' })
  } catch (e) {
    try {
      await recordAuditEvent({
        eventType: 'nightly_regression_failed', toolName: 'nightly', method: 'system',
        repo: repoSlug, taskId, author, status: 'error',
        detail: String(e.message || e).slice(0, 300),
      })
    } catch { /* ignore */ }
    return { ok: false, code: 'SUBMIT_FAILED', taskId, detail: String(e.message || e).slice(0, 300), cleanedPrev }
  }

  try {
    await recordAuditEvent({
      eventType: 'nightly_regression_started', toolName: 'nightly', method: 'system',
      repo: repoSlug, taskId, author, status: 'ok',
      detail: `submission=${out.submissionId} units=${(out.requiredUnits || []).join(',')}`,
      payload: { submissionId: out.submissionId, requiredUnits: out.requiredUnits, cleanedPrev },
    })
  } catch { /* ignore */ }
  return {
    ok: true, taskId, submissionId: out.submissionId, bindingId: out.bindingId,
    requiredUnits: out.requiredUnits, cleanedPrev,
  }
}
