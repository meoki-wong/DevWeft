// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCloudTestingStore, compareObservation } from '../public/assets/cloud-testing/store.js'
import { mountCloudTesting, getNodeInfo } from '../public/assets/cloud-testing/index.js'

// 证据窗口由另一模块独立测试；本文件锁定传入的轮次、运行和尝试契约。
const evidence = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), dispose: vi.fn() }))
const createEvidence = vi.hoisted(() => vi.fn(() => evidence))
vi.mock('../public/assets/cloud-testing/evidence-dialog.js', () => ({ createEvidenceDialog: createEvidence }))
const disposables = []
const stamp = '2026-09-25T10:00:00Z'
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const makeRound = (n, status = 'passed', extra = {}) => ({ submissionId: `s${n}`, roundNo: n, epoch: n > 3 ? 2 : 1,
  bindingId: `b${n}`, status, createdAt: stamp, requiredUnits: ['smoke:web'], runs: [{ runId: `r${n}`, unit: 'smoke', side: 'web', status,
    startedAt: stamp, finishedAt: '2026-09-25T10:00:05Z', totalMs: 5000, attempts: [{ attempt: 1, status }], checks: [] }], mutations: [], ...extra })
function data(numbers = [2, 1], extra = {}) {
  const submissions = extra.submissions || numbers.map((n) => makeRound(n))
  const latest = extra.latest ?? numbers[0]
  return { linked: true, total: latest || 0, task: { phase: 'EXECUTE' },
    page: { before: extra.before || null, limit: 5, hasMore: numbers.at(-1) > 1, nextCursor: numbers.at(-1) > 1 ? `s${numbers.at(-1)}` : null },
    submissions, summary: { version: 1, context: { repo: 'repo', taskId: 'task', taskInstanceId: 'ti', epoch: 2, revision: 1 },
      latestSubmissionId: latest ? `s${latest}` : null, formalRoundCount: latest || 0,
      execution: { state: 'passed', required: 1, passed: 1, failed: 0, active: 0, missing: [] },
      mutation: { killed: 0, weak: 0, exempt: 0, active: 0, inconclusive: 0, unknown: 0 },
      mode: { configured: 'observe', effective: 'enforce_s', source: 'policy preview' },
      assessment: { kind: 'observation', targetTransition: 'VERIFY', reasons: [], evidenceRefs: [], observedAt: stamp }, observedAt: extra.observedAt || stamp,
      ...extra.summary }, ...extra }
}
function mount(options = {}) {
  const root = document.createElement('div')
  root.className = 'gate-card'
  root.id = 'stable-gate'
  document.body.append(root)
  const api = options.api || vi.fn(async () => data())
  const controller = mountCloudTesting(root, { repo: 'repo', taskId: 'task', api, initialData: data(), ...options })
  disposables.push(controller)
  return { root, controller, api }
}
function store(options = {}) {
  const api = options.api || { getPage: vi.fn(async () => data()) }
  const instance = createCloudTestingStore({ repo: 'repo', taskId: 'task', api, initialData: data(), ...options })
  disposables.push(instance)
  return instance
}
const click = (root, action) => {
  const button = root.querySelector(`button[data-action="${action}"]`)
  expect(button, `缺少按钮 ${action}`).toBeTruthy()
  button.click()
  return button
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(stamp))
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  vi.clearAllMocks()
})
afterEach(() => {
  for (const item of disposables.splice(0)) item.dispose()
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('分页与共享快照状态', () => {
  it('逆序分页只应用最新代次，stale 不回滚 cursor/trail/错误', async () => {
    const a = deferred(), b = deferred()
    const api = { getPage: vi.fn(({ before }) => before === 's5' ? a.promise : b.promise) }
    const instance = store({ api, initialData: data([7, 6, 5]) })
    const first = instance.loadPage({ before: 's5' })
    await tick()
    const second = instance.loadPage({ before: 's3' })
    await tick()
    b.resolve(data([2, 1], { before: 's3', latest: 7 }))
    expect((await second).status).toBe('applied')
    const current = instance.getSnapshot()
    expect(current.page.before).toBe('s3')
    expect(current.selectedId).toBe('s2')
    a.resolve(data([4, 3], { before: 's5', latest: 7 }))
    expect((await first).status).toBe('stale')
    expect(instance.getSnapshot()).toMatchObject({ page: current.page, trail: current.trail, selectedId: 's2', pageError: null })
    expect(api.getPage.mock.calls[0][0].signal.aborted).toBe(true)
  })
  it('逆序失败不能覆盖新页；真正失败保留原有导航和正文', async () => {
    const a = deferred(), b = deferred()
    const instance = store({ api: { getPage: vi.fn(({ before }) => before === 's5' ? a.promise : b.promise) } })
    const old = instance.loadPage({ before: 's5' })
    await tick()
    const next = instance.loadPage({ before: 's3' })
    b.resolve(data([2, 1], { before: 's3', latest: 7 }))
    await next
    a.reject(new Error('旧失败'))
    expect((await old).status).toBe('stale')
    expect(instance.getSnapshot().pageError).toBeNull()
    const failing = store({ api: { getPage: vi.fn(async () => { throw new Error('断网') }) } })
    const before = failing.getSnapshot()
    expect((await failing.loadPage({ before: 's1' })).status).toBe('failed')
    expect(failing.getSnapshot()).toMatchObject({ selectedId: before.selectedId, page: before.page, trail: before.trail, pageError: '断网' })
  })
  it('同游标分页与同任务刷新去重，手动刷新返回 applied', async () => {
    const pending = deferred()
    const api = { getPage: vi.fn(() => pending.promise) }
    const instance = store({ api })
    const first = instance.refresh({ force: true })
    const second = instance.refresh({ force: true })
    expect(second).toBe(first)
    await tick()
    expect(api.getPage).toHaveBeenCalledTimes(1)
    pending.resolve(data())
    expect((await first).status).toBe('applied')
    api.getPage.mockResolvedValue(data([1], { before: 's2' }))
    const pageA = instance.loadPage({ before: 's2' })
    const pageB = instance.loadPage({ before: 's2' })
    expect(pageA).toBe(pageB)
    expect((await pageA).status).toBe('applied')
  })
  it.each([true, false])('返回最新与轮询同拍共享单一首页请求，导航优先发起=%s', async (pageFirst) => {
    const pending = deferred()
    const onData = vi.fn()
    const api = { getPage: vi.fn(() => pending.promise) }
    const instance = store({ api, onData })
    const page = () => instance.loadPage({ before: null })
    const refresh = () => instance.refresh({ force: true })
    const first = pageFirst ? page() : refresh()
    const second = pageFirst ? refresh() : page()
    await tick()
    expect(api.getPage).toHaveBeenCalledTimes(1)
    pending.resolve(data([3, 2]))
    expect((await first).status).toBe('applied')
    expect((await second).status).toBe('applied')
    expect(instance.getSnapshot().selectedId).toBe('s3')
    expect(onData).toHaveBeenCalledTimes(2)
  })
  it('外部同时间快照使旧首页导航失效，不回滚轮次和导航', async () => {
    const pending = deferred()
    const api = { getPage: vi.fn(() => pending.promise) }
    const instance = store({ api })
    instance.selectRound('s1')
    const request = instance.loadPage({ before: null })
    await tick()
    expect(instance.update(data([3, 2])).status).toBe('applied')
    expect(api.getPage.mock.calls[0][0].signal.aborted).toBe(true)
    pending.resolve(data([2, 1]))
    expect((await request).status).toBe('stale')
    expect(instance.getSnapshot()).toMatchObject({ latestId: 's3', selectedId: 's1', navIds: ['s3', 's2'], pageLoading: false })
  })
  it('请求尚未发出即隐藏时，不再调用网络适配层', async () => {
    const api = { getPage: vi.fn(async () => data()) }
    const instance = store({ api })
    const request = instance.refresh({ force: true })
    instance.setVisible(false)
    expect((await request).status).toBe('stale')
    expect(api.getPage).not.toHaveBeenCalled()
  })
  it('旧后端历史页不会覆盖首页执行事实，也不会覆盖共享给宿主的快照', async () => {
    const current = { total: 5, gateMode: 'observe', submissions: [makeRound(5, 'failed')] }
    const history = { total: 5, page: { before: 's5' }, submissions: [makeRound(4)] }
    const onData = vi.fn()
    const instance = store({ initialData: current, onData, api: { getPage: vi.fn(async () => history) } })
    await instance.loadPage({ before: 's5' })
    expect(instance.getSnapshot()).toMatchObject({ selectedId: 's4', summary: { execution: { state: 'failed' } }, data: current })
    expect(onData).toHaveBeenCalledTimes(1)
  })
  it('历史页与当前摘要独立，旧历史摘要不能覆盖较新当前摘要', async () => {
    const historic = deferred()
    const instance = store({ api: { getPage: vi.fn(() => historic.promise) }, initialData: data([7, 6], { observedAt: '2026-09-25T10:10:00Z' }) })
    const request = instance.loadPage({ before: 's6' })
    historic.resolve(data([5, 4], { before: 's6', latest: 6, observedAt: stamp }))
    expect((await request).status).toBe('applied')
    expect(instance.getSnapshot()).toMatchObject({ selectedId: 's5', latestId: 's7', total: 7, observedAt: '2026-09-25T10:10:00Z' })
  })
  it('当前摘要用上下文版本优先，不以较新的时间覆盖旧 revision', () => {
    expect(compareObservation({ version: 1, context: { epoch: 2, revision: 2 }, observedAt: '2026-09-25T12:00:00Z' },
      { version: 1, context: { epoch: 2, revision: 3 }, observedAt: stamp })).toBe(-1)
    const instance = store({ initialData: data([3], { observedAt: '2026-09-25T12:00:00Z' }) })
    expect(instance.update(data([2], { observedAt: stamp })).status).toBe('stale')
    expect(instance.getSnapshot().latestId).toBe('s3')
  })
  it('外部快照会使之前的首页请求失效；串仓数据也不应用', async () => {
    const pending = deferred()
    const instance = store({ api: { getPage: vi.fn(() => pending.promise) } })
    const request = instance.refresh({ force: true })
    instance.update(data([3, 2]))
    pending.resolve(data([2, 1]))
    expect((await request).status).toBe('stale')
    expect(instance.getSnapshot().latestId).toBe('s3')
    expect(instance.update(data([8], { summary: { version: 1, context: { repo: 'other', taskId: 'task' } } })).status).toBe('failed')
    expect(instance.getSnapshot().latestId).toBe('s3')
  })
})

describe('面板布局与阅读稳定性', () => {
  it('遵循公开控制器契约，不替换宿主 root，initialData 避免重复首抓', async () => {
    const onData = vi.fn()
    const initialData = data()
    const { root, controller, api } = mount({ initialData, onData })
    await tick()
    expect(Object.keys(controller).sort()).toEqual(['dispose', 'getSnapshot', 'refresh', 'setVisible', 'update'])
    expect(document.getElementById('stable-gate')).toBe(root)
    expect(root.matches('.gate-card.cloud-testing')).toBe(true)
    expect(controller.getSnapshot().selectedId).toBe('s2')
    expect(root.querySelectorAll('.ct-round-detail')).toHaveLength(1)
    expect(api).not.toHaveBeenCalled()
    expect(onData).toHaveBeenCalledWith(initialData)
    expect(createEvidence).toHaveBeenCalledWith(expect.objectContaining({ repo: 'repo', taskId: 'task', api: expect.objectContaining({ getLogs: expect.any(Function) }) }))
    expect(getNodeInfo(initialData).status).toBe('attention')
  })
  it('没有 initialData 时立即请求首页，传递 AbortSignal', async () => {
    const { controller, api } = mount({ initialData: null })
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    expect(api.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(controller.getSnapshot().selectedId).toBe('s2')
  })
  it('新轮出现不切换历史选择，正文节点、展开、焦点和错误滚动不变', () => {
    const old = makeRound(1, 'failed', { runs: [{ runId: 'r1', unit: 'smoke', side: 'web', status: 'failed',
      terminalReason: 'assertion_failed', attempts: [{ attempt: 1, status: 'failed', errorDetail: '第一行\n'.repeat(100) }] }] })
    const { root, controller } = mount({ initialData: data([2, 1], { submissions: [makeRound(2), old] }) })
    root.querySelector('[data-round="s1"]').click()
    const body = root.querySelector('.ct-round-detail')
    const run = root.querySelector('[data-run-id="r1"]')
    const details = run.querySelector('details')
    details.open = true
    const pre = details.querySelector('pre')
    pre.scrollTop = 170
    const trigger = run.querySelector('[data-action="evidence"]')
    trigger.focus()
    controller.update(data([3, 2]))
    expect(controller.getSnapshot().selectedId).toBe('s1')
    expect(root.querySelector('.ct-round-detail')).toBe(body)
    expect(root.querySelector('[data-run-id="r1"]')).toBe(run)
    expect(details.open).toBe(true)
    expect(pre.scrollTop).toBe(170)
    expect(document.activeElement).toBe(trigger)
    expect(root.querySelector('.ct-new-round').hidden).toBe(false)
    expect(root.querySelectorAll('.ct-round-detail')).toHaveLength(1)
  })
  it('同轮节点内容变化时局部更新，保留详情展开和焦点', () => {
    const failed = makeRound(2, 'error', { runs: [{ runId: 'r2', unit: 'smoke', side: 'web', status: 'error', terminalReason: 'infra_error',
      attempts: [{ attempt: 1, status: 'error', errorDetail: '网络失败' }] }] })
    const { root, controller } = mount({ initialData: data([2], { submissions: [failed] }) })
    const detail = root.querySelector('.ct-run details')
    detail.open = true
    const run = root.querySelector('.ct-run')
    const pre = detail.querySelector('pre')
    const focus = run.querySelector('[data-action="evidence"]')
    focus.focus()
    const next = structuredClone(failed)
    next.runs[0].attempts[0].errorDetail = '网络失败，补充诊断'
    controller.update(data([2], { submissions: [next] }))
    expect(root.querySelector('.ct-run')).toBe(run)
    expect(detail.open).toBe(true)
    expect(detail.querySelector('pre')).toBe(pre)
    expect(pre.textContent).toContain('补充诊断')
    expect(document.activeElement).toBe(focus)
  })
  it('失败刷新保留内容、截至时间和所选轮，恢复后继续更新', async () => {
    const api = vi.fn().mockRejectedValueOnce(new Error('暂时断网')).mockResolvedValue(data([3, 2]))
    const { root, controller } = mount({ api })
    const before = controller.getSnapshot()
    expect((await controller.refresh()).status).toBe('failed')
    expect(controller.getSnapshot()).toMatchObject({ selectedId: before.selectedId, observedAt: before.observedAt, lastSuccessAt: before.lastSuccessAt })
    expect(root.textContent).toContain('暂时断网')
    expect(root.querySelector('.ct-round-detail')).toBeTruthy()
    expect((await controller.refresh()).status).toBe('applied')
    expect(controller.getSnapshot().error).toBeNull()
    expect(controller.getSnapshot().selectedId).toBe('s2')
  })
  it('页签支持方向键/Home/End，选择条可切换轮次', () => {
    const { root, controller } = mount()
    const first = root.querySelector('[role="tab"]')
    first.focus()
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(controller.getSnapshot().tab).toBe('mutation')
    expect(document.activeElement.dataset.tab).toBe('mutation')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(controller.getSnapshot().tab).toBe('inputs')
    expect(root.querySelector('[role="tabpanel"]:not([hidden])').textContent).toContain('冻结输入')
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(controller.getSnapshot().tab).toBe('execution')
    const select = root.querySelector('select')
    select.value = 's1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    expect(controller.getSnapshot().selectedId).toBe('s1')
  })
  it('显示模式差异、三个独立维度和 unknown；observe DONE 失败仍为红色', () => {
    const { root, controller } = mount()
    expect(root.textContent).toContain('配置与当前有效不同')
    expect(root.querySelectorAll('.ct-axis')).toHaveLength(3)
    const next = data([2], { task: { phase: 'DONE' } })
    next.summary.execution = { state: 'failed', required: 2, passed: 0, failed: 1, active: 1, missing: [] }
    next.summary.mode.effective = 'observe'
    next.summary.mutation = { killed: 2, weak: 1, exempt: 1, active: 1, inconclusive: 1, unknown: 1 }
    controller.update(next)
    expect(root.querySelector('[data-ct-key="execution-axis"] .ct-badge').className).toContain('danger')
    expect(root.textContent).toContain('本层不强制拦截')
    expect(root.textContent).not.toContain('任务可以完成。云端')
    expect(getNodeInfo(next).status).toBe('failed')
    controller.update({ node: 'passed', task: { phase: 'DONE' }, submissions: [] })
    // 已有可信摘要不被低版本兼容数据覆盖。
    expect(controller.getSnapshot().summary.version).toBe(1)
    const unknown = mount({ initialData: { submissions: [makeRound(1, 'unknown')] } })
    expect(unknown.root.querySelector('.ct-run .ct-badge').className).not.toContain('success')
    expect(unknown.root.textContent).toContain('当前有效：未知')
  })
  it('新 epoch 无当前提交时，历史轮不回填最新轮且选择保持', () => {
    const next = data()
    next.summary.context.epoch = 3
    next.summary.latestSubmissionId = null
    next.summary.execution = { state: 'idle', required: null, completed: 0 }
    next.submissions.forEach((round) => { round.historical = true })
    const { root, controller } = mount()
    root.querySelector('[data-round="s1"]').click()
    controller.update(next)
    expect(controller.getSnapshot()).toMatchObject({ latestId: null, selectedId: 's1', newRound: false })
    expect(root.querySelector('.ct-round-header').textContent).toContain('正在查看历史轮')
    expect(root.querySelector('[data-ct-key="execution-axis"]').textContent).toContain('尚无当前正式提交')
    expect(root.querySelector('.ct-new-round').hidden).toBe(true)
    expect(store({ initialData: next }).getSnapshot().latestId).toBeNull()
  })
  it('未知数量未量化与不适用明确显示，范围扩展字段不参加变异计数', () => {
    const initialData = data([1], { submissions: [makeRound(1, 'passed', { requiredUnits: [], runs: [] })] })
    initialData.summary.execution = { state: 'not_applicable', required: 0, completed: 0 }
    initialData.summary.mutation = { unknown: null, recorded: 0, unrecorded: true, detailAvailable: true, scope: 'latest_submission' }
    const { root } = mount({ initialData })
    const execution = root.querySelector('[data-ct-key="execution-axis"]')
    const mutation = root.querySelector('[data-ct-key="mutation-axis"]')
    expect(execution.textContent).toContain('不适用')
    expect(execution.querySelector('.ct-badge').className).not.toContain('success')
    expect(mutation.textContent).toContain('未知范围未量化')
    expect(mutation.textContent).toContain('未记录当前轮变异')
    expect(mutation.textContent).not.toContain('仅统计有记录范围')
    expect([...mutation.querySelectorAll('b')].at(-1).textContent).toBe('未记录')
  })
  it('两次尝试仍为一轮，报告不复制到每个 attempt', () => {
    const r = makeRound(1)
    r.runs[0].reportAttempt = 2
    r.runs[0].attempts = [{ attempt: 1, status: 'error', errorDetail: '首次失败' }, { attempt: 2, status: 'passed', worker: 'worker-2' }]
    const { root, controller } = mount({ initialData: data([1], { submissions: [r] }) })
    expect(root.querySelectorAll('.ct-round-detail')).toHaveLength(1)
    expect(root.querySelectorAll('.ct-attempt')).toHaveLength(2)
    expect(root.textContent).toContain('尝试 2 次、重试 1 次')
    expect(root.textContent).toContain('当前检查项报告属于尝试 2')
    expect(controller.getSnapshot().total).toBe(1)
  })
  it('当前 AC 不进入历史正文或传递的历史证据上下文', () => {
    const raw = data()
    raw.flow = { version: 1, rounds: raw.submissions, currentAcceptance: { phase: 'DONE', acceptance: [{ id: 'AC-NOW', text: '当前验收条件' }], coverage: { covered: ['AC-NOW'] } } }
    const { root } = mount({ initialData: raw })
    root.querySelector('[data-round="s1"]').click()
    expect(root.querySelector('.ct-current-observation').textContent).toContain('AC-NOW')
    expect(root.querySelector('.ct-round-detail').textContent).not.toContain('AC-NOW')
    click(root, 'round-report')
    expect(JSON.stringify(evidence.open.mock.calls[0][0].round)).not.toContain('AC-NOW')
  })
  it('报告、日志、时间线和尝试入口传递所选轮的冻结上下文', () => {
    const { root, controller } = mount()
    root.querySelector('[data-round="s1"]').click()
    const trigger = click(root, 'round-report')
    expect(evidence.open).toHaveBeenLastCalledWith(expect.objectContaining({ round: expect.objectContaining({ submissionId: 's1' }), runId: null, attempt: null, tab: 'report', trigger }))
    const locked = evidence.open.mock.calls[0][0].round
    controller.update(data([3, 2]))
    expect(locked.submissionId).toBe('s1')
    root.querySelector('[data-action="evidence"][data-tab="logs"][data-attempt="1"]').click()
    expect(evidence.open).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'r1', attempt: 1, tab: 'logs', observedAt: expect.any(String) }))
    root.querySelector('[data-action="evidence"][data-tab="timeline"]').click()
    expect(evidence.open).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'r1', tab: 'timeline' }))
  })
  it('转义服务端文本，技术 ID 只进入元信息和原生复制按钮', () => {
    const r = makeRound(1)
    r.runs[0].title = '<img src=x onerror=alert(1)>'
    r.runs[0].runId = 'run-"<svg/onload=alert(1)>'
    const { root } = mount({ initialData: data([1], { submissions: [r] }) })
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('.ct-run h4').textContent).toContain('<img')
    expect(root.querySelector('[data-action="copy"]')).toBeInstanceOf(HTMLButtonElement)
  })
})

