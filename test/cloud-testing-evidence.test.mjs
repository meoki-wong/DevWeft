import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { createEvidenceDialog } from '../public/assets/cloud-testing/evidence-dialog.js'
import { formatDateTime } from '../public/assets/cloud-testing/model.js'

// 全部接口都是 fixtures；不导入服务端、数据库或真实通信适配器。
const AT = '2026-09-17T10:00:00.000Z'
const paths = ['output/agent.log', 'output/other.log']
const fileList = (names = paths) => names.map((path) => ({ path, size: 123, kind: 'text' }))
const pkg = (artifactId = 'a-r1', attempt = 2, files = fileList()) => ({ ok: true, artifactId, attempt, truncated: false, files })
const textFile = (path, text, artifactId = 'a-r1', attempt = 2) => ({ ok: true, path, text, artifactId, attempt, size: text.length, truncated: false })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve() }
const makeRun = (runId = 'r1', extra = {}) => ({
  kind: 'run', runId, unit: 'smoke', side: 'web', status: 'failed', state: 'failed',
  summary: '接口断言失败', reason: '返回状态不符', createdAt: AT, totalMs: 1000,
  attempts: [{ attempt: 1, status: 'error' }, { attempt: 2, status: 'failed' }], reportAttempt: 2,
  checks: [{ caseKey: 'test:spec/order', status: 'failed', expected: '返回 200', actual: '返回 400', detail: '库存不足', durationMs: 100 }],
  artifact: { artifactId: `a-${runId}`, attempt: 2 }, ...extra,
})
const makeRound = (extra = {}) => ({
  submissionId: 'sub-old', roundNo: 3, status: 'failed', createdAt: AT, historical: true,
  runs: [makeRun()], mutations: [], steps: [], ...extra,
})
const fakeApi = (extra = {}) => ({
  getLogs: vi.fn(async (runId, { artifactId } = {}) => pkg(artifactId || `a-${runId}`)),
  getLog: vi.fn(async (runId, path, { artifactId } = {}) => textFile(path, `正文 ${runId} ${path}`, artifactId || `a-${runId}`)),
  getTimeline: vi.fn(async () => ({ steps: [], summary: null, failureAnalysis: null, source: 'mixed' })),
  getDiagnostics: vi.fn(async (runId) => ({ ok: true, runId, status: 'failed', unit: 'smoke', side: 'web', phase: 'smoke',
    failureAnalysis: { hasFailure: false }, suggestions: [], similarFailures: [], similarExperiences: [] })),
  submitDiagnosticFeedback: vi.fn(async (runId, suggestionId, { action }) => ({ ok: true, runId, suggestionId, action })),
  compareRuns: vi.fn(async (runId, againstRunId) => ({ ok: true, comparable: false,
    left: { runId, status: 'failed', durationMs: null }, right: { runId: againstRunId, status: 'passed', durationMs: 10 },
    comparabilityReasons: ['检查项集合发生变化'], configuration: {}, caseSet: { added: [], removed: [], common: 0 },
    statusChanges: [], failedChecks: { before: [], after: [] }, durationDeltaMs: null, denominator: { common: 0, before: 0, after: 0 } })),
  submitExperienceFeedback: vi.fn(async (feedback) => ({ ok: true, feedback: { ...feedback, verificationStatus: 'unverified' } })),
  logUrl: vi.fn((runId, path, { artifactId } = {}) => `https://evidence.invalid/${encodeURIComponent(runId)}/log?${new URLSearchParams({ path, ...(artifactId ? { artifactId } : {}) })}`),
  ...extra,
})
let window, controllers, clipboard, network, trigger
const $ = (selector) => document.querySelector(selector)
const content = (name) => $(`[data-panel="${name}"]`).textContent
const click = async (selector) => { $(selector).click(); await flush() }
const select = async (control, value) => {
  const element = $(`[data-control="${control}"]`)
  element.value = value
  element.dispatchEvent(new window.Event('change', { bubbles: true }))
  await flush()
}
const input = (control, value) => {
  const element = $(`[data-control="${control}"]`)
  element.value = value
  element.dispatchEvent(new window.Event('input', { bubbles: true }))
}
const create = (api = fakeApi()) => {
  const controller = createEvidenceDialog({ api, repo: 'fixture-repo', taskId: 'task-fixture' })
  controllers.push(controller)
  return { controller, api }
}
const open = async (options = {}, api = fakeApi()) => {
  const result = create(api)
  await result.controller.open({ round: makeRound(), observedAt: AT, trigger, ...options })
  return result
}

