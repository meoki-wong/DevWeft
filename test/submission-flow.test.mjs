import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { buildSubmissionFlow, compareSubmissionInputs, mutationVerdict, parseFlowJson, submissionReceipt } from '../testing/submission-flow.js'
import { readTaskTestingView as readView, readTaskGateSummaries, taskTestingKey, buildTaskTestingSummary, readRun } from '../dashboard/testing-read-model.js'

const spec = (featureKey, version = 1, blobSha256 = 'sha') => ({ featureKey, version, blobSha256, specType: 'e2e', side: 'web' })
const run = (patch = {}) => ({ runId: 'run-1', unit: 'smoke', side: 'web', status: 'passed', checks: [], attempts: [], ...patch })
const sub = (id, specs = [spec('a')], tree = 'tree-1') => ({
  submissionId: id, bindingId: `b-${id}`, roundNo: 1, status: 'passed', requiredUnits: ['smoke:web'],
  runs: [run({ runId: `run-${id}` })], mutations: [],
  evidence: { binding: { state: 'active', canonical_binding_json: JSON.stringify({ assetLock: { specs }, snapshotTreeOid: tree }) },
    snapshot: { snapshot_id: `snap-${id}`, snapshot_tree_oid: tree }, principal: { subject: 'alice' }, audit: [] },
})
const current = { task: { phase: 'EXECUTE' }, instance: { task_instance_id: 't1', active_binding_id: 'b-new' } }

