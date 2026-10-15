/**
 * activity-plan.js — 按信号计算活动序列。
 * phase 列仍可存历史阶段名；读写都经过这里映射。
 */
import { createHash } from 'node:crypto'

export const LARGE_DIFF_FILES = 15

const LEGACY_TO_ACTIVITY = {
  RECEIVE: 'receive',
  CLASSIFY: 'classify',
  LOCATE: 'retrieve',
  PLAN: 'plan',
  EXECUTE: 'execute',
  VERIFY: 'static',
  DISTILL: 'distill',
  DONE: 'done',
  ABORTED: 'aborted',
}

const ACTIVITY_TO_LEGACY = {
  receive: 'RECEIVE',
  classify: 'CLASSIFY',
  retrieve: 'LOCATE',
  plan: 'PLAN',
  execute: 'EXECUTE',
  static: 'VERIFY',
  smoke: 'VERIFY',
  distill: 'DISTILL',
  done: 'DONE',
  aborted: 'ABORTED',
}

export function phaseToActivity(phase) {
  if (!phase) return 'receive'
  if (LEGACY_TO_ACTIVITY[phase]) return LEGACY_TO_ACTIVITY[phase]
  if (ACTIVITY_TO_LEGACY[phase]) return phase
  return 'receive'
}

export function projectPhase(activity) {
  return ACTIVITY_TO_LEGACY[activity] || activity
}

export function normalizeTarget(to) {
  if (!to) return null
  if (LEGACY_TO_ACTIVITY[to]) return LEGACY_TO_ACTIVITY[to]
  if (ACTIVITY_TO_LEGACY[to]) return to
  return null
}

/** 看板路径：活动投影成历史阶段名，去掉重复的 VERIFY。 */
export function legacyPathFromActivities(activities, currentPhase = null) {
  const path = []
  for (const a of activities || []) {
    const p = projectPhase(a)
    if (p && !path.includes(p)) path.push(p)
  }
  if (!path.includes('RECEIVE')) path.unshift('RECEIVE')
  if (currentPhase && !path.includes(currentPhase) && currentPhase !== 'ABORTED') {
    const at = path.indexOf('EXECUTE')
    path.splice(at >= 0 ? at : 1, 0, currentPhase)
  }
  if (!path.includes('DONE') && currentPhase !== 'ABORTED') path.push('DONE')
  return path
}

export function requirementHash(requirement) {
  const norm = String(requirement || '').replace(/\s+/g, ' ').trim()
  if (!norm) return ''
  return createHash('sha256').update(norm).digest('hex')
}

/**
 * @param {object} signals
 * @param {string[]} [signals.changedFiles]
 * @param {boolean} [signals.riskPath]
 * @param {boolean} [signals.contractTouch]
 * @param {string[]|null} [signals.sides] null = 端未定
 * @param {string} [signals.changeKind]
 * @param {boolean} [signals.uncertain]
 * @param {string|null} [signals.type]
 * @param {boolean} [signals.touchesUi]
 * @param {number} [signals.failStreak]
 */
export function buildActivityPlan(signals = {}) {
  const files = Array.isArray(signals.changedFiles) ? signals.changedFiles : []
  const large = files.length > (signals.largeThreshold || LARGE_DIFF_FILES)
  const risk = Boolean(signals.riskPath)
  const contract = Boolean(signals.contractTouch)
  const uncertain = Boolean(signals.uncertain)
  const bothSides = Array.isArray(signals.sides) && signals.sides.length > 1
  const cross = large || risk || bothSides
  const needsContext = ['FEATURE', 'UI_DEV', 'INTEGRATION', 'RELEASE'].includes(signals.type)
    || cross || contract || uncertain
  const specOnly = signals.changeKind === 'spec-only'
  const touchesUi = Boolean(signals.touchesUi) || ['UI_DEV', 'FEATURE', 'INTEGRATION'].includes(signals.type)

  const steps = ['receive']
  if (needsContext) {
    steps.push('retrieve')
    steps.push('plan')
  }
  steps.push('execute')
  if (!specOnly) steps.push('static')
  if (touchesUi && !specOnly) steps.push('smoke')
  return steps
}

export function deriveSize(signals = {}) {
  const files = Array.isArray(signals.changedFiles) ? signals.changedFiles : []
  const both = Array.isArray(signals.sides) && signals.sides.length > 1
  if (signals.contractTouch || signals.riskPath || both || files.length > LARGE_DIFF_FILES) return 'L'
  if (signals.touchesUi || ['UI_DEV', 'FEATURE', 'INTEGRATION'].includes(signals.type)) return 'M'
  return 'S'
}

