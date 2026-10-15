import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeData, statusMeta, getNodeInfo, modeLabel, escapeHtml, formatDateTime, formatDuration,
  executionStats, mutationStats, canRequeue, runLabel, attemptLabel } from '../public/assets/cloud-testing/model.js'
import { createTestingApi, fetchJson } from '../public/assets/cloud-testing/api.js'

const run = (extra = {}) => ({ runId: 'r1', unit: 'smoke', side: 'web', status: 'passed', attempts: [], checks: [], ...extra })
const sub = (extra = {}) => ({ submissionId: 's1', roundNo: 1, status: 'passed', requiredUnits: ['smoke:web'], runs: [run()], mutations: [], ...extra })
const summary = (extra = {}) => ({ version: 1, context: { repo: 'repo', taskId: 'task', epoch: 1, revision: 2 },
  latestSubmissionId: 's1', formalRoundCount: 1, execution: { state: 'passed', required: 1, passed: 1, failed: 0, active: 0, missing: [] },
  mutation: { killed: 0, weak: 0, exempt: 0, active: 0, inconclusive: 0, unknown: 0 },
  mode: { configured: 'observe', effective: 'observe', source: 'policy' }, assessment: { kind: 'observation', reasons: [], evidenceRefs: [] }, ...extra })

afterEach(() => vi.unstubAllGlobals())
describe('云端面板纯展示模型', () => {
  it('合并 flow 节点与原始 run，保留证据契约，不更改输入', () => {
    const source = { total: 1, submissions: [sub({ runs: [run({ reportAttempt: 2, totalMs: 2345, artifact: { artifactId: 'a2', attempt: 2 },
      attempts: [{ attempt: 1, status: 'error', errorDetail: '启动失败' }, { attempt: 2, status: 'passed', worker: 'w' }] })] })],
    flow: { version: 1, rounds: [{ submissionId: 's1', id: 'submission:s1', roundNo: 1, status: 'passed', steps: [
      { kind: 'execute', requiredUnits: ['smoke:web'], nodes: [{ runId: 'r1', state: 'passed', attempts: [{ attempt: 2, status: 'passed' }] }] },
      { kind: 'acceptance', state: 'unknown' },
    ] }] } }
    const before = JSON.stringify(source)
    const model = normalizeData(source)
    expect(JSON.stringify(source)).toBe(before)
    expect(model.rounds).toHaveLength(1)
    const node = model.rounds[0].runs[0]
    expect(node).toMatchObject({ unit: 'smoke', side: 'web', kind: 'run', state: 'passed', status: 'passed', reportAttempt: 2,
      artifact: { artifactId: 'a2', attempt: 2 }, totalMs: 2345 })
    expect(node.attempts).toHaveLength(2)
    expect(node.attempts[1]).toMatchObject({ worker: 'w', id: 'submission:s1:run:r1:attempt:2' })
    expect(attemptLabel(node)).toBe('尝试 2 次、重试 1 次')
    expect(model.rounds[0].steps.some((step) => step.kind === 'acceptance')).toBe(false)
    expect(model.total).toBe(1)
  })
  it.each(['failed', 'error', 'lost', 'timed_out'])('observe + DONE 不覆盖 %s', (state) => {
    const data = { task: { phase: 'DONE' }, summary: summary({ execution: { state, failed: 1, active: 0, required: 1, passed: 0, missing: [] } }) }
    expect(getNodeInfo(data).status).toBe('failed')
    expect(statusMeta(state).tone).toBe('danger')
    expect(normalizeData(data).summary.mode.effective).toBe('observe')
  })
  it('新摘要优先，不读旧 cloud-status node/round 或任务生命周期推断成功', () => {
    const data = { node: 'passed', round: 999, task: { phase: 'DONE' }, submissions: [sub()], summary: summary({ formalRoundCount: 12 }) }
    expect(normalizeData(data).total).toBe(12)
    expect(getNodeInfo(data).status).toBe('attention')
    expect(getNodeInfo({ node: 'passed', round: 999, task: { phase: 'DONE' } }).status).not.toBe('done')
    expect(normalizeData({ node: 'passed', round: 999 }).total).toBeNull()
  })
  it.each(['enforce_all', 'enforce_ml', 'enforce_s'])('%s 统一拦截文案，配置不能冒充有效模式', (mode) => {
    expect(modeLabel(mode)).toBe('拦截模式')
    const result = normalizeData({ gateMode: mode, submissions: [sub()] })
    expect(result.summary.mode).toMatchObject({ configured: mode, effective: null })
    expect(modeLabel(result.summary.mode.effective)).toBe('未知')
  })
  it('正式通过不等于允许推进，缺必需单元与未知均不涂绿', () => {
    const model = normalizeData({ submissions: [sub({ requiredUnits: ['smoke:web', 'static:na'] })] })
    expect(model.summary.execution).toMatchObject({ state: 'unknown', passed: 1, required: 2, missing: ['static:na'] })
    expect(statusMeta('unknown').tone).toBe('neutral')
    expect(statusMeta('future-status').tone).toBe('neutral')
    expect(statusMeta('passed', 'gateEffect').tone).not.toBe('success')
    expect(getNodeInfo({ submissions: [sub()] }).status).toBe('attention')
    expect(getNodeInfo({ summary: summary({ execution: { state: 'passed', passed: 1, missing: ['static:na'] } }) }).status).toBe('attention')
  })
  it('并行执行和失败分别计数，排队不是执行中的节点', () => {
    const model = normalizeData({ submissions: [sub({ requiredUnits: ['smoke:web', 'smoke:admin'],
      runs: [run({ status: 'failed' }), run({ runId: 'r2', side: 'admin', status: 'active' })] })] })
    expect(executionStats(model.rounds[0])).toMatchObject({ state: 'running', failed: 1, active: 1, running: 1, ended: 1 })
    expect(getNodeInfo(model.raw).status).toBe('failed')
    expect(getNodeInfo({ submissions: [sub({ runs: [run({ status: 'queued' })] })] }).status).toBe('pending')
    expect(getNodeInfo({ submissions: [sub({ runs: [run({ status: 'active' })] })] }).status).toBe('current')
  })
  it('三轴分开统计杀中、弱、豁免、活动、未考成和未知', () => {
    const states = ['passed', 'weak', 'exempt', 'running', 'error', 'unknown']
    const model = normalizeData({ summary: summary(), flow: { version: 1, rounds: [{ ...sub(), steps: [
      { kind: 'execute', nodes: [run({ state: 'passed' })], requiredUnits: ['smoke:web'] },
      { kind: 'mutation', nodes: states.map((state, i) => run({ runId: `m${i}`, state, status: state === 'passed' ? 'failed' : 'passed' })) },
    ] }] } })
    expect(mutationStats(model.rounds[0])).toEqual({ killed: 1, weak: 1, exempt: 1, active: 1, inconclusive: 1, unknown: 1 })
    expect(executionStats(model.rounds[0]).failed).toBe(0)
    expect(statusMeta('passed', 'mutation').label).toBe('已杀中变异')
    expect(statusMeta('weak', 'mutation').tone).toBe('warning')
    expect(statusMeta('exempt', 'mutation').tone).toBe('violet')
    expect(statusMeta('error', 'mutation').tone).toBe('danger')
  })
  it.each([['running', 'current'], ['queued', 'pending']])('变异节点 %s 只在有可靠活动状态时映射 %s', (state, expected) => {
    const source = { summary: summary({ mutation: { active: 1 } }), flow: { version: 1, rounds: [{ ...sub(), steps: [
      { kind: 'execute', requiredUnits: ['smoke:web'], nodes: [run({ state: 'passed' })] },
      { kind: 'mutation', nodes: [run({ runId: 'm1', state, status: state === 'running' ? 'active' : 'queued' })] },
    ] }] } }
    expect(getNodeInfo(source).status).toBe(expected)
    source.summary.mutation = { weak: 1, active: 1 }
    expect(getNodeInfo(source).status).toBe('attention')
  })
  it('汇总与本次冻结单元计数一致才补已结束数，且不修改原始摘要', () => {
    const original = { summary: summary(), submissions: [sub()] }
    expect(normalizeData(original).summary.execution.ended).toBe(1)
    expect(original.summary.execution).not.toHaveProperty('ended')
    original.summary.execution.required = 2
    expect(normalizeData(original).summary.execution.ended).toBeNull()
    expect(statusMeta('__proto__')).toEqual(statusMeta('unknown'))
  })
  it('无 flow 时 mutation 即便含旧检查项也只能 unknown，无记录不补杀中', () => {
    const model = normalizeData({ submissions: [sub({ mutations: [run({ status: 'failed', featureKey: 'x',
      checks: [{ caseKey: 'test:spec/x', status: 'failed' }] })] })] })
    expect(model.rounds[0].mutations[0].state).toBe('unknown')
    expect(model.summary.mutation).toMatchObject({ killed: 0, unknown: 1 })
    expect(normalizeData({ submissions: [sub()] }).summary.mutation.killed).toBe(0)
  })
  it('历史页不冒充当前摘要，当前验收不进入轮次证据', () => {
    const data = { page: { before: 's2' }, submissions: [sub()], flow: { version: 1, rounds: [sub()],
      currentAcceptance: { state: 'recorded', completed: true, coverage: { covered: ['AC-NOW'] } } } }
    const model = normalizeData(data)
    expect(model.summary.execution.state).toBe('unknown')
    expect(model.rounds[0]).not.toHaveProperty('currentAcceptance')
    expect(model.summary.assessment.kind).toBe('observation')
  })
  it.each(['skipped', 'canceled', 'exempt', 'unknown'])('%s 与执行通过不同', (state) => {
    const model = normalizeData({ submissions: [sub({ runs: [run({ status: state })] })] })
    expect(model.summary.execution.state).not.toBe('passed')
    expect(statusMeta(state).tone).not.toBe('success')
  })
  it('空的必需清单是不适用，不等于未知或执行通过', () => {
    const source = { submissions: [sub({ requiredUnits: [], runs: [] })] }
    expect(normalizeData(source).summary.execution).toMatchObject({ state: 'not_applicable', required: 0 })
    expect(getNodeInfo(source)).toMatchObject({ status: 'skipped', label: '云端测试不适用' })
    expect(statusMeta('not_applicable').tone).toBe('neutral')
    expect(statusMeta('idle').label).toContain('尚无')
    expect(normalizeData({ submissions: [sub({ requiredUnits: null, runs: [] })] }).summary.execution.state).toBe('unknown')
  })
  it.each(['null', 'unrecorded', 'conflicting-known'])('旧 flow 空清单不伪装不适用，原始来源为 %s', (source) => {
    const data = { flow: { version: 1, rounds: [{ submissionId: 's1',
      ...(source === 'conflicting-known' ? { requiredKnown: true } : {}),
      steps: [{ kind: 'execute', state: 'unknown', requiredUnits: [], nodes: [] }],
    }] } }
    if (source !== 'unrecorded') data.submissions = [sub({ requiredUnits: null, runs: [] })]
    const model = normalizeData(data)
    expect(model.rounds[0].requiredKnown).toBe(false)
    expect(model.summary.execution).toMatchObject({ state: 'unknown', required: null })
    expect(getNodeInfo(data).status).toBe('attention')
    data.submissions = [sub({ requiredUnits: [], runs: [] })]
    expect(normalizeData(data).summary.execution).toMatchObject({ state: 'not_applicable', required: 0 })
  })
  it('同必需单元的多个 run 不放大分母或通过数，可选单元不计正式统计', () => {
    const round = normalizeData({ submissions: [sub({ requiredUnits: ['smoke:web', 'smoke:web'], runs: [
      run(), run({ runId: 'duplicate' }), run({ runId: 'optional', unit: 'static', side: 'na', status: 'failed' }),
    ] })] }).rounds[0]
    expect(executionStats(round)).toMatchObject({ required: 1, passed: 1, failed: 0, ended: 1 })
    round.requiredUnits.push('smoke:admin')
    round.runs[0].state = round.runs[1].state = 'skipped'
    expect(executionStats(round)).toMatchObject({ state: 'unknown', missing: ['smoke:admin'] })
  })
  it('保留后端未量化的 unknown、范围说明和 completed 计数', () => {
    const source = { summary: summary({ execution: { state: 'idle', required: null, completed: 0 },
      mutation: { unknown: null, unrecorded: true, recorded: 0, scope: 'latest_submission' } }) }
    expect(normalizeData(source).summary.mutation).toMatchObject({ unknown: null, unrecorded: true, recorded: 0 })
    expect(normalizeData(source).summary.execution.ended).toBe(0)
    expect(getNodeInfo(source).status).toBe('pending')
  })
  it('新摘要明确给出的已结束数不被轮次补算覆盖', () => {
    const execution = { state: 'passed', required: 1, passed: 1, failed: 0, active: 0, missing: [], completed: 0 }
    const source = { summary: summary({ execution }), submissions: [sub()] }
    expect(normalizeData(source).summary.execution.ended).toBe(0)
    expect(source.summary.execution).not.toHaveProperty('ended')
  })
  it('同一必需单元存在活动和失败时，两种事实并存且尚未整体结束', () => {
    const model = normalizeData({ submissions: [sub({ runs: [run({ status: 'failed' }),
      run({ runId: 'r2', status: 'active' })] })] })
    expect(model.summary.execution).toMatchObject({ state: 'running', required: 1, failed: 1, active: 1, passed: 0, ended: 0 })
  })
  it('重推仅符合服务端条件的非变异基础设施错误', () => {
    expect(canRequeue({ kind: 'run', status: 'error', reason: 'infra_error' })).toBe(true)
    expect(canRequeue({ kind: 'run', status: 'error', reason: 'lost' })).toBe(true)
    for (const patch of [{ kind: 'mutation' }, { status: 'failed' }, { reason: 'assertion_failed' }, { requeueAllowed: false }]) {
      expect(canRequeue({ kind: 'run', status: 'error', reason: 'infra_error', ...patch })).toBe(false)
    }
  })
  it('统一中文时间且含时区、耗时与业务名，动态内容转义', () => {
    expect(formatDateTime('2026-09-25T10:00:00Z')).toMatch(/2026年.*月.*日.*GMT.*（.+）/)
    expect(formatDateTime('bad-date')).toBe('时间未记录')
    expect(formatDateTime(null)).toBe('时间未记录')
    expect(formatDuration(61200)).toBe('1 分 1 秒')
    expect(formatDuration(null)).toBe('耗时未记录')
    expect(runLabel(run())).toBe('端到端测试')
    expect(escapeHtml('<img x="a">&\'')).toBe('&lt;img x=&quot;a&quot;&gt;&amp;&#39;')
  })
})

