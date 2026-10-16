/* ═══════════════════════════════════════════════════════════
   Agent Workflow Platform — 前端逻辑
   视图：总览 / 经验库 / 调用流 / 任务 / 测试资产 / 知识库
   ═══════════════════════════════════════════════════════════ */

/* ─── 全局状态 ─────────────────────────────────────────── */
const state = {
  repo: localStorage.getItem('awp.repo') || 'demo-app',
  username: localStorage.getItem('awp.username') || '',
  route: 'overview',
  labels: { phases: {} },
  live: { events: [], connected: false },
  exp: { keyword: '', status: 'all', source: 'all', module: '', page: 1, pageSize: 20, items: [], total: 0, facets: null, loading: false, expanded: new Set() },
  act: { author: '', cats: new Set(['init', 'harness', 'knowledge', 'records', 'http', 'review', 'mcp']), paused: false },
  tasks: { status: 'open', items: [], wfCache: new Map() },
  docs: { keyword: '', selected: null, content: null, versions: null, showVersions: false },
  specs: { q: '', type: '', status: '', side: '', sort: 'updated', module: '', catalog: null, drawer: null },
  trends: { days: 30 },
}

const $ = (sel, root) => (root || document).querySelector(sel)
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)]

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// 保持 classic script，只按需加载云端测试模块。
const dashboardBuild = new URL(document.currentScript?.src || location.href).searchParams.get('v')
let cloudTestingModule = null
let cloudTestingImport = null
function loadCloudTesting() {
  if (!cloudTestingImport) {
    cloudTestingImport = import('./cloud-testing/index.js' + (dashboardBuild ? `?v=${encodeURIComponent(dashboardBuild)}` : ''))
      .then((module) => { cloudTestingModule = module; return module })
      .catch((error) => { cloudTestingImport = null; throw error })
  }
  return cloudTestingImport
}

async function api(path, opts) {
  const res = await fetch(path, opts)
  let data = {}
  try { data = await res.json() } catch { /* 非 JSON 错误体 */ }
  if (!res.ok || data.error) throw new Error(data.error || `${res.status} ${res.statusText}`)
  return data
}

/* ─── 时间 / 展示工具 ──────────────────────────────────── */
// 时间解析统一入口（2026-09-26 修复看板时间）：空值/非法值返回 null（渲染 '—'），
// 无时区后缀的历史串按 UTC 处理（服务端 utcNow 统一 UTC 落库）。
function parseTs(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const normalized = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z'
  const d = new Date(normalized)
  return Number.isFinite(d.getTime()) ? d : null
}
function relTime(iso) {
  const d = parseTs(iso)
  if (!d) return '—'
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 50) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  const p = (n) => String(n).padStart(2, '0')
  if (diff < 172800) return `昨天 ${p(d.getHours())}:${p(d.getMinutes())}`
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function fmtDateTime(iso) {
  const d = parseTs(iso)
  if (!d) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function fmtBytes(n) {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function avatar(name) {
  const ch = String(name || '?').trim().charAt(0) || '?'
  let h = 0
  for (const c of String(name || '?')) h = (h * 31 + c.charCodeAt(0)) % 360
  return `<span class="avatar" style="background:hsl(${h},52%,48%)" title="${esc(name)}">${esc(ch)}</span>`
}
function toast(msg, type = 'info') {
  const el = document.createElement('div')
  el.className = `toast ${type}`
  el.innerHTML = `${type === 'ok' ? '✓' : type === 'err' ? '✕' : 'ℹ'} <span>${esc(msg)}</span>`
  $('#toasts').appendChild(el)
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320) }, 3200)
}

/* ─── 迷你 Markdown 渲染（知识库文档展示用） ───────────── */
function mdInline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<span title="$2">$1</span>')
}
function mdToHtml(src) {
  const lines = String(src || '').split('\n')
  let html = '', inCode = false, inList = false, para = []
  const flushP = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = [] } }
  const flushL = () => { if (inList) { html += '</ul>'; inList = false } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().startsWith('```')) {
      flushP(); flushL()
      if (inCode) { html += '</code></pre>'; inCode = false } else { html += '<pre><code>'; inCode = true }
      continue
    }
    if (inCode) { html += esc(raw) + '\n'; continue }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { flushP(); flushL(); const lv = Math.min(5, h[1].length + 1); html += `<h${lv}>${mdInline(h[2])}</h${lv}>`; continue }
    const li = line.match(/^\s*[-*•]\s+(.*)$/)
    if (li) { flushP(); if (!inList) { html += '<ul>'; inList = true } html += `<li>${mdInline(li[1])}</li>`; continue }
    const oli = line.match(/^\s*\d+[.、)]\s+(.*)$/)
    if (oli) { flushP(); if (!inList) { html += '<ul>'; inList = true } html += `<li>${mdInline(oli[1])}</li>`; continue }
    const bq = line.match(/^&gt;\s?(.*)$|^>\s?(.*)$/)
    if (bq) { flushP(); flushL(); html += `<blockquote>${mdInline(bq[1] ?? bq[2])}</blockquote>`; continue }
    if (!line.trim()) { flushP(); flushL(); continue }
    para.push(mdInline(line))
  }
  if (inCode) html += '</code></pre>'
  flushP(); flushL()
  return html
}

/* ─── 事件分类（调用流 / 总览共用） ─────────────────────── */
const CAT_META = {
  init:      { icon: '⇋', label: '连接',   icoBg: 'c-init' },
  harness:   { icon: '⏵', label: '阶段',   icoBg: 'c-harness' },
  knowledge: { icon: '▤', label: '知识',   icoBg: 'c-knowledge' },
  records:   { icon: '✦', label: '经验',   icoBg: 'c-records' },
  http:      { icon: '⇄', label: 'HTTP',   icoBg: 'c-http' },
  review:    { icon: '✔', label: '评审',   icoBg: 'c-review' },
  mcp:       { icon: '◆', label: '工具',   icoBg: 'c-mcp' },
}
function catOf(ev) {
  if (ev.event_type === 'exp_review') return 'review'
  const t = ev.tool_name || ''
  if (t.startsWith('harness_')) return 'harness'
  if (['get_doc', 'list_docs', 'query_docs', 'update_doc'].includes(t)) return 'knowledge'
  if (['distill_query', 'distill_append', 'distill_set_status', 'task_state', 'verify_report', 'drift_stats', 'lesson_record'].includes(t)) return 'records'
  if ((ev.event_type || '').startsWith('http')) return 'http'
  if (ev.event_type === 'mcp_init') return 'init'
  return 'mcp'
}
function evDesc(ev) {
  return ev.summary_zh || ev.detail || (ev.tool_name ? `【工具调用】${ev.tool_name}` : ev.event_type || '系统事件')
}
function evDescHtml(ev) {
  return esc(evDesc(ev)).replace(/【([^】]+)】/g, '<span class="accent">【$1】</span>')
}

/* ═══ SSE 实时流（全局单连接） ═══ */
let es = null
function connectStream() {
  if (es) es.close()
  es = new EventSource('/api/audit/stream')
  es.onopen = () => { state.live.connected = true; updateLiveBadge() }
  es.onerror = () => { state.live.connected = false; updateLiveBadge() }
    es.onmessage = (msg) => {
      let ev
      try { ev = JSON.parse(msg.data) } catch { return }
      if (ev.type === 'connected') return
      if (ev.event_type === 'http_harness_status') return
      if (state.live.events.some((e) => e.id === ev.id)) return
      state.live.events.unshift(ev)
      if (state.live.events.length > 300) state.live.events.pop()
      if (state.route === 'activity' && !state.act.paused) prependActivityEvent(ev)
      if (state.route === 'overview') prependOverviewFeed(ev)
      // 门禁/工作流相关事件：立即刷新已展开任务（隔离异常）
      try {
        if (GATE_SSE_TOOLS.has(ev.tool_name)) {
          for (const listener of gateListeners) {
            try { listener(ev) } catch { /* 单个面板失败不影响其他订阅者。 */ }
          }
          refreshOpenGateCards(ev)
        }
        if (
          ev.tool_name === 'harness_advance'
          || ev.tool_name === 'harness_start'
          || ev.tool_name === 'test_run_status'
        ) {
          refreshOpenTaskWorkflows(ev)
        }
      } catch { /* ignore */ }
    }
}

const GATE_SSE_TOOLS = new Set([
  'awp_test_run', 'awp_loop_wait', 'awp_loop_resume',
  'awp_test_spec_submit', 'distill_append', 'harness_advance',
  // 服务端轮询桥：host-worker 完成/失败 run 时推送（独立进程不走 MCP SSE）
  'test_run_status',
])

// 任务宿主负责收起态摘要；可见面板的 5s 轮询只由控制器负责。
const openTaskDetails = new Map()
const gateListeners = new Set()
let taskViewGeneration = 0
let taskListAbort = null
const taskKey = (repo, taskId) => JSON.stringify([repo, taskId])
const taskIsActive = (rec) => !rec.disposed && rec.row.isConnected && rec.row.classList.contains('open') && !document.hidden

function eventMatchesTask(event, rec) {
  if (!event) return true
  const taskId = event.task_id || event.taskId
  if (taskId && taskId !== rec.taskId) return false
  // 审计中的 repo 可能是 UUID；只在确认是已知 slug 时排除其他仓库。
  const knownRepo = event.repo && state.tasks.items.some((task) => task.repo === event.repo)
  return !knownRepo || event.repo === rec.repo
}
function cancelTaskRequests(rec) {
  rec.generation++
  for (const request of rec.requests.values()) request.abort.abort()
  rec.requests.clear()
  rec.loading = null
}
function disposeTaskRecord(rec) {
  if (rec.disposed) return
  rec.disposed = true
  cancelTaskRequests(rec)
  rec.controller?.dispose()
  openTaskDetails.delete(rec.key)
}
function disposeTaskViews() {
  taskViewGeneration++
  taskListAbort?.abort()
  taskListAbort = null
  for (const rec of openTaskDetails.values()) disposeTaskRecord(rec)
  gateListeners.clear()
  state.tasks.wfCache.clear()
}

// 同一任务的相同读取共享 promise；收起、隐藏、重绘均取消，并拒绝迟到响应。
function taskRequest(rec, path, options = {}) {
  if (!taskIsActive(rec) || options.signal?.aborted) return Promise.reject(new DOMException('请求已取消', 'AbortError'))
  const url = new URL(path, location.href)
  url.searchParams.sort()
  const key = `${options.method || 'GET'} ${url.pathname}${url.search}`
  let pending = rec.requests.get(key)
  if (!pending || pending.abort.signal.aborted) {
    const abort = new AbortController()
    pending = { abort, promise: null }
    pending.promise = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw new DOMException('请求已取消', 'AbortError')
      return api(path, { ...options, signal: abort.signal })
    }).then((data) => {
      if (abort.signal.aborted || !taskIsActive(rec)) throw new DOMException('请求已过期', 'AbortError')
      return data
    }).finally(() => { if (rec.requests.get(key) === pending) rec.requests.delete(key) })
    rec.requests.set(key, pending)
  }
  const onAbort = () => pending.abort.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  return pending.promise.finally(() => options.signal?.removeEventListener('abort', onAbort))
}
function acceptTaskGateData(rec, data) {
  if (rec.disposed || !rec.row.isConnected || !data || (data.page?.before || data.flow?.page?.before)) return
  const context = data.summary?.context
  if ((context?.repo && context.repo !== rec.repo) || (context?.taskId && context.taskId !== rec.taskId)) return
  rec.data = data
  state.tasks.wfCache.set(rec.key, data)
  updateTaskGateSummary(rec)
}
async function refreshTaskGateSummary(rec) {
  if (!taskIsActive(rec) || rec.controller?.getSnapshot().visible) return
  const generation = rec.generation
  try {
    const data = await taskRequest(rec, `/api/testing/by-task/${encodeURIComponent(rec.taskId)}?repo=${encodeURIComponent(rec.repo)}&limit=5`)
    if (!taskIsActive(rec) || generation !== rec.generation) return
    acceptTaskGateData(rec, data)
    if (!rec.controller?.getSnapshot().visible && rec.data === data) rec.controller?.update(data)
  } catch { /* 保留上次成功的首页，不以失败清空摘要。 */ }
}
function activeTaskRecords(event) {
  if (state.route !== 'tasks' || document.hidden) return []
  const records = []
  for (const rec of openTaskDetails.values()) {
    if (!rec.row.isConnected) { disposeTaskRecord(rec); continue }
    if (taskIsActive(rec) && eventMatchesTask(event, rec)) records.push(rec)
  }
  return records
}
function refreshOpenGateCards(event) {
  return Promise.all(activeTaskRecords(event).map((rec) => rec.loading || refreshTaskGateSummary(rec)))
}
function refreshOpenTaskWorkflows(event) {
  return Promise.all(activeTaskRecords(event).map((rec) => rec.loading || refreshTaskWorkflow(rec)))
}
setInterval(() => {
  if (document.hidden || !openTaskDetails.size) return
  void refreshOpenGateCards()
  void refreshOpenTaskWorkflows()
}, 5000)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    for (const rec of openTaskDetails.values()) cancelTaskRequests(rec)
  } else {
    // 可见控制器会自行恢复一次；宿主只恢复未完成的首读或收起态摘要。
    for (const rec of activeTaskRecords()) {
      if (rec.detail.dataset.loaded !== '1') void fillTaskDetail(rec.row)
      else { void refreshTaskGateSummary(rec); void refreshTaskWorkflow(rec) }
    }
  }
})

/* ─── UI 链路分叉（双泳道）：主链一行走到黑（✗ 废弃、虚线），备用链下方平行续跑（amber 主色） ─── */
/* 布局：泳道为 CSS Grid（rail 定宽列 + 节点数等分列），卡片充满所在列；分叉连线坐标渲染后按实测 DOM 定位 */
const WF2 = { LANE_GAP: 74 }

function wf2Clock(iso) {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d) ? d.toTimeString().slice(0, 8) : ''
}
function wf2SeqAt(wf, i) {
  return wf.slice(0, i).filter((s) => s.phase !== 'GATE_TEST').length + 1
}
const WF2_ICONS = {
  done: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.6 6.3l2.3 2.3 4.5-4.9" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bdone: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.6 6.3l2.3 2.3 4.5-4.9" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fork: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3.4 3.4l5.2 5.2M8.6 3.4L3.4 8.6" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  dead: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3.4 3.4l5.2 5.2M8.6 3.4L3.4 8.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  now: '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M4.2 2.8l5 3.2-5 3.2z" fill="#fff"/></svg>',
  wait: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.6 6.3l2.3 2.3 4.5-4.9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}
