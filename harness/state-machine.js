/**
 * state-machine.js — Harness 状态机（团队共享，IDE 无关）
 *
 * 主路径（L）：RECEIVE → CLASSIFY → LOCATE → PLAN → EXECUTE → VERIFY → DISTILL → DONE
 * 中路径（M）：RECEIVE → CLASSIFY → EXECUTE → VERIFY → DONE
 * 短路径（S）：RECEIVE → CLASSIFY → EXECUTE → DONE
 */
import { isPostgres } from '../db/dialect-helpers.js'
import db from '../db.js'
import { runHarnessMigrations } from './migrate.js'
import { ensureTenantRepo } from '../testing/migrate.js'
import { getTenantContextHints } from '../testing/tenant-config.js'
import { checkGuard } from './guards.js'
import { buildContextPack } from './context.js'
import { phaseLabel, buildWorkflowView, buildTestNodes } from './labels.js'
import { transitionTask } from './task-store.js'
import { assertTaskDriver } from './session-guard.js'
import { stampEvidenceAnchor } from '../testing/verify-evidence.js'
import { changedFilesForBinding } from '../testing/impact.js'
import { evaluateAllowedTransitions } from './transition-evaluator.js'
import {
  checkAcDiscipline,
  checkDoneGate,
  evaluateAcCoverage,
  evaluateNewGate,
  findUnsummarizedGateFailure,
  getRepoGateMode,
  getTaskAcceptance,
  isPlatformGateTransition,
  isSpecOnActiveBindingPath,
  recordObserveEvent,
  shouldEnforceNewGate,
  testingPolicy,
  validateAcceptance,
} from './testing-gate.js'
import {
  acquireTaskSession,
  ensureGateLoop,
  getActiveTaskSession,
  getGateLoop,
  releaseTaskSession,
  syncGateLoopFromRunGroup,
  updateGateLoop,
  buildPacketWithDb,
} from './loop.js'
import { resolveVerifySource } from '../testing/verify-mode.js'
import { recordAuditEvent } from '../audit/index.js'
import { resolveGatePolicy } from './gate-policy.js'
import { resolveRepoWorkspacePath } from '../testing/repo-platform.js'
import { resolveWorkspaceHeadOid } from '../testing/snapshots.js'
import { buildDeliveryPack } from './delivery.js'
import { taskAttachmentSummaries } from './attachments.js'
import { requirementHash, buildActivityPlan, signalsFromTask, deriveSize, phaseToActivity, exitCriteriaFor, nextToolFor, legacyPathFromActivities, nextActivity, resolveAdvanceTarget } from './activity-plan.js'
import { buildActivityPlanDispatched, applyFloorDispatched, assertNoMissingHandlers, resolveCapability } from './dispatch.js'

runHarnessMigrations()

const TERMINAL = new Set(['DONE', 'ABORTED', 'done', 'aborted'])
const OPEN_PHASES = [
  'RECEIVE', 'CLASSIFY', 'LOCATE', 'PLAN', 'EXECUTE', 'VERIFY', 'DISTILL',
  'receive', 'retrieve', 'plan', 'execute', 'static', 'smoke', 'distill', 'classify',
]

function parseTask(row) {
  if (!row) return null
  return {
    ...row,
    completed: JSON.parse(row.completed || '[]'),
    pending: JSON.parse(row.pending || '[]'),
    decisions: JSON.parse(row.decisions || '[]'),
    meta: JSON.parse(row.meta || '{}'),
  }
}

async function getTask(repo, taskId) {
  return parseTask(await db.prepare('SELECT * FROM tasks WHERE repo = ? AND task_id = ?').get(repo, taskId))
}

async function saveVersion(taskId, repo, phase, snapshot, author) {
  await db.prepare(
    `INSERT INTO task_versions (task_id, repo, tenant_id, phase, snapshot, author, created_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?)`
  ).run(taskId, repo, repo, phase, JSON.stringify(snapshot), author, new Date().toISOString())
}

/** 从需求正文提取被误写进去的 taskId（如 taskId=2026-09-17-xxx） */
function extractEmbeddedTaskId(requirement) {
  const m = String(requirement || '').match(/taskId\s*[=:：]\s*([^\s，,；;）)]+)/i)
  return m ? m[1].trim() : null
}

function requirementFingerprint(requirement) {
  return requirementHash(requirement)
}

/**
 * 查找同仓未终态、需求高度相似的任务（防误开 -2）。
 * 指纹前缀相同 或 显式 taskId 命中 open 任务。
 */
async function findOpenSimilarTask(db, { repo, requirement, excludeTaskId = null }) {
  const openPhases = OPEN_PHASES
  const rows = await db
    .prepare(
      `SELECT task_id, phase, requirement, author, updated_at FROM tasks
       WHERE repo = ? AND phase IN (${openPhases.map(() => '?').join(',')})
       ORDER BY updated_at DESC LIMIT 50`
    )
    .all(repo, ...openPhases)
  const fp = requirementFingerprint(requirement)
  const embedded = extractEmbeddedTaskId(requirement)
  for (const r of rows) {
    if (excludeTaskId && r.task_id === excludeTaskId) continue
    if (embedded && r.task_id === embedded) {
      return { task: r, reason: 'embedded-task-id' }
    }
    if (fp && requirementFingerprint(r.requirement) === fp) {
      return { task: r, reason: 'requirement-hash' }
    }
  }
  return null
}

/**
 * 开启任务（RECEIVE）
 * forceNew=true：显式要求并行新任务（绕过同需求防重，仍会审计）。
 */
