// 展示投影只描述事实，不复制门禁判定，也不按任务 DONE 改写执行结果。
export const list = (value) => Array.isArray(value) ? value : []
export const text = (value) => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const count = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback
const live = new Set(['active', 'running', 'preparing', 'uploading'])
const waiting = new Set(['queued', 'planned', 'pending'])
const bad = new Set(['failed', 'error', 'infra_error', 'assertion_failed', 'timed_out', 'lost', 'rejected'])
const canceled = new Set(['canceled', 'cancelled', 'superseded'])
export const isRunning = (state) => live.has(state)
export const isFailure = (state) => bad.has(state)

export function escapeHtml(value) {
  return text(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function formatDateTime(value) {
  if (value == null || value === '') return '时间未记录'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未记录'
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'longOffset',
  })
  return `${formatter.format(date)}（${formatter.resolvedOptions().timeZone}）`
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return '耗时未记录'
  ms = Number(ms)
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} 秒`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`
}

const executionMeta = {
  queued: ['排队中', 'warning', '…'], planned: ['待调度', 'warning', '…'], pending: ['待执行', 'neutral', '…'],
  active: ['执行中', 'info', '↻'], running: ['执行中', 'info', '↻'], preparing: ['准备中', 'info', '↻'], uploading: ['上传中', 'info', '↻'],
  passed: ['通过', 'success', '✓'], failed: ['执行失败', 'danger', '×'], assertion_failed: ['断言失败', 'danger', '×'],
  error: ['执行异常', 'danger', '!'], infra_error: ['环境异常', 'danger', '!'], lost: ['运行失联', 'danger', '!'],
  timed_out: ['执行超时', 'danger', '!'], rejected: ['已拒绝', 'danger', '!'],
  skipped: ['已跳过', 'neutral', '–'], canceled: ['已取消', 'neutral', '⊘'], cancelled: ['已取消', 'neutral', '⊘'],
  superseded: ['已取代', 'neutral', '–'], exempt: ['豁免，非执行通过', 'violet', '–'],
  weak: ['未杀中，考卷偏弱', 'warning', '!'], recorded: ['已记录', 'neutral', '≡'],
  unknown: ['未知 / 未记录', 'neutral', '?'], blocked: ['待处理', 'warning', '!'],
  idle: ['尚无当前正式提交', 'neutral', '…'], not_applicable: ['无必需执行单元（不适用）', 'neutral', '–'],
}
const mutationMeta = {
  passed: ['已杀中变异', 'success', '✓'], killed: ['已杀中变异', 'success', '✓'],
  weak: ['未杀中，需关注判别力', 'warning', '!'], exempt: ['豁免，非真实杀中', 'violet', '–'],
  error: ['未考成（执行异常）', 'danger', '!'], failed: ['未考成（执行失败）', 'danger', '!'],
  inconclusive: ['未考成', 'warning', '?'], unknown: ['判卷未知', 'neutral', '?'],
}
export function statusMeta(status, dimension = 'execution') {
  let meta
  if ((dimension === 'mutation' || dimension === 'mutationVerdict') && Object.hasOwn(mutationMeta, status)) meta = mutationMeta[status]
  if (dimension === 'gate' || dimension === 'gateEffect') {
    const gateMeta = { observation: ['只读观测，待实际门禁确认', 'warning', '?'], recorded: ['已有门禁决定记录', 'neutral', '≡'],
      unavailable: ['门禁影响未知', 'neutral', '?'] }
    meta = Object.hasOwn(gateMeta, status) ? gateMeta[status] : ['待实际门禁确认', 'neutral', '?']
  }
  meta ||= Object.hasOwn(executionMeta, status) ? executionMeta[status] : executionMeta.unknown
  return { label: meta[0], tone: meta[1], icon: meta[2] }
}