function wf2Card(s, variant, num = '', attrs = '') {
  const sub = { done: '已完成', fork: '已中断', dead: '未执行', bdone: '已完成', now: '执行中…', wait: '待执行', cur: '执行中…', pend: '待执行' }[variant] || ''
  const ico = WF2_ICONS[variant] || `<span style="font-size:10px;font-weight:700">${esc(String(num))}</span>`
  return `<div class="wf2-card ${variant}"${attrs} title="${esc(s.summary || s.name || '')}">
    <span class="wf2-ico" aria-hidden="true">${ico}</span>
    <span class="wf2-nm">${esc(s.name || '')}</span>
    <span class="wf2-st">${esc(sub)}</span>
  </div>`
}
/** 门禁节点卡：外壳承担卡片视觉/废弃态，内部按钮类名由 updateTaskGateSummary 托管（保持交互与 aria 不变）。 */
function wf2GateWrap(s, dead, rec) {
  return `<div class="wf2-card wf2-gate-wrap${dead ? ' dead' : ''}">${wfStepHtml(s, 0, rec.root.id, !rec.root.hidden)}</div>`
}
/** 渲染后按实测 DOM 定位分叉连线与徽标（任意节点数/任意宽度都对齐，resize 时重算）。 */
function layoutWf2Wires(scope) {
  const svg = scope?.querySelector?.('.wf2-wires')
  const forkEl = scope?.querySelector?.('[data-wf2-fork]')
  const liveEl = scope?.querySelector?.('[data-wf2-backup-start]')
  if (!svg || !forkEl || !liveEl) return
  const canvas = svg.parentElement
  const cb = canvas.getBoundingClientRect()
  if (!cb.width || !cb.height) return
  const f = forkEl.getBoundingClientRect()
  const l = liveEl.getBoundingClientRect()
  const x = Math.round(f.left + f.width / 2 - cb.left)
  const y1 = Math.round(f.bottom - cb.top) + 2
  const y2 = Math.round(l.top - cb.top) - 6
  const grad = svg.querySelector('linearGradient')
  if (grad) {
    grad.setAttribute('x1', String(x)); grad.setAttribute('y1', String(y1))
    grad.setAttribute('x2', String(x)); grad.setAttribute('y2', String(y2))
  }
  const flow = svg.querySelector('.wf2-flow')
  if (flow) flow.setAttribute('d', `M ${x} ${y1} C ${x} ${y1 + 22}, ${x} ${y2 - 22}, ${x} ${y2}`)
  const arrow = svg.querySelector('.wf2-arrow')
  if (arrow) arrow.setAttribute('d', `M ${x - 4} ${y2 - 7} L ${x} ${y2 + 2} L ${x + 4} ${y2 - 7}`)
  const badge = canvas.querySelector('.wf2-badge')
  if (badge) {
    badge.hidden = false
    badge.style.left = `${x + 14}px`
    badge.style.top = `${Math.round((y1 + y2) / 2) - 13}px`
  }
}
/**
 * UI 链路分叉（双泳道）：支持多事件时间序列（fork/recover），实现"分叉→合流"视图。
 * - fork 段：主泳道 dead（✗ 废弃），备用泳道 bdone/now/wait（保留已完成节点，不消失）
 * - recover 段：备用泳道结束，主泳道恢复 live（正常颜色）
 * - 修复 forkIdx 推进 bug：stepIndex 只在分叉时计算一次，不随备用完成而推进
 */
function wfForkHtml(wf, events, rec) {
  const n = wf.length

  // 计算每个事件的 stepIndex（在 workflow 中的索引）
  const eventsWithIndex = events.map((ev) => {
    let stepIndex = wf.findIndex((s) => (s.phase || '').toLowerCase() === String(ev.phase || '').toLowerCase())
    // advance 类调用记录的是 from-phase（已完成）→ 顺延到 to-phase（首个未完成步）
    // 关键：这个顺延只在分叉时计算一次，不随备用完成而推进（修复原 while 循环 bug）
    if (stepIndex >= 0 && ev.toolName === 'harness_advance' && stepIndex < n - 1) {
      stepIndex++
    }
    if (stepIndex < 0) stepIndex = wf.findIndex((s) => s.status !== 'done')
    if (stepIndex < 0) stepIndex = Math.max(n - 1, 0)
    return { ...ev, stepIndex }
  })

  // 找到第一个 fork 和第一个 recover（简化：只处理单 fork + 单 recover，多段后续扩展）
  const forkEvent = eventsWithIndex.find((e) => e.type === 'fork')
  const recoverEvent = eventsWithIndex.find((e) => e.type === 'recover')

  if (!forkEvent) {
    // 没有 fork 事件，降级到线性视图
    return wfLinearCardsHtml(wf, rec)
  }

  const forkIdx = forkEvent.stepIndex
  const recoverIdx = recoverEvent ? recoverEvent.stepIndex : null

  // 主泳道卡片
  const mainCards = wf
    .map((s, i) => {
      if (s.phase === 'GATE_TEST') {
        // 门禁节点：fork 之后且 recover 之前（或无 recover）标为 dead
        const isDead = i >= forkIdx && (recoverIdx === null || i < recoverIdx)
        return wf2GateWrap(s, isDead, rec)
      }
      if (i < forkIdx) {
        // fork 之前：正常显示（done/plain）
        return wf2Card(s, s.status === 'done' ? 'done' : 'plain', wf2SeqAt(wf, i))
      }
      if (recoverIdx !== null && i >= recoverIdx) {
        // recover 之后：主链路恢复，正常显示（done/current/pending）
        const v = s.status === 'done' ? 'done' : s.status === 'current' ? 'cur' : 'pend'
        return wf2Card(s, v, wf2SeqAt(wf, i))
      }
      // fork → recover 之间（或无 recover）：主链路废弃
      return wf2Card(s, i === forkIdx ? 'fork' : 'dead', '', i === forkIdx ? ' data-wf2-fork="1"' : '')
    })
    .join('')

  // 备用泳道卡片：只显示 fork→recover 之间的节点（recover 之后不显示，形成"合流"效果）
  const backupEndIdx = recoverIdx !== null ? recoverIdx : n
  const backupCards = wf
    .slice(forkIdx, backupEndIdx)
    .map((s, k) => {
      const i = forkIdx + k
      if (s.phase === 'GATE_TEST') return wf2GateWrap(s, false, rec)
      // 备用链路完成的节点保留为 bdone，不消失（修复用户反馈的 bug）
      const v = s.status === 'done' ? 'bdone' : s.status === 'current' ? 'now' : 'wait'
      return wf2Card(s, v, wf2SeqAt(wf, i), k === 0 ? ' data-wf2-backup-start="1"' : '')
    })
    .join('')

  const clock = wf2Clock(forkEvent.at)
  const gradId = 'wf2g-' + String(forkEvent.callId || 'x').replace(/[^a-zA-Z0-9-]/g, '')

  const primaryLabel = forkEvent.fromLabel || '主链路'
  const backupLabel = forkEvent.toLabel || '备用链路'

  // 主泳道状态标签
  const primaryStatus =
    recoverIdx !== null
      ? `<span class="wf2-rail-tag live">已恢复</span>`
      : `<span class="wf2-rail-tag dead">已断开</span>`

  // 备用泳道状态标签
  const backupStatus =
    recoverIdx !== null
      ? `<span class="wf2-rail-tag live">已切回主链路</span>`
      : `<span class="wf2-rail-tag live">续跑中</span>`

  // 备用泳道的 grid-column 偏移：fork 之前的节点用空 div 占位
  const backupOffset = forkIdx

  return `<div class="wf2"><div class="wf2-canvas">
    <div class="wf2-lane" style="--wf2-n:${n}">
      <div class="wf2-rail primary"><div>
        <div class="wf2-rail-title">${esc(primaryLabel)} <span class="wf2-rail-en">PRIMARY</span></div>
        <div class="wf2-rail-sub">截至 ${esc(clock || '—')} ${primaryStatus}</div>
      </div></div>
      ${mainCards}
    </div>
    <div class="wf2-lane" style="--wf2-n:${n};margin-top:${WF2.LANE_GAP}px">
      <div class="wf2-rail backup"><div>
        <div class="wf2-rail-title">${esc(backupLabel)} <span class="wf2-rail-en">BACKUP</span></div>
        <div class="wf2-rail-sub">${esc(clock || '—')} 接管 ${backupStatus}</div>
      </div></div>
      <div style="grid-column: 2 / span ${backupOffset}"></div>
      ${backupCards}
    </div>
    <svg class="wf2-wires" aria-hidden="true">
      <defs><linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="0">
        <stop offset="0" class="wf2-grad-a"/><stop offset="1" class="wf2-grad-b"/></linearGradient></defs>
      <path class="wf2-flow" d="M 0 0" fill="none" stroke="url(#${gradId})" stroke-width="2.4"/>
      <path class="wf2-arrow" d="M 0 0" fill="none" stroke-width="2.2"/>
    </svg>
    <div class="wf2-badge" hidden>⚠ ${esc(primaryLabel)} → ${esc(backupLabel)}${clock ? ` <span class="t">${esc(clock)}</span>` : ''}</div>
  </div></div>`
}

/** 未切换任务的链路：与分叉视图同一套卡片语言的单行排布（绿=已完成 / 蓝=执行中 / 灰=待执行，门禁节点保持可点）。 */
function wfLinearCardsHtml(wf, rec) {
  const cards = wf.map((s, i) => {
    if (s.phase === 'GATE_TEST') return wf2GateWrap(s, false, rec)
    const v = s.status === 'done' ? 'done' : s.status === 'current' ? 'cur' : 'pend'
    return wf2Card(s, v, wf2SeqAt(wf, i))
  }).join('')
  return `<div class="wf2"><div class="wf2-canvas"><div class="wf2-lane flat" style="--wf2-n:${wf.length}">${cards}</div></div></div>`
}

// 视口宽度变化时重算已展开任务分叉连线（rAF 节流；仅分叉视图含 wires，线性视图无元素直接跳过）
let wf2ResizeRaf = 0
window.addEventListener('resize', () => {
  cancelAnimationFrame(wf2ResizeRaf)
  wf2ResizeRaf = requestAnimationFrame(() => {
    for (const rec of openTaskDetails.values()) {
      if (!rec.disposed && rec.detail?.isConnected) layoutWf2Wires(rec.detail)
    }
  })
})

function workflowHtmlFromStatus(data, rec) {
  const available = data?.ok && Array.isArray(data.workflow)
  const info = taskGateNodeInfo(rec.data || taskGateData(rec.task))
  const wf = injectGateNode(available ? data.workflow : [], info)
  // 优先使用 linkEvents（新字段：所有切换事件），降级到 linkFork（向后兼容：最近一次 fork）
  const events = rec.linkEvents?.length
    ? rec.linkEvents
    : rec.linkFork
      ? [{ type: 'fork', phase: rec.linkFork.forkPhase, toolName: rec.linkFork.forkToolName, at: rec.linkFork.forkAt, callId: rec.linkFork.forkCallId, fromLabel: rec.linkFork.primaryLabel, toLabel: rec.linkFork.backupLabel }]
      : null
  if (available && events) {
    return wfForkHtml(wf, events, rec) + (data?.doingNow ? `<div class="doing-now">👉 ${esc(data.doingNow)}</div>` : '')
  }
  if (available) {
    return wfLinearCardsHtml(wf, rec) + (data?.doingNow ? `<div class="doing-now">👉 ${esc(data.doingNow)}</div>` : '')
  }
  let seq = 0
  let html = `<div class="wf">${wf.map((s) => {
    if (s.phase !== 'GATE_TEST') seq += 1
    return wfStepHtml(s, seq, rec.root.id, !rec.root.hidden)
  }).join('')}</div>`
  if (data?.doingNow) html += `<div class="doing-now">👉 ${esc(data.doingNow)}</div>`
  if (!available) html += '<div class="doing-now">该任务无 Harness 工作流数据（可能由 task_state 直接创建）</div>'
  return html
}
function applyTaskWorkflow(rec, data) {
  const phase = data?.phase || data?.status?.phase
  // sticky：响应缺 linkFork/linkEvents 字段（旧后端/双机滚动期）时保留上次分叉，字段存在（含 null/[]）才更新
  if (data && data.linkFork !== undefined) rec.linkFork = data.linkFork
  if (data && data.linkEvents !== undefined) rec.linkEvents = data.linkEvents
  // sticky workflow：主备切换滚动期 /api/harness/status 可能返回 HTTP200 但 ok:false / workflow 缺失的退化体，
  // 直接采用会让 injectGateNode([]) 只剩「云端测试」一个节点、把已有生命周期节点清空（与 linkFork 同类问题）。
  // 拿到过有效 workflow 后，退化响应沿用上一次有效数据，仅同步最新 events；无历史时才渲染兜底提示。
  const wfAvailable = Boolean(data?.ok) && Array.isArray(data.workflow)
  if (wfAvailable) rec.lastGoodWorkflowData = data
  const eff = wfAvailable || !rec.lastGoodWorkflowData
    ? data
    : { ...rec.lastGoodWorkflowData, linkFork: rec.linkFork, linkEvents: rec.linkEvents }
  const effPhase = eff?.phase || eff?.status?.phase || phase
  const signature = JSON.stringify([eff?.ok, eff?.workflow, effPhase, eff?.doingNow, rec.linkFork?.forkCallId || null, rec.linkFork?.forkAt || null, rec.linkEvents?.length || 0])
  if (rec.workflowSignature !== signature) {
    const host = rec.detail.querySelector('.task-workflow')
    host.innerHTML = workflowHtmlFromStatus(eff, rec)
    layoutWf2Wires(host)
    rec.workflowSignature = signature
  }
  if (phase) {
    const phaseChip = rec.row.querySelector('[data-task-phase]')
    phaseChip.className = `chip ${phaseColor(phase)}`
    phaseChip.textContent = phaseName(phase)
    const statusChip = rec.row.querySelector('[data-task-status]')
    statusChip.className = `chip${['DONE', 'ABORTED'].includes(phase) ? '' : ' green'}`
    statusChip.textContent = { DONE: '已完成', ABORTED: '已中止' }[phase] || '进行中'
  }
  updateTaskGateSummary(rec)
}
async function refreshTaskWorkflow(rec) {
  if (!taskIsActive(rec)) return
  const generation = rec.generation
  try {
    const data = await taskRequest(rec, `/api/harness/status?taskId=${encodeURIComponent(rec.taskId)}&repo=${encodeURIComponent(rec.repo)}`)
    if (!taskIsActive(rec) || generation !== rec.generation) return
    applyTaskWorkflow(rec, data)
  } catch { /* 工作流刷新失败不清空已有节点。 */ }
}
function updateLiveBadge() {
  const badge = $('#liveBadge')
  if (!badge) return
  badge.classList.toggle('off', !state.live.connected)
  badge.querySelector('span').textContent = state.live.connected ? '实时更新中' : '连接已断开，重连中…'
}

