// 只读模型：不导入生产 db、迁移、策略 resolver 或存储初始化器；外部观测与文件读取均显式注入。
import { isPostgres } from '../db/dialect-helpers.js'
import { buildSubmissionFlow, mutationVerdict, parseFlowJson } from '../testing/submission-flow.js'
import { phaseToActivity } from '../harness/activity-plan.js'

const list = (value) => Array.isArray(value) ? value : []
const LIVE = new Set(['planned', 'queued', 'active', 'running'])
const BAD = new Set(['failed', 'error', 'timed_out', 'lost', 'rejected'])
const CANCELED = new Set(['canceled', 'superseded'])
const MODES = new Set(['legacy', 'disabled', 'observe', 'enforce_s', 'enforce_ml', 'enforce_all'])
const optionalRead = async (conn, sql, args = [], many = false) => {
  // PG tx 内失败语句会把主事务推到 aborted 态 → 同事务后面所有查询一路报
  // "current transaction is aborted"，看板刷新就 500。有 savepoint 时优先隔离，
  // 失败只回滚 savepoint、主事务还能继续用；无 savepoint（池级自动提交 / sqlite）则回退普通 try/catch。
  if (conn && typeof conn.savepoint === 'function') {
    try { return await conn.savepoint(() => conn.prepare(sql)[many ? 'all' : 'get'](...args)) } catch { return many ? [] : null }
  }
  try { return await conn.prepare(sql)[many ? 'all' : 'get'](...args) } catch { return many ? [] : null }
}
export const taskTestingKey = (repo, taskId) => JSON.stringify([repo, taskId])

export async function locateTaskInstance(conn, { taskId, repo = null }) {
  return await conn.prepare(`SELECT ti.*, r.slug FROM task_instances ti
    JOIN repositories r ON r.repo_id=ti.repo_id
    WHERE ti.external_task_id=? ${repo ? 'AND r.slug=?' : ''}
    ORDER BY ti.epoch DESC, ti.task_instance_id DESC LIMIT 1`).get(taskId, ...(repo ? [repo] : [])) || null
}

// 按必需单元而非 attempt 计数；没有稳定分母时不推导通过，也不把可选单元补成必需项。
export function summarizeExecution(submission) {
  const validUnit = (u) => typeof u === 'string' && u.length > 0
  const requiredKnown = Array.isArray(submission?.requiredUnits) && submission.requiredUnits.every(validUnit)
  const requiredUnits = [...new Set(list(submission?.requiredUnits).filter(validUnit))]
  const runs = list(submission?.runs)
  const groups = requiredUnits.map((u) => runs.filter((r) => `${r.unit}:${r.side}` === u))
  const missing = requiredUnits.filter((_, i) => !groups[i].length)
  const passed = groups.filter((rs) => rs.length && rs.every((r) => r.status === 'passed')).length
  const failed = groups.filter((rs) => rs.some((r) => BAD.has(r.status))).length
  const active = groups.filter((rs) => rs.some((r) => LIVE.has(r.status))).length
  const canceled = groups.filter((rs) => rs.length && rs.every((r) => CANCELED.has(r.status))).length
  const completed = groups.filter((rs) => rs.length && rs.every((r) => BAD.has(r.status) || CANCELED.has(r.status) || ['passed', 'skipped'].includes(r.status))).length
  const queued = groups.filter((rs) => rs.some((r) => ['queued', 'planned'].includes(r.status))).length
  const running = groups.filter((rs) => rs.some((r) => ['active', 'running'].includes(r.status))).length
  let state = 'unknown'
  if (!submission) state = 'idle'
  else if (active) state = running ? 'running' : 'queued'
  else if (failed) state = 'failed'
  else if (missing.length) state = 'unknown'
  else if (requiredKnown && !requiredUnits.length) state = 'not_applicable'
  else if (requiredKnown && requiredUnits.length && passed === requiredUnits.length) state = 'passed'
  else if (requiredKnown && requiredUnits.length && canceled === requiredUnits.length) state = 'canceled'
  return { state, required: requiredKnown ? requiredUnits.length : null, requiredKnown, requiredUnits,
    passed, failed, active, missing, completed, canceled, queued, running, recorded: runs.length }
}

export function summarizeMutation(runs = [], { lightweight = false } = {}) {
  const counts = { killed: 0, weak: 0, exempt: 0, active: 0, inconclusive: 0, unknown: runs.length ? 0 : null }
  for (const run of runs) {
    const state = lightweight
      ? LIVE.has(run.status) ? 'running' : ['error', 'lost', 'timed_out', 'rejected'].includes(run.status) || CANCELED.has(run.status) ? 'error' : 'unknown'
      : mutationVerdict(run).state
    const key = { passed: 'killed', weak: 'weak', exempt: 'exempt', running: 'active', queued: 'active', error: 'inconclusive' }[state] || 'unknown'
    counts[key] += 1
  }
  // null 表示未知范围无法量化，不伪造一个待验卷项或复用历史结论补绿。
  return { ...counts, recorded: runs.length, scope: 'latest_submission', unrecorded: !runs.length, detailAvailable: !lightweight }
}