export function modeLabel(mode) {
  if (['enforce_all', 'enforce_ml', 'enforce_s'].includes(mode)) return '拦截模式'
  return ({ observe: '观察模式', legacy: '兼容模式', disabled: '已停用' })[mode] || '未知'
}
export function sideLabel(side) {
  return side === 'na' ? '通用' : side === 'both' ? '双侧' : side || '侧别未记录'
}
export function runLabel(run = {}) {
  const business = run.businessName || run.featureTitle || run.title
  if (business) return String(business)
  if (run.kind === 'mutation' || run.purpose === 'mutation') return `变异验卷 · ${run.featureKey || '考卷未记录'}`
  return ({ static: '静态扫描', smoke: '端到端测试', e2e: '端到端测试', unit: '单元测试', contract: '契约测试' })[run.unit]
    || run.label || run.unit || '执行单元（名称未记录）'
}
export function attemptLabel(run) {
  const n = list(run.attempts).length
  return n > 1 ? `尝试 ${n} 次、重试 ${n - 1} 次` : n === 1 ? '尝试 1' : '尝试未记录'
}
export function durationOf(run = {}) {
  if (run.totalMs != null) return run.totalMs
  if (!run.startedAt || !run.finishedAt) return null
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}
export function firstError(run) {
  // 已通过的重试不把先前环境异常当作当前失败；细节仍在尝试记录内保留。
  if (run.kind === 'mutation') return run.verdictDetail || run.reason || run.summary || ''
  if (!bad.has(run.state) && !bad.has(run.status)) return run.reason || ''
  const check = list(run.checks).find((item) => bad.has(item.status))
  const attempt = [...list(run.attempts)].reverse().find((item) => item.errorDetail || item.errorCode)
  return text(check?.detail || attempt?.errorDetail || run.reason || attempt?.errorCode || '失败详情未记录')
}
export function canRequeue(run) {
  return run?.kind !== 'mutation' && run?.purpose !== 'mutation' && run?.status === 'error'
    && ['infra_error', 'lost'].includes(run.reason || run.terminalReason) && run.requeueAllowed !== false && run.canRequeue !== false
}

function mergePresent(raw = {}, projected = {}) {
  const merged = { ...raw }
  for (const [key, value] of Object.entries(projected)) if (value != null) merged[key] = value
  return merged
}
function normalizeRun(projected, raw, roundId, mutation, trusted) {
  const run = mergePresent(raw, projected)
  const runId = run.runId || run.run_id || null
  const id = run.id || `${roundId}:run:${runId || `${run.unit || 'unknown'}:${run.side || 'unknown'}`}`
  const rawAttempts = new Map(list(raw?.attempts).map((a) => [a.attempt, a]))
  const attempts = new Map(rawAttempts)
  for (const a of list(projected?.attempts)) attempts.set(a.attempt, mergePresent(rawAttempts.get(a.attempt), a))
  const state = mutation ? trusted ? projected?.state || 'unknown' : 'unknown' : run.state || run.status || 'unknown'
  return {
    ...run, id, runId, unit: run.unit || null, side: run.side || null, kind: mutation ? 'mutation' : 'run',
    status: run.status || 'unknown', state, reason: run.reason || run.terminalReason || null,
    summary: mutation && !trusted ? '旧接口没有判卷结论，不能由执行状态反推杀中或豁免' : run.summary || null,
    checks: list(run.checks).length ? run.checks : list(raw?.checks), reportAttempt: run.reportAttempt ?? null, artifact: run.artifact || null,
    attempts: [...attempts.values()].sort((a, b) => Number(a.attempt) - Number(b.attempt)).map((a) => ({
      ...a, id: a.id || `${id}:attempt:${a.attempt}`, status: a.status || 'unknown',
    })),
  }
}
function normalizeRound(projected, raw = {}, trusted) {
  const round = mergePresent(raw, projected)
  const submissionId = round.submissionId || round.submission_id || round.id || null
  const id = round.id || `submission:${submissionId}`
  const execute = list(projected.steps).find((step) => step.kind === 'execute')
  const mutation = list(projected.steps).find((step) => step.kind === 'mutation')
  const nodes = (kind, step) => {
    const originals = new Map(list(raw[kind]).map((run) => [run.runId, run]))
    const projections = new Map(list(step?.nodes || projected[kind]).map((run) => [run.runId, run]))
    return [...new Set([...projections.keys(), ...originals.keys()])].map((runId) => normalizeRun(
      projections.get(runId) || {}, originals.get(runId) || {}, id, kind === 'mutations', trusted && projections.has(runId),
    ))
  }
  const runs = nodes('runs', execute)
  const mutations = nodes('mutations', mutation)
  const required = Object.hasOwn(raw, 'requiredUnits') ? raw.requiredUnits : round.requiredUnits ?? execute?.requiredUnits
  const requiredKnown = Array.isArray(required) && (round.requiredKnown
    ?? (required.length > 0 || Object.hasOwn(raw, 'requiredUnits') || !trusted || execute?.state === 'not_applicable'))
  return {
    ...round, id, submissionId, roundNo: Number.isInteger(round.roundNo) ? round.roundNo : null,
    status: round.status || 'unknown', createdAt: round.createdAt || null, historical: Boolean(round.historical),
    requiredUnits: list(required), requiredKnown, runs, mutations,
    // 当前 AC 不挂入历史轮；证据窗口也只收到本轮自身的输入、执行与判卷证据。
    steps: list(projected.steps).filter((step) => step.kind !== 'acceptance').map((step) => ({
      ...step, ...(step.kind === 'execute' ? { nodes: runs } : step.kind === 'mutation' ? { nodes: mutations } : {}),
    })),
  }
}