describe('自动刷新生命周期', () => {
  it('5 秒轮询、订阅与手动请求合并，暂停后不抓取，恢复立即刷新', async () => {
    let signal
    const unsubscribe = vi.fn()
    const pending = deferred()
    const api = vi.fn(() => pending.promise)
    const { root, controller } = mount({ api, subscribe: (callback) => { signal = callback; return unsubscribe } })
    await vi.advanceTimersByTimeAsync(5000)
    signal()
    const manual = controller.refresh()
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    pending.resolve(data())
    await manual
    signal()
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    click(root, 'pause')
    await vi.advanceTimersByTimeAsync(15000)
    signal()
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('已暂停自动刷新')
    click(root, 'pause')
    await tick()
    expect(api).toHaveBeenCalledTimes(2)
    controller.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15000)
    signal()
    expect(api).toHaveBeenCalledTimes(2)
  })
  it('收起使用 hidden 并停止请求，重新显示立即刷新，不替换 root', async () => {
    const onClose = vi.fn()
    const { root, controller, api } = mount({ onClose })
    click(root, 'close')
    expect(root.hidden).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(evidence.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(api).not.toHaveBeenCalled()
    controller.setVisible(true)
    await tick()
    expect(root.hidden).toBe(false)
    expect(document.getElementById('stable-gate')).toBe(root)
    expect(api).toHaveBeenCalledTimes(1)
  })
  it('document 隐藏暂停、取消在途 GET，恢复立即刷新，旧响应不落地', async () => {
    const old = deferred()
    const api = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(data([3, 2]))
    const { controller } = mount({ api })
    const request = controller.refresh()
    await tick()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(api.mock.calls[0][1].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(api).toHaveBeenCalledTimes(1)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await tick()
    expect(api).toHaveBeenCalledTimes(2)
    old.resolve(data([1]))
    expect((await request).status).toBe('stale')
    expect(controller.getSnapshot().latestId).toBe('s3')
  })
  it('dispose 释放订阅、计时器、视图和证据窗口，重复调用安全', async () => {
    const { root, controller, api } = mount({ initialData: null })
    await tick()
    controller.dispose()
    controller.dispose()
    expect(root.childElementCount).toBe(0)
    expect(evidence.dispose).toHaveBeenCalledTimes(1)
    expect(root.classList.contains('gate-card')).toBe(true)
    await vi.advanceTimersByTimeAsync(20000)
    expect(api).toHaveBeenCalledTimes(1)
    expect((await controller.refresh()).status).toBe('stale')
    expect(controller.update(data([9])).status).toBe('stale')
  })
})

describe('受控恢复操作', () => {
  it('重推必须确认、不新轮，等待服务端、避免双击、显示错误并可重试', async () => {
    const pending = deferred()
    const sub = makeRound(1, 'error')
    sub.runs[0].terminalReason = 'infra_error'
    const api = vi.fn((url, options) => options?.method === 'POST' ? pending.promise : Promise.resolve(data([1], { submissions: [sub] })))
    const { root, controller } = mount({ api, initialData: data([1], { submissions: [sub] }) })
    click(root, 'requeue')
    expect(api).not.toHaveBeenCalled()
    expect(root.textContent).toContain('不新增正式轮')
    expect(document.activeElement.dataset.action).toBe('confirm-requeue')
    click(root, 'cancel-requeue')
    expect(root.querySelector('[data-action="confirm-requeue"]')).toBeNull()
    click(root, 'requeue')
    const confirm = click(root, 'confirm-requeue')
    confirm.click()
    await tick()
    expect(api).toHaveBeenCalledTimes(1)
    expect(root.querySelector('[data-action="confirm-requeue"]').disabled).toBe(true)
    expect(controller.getSnapshot().selectedRound.runs[0].status).toBe('error')
    pending.reject(new Error('权限不足'))
    await tick()
    expect(root.textContent).toContain('权限不足')
    expect(root.querySelector('[data-action="confirm-requeue"]').disabled).toBe(false)
    expect(controller.getSnapshot().total).toBe(1)
  })
  it('成功后仅提示已接受，再刷新真实状态，不乐观显示成功', async () => {
    const sub = makeRound(1, 'error')
    sub.runs[0].terminalReason = 'lost'
    const api = vi.fn(async (url, options) => options?.method === 'POST' ? { ok: true, runId: 'r1', status: 'queued' } : data([1], { submissions: [sub] }))
    const { root, controller } = mount({ api, initialData: data([1], { submissions: [sub] }) })
    click(root, 'requeue')
    click(root, 'confirm-requeue')
    await tick()
    expect(api).toHaveBeenCalledTimes(2)
    expect(root.textContent).toContain('重试请求已接受')
    expect(controller.getSnapshot().selectedRound.runs[0].status).toBe('error')
  })
  it('断言失败、变异运行和不允许的终态没有重推入口', () => {
    const sub = makeRound(1, 'failed')
    sub.runs[0].terminalReason = 'assertion_failed'
    sub.mutations = [{ runId: 'm1', status: 'error', terminalReason: 'infra_error' }]
    const { root } = mount({ initialData: data([1], { submissions: [sub] }) })
    expect(root.querySelector('[data-action="requeue"]')).toBeNull()
  })
})

describe('样式约束', () => {
  it('容器 900px 两栏 224px，小屏选择条、44px 控件和减弱动画规则齐备', () => {
    const css = readFileSync(`${process.cwd()}/public/assets/cloud-testing/cloud-testing.css`, 'utf8')
    expect(css).toContain('container: cloud-testing / inline-size')
    expect(css).toContain('@container cloud-testing (min-width: 900px)')
    expect(css).toContain('grid-template-columns: 224px minmax(0, 1fr)')
    expect(css).toContain('.ct-round-list { display: none; }')
    expect(css).toContain('.ct-round-select { display: flex;')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain('min-width: 44px')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('prefers-reduced-motion: reduce')
    expect(css).toContain('overflow-wrap: anywhere')
  })
})