export function buildTaskTestingSummary({ repo = null, taskId, instance = null, latest = null, total = 0,
  configured = null, policy = null, blockers = [], observedAt = new Date().toISOString(), lightweight = false } = {}) {
  const execution = summarizeExecution(latest)
  const mutation = summarizeMutation(list(latest?.mutations), { lightweight })
  const effective = policy && !policy.error && !list(policy.policyErrors).length && MODES.has(policy.effectiveMode) ? policy.effectiveMode : null
  const reasons = [...blockers]
  if (!instance) reasons.push({ code: 'TASK_INSTANCE_UNAVAILABLE', detail: '没有当前任务实例' })
  if (!latest) reasons.push({ code: 'NO_CURRENT_SUBMISSION', detail: '当前任务实例尚无正式轮；历史轮不作为当前执行结果' })
  if (execution.failed) reasons.push({ code: 'EXECUTION_FAILED', detail: `正式执行失败 ${execution.failed} 项` })
  if (execution.missing.length) reasons.push({ code: 'REQUIRED_UNITS_MISSING', detail: execution.missing.join('、') })
  if (mutation.weak) reasons.push({ code: 'MUTATION_WEAK', detail: `未杀中 ${mutation.weak} 项` })
  if (mutation.inconclusive) reasons.push({ code: 'MUTATION_INCONCLUSIVE', detail: `未考成 ${mutation.inconclusive} 项` })
  if (mutation.unrecorded || mutation.unknown) reasons.push({ code: 'MUTATION_UNKNOWN', detail: '本轮验卷证据不完整，不推断通过' })
  if (!effective) reasons.push({ code: 'EFFECTIVE_MODE_UNAVAILABLE', detail: '没有可信的只读有效模式来源' })
  return {
    version: 1,
    context: { repo: instance?.slug || repo, taskId, taskInstanceId: instance?.task_instance_id || null,
      epoch: instance?.epoch ?? null, revision: instance?.revision ?? null, activeBindingId: instance?.active_binding_id || null },
    latestSubmissionId: latest?.submissionId || null, formalRoundCount: total, execution, mutation,
    mode: { configured: MODES.has(configured) ? configured : null, effective, source: effective ? 'preview' : null },
    assessment: { kind: instance ? 'observation' : 'unavailable', targetTransition: null, reasons,
      evidenceRefs: latest ? [{ kind: 'submission', submissionId: latest.submissionId }] : [], observedAt },
    observedAt,
  }
}

export async function readRunArtifact(conn, runId, artifactId = null) {
  return await conn.prepare(`SELECT artifact_id, attempt, size, artifact_truncated, scan_state, archive_sha256, expire_at, deleted_at
    FROM artifacts WHERE run_id=? ${artifactId != null ? 'AND artifact_id=?' : 'AND deleted_at IS NULL'}
    ORDER BY attempt DESC, created_at DESC, artifact_id DESC LIMIT 1`).get(runId, ...(artifactId != null ? [artifactId] : [])) || null
}

export async function readRun(conn, r) {
  const attempts = await optionalRead(conn, `SELECT a.attempt, a.status, a.started_at, a.finished_at, a.heartbeat_at,
    a.error_code, a.error_detail, a.image_id, w.hostname AS worker
    FROM run_attempts a LEFT JOIN workers w ON w.worker_id=a.worker_id WHERE a.run_id=? ORDER BY a.attempt`, [r.run_id], true)
  const accepted = await optionalRead(conn, 'SELECT accepted_at FROM accepted_run_results WHERE run_id=?', [r.run_id])
  let artifact = null
  // readRunArtifact 内部也会走 tx.prepare；失败时同样需要 savepoint 隔离，避免毒化主事务。
  if (conn && typeof conn.savepoint === 'function') {
    try { artifact = await conn.savepoint(() => readRunArtifact(conn, r.run_id)) } catch { /* 历史库无 artifact 表时明确缺证据 */ }
  } else {
    try { artifact = await readRunArtifact(conn, r.run_id) } catch { /* 历史库无 artifact 表时明确缺证据 */ }
  }
  const report = parseFlowJson(r.report_json, {})
  const payload = parseFlowJson(r.payload_json, {})
  return {
    runId: r.run_id, unit: r.unit, side: r.side, status: r.status, terminalReason: r.terminal_reason,
    queueWaitMs: r.queue_wait_ms, totalMs: r.total_ms, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    acceptedAt: accepted?.accepted_at || null,
    reportAttempt: Number.isInteger(report.attempt) && report.attempt > 0 ? report.attempt : null,
    attempts: attempts.map((a) => ({ attempt: a.attempt, status: a.status, worker: a.worker || null, imageId: a.image_id,
      startedAt: a.started_at, finishedAt: a.finished_at, heartbeatAt: a.heartbeat_at, errorCode: a.error_code, errorDetail: a.error_detail })),
    checks: list(report.checks).map((c) => ({ caseKey: c.caseKey, status: c.status, detail: c.detail || null,
      durationMs: c.durationMs ?? null, actionCount: c.actionCount ?? null, mutation: c.mutation || null })),
    artifact: artifact ? { artifactId: artifact.artifact_id, attempt: artifact.attempt, size: artifact.size,
      truncated: !!artifact.artifact_truncated, scanState: artifact.scan_state, expired: Date.parse(artifact.expire_at) <= Date.now() } : null,
    ...(r.purpose === 'mutation' ? { featureKey: payload.featureKey || null, specVersion: payload.specVersion ?? null,
      sourceRunId: payload.sourceRunId || r.diagnostic_of_run_id || null,
      f2p: await optionalRead(conn, 'SELECT run_id, f2p_status, detail FROM spec_f2p_results WHERE run_id=? ORDER BY created_at DESC LIMIT 1', [r.run_id]) } : {}),
  }
}

async function readSubmission(conn, s) {
  const group = await optionalRead(conn, "SELECT * FROM run_groups WHERE submission_id=? AND kind='formal' ORDER BY run_group_id DESC LIMIT 1", [s.submission_id])
  // pg 事务内 Promise.all 让 savepoint 交错压栈；RELEASE 上层会级联销毁下层，
  // 触发 sp "does not exist" → 主事务 aborted 级联，看板刷新 500。改成顺序 for-of。
  const runs = []
  if (group) {
    const gateRows = await conn.prepare("SELECT * FROM test_runs WHERE run_group_id=? AND purpose='gate' ORDER BY unit, side, run_id").all(group.run_group_id)
    for (const r of gateRows) runs.push(await readRun(conn, r))
  }
  const mutationRows = await optionalRead(conn, `SELECT r.* FROM test_runs r JOIN run_groups g ON g.run_group_id=r.run_group_id
    WHERE g.submission_id=? AND r.purpose='mutation' ORDER BY r.created_at, r.run_id`, [s.submission_id], true)
  const mutations = []
  for (const r of mutationRows || []) mutations.push(await readRun(conn, r))
  return { submissionId: s.submission_id, bindingId: s.binding_id, expectedTaskRevision: s.expected_task_revision,
    status: s.status, createdAt: s.created_at, startedAt: s.started_at, finishedAt: s.finished_at,
    requiredUnits: parseFlowJson(group?.required_units_json, null), gateEligible: !!group?.gate_eligible,
    roundNo: s.round_no, epoch: s.epoch, runs, mutations }
}