/* ═══ 路由 ═══ */
async function renderTestingTrends() {
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap"><div class="toolbar"><label>时间范围<select id="trendDays"><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="180">最近 180 天</option></select></label><button class="btn ghost" id="trendRefresh">刷新趋势</button></div><div id="trendContent"><div class="empty">加载运行证据趋势…</div></div></div>`
  const select = $('#trendDays')
  select.value = String(state.trends.days)
  const load = async () => {
    const content = $('#trendContent')
    if (state.repo === 'all') { content.innerHTML = '<div class="empty">请选择单个项目查看趋势；跨项目数据不会混用统计口径。</div>'; return }
    content.innerHTML = '<div class="empty">加载运行证据趋势…</div>'
    try {
      const result = await api(`/api/testing/trends?${new URLSearchParams({ repo: state.repo, days: state.trends.days })}`)
      const overall = result.overall
      const percent = (value) => value == null ? '未知' : `${Math.round(value * 100)}%`
      const bars = result.series.map((item) => {
        const height = item.gatePassRate == null ? 0 : Math.max(3, Math.round(item.gatePassRate * 100))
        return `<div class="trend-bar-item" title="${esc(item.start)} · ${esc(percent(item.gatePassRate))} · 分母 ${item.gateDenominator}"><div class="trend-bar-track"><div class="trend-bar-fill" style="height:${height}%"></div></div><span>${esc(item.start.slice(5))}</span></div>`
      }).join('')
      const rows = result.series.map((item) => `<tr><td>${esc(item.start)}</td><td>${item.completedRuns}</td><td>${item.gatePassed}/${item.gateDenominator} · ${esc(percent(item.gatePassRate))}</td><td>${item.checksPassed}/${item.checkDenominator} · ${esc(percent(item.checkPassRate))}</td><td>${item.checksSkipped}</td><td>${item.incompleteGateRuns}</td><td>${item.averageDurationMs == null ? '未知' : `${item.averageDurationMs} ms`}</td></tr>`).join('')
      content.innerHTML = `<div class="stat-grid trend-stat-grid">
        ${statCard('✓', 'green', percent(overall.gatePassRate), '完整覆盖门禁通过率', [`<span class="chip">分母 ${overall.gateDenominator}</span>`])}
        ${statCard('◉', 'blue', percent(overall.checkPassRate), '检查项通过率', [`<span class="chip">分母 ${overall.checkDenominator}</span>`])}
        ${statCard('↗', 'violet', overall.completedRuns, '已结束运行', [`<span class="chip">无检查证据 ${overall.noCheckEvidenceRuns}</span>`])}
        ${statCard('◷', 'amber', overall.averageDurationMs == null ? '未知' : `${overall.averageDurationMs} ms`, '平均门禁耗时', [`<span class="chip">不完整覆盖 ${overall.incompleteGateRuns}</span>`])}
      </div><section class="card trend-card"><div class="card-head"><h3>完整覆盖门禁通过率</h3><span class="chip">${esc(result.repo)}</span></div><p class="muted">没有有效分母时显示“未知”。${overall.checksSkipped} 个 skipped 检查项不进入通过率分母。</p><div class="trend-bars" role="img" aria-label="按日期展示完整覆盖门禁通过率">${bars}</div></section>
      <section class="card trend-card"><div class="card-head"><h3>统计明细</h3><span class="muted">UTC 日期 · 每日桶</span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>日期</th><th>结束运行</th><th>门禁通过</th><th>检查项通过</th><th>跳过检查</th><th>覆盖不完整</th><th>平均耗时</th></tr></thead><tbody>${rows || '<tr><td colspan="7">所选时间范围没有运行记录</td></tr>'}</tbody></table></div>
      <p class="muted">门禁通过率只统计 coverage_complete=1 且至少有一个 passed/failed/error 检查证据的 gate 运行。检查项通过率为 passed / (passed + failed + error)，排除 skipped 和未知状态。空分母为未知，不等于 100%。</p></section>`
    } catch (error) { content.innerHTML = `<div class="empty">趋势加载失败：${esc(error.message)}</div>` }
  }
  select.onchange = () => { state.trends.days = Number(select.value); void load() }
  $('#trendRefresh').onclick = () => { void load() }
  await load()
}
const ROUTES = {
  overview:     { title: '总览',   sub: '体系运转一屏总览', render: renderOverview },
  experiences:  { title: '经验库', sub: '团队踩坑与规则的共享记忆 · 支持检索与评审', render: renderExperiences },
  activity:     { title: '调用流', sub: 'MCP / HTTP 调用实时审计', render: renderActivity },
  tasks:        { title: '任务',   sub: 'Harness 工作流任务 · 云端门禁测试内嵌于任务详情', render: renderTasks },
  projects:     { title: '项目管理', sub: '接入项目 · 云端测试开关与档位 · dev/qa 登录账号', render: renderProjects },
  specs:        { title: '测试资产', sub: '云端测试脚本资产库 · 按模块组织 · 版本与执行可追溯', render: renderSpecs },
  trends:       { title: '测试趋势', sub: '按实际运行证据统计通过率、覆盖和耗时', render: renderTestingTrends },
  docs:         { title: '知识库', sub: '规范文档单一真源 · 版本可回滚', render: renderDocs },
}
function currentRoute() {
  const h = (location.hash || '#/overview').replace(/^#\//, '').split('?')[0]
  return ROUTES[h] ? h : 'overview'
}
async function render() {
  disposeTaskViews()
  const name = currentRoute()
  state.route = name
  const cfg = ROUTES[name]
  $('#viewTitle').textContent = cfg.title
  $('#viewSub').textContent = cfg.sub
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.route === name))
  await cfg.render()
}
window.addEventListener('hashchange', render)

/* ═══════════════ 总览视图 ═══════════════ */
async function renderOverview() {
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap">
    <div class="stat-grid" id="ovStats">
      ${'<div class="card stat-card skeleton" style="height:92px"></div>'.repeat(4)}
    </div>
    <div class="ov-grid">
      <div class="ov-col">
        <div class="card">
          <div class="card-head"><h3>🌀 体系飞轮</h3><span class="chip mono" id="fwRepo"></span></div>
          <div class="fw-grid" id="fwGrid">${'<div class="skeleton" style="height:74px"></div>'.repeat(4)}</div>
          <div class="fw-keywords" id="fwKeywords"></div>
        </div>
        <div class="card">
          <div class="card-head"><h3>💡 最新经验</h3><span class="link" onclick="location.hash='#/experiences'">进入经验库 →</span></div>
          <div class="mini-list" id="ovExp"><div class="skeleton" style="height:180px;border-radius:0 0 var(--radius) var(--radius)"></div></div>
        </div>
      </div>
      <div class="ov-col">
        <div class="card">
          <div class="card-head"><h3>📡 实时动态</h3><span class="live-badge" id="liveBadge"><span>连接中…</span></span></div>
          <div class="mini-list" id="ovFeed"></div>
        </div>
      </div>
    </div>
  </div>`
  updateLiveBadge()

  let data
  try {
    data = await api(`/api/overview?repo=${encodeURIComponent(state.repo)}`)
  } catch (e) {
    $('#ovStats').innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="empty-ico">⚠️</span>加载失败：${esc(e.message)}</div>`
    return
  }
  const s = data.stats
  $('#ovStats').innerHTML = `
    ${statCard('💡', 'red', s.expTotal, '经验库', [
      s.expPending ? `<span class="chip amber">${s.expPending} 待评审</span>` : `<span class="chip green">评审清零</span>`,
    ])}
    ${statCard('📋', 'blue', s.tasksOpen, '进行中任务', [`<span class="chip blue">Harness 状态机</span>`])}
    ${statCard('📚', 'green', s.docsCount, '规范文档', [`<span class="chip green">单一真源</span>`])}
    ${statCard('📡', 'violet', s.eventsToday, '今日调用', [`<span class="chip violet">MCP + HTTP</span>`])}
  `

  const fw = data.flywheel
  const hitRate = fw.distillHit + fw.distillMiss > 0 ? Math.round((fw.distillHit / (fw.distillHit + fw.distillMiss)) * 100) : null
  $('#fwRepo').textContent = data.repo
  $('#fwGrid').innerHTML = [
    fwCell(fw.pending, '📥 待评审', '经验库该清淤（>10 飘红）', fw.pending > 10 ? 'bad' : fw.pending > 0 ? 'warn' : 'good'),
    fwCell(hitRate == null ? '—' : hitRate + '%', '🔍 经验命中率', `${fw.distillHit} 命中 / ${fw.distillMiss} 未命中`, hitRate != null && hitRate < 50 && fw.distillMiss > 0 ? 'warn' : 'good'),
    fwCell(fw.reuseCount, '♻️ 经验复用', '命中即复用一次（30 天）', 'good'),
    fwCell(fw.driftWeek, '📉 ai-drift 周新增', '语义修复后应趋稳', fw.driftWeek > 0 ? 'warn' : 'good'),
  ].join('')
  $('#fwKeywords').innerHTML = fw.missKeywords.length
    ? `<span class="chip" style="color:var(--muted)">未命中关键词 = 该补的经验：</span>` + fw.missKeywords.map((k) => `<span class="chip red">${esc(k)}</span>`).join('')
    : ''

  $('#ovExp').innerHTML = data.recentExperiences.length
    ? data.recentExperiences.map(miniExp).join('')
    : `<div class="empty"><span class="empty-ico">🌱</span>经验库还是空的<br>在 IDE 里调 distill_append 或脚本上报后，这里会亮起来</div>`
  $$('#ovExp .mini-item').forEach((el) => {
    el.onclick = () => { location.hash = '#/experiences' }
  })

  // 实时动态基底（live 事件去重后前插）
  state.feedBase = data.recentEvents
  renderOverviewFeed()
}
function statCard(ico, color, value, label, subs) {
  return `<div class="card stat-card">
    <div class="stat-ico ${color}">${ico}</div>
    <div class="stat-body">
      <div class="stat-value">${esc(value)}</div>
      <div class="stat-label">${label}</div>
      <div class="stat-sub">${subs.join('')}</div>
    </div>
  </div>`
}
function fwCell(value, label, hint, cls) {
  return `<div class="fw-cell ${cls}">
    <div class="fw-label">${label}</div>
    <div class="fw-value">${esc(value)}</div>
    <div class="fw-hint">${hint}</div>
  </div>`
}
function miniExp(e) {
  const st = { pending: 'amber', reviewed: 'green', obsolete: '' }[e.status] || ''
  return `<div class="mini-item">
    <div class="mini-body">
      <div class="mini-title">${esc(e.content)}</div>
      <div class="mini-meta">
        ${avatar(e.author)}<span>${esc(e.author)}</span>
        ${e.module ? `<span class="chip cyan">${esc(e.module)}</span>` : ''}
        <span class="chip ${st}">${e.status}</span>
        ${e.source === 'auto' ? '<span class="chip">AI 沉淀</span>' : '<span class="chip violet">人工</span>'}
      </div>
    </div>
    <span class="mini-time">${relTime(e.created_at)}</span>
  </div>`
}
function miniEvt(ev) {
  const cat = catOf(ev)
  const m = CAT_META[cat]
  return `<div class="mini-item" title="${esc(evDesc(ev))}">
    <span class="evt-ico ${m.icoBg}" style="width:30px;height:30px;border-radius:9px;font-size:13px">${m.icon}</span>
    <div class="mini-body">
      <div class="mini-title">${evDescHtml(ev)}</div>
      <div class="mini-meta">${ev.author ? `<span>@${esc(ev.author)}</span>` : ''}${ev.repo ? `<span>${esc(ev.repo)}</span>` : ''}</div>
    </div>
    <span class="mini-time">${relTime(ev.created_at)}</span>
  </div>`
}
function renderOverviewFeed() {
  const feed = $('#ovFeed')
  if (!feed) return
  const seen = new Set()
  const merged = [...state.live.events, ...state.feedBase || []].filter((e) => {
    if (state.repo !== 'all' && e.repo && e.repo !== state.repo) return false
    if (seen.has(e.id)) return false
    seen.add(e.id)
    return true
  }).slice(0, 9)
  feed.innerHTML = merged.length
    ? merged.map(miniEvt).join('')
    : `<div class="empty"><span class="empty-ico">📡</span>暂无调用记录<br>IDE 连接 MCP 或脚本上报后实时流入</div>`
}
function prependOverviewFeed() { renderOverviewFeed() }

/* ═══════════════ 经验库视图 ═══════════════ */
async function renderExperiences() {
  const e = state.exp
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap">
    <div class="toolbar">
      <div class="search-box" id="expSearchBox">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
        <input type="text" id="expSearch" placeholder="搜索经验（关键词 / 报错 / 模块）…  按 / 聚焦" value="${esc(e.keyword)}" />
        <button class="clear" title="清空">✕</button>
      </div>
      <select id="expSource" title="来源">
        <option value="all">全部来源</option>
        <option value="auto">AI 自动沉淀</option>
        <option value="user">人工总结</option>
      </select>
      <select id="expModule" title="模块"><option value="">全部模块</option></select>
    </div>
    <div class="tabs" id="expTabs"></div>
    <div class="result-meta"><span id="expCount"></span><span class="chip mono" id="expRepoChip">${esc(state.repo)}</span></div>
    <div class="exp-list" id="expList"></div>
    <div class="load-more" id="expMore"></div>
  </div>`

  $('#expSource').value = e.source
  $('#expSearchBox').classList.toggle('has-kw', !!e.keyword)

  let searchTimer = null
  $('#expSearch').oninput = (ev) => {
    e.keyword = ev.target.value
    $('#expSearchBox').classList.toggle('has-kw', !!e.keyword)
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => { e.page = 1; loadExperiences(false) }, 380)
  }
  $('#expSearchBox .clear').onclick = () => {
    $('#expSearch').value = ''
    e.keyword = ''
    $('#expSearchBox').classList.remove('has-kw')
    e.page = 1
    loadExperiences(false)
  }
  $('#expSource').onchange = (ev) => { e.source = ev.target.value; e.page = 1; loadExperiences(false) }
  $('#expModule').onchange = (ev) => { e.module = ev.target.value; e.page = 1; loadExperiences(false) }

  $('#expList').addEventListener('click', (ev) => {
    const card = ev.target.closest('.exp-card')
    if (!card) return
    const actBtn = ev.target.closest('[data-act]')
    if (actBtn) { handleReviewAction(actBtn, card); return }
    const tag = ev.target.closest('.exp-tag[data-module]')
    if (tag) {
      state.exp.module = tag.dataset.module
      state.exp.page = 1
      loadExperiences(false)
      return
    }
    if (ev.target.closest('input, button')) return
    card.classList.toggle('open')
    const id = card.dataset.id
    if (card.classList.contains('open')) state.exp.expanded.add(id)
    else state.exp.expanded.delete(id)
  })
  $('#expMore')?.addEventListener('click', () => { e.page++; loadExperiences(true) })

  await loadExperiences(false)
}
async function loadExperiences(append) {
  const e = state.exp
  e.loading = true
  const list = $('#expList')
  if (!append && list) list.innerHTML = `<div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:92px"></div><div class="skeleton" style="height:92px"></div>`
  try {
    const params = new URLSearchParams({
      repo: state.repo, status: e.status, source: e.source,
      keyword: e.keyword, page: e.page, pageSize: e.pageSize,
    })
    if (e.module) params.set('module', e.module)
    const data = await api('/api/experiences?' + params)
    e.items = append ? [...e.items, ...data.items] : data.items
    e.total = data.total
    e.facets = data.facets
  } catch (err) {
    if (list) list.innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>加载失败：${esc(err.message)}</div>`
    return
  }
  renderExpResults()
}
function renderExpResults() {
  const e = state.exp
  const f = e.facets
  // tabs
  const tabs = [
    { k: 'all', label: '全部' },
    { k: 'pending', label: '待评审' },
    { k: 'reviewed', label: '已评审' },
    { k: 'obsolete', label: '已废弃' },
  ]
  $('#expTabs').innerHTML = tabs.map((t) =>
    `<button data-status="${t.k}" class="${e.status === t.k ? 'active' : ''}">${t.label}<span class="cnt">${f?.statuses?.[t.k] ?? ''}</span></button>`
  ).join('')
  $$('#expTabs button').forEach((b) => {
    b.onclick = () => { e.status = b.dataset.status; e.page = 1; loadExperiences(false) }
  })
  // module select options（保留当前选择）
  const modSel = $('#expModule')
  const curMod = e.module
  modSel.innerHTML = '<option value="">全部模块</option>' + (f?.modules || []).map((m) =>
    `<option value="${esc(m.module)}">${esc(m.module)}（${m.c}）</option>`).join('')
  modSel.value = curMod
  $('#expRepoChip').textContent = state.repo

  const list = $('#expList')
  if (!e.items.length) {
    list.innerHTML = `<div class="card empty"><span class="empty-ico">🔍</span>${e.keyword || e.module || e.status !== 'all' ? '没有符合条件的经验' : '经验库还是空的'}<br><small>在 IDE 中调用 distill_append / lesson_record，或业务脚本 POST /api/distill 即可写入</small></div>`
  } else {
    list.innerHTML = e.items.map(expCardHtml).join('')
  }
  $('#expCount').textContent = `共 ${e.total} 条${e.items.length < e.total ? ` · 已加载 ${e.items.length}` : ''}`
  $('#expMore').innerHTML = e.items.length < e.total
    ? `<button class="btn" id="expMoreBtn">加载更多（还剩 ${e.total - e.items.length} 条）</button>` : ''
}
function expCardHtml(item) {
  const e = state.exp
  const tags = JSON.parse(item.tags || '[]')
  const stChip = { pending: 'amber', reviewed: 'green', obsolete: '' }[item.status]
  const stLabel = { pending: '待评审', reviewed: '已评审', obsolete: '已废弃' }[item.status]
  const open = e.expanded.has(item.id)
  // 评审动作：按当前状态展示可流转的目标
  const actions = []
  if (item.status !== 'reviewed') actions.push(`<button class="btn green sm" data-act="reviewed">✓ 通过并固化</button>`)
  if (item.status !== 'obsolete') actions.push(`<button class="btn warn sm" data-act="obsolete">标记废弃</button>`)
  if (item.status !== 'pending') actions.push(`<button class="btn sm" data-act="pending">恢复待评审</button>`)
  return `<div class="card exp-card st-${item.status} ${open ? 'open' : ''}" data-id="${esc(item.id)}" data-kb tabindex="0">
    <div class="exp-content">${esc(item.content)}</div>
    <div class="exp-meta">
      <span class="exp-id">${esc(item.id)}</span>
      ${avatar(item.author)}<span style="font-size:11.5px">${esc(item.author)}</span>
      <span class="chip ${stChip}">${stLabel}</span>
      ${item.source === 'auto' ? '<span class="chip">AI 沉淀</span>' : '<span class="chip violet">人工总结</span>'}
      ${item.module ? `<span class="chip cyan exp-tag" data-module="${esc(item.module)}" title="按模块筛选">${esc(item.module)}</span>` : ''}
      ${tags.map((t) => `<span class="chip ${t === 'ai-drift' ? 'red' : ''}">${esc(t)}</span>`).join('')}
      ${item.rule_ref ? `<span class="chip green" title="已固化规则">🔗 ${esc(item.rule_ref)}</span>` : ''}
      <span class="spacer"></span>
      <span class="exp-time">${relTime(item.created_at)}</span>
    </div>
    <div class="exp-detail">
      <div class="detail-grid">
        <div><span class="dt">完整 ID：</span><span class="dd">${esc(item.id)}</span></div>
        <div><span class="dt">所属项目：</span><span class="dd">${esc(item.repo)}</span></div>
        <div><span class="dt">写入时间：</span><span class="dd">${fmtDateTime(item.created_at)}</span></div>
        <div><span class="dt">更新时间：</span><span class="dd">${fmtDateTime(item.updated_at)}</span></div>
        ${item.task_id ? `<div><span class="dt">关联任务：</span><span class="dd">${esc(item.task_id)}</span></div>` : ''}
        ${item.rule_ref ? `<div><span class="dt">固化规则：</span><span class="dd">${esc(item.rule_ref)}</span></div>` : ''}
      </div>
      <div class="review-bar">
        <input type="text" class="rule-input" placeholder="固化规则位置（可选），如 AGENTS.md §硬规则-4" />
        ${actions.join('')}
      </div>
      <div class="review-hint">评审动作会记入调用流，状态流转：pending → reviewed（已固化）/ obsolete（废弃）</div>
    </div>
  </div>`
}
async function ensureUsername() {
  if (state.username) return state.username
  return new Promise((resolve) => {
    const modal = $('#nameModal')
    modal.hidden = false
    const input = $('#nameInput')
    input.value = ''
    setTimeout(() => input.focus(), 30)
    const close = (val) => {
      modal.hidden = true
      $('#nameSave').onclick = $('#nameCancel').onclick = null
      input.onkeydown = null
      resolve(val)
    }
    $('#nameSave').onclick = () => {
      const v = input.value.trim()
      if (!v) { input.focus(); return }
      state.username = v
      localStorage.setItem('mx.username', v)
      toast(`已登记：${v}`, 'ok')
      close(v)
    }
    $('#nameCancel').onclick = () => close(null)
    input.onkeydown = (ev) => { if (ev.key === 'Enter') $('#nameSave').click(); if (ev.key === 'Escape') close(null) }
  })
}
async function handleReviewAction(btn, card) {
  const id = card.dataset.id
  const status = btn.dataset.act
  const author = await ensureUsername()
  if (!author) return
  const item = state.exp.items.find((x) => x.id === id)
  const confirmMsg = {
    reviewed: `确认通过 ${id}（固化为规则）？`,
    obsolete: `确认废弃 ${id}？`,
    pending: `确认把 ${id} 恢复为待评审？`,
  }[status]
  if (!confirm(confirmMsg)) return
  const ruleRef = card.querySelector('.rule-input')?.value.trim() || null
  btn.disabled = true
  btn.textContent = '提交中…'
  try {
    await api(`/api/experiences/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ruleRef, author }),
    })
    toast(`已评审：${id} → ${status}`, 'ok')
    await loadExperiences(false)
    updateNavBadge()
  } catch (err) {
    toast(`评审失败：${err.message}`, 'err')
    btn.disabled = false
    btn.textContent = '重试'
  }
}
async function updateNavBadge() {
  try {
    const data = await api(`/api/experiences?repo=${encodeURIComponent(state.repo)}&pageSize=1`)
    const pending = data.facets?.statuses?.pending || 0
    const badge = $('#navExpBadge')
    badge.hidden = !pending
    badge.textContent = pending > 99 ? '99+' : pending
  } catch { /* 静默 */ }
}

