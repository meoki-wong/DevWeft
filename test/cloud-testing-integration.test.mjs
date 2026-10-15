import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { parse } from 'acorn'
import { Window } from 'happy-dom'
import * as cloudTesting from '../public/assets/cloud-testing/index.js'

const source = readFileSync(new URL('../public/assets/dashboard.js', import.meta.url), 'utf8')
const shell = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8')
const css = ['../public/assets/dashboard.css', '../public/assets/cloud-testing/cloud-testing.css']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' })
const tick = async () => { for (let n = 0; n < 60; n++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const stamp = '2026-09-25T10:00:00Z'
const fixtures = []

function summary(repo = 'repo', taskId = 'task', execution = 'failed', extra = {}) {
  return { version: 1, context: { repo, taskId, epoch: 1, revision: 1 }, latestSubmissionId: 's1', formalRoundCount: 1,
    execution: { state: execution, required: 1, passed: execution === 'passed' ? 1 : 0,
      failed: execution === 'failed' ? 1 : 0, active: ['running', 'queued'].includes(execution) ? 1 : 0, missing: [] },
    mutation: { killed: 0, weak: 0, exempt: 0, active: 0, inconclusive: 0, unknown: 0 },
    mode: { configured: 'observe', effective: 'observe', source: 'readonly' },
    assessment: { kind: 'observation', reasons: [], evidenceRefs: [] }, observedAt: stamp, ...extra }
}
function byTask(repo = 'repo', taskId = 'task', execution = 'failed', extra = {}) {
  return { ok: true, linked: true, task: { phase: 'DONE' }, total: 1,
    page: { before: null, limit: 5, hasMore: false, nextCursor: null }, submissions: [],
    summary: summary(repo, taskId, execution), ...extra }
}
function task(repo = 'repo', taskId = 'task', extra = {}) {
  return { repo, task_id: taskId, phase: 'DONE', requirement: '只读集成验证', author: 'tester',
    created_at: stamp, updated_at: stamp, completed: '[]', pending: '[]', gateSummary: summary(repo, taskId), ...extra }
}
function status(phase = 'DONE') {
  return { ok: true, status: { phase }, doingNow: '核对执行事实', workflow: [
    { phase: 'EXECUTE', name: '执行', status: 'done' }, { phase: 'VERIFY', name: '验收', status: 'done' },
  ] }
}

// 只在内存替换 dynamic import 的解析器与启动调用；其余完整 classic 源码原样执行。
// 导入返回真实模块，控制器、store、view、证据窗口均不做替身。
function classicScript() {
  const imports = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'ImportExpression') imports.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(ast)
  expect(imports).toHaveLength(1)
  const boot = ast.body.at(-1)
  expect(boot.expression.callee.name).toBe('boot')
  const replacements = [{ start: boot.start, end: boot.end, text: '' },
    ...imports.map((node) => ({ start: node.start, end: node.end, text: `__importCloud(${source.slice(node.source.start, node.source.end)})` }))]
  let result = source
  for (const change of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.text + result.slice(change.end)
  return result
}
function harness(options = {}) {
  const window = new Window({ url: 'http://classic.test/dashboard.html#/tasks', settings: {
    disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true,
  } })
  const document = window.document
  document.write(shell.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, ''))
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  const script = document.createElement('script')
  script.src = 'http://classic.test/assets/dashboard.js?v=classic-build'
  Object.defineProperty(document, 'currentScript', { configurable: true, value: script })
  Object.defineProperty(document, 'hidden', { configurable: true, writable: true, value: false })
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  const requests = []
  const input = {
    list: { items: [task()], gates: {}, phaseCounts: {} },
    gate: (repo, taskId) => byTask(repo, taskId), workflow: () => status(), ...options,
  }
  const request = vi.fn(async (path, opts = {}) => {
    expect(opts.method || 'GET', `测试只能读取：${path}`).toBe('GET')
    const url = new URL(path, window.location.href)
    requests.push({ path, url, signal: opts.signal })
    let data
    if (url.pathname === '/api/tasks') data = typeof input.list === 'function' ? await input.list(url) : input.list
    else if (url.pathname.startsWith('/api/testing/by-task/')) data = await input.gate(url.searchParams.get('repo'), decodeURIComponent(url.pathname.split('/').at(-1)), url)
    else if (url.pathname === '/api/harness/status') data = await input.workflow(url)
    else if (url.pathname === '/api/repos') data = { repos: [{ repo: 'repo' }, { repo: 'other' }], defaultRepo: 'repo' }
    else if (url.pathname === '/api/docs') data = { items: [] }
    else throw new Error(`未配置的请求：${path}`)
    return { ok: true, json: async () => data }
  })
  class EventSource {
    constructor() { this.onmessage = null }
    close() {}
  }
  const importCloud = vi.fn(options.importCloud || (async () => cloudTesting))
  const location = { href: window.location.href, hash: '#/tasks' }
  const context = createContext({ window, document, location, localStorage: window.localStorage,
    navigator: window.navigator, fetch: request, EventSource, URL, URLSearchParams, AbortController, DOMException,
    Date, console, setInterval, clearInterval, setTimeout, clearTimeout, __importCloud: importCloud })
  new Script(classicScript()).runInContext(context)
  const bridge = new Script('({ state, render, renderTasks, loadCloudTesting, connectStream, initRepoSelect, fillTaskDetail, refreshOpenGateCards, refreshOpenTaskWorkflows, openTaskDetails, gateListeners, disposeTaskViews, taskKey, wfStepHtml, acceptTaskGateData, getStream: () => es })').runInContext(context)
  bridge.state.repo = options.repo || 'repo'
  bridge.state.route = 'tasks'
  const h = { window, document, requests, request, input, bridge, importCloud,
    rows: () => [...document.querySelectorAll('.task-row')],
    record: (row = h.rows()[0]) => bridge.openTaskDetails.get(bridge.taskKey(row.dataset.repo, row.dataset.id)),
    gateRequests: () => requests.filter((r) => r.url.pathname.startsWith('/api/testing/by-task/')),
    statusRequests: () => requests.filter((r) => r.url.pathname === '/api/harness/status'),
    emit: (event) => bridge.getStream().onmessage({ data: JSON.stringify(event) }),
    hidden(value) { document.hidden = value; document.dispatchEvent(new window.Event('visibilitychange')) },
    async route(name) { location.hash = `#/${name}`; await bridge.render() },
  }
  fixtures.push(h)
  return h
}
async function openRow(h, index = 0) {
  const row = h.rows()[index]
  row.querySelector('.task-main').click()
  await tick()
  expect(row.querySelector('.task-detail').dataset.loaded).toBe('1')
  return h.record(row)
}
async function openPanel(h, rec) {
  rec.detail.querySelector('[data-gate-node]').click()
  await tick()
  expect(rec.controller.getSnapshot().visible).toBe(true)
  expect(h.window.getComputedStyle(rec.root).display).not.toBe('none')
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(stamp)) })
afterEach(async () => {
  for (const h of fixtures.splice(0)) { h.bridge.disposeTaskViews(); await h.window.happyDOM.abort() }
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('classic 云端测试接线', () => {
  it('保留 classic shell 与云端测试样式，彻底删除旧门禁分支', () => {
    expect(shell).toContain('assets/cloud-testing/cloud-testing.css?v=%BUILD%')
    expect(shell).toContain('<script src="assets/dashboard.js?v=%BUILD%"></script>')
    expect(source).not.toMatch(/__gateLoad|openGateReportModal|gateFlowData|gatePages|loadGateCard|renderGateCard|bindGateCard|UNIT_META|gate-freeze-btn|gc-actions/)
    expect(source).not.toMatch(/classList\.(?:add|remove|toggle)\('hidden'/)
    const workflow = ast.body.find((node) => node.id?.name === 'refreshTaskWorkflow')
    expect(source.slice(workflow.start, workflow.end)).not.toContain('/api/testing/by-task/')
    const h = harness()
    expect(h.bridge.state.tasks.wfCache.size).toBe(0)
    expect(typeof h.bridge.state.tasks.wfCache.get).toBe('function')
    expect(typeof h.window.__openLightbox).toBe('function')
    expect(typeof h.bridge.wfStepHtml).toBe('function')
  })

  it('导入时保留 skeleton、缓存同一 promise，失败后按钮重试并保留构建戳', async () => {
    const pending = deferred()
    const h = harness({ importCloud: vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(cloudTesting) })
    const rendering = h.bridge.renderTasks()
    const a = h.bridge.loadCloudTesting(), b = h.bridge.loadCloudTesting()
    expect(a).toBe(b)
    expect(h.document.querySelector('#taskList .skeleton')).not.toBeNull()
    expect(h.request).not.toHaveBeenCalled()
    pending.reject(new Error('模块暂不可用'))
    await rendering
    expect(h.document.querySelector('[data-task-retry]').textContent).toBe('重试')
    h.document.querySelector('[data-task-retry]').click()
    await tick()
    expect(h.rows()).toHaveLength(1)
    expect(h.importCloud).toHaveBeenCalledTimes(2)
    expect(h.importCloud).toHaveBeenLastCalledWith('./cloud-testing/index.js?v=classic-build')
    await h.bridge.loadCloudTesting()
    expect(h.importCloud).toHaveBeenCalledTimes(2)
  })

  it('行内 gateSummary 优先于旧 gates；无 linked 的旧摘要明确是正式执行而非放行', async () => {
    const h = harness({ list: { items: [task(), task('repo', 'legacy', { gateSummary: undefined })],
      gates: { task: { status: 'passed', passed: 8, total: 8 }, legacy: { status: 'passed', passed: 2, total: 2 } } } })
    await h.bridge.renderTasks()
    const [current, legacy] = h.rows().map((row) => row.querySelector('[data-gate-summary]'))
    expect(current.hidden).toBe(false)
    expect(current.textContent).toContain('执行失败')
    expect(current.textContent).not.toContain('8/8')
    expect(legacy.textContent).toContain('正式执行通过')
    expect(legacy.textContent).toContain('2/2')
    expect(legacy.title).toContain('待实际门禁确认')
    expect(legacy.textContent).not.toContain('门禁通过')
    expect(h.window.getComputedStyle(legacy).display).not.toBe('none')
  })

  it('全部项目的歧义旧 gates 不显示；行内新摘要仍按 repo + taskId 隔离', async () => {
    const h = harness({ repo: 'all', list: { items: [task('repo', 'same', { gateSummary: undefined }),
      task('other', 'same', { gateSummary: undefined }), task('repo', 'modern')], gates: { same: { status: 'passed', passed: 1, total: 1 } } } })
    await h.bridge.renderTasks()
    for (const row of h.rows().slice(0, 2)) {
      const chip = row.querySelector('[data-gate-summary]')
      expect(chip.hidden).toBe(true)
      expect(h.window.getComputedStyle(chip).display).toBe('none')
    }
    expect(h.rows()[2].querySelector('[data-gate-summary]').hidden).toBe(false)
    expect(h.gateRequests()).toHaveLength(0)
  })

  it('原生节点、稳定容器、真实 computed 隐藏；任务重开不自动展开面板', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    const root = rec.root
    const node = rec.detail.querySelector('[data-gate-node]')
    expect(root.tagName).toBe('DIV')
    expect(root.hidden).toBe(true)
    expect(h.window.getComputedStyle(root).display).toBe('none')
    expect(rec.controller).toBeNull()
    expect(node.tagName).toBe('BUTTON')
    expect(node.getAttribute('aria-controls')).toBe(root.id)
    expect(node.getAttribute('aria-expanded')).toBe('false')
    expect(node.getAttribute('aria-label')).toContain('异常')
    expect(node.title).toContain('执行失败')
    expect(node.querySelector('.wf-gate-status').textContent).toContain('异常')
    expect(node.classList.contains('done')).toBe(false)
    await openPanel(h, rec)
    const controller = rec.controller
    const update = vi.spyOn(controller, 'update')
    expect(node.getAttribute('aria-expanded')).toBe('true')
    rec.root.querySelector('[data-action="close"]').click()
    expect(rec.row.classList.contains('open')).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ visible: false, automatic: false, disposed: false })
    expect(root.hidden).toBe(true)
    expect(node.getAttribute('aria-expanded')).toBe('false')
    rec.row.querySelector('.task-main').click()
    expect(h.window.getComputedStyle(rec.detail).display).toBe('none')
    await openRow(h)
    expect(rec.root).toBe(root)
    expect(rec.controller).toBe(controller)
    expect(root.hidden).toBe(true)
    expect(controller.getSnapshot().visible).toBe(false)
    expect(h.window.getComputedStyle(root).display).toBe('none')
    update.mockClear()
    const before = h.gateRequests().length
    await openPanel(h, rec)
    expect(h.gateRequests()).toHaveLength(before + 1)
    expect(update).not.toHaveBeenCalled()
    expect(h.bridge.state.tasks.wfCache.get(rec.key)).toBe(rec.controller.getSnapshot().data)
    expect(root.classList.contains('hidden')).toBe(false)
  })

  it('行摘要按钮直接打开任务与云端，不被父行折叠；停止按钮不受新委托干扰', async () => {
    const h = harness({ list: { items: [task('repo', 'task', { phase: 'EXECUTE' })] } })
    await h.bridge.renderTasks()
    const row = h.rows()[0]
    row.querySelector('[data-gate-summary]').click()
    await tick()
    const rec = h.record(row)
    expect(rec.controller.getSnapshot().visible).toBe(true)
    expect(h.window.getComputedStyle(rec.detail).display).toBe('block')
    row.querySelector('[data-gate-summary]').click()
    expect(rec.root.hidden).toBe(false)
    expect(row.classList.contains('open')).toBe(true)
    h.window.confirm = vi.fn(() => false)
    row.querySelector('.task-stop-btn').click()
    expect(h.window.confirm).toHaveBeenCalledTimes(1)
    expect(row.classList.contains('open')).toBe(true)
    expect(h.requests.every((r) => !r.path.includes('/stop'))).toBe(true)
  })

  it('loading 中二次点击取消首读；忽略 Abort 的迟到响应不得展开或污染新一代', async () => {
    const gate = deferred(), workflow = deferred()
    const h = harness({ gate: () => gate.promise, workflow: () => workflow.promise })
    await h.bridge.renderTasks()
    const row = h.rows()[0]
    row.querySelector('[data-gate-summary]').click()
    await tick()
    const rec = h.record(row)
    row.querySelector('.task-main').click()
    expect(h.gateRequests()[0].signal.aborted).toBe(true)
    expect(h.statusRequests()[0].signal.aborted).toBe(true)
    expect(rec.root.hidden).toBe(true)
    h.input.gate = () => byTask('repo', 'task', 'running')
    h.input.workflow = () => status('EXECUTE')
    await openRow(h)
    gate.resolve(byTask('repo', 'task', 'passed'))
    workflow.resolve(status('DONE'))
    await tick()
    expect(rec.controller).toBeNull()
    expect(rec.root.hidden).toBe(true)
    expect(rec.data.summary.execution.state).toBe('running')
    expect(row.querySelector('[data-task-phase]').textContent).toBe('EXECUTE')
    expect(rec.detail.querySelector('[data-gate-node]').getAttribute('aria-expanded')).toBe('false')
  })

  it('首读与收起态 SSE/轮询请求去重；可见面板一拍只 GET 一次 by-task，焦点不丢失', async () => {
    const pending = deferred()
    const h = harness({ gate: () => pending.promise })
    await h.bridge.renderTasks()
    h.bridge.connectStream()
    const row = h.rows()[0]
    row.querySelector('.task-main').click()
    await tick()
    h.emit({ id: 'initial', tool_name: 'test_run_status', repo: 'repo', task_id: 'task' })
    void h.bridge.fillTaskDetail(row)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.gateRequests()).toHaveLength(1)
    expect(h.statusRequests()).toHaveLength(1)
    pending.resolve(byTask())
    await tick()
    const rec = h.record(row)
    h.input.gate = () => byTask()
    await openPanel(h, rec)
    const node = rec.detail.querySelector('[data-gate-node]')
    node.focus()
    let gateCount = h.gateRequests().length, statusCount = h.statusRequests().length
    await vi.advanceTimersByTimeAsync(5000)
    h.emit({ id: 'same-tick', tool_name: 'awp_test_run', repo: 'repo', task_id: 'task' })
    await tick()
    expect(h.gateRequests()).toHaveLength(gateCount + 1)
    expect(h.statusRequests()).toHaveLength(statusCount + 1)
    expect(rec.detail.querySelector('[data-gate-node]')).toBe(node)
    expect(h.document.activeElement).toBe(node)
    node.click()
    const summaryPending = deferred()
    h.input.gate = () => summaryPending.promise
    gateCount = h.gateRequests().length
    void h.bridge.refreshOpenGateCards()
    void h.bridge.refreshOpenGateCards()
    await tick()
    expect(h.gateRequests()).toHaveLength(gateCount + 1)
    expect(rec.controller.getSnapshot().visible).toBe(false)
    summaryPending.resolve(byTask())
    await tick()
  })

  it('任务行收起时联动隐藏正在读取的控制器，取消请求且停止后续轮询', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    await openPanel(h, rec)
    const pending = deferred()
    h.input.gate = () => pending.promise
    void rec.controller.refresh()
    await tick()
    const request = h.gateRequests().at(-1)
    rec.row.querySelector('.task-main').click()
    expect(request.signal.aborted).toBe(true)
    expect(rec.controller.getSnapshot()).toMatchObject({ visible: false, automatic: false })
    expect(rec.detail.querySelector('[data-gate-node]').getAttribute('aria-expanded')).toBe('false')
    expect(h.window.getComputedStyle(rec.root).display).toBe('none')
    expect(h.window.getComputedStyle(rec.detail).display).toBe('none')
    const count = h.requests.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.requests).toHaveLength(count)
    pending.resolve(byTask('repo', 'task', 'passed'))
    await tick()
    expect(rec.data.summary.execution.state).toBe('failed')
  })

  it('hidden 文档停止请求并取消在途读取，visible 恢复只共享一次首页刷新', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    await openPanel(h, rec)
    const delayed = deferred()
    h.input.gate = () => delayed.promise
    void rec.controller.refresh()
    await tick()
    const inFlight = h.gateRequests().at(-1)
    h.hidden(true)
    expect(inFlight.signal.aborted).toBe(true)
    expect(rec.controller.getSnapshot().automatic).toBe(false)
    const gateCount = h.gateRequests().length, statusCount = h.statusRequests().length
    await vi.advanceTimersByTimeAsync(15000)
    expect(h.gateRequests()).toHaveLength(gateCount)
    expect(h.statusRequests()).toHaveLength(statusCount)
    h.input.gate = () => byTask()
    h.hidden(false)
    await tick()
    expect(h.gateRequests()).toHaveLength(gateCount + 1)
    expect(h.statusRequests()).toHaveLength(statusCount + 1)
    expect(rec.controller.getSnapshot().automatic).toBe(true)
    delayed.resolve(byTask('repo', 'task', 'passed'))
    await tick()
    expect(rec.data.summary.execution.state).toBe('failed')
    rec.detail.querySelector('[data-gate-node]').click()
    h.hidden(true)
    const closedCount = h.gateRequests().length
    h.hidden(false)
    await tick()
    expect(h.gateRequests()).toHaveLength(closedCount + 1)
    expect(rec.controller.getSnapshot().visible).toBe(false)
  })

  it('单连接 SSE 按 task_id 和已知仓库隔离；UUID repo 保守失效相关任务', async () => {
    const h = harness({ repo: 'all', list: { items: [task('repo', 'same'), task('other', 'same'), task('repo', 'different')] } })
    await h.bridge.renderTasks()
    h.bridge.connectStream()
    for (let i = 0; i < 3; i++) await openPanel(h, await openRow(h, i))
    expect(h.bridge.gateListeners.size).toBe(3)
    await vi.advanceTimersByTimeAsync(300)
    let count = h.gateRequests().length
    h.emit({ id: 'slug', tool_name: 'test_run_status', repo: 'repo', task_id: 'same' })
    await tick()
    expect(h.gateRequests()).toHaveLength(count + 1)
    expect(h.gateRequests().at(-1).url.searchParams.get('repo')).toBe('repo')
    h.emit({ id: 'slug', tool_name: 'test_run_status', repo: 'repo', task_id: 'same' })
    await tick()
    expect(h.gateRequests()).toHaveLength(count + 1)
    await vi.advanceTimersByTimeAsync(300)
    count = h.gateRequests().length
    h.emit({ id: 'uuid', tool_name: 'awp_test_run', repo: '01a0-unknown-uuid', task_id: 'same' })
    await tick()
    expect(h.gateRequests()).toHaveLength(count + 2)
    expect(new Set(h.gateRequests().slice(-2).map((r) => r.url.searchParams.get('repo')))).toEqual(new Set(['repo', 'other']))
    await vi.advanceTimersByTimeAsync(300)
    count = h.gateRequests().length
    h.emit({ id: 'broad', tool_name: 'awp_test_run', repo: '01a0-unknown-uuid' })
    await tick()
    expect(h.gateRequests()).toHaveLength(count + 3)
  })

  it('路由离开销毁真实控制器、证据 DOM、订阅和在途请求，迟到响应不回写', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    await openPanel(h, rec)
    const pending = deferred()
    h.input.gate = () => pending.promise
    void rec.controller.refresh()
    await tick()
    const request = h.gateRequests().at(-1)
    await h.route('overview')
    expect(rec.controller.getSnapshot().disposed).toBe(true)
    expect(rec.disposed).toBe(true)
    expect(request.signal.aborted).toBe(true)
    expect(h.bridge.openTaskDetails.size).toBe(0)
    expect(h.bridge.gateListeners.size).toBe(0)
    expect(h.document.querySelector('.ct-evidence')).toBeNull()
    pending.resolve(byTask('repo', 'task', 'passed'))
    await tick()
    expect(h.bridge.state.tasks.wfCache.size).toBe(0)
    const count = h.gateRequests().length
    await vi.advanceTimersByTimeAsync(10000)
    expect(h.gateRequests()).toHaveLength(count)
    await h.route('docs')
    expect(h.document.querySelector('#docsNav').textContent).toContain('没有匹配的文档')
  })

  it('仓库切换及列表重绘释放控制器；旧列表请求 abort 后不能覆盖新仓', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    await openPanel(h, rec)
    await h.bridge.initRepoSelect()
    const pending = deferred()
    h.input.list = () => pending.promise
    const old = h.bridge.renderTasks()
    await tick()
    expect(rec.controller.getSnapshot().disposed).toBe(true)
    const oldRequest = h.requests.filter((r) => r.url.pathname === '/api/tasks').at(-1)
    h.input.list = { items: [task('other', 'new')] }
    const select = h.document.querySelector('#repoSelect')
    select.value = 'other'
    select.dispatchEvent(new h.window.Event('change'))
    await tick()
    expect(oldRequest.signal.aborted).toBe(true)
    pending.resolve({ items: [task('repo', 'old')] })
    await old
    expect(h.rows()).toHaveLength(1)
    expect(h.rows()[0].dataset.repo).toBe('other')
    expect(h.rows()[0].dataset.id).toBe('new')
  })

  it('工作流只读取 status 且共享节点缓存；语义由真实模型提供，任务 DONE 不补绿', async () => {
    const h = harness()
    await h.bridge.renderTasks()
    const rec = await openRow(h)
    const gateCount = h.gateRequests().length
    h.input.workflow = () => status('EXECUTE')
    await h.bridge.refreshOpenTaskWorkflows()
    expect(h.gateRequests()).toHaveLength(gateCount)
    expect(rec.row.querySelector('[data-task-phase]').textContent).toBe('EXECUTE')
    expect(rec.row.querySelector('[data-gate-summary]').textContent).toContain('执行失败')
    for (const execution of ['queued', 'running', 'failed', 'passed', 'skipped', 'not_applicable']) {
      const data = byTask('repo', 'task', execution)
      h.bridge.acceptTaskGateData(rec, data)
      const expected = cloudTesting.getNodeInfo(data)
      const node = rec.detail.querySelector('[data-gate-node]')
      expect(node.querySelector('.wf-gate-status').textContent).toBe(expected.label)
      expect(node.title).toBe(expected.summary)
      expect(node.getAttribute('aria-label')).toContain(expected.label)
      expect(node.getAttribute('aria-controls')).toBe(rec.root.id)
      expect(node.classList.contains('current')).toBe(execution === 'running')
      expect(node.classList.contains('done')).toBe(false)
      if (execution !== 'running') expect(h.window.getComputedStyle(node.querySelector('.wf-dot')).animation).not.toContain('pulse')
    }
    const prior = rec.data
    h.bridge.acceptTaskGateData(rec, byTask('other', 'task'))
    expect(rec.data).toBe(prior)
    h.bridge.acceptTaskGateData(rec, byTask('repo', 'task', 'passed', { page: { before: 'history' } }))
    expect(rec.data).toBe(prior)
  })
})
