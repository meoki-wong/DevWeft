import { createTestingApi } from './api.js'
import { createCloudTestingStore } from './store.js'
import { createCloudTestingView } from './view.js'
import { canRequeue } from './model.js'
import { createEvidenceDialog } from './evidence-dialog.js'

export { getNodeInfo } from './model.js'

export function mountCloudTesting(root, { repo, taskId, api: requestFn, initialData = null,
  onData = () => {}, onClose = () => {}, subscribe = null }) {
  if (!root || root.nodeType !== 1) throw new TypeError('云端面板需要稳定的根元素')
  const testingApi = createTestingApi({ repo, taskId, request: requestFn })
  const evidence = createEvidenceDialog({ api: testingApi, repo, taskId })
  const operations = Object.create(null)
  const writes = new Set()
  let disposed = false
  root.classList.add('cloud-testing')
  root.setAttribute('aria-label', '云端测试面板')
  const store = createCloudTestingStore({ api: testingApi, repo, taskId, initialData, onData, subscribe,
    document: root.ownerDocument, visible: !root.hidden })
  const render = () => { if (!disposed) view.render(store.getSnapshot(), operations) }
  const findRun = (runId) => {
    const round = store.getSnapshot().selectedRound
    return [...(round?.runs || []), ...(round?.mutations || [])].find((run) => run.runId === runId)
  }
  const focusAction = (action, runId) => {
    const target = [...root.querySelectorAll('button[data-action]')].find((el) => el.dataset.action === action && (!runId || el.dataset.run === runId))
    if (target) target.focus()
  }
  async function requeue(runId) {
    const run = findRun(runId)
    if (!run || !canRequeue(run) || !operations[runId]?.confirm || operations[runId]?.busy) return
    const controller = new AbortController()
    writes.add(controller)
    operations[runId] = { confirm: true, busy: true, error: null }
    render()
    try {
      const result = await testingApi.requeue(runId, { signal: controller.signal })
      if (disposed || controller.signal.aborted) return
      if (result?.ok === false) throw new Error(result.reason || '服务端拒绝重新入队')
      // 只确认请求已接受；执行状态必须等下一份 by-task 事实，不能乐观变绿。
      operations[runId] = { busy: false, confirm: false, message: '重试请求已接受，不新增正式轮；执行状态以刷新结果为准。' }
      render()
      focusAction('requeue', runId)
      await store.refresh({ force: true })
    } catch (error) {
      if (disposed || controller.signal.aborted) return
      operations[runId] = { busy: false, confirm: true, error: `重试未提交成功：${error?.message || '未知错误'}` }
      render()
      focusAction('confirm-requeue', runId)
    } finally { writes.delete(controller) }
  }
  function openEvidence(trigger, roundReport = false) {
    const snapshot = store.getSnapshot()
    if (!snapshot.selectedRound) return
    const round = typeof structuredClone === 'function' ? structuredClone(snapshot.selectedRound) : JSON.parse(JSON.stringify(snapshot.selectedRound))
    const attempt = trigger.dataset.attempt == null ? null : Number(trigger.dataset.attempt)
    try {
      Promise.resolve(evidence.open({ round, runId: roundReport ? null : trigger.dataset.run || null,
        attempt: Number.isFinite(attempt) ? attempt : null, tab: roundReport ? 'report' : trigger.dataset.tab || 'report',
        observedAt: round.observedAt || snapshot.observedAt, trigger })).catch((error) => {
        if (!disposed) view.announce(`证据打开失败：${error?.message || '未知错误'}`)
      })
    } catch (error) { view.announce(`证据打开失败：${error?.message || '未知错误'}`) }
  }
  const view = createCloudTestingView(root, { onAction(action, target) {
    if (disposed) return
    const state = store.getSnapshot()
    if (action === 'refresh') void store.refresh({ force: true })
    else if (action === 'pause') store.setPaused(!state.paused)
    else if (action === 'close') { controller.setVisible(false); onClose() }
    else if (action === 'round') store.selectRound(target.dataset.round || target.value)
    else if (action === 'tab') store.setTab(target.dataset.tab)
    else if (action === 'older' && state.page.nextCursor) void store.loadPage({ before: state.page.nextCursor })
    else if (action === 'newer' && state.trail.length) void store.loadPage({ before: state.trail.at(-1), direction: 'newer' })
    else if (action === 'latest') void store.loadPage({ before: null, direction: 'latest' })
    else if (action === 'evidence') openEvidence(target)
    else if (action === 'round-report') openEvidence(target, true)
    else if (action === 'requeue' && canRequeue(findRun(target.dataset.run))) {
      operations[target.dataset.run] = { confirm: true, busy: false }
      render()
      focusAction('confirm-requeue', target.dataset.run)
    } else if (action === 'cancel-requeue' && !operations[target.dataset.run]?.busy) {
      delete operations[target.dataset.run]
      render()
      focusAction('requeue', target.dataset.run)
    } else if (action === 'confirm-requeue') void requeue(target.dataset.run)
    else if (action === 'copy') {
      const clipboard = root.ownerDocument.defaultView?.navigator?.clipboard
      if (!clipboard?.writeText) { view.announce('当前环境不支持自动复制，请在元信息中选择文本复制。'); return }
      Promise.resolve(clipboard.writeText(target.dataset.copy || '')).then(() => {
        if (!disposed) view.announce('已复制')
      }).catch(() => { if (!disposed) view.announce('复制失败，请选择文本手动复制。') })
    }
  } })
  const unlisten = store.listen(render)
  const controller = {
    update(data) { return store.update(data) },
    refresh() { return store.refresh({ force: true }) },
    setVisible(visible) {
      if (disposed) return
      root.hidden = !visible
      if (!visible) evidence.close()
      store.setVisible(visible)
    },
    getSnapshot() { return store.getSnapshot() },
    dispose() {
      if (disposed) return
      disposed = true
      for (const controller of writes) controller.abort()
      writes.clear()
      unlisten()
      store.dispose()
      evidence.dispose()
      view.dispose()
      root.classList.remove('cloud-testing')
    },
  }
  store.start()
  return controller
}