/* ═══════════════ 调用流视图 ═══════════════ */
async function renderActivity() {
  const a = state.act
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap">
    <div class="toolbar">
      <div class="tabs" style="padding:3px">
        <button id="actResume" class="${a.paused ? 'active' : ''}" style="color:${a.paused ? 'var(--accent)' : ''}">${a.paused ? '▶ 已暂停，点击恢复' : '⏸ 暂停滚动'}</button>
      </div>
      <select id="actAuthor"><option value="">全部操作人</option></select>
      <div class="cat-filter" id="catFilter">
        ${Object.entries(CAT_META).map(([k, m]) => `<button class="cat-chip ${a.cats.has(k) ? 'on' : ''}" data-cat="${k}">${m.icon} ${m.label}</button>`).join('')}
      </div>
      <span class="live-badge" id="liveBadge" style="margin-left:auto"><span>连接中…</span></span>
    </div>
    <div class="card">
      <div class="evt-list" id="evtList"><div class="skeleton" style="height:120px;margin:14px;border-radius:10px"></div></div>
    </div>
  </div>`
  updateLiveBadge()

  // 历史事件打底 + 实时事件在前（去重）
  try {
    const data = await api(`/api/audit/events?limit=150${state.repo !== 'all' ? `&repo=${encodeURIComponent(state.repo)}` : ''}`)
    const seen = new Set(state.live.events.map((e) => e.id))
    state.feedBase = data.events.filter((e) => !seen.has(e.id) && e.event_type !== 'http_harness_status')
  } catch { state.feedBase = [] }

  try {
    const data = await api('/api/audit/authors')
    $('#actAuthor').innerHTML = '<option value="">全部操作人</option>' +
      data.authors.map((x) => `<option value="${esc(x.author)}">${esc(x.author)}（${x.cnt}）</option>`).join('')
    $('#actAuthor').value = a.author
  } catch { /* 静默 */ }
  $('#actAuthor').onchange = (ev) => { a.author = ev.target.value; renderEvtList() }
  $('#actResume').onclick = () => { a.paused = !a.paused; renderActivity().then(() => {}) }
  $$('#catFilter .cat-chip').forEach((b) => {
    b.onclick = () => {
      const cat = b.dataset.cat
      if (a.cats.has(cat)) a.cats.delete(cat)
      else a.cats.add(cat)
      b.classList.toggle('on')
      renderEvtList()
    }
  })
  renderEvtList()
}
function actVisibleEvents() {
  const a = state.act
  return [...state.live.events, ...state.feedBase || []]
    .filter((e) => a.cats.has(catOf(e)))
    .filter((e) => !a.author || e.author === a.author)
    .filter((e) => state.repo === 'all' || !e.repo || e.repo === state.repo)
    .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
    .slice(0, 150)
}
function evtCardHtml(ev, fresh) {
  const cat = catOf(ev)
  const m = CAT_META[cat]
  return `<div class="evt-item ${fresh ? 'fresh' : ''}">
    <span class="evt-ico ${m.icoBg}">${m.icon}</span>
    <div class="evt-body">
      <div class="evt-desc">${evDescHtml(ev)}</div>
      <div class="evt-meta">
        ${ev.author ? `${avatar(ev.author)}<span style="font-size:11.5px">@${esc(ev.author)}</span>` : ''}
        ${ev.tool_name ? `<span class="chip mono">${esc(ev.tool_name)}</span>` : ''}
        ${ev.repo ? `<span class="chip">${esc(ev.repo)}</span>` : ''}
        ${ev.task_id ? `<span class="chip blue" title="${esc(ev.task_id)}">task …${esc(String(ev.task_id).slice(-8))}</span>` : ''}
        ${ev.duration_ms != null ? `<span class="chip">${ev.duration_ms}ms</span>` : ''}
        ${ev.status && ev.status !== 'ok' ? `<span class="chip red">${esc(ev.status)}</span>` : ''}
        <span class="spacer" style="flex:1"></span>
        <span class="evt-time" title="${fmtDateTime(ev.created_at)}">${relTime(ev.created_at)}</span>
      </div>
      ${ev.args_preview ? `<details class="evt-args"><summary>参数 / 详情</summary><pre>${esc(ev.args_preview)}</pre></details>` : ''}
    </div>
  </div>`
}
function renderEvtList() {
  const list = $('#evtList')
  if (!list) return
  const evts = actVisibleEvents()
  list.innerHTML = evts.length
    ? evts.map((e) => evtCardHtml(e, false)).join('')
    : `<div class="empty"><span class="empty-ico">📡</span>暂无符合条件的调用${state.act.paused ? '（已暂停接收）' : ''}<br><small>等待 IDE / 脚本触发 MCP 工具或 REST 上报</small></div>`
}
function prependActivityEvent(ev) {
  const list = $('#evtList')
  if (!list) return
  const a = state.act
  if (!a.cats.has(catOf(ev))) return
  if (a.author && ev.author !== a.author) return
  if (state.repo !== 'all' && ev.repo && ev.repo !== state.repo) return
  const emptyEl = list.querySelector('.empty')
  if (emptyEl) emptyEl.remove()
  list.insertAdjacentHTML('afterbegin', evtCardHtml(ev, true))
  while (list.children.length > 160) list.lastElementChild.remove()
}

/* ═══════════════ 任务视图 ═══════════════ */
function phaseName(p) { return state.labels.phases?.[p]?.name || p || '—' }
function phaseColor(p) {
  if (p === 'DONE') return 'green'
  if (p === 'ABORTED') return 'red'
  return 'blue'
}
/* ═══ 云端测试任务桥接 ═══ */
function taskGateData(task) {
  const summary = task?.gateSummary
  if (summary?.version === 1) {
    const context = summary.context
    if ((context?.repo && context.repo !== task.repo) || (context?.taskId && context.taskId !== task.task_id)) return null
    return { summary }
  }
  // 旧 gates 没有仓库维度，全部项目下无法排除分页之外的同名任务。
  const legacyGate = state.repo !== 'all' && state.tasks.gates?.[task?.task_id]
  return legacyGate ? { legacyGate } : null
}
function taskGateNodeInfo(data) {
  if (!data) return { status: 'pending', label: '云端测试待执行', summary: '云端测试数据尚未取得，点击查看', linked: true }
  if (!data.legacyGate) return cloudTestingModule.getNodeInfo(data)
  const g = data.legacyGate
  const [status, label] = ({
    passed: ['attention', '正式执行通过'], failed: ['failed', '正式执行失败'], error: ['failed', '正式执行异常'],
    timed_out: ['failed', '正式执行超时'], lost: ['failed', '正式执行失联'],
    active: ['current', '正式执行中'], running: ['current', '正式执行中'],
    queued: ['pending', '正式执行排队中'], planned: ['pending', '正式执行待调度'],
    skipped: ['skipped', '正式执行已跳过'], canceled: ['attention', '正式执行已取消'],
  })[g.status] || ['attention', '正式执行状态未知']
  const counts = g.passed != null && g.total != null ? ` · ${g.passed}/${g.total} 单元通过` : ''
  return { status, label, linked: true, summary: `${label}${counts}（旧摘要） · 待实际门禁确认` }
}
const gateTone = (status) => ({ failed: 'red', current: 'blue', done: 'green', attention: 'amber' })[status] || ''
function updateTaskGateSummary(rec) {
  const data = rec.data || taskGateData(rec.task)
  const info = taskGateNodeInfo(data)
  const expanded = !rec.root.hidden && rec.row.classList.contains('open')
  const chip = rec.row.querySelector('[data-gate-summary]')
  chip.hidden = !data
  chip.className = `chip task-gate-summary ${gateTone(info.status)}`
  chip.textContent = `云端 · ${info.summary}`
  chip.title = info.summary
  chip.setAttribute('aria-controls', rec.root.id)
  chip.setAttribute('aria-expanded', String(expanded))
  // 分叉布局下门禁节点可能同时出现在主链臂与备用臂：逐个同步，保持两处一致
  const gateNodes = rec.detail.querySelectorAll('[data-gate-node]')
  gateNodes.forEach((node) => {
    node.className = `wf-step wf-gate wf-clickable ${info.status}`
    node.title = info.summary
    node.setAttribute('aria-label', `${info.label}：${info.summary}`)
    node.setAttribute('aria-expanded', String(expanded))
    node.querySelector('.wf-dot').textContent = info.status === 'done' ? '✓' : info.status === 'failed' ? '✗' : '☁'
    node.querySelector('.wf-gate-status').textContent = info.label
  })
}
function setTaskGateVisible(rec, visible) {
  if (visible && !taskIsActive(rec)) return
  if (visible && !rec.controller) {
    rec.controller = cloudTestingModule.mountCloudTesting(rec.root, {
      repo: rec.repo, taskId: rec.taskId, initialData: rec.data,
      api: (path, options) => taskRequest(rec, path, options),
      onData: (data) => acceptTaskGateData(rec, data),
      onClose: () => setTaskGateVisible(rec, false),
      subscribe(listener) {
        const receive = (event) => {
          if (!rec.disposed && eventMatchesTask(event, rec)) listener({ ...event, repo: rec.repo, taskId: rec.taskId })
        }
        gateListeners.add(receive)
        return () => gateListeners.delete(receive)
      },
    })
  }
  const returnFocus = !visible && rec.root.contains(document.activeElement)
  rec.controller?.setVisible(visible)
  rec.root.hidden = !visible
  updateTaskGateSummary(rec)
  if (returnFocus && rec.row.classList.contains('open')) rec.detail.querySelector('[data-gate-node]')?.focus()
}
function collapseTaskRow(row) {
  const rec = openTaskDetails.get(taskKey(row.dataset.repo, row.dataset.id))
  if (!rec) return
  setTaskGateVisible(rec, false)
  cancelTaskRequests(rec)
}
function injectGateNode(workflow, info) {
  const node = { phase: 'GATE_TEST', name: '云端测试', ...info, clickable: info.linked }
  const arr = [...workflow]
  const idx = arr.findIndex((s) => s.phase === 'EXECUTE' || s.phase === 'execute')
  arr.splice(idx >= 0 ? idx + 1 : Math.max(arr.length - 1, 0), 0, node)
  return arr
}
function wfStepHtml(s, seq, controls = '', expanded = false) {
  const isGate = s.phase === 'GATE_TEST'
  const dot = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : isGate ? '☁' : seq
  if (isGate) return `<button type="button" class="wf-step wf-gate wf-clickable ${esc(s.status)}" data-gate-node="1" aria-expanded="${expanded}" aria-controls="${esc(controls)}" aria-label="${esc(s.label)}：${esc(s.summary)}" title="${esc(s.summary || '')}">
    <span class="wf-dot" aria-hidden="true">${dot}</span><span class="wf-name">${esc(s.name)}</span>
    <span class="wf-gate-status">${esc(s.label)}</span></button>`
  return `<div class="wf-step ${s.status}${s.clickable ? ' wf-clickable' : ''}"  title="${esc(s.summary || '')}">
    <div class="wf-dot">${dot}</div>
    <div class="wf-name">${esc(s.name)}</div>
  </div>`
}

async function renderTasks() {
  disposeTaskViews()
  const generation = taskViewGeneration
  const repo = state.repo
  const abort = new AbortController()
  taskListAbort = abort
  const t = state.tasks
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap">
    <div class="toolbar">
      <div class="tabs" id="taskTabs">
        <button data-st="open" class="${t.status === 'open' ? 'active' : ''}">进行中</button>
        <button data-st="done" class="${t.status === 'done' ? 'active' : ''}">已完成</button>
        <button data-st="aborted" class="${t.status === 'aborted' ? 'active' : ''}">已中止</button>
        <button data-st="all" class="${t.status === 'all' ? 'active' : ''}">全部</button>
      </div>
      <span class="chip mono" style="margin-left:auto">${esc(state.repo)}</span>
    </div>
    <div class="card">
      <div class="task-list" id="taskList"><div class="skeleton" style="height:80px;margin:14px;border-radius:10px"></div></div>
    </div>
  </div>`
  $$('#taskTabs button').forEach((b) => {
    b.onclick = () => { t.status = b.dataset.st; renderTasks() }
  })
  const list = $('#taskList')
  let data
  try {
    await loadCloudTesting()
    if (abort.signal.aborted || generation !== taskViewGeneration) return
    data = await api(`/api/tasks?repo=${encodeURIComponent(repo)}&status=${t.status}`, { signal: abort.signal })
  } catch (e) {
    if (abort.signal.aborted || generation !== taskViewGeneration || !list.isConnected) return
    list.innerHTML = `<div class="empty">加载失败：${esc(e.message)} <button type="button" class="btn ghost sm" data-task-retry>重试</button></div>`
    list.querySelector('[data-task-retry]').onclick = renderTasks
    return
  }
  if (abort.signal.aborted || generation !== taskViewGeneration || !list.isConnected) return
  t.items = data.items || []
  t.phaseCounts = data.phaseCounts
  t.gates = data.gates || {}
  list.innerHTML = t.items.length
    ? t.items.map((task, i) => taskRowHtml(task, i)).join('')
    : `<div class="empty"><span class="empty-ico">📋</span>没有${{ open: '进行中', done: '已完成', aborted: '已中止', all: '' }[t.status]}任务<br><small>IDE 中调用 harness_start 开启新任务</small></div>`
  $$('#taskList .task-row').forEach((row) => {
    row.onclick = async (ev) => {
      // 停止按钮 / 详情区：不触发行展开
      if (ev.target.closest('.task-stop-btn')) {
        ev.stopPropagation()
        return
      }
      if (ev.target.closest('[data-gate-summary]')) {
        ev.stopPropagation()
        row.classList.add('open')
        const existing = openTaskDetails.get(taskKey(row.dataset.repo, row.dataset.id))
        const rec = existing?.detail.dataset.loaded === '1' ? existing : await fillTaskDetail(row)
        if (rec && taskIsActive(rec)) setTaskGateVisible(rec, true)
        return
      }
      if (ev.target.closest('a') || ev.target.closest('.task-detail')) return
      row.classList.toggle('open')
      if (row.classList.contains('open')) await fillTaskDetail(row)
      else collapseTaskRow(row)
    }
  })
  $$('#taskList .task-stop-btn').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation()
      const taskId = btn.dataset.id
      const repo = btn.dataset.repo
      if (!taskId) return
      if (!window.confirm(`确认中止任务？\n${taskId}\n\n将：phase→ABORTED、取消全部云端测试、尝试关闭 VM。\nAI Coding 会收到中止提示。`)) return
      btn.disabled = true
      const prevHtml = btn.innerHTML
      btn.textContent = '停止中…'
      try {
        const out = await api('/api/harness/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId, repo, author: 'dashboard' }),
        })
        if (out.ok) {
          toast(out.message || '任务已中止', 'ok')
          await render()
        } else {
          toast(out.error || '停止失败', 'err')
          btn.disabled = false
          btn.innerHTML = prevHtml
        }
      } catch (e) {
        toast(`停止失败：${e.message}`, 'err')
        btn.disabled = false
        btn.innerHTML = prevHtml
      }
    }
  })
}