export async function readTaskTestingView(conn, { taskId, repo = null, limit = 5, before = null }, readers = {}) {
  const observedAt = readers.now?.() || new Date().toISOString()
  const pageSize = Math.min(20, Math.max(1, Math.floor(Number(limit)) || 5))
  const inst = await locateTaskInstance(conn, { taskId, repo })
  const slug = inst?.slug || repo
  let configured = null, policy = null
  // 下面几处 try/catch 都在 db.tx 传入的主事务内执行：直接吞错会把主事务推到 aborted 态，
  // 同一事务后面的查询会一路报"current transaction is aborted"，前端看到刷新 500。
  // 优先走 savepoint 隔离；无 savepoint（sqlite）时退回普通 try/catch。
  const isolate = async (fn, fallback) => {
    const compute = typeof fallback === 'function' ? fallback : () => fallback
    if (conn && typeof conn.savepoint === 'function') {
      try { return await conn.savepoint(fn) } catch { return compute() }
    }
    try { return await fn(conn) } catch { return compute() }
  }
  configured = await isolate(
    async () => readers.getRepoGateMode
      ? await readers.getRepoGateMode(conn, slug)
      : (await conn.prepare(`SELECT m.mode FROM repositories r LEFT JOIN repo_gate_modes m ON m.repo_id=r.repo_id WHERE r.slug=?`).get(slug))?.mode || 'legacy',
    'legacy'
  )
  // 这里只接受调用者保证无写操作的预览；不导入既有会 ensure 表结构的 preview。
  policy = await isolate(
    async () => readers.previewGatePolicy ? await readers.previewGatePolicy(conn, { repoSlug: slug, taskId, size: inst?.size || null }) : null,
    null
  )
  if (!inst) return { ok: true, linked: false, total: 0, submissions: [],
    page: { limit: pageSize, hasMore: false, nextCursor: null }, flow: buildSubmissionFlow({ total: 0 }),
    summary: buildTaskTestingSummary({ repo: slug, taskId, configured, policy, observedAt }) }
  const task = await optionalRead(conn, 'SELECT phase, meta FROM tasks WHERE repo=? AND task_id=?', [slug, taskId])
  const loop = await optionalRead(conn, 'SELECT * FROM gate_loops WHERE repo=? AND task_id=?', [slug, taskId])
  const binding = await optionalRead(conn, 'SELECT * FROM test_bindings WHERE binding_id=?', [inst.active_binding_id])
  let acceptance = [], acCoverage = null, mutationDetail = null
  // 整段 acceptance/acCoverage/mutationDetail 观察都跑在主事务里；PG 中任一 SQL 失败会污染
  // 主事务 → 后续 SQL 一路报 "current transaction is aborted"，看板刷新 500。
  // 用 isolate/savepoint 隔离：吞错只回滚 savepoint，主事务保持可用；无 savepoint（sqlite）退回普通 try/catch。
  acceptance = await isolate(
    async () => readers.getTaskAcceptance ? await readers.getTaskAcceptance(conn, { repoSlug: slug, taskId }) : [],
    []
  )
  acCoverage = await isolate(
    async () => readers.evaluateAcCoverage ? await readers.evaluateAcCoverage(conn, { repoSlug: slug, taskId }) : null,
    null
  )
  mutationDetail = await isolate(
    async () => acCoverage?.applicable && readers.describeMutationVerification
      ? await readers.describeMutationVerification(conn, { repoSlug: slug, taskId })
      : null,
    null
  )
  // 全任务跨 epoch 编号；candidate 组和 attempt 均不产生正式轮。
  const ranked = `WITH ranked AS (
    SELECT s.*, ti.epoch, ROW_NUMBER() OVER (ORDER BY ti.epoch, s.created_at, s.submission_id) AS round_no
    FROM test_submissions s JOIN task_instances ti ON ti.task_instance_id=s.task_instance_id
    WHERE ti.external_task_id=? AND ti.repo_id=?
      AND EXISTS (SELECT 1 FROM run_groups g WHERE g.submission_id=s.submission_id AND g.kind='formal')
  )`
  const keys = [taskId, inst.repo_id]
  const total = (await conn.prepare(`${ranked} SELECT COUNT(*) AS total FROM ranked`).get(...keys)).total
  if (before && !await conn.prepare(`${ranked} SELECT submission_id FROM ranked WHERE submission_id=?`).get(...keys, before)) {
    throw new Error('历史分页游标不存在或不属于该任务')
  }
  const rows = await conn.prepare(`${ranked} SELECT * FROM ranked
    ${before ? 'WHERE round_no < (SELECT round_no FROM ranked WHERE submission_id=?)' : ''}
    ORDER BY round_no DESC LIMIT ?`).all(...keys, ...(before ? [before] : []), pageSize + 1)
  const page = { limit: pageSize, before: before || null, hasMore: rows.length > pageSize,
    nextCursor: rows.length > pageSize ? rows[pageSize - 1].submission_id : null }
  const readEvidence = async (s) => ({
    binding: await optionalRead(conn, 'SELECT * FROM test_bindings WHERE binding_id=?', [s.binding_id]),
    snapshot: await optionalRead(conn, `SELECT bs.* FROM business_snapshots bs JOIN test_bindings b ON b.snapshot_id=bs.snapshot_id WHERE b.binding_id=?`, [s.binding_id]),
    principal: await optionalRead(conn, 'SELECT subject, display_name FROM principals WHERE principal_id=?', [s.principal_id]),
    audit: await optionalRead(conn, isPostgres(conn)
      // postgres(§2.8):jsonb 运算符;非法 JSON 行被 ->> 转换错误跳过(应用层不需 json_valid)
      ? `SELECT id, submission_id, run_id, binding_id, author, tool_name, detail, payload_json, created_at
      FROM audit_events WHERE submission_id=? OR (repo=? AND task_id=? AND payload_json::jsonb->>'submissionReceipt' IS NOT NULL
        AND (payload_json::jsonb->'submissionReceipt'->>'submissionId'=? OR payload_json::jsonb->'receipt'->>'submissionId'=?))
      ORDER BY id DESC LIMIT 20`
      : `SELECT id, submission_id, run_id, binding_id, author, tool_name, detail, payload_json, created_at
      FROM audit_events WHERE submission_id=? OR (repo=? AND task_id=? AND json_valid(payload_json)
        AND (json_extract(payload_json, '$.submissionReceipt.submissionId')=? OR json_extract(payload_json, '$.receipt.submissionId')=?))
      ORDER BY id DESC LIMIT 20`, [s.submission_id, slug, taskId, s.submission_id, s.submission_id], true),
  })
  // 同 readSubmission 注释：pg 事务里 Promise.all 会打乱 savepoint 栈顺序，导致
  // RELEASE/ROLLBACK TO 撞 "savepoint does not exist" → 主事务 aborted 级联。
  const enriched = []
  for (const s of rows.slice(0, pageSize)) {
    enriched.push({ ...await readSubmission(conn, s), evidence: await readEvidence(s) })
  }
  const previousRow = rows[pageSize]
  const previousSubmission = previousRow ? { submissionId: previousRow.submission_id, evidence: await readEvidence(previousRow) } : null
  const flow = buildSubmissionFlow({ submissions: enriched, previousSubmission, total, page,
    current: { task: task || {}, instance: inst, binding, loop, acceptance, coverage: acCoverage, mutationDetail } })
  // 当前摘要不取历史页第一条；新 epoch 无轮次时也不借用旧 epoch 的绿色结果。
  const latestRow = await conn.prepare(`${ranked} SELECT * FROM ranked WHERE task_instance_id=? ORDER BY round_no DESC LIMIT 1`).get(...keys, inst.task_instance_id)
  const latest = latestRow ? enriched.find((s) => s.submissionId === latestRow.submission_id) || await readSubmission(conn, latestRow) : null
  const summary = buildTaskTestingSummary({ repo: slug, taskId, instance: inst, latest, total, configured, policy,
    blockers: flow.currentAcceptance.blockers, observedAt })
  return { ok: true, linked: total > 0, total, page,
    task: { size: inst.size, type: inst.type, epoch: inst.epoch, phase: task?.phase || inst.phase || null },
    gateMode: configured, acceptance, acCoverage: acCoverage || { applicable: false, total: 0, missing: [], covered: [] },
    mutationDetail, submissions: enriched.map(({ evidence: _evidence, ...s }) => s), flow, summary }
}