beforeEach(() => {
  window = new Window({ url: 'https://evidence.invalid/', settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true } })
  controllers = []
  clipboard = vi.fn(async () => {})
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
  network = vi.fn(() => { throw new Error('测试禁止真实网络请求') })
  vi.stubGlobal('window', window)
  vi.stubGlobal('document', window.document)
  vi.stubGlobal('navigator', window.navigator)
  vi.stubGlobal('fetch', network)
  document.body.innerHTML = '<main class="ct-panel"><button data-cloud-testing-entry>云端测试</button><button id="trigger">查看证据</button></main><aside inert>原本已隔离的区域</aside>'
  trigger = $('#trigger')
  trigger.focus()
})
afterEach(async () => {
  for (const controller of controllers) controller.dispose()
  expect(network).not.toHaveBeenCalled()
  await window.happyDOM.abort()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('统一证据窗口：所选轮与检查项归属', () => {
  it('报告固定所选历史轮的深拷贝，不读取最新轮或当前 AC', async () => {
    const round = makeRound({ currentAcceptance: { label: '绝不能展示的当前 AC' }, steps: [{ kind: 'acceptance', summary: '绝不能展示的当前门禁' }] })
    const { api } = await open({ round })
    round.roundNo = 99
    round.submissionId = 'sub-latest'
    round.runs[0].summary = '最新轮覆盖'
    await click('[data-tab="checks"]')
    await click('[data-tab="report"]')
    expect(content('report')).toContain('第 3 轮')
    expect(content('report')).toContain('sub-old')
    expect(content('report')).toContain('接口断言失败')
    expect(content('report')).not.toMatch(/sub-latest|最新轮覆盖|绝不能展示/)
    expect($('.ct-dialog-context').textContent).toContain('第 3 轮')
    expect(api.getTimeline).not.toHaveBeenCalled()
    expect(api.getLogs).not.toHaveBeenCalled()
    expect(api.getLog).not.toHaveBeenCalled()
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
  })

  it('阶段报告与变异判卷使用独立维度，不把预期失败画成未杀中', async () => {
    const mutations = [
      makeRun('m1', { state: 'passed', status: 'failed' }),
      makeRun('m2', { state: 'weak', status: 'passed' }),
      makeRun(null, { state: 'exempt', status: 'unknown' }),
      makeRun('m4', { state: 'error', status: 'error' }),
      makeRun('m5', { state: 'unknown', status: 'passed' }),
    ]
    await open({ round: makeRound({ status: 'active', mutations }) })
    expect(content('report')).toContain('阶段报告')
    expect(content('report')).toContain('已杀中变异')
    expect(content('report')).toContain('未杀中，需关注判别力')
    expect(content('report')).toContain('豁免，非真实杀中')
    expect(content('report')).toContain('未考成')
    expect(content('report')).toContain('判卷未知')
    expect(content('report')).toContain('2 次尝试，1 次重试')
  })

  it('检查项 reportAttempt 不匹配时不可用，不能展示其他尝试检查项', async () => {
    await open({ tab: 'checks', attempt: 1 })
    expect(content('checks')).toContain('已有报告属于尝试 2')
    expect(content('checks')).not.toContain('test:spec/order')
    await select('attempt', '2')
    expect(content('checks')).toContain('报告归属：尝试 2')
    expect(content('checks')).toContain('test:spec/order')
    expect(content('checks')).toContain('库存不足')
  })

  it('null reportAttempt 仅在运行级展示归属未知，不分配到任何尝试', async () => {
    await open({ tab: 'checks', round: makeRound({ runs: [makeRun('r1', { reportAttempt: null })] }) })
    expect(content('checks')).toContain('运行级报告，尝试归属未记录')
    expect(content('checks')).toContain('test:spec/order')
    await select('attempt', '2')
    expect(content('checks')).toContain('检查项不可用')
    expect(content('checks')).not.toContain('test:spec/order')
  })

  it('运行选择器只包含同一轮，切换不会改变报告轮次', async () => {
    await open({ tab: 'checks', round: makeRound({ runs: [makeRun(), makeRun('r2', { checks: [{ caseKey: 'second-case', status: 'passed' }] })] }) })
    await select('run', 'r2')
    expect(content('checks')).toContain('second-case')
    expect(content('checks')).not.toContain('test:spec/order')
    expect($('.ct-dialog-context').textContent).toContain('运行：r2')
    expect($('.ct-dialog-context').textContent).toContain('第 3 轮')
    const { controller } = create()
    await expect(controller.open({ round: makeRound(), runId: 'outside-round' })).rejects.toThrow('不属于')
  })

  it('无运行记录可打开，所有页签不伪造通过或请求', async () => {
    const { api } = await open({ round: makeRound({ runs: [] }) })
    expect(content('report')).toContain('无此类记录，不判定为通过')
    expect($('[data-control="run"]').disabled).toBe(true)
    for (const tab of ['checks', 'timeline', 'logs']) {
      await click(`[data-tab="${tab}"]`)
      expect(content(tab)).toContain('本轮没有')
    }
    expect(api.getLogs).not.toHaveBeenCalled()
    expect(api.getTimeline).not.toHaveBeenCalled()
  })
})

describe('日志：锁包、业务失败与旧接口降级', () => {
  it('清单、文本与媒体链接使用同一个 artifactId，且传入取消信号', async () => {
    const { api } = await open({ tab: 'logs', attempt: 2 })
    expect(api.getLogs).toHaveBeenCalledWith('r1', { artifactId: 'a-r1', signal: expect.any(AbortSignal) })
    expect(api.getLog).toHaveBeenCalledWith('r1', paths[0], { artifactId: 'a-r1', signal: expect.any(AbortSignal) })
    expect(content('logs')).toContain('已锁定日志包：a-r1')
    expect(content('logs')).toContain('包归属：尝试 2')
    expect($('[data-action="file"]').tagName).toBe('BUTTON')
  })

  it('没有快照包 ID 时锁定清单返回的 ID，后续文件仍读取原包', async () => {
    const { api } = await open({ tab: 'logs', round: makeRound({ runs: [makeRun('r1', { artifact: null })] }) })
    expect(api.getLogs.mock.calls[0][1]).not.toHaveProperty('artifactId')
    api.getLogs.mockResolvedValue(pkg('new-artifact'))
    await click(`[data-action="file"][data-path="${paths[1]}"]`)
    expect(api.getLog.mock.lastCall[2].artifactId).toBe('a-r1')
    expect(api.getLogs).toHaveBeenCalledTimes(1)
  })

  it('明确历史 attempt 的最新包不匹配时不读取正文', async () => {
    const { api } = await open({ tab: 'logs', attempt: 1 })
    expect(content('logs')).toContain('尝试 1 的日志不可用')
    expect(content('logs')).toContain('不能用最新包替代')
    expect(api.getLog).not.toHaveBeenCalled()
  })

  it('同轮历史 attempt 有专属 artifactId 时能读取历史包', async () => {
    const api = fakeApi({
      getLogs: vi.fn(async () => pkg('history-1', 1)),
      getLog: vi.fn(async (_run, path) => textFile(path, '历史尝试正文', 'history-1', 1)),
    })
    await open({ tab: 'logs', attempt: 1, round: makeRound({ runs: [makeRun('r1', { attempts: [{ attempt: 1, artifactId: 'history-1' }, { attempt: 2 }] })] }) }, api)
    expect(api.getLogs.mock.lastCall[1].artifactId).toBe('history-1')
    expect(api.getLog.mock.lastCall[2].artifactId).toBe('history-1')
    expect(content('logs')).toContain('历史尝试正文')
  })

  it('旧接口允许运行级最新包，但明确不能锁定且不是历史尝试', async () => {
    const api = fakeApi({
      getLogs: vi.fn(async () => ({ ok: true, attempt: 2, files: fileList(), truncated: true })),
      getLog: vi.fn(async (_run, path) => ({ ok: true, path, text: '旧日志文本', truncated: true })),
    })
    await open({ tab: 'logs', round: makeRound({ runs: [makeRun('r1', { artifact: { attempt: 2 } })] }) }, api)
    expect(content('logs')).toContain('最新包（旧接口未提供 artifactId')
    expect(content('logs')).toContain('不代表历史尝试')
    expect(content('logs')).toContain('日志包已截断')
    expect(content('logs')).toContain('正文已截断')
    expect(content('logs')).toContain('旧日志文本')
    await select('attempt', '2')
    expect(content('logs')).toContain('日志不可用')
    expect(api.getLog).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['清单换包', pkg('wrong-package'), null],
    ['清单丢失锁包字段', { ok: true, attempt: 2, files: fileList() }, null],
    ['正文换包', pkg(), textFile(paths[0], '禁止混包', 'wrong-package')],
    ['正文丢失归属', pkg(), { ok: true, path: paths[0], text: '禁止混包' }],
    ['正文换尝试', pkg(), textFile(paths[0], '禁止混包', 'a-r1', 1)],
    ['正文换路径', pkg(), textFile('wrong.log', '禁止混包')],
  ])('%s 时停止展示，不能悄悄降级最新包', async (_name, listing, file) => {
    const api = fakeApi({ getLogs: vi.fn(async () => listing), ...(file ? { getLog: vi.fn(async () => file) } : {}) })
    await open({ tab: 'logs' }, api)
    expect(content('logs')).not.toContain('禁止混包')
    expect($('[data-log-error]').textContent).not.toBe('')
    if (!file) expect(api.getLog).not.toHaveBeenCalled()
  })

  it.each(['expired', 'scan_rejected', 'not_uploaded', 'missing'])('业务失败 %s 保留具体原因而不是显示空历史', async (reason) => {
    const api = fakeApi({ getLogs: vi.fn(async () => ({ ok: false, reason, files: [] })) })
    await open({ tab: 'logs' }, api)
    expect(content('logs')).toContain(reason)
    expect(content('logs')).toContain('日志不可用')
    expect(api.getLog).not.toHaveBeenCalled()
  })

  it('同步接口失败也被捕获，正文失败保留已读文本及其真实文件名', async () => {
    const { api } = await open({ tab: 'logs' })
    api.getLog.mockImplementation(() => { throw new Error('包已过期，不可再次读取') })
    await click(`[data-action="file"][data-path="${paths[1]}"]`)
    expect(content('logs')).toContain('包已过期')
    expect(content('logs')).toContain(`仍保留先前已加载的文件：${paths[0]}`)
    expect($('.ct-dialog-logtext').textContent).toContain(paths[0])
    const second = create(fakeApi({ getLogs: vi.fn(() => { throw new Error('同步清单失败') }) }))
    controllers[0].close()
    await second.controller.open({ round: makeRound(), tab: 'logs' })
    expect(document.querySelector('dialog[open]').textContent).toContain('同步清单失败')
  })
})

describe('日志：竞态、阅读状态与安全显示', () => {
  it('旧文件响应忽略 AbortSignal 仍不能覆盖新文件', async () => {
    const first = deferred(), second = deferred()
    const api = fakeApi({ getLog: vi.fn((_run, path) => path === paths[0] ? first.promise : second.promise) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound(), tab: 'logs' })
    await flush()
    const signal = api.getLog.mock.calls[0][2].signal
    await click(`[data-action="file"][data-path="${paths[1]}"]`)
    expect(signal.aborted).toBe(true)
    second.resolve(textFile(paths[1], '新文件胜出'))
    await flush()
    first.resolve(textFile(paths[0], '旧请求不可覆盖'))
    await opening
    expect($('.ct-dialog-logtext').textContent).toBe('新文件胜出')
    expect(content('logs')).not.toContain('旧请求不可覆盖')
  })

  it('切换 run 时旧清单不能写入新运行或触发其正文读取', async () => {
    const first = deferred()
    const api = fakeApi({ getLogs: vi.fn((run) => run === 'r1' ? first.promise : Promise.resolve(pkg('a-r2'))) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound({ runs: [makeRun(), makeRun('r2')] }), tab: 'logs' })
    await flush()
    const oldSignal = api.getLogs.mock.calls[0][1].signal
    await select('run', 'r2')
    first.resolve(pkg('a-r1'))
    await opening
    expect(oldSignal.aborted).toBe(true)
    expect($('.ct-dialog-logtext').textContent).toContain('r2')
    expect(api.getLog.mock.calls.every(([run]) => run === 'r2')).toBe(true)
  })

  it('切换 run 时忽略旧正文与旧错误，返回原 run 可重新请求', async () => {
    const first = deferred()
    const api = fakeApi({ getLog: vi.fn((run, path) => run === 'r1' ? first.promise : Promise.resolve(textFile(path, '运行二正文', 'a-r2'))) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound({ runs: [makeRun(), makeRun('r2')] }), tab: 'logs' })
    await flush()
    await select('run', 'r2')
    first.reject(new Error('运行一过期错误，不应污染运行二'))
    await opening
    expect(content('logs')).toContain('运行二正文')
    expect(content('logs')).not.toContain('运行一过期错误')
    api.getLog.mockImplementation(async (run, path) => textFile(path, `恢复 ${run}`, `a-${run}`))
    await select('run', 'r1')
    expect($('.ct-dialog-logtext').textContent).toBe('恢复 r1')
  })

  it('正文通过文本节点显示，搜索仅加载范围，复制仅响应用户点击', async () => {
    const raw = '<img src=x onerror="evil()">错误\n错误 & 安全文本'
    const api = fakeApi({ getLog: vi.fn(async (_run, path) => ({ ...textFile(path, raw), truncated: true })) })
    await open({ tab: 'logs' }, api)
    expect($('.ct-dialog-logtext').textContent).toBe(raw)
    expect($('.ct-dialog-logtext img')).toBeNull()
    expect(clipboard).not.toHaveBeenCalled()
    input('text-search', '错误')
    expect(document.querySelectorAll('.ct-dialog-logtext mark')).toHaveLength(2)
    expect($('[data-search-result]').textContent).toContain('已加载范围内2 处匹配')
    expect($('.ct-dialog-logtext').textContent).toBe(raw)
    await click('[data-action="copy-log"]')
    expect(clipboard).toHaveBeenCalledWith(raw)
    input('file-search', 'other')
    expect(document.querySelectorAll('[data-action="file"]')).toHaveLength(1)
    expect($('[data-action="file"]').textContent).toContain('other.log')
  })

  it('元数据转义显示，复制提交标识不把字段变成 DOM', async () => {
    const malicious = '"><img src=x onerror="evil()">'
    await open({ round: makeRound({ submissionId: malicious, runs: [makeRun('r1', { summary: malicious, reason: malicious })] }) })
    expect(content('report')).toContain(malicious)
    expect(document.querySelector('dialog img')).toBeNull()
    expect(clipboard).not.toHaveBeenCalled()
    await click('[data-action="copy-submission"]')
    expect(clipboard).toHaveBeenCalledWith(malicious)
  })

  it('文件、搜索、换行与滚动在切页签、run 及重新打开时保留', async () => {
    const round = makeRound({ runs: [makeRun(), makeRun('r2')] })
    const { controller } = await open({ tab: 'logs', round })
    await click(`[data-action="file"][data-path="${paths[1]}"]`)
    input('file-search', 'other')
    input('text-search', '正文')
    const wrap = $('[data-control="wrap"]')
    wrap.checked = false
    wrap.dispatchEvent(new window.Event('change', { bubbles: true }))
    $('.ct-dialog-logtext').scrollTop = 150
    $('.ct-dialog-logtext').scrollLeft = 40
    await click('[data-tab="report"]')
    await click('[data-tab="logs"]')
    expect($('.ct-dialog-logtext').scrollTop).toBe(150)
    await select('run', 'r2')
    await select('run', 'r1')
    expect($('[data-control="file-search"]').value).toBe('other')
    expect($('[data-control="text-search"]').value).toBe('正文')
    expect($('.ct-dialog-logtext').dataset.wrap).toBe('false')
    expect($('.ct-dialog-logtext').scrollTop).toBe(150)
    expect($('.ct-dialog-logtext').scrollLeft).toBe(40)
    controller.close()
    await controller.open({ round, tab: 'logs', trigger })
    expect($('[data-action="file"][aria-pressed="true"]').dataset.path).toBe(paths[1])
    expect($('.ct-dialog-logtext').scrollTop).toBe(150)
  })

  it('webm 即使旧接口标 image 仍使用 video，二进制不请求文本', async () => {
    const files = [{ path: 'record.webm', kind: 'image' }, { path: 'archive.zip', kind: 'binary' }, { path: 'shot.png', kind: 'image' }]
    const api = fakeApi({ getLogs: vi.fn(async () => pkg('a-r1', 2, files)) })
    await open({ tab: 'logs', round: makeRound({ runs: [makeRun(), makeRun('r2')] }) }, api)
    expect($('dialog video').controls).toBe(true)
    expect($('dialog video').preload).toBe('none')
    expect($('dialog img')).toBeNull()
    expect(api.logUrl.mock.lastCall[2]).toEqual({ artifactId: 'a-r1' })
    await select('run', 'r2')
    await select('run', 'r1')
    expect($('dialog video')).not.toBeNull()
    await click('[data-path="archive.zip"]')
    expect(content('logs')).toContain('二进制文件不作为文本显示')
    expect($('[data-action="copy-log"]').disabled).toBe(true)
    await click('[data-path="shot.png"]')
    expect($('dialog img').src).toContain('artifactId=a-r1')
    expect(api.getLog).not.toHaveBeenCalled()
  })

  it('媒体地址校验失败时保留已读正文，不误称已保留不存在的文件', async () => {
    const api = fakeApi({
      getLogs: vi.fn(async () => pkg('a-r1', 2, [...fileList(), { path: 'unsafe.png', kind: 'image' }])),
      logUrl: vi.fn(() => 'javascript:evil()'),
    })
    await open({ tab: 'logs' }, api)
    const original = $('.ct-dialog-logtext').textContent
    await click('[data-path="unsafe.png"]')
    expect($('.ct-dialog-logtext').textContent).toBe(original)
    expect($('[data-log-error]').textContent).toContain(`仍保留先前已加载的文件：${paths[0]}`)
    expect($('[data-action="copy-log"]').disabled).toBe(false)
  })

  it('媒体解码失败保留引用，不伪造过期原因或执行失败结论', async () => {
    await open({ tab: 'logs' }, fakeApi({ getLogs: vi.fn(async () => pkg('a-r1', 2, [{ path: 'record.webm', kind: 'image' }])) }))
    $('dialog video').dispatchEvent(new window.Event('error'))
    expect($('[data-log-error]').textContent).toContain('浏览器未提供具体业务原因')
    expect($('.ct-dialog-download').href).toContain('artifactId=a-r1')
    expect($('[data-log-error]').textContent).not.toContain('已过期')
  })

  it('不安全媒体 URL 与伪装文本的二进制内容不进入页面', async () => {
    const api = fakeApi({ getLogs: vi.fn(async () => pkg('a-r1', 2, [{ path: 'shot.png', kind: 'image' }])), logUrl: vi.fn(() => 'javascript:evil()') })
    await open({ tab: 'logs' }, api)
    expect(content('logs')).toContain('不安全的日志地址')
    expect($('dialog img')).toBeNull()
    controllers[0].close()
    const other = create(fakeApi({ getLog: vi.fn(async (_run, path) => textFile(path, '二进制\u0000内容')) }))
    await other.controller.open({ round: makeRound(), tab: 'logs' })
    expect(document.querySelector('dialog[open]').textContent).toContain('检测到二进制内容')
  })
})

describe('时间线：来源、时区、详情与日志导航', () => {
  const timeline = () => ({
    source: 'mixed', summary: { note: '运行级统计' }, failureAnalysis: { reason: '接口错误' }, steps: [
      { attempt: 1, source: 'recorded', status: 'failed', name: '真实事件', at: AT, durationMs: 123, expected: '返回 200', actual: '返回 400', detail: { message: '库存不足' }, note: '原始执行记录', evidence: { path: 'shot.png' } },
      { attempt: 2, source: 'synthesized', status: 'ok', name: '推断事件', at: null, detail: '依据报告推断' },
      { status: 'skip', name: '旧事件', at: null, detail: '无法确认事件来源' },
    ],
  })

  it('按 attempt 分组，记录/推断/混合来源区分，期望实际详情确实可读', async () => {
    await open({ tab: 'timeline' }, fakeApi({ getTimeline: vi.fn(async () => timeline()) }))
    expect(document.querySelectorAll('[data-timeline-attempt]')).toHaveLength(3)
    expect(content('timeline')).toContain('已记录')
    expect(content('timeline')).toContain('由结果推断')
    expect(content('timeline')).toContain('来源未逐项记录')
    expect(content('timeline')).toContain('尝试归属未记录')
    expect(content('timeline')).toContain('返回 200')
    expect(content('timeline')).toContain('返回 400')
    expect(content('timeline')).toContain('库存不足')
    expect(content('timeline')).toContain('原始执行记录')
    expect(content('timeline')).toContain('shot.png')
    expect(content('timeline')).toContain('未记录时间')
    expect(content('timeline')).not.toMatch(/1970|Invalid Date/)
    const detail = $('[data-timeline-attempt="1"] details')
    detail.open = true
    expect(detail.textContent).toContain('库存不足')
  })

  it('头部、报告、时间线使用同一日期及时区格式而不是截取 ISO', async () => {
    await open({ tab: 'timeline', observedAt: AT }, fakeApi({ getTimeline: vi.fn(async () => timeline()) }))
    const formatted = formatDateTime(AT)
    expect($('.ct-dialog-context').textContent).toContain(formatted)
    expect(content('report')).toContain(formatted)
    expect(content('timeline')).toContain(formatted)
    expect(formatted).toContain('2026')
    expect(formatted).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(content('timeline')).not.toContain(AT)
  })

  it('指定 attempt 不展示另一尝试事件，不把旧混合来源标作已记录', async () => {
    await open({ tab: 'timeline', attempt: 2 }, fakeApi({ getTimeline: vi.fn(async () => timeline()) }))
    expect(content('timeline')).not.toContain('真实事件')
    expect(content('timeline')).toContain('推断事件')
    expect(content('timeline')).toContain('旧事件')
    expect($('[data-timeline-attempt=""] .ct-dialog-badge:nth-of-type(2)').textContent).toContain('来源未逐项记录')
  })

  it('看日志等待清单完成、只读指定文件并锁定事件包，不用延迟猜测', async () => {
    const pending = deferred()
    const api = fakeApi({
      getTimeline: vi.fn(async () => ({ steps: [{ attempt: 1, source: 'recorded', name: '旧尝试事件', logPath: paths[1], evidence: { artifactId: 'event-artifact' } }] })),
      getLogs: vi.fn(() => pending.promise),
      getLog: vi.fn(async (_run, path) => textFile(path, '事件指定文件', 'event-artifact', 1)),
    })
    await open({ tab: 'timeline' }, api)
    await click('[data-action="timeline-log"]')
    expect(api.getLog).not.toHaveBeenCalled()
    expect(api.getLogs.mock.lastCall[1].artifactId).toBe('event-artifact')
    pending.resolve(pkg('event-artifact', 1))
    await flush()
    expect(api.getLog).toHaveBeenCalledTimes(1)
    expect(api.getLog.mock.lastCall.slice(0, 2)).toEqual(['r1', paths[1]])
    expect(api.getLog.mock.lastCall[2].artifactId).toBe('event-artifact')
    expect($('.ct-dialog-context').textContent).toContain('尝试 1')
    expect($('[data-tab="logs"]').getAttribute('aria-selected')).toBe('true')
    expect($('.ct-dialog-logtext').textContent).toBe('事件指定文件')
  })

  it('时间线文件不存在时不偷偷显示默认文件', async () => {
    const api = fakeApi({ getTimeline: vi.fn(async () => ({ steps: [{ name: '缺失引用', logPath: 'not-in-package.log' }] })) })
    await open({ tab: 'timeline' }, api)
    await click('[data-action="timeline-log"]')
    expect(content('logs')).toContain('没有文件：not-in-package.log')
    expect(api.getLog).not.toHaveBeenCalled()
  })

  it('接口错误返回其他运行的时间线时拒绝展示', async () => {
    await open({ tab: 'timeline' }, fakeApi({ getTimeline: vi.fn(async () => ({ runId: 'outside-round', steps: [{ name: '其他运行的私有证据' }] })) }))
    expect(content('timeline')).toContain('返回的运行与所选运行不匹配')
    expect(content('timeline')).not.toContain('其他运行的私有证据')
  })

  it('旧时间线响应不能覆盖新 run', async () => {
    const pending = deferred()
    const api = fakeApi({ getTimeline: vi.fn((run) => run === 'r1' ? pending.promise : Promise.resolve({ steps: [{ name: '运行二事件' }] })) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound({ runs: [makeRun(), makeRun('r2')] }), tab: 'timeline' })
    await flush()
    await select('run', 'r2')
    pending.resolve({ steps: [{ name: '运行一旧事件' }] })
    await opening
    expect(content('timeline')).toContain('运行二事件')
    expect(content('timeline')).not.toContain('运行一旧事件')
  })
})

describe('失败诊断：证据、建议与审计反馈', () => {
  it('展示运行级诊断，并在确认建议后等待审计回执再刷新', async () => {
    const suggestion = { suggestionId: 'sug-1', action: 'inspect-product', title: '定位产品失败', category: 'product',
      reason: '产品缺陷', nextStep: '核对接口返回', evidence: { runId: 'r1', source: 'stored_run_report' }, feedback: null }
    const diagnostics = {
      ok: true, runId: 'r1', status: 'failed', unit: 'smoke', side: 'web', phase: 'smoke', terminalReason: 'assertion_failed',
      failureAnalysis: { hasFailure: true, category: 'product', categoryZh: '产品缺陷', firstCaseKey: 'test:spec/order', text: '首错用例：test:spec/order' },
      suggestions: [suggestion], similarFailures: [{ case_key: 'test:spec/order', failure_class: 'product', occurrence_count: 2, status: 'open', error_signature: 'status 400' }],
      similarExperiences: [{ experienceId: 'exp-1', title: '处理状态码错误', content: '核对响应断言', reviewedAt: AT }],
    }
    const confirmed = { ...diagnostics, suggestions: [{ ...suggestion, feedback: { action: 'confirm', author: 'dashboard', createdAt: AT } }] }
    const api = fakeApi({
      getDiagnostics: vi.fn().mockResolvedValueOnce(diagnostics).mockResolvedValueOnce(confirmed),
      submitDiagnosticFeedback: vi.fn(async () => ({ ok: true })),
    })
    await open({ tab: 'diagnostics' }, api)
    expect(content('diagnostics')).toContain('失败阶段')
    expect(content('diagnostics')).toContain('status 400')
    expect(content('diagnostics')).toContain('处理状态码错误')
    expect(content('diagnostics')).toContain('确认建议')
    await click('[data-action="diagnostic-feedback"][data-feedback-action="confirm"]')
    expect(api.submitDiagnosticFeedback).toHaveBeenCalledWith('r1', 'sug-1', expect.objectContaining({ action: 'confirm', signal: expect.any(AbortSignal) }))
    expect(api.getDiagnostics).toHaveBeenCalledTimes(2)
    expect(content('diagnostics')).toContain('已确认建议')
    expect(document.querySelector('[data-action="diagnostic-feedback"]')).toBeNull()
  })
})

describe('运行比较：先展示集合变化再解释结果', () => {
  it('只对当前正式轮中的另一运行比较，并保留不可比说明', async () => {
    const round = makeRound({ runs: [makeRun('r1'), makeRun('r2', { status: 'passed' })] })
    const api = fakeApi()
    await open({ round, runId: 'r1', tab: 'compare' }, api)
    expect(content('compare')).toContain('当前结果不可直接比较')
    expect(content('compare')).toContain('检查项集合发生变化')
    expect(api.compareRuns).toHaveBeenCalledWith('r1', 'r2', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const selector = $('[data-control="compare-run"]')
    expect(selector.options).toHaveLength(1)
    expect(selector.value).toBe('r2')
  })
})

describe('结构化解决经验反馈', () => {
  it('提交解决办法时携带运行证据并保持未验证状态', async () => {
    const data = { ok: true, runId: 'r1', repo: 'fixture-repo', status: 'failed', unit: 'smoke', side: 'web', phase: 'smoke', terminalReason: 'assertion_failed',
      failureAnalysis: { hasFailure: true, category: 'product', categoryZh: '产品缺陷', firstCaseKey: 'test:spec/order' },
      suggestions: [], similarFailures: [], similarExperiences: [] }
    const api = fakeApi({ getDiagnostics: vi.fn(async () => data) })
    await open({ tab: 'diagnostics' }, api)
    const input = $('[data-control="experience-resolution"]')
    input.value = '修复响应码校验，并补充回归断言。'
    input.closest('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await flush()
    expect(api.submitExperienceFeedback).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'fixture-repo', runId: 'r1', sourceType: 'run',
      failureSummary: '产品缺陷 · test:spec/order', resolutionSummary: '修复响应码校验，并补充回归断言。',
      scope: { unit: 'smoke', side: 'web', phase: 'smoke', category: 'product', caseKey: 'test:spec/order' },
      evidence: { runId: 'r1', caseKey: 'test:spec/order', terminalReason: 'assertion_failed', source: 'stored_run_report' },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(content('diagnostics')).toContain('当前为未验证状态')
  })
})

describe('原生模态与生命周期', () => {
  it('原生 showModal/cancel 路径支持 Esc、焦点返回及原有 inert 恢复', async () => {
    const { controller } = create()
    const dialog = $('dialog')
    const showModal = vi.fn(() => { dialog.setAttribute('open', '') })
    Object.defineProperty(dialog, 'showModal', { configurable: true, value: showModal })
    Object.defineProperty(dialog, 'close', { configurable: true, value: () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close')) } })
    await controller.open({ round: makeRound(), trigger })
    expect(showModal).toHaveBeenCalledTimes(1)
    expect(dialog.classList.contains('ct-dialog-fallback')).toBe(false)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect($('.ct-panel').hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe($('[data-action="close"]'))
    const cancel = new window.Event('cancel', { cancelable: true })
    dialog.dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
    expect($('.ct-panel').hasAttribute('inert')).toBe(false)
    expect($('aside').hasAttribute('inert')).toBe(true)
  })

  it('happy-dom 降级模式下 Escape 返回焦点，Tab 可循环', async () => {
    const { controller } = create()
    Object.defineProperty($('dialog'), 'showModal', { value: () => { throw new Error('未实现') } })
    await controller.open({ round: makeRound(), trigger })
    const close = $('[data-action="close"]')
    close.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).not.toBe(trigger)
    expect($('dialog').contains(document.activeElement)).toBe(true)
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect($('dialog').open).toBe(false)
    expect(document.activeElement).toBe(trigger)
  })

  it('触发节点已移除时回到面板入口，页签支持方向键及正确 ARIA', async () => {
    const { controller } = await open()
    const report = $('[data-tab="report"]')
    report.focus()
    report.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await flush()
    expect(document.activeElement).toBe($('[data-tab="checks"]'))
    expect($('[data-tab="checks"]').getAttribute('aria-selected')).toBe('true')
    expect($('[data-panel="checks"]').hidden).toBe(false)
    expect($('[data-panel="report"]').hidden).toBe(true)
    trigger.remove()
    controller.close()
    expect(document.activeElement).toBe($('[data-cloud-testing-entry]'))
    expect($('style[data-ct-evidence-style]').textContent).toContain('min-height:44px')
    expect($('style[data-ct-evidence-style]').textContent).toContain('prefers-reduced-motion')
  })

  it('dispose 取消未完成请求、移除 DOM/样式/监听，旧响应不能复活窗口', async () => {
    const pending = deferred()
    const api = fakeApi({ getLogs: vi.fn(() => pending.promise) })
    const docRemove = vi.spyOn(document, 'removeEventListener')
    const { controller } = create(api)
    const detached = $('dialog'), remove = vi.spyOn(detached, 'removeEventListener')
    const opening = controller.open({ round: makeRound(), tab: 'logs', trigger })
    await flush()
    const signal = api.getLogs.mock.lastCall[1].signal
    controller.dispose()
    expect(signal.aborted).toBe(true)
    expect($('dialog')).toBeNull()
    expect($('style[data-ct-evidence-style]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(docRemove).toHaveBeenCalledWith('keydown', expect.any(Function), undefined)
    expect(remove).toHaveBeenCalledWith('click', expect.any(Function), undefined)
    pending.resolve(pkg())
    await opening
    expect(api.getLog).not.toHaveBeenCalled()
    expect($('dialog')).toBeNull()
    await expect(controller.open({ round: makeRound() })).rejects.toThrow('已经释放')
  })

  it.each(['getLog', 'getTimeline'])('dispose 也取消 %s 的待完成请求', async (method) => {
    const pending = deferred()
    const api = fakeApi({ [method]: vi.fn(() => pending.promise) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound(), tab: method === 'getLog' ? 'logs' : 'timeline' })
    await flush()
    const signal = api[method].mock.lastCall.at(-1).signal
    controller.dispose()
    expect(signal.aborted).toBe(true)
    pending.resolve(method === 'getLog' ? textFile(paths[0], '释放后的响应') : { steps: [{ name: '释放后的响应' }] })
    await opening
    expect($('dialog')).toBeNull()
    expect(document.body.textContent).not.toContain('释放后的响应')
  })

  it('close 后重新打开其他轮，旧正文不会覆盖新轮内容', async () => {
    const pending = deferred()
    const api = fakeApi({ getLog: vi.fn((_run, path) => path === paths[0] ? pending.promise : Promise.resolve(textFile(path, '新正文'))) })
    const { controller } = create(api)
    const opening = controller.open({ round: makeRound(), tab: 'logs' })
    await flush()
    controller.close()
    await controller.open({ round: makeRound({ submissionId: 'sub-next', roundNo: 4 }), tab: 'report' })
    pending.resolve(textFile(paths[0], '旧轮响应'))
    await opening
    expect($('.ct-dialog-context').textContent).toContain('sub-next')
    expect(content('report')).toContain('第 4 轮')
    expect($('dialog').textContent).not.toContain('旧轮响应')
  })
})