function gateRootId(repo, taskId) { return `cloud-testing-${encodeURIComponent(taskKey(repo, taskId))}` }
function gateChipHtml(task) {
  const data = taskGateData(task)
  const info = taskGateNodeInfo(data)
  return `<button type="button" class="chip task-gate-summary ${gateTone(info.status)}" data-gate-summary aria-expanded="false" aria-controls="${esc(gateRootId(task.repo, task.task_id))}" title="${esc(info.summary)}"${data ? '' : ' hidden'}>云端 · ${esc(info.summary)}</button>`
}

function taskRowHtml(task) {
  const color = phaseColor(task.phase)
  const st = { DONE: '已完成', ABORTED: '已中止' }[task.phase] || '进行中'
  const canStop = !['DONE', 'ABORTED'].includes(task.phase)
  return `<div class="task-row" data-id="${esc(task.task_id)}" data-repo="${esc(task.repo)}" data-kb tabindex="0">
    <div class="task-main">
      <span class="phase-dot" style="background:var(--${color})"></span>
      <div class="task-title">
        <div class="task-req">${esc(task.requirement || task.task_id)}</div>
        <div class="task-id">${esc(task.task_id)}</div>
      </div>
      <span class="chip">${esc(task.type || 'FEATURE')}</span>
      <span class="chip ${color}" data-task-phase>${esc(phaseName(task.phase))}</span>
      ${st !== '进行中' ? `<span class="chip" data-task-status>${st}</span>` : `<span class="chip green" data-task-status>${st}</span>`}
      ${gateChipHtml(task)}
      ${canStop ? `<button type="button" class="btn danger sm task-stop-btn" data-id="${esc(task.task_id)}" data-repo="${esc(task.repo)}" title="中止任务：取消云端测试并关闭 VM"><svg class="btn-ico" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>停止</button>` : ''}
      ${avatar(task.author)}
      <span class="evt-time" title="创建 ${fmtDateTime(task.created_at)} · 最近更新 ${fmtDateTime(task.updated_at)}">${relTime(task.created_at)}</span>
    </div>
    <div class="task-detail"></div>
  </div>`
}
async function fillTaskDetail(row) {
  const detail = row.querySelector('.task-detail')
  const taskId = row.dataset.id
  const repo = row.dataset.repo
  const key = taskKey(repo, taskId)
  let rec = openTaskDetails.get(key)
  if (!rec) {
    const task = state.tasks.items.find((x) => x.task_id === taskId && x.repo === repo)
    let completed = [], pending = []
    try {
      completed = JSON.parse(task?.completed || '[]')
      pending = JSON.parse(task?.pending || '[]')
    } catch { /* 忽略解析失败 */ }
    detail.innerHTML = `
      <div class="task-workflow"><div class="skeleton" style="height:60px;margin-top:8px"></div></div>
      <div class="td-grid">
        <div><span class="dt">创建时间：</span><span class="dd">${task ? fmtDateTime(task.created_at) : '—'}</span></div>
        <div><span class="dt">负责人：</span><span class="dd">${esc(task?.author || '—')}</span></div>
      </div>
      <div class="td-lists">
        <div><h5>已完成（${completed.length}）</h5><ul>${completed.map((c) => `<li>${esc(String(c))}</li>`).join('') || '<li style="color:var(--faint)">暂无</li>'}</ul></div>
        <div><h5>待办（${pending.length}）</h5><ul>${pending.map((c) => `<li>${esc(String(c))}</li>`).join('') || '<li style="color:var(--faint)">暂无</li>'}</ul></div>
      </div>
      <div class="gate-card cloud-testing" id="${esc(gateRootId(repo, taskId))}" hidden></div>`
    rec = { key, row, detail, taskId, repo, task, root: detail.querySelector('.gate-card'),
      data: null, controller: null, requests: new Map(), generation: 0, disposed: false, loading: null }
    openTaskDetails.set(key, rec)
    detail.onclick = (event) => {
      if (!event.target.closest('[data-gate-node]')) return
      event.stopPropagation()
      setTaskGateVisible(rec, rec.root.hidden)
    }
  }
  if (!taskIsActive(rec)) return null
  if (rec.loading) return rec.loading
  const generation = rec.generation
  const loading = (async () => {
    const [data] = await Promise.all([
      taskRequest(rec, `/api/harness/status?taskId=${encodeURIComponent(taskId)}&repo=${encodeURIComponent(repo)}`).catch(() => null),
      refreshTaskGateSummary(rec),
    ])
    if (!taskIsActive(rec) || generation !== rec.generation) return null
    if (data || detail.dataset.loaded !== '1') applyTaskWorkflow(rec, data)
    detail.dataset.loaded = '1'
    return rec
  })()
  rec.loading = loading
  try { return await loading } finally { if (rec.loading === loading) rec.loading = null }
}

/* ═══════════════ 知识库视图 ═══════════════ */
async function renderDocs() {
  const d = state.docs
  const view = $('#view')
  view.innerHTML = `<div class="view-wrap">
    <div class="toolbar">
      <div class="search-box" id="docSearchBox">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
        <input type="text" id="docSearch" placeholder="按名称 / 分类过滤…" value="${esc(d.keyword)}" />
        <button class="clear" title="清空">✕</button>
      </div>
      <span class="chip mono" style="margin-left:auto">${esc(state.repo)}</span>
    </div>
    <div class="docs-layout">
      <div class="card docs-nav" id="docsNav"><div class="skeleton" style="height:200px;margin:6px"></div></div>
      <div class="card doc-viewer" id="docViewer">
        <div class="empty"><span class="empty-ico">📚</span>左侧选择一份规范文档<br><small>规范唯一真源存于 docs 表，IDE 通过 get_doc 读取同一份；测试脚本见侧栏「测试资产」</small></div>
      </div>
    </div>
  </div>`
  $('#docSearchBox').classList.toggle('has-kw', !!d.keyword)
  let timer = null
  $('#docSearch').oninput = (ev) => {
    d.keyword = ev.target.value
    $('#docSearchBox').classList.toggle('has-kw', !!d.keyword)
    clearTimeout(timer)
    timer = setTimeout(renderDocsNav, 300)
  }
  $('#docSearchBox .clear').onclick = () => { $('#docSearch').value = ''; d.keyword = ''; $('#docSearchBox').classList.remove('has-kw'); renderDocsNav() }

  await loadDocsList()
}
async function loadDocsList() {
  const d = state.docs
  try {
    const params = new URLSearchParams({ repo: state.repo })
    if (d.keyword.trim()) params.set('keyword', d.keyword.trim())
    const data = await api('/api/docs?' + params)
    d.items = data.items
  } catch (e) {
    $('#docsNav').innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>${esc(e.message)}</div>`
    return
  }
  renderDocsNav()
}
function renderDocsNav() {
  const d = state.docs
  const groups = new Map()
  for (const doc of d.items) {
    const cat = doc.category || '未分类'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(doc)
  }
  const nav = $('#docsNav')
  if (!d.items.length) {
    nav.innerHTML = `<div class="empty" style="padding:30px 10px"><span class="empty-ico">📭</span>没有匹配的文档</div>`
    return
  }
  nav.innerHTML = [...groups.entries()].map(([cat, docs]) => `
    <div class="docs-group-title">${esc(cat)} · ${docs.length}</div>
    ${docs.map((doc) => `
      <div class="doc-item ${d.selected?.name === doc.name && d.selected?.repo === doc.repo ? 'active' : ''}" data-name="${esc(doc.name)}" data-repo="${esc(doc.repo)}" data-kb tabindex="0">
        <span style="flex-shrink:0">📄</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.name)}</span>
        <span class="doc-size">${fmtBytes(doc.size)}</span>
      </div>`).join('')}
  `).join('')
  $$('.doc-item', nav).forEach((el) => {
    el.onclick = () => openDoc(el.dataset.name, el.dataset.repo)
  })
}
async function openDoc(name, repo) {
  const d = state.docs
  d.selected = { name, repo }
  d.showVersions = false
  d.versions = null
  $$('.doc-item').forEach((el) => el.classList.toggle('active', el.dataset.name === name && el.dataset.repo === repo))
  const viewer = $('#docViewer')
  viewer.innerHTML = `<div class="skeleton" style="height:280px"></div>`
  let data
  try {
    data = await api(`/api/docs/detail?name=${encodeURIComponent(name)}&repo=${encodeURIComponent(repo)}`)
  } catch (e) {
    viewer.innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>${esc(e.message)}</div>`
    return
  }
  const doc = data.doc
  viewer.innerHTML = `
    <div class="doc-head">
      <h2>${esc(doc.name)}</h2>
      <button class="btn sm" id="verBtn">🕘 版本历史（${data.versionCount}）</button>
    </div>
    <div class="doc-head-meta">
      <span class="chip">${esc(doc.category || '未分类')}</span>
      <span class="chip mono">${esc(doc.repo)}</span>
      <span class="chip">${fmtBytes(doc.content.length)}</span>
      <span class="chip">更新于 ${relTime(doc.updated_at)}</span>
      <span class="chip">${esc(doc.updated_by || 'unknown')}</span>
    </div>
    <div class="doc-content">${mdToHtml(doc.content)}</div>
    <div class="ver-panel" id="verPanel" style="display:none"></div>`
  $('#verBtn').onclick = () => toggleVersions(name, repo)
}
async function toggleVersions(name, repo) {
  const d = state.docs
  const panel = $('#verPanel')
  d.showVersions = !d.showVersions
  panel.style.display = d.showVersions ? 'block' : 'none'
  if (!d.showVersions) return
  panel.innerHTML = `<div class="empty" style="padding:20px">加载中…</div>`
  try {
    const data = await api(`/api/docs/versions?name=${encodeURIComponent(name)}&repo=${encodeURIComponent(repo)}`)
    if (!data.versions.length) {
      panel.innerHTML = `<div class="empty" style="padding:20px"><span class="empty-ico">🕓</span>暂无历史（该规范尚未被 update_doc 修改过）</div>`
      return
    }
    panel.innerHTML = `<div class="docs-group-title" style="padding-left:0">版本历史 · ${data.versions.length} 次变更</div>` +
      data.versions.map((v) => {
        const isRollback = String(v.content_before).startsWith('[rollback]')
        const before = (v.content_before || '').slice(0, 260)
        const after = (v.content_after || '').slice(0, 260)
        return `<div class="ver-item">
          <div class="ver-head">
            <b>v${v.version}</b>
            ${isRollback ? '<span class="chip amber">回滚点</span>' : '<span class="chip blue">变更</span>'}
            <span class="t">${fmtDateTime(v.created_at)}</span>
            <span>@${esc(v.author || 'unknown')}</span>
            <span style="flex:1"></span>
            <button class="btn danger sm" data-rollback="${v.id}">回滚到此版本</button>
          </div>
          <div class="ver-diff">
            ${before && !isRollback ? `<div class="del">- ${esc(before)}${(v.content_before || '').length > 260 ? '…' : ''}</div>` : ''}
            <div class="add">+ ${esc(after)}${(v.content_after || '').length > 260 ? '…' : ''}</div>
          </div>
        </div>`
      }).join('')
    $$('[data-rollback]', panel).forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`确认回滚 ${name} 到版本 #${b.dataset.rollback}？将产生一条新快照，不会丢数据。`)) return
        try {
          const r = await api('/api/docs/rollback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, repo, versionId: Number(b.dataset.rollback), author: state.username || 'dashboard' }),
          })
          toast(r.message || '已回滚', 'ok')
          openDoc(name, repo)
          d.showVersions = true
          toggleVersions(name, repo)
        } catch (e) {
          toast(`回滚失败：${e.message}`, 'err')
        }
      }
    })
  } catch (e) {
    panel.innerHTML = `<div class="empty" style="padding:20px">加载失败：${esc(e.message)}</div>`
  }
}

