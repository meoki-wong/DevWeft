// 只读纯投影：不访问数据库、不调用门禁决策、不使用当前考卷覆盖历史结论。
const list = (value) => Array.isArray(value) ? value : []
const text = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : null
export function parseFlowJson(value, fallback = null) {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) ?? fallback } catch { return fallback }
}
const LIVE = new Set(['queued', 'planned', 'active', 'running'])
const BAD = new Set(['failed', 'error', 'timed_out', 'lost', 'rejected'])
const evidence = (value, source) => ({ value: value ?? null, source: value == null ? 'unrecorded' : source })

export function compareSubmissionInputs(previous, current) {
  const oldDoc = parseFlowJson(previous?.evidence?.binding?.canonical_binding_json, {})
  const doc = parseFlowJson(current?.evidence?.binding?.canonical_binding_json, {})
  const oldTree = previous?.evidence?.snapshot?.snapshot_tree_oid || oldDoc.snapshotTreeOid
  const tree = current?.evidence?.snapshot?.snapshot_tree_oid || doc.snapshotTreeOid
  const oldSpecs = oldDoc.assetLock?.specs
  const specs = doc.assetLock?.specs
  const diff = { source: 'unrecorded', added: [], updated: [], removed: [] }
  if (Array.isArray(oldSpecs) && Array.isArray(specs)) {
    const key = (s) => JSON.stringify([s.featureKey, s.specType, s.side || null])
    const valid = (s) => s?.featureKey && s.version != null && s.blobSha256
    if (oldSpecs.every(valid) && specs.every(valid)) {
      const before = new Map(oldSpecs.map((s) => [key(s), s]))
      const after = new Map(specs.map((s) => [key(s), s]))
      const entry = (s) => ({ featureKey: s.featureKey, specType: s.specType, side: s.side || null, version: s.version, blobSha256: s.blobSha256 })
      diff.source = 'inferred'
      for (const [k, s] of after) {
        const prior = before.get(k)
        if (!prior) diff.added.push(entry(s))
        else if (prior.version !== s.version || prior.blobSha256 !== s.blobSha256 || prior.entry !== s.entry || prior.scope !== s.scope) {
          diff.updated.push({ ...entry(s), previousVersion: prior.version })
        }
      }
      for (const [k, s] of before) if (!after.has(k)) diff.removed.push(entry(s))
    }
  }
  return {
    previousSubmissionId: previous?.submissionId || null,
    businessTree: evidence(oldTree && tree ? oldTree === tree ? 'unchanged' : 'changed' : null, 'inferred'),
    previousTree: oldTree || null,
    tree: tree || null,
    specs: diff,
  }
}

// receipt 仅接受能精确关联本次 submission 的审计记录；不按相邻时间猜提交人或触发原因。
export function submissionReceipt(submission) {
  for (const event of list(submission.evidence?.audit)) {
    const payload = parseFlowJson(event.payload_json, {})
    const receipt = payload.submissionReceipt || payload.receipt
    if (!receipt || typeof receipt !== 'object') continue
    if ((receipt.submissionId || event.submission_id) !== submission.submissionId) continue
    if (receipt.submissionId && receipt.submissionId !== submission.submissionId) continue
    return { ...receipt, auditId: event.id }
  }
  return null
}

export function mutationVerdict(run) {
  if (LIVE.has(run.status)) return { state: run.status === 'queued' ? 'queued' : 'running', label: '验卷尚在执行，未判卷' }
  if (['error', 'lost', 'timed_out', 'canceled', 'superseded'].includes(run.status) || run.terminalReason === 'infra_error') {
    return { state: 'error', label: '验卷未考成，不能当作杀中', detail: text(run.terminalReason) }
  }
  const check = run.featureKey ? list(run.checks).find((c) => c.caseKey === `test:spec/${run.featureKey}`) : null
  const f2p = run.f2p
  if (f2p?.run_id === run.runId && /^mutation (not-covered|survived-cap-exempt)/.test(f2p.detail || '')) {
    return { state: 'exempt', label: '有记录的验卷豁免', detail: f2p.detail }
  }
  if (check && ['passed', 'failed'].includes(check.status) && check.mutation?.mode === 'skipped') {
    return { state: 'exempt', label: '未注入变异（豁免，不是杀中）', detail: text(check.mutation.reason) }
  }
  if (check?.status === 'failed') return { state: 'passed', label: '已杀中：考卷抓到变异', detail: text(check.detail) }
  // 「未杀中」= 考卷在暗埋 bug 的代码上仍执行通过（run.status=passed）→ 没抓住变异 = 验卷偏弱。
  // 用 weak（amber）而非 failed（red）：这是验卷维度的结论，不是脚本执行失败，避免与同节点「执行状态 passed」撞车误导。
  if (check?.status === 'passed') return { state: 'weak', label: '未杀中：考卷仍通过（验卷偏弱，非执行失败）', detail: text(check.detail) }
  return { state: BAD.has(run.status) ? 'error' : 'unknown', label: '无考卷执行结论，不能判有效', detail: text(run.terminalReason) }
}