describe('云端 API 适配契约', () => {
  it('使用原接口和 plain JSON，正确编码参数、传递取消信号', async () => {
    const request = vi.fn(async () => ({ ok: true }))
    const api = createTestingApi({ repo: '项目 空格', taskId: '任务/1', request })
    const signal = new AbortController().signal
    expect(await api.getPage({ before: 's&1', limit: 5, signal })).toEqual({ ok: true })
    let [url, options] = request.mock.calls[0]
    expect(url).toContain('/by-task/%E4%BB%BB%E5%8A%A1%2F1?')
    expect(new URL(url, 'https://local').searchParams.get('before')).toBe('s&1')
    expect(options.signal).toBe(signal)
    await api.getSummary({ signal })
    expect(request.mock.calls[1][0]).toContain('/cloud-status?')
    await api.getLogs('r/1', { artifactId: 'a&1', signal })
    await api.getLog('r/1', '目录/x.log', { artifactId: 'a&1', signal })
    expect(request.mock.calls[3][0]).toBe(api.logUrl('r/1', '目录/x.log', { artifactId: 'a&1' }))
    await api.getTimeline('r/1', { signal })
    await api.requeue('r/1', { signal })
    expect(request.mock.calls[5][1]).toMatchObject({ method: 'POST', signal })
    expect(request.mock.calls.slice(0, 5).every(([, opts]) => !opts.method)).toBe(true)
  })
  it('拒绝串仓、串任务、串游标和串证据包', async () => {
    const request = vi.fn()
    const api = createTestingApi({ repo: 'repo', taskId: 'task', request })
    request.mockResolvedValue({ summary: summary({ context: { repo: 'other', taskId: 'task' } }) })
    await expect(api.getPage()).rejects.toThrow('当前仓库或任务')
    request.mockResolvedValue({ page: { before: 'other' } })
    await expect(api.getPage({ before: 's1' })).rejects.toThrow('游标')
    request.mockResolvedValue({ runId: 'other' })
    await expect(api.getTimeline('r1')).rejects.toThrow('所选运行')
    request.mockResolvedValue({ artifactId: 'a2' })
    await expect(api.getLogs('r1', { artifactId: 'a1' })).rejects.toThrow('artifact')
  })
  it('默认请求保留看板错误兼容，并支持结构化错误', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    fetch.mockResolvedValue({ ok: true, json: async () => ({ error: '旧错误' }) })
    await expect(fetchJson('/unused')).rejects.toThrow('旧错误')
    fetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: { message: '无权查看', code: 'DENIED' } }) })
    await expect(fetchJson('/unused')).rejects.toMatchObject({ status: 403, code: 'DENIED', message: '无权查看' })
    fetch.mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => { throw new Error('not json') } })
    await expect(fetchJson('/unused')).rejects.toThrow('502 Bad Gateway')
  })
})