// cloud-status 的旧 node/round 只为兼容保留；新客户端使用同源 summary，不从生命周期反推执行通过。
export async function readCloudTestingStatus(conn, { taskId, repo }, readers = {}) {
  const view = await readTaskTestingView(conn, { taskId, repo, limit: 1 }, readers)
  const inst = await locateTaskInstance(conn, { taskId, repo })
  const loop = await optionalRead(conn, 'SELECT * FROM gate_loops WHERE repo=? AND task_id=?', [repo, taskId])
  const taskRow = await optionalRead(conn, 'SELECT phase FROM tasks WHERE repo=? AND task_id=?', [repo, taskId])
  const sub = inst ? await conn.prepare(`SELECT s.submission_id, s.status, s.binding_id, s.created_at, s.finished_at, g.required_units_json, g.run_group_id
    FROM test_submissions s JOIN run_groups g ON g.submission_id=s.submission_id AND g.kind='formal'
    WHERE s.task_instance_id=? ORDER BY s.created_at DESC, s.submission_id DESC, g.run_group_id DESC LIMIT 1`).get(inst.task_instance_id) : null
  const runs = sub ? (await conn.prepare(`SELECT run_id, unit, side, status, terminal_reason, next_attempt, started_at, finished_at, coverage_complete
    FROM test_runs WHERE run_group_id=? AND purpose='gate' ORDER BY unit, side, run_id`).all(sub.run_group_id)).map((r) => ({
    unit: r.unit, side: r.side, status: r.status, terminalReason: r.terminal_reason,
    attempts: r.next_attempt, startedAt: r.started_at, finishedAt: r.finished_at, coverageComplete: r.coverage_complete,
  })) : []
  const infraRetries = runs.length ? Math.max(...runs.map((r) => Number(r.attempts) || 1)) : 0
  const activeRuns = runs.filter((r) => r.status === 'queued' || r.status === 'active').length
  const ac = view.acCoverage || { applicable: false, covered: [], missing: [], offPath: [] }
  // 数据源可能来自 tasks/gate_loops（活动名）或 task_instances（旧名），统一投影后判断
  const phase = taskRow?.phase || loop?.phase || inst?.phase || 'EXECUTE'
  const phaseAct = phaseToActivity(phase)
  const needsHuman = Boolean(loop?.needs_human)
  const gatePassed = sub?.status === 'passed'
  const running = activeRuns > 0
  const provisioning = runs.some((r) => r.status === 'active' && !r.startedAt)
  let subStage = 'idle'
  if (running) {
    if (runs.some((r) => r.status === 'queued')) subStage = 'queued'
    else if (provisioning) subStage = 'provisioning'
    else subStage = 'executing'
  } else if (sub) subStage = gatePassed ? 'attributing' : 'failed'
  let status, finished
  if (needsHuman) { status = 'needs_human'; finished = false }
  else if (['CLOSED'].includes(phase) || ['static', 'smoke', 'done'].includes(phaseAct)) { status = 'passed'; finished = true }
  else if (running) { status = provisioning ? 'provisioning' : 'running'; finished = false }
  else if (sub?.status === 'error') { status = 'failed'; finished = false }
  else if (sub?.status === 'canceled') { status = 'canceled'; finished = false }
  else if (sub) { status = 'verifying'; finished = false }
  else { status = 'idle'; finished = false }
  const labels = {
    idle: '未开始', queued: '排队中', provisioning: '环境准备中', running: '执行中', executing: '执行中',
    verifying: '判定中', passed: '云端测试通过', failed: '未通过', needs_human: '需人工介入', canceled: '已取消', attributing: '归因中',
  }
  return { ok: true, repo, taskId, taskPhase: phase, instanceStatus: inst?.status || null, loopState: loop?.state || null,
    round: (loop?.iteration || 0) + (status === 'passed' ? 0 : sub ? 1 : 0), maxRounds: loop?.max_iterations ?? null,
    needsHuman, lastTerminal: loop?.last_terminal || null, lastClass: loop?.last_class || null, infraRetries, activeRuns,
    submission: sub ? { id: sub.submission_id, status: sub.status, bindingId: sub.binding_id, createdAt: sub.created_at, requiredUnits: parseFlowJson(sub.required_units_json, []) } : null,
    runs, ac: { applicable: ac.applicable, covered: ac.covered, missing: ac.missing, offPath: ac.offPath || [] },
    node: { status, finished, subStage, label: labels[status] || status }, summary: view.summary }
}