describe('纯轮次投影', () => {
  it('不修改输入，正式轮通过不等于验收，预检无记录不变绿', () => {
    const s = sub('new')
    const input = { submissions: [s], current, total: 16 }
    const before = JSON.stringify(input)
    const flow = buildSubmissionFlow(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(flow.total).toBe(16)
    expect(flow.currentAcceptance.completed).toBe(false)
    expect(flow.rounds[0].steps.map((n) => n.kind)).toEqual(['prepare', 'execute', 'mutation', 'acceptance'])
    expect(flow.rounds[0].steps[0].state).toBe('recorded')
    expect(flow.rounds[0].steps[0].preflight.state).toBe('unknown')
    expect(flow.rounds[0].steps[1].state).toBe('passed')
    expect(flow.rounds[0].steps[2].state).toBe('unknown')
    expect(flow.rounds[0].steps[3].state).toBe('unknown')
  })
  it('同轮 attempt 和自动 mutation 不增加轮数，节点 ID 稳定', () => {
    const s = sub('new')
    s.runs[0].attempts = [{ attempt: 1, status: 'error', errorCode: 'VM_BOOT', errorDetail: '启动失败' }, { attempt: 2, status: 'passed' }]
    s.mutations = [run({ runId: 'm1', status: 'active', featureKey: 'a' })]
    const first = buildSubmissionFlow({ submissions: [s], current })
    const next = buildSubmissionFlow({ submissions: [sub('newer'), s], current })
    expect(first.rounds).toHaveLength(1)
    expect(first.rounds[0].steps[1].nodes[0].attempts).toHaveLength(2)
    expect(first.rounds[0].steps[1].nodes[0].errors[0]).toMatchObject({ code: 'VM_BOOT', detail: '启动失败' })
    expect(first.rounds[0].steps[2].state).toBe('running')
    expect(first.rounds[0].id).toBe(next.rounds[1].id)
    expect(first.rounds[0].steps[1].nodes[0].attempts[0].id).toBe(next.rounds[1].steps[1].nodes[0].attempts[0].id)
  })
  it('当前 binding 过期标历史，不把过去通过改成失败', () => {
    const s = sub('old')
    s.evidence.binding.state = 'stale'
    s.evidence.binding.stale_reason = 'SPEC_VERSION_CHANGED'
    const flow = buildSubmissionFlow({ submissions: [s], current: { ...current, binding: s.evidence.binding, coverage: { applicable: true, missing: ['AC-1'], mutationPending: true } } })
    expect(flow.rounds[0].historical).toBe(true)
    expect(flow.rounds[0].status).toBe('passed')
    expect(flow.rounds[0].steps[1].state).toBe('passed')
    expect(flow.currentAcceptance.blockers[0].detail).toBe('SPEC_VERSION_CHANGED')
    expect(flow.currentAcceptance.state).toBe('blocked')
  })
  it.each(['VERIFY', 'DISTILL', 'EXECUTE'])('%s 不冒充任务验收完成', (phase) => {
    expect(buildSubmissionFlow({ current: { task: { phase } } }).currentAcceptance.completed).toBe(false)
  })
  it('任务完成记录不倒灌历史节点，也不是新验收成功', () => {
    const flow = buildSubmissionFlow({ submissions: [sub('old')], current: { task: { phase: 'DONE' } } })
    expect(flow.currentAcceptance).toMatchObject({ completed: true, state: 'recorded' })
    expect(flow.rounds[0].steps[3].state).toBe('unknown')
  })
  it('只有一项已绿但必需单元缺失时不聚合为通过', () => {
    const s = sub('new'); s.requiredUnits.push('static:na')
    const step = buildSubmissionFlow({ submissions: [s] }).rounds[0].steps[1]
    expect(step.state).toBe('unknown')
    expect(step.missingUnits).toEqual(['static:na'])
  })
  it('并行失败与运行中同时保留，不强制画线性成功', () => {
    const s = sub('new'); s.runs.push(run({ runId: 'r2', status: 'active' }))
    s.runs[0].status = 'failed'
    const step = buildSubmissionFlow({ submissions: [s] }).rounds[0].steps[1]
    expect(step.state).toBe('running')
    expect(step.nodes.map((n) => n.state)).toEqual(['failed', 'running'])
  })
  it('历史缺失、坏 JSON、空清单不等价，且不推断触发原因', () => {
    const s = sub('new'); delete s.evidence
    const round = buildSubmissionFlow({ submissions: [s] }).rounds[0]
    expect(round.actor.source).toBe('unrecorded')
    expect(round.trigger.source).toBe('unrecorded')
    expect(round.steps[0].state).toBe('unknown')
    expect(compareSubmissionInputs(s, sub('next')).specs.source).toBe('unrecorded')
    expect(parseFlowJson('{bad', {})).toEqual({})
  })
  it('通过快照 tree 与冻结考卷推导新增、更新、移除，明确为推断', () => {
    const a = sub('old', [spec('keep'), spec('update'), spec('remove')])
    const b = sub('new', [spec('keep'), spec('update', 2, 'new-sha'), spec('add')])
    const diff = compareSubmissionInputs(a, b)
    expect(diff.businessTree).toEqual({ value: 'unchanged', source: 'inferred' })
    expect(diff.specs.source).toBe('inferred')
    expect(diff.specs.added.map((s) => s.featureKey)).toEqual(['add'])
    expect(diff.specs.updated.map((s) => s.featureKey)).toEqual(['update'])
    expect(diff.specs.removed.map((s) => s.featureKey)).toEqual(['remove'])
    expect(compareSubmissionInputs(a, sub('changed', [], 'tree-2')).businessTree.value).toBe('changed')
    expect(compareSubmissionInputs(sub('a', []), sub('b', [])).specs.source).toBe('inferred')
  })
  it('receipt 只使用精确关联审计，不接受别轮回执', () => {
    const s = sub('new')
    s.evidence.audit = [{ id: 1, submission_id: 'new', payload_json: JSON.stringify({ receipt: { submissionId: 'other', reason: '错误关联' } }) }]
    expect(submissionReceipt(s)).toBeNull()
    s.evidence.audit.push({ id: 2, submission_id: 'new', payload_json: JSON.stringify({ submissionReceipt: { submissionId: 'new', actor: { subject: 'bob' }, trigger: { reason: '修复后重新提交' }, preflight: { status: 'failed', detail: 'PREFLIGHT_FAIL' } } }) })
    const round = buildSubmissionFlow({ submissions: [s] }).rounds[0]
    expect(round.actor).toEqual({ value: 'bob', source: 'receipt' })
    expect(round.trigger.value).toBe('修复后重新提交')
    expect(round.receiptAuditId).toBe(2)
    expect(round.steps[0].preflight.state).toBe('failed')
  })
})

describe('变异验卷不是看 run 颜色反推', () => {
  it('构建失败没有考卷结论，不能当杀中', () => {
    expect(mutationVerdict(run({ status: 'failed', featureKey: 'a', checks: [{ caseKey: 'build', status: 'failed' }] }))).toMatchObject({ state: 'error' })
  })
  it('只有对应考卷失败才杀中；正常通过说明未杀中（weak，非红色失败）', () => {
    expect(mutationVerdict(run({ status: 'failed', featureKey: 'a', checks: [{ caseKey: 'test:spec/a', status: 'failed' }] })).state).toBe('passed')
    const weak = mutationVerdict(run({ featureKey: 'a', checks: [{ caseKey: 'test:spec/a', status: 'passed' }] }))
    expect(weak.state).toBe('weak')
    expect(weak.label).toContain('非执行失败')
  })
  it('跳过/等价豁免不涂绿，F2P 必须与本 run 精确关联', () => {
    const r = run({ featureKey: 'a', checks: [{ caseKey: 'test:spec/a', status: 'passed', mutation: { mode: 'skipped', reason: '无算子' } }] })
    expect(mutationVerdict(r).state).toBe('exempt')
    r.checks[0].mutation = null
    r.f2p = { run_id: 'other', detail: 'mutation survived-cap-exempt' }
    expect(mutationVerdict(r).state).toBe('weak')
    r.f2p.run_id = r.runId
    expect(mutationVerdict(r).state).toBe('exempt')
  })
  it('未杀中(weak)整步聚合为 weak（amber），不误报红色失败、也不掉到 unknown', () => {
    const s = sub('new')
    s.mutations = [run({ runId: 'm1', featureKey: 'a', status: 'passed', checks: [{ caseKey: 'test:spec/a', status: 'passed' }] })]
    const step = buildSubmissionFlow({ submissions: [s], current }).rounds[0].steps[2]
    expect(step.state).toBe('weak')
    expect(step.nodes[0].state).toBe('weak')
  })
})

// 正常导入无副作用模型；所有读者与时钟注入，query_only 阻止隐式写操作。
const readers = { getTaskAcceptance: async () => [], evaluateAcCoverage: async () => ({ applicable: false }),
  describeMutationVerification: async () => null, getRepoGateMode: async () => 'observe', now: () => '2026-09-25T00:00:00.000Z' }
async function memoryDb() {
  const db = new Database(':memory:')
  await db.exec(`CREATE TABLE repositories(repo_id TEXT, slug TEXT);
    CREATE TABLE task_instances(task_instance_id TEXT, repo_id TEXT, external_task_id TEXT, epoch INTEGER, active_binding_id TEXT, phase TEXT, size TEXT, type TEXT, revision INTEGER DEFAULT 1);
    CREATE TABLE repo_gate_modes(repo_id TEXT, mode TEXT);
    CREATE TABLE tasks(repo TEXT, task_id TEXT, phase TEXT, meta TEXT);
    CREATE TABLE artifacts(artifact_id TEXT, run_id TEXT, attempt INTEGER, size INTEGER, artifact_truncated INTEGER, scan_state TEXT, archive_sha256 TEXT, expire_at TEXT, deleted_at TEXT, created_at TEXT);
    CREATE TABLE workers(worker_id TEXT, hostname TEXT);
    CREATE TABLE run_attempts(run_id TEXT, attempt INTEGER, status TEXT, started_at TEXT, finished_at TEXT, heartbeat_at TEXT, error_code TEXT, error_detail TEXT, image_id TEXT, worker_id TEXT);
    CREATE TABLE test_submissions(submission_id TEXT, binding_id TEXT, task_instance_id TEXT, principal_id TEXT, status TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, expected_task_revision INTEGER);
    CREATE TABLE run_groups(run_group_id TEXT, submission_id TEXT, kind TEXT, gate_eligible INTEGER, required_units_json TEXT);
    CREATE TABLE test_runs(run_id TEXT, run_group_id TEXT, purpose TEXT, unit TEXT, side TEXT, status TEXT, created_at TEXT);
    INSERT INTO repositories VALUES ('r1','repo1'), ('r2','repo2');
    INSERT INTO task_instances VALUES ('t1','r1','task',1,'b1','EXECUTE','M','feature',1), ('t2','r1','task',2,'b7','EXECUTE','M','feature',7), ('foreign','r2','task',9,'x','EXECUTE','S','fix',2);
    INSERT INTO repo_gate_modes VALUES ('r1','observe'), ('r2','enforce_all');`)
  const insert = db.prepare('INSERT INTO test_submissions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1)')
  for (let n = 1; n <= 7; n++) await insert.run(`s${n}`, `b${n}`, n <= 3 ? 't1' : 't2', 'p', 'passed', '2026-01-01')
  await insert.run('foreign-sub', 'x', 'foreign', 'p', 'passed', '2026-01-02')
  for (const { submission_id: id } of await db.prepare('SELECT submission_id FROM test_submissions').all()) {
    await db.prepare('INSERT INTO run_groups VALUES (?, ?, ?, 1, ?)').run(`g-${id}`, id, 'formal', '["smoke:web"]')
  }
  await db.exec("INSERT INTO run_groups VALUES ('m7','s7','candidate',0,'[]'); INSERT INTO test_runs VALUES ('m','m7','mutation','smoke','web','active','2026-01-01');")
  db.pragma('query_only = ON')
  return db
}

describe('统一摘要与轻量批量读取', () => {
  it.each(['observe', 'enforce_s', 'enforce_ml', 'enforce_all', 'disabled', 'legacy'])('%s 只表达事实，不推可推进；静态与有效模式分离', (mode) => {
    const latest = sub('s')
    latest.runs[0].status = 'failed'
    const summary = buildTaskTestingSummary({ taskId: 'task', instance: { task_instance_id: 't', phase: 'DONE' }, latest,
      configured: mode, policy: { effectiveMode: 'enforce_all' } })
    expect(summary.execution).toMatchObject({ state: 'failed', required: 1, passed: 0, failed: 1, completed: 1 })
    expect(summary.mode).toEqual({ configured: mode, effective: 'enforce_all', source: 'preview' })
    expect(summary.assessment).toMatchObject({ kind: 'observation', targetTransition: null })
    expect(JSON.stringify(summary)).not.toContain('canAdvance')
    expect(summary.mutation).toMatchObject({ killed: 0, unknown: null, recorded: 0, unrecorded: true })
  })
  it('并行失败保留计数，缺失必需项独立；可选单元与重复尝试不充当分母', () => {
    const latest = sub('s')
    latest.requiredUnits.push('static:na', 'smoke:admin')
    latest.runs = [run({ status: 'failed', attempts: [{ attempt: 1 }, { attempt: 2 }] }),
      run({ unit: 'static', side: 'na', status: 'active' }), run({ unit: 'optional', status: 'passed' })]
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'running', required: 3,
      passed: 0, failed: 1, active: 1, completed: 1, missing: ['smoke:admin'], recorded: 3 })
    latest.requiredUnits = []
    expect(buildTaskTestingSummary({ latest }).execution.state).toBe('not_applicable')
    latest.requiredUnits = null
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'unknown', required: null })
    latest.requiredUnits = ['smoke:web', null]; latest.runs = [run()]
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'unknown', required: null })
  })
  it('结束、取消与通过分别计数，全部跳过不等于通过', () => {
    const latest = sub('s')
    latest.runs[0].status = 'skipped'
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'unknown', completed: 1, passed: 0, canceled: 0 })
    latest.runs[0].status = 'canceled'
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'canceled', completed: 1, passed: 0, canceled: 1 })
    latest.runs[0].status = 'queued'
    expect(buildTaskTestingSummary({ latest }).execution).toMatchObject({ state: 'queued', active: 1, queued: 1, running: 0, completed: 0 })
  })
  it('本轮 mutation 按考卷判卷，基础设施失败不因旧 checks 变绿', () => {
    const latest = sub('s')
    const check = (status) => [{ caseKey: 'test:spec/a', status }]
    latest.mutations = [run({ featureKey: 'a', status: 'failed', checks: check('failed') }),
      run({ featureKey: 'a', checks: check('passed') }),
      run({ featureKey: 'a', checks: [{ ...check('passed')[0], mutation: { mode: 'skipped' } }] }),
      run({ status: 'active' }), run({ status: 'error', featureKey: 'a', checks: check('failed') }), run()]
    expect(buildTaskTestingSummary({ latest }).mutation).toMatchObject({ killed: 1, weak: 1, exempt: 1, active: 1, inconclusive: 1, unknown: 1, recorded: 6 })
    expect(buildTaskTestingSummary({ latest: sub('no-record') }).mutation.killed).toBe(0)
    expect(buildTaskTestingSummary({ latest: { ...latest, mutations: [latest.mutations[0]] }, lightweight: true }).mutation)
      .toMatchObject({ killed: 0, inconclusive: 0, unknown: 1 })
  })
  it('可信只读预览可注入；失败或策略错误不回退静态有效模式', async () => {
    const db = await memoryDb()
    try {
      const calls = []
      const deps = { ...readers, previewGatePolicy: async (conn, args) => { calls.push(args); expect(conn).toBe(db); return { effectiveMode: 'enforce_all' } } }
      expect((await readView(db, { repo: 'repo1', taskId: 'task' }, deps)).summary.mode.effective).toBe('enforce_all')
      expect(calls[0]).toMatchObject({ repoSlug: 'repo1', taskId: 'task', size: 'M' })
      deps.previewGatePolicy = () => { throw new Error('不可用') }
      expect((await readView(db, { repo: 'repo1', taskId: 'task' }, deps)).summary.mode.effective).toBeNull()
      deps.previewGatePolicy = () => ({ effectiveMode: 'enforce_all', error: 'POLICY_EVAL_FAILED' })
      expect((await readView(db, { repo: 'repo1', taskId: 'task' }, deps)).summary.mode.effective).toBeNull()
    } finally { db.close() }
  })
  it('新 epoch 无正式轮不借旧轮；candidate-only 不计正式轮', async () => {
    const db = await memoryDb()
    try {
      db.pragma('query_only = OFF')
      await db.exec(`INSERT INTO task_instances VALUES ('t3','r1','task',3,'b9','EXECUTE','M','feature',9);
        INSERT INTO test_submissions VALUES ('candidate','b9','t3','p','passed','2026-02-01',NULL,NULL,9);
        INSERT INTO run_groups VALUES ('candidate-group','candidate','candidate',0,'[]');`)
      db.pragma('query_only = ON')
      const view = await readView(db, { repo: 'repo1', taskId: 'task' }, readers)
      expect(view.total).toBe(7)
      expect(view.summary).toMatchObject({ latestSubmissionId: null, formalRoundCount: 7, context: { epoch: 3 }, execution: { state: 'idle' } })
    } finally { db.close() }
  })
  it('未配置时详细和轻量模式均默认 legacy，缺表时返回 unavailable', async () => {
    const db = await memoryDb()
    try {
      db.pragma('query_only = OFF')
      await db.exec('DELETE FROM repo_gate_modes')
      db.pragma('query_only = ON')
      expect((await readView(db, { repo: 'repo1', taskId: 'task' })).summary.mode).toEqual({ configured: 'legacy', effective: null, source: null })
      expect((await readTaskGateSummaries(db, [{ repo: 'repo1', task_id: 'task' }])).get(taskTestingKey('repo1', 'task')).summary.mode.configured).toBe('legacy')
      db.pragma('query_only = OFF')
      await db.exec('DROP TABLE run_groups')
      db.pragma('query_only = ON')
      expect((await readTaskGateSummaries(db, [{ repo: 'repo1', task_id: 'task' }])).get(taskTestingKey('repo1', 'task')).summary.assessment.kind).toBe('unavailable')
    } finally { db.close() }
  })
  it('批量仅查询返回任务，跨仓同名不覆盖；与详细摘要使用同一执行语义', async () => {
    const db = await memoryDb()
    try {
      const queries = []
      const conn = { prepare: (sql) => { queries.push(sql); return db.prepare(sql) } }
      const batch = await readTaskGateSummaries(conn, [{ repo: 'repo1', task_id: 'task' }, { repo: 'repo2', task_id: 'task' }, { repo: 'repo1', task_id: 'absent' }], { observedAt: readers.now() })
      expect(queries).toHaveLength(2)
      expect(queries.join('\n')).not.toMatch(/report_json|spec_f2p|LIMIT 400/)
      const a = batch.get(taskTestingKey('repo1', 'task'))
      const b = batch.get(taskTestingKey('repo2', 'task'))
      expect(a.summary.latestSubmissionId).toBe('s7')
      expect(b.summary).toMatchObject({ latestSubmissionId: 'foreign-sub', context: { repo: 'repo2', epoch: 9 }, mode: { configured: 'enforce_all', effective: null } })
      expect(a.summary.execution).toEqual((await readView(db, { repo: 'repo1', taskId: 'task' }, readers)).summary.execution)
      expect(a.legacy).toEqual({ status: 'passed', passed: 0, total: 0, at: '2026-01-01' })
      expect(batch.get(taskTestingKey('repo1', 'absent')).summary.assessment.kind).toBe('unavailable')
      expect(await readTaskGateSummaries(conn, [])).toEqual(new Map())
    } finally { db.close() }
  })
  it('超过400条其他记录也不截断返回任务，轻量模式不读取 F2P', async () => {
    const db = await memoryDb()
    try {
      db.pragma('query_only = OFF')
      for (let i = 0; i < 410; i++) {
        await db.prepare('INSERT INTO test_submissions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1)').run(`other-${i}`, 'x', 'foreign', 'p', 'passed', '2026-03-01')
        await db.prepare('INSERT INTO run_groups VALUES (?, ?, ?, 1, ?)').run(`other-g-${i}`, `other-${i}`, 'formal', '[]')
      }
      await db.exec("INSERT INTO test_runs VALUES ('m-done','m7','mutation','smoke','web','passed','2026-01-01');")
      db.pragma('query_only = ON')
      const summary = (await readTaskGateSummaries(db, [{ repo: 'repo1', task_id: 'task' }])).get(taskTestingKey('repo1', 'task')).summary
      expect(summary.formalRoundCount).toBe(7)
      expect(summary.mutation).toMatchObject({ active: 1, killed: 0, unknown: 1, recorded: 2, detailAvailable: false })
    } finally { db.close() }
  })
  it('run 与 flow 节点保留 raw unit/side/artifact/reportAttempt，旧报告不冒充最新尝试', async () => {
    const db = await memoryDb()
    try {
      db.pragma('query_only = OFF')
      await db.exec(`INSERT INTO artifacts VALUES ('a2','r',2,10,0,'passed','sha','2099-01-01',NULL,'2026-01-01');
        INSERT INTO run_attempts(run_id,attempt,status) VALUES ('r',1,'failed'),('r',2,'passed');`)
      db.pragma('query_only = ON')
      const raw = { run_id: 'r', unit: 'smoke', side: 'web', status: 'passed', report_json: JSON.stringify({ attempt: 1, checks: [{ caseKey: 'x', status: 'failed' }] }) }
      const r = await readRun(db, raw)
      expect(r).toMatchObject({ reportAttempt: 1, artifact: { artifactId: 'a2', attempt: 2 } })
      const s = sub('s'); s.runs = [r]
      const node = buildSubmissionFlow({ submissions: [s] }).rounds[0].steps[1].nodes[0]
      expect(node).toMatchObject({ unit: 'smoke', side: 'web', status: 'passed', reportAttempt: 1, artifact: { artifactId: 'a2', attempt: 2 } })
      expect(node.attempts).toHaveLength(2)
      expect((await readRun(db, { ...raw, report_json: '{}' })).reportAttempt).toBeNull()
    } finally { db.close() }
  })
})

