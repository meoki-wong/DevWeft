/**
 * transition-evaluator.js — status / advance / DONE 共用纯判定器
 *
 * 目标：status 展示的 allowed 与 advance 实际门禁同源，避免「status 说可以、advance 却失败」。
 * 本模块只读判定，不写库。
 */
import { checkGuard } from './guards.js'
import { signalsFromTask, resolveAdvanceTarget, phaseToActivity } from './activity-plan.js'
import { buildActivityPlanDispatched } from './dispatch.js'
import {
  checkAcDiscipline,
  checkDoneGate,
  evaluateAcCoverage,
  evaluateNewGate,
  getRepoGateMode,
  isPlatformGateTransition,
  shouldEnforceNewGate,
} from './testing-gate.js'
import { resolveGatePolicy } from './gate-policy.js'

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} input
 * @param {object} input.task  已 parse 的任务行
 * @param {string} input.to
 * @param {string} input.repo
 * @param {string[]} [input.changedFiles]
 * @param {string} [input.author]
 * @param {boolean} [input.deep=false]  是否做 AC 覆盖/云端等重查询（status 默认轻量）
 */
export async function evaluateTransition(db, {
  task,
  to,
  repo,
  changedFiles = null,
  author = null,
  deep = false,
}) {
  const blockedBy = []
  const signals = signalsFromTask(task, changedFiles)
  // §9 harness.activityPlan(replace):接线 evaluateTransition(§15.2)
  const plan = await buildActivityPlanDispatched(db, { repoSlug: repo, signals })
  const resolved = resolveAdvanceTarget(task.phase, to, plan, task.meta)
  if (!resolved.ok) {
    return {
      ok: false,
      to,
      blockedBy: resolved.blockedBy,
      code: resolved.code,
      nextActivity: resolved.next,
      mode: await getRepoGateMode(db, repo),
      effectiveMode: null,
      factors: [],
      acCoverage: null,
      doneAcBlock: false,
    }
  }
  to = resolved.store
  const phase = task.phase
  const size = task.size

  const guard = await checkGuard(to, task)
  if (!guard.ok) blockedBy.push(...guard.blockedBy)

  const mode = await getRepoGateMode(db, repo)
  const acDiscipline = checkAcDiscipline({
    phase,
    to,
    size,
    mode,
    metaAcceptance: task.meta?.acceptance || null,
    acceptanceInput: null,
    snapshotFrozen: Boolean(task.meta?.productSnapshotAt),
  })
  if (acDiscipline) blockedBy.push(...acDiscipline.blockedBy)

  let gatePolicy = null
  try {
    gatePolicy = await resolveGatePolicy(db, {
      repoSlug: repo,
      taskId: task.task_id,
      size,
      changedFiles,
      author,
    })
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) {
      blockedBy.push(`POLICY_EVAL_FAILED: ${e.message}`)
    }
    gatePolicy = null
  }

  let acCoverage = null
  let doneAcBlock = false
  const target = phaseToActivity(to)
  const effectiveMode = gatePolicy?.effectiveMode || mode
  if (deep && isPlatformGateTransition(phase, to, size) && effectiveMode !== 'legacy' && effectiveMode !== 'disabled') {
    try {
      const testingEval = await evaluateNewGate(db, {
        repoSlug: repo,
        taskId: task.task_id,
        size,
        gateBindingId: null,
        expectedTaskRevision: null,
      })
      if (shouldEnforceNewGate(effectiveMode, size) && testingEval.wouldBlock) {
        blockedBy.push(...(testingEval.blockedBy || ['云端门禁未通过']))
      }
    } catch (e) {
      if (!/no such table/i.test(String(e?.message || e))) {
        blockedBy.push(`GATE_EVAL_FAILED: ${e.message}`)
      }
    }
  }
  if (deep && target === 'done') {
    if (shouldEnforceNewGate(effectiveMode, size)) {
      try {
        const doneGate = await checkDoneGate(db, { repoSlug: repo, taskId: task.task_id, size, mode: effectiveMode })
        if (!doneGate.ok && doneGate.code !== 'DISABLED_BYPASS') {
          blockedBy.push(...(doneGate.blockedBy || [doneGate.message || '云端门禁未绿']))
        }
      } catch (e) {
        if (!/no such table/i.test(String(e?.message || e))) {
          blockedBy.push(`GATE_EVAL_FAILED: ${e.message}`)
        }
      }
      try {
        acCoverage = await evaluateAcCoverage(db, { repoSlug: repo, taskId: task.task_id })
        if (acCoverage.applicable && acCoverage.missing?.length) {
          doneAcBlock = true
          blockedBy.push(`AC 覆盖率不足：${acCoverage.missing.join('、')} 尚无 active 考卷覆盖`)
        }
        if (acCoverage.applicable && acCoverage.mutationPending) {
          doneAcBlock = true
          blockedBy.push('AC 覆盖考卷尚未通过变异验卷（MUTATION_UNVERIFIED）')
        }
      } catch (e) {
        if (!/no such table/i.test(String(e?.message || e))) {
          blockedBy.push(`AC_COVERAGE_FAILED: ${e.message}`)
        }
      }
    }
  }

  return {
    ok: blockedBy.length === 0,
    to,
    blockedBy,
    mode,
    effectiveMode: gatePolicy?.effectiveMode || mode,
    factors: gatePolicy?.factors || [],
    acCoverage,
    doneAcBlock,
  }
}

/**
 * 为 harnessStatus 生成 allowedTransitions（与 advance 同源的 guard/AC 判定）。
 */
export async function evaluateAllowedTransitions(db, { task, repo, nextPhases, changedFiles = null, author = null }) {
  // 逐项判定为异步（postgres 方言下 checkGuard/gate 查询是 IO），用 Promise.all 保持逐项顺序
  return Promise.all(
    (nextPhases || []).map(async (to) => {
      const ev = await evaluateTransition(db, { task, to, repo, changedFiles, author, deep: true })
      return {
        to,
        allowed: ev.ok,
        blockedBy: ev.blockedBy,
        effectiveMode: ev.effectiveMode,
        factors: ev.factors,
      }
    })
  )
}