// 两次批量 SELECT 仅针对当前返回任务；不拉报告、AC、F2P，也不依赖全局最近 N 条。
export async function readTaskGateSummaries(conn, tasks, { observedAt = new Date().toISOString() } = {}) {
  const result = new Map()
  const requested = [...new Map(tasks.map((t) => [taskTestingKey(t.repo, t.task_id), { repo: t.repo, taskId: t.task_id }])).values()]
  for (const t of requested) result.set(taskTestingKey(t.repo, t.taskId), { summary: buildTaskTestingSummary({ ...t, observedAt, lightweight: true }), legacy: null })
  if (!requested.length) return result
  let rows
  try {
    const PG_BATCH = `WITH requested AS (
      SELECT value->>'repo' AS repo, value->>'taskId' AS task_id FROM jsonb_array_elements(?::jsonb)
    ), instances AS (
      SELECT ti.*, r.slug, ROW_NUMBER() OVER (PARTITION BY ti.repo_id, ti.external_task_id ORDER BY ti.epoch DESC, ti.task_instance_id DESC) AS instance_rank
      FROM requested q JOIN repositories r ON r.slug=q.repo
      JOIN task_instances ti ON ti.repo_id=r.repo_id AND ti.external_task_id=q.task_id
    ), rounds AS (
      SELECT s.*, i.slug, i.external_task_id, ROW_NUMBER() OVER (PARTITION BY s.task_instance_id ORDER BY s.created_at DESC, s.submission_id DESC) AS submission_rank
      FROM instances i JOIN test_submissions s ON s.task_instance_id=i.task_instance_id
      WHERE EXISTS (SELECT 1 FROM run_groups g WHERE g.submission_id=s.submission_id AND g.kind='formal')
    ), counts AS (
      SELECT slug, external_task_id, COUNT(*) AS total FROM rounds GROUP BY slug, external_task_id
    ) SELECT q.repo, q.task_id, i.task_instance_id, i.epoch, i.revision, i.active_binding_id,
      COALESCE(m.mode, 'legacy') AS mode, COALESCE(c.total, 0) AS total,
      s.submission_id, s.status, s.created_at, g.required_units_json, g.run_group_id
      FROM requested q LEFT JOIN repositories r ON r.slug=q.repo
      LEFT JOIN instances i ON i.slug=q.repo AND i.external_task_id=q.task_id AND i.instance_rank=1
      LEFT JOIN repo_gate_modes m ON m.repo_id=r.repo_id
      LEFT JOIN counts c ON c.slug=q.repo AND c.external_task_id=q.task_id
      LEFT JOIN rounds s ON s.task_instance_id=i.task_instance_id AND s.submission_rank=1
      LEFT JOIN run_groups g ON g.run_group_id=(SELECT g2.run_group_id FROM run_groups g2 WHERE g2.submission_id=s.submission_id AND g2.kind='formal' ORDER BY g2.run_group_id DESC LIMIT 1)`
    const SQLITE_BATCH = `WITH requested AS (
      SELECT json_extract(value, '$.repo') AS repo, json_extract(value, '$.taskId') AS task_id FROM json_each(?)
    ), instances AS (
      SELECT ti.*, r.slug, ROW_NUMBER() OVER (PARTITION BY ti.repo_id, ti.external_task_id ORDER BY ti.epoch DESC, ti.task_instance_id DESC) AS instance_rank
      FROM requested q JOIN repositories r ON r.slug=q.repo
      JOIN task_instances ti ON ti.repo_id=r.repo_id AND ti.external_task_id=q.task_id
    ), rounds AS (
      SELECT s.*, i.slug, i.external_task_id, ROW_NUMBER() OVER (PARTITION BY s.task_instance_id ORDER BY s.created_at DESC, s.submission_id DESC) AS submission_rank
      FROM instances i JOIN test_submissions s ON s.task_instance_id=i.task_instance_id
      WHERE EXISTS (SELECT 1 FROM run_groups g WHERE g.submission_id=s.submission_id AND g.kind='formal')
    ), counts AS (
      SELECT slug, external_task_id, COUNT(*) AS total FROM rounds GROUP BY slug, external_task_id
    ) SELECT q.repo, q.task_id, i.task_instance_id, i.epoch, i.revision, i.active_binding_id,
      COALESCE(m.mode, 'legacy') AS mode, COALESCE(c.total, 0) AS total,
      s.submission_id, s.status, s.created_at, g.required_units_json, g.run_group_id
      FROM requested q LEFT JOIN repositories r ON r.slug=q.repo
      LEFT JOIN instances i ON i.slug=q.repo AND i.external_task_id=q.task_id AND i.instance_rank=1
      LEFT JOIN repo_gate_modes m ON m.repo_id=r.repo_id
      LEFT JOIN counts c ON c.slug=q.repo AND c.external_task_id=q.task_id
      LEFT JOIN rounds s ON s.task_instance_id=i.task_instance_id AND s.submission_rank=1
      LEFT JOIN run_groups g ON g.run_group_id=(SELECT g2.run_group_id FROM run_groups g2 WHERE g2.submission_id=s.submission_id AND g2.kind='formal' ORDER BY g2.run_group_id DESC LIMIT 1)`
    rows = await conn.prepare(isPostgres(conn) ? PG_BATCH : SQLITE_BATCH).all(JSON.stringify(requested))
    const ids = rows.map((r) => r.submission_id).filter(Boolean)
    const runs = ids.length ? await conn.prepare(isPostgres(conn)
      ? `SELECT r.run_id, r.run_group_id, r.unit, r.side, r.status, r.purpose, g.kind, g.submission_id
      FROM jsonb_array_elements(?::jsonb) ids JOIN run_groups g ON g.submission_id=ids.value::text JOIN test_runs r ON r.run_group_id=g.run_group_id
      WHERE (g.kind='formal' AND r.purpose='gate') OR r.purpose='mutation'`
      : `SELECT r.run_id, r.run_group_id, r.unit, r.side, r.status, r.purpose, g.kind, g.submission_id
      FROM json_each(?) ids JOIN run_groups g ON g.submission_id=ids.value JOIN test_runs r ON r.run_group_id=g.run_group_id
      WHERE (g.kind='formal' AND r.purpose='gate') OR r.purpose='mutation'`).all(JSON.stringify(ids)) : []
    const bySubmission = new Map()
    for (const r of runs) {
      if (!bySubmission.has(r.submission_id)) bySubmission.set(r.submission_id, [])
      bySubmission.get(r.submission_id).push(r)
    }
    for (const r of rows) {
      const ownRuns = bySubmission.get(r.submission_id) || []
      const formal = ownRuns.filter((run) => run.run_group_id === r.run_group_id && run.purpose === 'gate')
      const latest = r.submission_id ? { submissionId: r.submission_id, requiredUnits: parseFlowJson(r.required_units_json, null),
        runs: formal, mutations: ownRuns.filter((run) => run.purpose === 'mutation') } : null
      const summary = buildTaskTestingSummary({ repo: r.repo, taskId: r.task_id,
        instance: r.task_instance_id ? { ...r, slug: r.repo } : null, latest, total: r.total,
        configured: r.mode, observedAt, lightweight: true })
      result.set(taskTestingKey(r.repo, r.task_id), { summary,
        legacy: latest ? { status: r.status, passed: formal.filter((run) => run.status === 'passed').length, total: formal.length, at: r.created_at } : null })
    }
  } catch { /* 旧库表不齐时返回显式 unavailable，而非伪造通过 */ }
  return result
}