export async function harnessStart({ taskId, requirement, type = 'FEATURE', author, repo = 'demo-app', forceNew = false }) {
  let id = taskId
  let autoId = false

  // 防误开：正文里写了 taskId=旧任务 且该任务未终态 → 必须续作，禁止再 start
  if (!forceNew) {
    const embedded = extractEmbeddedTaskId(requirement)
    if (embedded && embedded !== taskId) {
      const emb = await getTask(repo, embedded)
      if (emb && !TERMINAL.has(emb.phase)) {
        return {
          ok: false,
          code: 'RESUME_EXISTING',
          error:
            `需求正文引用了未终态任务 ${embedded}（phase=${emb.phase}）。` +
            `禁止再 harness_start 冒充新任务；请 harness_status(taskId="${embedded}") 续作。` +
            `若确要另开并行任务，请去掉正文中的 taskId= 并传 forceNew=true。`,
          existingTaskId: embedded,
          existingPhase: emb.phase,
        }
      }
    }

    // 未显式 taskId 时：同仓已有高度相似未终态任务 → 拒绝自动建 -2
    if (!taskId) {
      const similar = await findOpenSimilarTask(db, { repo, requirement })
      if (similar) {
        return {
          ok: false,
          code: 'DUPLICATE_OPEN_TASK',
          error:
            `检测到同仓已有高度相似的未终态任务 ${similar.task.task_id}（phase=${similar.task.phase}，依据=${similar.reason}）。` +
            `请 harness_status(taskId="${similar.task.task_id}") 续作。` +
            `禁止对同一需求反复 start 生成 ${taskId || '自动 id'}-2 旁路任务。` +
            `若确认是另一条需求，请在 requirement 中写清差异，并传 forceNew=true。`,
          existingTaskId: similar.task.task_id,
          existingPhase: similar.task.phase,
          matchReason: similar.reason,
        }
      }
    }
  }

  if (!id) {
    autoId = true
    const base = `${new Date().toISOString().slice(0, 10)}-${(requirement || 'task').slice(0, 12).replace(/[^\w一-龥-]/g, '')}`
    id = base
    let n = 1
    while (await db.prepare('SELECT task_id FROM tasks WHERE repo = ? AND task_id = ?').get(repo, id)) {
      n += 1
      id = `${base}-${n}`
      if (n > 50) {
        id = `${base}-${Date.now().toString(36)}`
        break
      }
    }
  }

  const existing = await db.prepare('SELECT task_id, phase FROM tasks WHERE repo = ? AND task_id = ?').get(repo, id)
  if (existing) {
    const phase = existing.phase || null
    return {
      ok: false,
      code: TERMINAL.has(phase) ? 'TASK_TERMINAL' : 'TASK_EXISTS',
      error: TERMINAL.has(phase)
        ? `任务已处于终态 ${phase}：${id}。不可再续作；请评估是否 harness_start 开新任务（写清与旧任务的增量关系）。`
        : `任务已存在：${id}（phase=${phase}）。请用 harness_status(taskId) 续作，禁止对同一需求反复 start。`,
      existingTaskId: id,
      existingPhase: phase,
    }
  }

  // 新 repo 即开独立租户（项目管理可见、可配门禁/工作区），禁止只出现任务下拉的幽灵仓
  let tenant = null
  try {
    tenant = await ensureTenantRepo(db, repo)
  } catch (e) {
    return { ok: false, error: `INVALID_REPO: ${e.message}` }
  }

  const now = new Date().toISOString()
  // 任务起点 HEAD：改动集归因边界（dirty ∪ diff(startHeadOid, HEAD)）。
  // 解析失败不阻断开任务；提交侧会退化为「只认脏改动」。
  let startHeadOid = null
  try {
    const ws = resolveRepoWorkspacePath(repo)
    if (ws) startHeadOid = resolveWorkspaceHeadOid(ws)
  } catch {
    startHeadOid = null
  }
  const startMeta = {
    startHeadOid: startHeadOid || null,
    startAt: now,
    startSource: startHeadOid ? 'workspace-head' : 'unresolved',
  }
  await db.prepare(
    `INSERT INTO tasks (task_id, repo, tenant_id, requirement, type, phase, size, completed, pending, decisions, meta, author, created_at, updated_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, 'receive', NULL, '[]', ?, '[]', ?, ?, ?, ?)`
  ).run(id, repo, repo, requirement, type, JSON.stringify([requirement]), JSON.stringify(startMeta), author, now, now)

  await saveVersion(id, repo, 'receive', { requirement, type, phase: 'receive' }, author)
  await ensureGateLoop(db, { repo, taskId: id, phase: 'receive' })
  try {
    await acquireTaskSession(db, { repo, taskId: id, ownerSubject: author })
  } catch {
    /* 租约失败不阻开任务 */
  }

  return {
    ok: true,
    taskId: id,
    autoId,
    tenant: tenant ? { repoId: tenant.repoId, slug: tenant.slug, created: tenant.created } : null,
    message: autoId && /-\d+$/.test(id)
      ? `已创建任务 ${id}（与同日同名前缀冲突，自动加后缀）`
      : `已创建任务 ${id}`,
    status: await harnessStatus({ taskId: id, repo }),
  }
}

/**
 * 从 active binding / gate_loops.last_binding_id 读取本次改动文件清单。
 * 取不到返回 null（动态因子不生效，但不降级 repoMode）。
 */