function runNode(run, submissionId, mutation = false) {
  const verdict = mutation ? mutationVerdict(run) : null
  const checks = list(run.checks)
  return {
    id: `submission:${submissionId}:run:${run.runId}`,
    kind: mutation ? 'mutation' : 'run',
    runId: run.runId,
    unit: run.unit || null,
    side: run.side || null,
    reportAttempt: run.reportAttempt ?? null,
    artifact: run.artifact || null,
    queueWaitMs: run.queueWaitMs ?? null,
    totalMs: run.totalMs ?? null,
    acceptedAt: run.acceptedAt || null,
    terminalReason: run.terminalReason || null,
    label: mutation ? `自动 mutation · ${run.featureKey || '考卷未记录'}` : `${run.unit}:${run.side}`,
    state: verdict?.state || (LIVE.has(run.status) ? run.status === 'queued' ? 'queued' : 'running' : run.status || 'unknown'),
    status: run.status,
    summary: verdict?.label || null,
    sourceRunId: run.sourceRunId || null,
    featureKey: run.featureKey || null,
    specVersion: run.specVersion ?? null,
    reason: run.terminalReason || null,
    verdictDetail: verdict?.detail || null,
    createdAt: run.createdAt || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    checks,
    attempts: list(run.attempts).map((a) => ({
      ...a, id: `submission:${submissionId}:run:${run.runId}:attempt:${a.attempt}`,
    })),
    errors: [
      ...list(run.attempts).filter((a) => a.errorCode || a.errorDetail).map((a) => ({
        source: `attempt ${a.attempt}`, code: a.errorCode || null, detail: a.errorDetail || null,
      })),
      ...checks.filter((c) => c.status === 'failed' || c.status === 'error').map((c) => ({
        source: c.caseKey, code: c.status, detail: c.detail || null,
      })),
    ],
  }
}

function aggregate(nodes) {
  if (!nodes.length) return 'unknown'
  if (nodes.some((n) => n.state === 'running')) return 'running'
  if (nodes.some((n) => n.state === 'queued')) return 'queued'
  if (nodes.some((n) => BAD.has(n.state))) return 'failed'
  if (nodes.every((n) => n.state === 'passed')) return 'passed'
  if (nodes.every((n) => n.state === 'passed' || n.state === 'exempt')) return 'exempt'
  // 有「未杀中(weak)」且无真执行失败(BAD)：整步标 weak（amber），不误报红色失败、也不掉到 unknown
  if (nodes.some((n) => n.state === 'weak')) return 'weak'
  if (nodes.every((n) => n.state === 'canceled' || n.state === 'superseded')) return 'canceled'
  return 'unknown'
}

function currentAcceptance(current = {}) {
  const { task = {}, instance = {}, binding = null, loop = null, coverage = null } = current
  const phase = task.phase || instance.phase || null
  const blockers = []
  if (binding && binding.state !== 'active') blockers.push({ code: 'BINDING_HISTORICAL', detail: binding.stale_reason || `绑定状态 ${binding.state}` })
  if (loop?.needs_human) blockers.push({ code: 'NEEDS_HUMAN', detail: '闭环已记录需人工介入' })
  if (loop?.await_distill) blockers.push({ code: 'AWAIT_DISTILL', detail: '闭环已记录待沉淀' })
  if (coverage?.applicable) {
    if (list(coverage.missing).length) blockers.push({ code: 'AC_COVERAGE_MISSING', detail: list(coverage.missing).join('、') })
    if (coverage.mutationPending) blockers.push({ code: 'MUTATION_PENDING', detail: '当前考卷尚有未验卷项' })
    if (coverage.f2pStatus === 'bad') blockers.push({ code: 'F2P_BAD', detail: '当前 F2P 存在无效考卷' })
    if (coverage.f2pStatus === 'pending') blockers.push({ code: 'F2P_PENDING', detail: '当前 F2P 证据待补齐' })
  }
  const completed = ['DONE', 'CLOSED', 'done', 'closed'].includes(phase)
  const aborted = ['ABORTED', 'aborted'].includes(phase)
  return {
    id: `acceptance:${instance.task_instance_id || 'unlinked'}`,
    state: completed ? 'recorded' : aborted ? 'canceled' : blockers.length ? 'blocked' : 'pending',
    completed,
    label: completed ? '任务已记录完成（不是重新验收）' : aborted ? '任务已中止，未验收完成' : '任务验收尚未完成',
    phase,
    activeBindingId: instance.active_binding_id || null,
    bindingState: binding?.state || null,
    blockers,
    acceptance: list(current.acceptance),
    coverage,
    mutationDetail: current.mutationDetail || null,
    loopState: loop?.state || null,
    source: phase ? 'recorded' : 'unrecorded',
    note: '当前状态与历史轮次独立；以下为只读观测，不执行门禁判定。没有阻塞记录也不等于验收通过。',
  }
}