// artifactId 明确指定时绝不回退 latest；包所属 run 的校验与读取使用同一条 SELECT。
export async function loadRunArtifactEntries(conn, { runId, artifactId = null }, storage) {
  const artifact = await readRunArtifact(conn, runId, artifactId)
  if (!artifact) return { error: '该运行没有上传日志包（artifact）', artifactId: null, attempt: null }
  const fail = (error) => ({ error, artifactId: artifact.artifact_id, attempt: artifact.attempt })
  if (artifact.deleted_at || Date.parse(artifact.expire_at) <= (storage.now?.() ?? Date.now())) return fail('日志包已过保留期（14 天）被清理')
  if (artifact.scan_state === 'rejected') return fail('日志包未通过安全扫描，禁止查看')
  const zipPath = storage.contentPath(artifact.archive_sha256)
  if (!storage.existsSync(zipPath)) return fail('日志包内容缺失（blob 不在存储中）')
  try { return { artifact, entries: storage.readZipCentralEntries(storage.readFileSync(zipPath)) } }
  catch (e) { return fail(`日志包解析失败：${e.message}`) }
}

export function utf8Tail(buffer, maxBytes = 512 * 1024) {
  const limit = Math.max(0, Math.floor(Number(maxBytes)) || 0)
  let offset = Math.max(0, buffer.length - limit)
  // 跳过截点后的 UTF-8 continuation bytes，避免半个汉字/emoji 产生替换字符。
  while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset += 1
  const tail = buffer.subarray(offset)
  return { text: tail.toString('utf8'), truncated: offset > 0, offsetBytes: offset, returnedBytes: tail.length }
}