/* ═══════════════ 顶栏 / 全局 ═══════════════ */
async function initRepoSelect() {
  const sel = $('#repoSelect')
  try {
    const data = await api('/api/repos')
    const repos = data.repos
    if (state.repo !== 'all' && !repos.some((r) => r.repo === state.repo)) {
      state.repo = repos[0]?.repo || data.defaultRepo
    }
    sel.innerHTML = `<option value="all">全部项目</option>` +
      repos.map((r) => `<option value="${esc(r.repo)}">${esc(r.repo)}（经验 ${r.experiences} · 文档 ${r.docs} · 任务 ${r.tasks}）</option>`).join('')
    sel.value = state.repo
  } catch {
    sel.innerHTML = `<option>${esc(state.repo)}</option>`
  }
  sel.onchange = () => {
    state.repo = sel.value
    localStorage.setItem('mx.repo', state.repo)
    // 各视图筛选状态复位（跨项目后 module facets 等需要重建）
    state.exp.module = ''
    state.docs.selected = null
    render()
    updateNavBadge()
  }
}
function initTheme() {
  const saved = localStorage.getItem('mx.theme')
  if (saved) document.documentElement.dataset.theme = saved
  $('#themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? '' : 'dark'
    if (cur) document.documentElement.dataset.theme = cur
    else delete document.documentElement.dataset.theme
    localStorage.setItem('mx.theme', cur)
  }
}
function initHealth() {
  const tick = async () => {
    try {
      const h = await api('/api/health')
      $('#healthDot').className = 'dot ok'
      $('#healthText').textContent = '服务正常'
      $('#healthSub').textContent = `经验 ${h.counts.experiences} · 任务 ${h.counts.tasks} · 文档 ${h.counts.docs}`
    } catch {
      $('#healthDot').className = 'dot bad'
      $('#healthText').textContent = '服务不可达'
    }
  }
  tick()
  setInterval(tick, 30000)
}
$('#refreshBtn').onclick = () => { render(); toast('已刷新', 'info') }

/* ═══════════════ 测试资产库（独立页） ═══════════════ */

/** 轻量 JS/TS 语法高亮（无外部依赖） */
function highlightCode(src) {
  let s = esc(src || '')
  s = s.replace(/(\/\/[^\n]*)/g, '<span class="hl-c">$1</span>')
  s = s.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="hl-c">$1</span>')
  s = s.replace(/('[^'\n]*'|"[^"\n]*"|`[^`\n]*`)/g, '<span class="hl-s">$1</span>')
  s = s.replace(/\b(export|default|async|function|const|let|var|await|return|if|else|for|of|in|new|throw|try|catch|import|from|class|true|false|null|undefined)\b/g,
    '<span class="hl-k">$1</span>')
  s = s.replace(/\b(page|baseURL|waitForSelector|goto|click|getByText)\b/g, '<span class="hl-f">$1</span>')
  return s
}

/** 行级 diff（LCS），返回 [{type:add|del|eq, text}] */
function lineDiff(aText, bText) {
  const a = String(aText || '').split('\n')
  const b = String(bText || '').split('\n')
  const n = a.length, m = b.length
  // 小文件全量 LCS；大文件降级为按行前后对齐的简易 diff
  if (n * m > 400000) {
    const out = []
    const max = Math.max(n, m)
    for (let i = 0; i < max; i++) {
      if (a[i] === b[i]) out.push({ type: 'eq', text: a[i] ?? '' })
      else {
        if (a[i] != null) out.push({ type: 'del', text: a[i] })
        if (b[i] != null) out.push({ type: 'add', text: b[i] })
      }
    }
    return out
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'eq', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] })
  while (j < m) out.push({ type: 'add', text: b[j++] })
  return out
}

function diffHtml(rows) {
  return rows.map((r) => {
    const cls = r.type === 'add' ? 'df-add' : r.type === 'del' ? 'df-del' : ''
    const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '
    return `<div class="df-row ${cls}"><span class="df-sign">${sign}</span><span class="df-t">${highlightCode(r.text)}</span></div>`
  }).join('')
}
const SPEC_TYPE_META = {
  e2e: { label: 'e2e', cls: 'violet' },
  smoke: { label: 'smoke', cls: 'blue' },
  unit: { label: 'unit', cls: 'cyan' },
}
const SPEC_STATUS_META = {
  active: { label: 'active', cls: 'green' },
  draft: { label: 'draft', cls: 'amber' },
  'orphan-candidate': { label: 'orphan', cls: 'red' },
  reviewed: { label: 'reviewed', cls: 'blue' },
  archived: { label: 'archived', cls: '' },
}

function specResultChip(r) {
  if (r === 'passed') return '<span class="chip green">✓ passed</span>'
  if (r === 'failed') return '<span class="chip red">✗ failed</span>'
  return '<span class="chip">未执行</span>'
}

/* ─── 云端测试开关（按仓可插拔，specs 页管理卡） ──────────── */
const GATE_MODE_META = {
  enforce_all: {
    label: '强制门禁', chip: 'green',
    desc: '所有门禁节点都要求云端测试全绿才放行：没下单、执行中、有失败都会被拦回。适合已稳定接入的项目。',
  },
  enforce_ml: {
    label: '仅 M/L 强制', chip: 'violet',
    desc: '只有大任务（M/L）强制云端全绿；小任务（S）不拦，本地验证后可直接推进。',
  },
  enforce_s: {
    label: '仅 S 强制', chip: 'cyan',
    desc: '只有小任务（S）在收尾时强制云端全绿；M/L 大任务不拦。试点期用。',
  },
  observe: {
    label: '观察模式', chip: 'blue',
    desc: '云端测试照常执行并记录判断结果，但不拦截推进。接入初期用来观察新门禁是否误伤。',
  },
  legacy: {
    label: '传统守卫', chip: 'amber',
    desc: '与「已关闭」相同：不下单云端测试，只按本地规矩推进（L1 上报等）。与观察模式的区别：观察会跑云端但不拦；传统完全不跑云端。',
  },
  disabled: {
    label: '已关闭', chip: 'red',
    desc: '该仓云端测试整体停用：不下单、不建测试资产、门禁放行；其他仓不受影响。',
  },
}
const GATE_ENABLED_MODES = ['enforce_all', 'enforce_ml', 'enforce_s', 'observe', 'legacy']

/* ─── 项目管理视图（接入项目 · 云端测试开关/档位 · dev/qa 账号） ─── */
async function renderProjects() {
  const view = $('#view')
  let platformSettings = { workerConcurrency: 2, depCache: 'off', mutationStaticSkip: 'off' }
  try { platformSettings = { ...platformSettings, ...(await api('/api/testing/platform-settings')) } } catch { }
  const ps = platformSettings
  view.innerHTML = `
    <div class="projects-page">
      <div class="card pj-legend-card">
        <div class="gm-legend">
          <span class="pj-legend-cap">档位说明</span>
          ${Object.entries(GATE_MODE_META)
            .map(
              ([m, meta]) =>
                `<span class="gm-legend-item"><span class="chip ${meta.chip}">${meta.label}</span><span class="gm-help" data-tip="${esc(meta.desc)}">?</span></span>`
            )
            .join('')}
        </div>
      </div>
      <div class="card pj-worker-cc" style="padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0">
          <span class="pj-k" style="min-width:auto">Worker 并发</span>
          <span class="pj-env-switch" id="workerCcSwitch">
            ${[1, 2, 3].map((n) => `<button class="pj-env-btn ${n === ps.workerConcurrency ? 'active' : ''}" data-cc="${n}">${n}</button>`).join('')}
          </span>
          <span class="muted" style="font-size:11px">同时运行的考试 VM 数量上限（需 pm2 restart 生效）</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0;border-top:1px dashed var(--border)">
          <span class="pj-k" style="min-width:auto">依赖缓存</span>
          <label class="gm-switch" title="开启后：依赖未变时跳过 npm ci（省 5~10 分钟/场）。预热层按 仓+依赖指纹 隔离，租户不共享">
            <input type="checkbox" id="depCacheToggle" ${ps.depCache === 'on' ? 'checked' : ''} />
            <span class="gm-slider"></span>
          </label>
          <span class="chip ${ps.depCache === 'on' ? 'green' : 'amber'}">${ps.depCache === 'on' ? '已开启' : '默认关闭'}</span>
          <span class="muted" style="font-size:11px">三级差分盘缓存 node_modules；首次全量，之后秒级</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0;border-top:1px dashed var(--border)">
          <span class="pj-k" style="min-width:auto">变异预筛</span>
          <label class="gm-switch" title="开启后：考卷 pages 与本次改动无交集时跳过变异 VM（省一整轮）。有交集或无声明照旧真跑，保守不误判">
            <input type="checkbox" id="mutationSkipToggle" ${ps.mutationStaticSkip === 'on' ? 'checked' : ''} />
            <span class="gm-slider"></span>
          </label>
          <span class="chip ${ps.mutationStaticSkip === 'on' ? 'green' : 'amber'}">${ps.mutationStaticSkip === 'on' ? '已开启' : '默认关闭'}</span>
          <span class="muted" style="font-size:11px">静态预筛可疑考卷仍真跑 VM 复核</span>
        </div>
      </div>
      <div class="card pj-links-card" style="padding:12px 14px;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <span class="pj-k" style="min-width:auto">链路池</span>
          <span class="muted" style="font-size:11px">全局有序链路；项目只选首选，空=主链路。网关据此选路/重放/熔断（不随业务发版重启）。</span>
        </div>
        <div id="linksPanelBody"><div class="skeleton" style="height:80px;border-radius:10px"></div></div>
      </div>
      <div id="projCards" class="pj-cards">
        <div class="skeleton" style="height:120px;margin:14px;border-radius:10px"></div>
      </div>
    </div>`
  // Worker 并发设置
  $$('#workerCcSwitch .pj-env-btn').forEach((b) => {
    b.onclick = async () => {
      try {
        await api('/api/testing/platform-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'worker_concurrency', value: b.dataset.cc, author: 'dashboard' }),
        })
        toast(`Worker 并发已切换为 ${b.dataset.cc}（pm2 restart 后生效）`, 'ok')
        $$('#workerCcSwitch .pj-env-btn').forEach((x) => x.classList.toggle('active', x === b))
      } catch (e) { toast(`设置失败：${e.message}`, 'err') }
    }
  })
  // 依赖缓存开关
  const depToggle = $('#depCacheToggle')
  if (depToggle) depToggle.onchange = async (ev) => {
    const on = ev.target.checked
    try {
      await api('/api/testing/platform-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'dep_cache', value: on ? 'on' : 'off', author: 'dashboard' }),
      })
      toast(on ? '依赖缓存已开启：下一次考试仍全量跑并固化缓存层，之后命中即跳过 npm ci' : '依赖缓存已关闭：回到完整 npm ci 路径', 'ok')
    } catch (e) {
      ev.target.checked = !on
      toast(`设置失败：${e.message}`, 'err')
    }
  }
  // 变异静态预筛开关
  const mutToggle = $('#mutationSkipToggle')
  if (mutToggle) mutToggle.onchange = async (ev) => {
    const on = ev.target.checked
    try {
      await api('/api/testing/platform-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'mutation_static_skip', value: on ? 'on' : 'off', author: 'dashboard' }),
      })
      toast(on ? '变异静态预筛已开启：pages 与改动无交集的考卷跳过变异 VM' : '变异静态预筛已关闭：全部真跑 VM 验卷', 'ok')
    } catch (e) {
      ev.target.checked = !on
      toast(`设置失败：${e.message}`, 'err')
    }
  }
  await loadLinks()
  await loadProjects()
}

// ─── 链路池管理（链路网关方案 §9）───
async function loadLinks() {
  const box = $('#linksPanelBody')
  if (!box) return
  let data
  try {
    data = await api('/api/links')
  } catch (e) {
    box.innerHTML = `<div class="empty">加载链路失败：${esc(e.message)}</div>`
    return
  }
  const links = data.links || []
  box.innerHTML = `
    <div class="lk-addbar" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <input class="input lk-new-name" placeholder="名称" style="max-width:140px" />
      <input class="input lk-new-url" placeholder="http://主机:8791（无路径/查询）" style="min-width:240px" />
      <label class="muted" style="font-size:11px"><input type="checkbox" class="lk-new-primary" /> 设为主链路</label>
      <button class="pj-btn lk-add">添加</button>
    </div>
    <table class="lk-table" style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="text-align:left;color:var(--muted)"><th>名称</th><th>地址</th><th>序号</th><th>主链路</th><th>启用</th><th>操作</th></tr></thead>
      <tbody>
      ${links
        .map(
          (l) => `
        <tr data-link="${esc(l.link_id)}" data-primary="${Number(l.is_primary)}" style="border-top:1px solid var(--border)">
          <td><input class="input lk-name" value="${esc(l.name)}" /></td>
          <td><input class="input lk-url" value="${esc(l.base_url)}" /></td>
          <td><input class="input lk-sort" type="number" value="${Number(l.sort_order)}" style="width:64px" /></td>
          <td>${Number(l.is_primary) === 1 ? '<span class="chip blue">主链路</span>' : ''}</td>
          <td><input type="checkbox" class="lk-enabled" ${Number(l.enabled) === 1 ? 'checked' : ''} ${Number(l.is_primary) === 1 ? 'disabled' : ''} /></td>
          <td>
            <button class="pj-btn lk-save">保存</button>
            ${Number(l.is_primary) === 1
              ? ''
              : `<button class="pj-btn lk-toggle">${Number(l.enabled) === 1 ? '停用' : '启用'}</button><button class="pj-btn lk-del">删除</button>`}
          </td>
        </tr>`
        )
        .join('')}
      </tbody>
    </table>`

  const addBtn = box.querySelector('.lk-add')
  if (addBtn) addBtn.onclick = async () => {
    const name = box.querySelector('.lk-new-name').value.trim()
    const baseUrl = box.querySelector('.lk-new-url').value.trim()
    const isPrimary = box.querySelector('.lk-new-primary').checked ? 1 : 0
    if (!name || !baseUrl) { toast('名称与地址必填', 'err'); return }
    try {
      await api('/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, baseUrl, isPrimary, author: 'dashboard' }) })
      toast('链路已添加', 'ok')
      await loadLinks(); await loadProjects()
    } catch (e) { toast(`添加失败：${e.message}`, 'err') }
  }

  box.querySelectorAll('tbody tr').forEach((tr) => {
    const linkId = tr.dataset.link
    const isPrimary = Number(tr.dataset.primary) === 1
    tr.querySelector('.lk-save').onclick = async () => {
      const body = {
        name: tr.querySelector('.lk-name').value.trim(),
        baseUrl: tr.querySelector('.lk-url').value.trim(),
        sortOrder: Number(tr.querySelector('.lk-sort').value),
        enabled: isPrimary ? 1 : (tr.querySelector('.lk-enabled').checked ? 1 : 0),
      }
      try {
        await api(`/api/links/${encodeURIComponent(linkId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        toast('链路已保存', 'ok')
        await loadLinks(); await loadProjects()
      } catch (e) { toast(`保存失败：${e.message}`, 'err') }
    }
    const toggleBtn = tr.querySelector('.lk-toggle')
    if (toggleBtn) toggleBtn.onclick = async () => {
      const nextEnabled = tr.querySelector('.lk-enabled').checked ? 0 : 1
      try {
        await api(`/api/links/${encodeURIComponent(linkId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: nextEnabled }) })
        toast(nextEnabled ? '链路已启用' : '链路已停用', 'ok')
        await loadLinks(); await loadProjects()
      } catch (e) { toast(`操作失败：${e.message}`, 'err') }
    }
    const delBtn = tr.querySelector('.lk-del')
    if (delBtn) delBtn.onclick = async () => {
      try {
        await api(`/api/links/${encodeURIComponent(linkId)}`, { method: 'DELETE' })
        toast('链路已删除（指向它的项目首选已置空）', 'ok')
        await loadLinks(); await loadProjects()
      } catch (e) { toast(`删除失败：${e.message}`, 'err') }
    }
  })
}