export function buildSubmissionFlow({ submissions = [], previousSubmission = null, current = {}, total = null, page = {} } = {}) {
  const acceptance = currentAcceptance(current)
  const rounds = submissions.map((sub, i) => {
    const previous = submissions[i + 1] || previousSubmission
    const receipt = submissionReceipt(sub)
    const binding = sub.evidence?.binding
    const snapshot = sub.evidence?.snapshot
    const doc = parseFlowJson(binding?.canonical_binding_json, {})
    const lock = doc.assetLock
    const audit = list(sub.evidence?.audit).find((a) => a.submission_id === sub.submissionId && !a.run_id && a.author)
    const actor = text(receipt?.actor?.subject || receipt?.actor || receipt?.submittedBy) || sub.evidence?.principal?.subject || audit?.author
    const connector = compareSubmissionInputs(previous, sub)
    const formal = list(sub.runs).map((r) => runNode(r, sub.submissionId))
    const mutations = list(sub.mutations).map((r) => runNode(r, sub.submissionId, true))
    const currentBinding = Boolean(sub.bindingId && sub.bindingId === acceptance.activeBindingId && binding?.state === 'active')
    const id = `submission:${sub.submissionId}`
    const required = list(sub.requiredUnits)
    const missingUnits = required.filter((u) => !list(sub.runs).some((r) => `${r.unit}:${r.side}` === u))
    const formalState = aggregate(formal)
    const historical = Boolean(binding && binding.state !== 'active') || Boolean(acceptance.activeBindingId && sub.bindingId !== acceptance.activeBindingId)
    const prepare = snapshot && Array.isArray(lock?.specs)
    const preflight = receipt?.preflight
    return {
      id, submissionId: sub.submissionId, bindingId: sub.bindingId,
      roundNo: Number.isInteger(sub.roundNo) ? sub.roundNo : null,
      epoch: sub.epoch ?? null,
      kind: 'formal', status: sub.status,
      createdAt: sub.createdAt, expectedTaskRevision: sub.expectedTaskRevision,
      historical, bindingState: binding?.state || null, staleReason: binding?.stale_reason || null,
      actor: evidence(actor, receipt ? 'receipt' : sub.evidence?.principal?.subject ? 'principal' : 'inferred'),
      trigger: evidence(text(receipt?.trigger?.reason || receipt?.triggerReason || receipt?.reason), 'receipt'),
      receiptAuditId: receipt?.auditId || null,
      connector,
      steps: [
        { id: `${id}:prepare`, kind: 'prepare', label: '快照与考卷准备', state: prepare ? 'recorded' : 'unknown',
          summary: prepare ? '已找到冻结输入；不代表预检通过' : '冻结输入记录不完整',
          snapshot: snapshot ? { id: snapshot.snapshot_id, tree: snapshot.snapshot_tree_oid, commit: snapshot.snapshot_commit_oid, head: snapshot.head_commit_oid } : null,
          specs: Array.isArray(lock?.specs) ? lock.specs.map((s) => ({ featureKey: s.featureKey, version: s.version, specType: s.specType, side: s.side, blobSha256: s.blobSha256 })) : null,
          preflight: preflight && ['passed', 'failed', 'skipped'].includes(preflight.status)
            ? { state: preflight.status, detail: text(preflight.detail), source: 'receipt' }
            : { state: 'unknown', detail: '未记录预检，不能由已下单推断通过', source: 'unrecorded' },
        },
        { id: `${id}:execute`, kind: 'execute', label: '排队 / 执行',
          state: missingUnits.length && formalState === 'passed' ? 'unknown' : formalState,
          summary: `${formal.length} 个正式单元；attempt 属于本轮，不计新轮次`, requiredUnits: required, missingUnits, nodes: formal },
        { id: `${id}:mutation`, kind: 'mutation', label: '变异验卷', state: aggregate(mutations),
          summary: mutations.length ? `${mutations.length} 个同轮自动 mutation；按各自记录展示，可与其他单元并行` : '未记录本轮 mutation；可能复用/豁免，但无证据不判通过', nodes: mutations },
        { id: `${id}:acceptance`, kind: 'acceptance', label: '验收', state: 'unknown',
          summary: currentBinding ? '本轮结果供当前验收参考；本轮通过 ≠ 任务验收完成' : '历史结果保留；未记录本轮独立验收结论',
          currentBinding, currentAcceptanceId: currentBinding ? acceptance.id : null },
      ],
    }
  })
  return { version: 1, total, page, currentAcceptance: acceptance, rounds }
}