async function loadChangedFilesForTask(db, { repoSlug, taskId }) {
  try {
    const loopRow = await db.prepare(
      `SELECT last_binding_id FROM gate_loops WHERE repo=? AND task_id=?`
    ).get(repoSlug, taskId)
    if (loopRow?.last_binding_id) {
      const files = await changedFilesForBinding(db, loopRow.last_binding_id)
      if (files && files.length) return files
    }
  } catch { /* ignore */ }
  try {
    const inst = await db.prepare(
      `SELECT active_binding_id FROM task_instances
       WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=?)
         AND external_task_id=?`
    ).get(repoSlug, taskId)
    if (inst?.active_binding_id) {
      const files = await changedFilesForBinding(db, inst.active_binding_id)
      if (files && files.length) return files
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 查询任务状态 + 允许流转 + 上下文包
 *
 * @param {object} opts
 * @param {boolean} [opts.syncLoop=false]  是否允许写 gate_loops（默认只读，dashboard 轮询安全）
 *   advance/resume/test_run_wait 等写路径应显式传 true。
 */
// QUERY_CLASS: TENANT —— 按 (repo, task_id) 归属查询，RLS 上限内可见（方案 §7.1）
export async function harnessStatus({ taskId, repo = 'demo-app', syncLoop = false, view = 'rest' }) {
  const task = await getTask(repo, taskId)
  if (!task) return { ok: false, error: `任务不存在：${taskId}` }
  // 云端测试可插拔：该仓 disabled 时不做环同步、不算 resumable（门禁语义整体旁路）
  const cloudDisabled = await getRepoGateMode(db, repo) === 'disabled'

  const planSignalsEarly = signalsFromTask(task, await loadChangedFilesForTask(db, { repoSlug: repo, taskId }))
  // §9 harness.activityPlan(replace):无登记行时与 §8 结束时一致;
  // handler 未注册时不得回落 default —— 置空计划并由 capabilityError 透出
  let activityPlanEarly
  try {
    activityPlanEarly = await buildActivityPlanDispatched(db, { repoSlug: repo, signals: planSignalsEarly })
  } catch (e) {
    if (e.code === 'CAPABILITY_HANDLER_MISSING') activityPlanEarly = []
    else throw e
  }
  const next = nextActivity(task.phase, activityPlanEarly, task.meta)
  const allowedBase = []
  if (next) allowedBase.push(next)
  const curAct = phaseToActivity(task.phase)
  if (['execute', 'static', 'smoke'].includes(curAct) && next !== 'distill') allowedBase.push('distill')
  let allowed
  try {
    // 与 advance 同源判定（guard + AC 纪律），status 展示可信
    const evalInputs = {
      task,
      repo,
      nextPhases: allowedBase,
      changedFiles: await loadChangedFilesForTask(db, { repoSlug: repo, taskId }),
      author: task.author,
    }
    allowed = await Promise.all((await evaluateAllowedTransitions(db, evalInputs)).map(async (e) => ({
      to: e.to,
      allowed: e.allowed,
      blockedBy: e.blockedBy,
      testing: await testingPolicy(db, {
        repoSlug: repo,
        taskId,
        phase: task.phase,
        size: task.size,
        nextTo: e.to,
      }),
      effectiveMode: e.effectiveMode,
    })))
  } catch {
    // 异步守卫失败回退：Promise.all 保持与主路径同形的数组结果
    allowed = await Promise.all(allowedBase.map(async (to) => {
      const guard = await checkGuard(to, task)
      return {
        to,
        allowed: guard.ok,
        blockedBy: guard.blockedBy,
        testing: await testingPolicy(db, {
          repoSlug: repo,
          taskId,
          phase: task.phase,
          size: task.size,
          nextTo: to,
        }),
      }
    }))
  }

  // 任意非终态可 abort
  if (!TERMINAL.has(task.phase)) {
    allowed.push({ to: 'aborted', allowed: true, blockedBy: [] })
  }

  const testing = await testingPolicy(db, {
    repoSlug: repo,
    taskId,
    phase: task.phase,
    size: task.size,
  })
  let verifyMode = null
  try {
    verifyMode = await resolveVerifySource(db, repo)
  } catch {
    verifyMode = null
  }
  let attachmentsText = null
  try { attachmentsText = await taskAttachmentSummaries(repo, taskId) } catch { attachmentsText = null }
  const contextPack = buildContextPack(task.phase, {
    size: task.size,
    type: task.type,
    testing,
    verifyMode,
    tenantHints: getTenantContextHints(repo),
    relatedExperiences: await topRelatedExperiences(repo, task.requirement),
    attachmentsText,
  })

  // CLRP：同步环状态 + 可恢复包（默认只读；syncLoop=true 时才写）
  let gateLoop = await getGateLoop(db, { repo, taskId })
  let remediation = null
  const canSync =
    syncLoop &&
    !TERMINAL.has(task.phase) &&
    !cloudDisabled &&
    ['execute', 'static', 'smoke'].includes(phaseToActivity(task.phase))
  if (canSync) {
    try {
      remediation = await syncGateLoopFromRunGroup(db, {
        repoSlug: repo,
        taskId,
        size: task.size,
        phase: task.phase,
      })
      gateLoop = remediation.loop
    } catch {
      gateLoop = gateLoop || await ensureGateLoop(db, { repo, taskId, size: task.size, phase: task.phase })
    }
  } else if (!gateLoop && syncLoop) {
    gateLoop = await ensureGateLoop(db, { repo, taskId, size: task.size, phase: task.phase })
  }
  // 只读模式：无 loop 行时不创建，resumable 基于现有行判断

  const session = await getActiveTaskSession(db, { repo, taskId })
  const completionBlocked = !TERMINAL.has(task.phase)
  const resumable =
    completionBlocked &&
    !cloudDisabled &&
    Boolean(gateLoop) &&
    (gateLoop.state === 'waiting_gate' ||
      gateLoop.state === 'remediation_suite' ||
      gateLoop.state === 'remediation_product' ||
      gateLoop.state === 'green_pending_advance' ||
      gateLoop.state === 'needs_human' ||
      gateLoop.state === 'paused_ops' ||
      gateLoop.iteration > 0)

  const versions = await db
    .prepare(
      'SELECT phase, author, created_at FROM task_versions WHERE repo = ? AND task_id = ? ORDER BY id'
    )
    .all(repo, taskId)

  const acCoverage = await evaluateAcCoverage(db, { repoSlug: repo, taskId })
  const changed = await loadChangedFilesForTask(db, { repoSlug: repo, taskId })
  const planSignals = signalsFromTask(task, changed)
  let activityPlan
  try {
    activityPlan = await buildActivityPlanDispatched(db, { repoSlug: repo, signals: planSignals })
  } catch (e) {
    if (e.code === 'CAPABILITY_HANDLER_MISSING') activityPlan = []
    else throw e
  }
  const activity = phaseToActivity(task.phase)
  let distillPending = false
  try {
    distillPending = Boolean(await findUnsummarizedGateFailure(db, { repoSlug: repo, taskId }))
  } catch {
    distillPending = false
  }
  if (contextPack) {
    contextPack.workflow = buildWorkflowView(task.phase, task.size, verifyMode, activityPlan)
    // §9 harness.instructions(params):租户 handler 基于现有文案追加/覆盖;
    // 未注册 handler 不得回落 default —— 置空并透出 capabilityError
    try {
      const insCap = await resolveCapability(db, { feature: 'harness.instructions', repoSlug: repo })
      if (insCap.ok && insCap.registered) {
        const next = insCap.handler(contextPack.instructions, insCap.params, { phase: task.phase, repo })
        if (typeof next === 'string') contextPack.instructions = next
      } else if (!insCap.ok && insCap.code === 'CAPABILITY_HANDLER_MISSING') {
        contextPack.instructions = ''
        contextPack.capabilityError = insCap.code
      }
    } catch { /* 文案装配异常不阻断状态读取 */ }
  }

  if (view === 'mcp') {
    const blockedBy = []
    for (const t of allowed || []) {
      if (t && t.allowed === false) blockedBy.push(...(t.blockedBy || []))
    }
    // 注入盲区告警：size 门禁不执行的 E2E 考卷虽被豁免验卷（不死锁），但其 AC 的 E2E 验证实际缺失，
    // 必须显式告知 AI，避免「S 级任务声称覆盖 AC 却从未真跑 E2E」被静默放行（放水）。
    const notices = []
    if (Array.isArray(acCoverage?.offPathNoSmoke) && acCoverage.offPathNoSmoke.length) {
      notices.push(
        `⚠️ 本任务 size=${task.size}，门禁只执行 static、不跑 E2E；已冻结的 ${acCoverage.offPathNoSmoke.length} 张 E2E/冒烟考卷（${acCoverage.offPathNoSmoke.join('、')}）本轮不会被执行，其 AC 的 E2E 验证实际缺失（已豁免变异验卷以免死锁）。若确需 E2E 验证，请将 size 提升为 M/L 后重新 awp_test_run。`
      )
    }
    // D（豁免如实盖章）：变异「豁免通过」不等于「真杀中」——明确告知 AI 这些考卷判别力未被证明，
    // 避免「任务 DONE = 考卷都有效」的错觉；不阻断闭环，只留痕提示后续补强断言。
    if (Array.isArray(acCoverage?.mutationExempt) && acCoverage.mutationExempt.length) {
      const caps = acCoverage.mutationExempt.filter((m) => m.kind === 'survived-cap').map((m) => m.featureKey)
      const nc = acCoverage.mutationExempt.filter((m) => m.kind === 'not-covered').map((m) => m.featureKey)
      const parts = []
      if (caps.length) parts.push(`${caps.length} 张「疑似等价变异」豁免（${caps.join('、')}）`)
      if (nc.length) parts.push(`${nc.length} 张「改动行无可翻算子」豁免（${nc.join('、')}）`)
      notices.push(
        `⚠️ 验卷盖章：本任务有 ${parts.join('；')}——这些考卷是「豁免通过」，并非真的杀中变异（未证明能抓到 bug）。任务可继续，但考卷判别力可能不足，建议后续按暗改落点补强断言（接口字段/数据状态/可见 DOM），而非当作已充分验证。`
      )
    }
    return {
      ok: true,
      taskId: task.task_id,
      phase: task.phase,
      activity,
      size: task.size,
      type: task.type,
      exitCriteria: exitCriteriaFor(activity),
      blockedBy: blockedBy.slice(0, 8),
      notices,
      nextTool: nextToolFor(activity),
      activityPlan,
      allowedTransitions: (allowed || []).map((t) => ({
        to: t.to,
        allowed: t.allowed,
        blockedBy: t.blockedBy || [],
      })),
      distillPending,
    }
  }

  return {
    ok: true,
    taskId: task.task_id,
    repo: task.repo,
    phase: task.phase,
    size: task.size,
    type: task.type,
    requirement: task.requirement,
    author: task.author,
    completed: task.completed,
    pending: task.pending,
    decisions: task.decisions,
    allowedTransitions: allowed.map((t) => ({
      ...t,
      toLabel: phaseLabel(t.to).name,
      toSummary: phaseLabel(t.to).summary,
    })),
    contextPack,
    testing,
    verifyMode,
    acceptance: await getTaskAcceptance(db, { repoSlug: repo, taskId }),
    acCoverage,
    workflow: contextPack.workflow,
    testNodes: buildTestNodes({
      phase: task.phase,
      size: task.size,
      gateLoop,
      acCoverage,
      requiredUnits: gateLoop?.requiredUnits || null,
    }),
    doingNow: contextPack.currentPhase?.doingNow,
    activity,
    activityPlan,
    derivedSize: deriveSize(planSignals),
    distillPending,
    timeline: versions,
    completionBlocked,
    resumable,
    gateLoop,
    session: session
      ? {
          sessionId: session.session_id,
          owner: session.owner_subject,
          state: session.state,
          expiresAt: session.expires_at,
        }
      : null,
    resume: resumable
      ? {
          state: gateLoop.state,
          iteration: gateLoop.iteration,
          maxIterations: gateLoop.maxIterations,
          pendingActions: gateLoop.pendingActions,
          packet: remediation?.packet || null,
          completionBlocked: true,
        }
      : null,
    hint: resumable
      ? '存在未完成门禁闭环：必须先按 resume.pendingActions 续作本任务，禁止 harness_start 冒充完成，禁止宣称任务已完成'
      : phaseToActivity(task.phase) === 'aborted'
        ? 'TASK_ABORTED: 本任务已被中止。请立即停止编码、verify_report、awp_test_run 与 harness_advance；' +
          '云端测试与 VM 已取消/关闭。如需继续请 harness_start 开新任务，禁止复活本任务。'
        : phaseToActivity(task.phase) === 'done'
          ? '任务已完成（DONE）。禁止再推进；增量需求请 harness_start 开新任务。'
          : '阶段推进请调用 harness_advance，禁止 task_state 直接改 phase；禁止让用户执行测试平台命令',
    aborted: phaseToActivity(task.phase) === 'aborted'
      ? {
          reason: task.meta?.abortReason || null,
          aiHint:
            'TASK_ABORTED: 任务已中止。停止一切编码与测试动作；' +
            '不要调用 harness_advance / awp_test_run / verify_report。' +
            '如需交付请另开 harness_start 新任务。',
        }
      : null,
  }
}

/**
 * 状态流转（唯一合法改 phase 的入口）
 */
// QUERY_CLASS: TENANT —— 写路径限定在任务归属 repo（方案 §7.1）
export async function harnessAdvance({
  taskId,
  to,
  data = {},
  author,
  repo = 'demo-app',
  view = 'rest',
}) {
  const task = await getTask(repo, taskId)
  if (!task) return { ok: false, error: `任务不存在：${taskId}` }
  if (TERMINAL.has(task.phase)) {
    return { ok: false, error: `任务已处于终态 ${task.phase}，不可再推进` }
  }
  // §9:相关 feature 有登记但 handler 未注册 → CAPABILITY_HANDLER_MISSING,阶段不变(不得回落 default)
  const missingCap = await assertNoMissingHandlers(db, { repoSlug: repo, features: ['harness.activityPlan', 'harness.guard', 'gate.policy'] })
  if (missingCap) {
    return {
      ok: false,
      code: 'CAPABILITY_HANDLER_MISSING',
      error: 'CAPABILITY_HANDLER_MISSING',
      feature: missingCap.feature,
      handlerId: missingCap.handlerId,
      blockedBy: ['CAPABILITY_HANDLER_MISSING'],
      completionBlocked: true,
      status: await harnessStatus({ taskId, repo }),
    }
  }

  // session owner 校验（灰度：harness_strict_session，默认 warn）
  try {
    const drv = await assertTaskDriver(db, { repo, taskId, author })
    if (drv && drv.ok === false) {
      return {
        ok: false,
        error: drv.code || 'TASK_SESSION_HELD',
        code: 'TASK_SESSION_HELD',
        blockedBy: [drv.detail || 'TASK_SESSION_HELD'],
        completionBlocked: true,
        session: { owner: drv.owner, expiresAt: drv.expiresAt },
        status: await harnessStatus({ taskId, repo }),
      }
    }
  } catch { /* guard 内部异常不阻断历史行为 */ }

  const previewMeta = { ...task.meta }
  if (data.l3Confirmed) previewMeta.l3Confirmed = true

  const changedForPlan = await loadChangedFilesForTask(db, { repoSlug: repo, taskId })
  const signals = signalsFromTask(task, changedForPlan)
  if (data.uncertain) signals.uncertain = true
  const activityPlan = await buildActivityPlanDispatched(db, { repoSlug: repo, signals })
  const derived = deriveSize(signals)
  const resolved = resolveAdvanceTarget(task.phase, to, activityPlan, task.meta)
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      error: resolved.code,
      blockedBy: resolved.blockedBy,
      nextActivity: resolved.next,
      completionBlocked: true,
    }
  }
  to = resolved.store

  const size = data.size || task.size || derived
  // §9 harness.guard(floor):先跑 default,租户 handler 只能向 blockedBy 追加
  const guard = await applyFloorDispatched(db, {
    repoSlug: repo,
    feature: 'harness.guard',
    defaultResult: await checkGuard(to, { ...task, size, meta: previewMeta }),
    ctx: { to, task: { ...task, size, meta: previewMeta } },
  })
  const mode = await getRepoGateMode(db, repo)
  let gatePolicy = null
  try {
    const changedFiles = await loadChangedFilesForTask(db, { repoSlug: repo, taskId })
    gatePolicy = await resolveGatePolicy(db, {
      repoSlug: repo,
      taskId,
      size,
      changedFiles,
      author,
    })
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) {
      return {
        ok: false,
        code: 'POLICY_EVAL_FAILED',
        error: 'POLICY_EVAL_FAILED',
        blockedBy: [String(e?.message || e)],
        completionBlocked: true,
      }
    }
    gatePolicy = null
  }
  // §9 gate.policy(floor):租户 handler 只能向 blockedBy 追加;只升不降仍在 resolveGatePolicy 内。
  // 放在 try/catch 之外——CAPABILITY_HANDLER_MISSING 必须透出,不得被吞成 POLICY_EVAL_FAILED
  if (gatePolicy) {
    gatePolicy = await applyFloorDispatched(db, {
      repoSlug: repo,
      feature: 'gate.policy',
      defaultResult: gatePolicy,
      ctx: { taskId, size },
    })
    // floor 追加的阻断必须生效(租户只能加严不能放松)
    if (Array.isArray(gatePolicy.blockedBy) && gatePolicy.blockedBy.length && !gatePolicy.error) {
      return {
        ok: false,
        error: '门禁未通过(租户扩展)',
        code: 'TENANT_FLOOR_BLOCKED',
        blockedBy: gatePolicy.blockedBy,
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
  }
  const effectiveMode = gatePolicy?.effectiveMode || mode
  if (gatePolicy?.error) {
    return {
      ok: false,
      error: gatePolicy.error,
      code: gatePolicy.error,
      blockedBy: (gatePolicy.policyErrors || []).map((e) => `${e.key}: ${e.detail}`),
      completionBlocked: true,
    }
  }
  const gateTransition = isPlatformGateTransition(task.phase, to, size)

  // AC 纪律：M/L 进入 EXECUTE 前必须先产出验收清单；进入后冻结，禁止赛后改答案
  const acDiscipline = checkAcDiscipline({
    phase: task.phase,
    to,
    size,
    mode,
    metaAcceptance: task.meta?.acceptance || null,
    acceptanceInput: Array.isArray(data.acceptance) ? data.acceptance : null,
    snapshotFrozen: Boolean(task.meta?.productSnapshotAt),
  })
  if (acDiscipline) {
    return {
      ok: false,
      error: acDiscipline.code,
      blockedBy: acDiscipline.blockedBy,
      completionBlocked: true,
      status: await harnessStatus({ taskId, repo }),
    }
  }
  const acceptanceInput = Array.isArray(data.acceptance) ? data.acceptance : null

  // 租约心跳（有会话则续期）
  try {
    const sess = await getActiveTaskSession(db, { repo, taskId })
    if (sess) {
      const nowIso = new Date().toISOString()
      const exp = new Date(Date.now() + 2 * 3600 * 1000).toISOString()
      await db.prepare('UPDATE task_sessions SET heartbeat_at=?, expires_at=? WHERE session_id=?').run(
        nowIso,
        exp,
        sess.session_id
      )
    }
  } catch {
    /* ignore */
  }

  // needs_human：禁止 advance（ABORTED 除外；云端测试已关闭的仓旁路——那是云端门禁产生的状态）
  if (phaseToActivity(to) !== 'aborted' && mode !== 'disabled') {
    const loop0 = await getGateLoop(db, { repo, taskId })
    if (loop0?.needsHuman) {
      const packet = await buildPacketWithDb(db, {
        repo,
        taskId,
        status: 'NEEDS_HUMAN',
        loop: loop0,
        classification: { overall: loop0.lastClass || 'product', byCheck: [] },
        bindingId: loop0.lastBindingId,
        message: `迭代已达上限（${loop0.iteration}/${loop0.maxIterations}），需要人工处理或 waiver 后才能继续`,
      })
      return {
        ok: false,
        error: 'NEEDS_HUMAN',
        blockedBy: [`gateLoop 已达 maxIterations=${loop0.maxIterations}，禁止继续 advance/test_run，需人工介入`],
        packet,
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
  }

  let testingEval = null
  let remediationPacket = null
  if (gateTransition && effectiveMode !== 'legacy' && effectiveMode !== 'disabled') {
    testingEval = await evaluateNewGate(db, {
      repoSlug: repo,
      taskId,
      size,
      gateBindingId: data.gateBindingId || null,
      expectedTaskRevision: Number.isInteger(data.expectedTaskRevision) ? data.expectedTaskRevision : null,
    })
    await recordObserveEvent(db, {
      repoSlug: repo,
      taskId,
      transition: `${task.phase}->${to}`,
      mode,
      legacyWouldBlock: !guard.ok,
      evaluation: testingEval,
      gateBindingId: data.gateBindingId || null,
    })
    if (shouldEnforceNewGate(effectiveMode, size) && testingEval.wouldBlock) {
      try {
        const synced = await syncGateLoopFromRunGroup(db, { repoSlug: repo, taskId, size, phase: task.phase })
        remediationPacket = synced.packet
      } catch {
        remediationPacket = await buildPacketWithDb(db, {
          repo,
          taskId,
          status: 'BLOCKED',
          loop: await getGateLoop(db, { repo, taskId }) || await ensureGateLoop(db, { repo, taskId, size, phase: task.phase }),
          classification: { overall: 'none', byCheck: [] },
        })
      }
      const primaryCode = testingEval.blockedBy?.[0]?.code || 'BLOCKED'
      const errStatus =
        primaryCode === 'IN_PROGRESS'
          ? 'IN_PROGRESS'
          : primaryCode === 'NOT_SUBMITTED'
            ? 'NOT_SUBMITTED'
            : primaryCode === 'UNITS_FAILED'
              ? 'failed'
              : 'BLOCKED'
      if (errStatus === 'IN_PROGRESS') {
        await updateGateLoop(db, {
          repo,
          taskId,
          patch: { state: 'waiting_gate', size, phase: task.phase },
        })
      }
      return {
        ok: false,
        error:
          errStatus === 'IN_PROGRESS'
            ? '云端测试执行中，必须等待终态（awp_loop_wait），禁止宣称完成'
            : '门禁未通过',
        code: primaryCode,
        blockedBy: testingEval.blockedBy,
        testing: { mode, ...testingEval },
        packet: remediationPacket,
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
  }
  // AC 覆盖率终审：考卷全绿后，冻结的 AC 清单必须全部被 active 考卷覆盖
  // M/L 在 VERIFY→DONE / DISTILL→DONE 也要复查（原先只在 EXECUTE→VERIFY 查一次）
  const acRecheckOnDone =
    phaseToActivity(to) === 'done' &&
    (size === 'M' || size === 'L') &&
    phaseToActivity(task.phase) !== 'execute' // EXECUTE→DONE（S）走 gateTransition
  if ((gateTransition || acRecheckOnDone) && shouldEnforceNewGate(effectiveMode, size)) {
    const ac = await evaluateAcCoverage(db, { repoSlug: repo, taskId })
    if (ac.applicable && ac.missing.length) {
      return {
        ok: false,
        error: 'AC_UNCOVERED',
        code: 'AC_UNCOVERED',
        blockedBy: [
          `AC 覆盖率不足：${ac.missing.join('、')} 尚无 active 考卷覆盖。`,
          '补齐方式：awp_test_spec_submit 时带 acceptanceRefs（对应缺失的 AC id），再 advance。',
        ],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    // 全部覆盖卷都 offPath：本轮零有效观测，禁止 DONE（防 SFC/业务页未测仍放行）
    // 注意：offPathNoSmoke（size 门禁不跑其 smoke lane 而豁免，如 S 级不执行 E2E）是体量策略的正常结果，
    // S 级本就不要求 E2E 观测，不算「观测缺失」；只对「注入路径不匹配」的真 offPath 拦 DONE，避免死锁转移到本判定。
    const offPathNotInjected = (ac.offPath || []).filter((k) => !(ac.offPathNoSmoke || []).includes(k))
    if (
      ac.applicable &&
      ac.covered?.length &&
      offPathNotInjected.length >= ac.covered.length &&
      ac.f2pStatus === 'none' &&
      ac.f2pDetail?.ok === 0
    ) {
      return {
        ok: false,
        error: 'AC_ALL_OFFPATH',
        code: 'AC_ALL_OFFPATH',
        blockedBy: [
          `覆盖 AC 的考卷全部不在本轮观测路径（offPath=${offPathNotInjected.join('、')}），无法证明页面/接口可测。`,
          '请确认改动文件与考卷 pages 一致，或补一张覆盖目标路径的考卷后 awp_test_run；禁止在零有效观测下 DONE。',
        ],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    // 变异验卷终审：覆盖 AC 的考卷必须能抓到平台暗埋的 bug（走过场的卷子在这里现形）
    if (!ac.missing.length && ac.mutationPending) {
      // 区分「作业在跑」与「永不会调度」：后者空等/反复重下单都无进展，必须给准确指引，
      // 而不是用「进行中，请轮询等待」误导 AI 空耗迭代（2026-09-24 V267-4 死锁教训）。
      const noMutationJob = !(ac.mutation?.running > 0) && !(ac.mutation?.queued > 0)
      return {
        ok: false,
        error: 'MUTATION_UNVERIFIED',
        code: 'MUTATION_UNVERIFIED',
        blockedBy: noMutationJob
          ? await mutationUnverifiedGuidance(db, { repo, taskId, size })
          : [
              '考卷有效性未验证：变异暗卷考试进行中或未通过。',
              '轮询 harness_status 等待验卷完成；若变异卷反复 pass，说明考卷是走过场的——增强断言（对接口契约/数据状态），而不是改弱。',
            ],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    // F2P 终审：考卷必须能区分"改动前"与"改动后"两个世界（SWE-bench 金标准）
    if (!ac.missing.length && !ac.mutationPending && ac.f2pStatus === 'bad') {
      return {
        ok: false,
        error: 'F2P_BAD',
        code: 'F2P_BAD',
        blockedBy: [
          '考卷被判废：在改动前的代码上也通过（always_pass）或两轮都失败（always_fail）。',
          '重写考卷：必须断言新功能的可观察行为（接口契约/数据状态），而不是碰巧通过的形式检查。',
        ],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    if (!ac.missing.length && !ac.mutationPending && ac.f2pStatus === 'pending') {
      return {
        ok: false,
        error: 'F2P_PENDING',
        code: 'F2P_PENDING',
        blockedBy: [
          'F2P 验卷尚未完成：考卷还需在"改动前 baseline"上跑一轮（baseline 必须红）。',
          '轮询 harness_status 等待验卷完成。',
        ],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
  }
  if (!guard.ok) {
    try {
      await recordAuditEvent({
        eventType: 'advance_denied',
        toolName: 'harness_advance',
        method: 'mcp',
        repo,
        taskId,
        author,
        status: 'error',
        phase: task.phase,
        detail: `门禁未通过 → ${to}`,
        payload: { to, blockedBy: guard.blockedBy, mode },
      })
    } catch { /* 埋点失败不阻断 */ }
    return {
      ok: false,
      error: '门禁未通过',
      blockedBy: guard.blockedBy,
      testing: testingEval ? { mode, ...testingEval } : undefined,
      packet: remediationPacket,
      completionBlocked: true,
      status: await harnessStatus({ taskId, repo }),
    }
  }

  // DONE 终态硬门禁：M/L 路径 EXECUTE→VERIFY 已检过一次，VERIFY/DISTILL→DONE 必须再次核对仍为绿
  //（防中途换 binding / 证据失效后仍宣称完成）。disabled 旁路；observe/legacy 不拦。
  if (phaseToActivity(to) === 'done') {
    const doneGate = await checkDoneGate(db, {
      repoSlug: repo,
      taskId,
      size,
      mode: effectiveMode,
      gateBindingId: data.gateBindingId || null,
      expectedTaskRevision: Number.isInteger(data.expectedTaskRevision) ? data.expectedTaskRevision : null,
    })
    if (!doneGate.ok) {
      try {
        await recordAuditEvent({
          eventType: 'advance_denied',
          toolName: 'harness_advance',
          method: 'mcp',
          repo,
          taskId,
          author,
          status: 'error',
          phase: task.phase,
          detail: `GATE_NOT_GREEN → DONE mode=${doneGate.mode}`,
          payload: { to: 'DONE', code: doneGate.code, blockedBy: doneGate.blockedBy, bindingId: doneGate.bindingId },
        })
      } catch { /* ignore */ }
      let packet = null
      try {
        const synced = await syncGateLoopFromRunGroup(db, { repoSlug: repo, taskId, size, phase: task.phase })
        packet = synced.packet
      } catch {
        packet = await buildPacketWithDb(db, {
          repo,
          taskId,
          status: 'BLOCKED',
          loop: await getGateLoop(db, { repo, taskId }) || await ensureGateLoop(db, { repo, taskId, size, phase: task.phase }),
          classification: { overall: 'none', byCheck: [] },
          bindingId: doneGate.bindingId || null,
          message: doneGate.message,
        })
      }
      return {
        ok: false,
        error: doneGate.message || 'GATE_NOT_GREEN',
        code: doneGate.code,
        blockedBy: doneGate.blockedBy || [doneGate.message],
        testing: { mode: doneGate.mode, enforcement: doneGate.enforcement, requiredUnits: doneGate.requiredUnits },
        packet,
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    if (doneGate.code === 'DISABLED_BYPASS') {
      try {
        await recordAuditEvent({
          eventType: 'harness_advance',
          toolName: 'harness_advance',
          method: 'mcp',
          repo,
          taskId,
          author,
          status: 'ok',
          detail: `DONE bypass_local mode=disabled（云端门禁关闭，本地直通）`,
        })
      } catch {
        /* 审计失败不阻断 */
      }
    }
  }

  const now = new Date().toISOString()
  const merged = { ...task }

  if (data.size) merged.size = data.size
  if (data.requirement) merged.requirement = data.requirement
  if (data.type) merged.type = data.type
  if (Array.isArray(data.completed)) merged.completed = data.completed
  if (Array.isArray(data.pending)) merged.pending = data.pending
  if (Array.isArray(data.decisions)) merged.decisions = data.decisions

  const meta = { ...merged.meta }
  if (data.l3Confirmed) meta.l3Confirmed = true
  if (data.note) meta.lastNote = data.note
  if (phaseToActivity(to) === 'distill' && phaseToActivity(task.phase) !== 'distill') {
    meta.resumeActivity = phaseToActivity(task.phase)
  }
  if (phaseToActivity(task.phase) === 'distill' && phaseToActivity(to) !== 'distill') {
    delete meta.resumeActivity
  }
  meta.activity = phaseToActivity(to)
  meta.activityPlan = activityPlan
  meta.derivedSize = derived
  if (!merged.size) merged.size = data.size || task.size || derived
  const enteringExecute = phaseToActivity(to) === 'execute' && phaseToActivity(task.phase) !== 'execute'
  if (enteringExecute && acceptanceInput) meta.acceptance = acceptanceInput
  if ((data.workspaceHead || data.gateBindingId) && !meta.productSnapshotAt) {
    meta.productSnapshotAt = now
    meta.evidenceAnchorAt = meta.evidenceAnchorAt || now
    if (data.workspaceHead) meta.evidenceWorkspaceHead = data.workspaceHead
  }
  if (phaseToActivity(to) === 'aborted') meta.abortReason = data.reason || ''
  merged.meta = meta
  merged.phase = to

  const isTerminal = phaseToActivity(to) === 'done' || phaseToActivity(to) === 'aborted'
  const loopPatch = isTerminal
    ? {
        state: phaseToActivity(to) === 'done' ? 'coding' : 'needs_human',
        phase: to,
        needsHuman: phaseToActivity(to) === 'aborted',
        pendingActions: [],
        awaitDistill: 0,
      }
    : {
        phase: to,
        size: merged.size,
        state: to === 'EXECUTE' ? 'coding' : to === 'VERIFY' ? 'coding' : undefined,
      }

  // 统一写入：phase CAS + 同事务 version/loop/session
  try {
    await transitionTask(db, {
      repo,
      taskId,
      fromPhase: task.phase,
      to,
      merged,
      author,
      snapshot: {
        phase: to,
        size: merged.size,
        completed: merged.completed,
        pending: merged.pending,
        decisions: merged.decisions,
        signals,
        activityPlan,
      },
      loopPatch,
      releaseSession: isTerminal,
    })
  } catch (e) {
    if (e && e.code === 'PHASE_CONFLICT') {
      return {
        ok: false,
        error: e.message,
        code: 'PHASE_CONFLICT',
        blockedBy: ['并发推进冲突：任务 phase 已被其他驱动者修改，请重新 harness_status 后再试'],
        completionBlocked: true,
        status: await harnessStatus({ taskId, repo }),
      }
    }
    throw e
  }

  // 考卷生命周期：任务结束 → 非回归考卷自动归档（写入成功后，失败不回滚任务）
  if (phaseToActivity(to) === 'done') {
    try {
      const repoRow = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repo)
      if (repoRow) {
        const archived = await db.prepare(
          `UPDATE test_specs SET review_status='archived', updated_at=?
           WHERE repo_id=? AND review_status='active'
             AND (scope IS NULL OR scope='task')
             AND demand_ref = ?`
        ).run(now, repoRow.repo_id, taskId)
        if (archived.changes) {
          process.stdout.write(`[specs] task DONE archived ${archived.changes} task-scoped spec(s)\n`)
        }
      }
    } catch (e) {
      process.stderr.write(`[specs] auto-archive skip: ${e.message}\n`)
    }
  }

  // 交付包（2026-09-26）：DONE 时随终态返回收尾文本（变更说明/commit message/清单）。
  // 交付动作在开发机执行——平台不写码不留码（submit-run finally 复位），这里只出"作业指导"。
  let deliveryPack = null
  if (phaseToActivity(to) === 'done') {
    try { deliveryPack = await buildDeliveryPack(db, { repo, taskId }) } catch (e) {
      process.stderr.write(`[delivery] pack skip: ${e.message}\n`)
    }
  }

  const status = await harnessStatus({ taskId, repo, syncLoop: true })
  const ctx = status.contextPack
  const fromLabel = phaseLabel(task.phase)
  const toLabel = phaseLabel(to)

  const full = {
    ok: true,
    taskId,
    from: task.phase,
    to,
    message: `已推进：${fromLabel.name} → ${toLabel.name}`,
    completionBlocked: phaseToActivity(to) !== 'done' && phaseToActivity(to) !== 'aborted',
    doingNow: ctx.currentPhase?.doingNow,
    nextSteps: ctx.instructions,
    readDocs: ctx.docs,
    workflow: status.workflow,
    activity: status.activity || phaseToActivity(to),
    activityPlan: status.activityPlan || activityPlan,
    status,
  }
  if (view === 'mcp') {
    return {
      ok: true,
      taskId,
      activity: phaseToActivity(to),
      exitCriteria: exitCriteriaFor(phaseToActivity(to)),
      blockedBy: [],
      nextTool: nextToolFor(phaseToActivity(to)),
      ...(deliveryPack ? { deliveryPack: deliveryPack.text, commitMessage: deliveryPack.commitMessage } : {}),
    }
  }
  return full
}

/**
 * MUTATION_UNVERIFIED 指引细分（2026-09-27 修复 V267 死锁的指引缺陷）：
 *  - 有 survived 历史（变异卷跑过但未杀中）→ 指引「增强断言 + 升考卷版本重提」（R6 收敛正路），
 *    绝不提"提升 size"（survived 与 size 无关，09-27 historical production 教训：M 级任务被误导去改 size）；
 *  - 无任何调度历史 → 维持 size 类指引，且按当前 size 分支（已是 M/L 就不再说"提升 size"）。
 *
 * 2026-09-28 B2：SQL 的 `OR review_status='active'` 会把全仓 active 卷的 always_pass 都捞进本任务指引
 * （别人的 activity 卷会混进飞行检查文案）。与判定侧同口径按 assetLock 冻结清单求交——
 * 本轮没注入/没跑的卷不可能是本任务的弱卷，不点名；无 active binding / 旧 binding 仍维持严格（不排除）。
 */
export async function mutationUnverifiedGuidance(db, { repo, taskId, size }) {
  let survived = []
  try {
    // 只取每个考卷最新一条 always_pass（按 created_at 倒序去重）：
    // 旧版本的落点行（spec 轮转前的锚点）会随考卷升级而过时，展示它们会误导排查方向
    const rows = await db
      .prepare(
        `SELECT f.feature_key, f.detail FROM spec_f2p_results f
         WHERE f.f2p_status='always_pass' AND f.detail NOT LIKE '%survived-cap-exempt%'
           AND f.feature_key IN (
             SELECT feature_key FROM test_specs
             WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=?)
               AND (demand_ref=? OR review_status='active')
           )
         ORDER BY f.created_at DESC`
      )
      .all(repo, taskId)
    const latestByKey = []
    const seenKeys = new Set()
    for (const r of rows) {
      if (!seenKeys.has(r.feature_key)) {
        seenKeys.add(r.feature_key)
        latestByKey.push(r)
      }
    }
    // 异步过滤用 for..of（.filter(async) 会把 Promise 视为 truthy，过滤失效）
    survived = []
    for (const r of latestByKey) {
      if (await isSpecOnActiveBindingPath(db, { repoSlug: repo, taskId, featureKey: r.feature_key })) {
        survived.push(r)
      }
    }
  } catch {
    survived = []
  }
  if (survived.length) {
    return [
      `变异卷已跑过但未杀中暗改（survived）：考卷断言偏弱——这不是流程卡死，是卷需要增强。`,
      `收敛路径：增强断言（对接口契约/数据状态/可见 DOM，禁止只 waitForSelector）→ ` +
        `awp_test_spec_submit 提交新版本（版本+1 会自动更换暗题落点）→ awp_test_run 重提。`,
      `涉及考卷：${survived.map((s) => s.feature_key).join('、')}；` +
        `暗题落点示例：${survived.slice(0, 2).map((s) => String(s.detail || '').slice(0, 70)).join(' / ')}`,
      `迭代预算用尽时：看板 waiver 或 awp_loop_resume 申请补发测试预算。`,
    ]
  }
  const sizeHint =
    size === 'S'
      ? '若确需 E2E 验卷，应把任务 size 提升为 M/L 后重新下单。'
      : `当前 size=${size || '?'} 本应调度 smoke/变异：请联系平台核查 requiredUnits、考卷 side 与 e2e 注入模式（scoped 模式会按 pages 声明过滤卷）。`
  return [
    '考卷有效性未验证，且当前没有任何变异验卷作业在运行或排队（mutation.running=0, queued=0）——空等或反复重下单不会有任何进展。',
    '这通常意味着门禁单元与考卷类型不匹配：如任务 size=S 时门禁只跑 static、不执行 E2E 考卷，验卷作业永不会被调度。',
    '请勿再 awp_test_run 空耗迭代；' + sizeHint,
  ]
}

/**
 * 超时自动结束：非终态任务超过 maxAgeDays 未更新 → ABORTED
 * meta.abortReason = 超时自动结束，便于看板/经验追溯
 */
export async function sweepStaleTasks({
  maxAgeDays = Number(process.env.AWP_TASK_TIMEOUT_DAYS || 3),
  now = new Date(),
  dryRun = false,
  all = false,
} = {}) {
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 3600 * 1000).toISOString()
  const rows = all
    ? await db
        .prepare(
          `SELECT task_id, repo, phase, updated_at, meta
           FROM tasks
           WHERE phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted')`
        )
        .all()
    : await db
        .prepare(
          `SELECT task_id, repo, phase, updated_at, meta
           FROM tasks
           WHERE phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted')
             AND (updated_at IS NULL OR updated_at < ?)`
        )
        .all(cutoff)
  if (!rows.length) return { closed: 0, items: [] }

  const items = []
  for (const row of rows) {
    const ageDays = Math.floor((now.getTime() - Date.parse(row.updated_at)) / (24 * 3600 * 1000))
    items.push({
      taskId: row.task_id,
      repo: row.repo,
      fromPhase: row.phase,
      updatedAt: row.updated_at,
      ageDays,
    })
    if (dryRun) continue
    let meta = {}
    try {
      meta = JSON.parse(row.meta || '{}')
    } catch {
      meta = {}
    }
    const closedAt = now.toISOString()
    const reason = all
      ? '每日05:00例行清理：结束所有未完成任务'
      : `超时自动结束：任务非终态已超过 ${maxAgeDays} 天未推进（updated_at=${row.updated_at}，原 phase=${row.phase}）`
    const nextMeta = {
      ...meta,
      abortReason: reason,
      autoAborted: true,
      autoAbortAt: closedAt,
      autoAbortFromPhase: row.phase,
    }
    await db.prepare(
      `UPDATE tasks SET phase = 'aborted', meta = ?, updated_at = ?, closed_at = ?
       WHERE repo = ? AND task_id = ? AND phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted')`
    ).run(JSON.stringify(nextMeta), closedAt, closedAt, row.repo, row.task_id)
    await saveVersion(row.task_id, row.repo, 'aborted', {
      phase: 'aborted',
      autoTimeout: true,
      fromPhase: row.phase,
    }, 'system:task-timeout')
    try {
      await recordAuditEvent({
        eventType: 'task_auto_aborted',
        toolName: 'sweep',
        method: 'system',
        repo: row.repo,
        taskId: row.task_id,
        author: 'system:sweep',
        status: 'ok',
        detail: all ? '每日05:00例行清理：结束所有未完成任务' : `超时自动结束（>${maxAgeDays} 天未推进）`,
        payload: { all, fromPhase: row.phase, ageDays },
      })
    } catch { /* 审计失败不阻断 */ }
    try {
      await releaseTaskSession(db, { repo: row.repo, taskId: row.task_id })
      await updateGateLoop(db, {
        repo: row.repo,
        taskId: row.task_id,
        patch: {
          state: 'needs_human',
          needsHuman: 1,
          pendingActions: ['needs_human'],
          phase: 'aborted',
        },
      })
    } catch {
      /* loop/session 表可选 */
    }
  }
  return { closed: dryRun ? 0 : items.length, dryRun, maxAgeDays: all ? null : maxAgeDays, all, items }
}

/**
 * 任务开始时的经验注入（2026-09-26，经验复用闭环 v1）：
 * 按需求文本从 experiences 检索最相关的历史经验（FTS 优先，LIKE 兜底），随 contextPack 推给 AI。
 * 只读、限额 3 条×200 字符；检索失败一律静默返回空——注入是增益，不是依赖。
 */
async function topRelatedExperiences(repo, requirement) {
  try {
    const phrase = String(requirement || '').replace(/["'`*()[\]:{}]/g, ' ').trim().slice(0, 40)
    if (phrase.length < 4) return []
    let rows = []
    try {
      // §2.8:sqlite 走 FTS5 MATCH;postgres 走 pg_trgm ILIKE(基线 GIN)
      rows = await db
        .prepare(
          isPostgres(db)
            ? `SELECT e.id, e.category, e.content FROM experiences e
           WHERE (e.content ILIKE ?) AND e.status != 'obsolete' AND (e.repo = ? OR e.repo = 'shared')
           ORDER BY e.created_at DESC LIMIT 3`
            : `SELECT e.id, e.category, e.content FROM experiences e
           JOIN experiences_fts f ON f.rowid = e.rowid
           WHERE experiences_fts MATCH ? AND e.status != 'obsolete' AND (e.repo = ? OR e.repo = 'shared')
           ORDER BY bm25(experiences_fts) LIMIT 3`
        )
        .all(isPostgres(db) ? `%${phrase}%` : phrase, repo)
    } catch {
      rows = []
    }
    if (!rows.length) {
      rows = await db
        .prepare(
          `SELECT id, category, content FROM experiences
           WHERE status != 'obsolete' AND (repo = ? OR repo = 'shared') AND content LIKE ?
           ORDER BY updated_at DESC LIMIT 3`
        )
        .all(repo, `%${phrase.slice(0, 12)}%`)
    }
    return rows.map((r) => ({ id: r.id, category: r.category, excerpt: String(r.content || '').slice(0, 200) }))
  } catch {
    return []
  }
}