export function executionStats(round) {
  const requiredUnits = [...new Set(list(round?.requiredUnits).filter((unit) => typeof unit === 'string' && unit))]
  const known = (round?.requiredKnown ?? Array.isArray(round?.requiredUnits))
    && list(round?.requiredUnits).every((unit) => typeof unit === 'string' && unit)
  const runs = list(round?.runs)
  const keys = known ? requiredUnits : [...new Set(runs.map((run) => `${run.unit}:${run.side}`))]
  const groups = keys.map((unit) => runs.filter((run) => `${run.unit}:${run.side}` === unit).map((run) => run.state || run.status || 'unknown'))
  const missing = known ? keys.filter((_, i) => !groups[i].length) : []
  const every = (test) => groups.filter((states) => states.length && states.every(test)).length
  const some = (test) => groups.filter((states) => states.some(test)).length
  const passed = every((s) => s === 'passed')
  const failed = some((s) => bad.has(s))
  const running = some((s) => live.has(s))
  const queued = some((s) => waiting.has(s))
  const active = some((s) => live.has(s) || waiting.has(s))
  const skipped = every((s) => s === 'skipped')
  const cancelled = every((s) => canceled.has(s))
  const ended = every((s) => bad.has(s) || ['passed', 'skipped', 'exempt'].includes(s) || canceled.has(s))
  let state = 'unknown'
  if (running) state = 'running'
  else if (failed) state = 'failed'
  else if (queued) state = 'queued'
  else if (known && !keys.length) state = 'not_applicable'
  else if (keys.length && skipped === keys.length) state = 'skipped'
  else if (keys.length && cancelled === keys.length) state = 'canceled'
  else if (known && keys.length && !missing.length && passed === keys.length) state = 'passed'
  return { state, required: known ? keys.length : null, passed, failed, running, queued, active,
    missing, ended, skipped, canceled: cancelled, unknown: groups.filter((states) => !states.length || states.some((s) => s === 'unknown')).length }
}
export function mutationStats(round) {
  const counts = { killed: 0, weak: 0, exempt: 0, active: 0, inconclusive: 0, unknown: 0 }
  for (const node of list(round?.mutations)) {
    if (['passed', 'killed'].includes(node.state)) counts.killed++
    else if (node.state === 'weak') counts.weak++
    else if (node.state === 'exempt') counts.exempt++
    else if (live.has(node.state) || waiting.has(node.state)) counts.active++
    else if (bad.has(node.state) || node.state === 'inconclusive') counts.inconclusive++
    else counts.unknown++
  }
  return counts
}