// ─── 任务全流程追踪（2026-09-26 运维埋点配套）：只读 SELECT，把任务→版本→提交→run→attempt→审计→经验串成一条时间线 ───
export async function buildTaskTrace(conn, { taskId, repo = null }) {
  const instance = await locateTaskInstance(conn, { taskId, repo })
  const task = await optionalRead(conn,
    `SELECT task_id, repo, requirement, type, phase, size, author, created_at, updated_at, closed_at
     FROM tasks WHERE task_id=? ${repo ? 'AND repo=?' : ''} ORDER BY updated_at DESC LIMIT 1`,
    repo ? [taskId, repo] : [taskId])
  const versions = await optionalRead(conn,
    `SELECT phase, author, created_at FROM task_versions WHERE task_id=? ORDER BY created_at ASC LIMIT 300`,
    [taskId], true)
  const loop = await optionalRead(conn,
    `SELECT state, iteration, max_iterations, needs_human, last_class, last_submission_id, updated_at
     FROM gate_loops WHERE repo=? AND task_id=? ORDER BY updated_at DESC LIMIT 1`,
    [task?.repo || repo, taskId])
  const submissions = instance
    ? await optionalRead(conn,
      `SELECT s.submission_id, s.status, s.created_at, s.finished_at, g.run_group_id, g.kind, g.status AS group_status
       FROM test_submissions s LEFT JOIN run_groups g ON g.submission_id=s.submission_id
       WHERE s.task_instance_id=? ORDER BY s.created_at ASC LIMIT 100`,
      [instance.task_instance_id], true)
    : []
  const groupIds = submissions.map((s) => s.run_group_id).filter(Boolean)
  const runs = groupIds.length
    ? await optionalRead(conn,
      `SELECT run_id, run_group_id, unit, side, status, terminal_reason, purpose, created_at, started_at, finished_at
       FROM test_runs WHERE run_group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY created_at ASC`,
      groupIds, true)
    : []
  const runIds = runs.map((r) => r.run_id)
  const attempts = runIds.length
    ? await optionalRead(conn,
      `SELECT run_id, attempt, status, error_code, created_at, finished_at FROM run_attempts
       WHERE run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 500`,
      runIds, true)
    : []
  const audits = await optionalRead(conn,
    `SELECT event_type, tool_name, method, author, status, detail, created_at
     FROM audit_events WHERE task_id=? ORDER BY created_at ASC, id ASC LIMIT 800`,
    [taskId], true)
  const experiences = await optionalRead(conn,
    `SELECT id, category, status, author, created_at FROM experiences WHERE task_id=? ORDER BY created_at ASC LIMIT 50`,
    [taskId], true)

  const timeline = []
  for (const v of versions) timeline.push({ at: v.created_at, kind: 'task_version', summary: `phase=${v.phase}`, by: v.author })
  for (const s of submissions) timeline.push({ at: s.created_at, kind: 'submission', summary: `${s.kind || 'formal'} ${s.submission_id} → ${s.status}`, ref: s.submission_id })
  for (const r of runs) timeline.push({ at: r.created_at, kind: 'run', summary: `${r.purpose || 'gate'} ${r.unit}:${r.side || '-'} created → ${r.status}${r.terminal_reason ? ` (${r.terminal_reason})` : ''}`, ref: r.run_id })
  for (const r of runs) if (r.finished_at) timeline.push({ at: r.finished_at, kind: 'run_finished', summary: `${r.unit}:${r.side || '-'} ${r.status}${r.terminal_reason ? ` (${r.terminal_reason})` : ''}`, ref: r.run_id })
  for (const a of attempts) timeline.push({ at: a.created_at, kind: 'attempt', summary: `attempt#${a.attempt} ${a.status}${a.error_code ? ` (${a.error_code})` : ''}`, ref: a.run_id })
  for (const e of audits) timeline.push({ at: e.created_at, kind: 'audit', summary: `${e.event_type || e.tool_name || ''} ${e.status || ''} ${String(e.detail || '').slice(0, 120)}`, by: e.author })
  for (const x of experiences) timeline.push({ at: x.created_at, kind: 'experience', summary: `${x.id} ${x.category}/${x.status}`, by: x.author })
  timeline.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
  return {
    version: 1, generatedAt: new Date().toISOString(),
    task: task ? { taskId: task.task_id, repo: task.repo, requirement: String(task.requirement || '').slice(0, 120),
      phase: task.phase, author: task.author, createdAt: task.created_at, updatedAt: task.updated_at, closedAt: task.closed_at } : null,
    instance: instance ? { taskInstanceId: instance.task_instance_id, epoch: instance.epoch, activeBindingId: instance.active_binding_id } : null,
    gateLoop: loop ? { state: loop.state, iteration: loop.iteration, maxIterations: loop.max_iterations, needsHuman: Boolean(loop.needs_human), lastClass: loop.last_class } : null,
    counts: { submissions: submissions.length, runs: runs.length, attempts: attempts.length, audits: audits.length, experiences: experiences.length },
    timeline,
  }
}

// ─── 仓级需求→考卷覆盖地图（2026-09-26）：AI 出卷模式的运营底座，回答"哪些需求没有卷/哪些 AC 没覆盖" ───
export async function buildCoverageMap(conn, { repo }) {
  const repoRow = await optionalRead(conn, 'SELECT repo_id FROM repositories WHERE slug=?', [repo])
  if (!repoRow) return { version: 1, repo, error: 'REPO_NOT_FOUND', tasks: [], totals: null, generatedAt: new Date().toISOString() }
  const tasks = await optionalRead(conn,
    `SELECT task_id, requirement, phase, meta, created_at FROM tasks
     WHERE repo=? AND phase NOT IN ('DONE','ABORTED','done','aborted') ORDER BY created_at DESC LIMIT 200`,
    [repo], true)
  const specs = await optionalRead(conn,
    `SELECT feature_key, demand_ref, acceptance_refs_json, review_status, spec_type, side, version
     FROM test_specs WHERE repo_id=? AND review_status IN ('active','draft') ORDER BY feature_key`,
    [repoRow.repo_id], true)
  const coveredIndex = new Map()
  for (const s of specs) {
    let refs = []
    try { refs = JSON.parse(s.acceptance_refs_json || '[]') } catch { refs = [] }
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (!coveredIndex.has(ref)) coveredIndex.set(ref, [])
      coveredIndex.get(ref).push(s.feature_key)
    }
  }
  const rows = tasks.map((t) => {
    let acceptance = []
    try { acceptance = JSON.parse(t.meta || '{}')?.acceptance } catch { acceptance = [] }
    const list = Array.isArray(acceptance) ? acceptance : []
    const ids = list.map((a) => a?.id).filter(Boolean)
    const uncovered = ids.filter((id) => !coveredIndex.has(id))
    const covered = ids.filter((id) => coveredIndex.has(id))
    const specCount = specs.filter((s) => s.demand_ref === t.task_id).length
    return { taskId: t.task_id, requirement: String(t.requirement || '').slice(0, 100), phase: t.phase,
      createdAt: t.created_at, acceptanceTotal: ids.length, covered, uncovered, specCount,
      coveringSpecs: [...new Set(covered.flatMap((id) => coveredIndex.get(id) || []))] }
  })
  return {
    version: 1, generatedAt: new Date().toISOString(), repo,
    totals: { openTasks: tasks.length, activeSpecs: specs.filter((s) => s.review_status === 'active').length,
      draftSpecs: specs.filter((s) => s.review_status === 'draft').length,
      uncoveredAcs: rows.reduce((n, r) => n + r.uncovered.length, 0),
      tasksWithoutSpec: rows.filter((r) => !r.specCount).length },
    tasks: rows,
  }
}