async function loadProjects() {
  const box = $('#projCards')
  if (!box) return
  let data
  try {
    data = await api('/api/testing/projects')
  } catch (e) {
    box.innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>加载失败：${esc(e.message)}</div>`
    return
  }
  const envs = data.envs || ['dev', 'qa']
  box.innerHTML = (data.projects || [])
    .map((p) => {
      const meta = GATE_MODE_META[p.mode] || GATE_MODE_META.legacy
      const lastEnabled = p.mode === 'disabled' ? 'enforce_all' : p.mode
      const gateRow = `
          <div class="pj-item pj-gate" data-slug="${esc(p.slug)}">
            <span class="pj-k">云端测试</span>
            <span class="chip ${meta.chip} gm-badge" title="${esc(meta.desc)}">${meta.label}</span>
            <span class="gm-help" data-tip="${esc(meta.desc)}">?</span>
            <select class="input gm-mode" ${p.enabled ? '' : 'disabled'} title="启用时的门禁档位">
              ${GATE_ENABLED_MODES
                .map((m) => `<option value="${m}"${lastEnabled === m ? ' selected' : ''}>${GATE_MODE_META[m].label}</option>`)
                .join('')}
            </select>
            <label class="gm-switch" title="${p.enabled ? '点击关闭该项目云端测试' : '点击开启该项目云端测试'}">
              <input type="checkbox" class="gm-toggle" ${p.enabled ? 'checked' : ''} />
              <span class="gm-slider"></span>
            </label>
          </div>`
      const e2eMode = p.e2eInjectMode || 'scoped'
      const e2eHelp = {
        scoped: '回归卷始终跑；task 卷只跑与本次改动 pages 相关的（默认，省钱）',
        all: '该项目全部 active 考卷都注入（旧行为，最全最贵）',
        regression_only: '只跑标记为 regression 的考卷（最快，可能漏任务相关断言）',
      }
      const e2eRow = `
          <div class="pj-item pj-e2e" data-slug="${esc(p.slug)}">
            <span class="pj-k">E2E 注入</span>
            <select class="input e2e-mode" title="${esc(e2eHelp[e2eMode] || e2eHelp.scoped)}">
              ${(p.e2eInjectModes || ['scoped', 'all', 'regression_only'])
                .map((m) => `<option value="${m}"${e2eMode === m ? ' selected' : ''}>${{ scoped: '按改动（推荐）', all: '全量', regression_only: '仅回归' }[m] || m}</option>`)
                .join('')}
            </select>
            <span class="muted" style="font-size:11px">${esc(e2eHelp[e2eMode] || e2eHelp.scoped)}</span>
          </div>`
      const envRows = envs
        .map((env) => {
          const a = p.accounts?.[env] || { configured: false }
          return `
          <div class="pj-item pj-account" data-env="${esc(env)}">
            <span class="pj-k">${env.toUpperCase()} 环境${env === p.defaultEnv ? ' <span class="chip blue">默认</span>' : ''}</span>
            <span class="chip ${a.configured ? 'green' : 'amber'} pj-acct-state">${a.configured ? `已设 ${esc(a.username || '')}` : '未设置'}</span>
            <input class="input pj-user" placeholder="账号" value="${esc(a.username || '')}" />
            <input class="input pj-pass" type="password" placeholder="${a.configured ? '留空 = 不修改密码' : '密码'}" />
            <button class="pj-btn pj-save" data-slug="${esc(p.slug)}" data-env="${esc(env)}">保存</button>
            ${a.configured ? `<button class="pj-btn pj-clear" data-slug="${esc(p.slug)}" data-env="${esc(env)}">清除</button>` : ''}
          </div>`
        })
        .join('')
      const envSwitch = `
          <span class="pj-env-switch">
            ${envs
              .map(
                (env) =>
                  `<button class="pj-env-btn ${p.defaultEnv === env ? 'active' : ''}" data-slug="${esc(p.slug)}" data-env="${esc(env)}" title="把默认测试环境切到 ${env.toUpperCase()}">${env.toUpperCase()}</button>`
              )
              .join('')}
          </span>`
      return `
      <div class="card pj-card" data-slug="${esc(p.slug)}">
        <div class="pj-head">
          <div class="pj-title"><span class="pj-slug">${esc(p.slug)}</span>${p.display_name && p.display_name !== p.slug ? `<span class="gm-dname">${esc(p.display_name)}</span>` : ''}</div>
        </div>
        <div class="pj-grid">
          ${gateRow}
          ${e2eRow}
          <div class="pj-item">
            <span class="pj-k">工作区</span>
            ${p.workspace
              ? `<span class="chip ${p.workspace.exists ? 'green' : 'red'}" title="${esc(p.workspace.path)}">${p.workspace.exists ? '已就绪' : '缺失'}</span><span class="pj-path">${esc(p.workspace.path)}</span>`
              : '<span class="muted">未配置工作区（检查 data/repo-platform.json 或 AWP_REPO_PATH_<SLUG>）</span>'}
          </div>
          <div class="pj-item">
            <span class="pj-k">测试资产</span>
            <span class="chip mono">${p.specCount} 个</span>
            <span class="chip mono">${(p.profile?.defaultSides || []).join(' / ') || '双侧'}</span>
          </div>
          <div class="pj-item">
            <span class="pj-k">租户定制</span>
            ${p.tenant?.applicable
              ? `${p.tenant.invalid ? '<span class="chip red">config 解析失败</span>' : ''}
                 ${p.tenant.rules.length ? `<span class="chip">规则 ${p.tenant.rules.length}</span>` : ''}
                 ${p.tenant.skills.length ? `<span class="chip">技能 ${p.tenant.skills.length}</span>` : ''}
                 ${p.tenant.hasOpenspec ? '<span class="chip blue">OpenSpec</span>' : ''}
                 ${!p.tenant.rules.length && !p.tenant.skills.length && !p.tenant.hasOpenspec ? '<span class="muted" style="font-size:11px">无定制（.awp/ 目录）</span>' : ''}`
              : '<span class="muted" style="font-size:11px">无工作区</span>'}
          </div>
          <div class="pj-item">
            <span class="pj-k">默认环境</span>
            ${envSwitch}
            <span class="muted" style="font-size:11px">测试执行时走该环境（账号需已设置）</span>
          </div>
          <div class="pj-item pj-link" data-slug="${esc(p.slug)}">
            <span class="pj-k">默认链路</span>
            <select class="input pj-link-sel" title="项目首选链路；选「主链路」= 走全局主链路">
              <option value=""${!p.defaultLinkId ? ' selected' : ''}>主链路</option>
              ${(p.links || [])
                .map((l) => `<option value="${esc(l.link_id)}"${p.defaultLinkId === l.link_id ? ' selected' : ''}>${esc(l.name)}</option>`)
                .join('')}
            </select>
            <span class="muted" style="font-size:11px">仅影响 /mcp 选路顺序（云端考试仍只由主机 host-worker 执行）</span>
          </div>
          ${envRows}
        </div>
      </div>`
    })
    .join('') || '<div class="empty">暂无已登记项目</div>'

  $$('.pj-gate', box).forEach((row) => {
    const slug = row.dataset.slug
    const postGate = (mode) =>
      api('/api/testing/gate-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: slug, mode, author: 'dashboard' }),
      })
    row.querySelector('.gm-toggle').onchange = async (ev) => {
      const on = ev.target.checked
      const mode = on ? row.querySelector('.gm-mode').value : 'disabled'
      try {
        await postGate(mode)
        toast(
          on ? `${slug} 云端测试已开启（${GATE_MODE_META[mode].label}）` : `${slug} 云端测试已关闭，任务不再走云端门禁`,
          on ? 'ok' : 'info'
        )
        await loadProjects()
      } catch (e) {
        ev.target.checked = !on
        toast(`切换失败：${e.message}`, 'err')
      }
    }
    row.querySelector('.gm-mode').onchange = async (ev) => {
      try {
        await postGate(ev.target.value)
        toast(`${slug} 档位已切换为 ${GATE_MODE_META[ev.target.value].label}`, 'ok')
        await loadProjects()
      } catch (e) {
        toast(`切换失败：${e.message}`, 'err')
      }
    }
  })
  $$('.e2e-mode', box).forEach((sel) => {
    sel.onchange = async () => {
      const slug = sel.closest('.pj-e2e')?.dataset.slug
      if (!slug) return
      try {
        await api(`/api/testing/projects/${encodeURIComponent(slug)}/e2e-inject-mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: sel.value, author: 'dashboard' }),
        })
        toast(`${slug} E2E 注入策略：${sel.options[sel.selectedIndex].text}`, 'ok')
        await loadProjects()
      } catch (e) {
        toast(`设置失败：${e.message}`, 'err')
      }
    }
  })
  $$('.pj-env-btn', box).forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/testing/projects/${encodeURIComponent(b.dataset.slug)}/default-env`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: b.dataset.env }),
        })
        toast(`${b.dataset.slug} 默认测试环境已切换为 ${b.dataset.env.toUpperCase()}`, 'ok')
        await loadProjects()
      } catch (e) {
        toast(`切换失败：${e.message}`, 'err')
      }
    }
  })
  $$('.pj-link', box).forEach((row) => {
    const sel = row.querySelector('.pj-link-sel')
    if (!sel) return
    sel.onchange = async () => {
      const slug = row.dataset.slug
      try {
        await api(`/api/testing/projects/${encodeURIComponent(slug)}/default-link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkId: sel.value || null }),
        })
        toast(`${slug} 默认链路已设为 ${sel.value ? sel.options[sel.selectedIndex].text : '主链路'}`, 'ok')
        await loadProjects()
      } catch (e) {
        toast(`设置失败：${e.message}`, 'err')
        await loadProjects()
      }
    }
  })
  $$('.pj-save', box).forEach((b) => {
    b.onclick = async () => {
      const wrap = b.closest('.pj-account')
      const username = wrap.querySelector('.pj-user').value.trim()
      const password = wrap.querySelector('.pj-pass').value
      if (!username) { toast('账号不能为空', 'err'); return }
      if (!password) { toast('请输入密码（留空仅修改账号无效）', 'err'); return }
      try {
        await api(`/api/testing/projects/${encodeURIComponent(b.dataset.slug)}/account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: b.dataset.env, username, password }),
        })
        toast(`${b.dataset.slug} ${b.dataset.env} 账号已保存（密码入 secret-broker，主库不落明文）`, 'ok')
        await loadProjects()
      } catch (e) {
        toast(`保存失败：${e.message}`, 'err')
      }
    }
  })
  $$('.pj-clear', box).forEach((b) => {
    b.onclick = async () => {
      try {
        await api(`/api/testing/projects/${encodeURIComponent(b.dataset.slug)}/account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ env: b.dataset.env, action: 'clear' }),
        })
        toast(`${b.dataset.slug} ${b.dataset.env} 账号已清除`, 'info')
        await loadProjects()
      } catch (e) {
        toast(`清除失败：${e.message}`, 'err')
      }
    }
  })
}

/* ─── 全页截图灯箱（点击放大 / 点击遮罩关闭） ──────────────── */
window.__openLightbox = (src, alt) => {
  let lb = document.getElementById('imgLightbox')
  if (!lb) {
    lb = document.createElement('div')
    lb.id = 'imgLightbox'
    lb.className = 'img-lightbox'
    lb.innerHTML = '<img alt="" /><div class="img-lightbox-tip">点击任意处关闭</div>'
    lb.onclick = () => lb.classList.remove('open')
    document.body.appendChild(lb)
  }
  lb.querySelector('img').src = src
  lb.querySelector('img').alt = alt || ''
  lb.classList.add('open')
}

function renderSpecs() {
  const s = state.specs
  const view = $('#view')
  view.innerHTML = `
    <div class="specs-page">
      <div class="specs-toolbar card">
        <input id="specQ" class="input" placeholder="搜索 featureKey / 标题 / 需求…" value="${esc(s.q)}" style="min-width:220px;flex:1" />
        <select id="specType" class="input" style="width:auto">
          <option value="">全部类型</option>
          <option value="e2e"${s.type === 'e2e' ? ' selected' : ''}>e2e</option>
          <option value="smoke"${s.type === 'smoke' ? ' selected' : ''}>smoke</option>
          <option value="unit"${s.type === 'unit' ? ' selected' : ''}>unit</option>
        </select>
        <select id="specStatus" class="input" style="width:auto">
          <option value="">全部状态</option>
          <option value="active"${s.status === 'active' ? ' selected' : ''}>active</option>
          <option value="draft"${s.status === 'draft' ? ' selected' : ''}>draft</option>
          <option value="orphan-candidate"${s.status === 'orphan-candidate' ? ' selected' : ''}>orphan</option>
          <option value="archived"${s.status === 'archived' ? ' selected' : ''}>archived</option>
        </select>
        <input id="specSide" class="input" style="width:150px" placeholder="按侧别筛选" value="${esc(s.side || '')}" />
        <select id="specSort" class="input" style="width:auto">
          <option value="updated"${s.sort === 'updated' ? ' selected' : ''}>最近更新</option>
          <option value="streak"${s.sort === 'streak' ? ' selected' : ''}>连败优先</option>
          <option value="key"${s.sort === 'key' ? ' selected' : ''}>按 key</option>
        </select>
      </div>
      <div class="specs-metrics" id="specMetrics"></div>
      <div class="specs-layout">
        <aside class="specs-tree card" id="specTree"></aside>
        <section class="specs-list card" id="specList">
          <div class="skeleton" style="height:120px;margin:14px;border-radius:10px"></div>
        </section>
      </div>
      <div class="specs-drawer-mask" id="specDrawerMask" hidden></div>
      <aside class="specs-drawer" id="specDrawer" hidden></aside>
    </div>`
  $('#specQ').oninput = debounce(() => { s.q = $('#specQ').value; loadSpecsCatalog() }, 280)
  $('#specType').onchange = () => { s.type = $('#specType').value; loadSpecsCatalog() }
  $('#specStatus').onchange = () => { s.status = $('#specStatus').value; loadSpecsCatalog() }
  $('#specSide').oninput = debounce(() => { s.side = $('#specSide').value.trim(); loadSpecsCatalog() }, 280)
  $('#specSort').onchange = () => { s.sort = $('#specSort').value; loadSpecsCatalog() }
  $('#specDrawerMask').onclick = closeSpecDrawer
  loadSpecsCatalog()
}