describe('只读 by-task reader / 内存 SQLite', () => {
  it('真实 total 跨 epoch，默认有界 5 条，candidate 不计新轮', async () => {
    const db = await memoryDb()
    try {
      const first = await readView(db, { taskId: 'task', repo: 'repo1' }, readers)
      expect(first.total).toBe(7)
      expect(first.submissions.map((s) => s.roundNo)).toEqual([7, 6, 5, 4, 3])
      expect(first.flow.rounds).toHaveLength(5)
      expect(first.submissions[0].mutations).toHaveLength(1)
      expect(first.page).toMatchObject({ limit: 5, hasMore: true, nextCursor: 's3' })
      const older = await readView(db, { taskId: 'task', repo: 'repo1', before: first.page.nextCursor }, readers)
      expect(older.submissions.map((s) => s.roundNo)).toEqual([2, 1])
      expect(older.page.hasMore).toBe(false)
      expect(older.flow.currentAcceptance.activeBindingId).toBe('b7')
      expect(first.summary).toMatchObject({ version: 1, latestSubmissionId: 's7', formalRoundCount: 7,
        context: { repo: 'repo1', taskId: 'task', taskInstanceId: 't2', epoch: 2, revision: 7 },
        execution: { required: 1, missing: ['smoke:web'] }, mutation: { active: 1, recorded: 1 } })
      expect(older.summary).toEqual(first.summary)
      expect(first).toHaveProperty('acCoverage')
      expect(first).toHaveProperty('mutationDetail')
      expect(first.submissions[0]).not.toHaveProperty('evidence')
    } finally { db.close() }
  })
  it('新增提交不会让下一页重复；同时间戳顺序稳定', async () => {
    const db = await memoryDb()
    try {
      const first = await readView(db, { taskId: 'task', repo: 'repo1' }, readers)
      db.pragma('query_only = OFF')
      await db.prepare('INSERT INTO test_submissions VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 1)').run('s8', 'b8', 't2', 'p', 'queued', '2026-01-03')
      await db.prepare('INSERT INTO run_groups VALUES (?, ?, ?, 1, ?)').run('g-s8', 's8', 'formal', '["smoke:web"]')
      db.pragma('query_only = ON')
      const older = await readView(db, { taskId: 'task', repo: 'repo1', before: first.page.nextCursor }, readers)
      expect(older.total).toBe(8)
      expect(older.summary.latestSubmissionId).toBe('s8')
      expect(older.submissions.map((s) => s.submissionId)).toEqual(['s2', 's1'])
    } finally { db.close() }
  })
  it('限制页大小、拒绝跨租户游标、未关联任务兼容', async () => {
    const db = await memoryDb()
    try {
      expect((await readView(db, { taskId: 'task', repo: 'repo1', limit: 999 }, readers)).page.limit).toBe(20)
      await expect(readView(db, { taskId: 'task', repo: 'repo1', before: 'foreign-sub' }, readers)).rejects.toThrow('不属于该任务')
      expect(await readView(db, { taskId: 'absent', repo: 'repo1' }, readers)).toMatchObject({ linked: false, total: 0, submissions: [] })
      expect(db.pragma('query_only', { simple: true })).toBe(1)
    } finally { db.close() }
  })
})
