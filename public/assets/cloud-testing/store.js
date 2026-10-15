import { normalizeData } from './model.js'

// 上下文版本优先于时间；历史页和当前摘要分别仲裁，不能拼成伪原子快照。
export function compareObservation(next, previous) {
  if (!previous) return 1
  if (next.version < previous.version) return -1
  const a = next.context || {}, b = previous.context || {}
  for (const key of ['epoch', 'revision']) {
    if (Number.isFinite(a[key]) && Number.isFinite(b[key]) && a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  const at = Date.parse(next.observedAt), bt = Date.parse(previous.observedAt)
  return Number.isFinite(at) && Number.isFinite(bt) ? Math.sign(at - bt) : 0
}

export function createCloudTestingStore({ api, repo, taskId, initialData = null, onData = () => {}, subscribe = null,
  document: doc = globalThis.document, pollMs = 5000, now = () => Date.now(), visible = true } = {}) {
  const listeners = new Set()
  const rounds = new Map()
  const roundObservations = new Map()
  const empty = normalizeData()
  const state = {
    repo, taskId, summary: empty.summary, currentAcceptance: null, task: {}, data: null, initialized: false,
    total: null, latestId: null, selectedId: null, navIds: [], page: empty.page, trail: [], tab: 'execution',
    visible, paused: false, pageHidden: Boolean(doc?.hidden), loading: false, pageLoading: false,
    error: null, pageError: null, lastSuccessAt: null, observedAt: null, newRound: false,
  }
  let disposed = false, started = false, timer = null, unsubscribe = null
  let refreshGeneration = 0, pageGeneration = 0, refreshing = null, paging = null
  let refreshAbort = null, pageAbort = null, lastRequestAt = -Infinity
  const active = () => started && !disposed && state.visible && !state.paused && !state.pageHidden
  const snapshot = () => ({ ...state, navIds: [...state.navIds], trail: [...state.trail], page: { ...state.page },
    rounds: [...rounds.values()], selectedRound: rounds.get(state.selectedId) || null,
    navigation: [...new Set([...state.navIds, ...(state.selectedId ? [state.selectedId] : [])])].map((id) => rounds.get(id)).filter(Boolean),
    refreshing: state.loading || state.pageLoading, automatic: active(), disposed,
  })
  const emit = () => { if (!disposed) for (const listener of listeners) listener(snapshot()) }
  const matches = (data) => {
    const context = data?.summary?.context
    return (!context?.repo || context.repo === repo) && (!context?.taskId || context.taskId === taskId)
  }
  const notifyData = (data) => {
    // 宿主的缓存回调不是网络请求的一部分，回调失败不能触发分页回滚。
    try { onData(data) } catch { /* 宿主独立负责回调错误。 */ }
  }
  function apply(data, kind, requestedBefore = null, trail = []) {
    if (disposed) return { status: 'stale' }
    if (!matches(data)) return { status: 'failed', error: new Error('响应不属于当前仓库或任务') }
    const model = normalizeData(data)
    if (kind === 'page' && model.page.before !== requestedBefore) return { status: 'failed', error: new Error('分页响应游标不一致') }
    const observedAt = model.summary.observedAt || new Date(now()).toISOString()
    const currentEligible = model.summary.version === 1 || !model.page.before
    const fresh = !state.initialized || compareObservation(model.summary, state.summary) >= 0
    if (currentEligible && !fresh && (kind !== 'page' || !requestedBefore)) return { status: 'stale' }
    for (const round of model.rounds) {
      const previous = roundObservations.get(round.submissionId)
      if (previous && compareObservation(model.summary, previous) < 0) continue
      // 相同正文保留对象；截至时间独立记录，视图不因此重建历史正文。
      const old = rounds.get(round.submissionId)
      const candidate = { ...round, observedAt }
      rounds.set(round.submissionId, old && JSON.stringify({ ...old, observedAt }) === JSON.stringify(candidate) ? { ...old, observedAt } : candidate)
      roundObservations.set(round.submissionId, model.summary)
    }
    if (currentEligible && fresh) {
      const previousLatest = state.latestId
      state.summary = model.summary
      state.currentAcceptance = model.currentAcceptance
      state.task = model.task
      state.total = model.total
      state.observedAt = observedAt
      // 新摘要的空值表示当前实例尚无正式轮，不能拿历史首页补成当前最新。
      state.latestId = model.summary.version === 1 ? model.summary.latestSubmissionId
        : model.summary.latestSubmissionId || (!model.page.before ? model.rounds[0]?.submissionId : null) || state.latestId
      if (!state.latestId) state.newRound = false
      else if (previousLatest && state.latestId !== previousLatest && state.selectedId !== state.latestId) state.newRound = true
    }
    if (!state.initialized || kind === 'page' || (!state.page.before && !model.page.before)) {
      state.navIds = model.rounds.map((round) => round.submissionId)
      state.page = model.page
    }
    if (!state.selectedId || kind === 'page') {
      state.selectedId = model.rounds[0]?.submissionId || state.selectedId
      if (state.selectedId === state.latestId) state.newRound = false
    }
    if (kind === 'page') {
      state.trail = trail
      state.pageError = null
    } else state.error = null
    state.initialized = true
    // 共享给宿主的始终是原始首页 by-task，不能用旧历史页毒化节点缓存。
    if (!model.page.before && fresh) {
      const changed = state.data !== data
      state.data = data
      state.lastSuccessAt = new Date(now()).toISOString()
      if (changed) notifyData(data)
    }
    return { status: 'applied', data }
  }
  function cancelRequests() {
    refreshGeneration++
    pageGeneration++
    refreshAbort?.abort()
    pageAbort?.abort()
    refreshAbort = pageAbort = null
    refreshing = paging = null
    state.loading = state.pageLoading = false
  }
  const sharedData = (result) => {
    if (result.status === 'applied') return result.data
    if (result.status === 'failed') throw result.error
    throw new DOMException('请求已过期', 'AbortError')
  }
  function refresh({ force = false, automatic = false } = {}) {
    if (disposed || !state.visible || state.pageHidden || (automatic && !active())) return Promise.resolve({ status: 'stale' })
    if (refreshing) return refreshing
    // SSE 与轮询在同一拍完成也合并；显式刷新与恢复不受冷却影响。
    if (!force && now() - lastRequestAt < 250) return Promise.resolve({ status: 'stale' })
    lastRequestAt = now()
    const generation = ++refreshGeneration
    const controller = new AbortController()
    refreshAbort = controller
    state.loading = true
    emit()
    const shared = paging?.before === null ? paging.promise : null
    refreshing = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError')
      return shared ? shared.then(sharedData) : api.getPage({ before: null, limit: 5, signal: controller.signal })
    }).then((data) => {
      if (disposed || generation !== refreshGeneration || controller.signal.aborted) return { status: 'stale' }
      const result = apply(data, 'refresh')
      if (result.status === 'failed') state.error = result.error.message
      return result
    }).catch((error) => {
      if (disposed || generation !== refreshGeneration || controller.signal.aborted || error?.name === 'AbortError') return { status: 'stale' }
      state.error = error?.message || '当前摘要刷新失败'
      return { status: 'failed', error }
    }).finally(() => {
      if (generation !== refreshGeneration || disposed) return
      state.loading = false
      refreshing = null
      refreshAbort = null
      emit()
    })
    return refreshing
  }
  function loadPage({ before = null, direction = before ? 'older' : 'latest' } = {}) {
    if (disposed || !state.visible || state.pageHidden) return Promise.resolve({ status: 'stale' })
    // 相同游标共享请求；不同导航具有独立代次，旧响应不回滚 cursor/trail。
    if (paging?.before === before) return paging.promise
    pageAbort?.abort()
    const generation = ++pageGeneration
    const controller = new AbortController()
    pageAbort = controller
    const trail = direction === 'latest' ? [] : direction === 'newer' ? state.trail.slice(0, -1) : [...state.trail, state.page.before]
    state.pageLoading = true
    state.pageError = null
    emit()
    const shared = before === null ? refreshing : null
    const promise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new DOMException('请求已取消', 'AbortError')
      return shared ? shared.then(sharedData) : api.getPage({ before, limit: 5, signal: controller.signal })
    }).then((data) => {
      if (disposed || generation !== pageGeneration || controller.signal.aborted) return { status: 'stale' }
      const result = apply(data, 'page', before, trail)
      if (result.status === 'failed') state.pageError = result.error.message
      return result
    }).catch((error) => {
      if (disposed || generation !== pageGeneration || controller.signal.aborted || error?.name === 'AbortError') return { status: 'stale' }
      state.pageError = error?.message || '历史轮次加载失败'
      return { status: 'failed', error }
    }).finally(() => {
      if (generation !== pageGeneration || disposed) return
      paging = null
      pageAbort = null
      state.pageLoading = false
      emit()
    })
    paging = { before, promise }
    return promise
  }
  function syncLifecycle(resume = false) {
    if (timer !== null) clearInterval(timer)
    timer = null
    if (active()) {
      timer = setInterval(() => { void refresh({ automatic: true }) }, pollMs)
      if (resume) void refresh({ force: true, automatic: true })
    } else cancelRequests()
    emit()
  }
  const visibilityChanged = () => {
    const wasActive = active()
    state.pageHidden = Boolean(doc?.hidden)
    syncLifecycle(!wasActive && active())
  }
  const store = {
    getSnapshot: snapshot,
    listen(listener) { listeners.add(listener); listener(snapshot()); return () => listeners.delete(listener) },
    update(data) {
      if (disposed) return { status: 'stale' }
      // 外部共享快照比之前发出的请求更新；即使旧后端没有时间戳也不会旧回滚。
      refreshGeneration++
      refreshAbort?.abort()
      refreshing = refreshAbort = null
      state.loading = false
      if (paging?.before === null) {
        pageGeneration++
        pageAbort?.abort()
        paging = pageAbort = null
        state.pageLoading = false
      }
      const result = apply(data, 'external')
      if (result.status === 'failed') state.error = result.error.message
      emit()
      return result
    },
    refresh, loadPage,
    selectRound(id) {
      if (disposed || !rounds.has(id)) return
      state.selectedId = id
      if (id === state.latestId) state.newRound = false
      emit()
    },
    setTab(tab) { if (!disposed && ['execution', 'mutation', 'inputs'].includes(tab)) { state.tab = tab; emit() } },
    setPaused(paused) {
      if (disposed || state.paused === Boolean(paused)) return
      const wasActive = active()
      state.paused = Boolean(paused)
      syncLifecycle(!wasActive && active())
    },
    setVisible(value) {
      if (disposed || state.visible === Boolean(value)) return
      const wasActive = active()
      state.visible = Boolean(value)
      syncLifecycle(!wasActive && active())
    },
    start() {
      if (started || disposed) return
      started = true
      doc?.addEventListener('visibilitychange', visibilityChanged)
      if (typeof subscribe === 'function') unsubscribe = subscribe((event) => {
        if (!active() || (event?.repo && event.repo !== repo) || (event?.taskId && event.taskId !== taskId)) return
        void refresh({ automatic: true })
      })
      syncLifecycle(!state.initialized)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== null) clearInterval(timer)
      timer = null
      cancelRequests()
      doc?.removeEventListener('visibilitychange', visibilityChanged)
      if (typeof unsubscribe === 'function') unsubscribe()
      listeners.clear()
    },
  }
  if (initialData !== null) apply(initialData, 'external')
  return store
}