export function signalsFromTask(task, changedFiles = null) {
  const meta = task?.meta && typeof task.meta === 'object' ? task.meta : {}
  const files = Array.isArray(changedFiles) ? changedFiles : Array.isArray(meta.changedFiles) ? meta.changedFiles : []
  const contractTouch = files.some((f) => /contract|openapi|swagger/i.test(String(f))) || Boolean(meta.contractTouch)
  const riskPath = Boolean(meta.riskPath)
  return {
    changedFiles: files,
    riskPath,
    contractTouch,
    sides: Array.isArray(meta.sides) ? meta.sides : null,
    changeKind: meta.changeKind || 'full',
    uncertain: Boolean(meta.uncertain),
    type: task?.type || null,
    touchesUi: Boolean(meta.touchesUi),
    failStreak: Number(meta.failStreak) || 0,
  }
}

const COMMON_TOOLS = ['harness_start', 'harness_status', 'harness_advance', 'get_doc', 'distill_query',
  // 任务上下文资产 / 影响面预检 / 蓝湖设计网关（2026-09-26）：全程可用，推送优于拉取
  'awp_task_attach', 'awp_task_attach_list', 'awp_impact_preview', 'awp_design_tools', 'awp_design_call']

export function toolsForActivity(activity) {
  const tools = [...COMMON_TOOLS]
  if (activity === 'retrieve' || activity === 'plan' || activity === 'classify') {
    tools.push('query_docs', 'list_docs')
  }
  if (activity === 'execute' || activity === 'static' || activity === 'smoke') {
    tools.push(
      'verify_report',
      'awp_test_run',
      'awp_loop_wait',
      'awp_loop_resume',
      'awp_test_lookup',
      'awp_test_spec_get',
      'awp_test_spec_submit',
      'awp_test_spec_review_status',
      'distill_append',
    )
  }
  if (activity === 'distill') tools.push('distill_append')
  return tools
}

export function nextActivity(phase, plan, meta = null) {
  const cur = phaseToActivity(phase)
  if (cur === 'done' || cur === 'aborted') return null
  if (cur === 'distill') {
    const resume = phaseToActivity(meta?.resumeActivity || 'execute')
    if (resume && resume !== 'distill' && resume !== 'done' && resume !== 'aborted') return resume
    return 'execute'
  }
  let idx = (plan || []).indexOf(cur)
  if (cur === 'classify') idx = (plan || []).indexOf('receive')
  if (idx < 0) idx = (plan || []).indexOf('receive')
  const next = (plan || [])[idx + 1]
  return next || 'done'
}

const LEGACY_TARGET = new Set(['CLASSIFY', 'LOCATE', 'PLAN', 'EXECUTE', 'VERIFY', 'DISTILL', 'RECEIVE'])

/**
 * 旧阶段名不改 phase，只指出下一活动。
 * 活动名必须等于计划中的下一步（distill / aborted 除外）。
 */
export function resolveAdvanceTarget(phase, requested, plan, meta = null) {
  const next = nextActivity(phase, plan, meta)
  if (requested === 'ABORTED' || requested === 'aborted') {
    return { ok: true, activity: 'aborted', store: 'aborted', next }
  }
  if (LEGACY_TARGET.has(requested)) {
    return {
      ok: false,
      code: 'LEGACY_TARGET',
      next,
      blockedBy: [`${requested} 不再直接改阶段。下一活动是 ${next}，请 harness_advance(to="${next}")`],
    }
  }
  const activity = normalizeTarget(requested)
  if (!activity) {
    return { ok: false, code: 'UNKNOWN_TARGET', next, blockedBy: [`未知目标 ${requested}`] }
  }
  if (activity === 'distill') {
    return { ok: true, activity: 'distill', store: 'distill', next }
  }
  if (activity !== next) {
    return {
      ok: false,
      code: 'ACTIVITY_MISMATCH',
      next,
      blockedBy: [`当前下一活动是 ${next}，不能进入 ${activity}`],
    }
  }
  return { ok: true, activity, store: activity, next }
}

export function nextToolFor(activity) {
  if (activity === 'execute') return 'awp_test_run'
  if (activity === 'static' || activity === 'smoke') return 'awp_loop_wait'
  if (activity === 'distill') return 'distill_append'
  if (activity === 'retrieve' || activity === 'plan') return 'query_docs'
  return 'harness_advance'
}

export function exitCriteriaFor(activity) {
  const text = {
    receive: '记录需求后推进。',
    classify: '信号已记录。按 activityPlan 进入下一步；进入 execute 时提交 AC（enforce 仓、计划含 plan 时必填）。',
    retrieve: '用 query_docs 取片段，结论写入 decisions 后推进。',
    plan: '提交 pending 或 decisions，以及 data.acceptance。',
    execute: '改完代码后：① 本地 L1 自检（prettier/eslint/build，不含 E2E）→ verify_report 上报；② awp_test_run(wait=true) 云端门禁（static+smoke，含 E2E）。失败后在本活动 distill_append，不要为了写经验改去 distill。计划内的 static/smoke 未绿不能完成。',
    static: '静态检查终态为 passed 后才能完成。',
    smoke: '只跑已确定的端。端未定（pending）时先声明 side，再下单。',
    distill: '写完经验后回到进入沉淀前的活动，不会退回 plan。',
    done: '任务已完成。',
    aborted: '任务已中止。',
  }
  return text[activity] || '调用 harness_advance 进入下一活动。'
}