function normalizeSummary(summary) {
  const execution = summary.execution || {}
  const state = execution.state || 'unknown'
  const missing = list(execution.missing)
  const failed = count(execution.failed)
  return {
    ...summary, version: 1, source: 'summary', context: summary.context || {},
    formalRoundCount: count(summary.formalRoundCount, null), latestSubmissionId: summary.latestSubmissionId || null,
    execution: { ...execution, state: state === 'passed' && (missing.length || failed) ? failed ? 'failed' : 'unknown' : state,
      required: count(execution.required, null), passed: count(execution.passed), failed, active: count(execution.active), missing,
      ended: count(execution.ended ?? execution.completed, null) },
    mutation: { ...summary.mutation,
      ...Object.fromEntries(['killed', 'weak', 'exempt', 'active', 'inconclusive'].map((key) => [key, count(summary.mutation?.[key])])),
      unknown: count(summary.mutation?.unknown, null) },
    mode: { configured: summary.mode?.configured || null, effective: summary.mode?.effective || null, source: summary.mode?.source || null },
    assessment: { ...summary.assessment, kind: ['observation', 'recorded', 'unavailable'].includes(summary.assessment?.kind) ? summary.assessment.kind : 'unavailable',
      reasons: list(summary.assessment?.reasons), evidenceRefs: list(summary.assessment?.evidenceRefs) },
    observedAt: summary.observedAt || null,
  }
}
export function normalizeData(data = {}) {
  data ||= {}
  const flow = data.flow?.version === 1 ? data.flow : null
  const originals = new Map(list(data.submissions).map((sub) => [sub.submissionId, sub]))
  const rounds = list(flow?.rounds || data.submissions).map((sub) => normalizeRound(sub, originals.get(sub.submissionId), Boolean(flow)))
  const page = { limit: 5, before: null, hasMore: false, nextCursor: null, ...(flow?.page || {}), ...(data.page || {}) }
  const acceptance = flow?.currentAcceptance || null
  const latest = !page.before && !rounds[0]?.historical ? rounds[0] : null
  const summary = data.summary?.version === 1 ? normalizeSummary(data.summary) : {
    version: 0, source: flow ? 'flow' : 'legacy', context: { epoch: data.task?.epoch ?? null, activeBindingId: acceptance?.activeBindingId || null },
    latestSubmissionId: !page.before ? rounds[0]?.submissionId || null : null,
    formalRoundCount: count(data.total ?? flow?.total, null), execution: executionStats(latest), mutation: mutationStats(latest),
    mode: { configured: data.gateMode || null, effective: null, source: null },
    assessment: { kind: acceptance ? 'observation' : 'unavailable', reasons: list(acceptance?.blockers), evidenceRefs: [], observedAt: null },
    observedAt: data.observedAt || null,
  }
  const currentRound = rounds.find((round) => round.submissionId === summary.latestSubmissionId && !round.historical)
  if (summary.version === 1 && currentRound) {
    const facts = executionStats(currentRound)
    const sameBinding = !summary.context.activeBindingId || !currentRound.bindingId || summary.context.activeBindingId === currentRound.bindingId
    if (summary.execution.ended == null && sameBinding
      && ['required', 'passed', 'failed', 'active'].every((key) => facts[key] === summary.execution[key])) {
      summary.execution.ended = facts.ended
    }
  }
  return { version: flow ? 1 : 0, linked: Boolean(data.linked || rounds.length), rounds, page, summary,
    total: summary.formalRoundCount, currentAcceptance: acceptance, task: data.task || {}, raw: data }
}

export function executionText(execution = {}) {
  const state = statusMeta(execution.state).label
  const countText = `通过 ${count(execution.passed)} · 失败 ${count(execution.failed)} · 活动 ${count(execution.active)}`
  return `${execution.state === 'passed' ? '正式执行通过' : state} · ${countText}${list(execution.missing).length ? ` · 缺必需单元 ${execution.missing.length}` : ''}`
}
export function getNodeInfo(data) {
  const { summary, rounds } = normalizeData(data)
  const execution = summary.execution
  const mutation = summary.mutation
  const current = rounds.find((round) => round.submissionId === summary.latestSubmissionId && !round.historical)
  const mutationRunning = list(current?.mutations).some((node) => live.has(node.state))
  const mutationQueued = list(current?.mutations).some((node) => waiting.has(node.state))
  let status = 'attention'
  if (execution.failed || bad.has(execution.state) || mutation.inconclusive) status = 'failed'
  else if (mutation.weak || execution.missing.length) status = 'attention'
  else if (live.has(execution.state) || mutationRunning) status = 'current'
  else if (waiting.has(execution.state) || execution.state === 'idle' || mutationQueued) status = 'pending'
  else if (['skipped', 'not_applicable'].includes(execution.state)) status = 'skipped'
  // 即使所有正式单元通过，这个展示层仍无权推导门禁放行。
  const risk = mutation.weak ? ` · 未杀中 ${mutation.weak}` : mutation.inconclusive ? ` · 未考成 ${mutation.inconclusive}` : ''
  const note = execution.state === 'passed' ? ' · 待实际门禁确认' : ''
  return { status, summary: executionText(execution) + risk + note,
    label: execution.state === 'not_applicable' && status === 'skipped' ? '云端测试不适用' : ({ pending: '云端测试待执行', current: '云端测试执行中', failed: '云端测试存在异常', attention: '云端测试待关注', skipped: '云端测试已跳过' })[status], linked: true }
}