function debounce(fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

async function loadSpecsCatalog() {
  const s = state.specs
  const qs = new URLSearchParams({ repo: state.repo })
  if (s.q) qs.set('q', s.q)
  if (s.type) qs.set('type', s.type)
  if (s.status) qs.set('status', s.status)
  if (s.side) qs.set('side', s.side)
  let cat
  try {
    cat = await api(`/api/testing/spec-catalog?${qs}`)
  } catch (e) {
    $('#specList').innerHTML = `<div class="empty"><span class="empty-ico">⚠️</span>加载失败：${esc(e.message)}</div>`
    return
  }
  s.catalog = cat
  renderSpecMetrics(cat.metrics)
  renderSpecTree(cat)
  renderSpecList(cat)
}

function renderSpecMetrics(m) {
  $('#specMetrics').innerHTML = `
    <div class="metric-card"><div class="metric-n">${m.total}</div><div class="metric-l">总资产</div></div>
    <div class="metric-card green"><div class="metric-n">${m.active}</div><div class="metric-l">active</div></div>
    <div class="metric-card amber"><div class="metric-n">${m.draft}</div><div class="metric-l">draft</div></div>
    <div class="metric-card red"><div class="metric-n">${m.orphan}</div><div class="metric-l">orphan</div></div>
    <div class="metric-card violet"><div class="metric-n">${m.streak3}</div><div class="metric-l">连败≥3</div></div>`
}

function renderSpecTree(cat) {
  const s = state.specs
  const el = $('#specTree')
  el.innerHTML = `
    <div class="specs-tree-h">模块 <span class="muted">(${cat.tree.length})</span></div>
    <div class="specs-tree-all${!s.module ? ' on' : ''}" data-mod="">全部</div>
    ${cat.tree.map((t) => `
      <div class="specs-tree-mod${s.module === t.module ? ' on' : ''}" data-mod="${esc(t.module)}">
        <span class="stm-name">${esc(t.module)}</span>
        <span class="stm-meta">${t.active}✓${t.failed ? ` ${t.failed}✗` : ''} · ${t.count}</span>
      </div>`).join('') || '<div class="empty" style="padding:16px">暂无模块</div>'}`
  $$('.specs-tree-all, .specs-tree-mod', el).forEach((n) => {
    n.onclick = () => { s.module = n.dataset.mod || ''; loadSpecsCatalog() }
  })
}

function renderSpecList(cat) {
  const s = state.specs
  let items = cat.items
  if (s.module) {
    const pre = s.module
    items = items.filter((x) => String(x.featureKey).startsWith(pre))
  }
  const list = $('#specList')
  if (!items.length) {
    list.innerHTML = `<div class="empty"><span class="empty-ico">📦</span>没有匹配的测试资产<br><small>开发时用 awp_test_lookup / awp_test_spec_submit 创建</small></div>`
    return
  }
  list.innerHTML = `<div class="specs-cards">${items.map((it) => {
    const tm = SPEC_TYPE_META[it.specType] || { label: it.specType, cls: '' }
    const sm = SPEC_STATUS_META[it.reviewStatus] || { label: it.reviewStatus, cls: '' }
    return `
    <div class="spec-card" data-fk="${esc(it.featureKey)}">
      <div class="spec-card-top">
        <div class="spec-fk">${esc(it.featureKey)}</div>
        <div class="spec-badges">
          <span class="chip ${tm.cls}">${tm.label}</span>
          ${it.side ? `<span class="chip">${esc(it.side)}</span>` : ''}
          <span class="chip ${sm.cls}">${sm.label}</span>
        </div>
      </div>
      <div class="spec-title">${esc(it.featureTitle || it.demandRef || '—')}${it.slug && state.repo === 'all' ? ` <span class="chip mono">${esc(it.slug)}</span>` : ''}</div>
      <div class="spec-meta">
        <span>v${it.version}</span>
        ${specResultChip(it.lastResult)}
        ${it.failStreak ? `<span class="chip red">连败 ${it.failStreak}</span>` : ''}
        <span class="muted">${relTime(it.updatedAt)}</span>
        <span class="muted">${esc(it.author || '')}</span>
      </div>
      <div class="spec-actions">
        <button class="btn ghost sm" data-open="${esc(it.featureKey)}">查看详情</button>
        ${it.reviewStatus === 'active' ? `<button class="btn ghost sm spec-scope" data-fk="${esc(it.featureKey)}" data-scope="${it.scope === 'regression' ? 'task' : 'regression'}" title="切换是否始终注入门禁">${it.scope === 'regression' ? '取消回归' : '标为回归'}</button>` : ''}
      </div>
    </div>`
  }).join('')}</div>`
  $$('[data-open]', list).forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); openSpecDrawer(b.dataset.open) }
  })
  $$('.spec-scope', list).forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation()
      const repo = state.repo === 'all' ? '' : state.repo
      if (!repo) { toast('请先在顶栏选择具体项目', 'err'); return }
      try {
        await api('/api/testing/specs/scope', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo, featureKey: b.dataset.fk, scope: b.dataset.scope, author: 'dashboard' }),
        })
        toast(`${b.dataset.fk} → ${b.dataset.scope === 'regression' ? '回归（始终注入）' : '任务相关（按改动）'}`, 'ok')
        render()
      } catch (e) {
        toast(`设置失败：${e.message}`, 'err')
      }
    }
  })
  $$('.spec-card', list).forEach((c) => {
    c.onclick = () => openSpecDrawer(c.dataset.fk)
  })
}

async function openSpecDrawer(featureKey, opts = {}) {
  const drawer = $('#specDrawer')
  const mask = $('#specDrawerMask')
  drawer.hidden = false
  mask.hidden = false
  drawer.innerHTML = `<div class="skeleton" style="height:200px;margin:16px;border-radius:10px"></div>`
  const repoQ = opts.repo || (state.repo === 'all' ? '' : state.repo)
  const qs = repoQ ? `?repo=${encodeURIComponent(repoQ)}` : ''
  let detail, runs
  try {
    detail = await api(`/api/testing/spec-catalog/${encodeURIComponent(featureKey)}${qs}`)
    try {
      runs = await api(`/api/testing/spec-catalog/${encodeURIComponent(featureKey)}/runs${repoQ ? `?repo=${encodeURIComponent(repoQ)}` : ''}`)
    } catch { runs = [] }
  } catch (e) {
    drawer.innerHTML = `<div class="specs-drawer-h"><span>加载失败</span><button class="icon-btn" id="specDrawerX">✕</button></div><div class="gate-err" style="margin:16px">${esc(e.message)}</div>`
    $('#specDrawerX').onclick = closeSpecDrawer
    return
  }
  const m = detail.meta
  const tm = SPEC_TYPE_META[m.specType] || { label: m.specType, cls: '' }
  const sm = SPEC_STATUS_META[m.reviewStatus] || { label: m.reviewStatus, cls: '' }
  const hist = detail.history || []
  const prev = hist.find((h) => h.version < m.version) || null

  drawer.innerHTML = `
    <div class="specs-drawer-h">
      <div>
        <div class="spec-fk">${esc(m.featureKey)} <span class="chip ${tm.cls}">${tm.label}</span>${m.side ? ` <span class="chip">${esc(m.side)}</span>` : ''} <span class="chip ${sm.cls}">${sm.label}</span></div>
        <div class="muted" style="font-size:12px;margin-top:4px">${esc(m.featureTitle || '')} · v${m.version} · ${esc(m.author || '')} · ${fmtDateTime(m.updatedAt)}${m.codeCommitOid ? ` · ${esc(String(m.codeCommitOid).slice(0, 8))}` : ''}</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button class="btn sm" id="specActArchive" title="下架：下一轮冻结清单不再包含该卷（写审计）">下架</button>
        <button class="btn sm" id="specActActivate" title="人工放行：改为 active（写审计）">放行</button>
        <button class="btn primary sm" id="specResubmit" title="提示在 IDE 中重提门禁">重提门禁</button>
        <button class="icon-btn" id="specDrawerX" title="关闭">✕</button>
      </div>
    </div>
    <div class="specs-drawer-tabs">
      <button class="on" data-tab="code">源码</button>
      <button data-tab="diff" ${prev ? '' : 'disabled title="无历史版本"'}>版本 Diff</button>
      <button data-tab="hist">版本历史</button>
      <button data-tab="runs">执行记录 <span class="muted">${runs.length}</span></button>
    </div>
    <div class="specs-drawer-body">
      <div id="tabCode" class="spec-tab">
        <pre class="gate-log-pre hl" style="max-height:calc(100vh - 210px)">${highlightCode(detail.content || '')}</pre>
      </div>
      <div id="tabDiff" class="spec-tab" hidden>
        <div class="muted" style="font-size:12px;margin-bottom:8px">${prev ? `v${prev.version} → v${m.version}` : '仅一版，无法 diff'}</div>
        <div id="diffBody" class="diff-body">${prev ? '<div class="skeleton" style="height:80px"></div>' : ''}</div>
      </div>
      <div id="tabHist" class="spec-tab" hidden>
        ${hist.map((h) => `
          <div class="hist-row${h.version === m.version ? ' on' : ''}" data-ver="${h.version}" style="cursor:pointer">
            <span class="mono">v${h.version}</span>
            <span class="chip ${SPEC_STATUS_META[h.review_status]?.cls || ''}">${esc(h.review_status)}</span>
            ${specResultChip(h.last_result)}
            ${h.fail_streak ? `<span class="chip red">连败 ${h.fail_streak}</span>` : ''}
            <span class="muted">${relTime(h.updated_at)}</span>
          </div>`).join('')}
      </div>
      <div id="tabRuns" class="spec-tab" hidden>
        ${runs.length ? runs.map((r) => `
          <div class="hist-row">
            <span class="chip ${r.checkStatus === 'passed' ? 'green' : r.checkStatus === 'failed' ? 'red' : ''}">${esc(r.checkStatus || r.status)}</span>
            <span class="mono">${esc(r.unit)}:${esc(r.side || '—')}</span>
            <span class="muted">${fmtDateTime(r.finishedAt || r.createdAt)}</span>
            ${r.checkDetail ? `<details style="margin-left:auto"><summary class="link">详情</summary><pre class="gate-log-pre" style="margin-top:6px">${esc(r.checkDetail)}</pre></details>` : ''}
          </div>`).join('') : '<div class="empty" style="padding:20px">暂无执行记录</div>'}
      </div>
    </div>`
  $('#specDrawerX').onclick = closeSpecDrawer
  // 人工流转（2026-09-26）：AI 审卷员误判时的人工回退通道——下架/放行都走 transition 端点并记审计
  const specOperator = () => {
    let who = localStorage.getItem('awp-operator')
    if (!who) {
      who = (prompt('操作人（记入审计 human:<author>）：') || '').trim()
      if (who) localStorage.setItem('awp-operator', who)
    }
    return who
  }
  const specTransition = async (reviewStatus, confirmText) => {
    const who = specOperator()
    if (!who) return toast('需要操作人身份（author）才能流转考卷', 'err')
    if (!confirm(confirmText)) return
    try {
      await api(`/api/testing/specs/${encodeURIComponent(featureKey)}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoId: repoQ || state.repo, version: m.version, reviewStatus, author: who, notes: '看板人工流转' }),
      })
      toast(`已流转 ${featureKey} v${m.version} → ${reviewStatus}`, 'ok')
      closeSpecDrawer()
      renderSpecs()
    } catch (e) {
      toast('流转失败：' + (e.message || e), 'err')
    }
  }
  const actArchive = $('#specActArchive')
  const actActivate = $('#specActActivate')
  if (actArchive) actArchive.onclick = () => specTransition('archived', `下架 ${featureKey} v${m.version}？下一轮冻结清单不再包含该卷。`)
  if (actActivate) actActivate.onclick = () => specTransition('active', `人工放行 ${featureKey} v${m.version} 为 active？`)
  $('#specResubmit').onclick = () => {
    const cmd = `awp_test_run({ taskId: "<taskId>", author: "<你>", repo: "${m.featureKey && repoQ ? repoQ : state.repo === 'all' ? 'demo-app' : state.repo}", wait: true, productFixed: true, suiteFixed: true })`
    navigator.clipboard?.writeText(cmd).catch(() => {})
    toast('请在 IDE MCP 中执行：' + cmd.slice(0, 80) + '…（已复制）', 'info')
  }
  $$('.specs-drawer-tabs button', drawer).forEach((b) => {
    if (b.disabled) return
    b.onclick = () => {
      $$('.specs-drawer-tabs button', drawer).forEach((x) => x.classList.remove('on'))
      b.classList.add('on')
      $('#tabCode').hidden = b.dataset.tab !== 'code'
      $('#tabDiff').hidden = b.dataset.tab !== 'diff'
      $('#tabHist').hidden = b.dataset.tab !== 'hist'
      $('#tabRuns').hidden = b.dataset.tab !== 'runs'
      if (b.dataset.tab === 'diff' && prev && !$('#diffBody').dataset.loaded) {
        loadSpecDiff(featureKey, prev.version, m.version, repoQ)
      }
    }
  })
  $$('#tabHist .hist-row', drawer).forEach((row) => {
    row.onclick = () => {
      const v = Number(row.dataset.ver)
      if (v === m.version) return
      closeSpecDrawer()
      setTimeout(() => openSpecDrawer(featureKey, { repo: repoQ, version: v }), 50)
    }
  })
  // 支持打开指定历史版本
  if (opts.version && opts.version !== m.version) {
    closeSpecDrawer()
    setTimeout(() => openSpecDrawerAtVersion(featureKey, opts.version, repoQ), 40)
  }
}

async function openSpecDrawerAtVersion(featureKey, version, repoQ) {
  // 详情 API 支持 ?version=
  const drawer = $('#specDrawer')
  const mask = $('#specDrawerMask')
  drawer.hidden = false
  mask.hidden = false
  drawer.innerHTML = `<div class="skeleton" style="height:200px;margin:16px;border-radius:10px"></div>`
  try {
    const detail = await api(`/api/testing/spec-catalog/${encodeURIComponent(featureKey)}?version=${version}${repoQ ? `&repo=${encodeURIComponent(repoQ)}` : ''}`)
    const m = detail.meta
    drawer.innerHTML = `
      <div class="specs-drawer-h">
        <div>
          <div class="spec-fk">${esc(m.featureKey)} <span class="chip">历史 v${m.version}</span></div>
          <div class="muted" style="font-size:12px;margin-top:4px">只读历史版本 · ${fmtDateTime(m.updatedAt)}</div>
        </div>
        <button class="icon-btn" id="specDrawerX">✕</button>
      </div>
      <div class="specs-drawer-body">
        <pre class="gate-log-pre hl" style="max-height:calc(100vh - 120px)">${highlightCode(detail.content || '')}</pre>
      </div>`
    $('#specDrawerX').onclick = () => openSpecDrawer(featureKey, { repo: repoQ })
  } catch (e) {
    drawer.innerHTML = `<div class="gate-err" style="margin:16px">${esc(e.message)}</div>`
  }
}

async function loadSpecDiff(featureKey, fromV, toV, repoQ) {
  const box = $('#diffBody')
  if (!box) return
  try {
    const [from, to] = await Promise.all([
      api(`/api/testing/spec-catalog/${encodeURIComponent(featureKey)}?version=${fromV}${repoQ ? `&repo=${encodeURIComponent(repoQ)}` : ''}`),
      api(`/api/testing/spec-catalog/${encodeURIComponent(featureKey)}?version=${toV}${repoQ ? `&repo=${encodeURIComponent(repoQ)}` : ''}`),
    ])
    const rows = lineDiff(from.content, to.content)
    box.dataset.loaded = '1'
    box.innerHTML = diffHtml(rows)
  } catch (e) {
    box.innerHTML = `<div class="gate-err">${esc(e.message)}</div>`
  }
}

function closeSpecDrawer() {
  $('#specDrawer').hidden = true
  $('#specDrawerMask').hidden = true
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
    const search = $('#expSearch') || $('#docSearch')
    if (search) { ev.preventDefault(); search.focus() }
  }
  // data-kb 元素支持 Enter / 空格 触发点击（键盘可达性）
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches?.('[data-kb]')) {
    ev.preventDefault()
    ev.target.click()
  }
})

// L6：轮询 deferred 队列健康；主机 host-worker 停摆导致云测静默积压时，顶部显式红灯横幅。
function initDeferredHealth() {
  let banner = document.getElementById('deferredHealthBanner')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'deferredHealthBanner'
    banner.hidden = true
    banner.setAttribute('role', 'alert')
    banner.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:9999;' +
      'background:#fc3f41;color:#fff;padding:8px 16px;border-radius:2px;font-size:13px;line-height:1.4;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:90vw;'
    document.body.appendChild(banner)
  }
  const tick = async () => {
    try {
      const d = await api('/api/testing/deferred-health')
      if (d && d.redFlag) {
        const ageS = Math.round((d.oldestPendingAgeMs || 0) / 1000)
        banner.textContent = `⚠ 云测队列停摆：${d.counts.pending} 条 deferred 待处理，最老已等待 ${ageS}s，主机 host-worker 疑似未运行 → 云端门禁将无限排队`
        banner.hidden = false
      } else {
        banner.hidden = true
      }
    } catch { banner.hidden = true }
  }
  tick()
  setInterval(() => { if (!document.hidden) tick() }, 30000)
}

/* ═══════════════ 启动 ═══════════════ */
async function boot() {
  initTheme()
  initHealth()
  initDeferredHealth()
  try { state.labels = await api('/api/harness/labels') } catch { /* 静默 */ }
  await initRepoSelect()
  await render()
  connectStream()
  updateNavBadge()
  setInterval(updateNavBadge, 60000)
}
boot()