// ─── 个人效能反馈（2026-09-26）：定位是开发者个人成长反馈，不是考核 ───
export async function buildDevStats(conn, { author, days = 30 }) {
  if (!author) return { version: 1, error: 'AUTHOR_REQUIRED' }
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const rows = await optionalRead(conn,
    `SELECT task_id, repo, phase, created_at FROM tasks WHERE author=? AND created_at>=?`,
    [author, since], true) || []
  const stats = { started: rows.length, done: 0, aborted: 0, inProgress: 0, firstPass: 0, iterations: [] }
  for (const t of rows) {
    if (['DONE', 'done'].includes(t.phase)) stats.done++
    else if (['ABORTED', 'aborted'].includes(t.phase)) stats.aborted++
    else stats.inProgress++
    if (['DONE', 'done'].includes(t.phase)) {
      const loop = await optionalRead(conn, `SELECT iteration FROM gate_loops WHERE repo=? AND task_id=?`, [t.repo, t.task_id])
      const it = Number(loop?.iteration || 1)
      stats.iterations.push(it)
      if (it <= 1) stats.firstPass++
    }
  }
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null)
  const distills = (await optionalRead(conn,
    `SELECT COUNT(*) c FROM experiences WHERE author=? AND created_at>=?`, [author, since]))?.c ?? null
  const teamStarted = (await optionalRead(conn,
    `SELECT COUNT(*) c FROM tasks WHERE created_at>=?`, [since]))?.c ?? 0
  const teamDone = (await optionalRead(conn,
    `SELECT COUNT(*) c FROM tasks WHERE phase IN ('DONE','done') AND created_at>=?`, [since]))?.c ?? 0
  return {
    version: 1, author, windowDays: days, since,
    tasks: { ...stats, avgIterations: avg(stats.iterations),
      firstPassRate: stats.done ? Math.round((stats.firstPass / stats.done) * 100) : null },
    distills,
    team: { started: teamStarted, done: teamDone },
  }
}

// ─── 平台状态自助页（2026-09-26）：聚合健康信号，回答"是平台挂了还是我的问题" ───
export async function buildPlatformStatus(conn, { lanhu = null } = {}) {
  const one = async (sql, ...a) => { try { return await conn.prepare(sql).get(...a) } catch { return null } }
  const workers = await one(`SELECT COUNT(*) c FROM workers WHERE status='active'`)
  const lastHeartbeat = await one(`SELECT MAX(last_heartbeat_at) h FROM workers WHERE status='active'`)
  const queued = await one(`SELECT COUNT(*) c FROM test_runs WHERE status='queued' AND desired_state='running'`)
  const active = await one(`SELECT COUNT(*) c FROM test_runs WHERE status IN ('active','running') AND desired_state='running'`)
  const openTasks = await one(`SELECT COUNT(*) c FROM tasks WHERE phase NOT IN ('DONE','ABORTED','done','aborted')`)
  const lastSweep = await one(`SELECT created_at, detail FROM audit_events WHERE author='system:5am' ORDER BY created_at DESC LIMIT 1`)
  const lastNightly = await one(`SELECT created_at, detail FROM audit_events WHERE event_type='nightly_regression_started' ORDER BY created_at DESC LIMIT 1`)
  const migrations = await one(`SELECT COUNT(*) c, MAX(applied_at) last FROM schema_migrations`)
  return {
    version: 1, generatedAt: new Date().toISOString(),
    db: { reachable: Boolean(workers !== null || openTasks !== null),
      migrations: migrations?.c ?? null, lastMigrationAt: migrations?.last ?? null },
    workers: { active: workers?.c ?? null, lastHeartbeatAt: lastHeartbeat?.h ?? null },
    runs: { queued: queued?.c ?? 0, active: active?.c ?? 0 },
    tasks: { open: openTasks?.c ?? null },
    ops: {
      lastDailySweepAt: lastSweep?.created_at ?? null,
      lastNightlyRegressionAt: lastNightly?.created_at ?? null,
    },
    lanhu: lanhu || { configured: null },
  }
}

// ─── 夜间全量回归报告（2026-09-26）───
export async function buildNightlyReport(conn, { repoSlug = 'demo-app', limit = 7 } = {}) {
  const tasks = await optionalRead(conn,
    `SELECT task_id, phase, created_at, updated_at FROM tasks
     WHERE repo=? AND task_id LIKE 'nightly-%' ORDER BY created_at DESC LIMIT ?`,
    [repoSlug, limit], true) || []
  const out = []
  for (const t of tasks) {
    const latest = await optionalRead(conn,
      `SELECT s.submission_id, s.status, s.created_at, g.run_group_id, g.status AS group_status
       FROM test_submissions s
       JOIN task_instances ti ON ti.task_instance_id=s.task_instance_id
       LEFT JOIN run_groups g ON g.submission_id=s.submission_id AND g.kind='formal'
       WHERE ti.external_task_id=? ORDER BY s.created_at DESC LIMIT 1`, [t.task_id])
    const runs = latest?.run_group_id
      ? await optionalRead(conn,
        `SELECT unit, side, status, terminal_reason FROM test_runs WHERE run_group_id=? ORDER BY unit, side`,
        [latest.run_group_id], true) || []
      : []
    out.push({
      taskId: t.task_id, phase: t.phase, createdAt: t.created_at, updatedAt: t.updated_at,
      submission: latest ? { id: latest.submission_id, status: latest.status, groupStatus: latest.group_status,
        runs: runs.map((r) => ({ unit: r.unit, side: r.side, status: r.status, terminalReason: r.terminal_reason })) } : null,
    })
  }
  return { version: 1, repoSlug, generatedAt: new Date().toISOString(), tasks: out }
}
