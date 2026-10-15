/**
 * guards.js — 状态流转守卫（查 verify_reports / 任务字段）
 *
 * 功能验证（L2）优先级（租户隔离，全项目统一）：
 *  - 云端门禁健康 → 不强制本地 L2（云端为真源；本地 verify 仅自检）
 *  - 云端不可用且仓有 verify.sh → 切换本地 L2 兜底，必须 L2 pass
 *  - 仓无 verify.sh → 永不强制本地 L2
 */
import db from '../db.js'
import { resolveVerifySource } from '../testing/verify-mode.js'
import { acceptAsGateEvidence, allowRepoL2Fallback } from '../testing/verify-evidence.js'
import { phaseToActivity } from './activity-plan.js'
import { evalPolicies } from './opa-policy.js'

async function latestVerifyPass({ taskId, repo, level }) {
  const row = await db
    .prepare(
      `SELECT pass, created_at, file, errors, task_id, repo, workspace_head
       FROM verify_reports
       WHERE repo = ? AND level = ? AND task_id = ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(repo, level, taskId)
  return row || null
}

async function countVerifyPass({ taskId, repo, level }) {
  const row = await db
    .prepare(
      `SELECT COUNT(*) as c FROM verify_reports
       WHERE repo = ? AND level = ? AND task_id = ? AND pass = 1`
    )
    .get(repo, level, taskId)
  return row?.c || 0
}

/** L 级 fallback：无 task_id 的历史上报，按任务创建后的 repo 级 L2 */
async function latestVerifyPassRepoFallback({ repo, level, since }) {
  const row = await db
    .prepare(
      `SELECT pass, created_at FROM verify_reports
       WHERE repo = ? AND level = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(repo, level, since)
  return row || null
}

/** 是否需要本地 L2（云端优先） */
async function needLocalL2(repo) {
  const v = await resolveVerifySource(db, repo || 'demo-app')
  return v.source === 'local'
}

function parseJsonField(val, fallback) {
  if (val == null) return fallback
  if (typeof val === 'string') {
    try {
      return JSON.parse(val)
    } catch {
      return fallback
    }
  }
  return val
}

/** L1 时效校验：strict 时过期/跨任务不可用；默认 warn */
async function checkL1Freshness(task, { taskId, repo, level = 'L1' }) {
  const row = await latestVerifyPass({ taskId, repo, level })
  if (!row) return { ok: false, row: null, reasons: ['no_report'] }
  let anchorAt = null
  let workspaceHead = null
  try {
    const meta = JSON.parse(task.meta || '{}')
    anchorAt = meta.evidenceAnchorAt || null
    workspaceHead = meta.evidenceWorkspaceHead || null
  } catch { /* ignore */ }
  const v = await acceptAsGateEvidence(db, row, {
    repo,
    taskId,
    anchorAt,
    workspaceHead,
    requireTaskMatch: true,
  })
  if (!v.ok && v.strict) {
    return { ok: false, row, reasons: v.reasons }
  }
  if (!v.ok && !v.strict) {
    try {
      process.stderr.write(
        `[guards] WARN stale L1 evidence task=${taskId} reasons=${v.reasons.join(',')}\n`
      )
    } catch { /* ignore */ }
  }
  return { ok: true, row, reasons: v.reasons || [] }
}

/**
 * @returns {{ ok: boolean, blockedBy: string[] }}
 */
export async function checkGuard(to, task) {
  const { task_id: taskId, repo, phase, created_at: since, size } = task
  const meta = parseJsonField(task.meta, {})
  const from = phaseToActivity(phase)
  const target = phaseToActivity(to)
  // aborted 直通(与 mandatory 策略一致;JS 快路径省一次求值)
  if (target === 'aborted' || to === 'ABORTED') return { ok: true, blockedBy: [] }

  // —— 证据收集(JS 保留;决策在 OPA WASM,§10/§16.3)——
  const facts = {
    pendingCount: 0,
    decisionsCount: 0,
    l1Ok: true,
    l1Reasons: [],
    needLocalL2: false,
    l2Ok: true,
    riskPath: Boolean(meta.riskPath),
    contractTouch: Boolean(meta.contractTouch),
    l3Confirmed: Boolean(meta.l3Confirmed),
    repoMode: null,
    candidateMode: null,
  }
  if (from === 'plan' && target === 'execute') {
    const pending = parseJsonField(task.pending, [])
    const decisions = parseJsonField(task.decisions, [])
    facts.pendingCount = pending.length
    facts.decisionsCount = decisions.length
  } else if (from === 'execute' && ['static', 'smoke', 'done'].includes(target)) {
    const l1 = await checkL1Freshness(task, { taskId, repo, level: 'L1' })
    facts.l1Ok = l1.ok
    facts.l1Reasons = l1.ok ? [] : (l1.reasons || ['no_report'])
  } else if (['static', 'smoke', 'distill'].includes(from) && target === 'done') {
    if (await needLocalL2(repo)) {
      facts.needLocalL2 = true
      let l2 = await latestVerifyPass({ taskId, repo, level: 'L2' })
      if ((!l2 || !l2.pass) && await allowRepoL2Fallback(db)) {
        l2 = await latestVerifyPassRepoFallback({ repo, level: 'L2', since })
      }
      facts.l2Ok = Boolean(l2 && l2.pass)
    }
  }

  // —— 决策(OPA WASM 进程内求值,§10)——求值抛错/超时:POLICY_EVAL_FAILED,不得放行(§16.1)
  try {
    const decision = await evalPolicies({
      tenant: repo,
      feature: 'harness.guard',
      phase: from,
      target,
      size: size || null,
      changedFiles: [],
      author: null,
      facts,
      factors: [],
    })
    return { ok: decision.ok, blockedBy: decision.blocked.map((b) => b.message) }
  } catch (e) {
    return {
      ok: false,
      code: e.code || 'POLICY_EVAL_FAILED',
      blockedBy: [`${e.code || 'POLICY_EVAL_FAILED'}: ${e.message}`],
    }
  }
}
