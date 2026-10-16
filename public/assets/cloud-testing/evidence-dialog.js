import { escapeHtml, formatDateTime, formatDuration, statusMeta, runLabel } from './model.js'

const TABS = { report: '报告', checks: '检查项', timeline: '时间线', diagnostics: '失败诊断', compare: '运行比较', pack: '证据包', logs: '日志' }
const list = (value) => Array.isArray(value) ? value : []
const valueText = (value) => value == null ? '未记录' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
const esc = (value) => escapeHtml(valueText(value))
const attemptKey = (value) => value == null || value === '' ? null : String(value)
const timeText = (value) => value == null || value === '' ? '未记录时间' : formatDateTime(value)
let nextDialogId = 0

// 核心样式由窗口自身持有，避免与其他 public 模块或全站 dialog 样式耦合。
const STYLES = `
.ct-evidence{box-sizing:border-box;width:min(1100px,calc(100vw - 24px));max-width:calc(100vw - 24px);height:min(880px,90dvh);max-height:90dvh;padding:0;border:1px solid var(--border,#ccd1db);border-radius:16px;background:var(--panel,#fff);color:var(--text,#172033);box-shadow:0 24px 80px #0005;overflow:hidden;font:inherit}
.ct-evidence[open]{display:flex;flex-direction:column}
.ct-evidence:not([open]){display:none}
.ct-evidence::backdrop{background:rgb(12 18 30 / 58%)}
.ct-evidence.ct-dialog-fallback{position:fixed;inset:0;margin:auto;z-index:10000;box-shadow:0 0 0 100vmax #10182799}
.ct-evidence *{box-sizing:border-box;min-width:0}
.ct-evidence [hidden]{display:none!important}
.ct-evidence .ct-dialog-head{flex:none;padding:16px 20px 12px;border-bottom:1px solid var(--border,#ccd1db);max-height:44dvh;overflow:auto}
.ct-evidence .ct-dialog-titlebar,.ct-evidence .ct-dialog-controls,.ct-evidence .ct-dialog-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ct-evidence .ct-dialog-titlebar{justify-content:space-between}
.ct-evidence h2{font-size:1.2rem;margin:0}
.ct-evidence h3{font-size:1.06rem;margin:16px 0 10px}
.ct-evidence h4{margin:10px 0}
.ct-evidence p{margin:8px 0;line-height:1.6}
.ct-evidence .ct-dialog-context{font-size:.88rem;overflow-wrap:anywhere;line-height:1.6;margin:8px 0;color:var(--muted,#606b7c)}
.ct-evidence button,.ct-evidence select,.ct-evidence input[type=search],.ct-evidence summary,.ct-evidence .ct-dialog-download{font:inherit;min-height:44px;min-width:44px}
.ct-evidence button,.ct-evidence select,.ct-evidence input[type=search],.ct-evidence .ct-dialog-download{border:1px solid var(--border,#ccd1db);border-radius:8px;background:var(--panel,#fff);color:var(--text,#172033);padding:8px 12px}
.ct-evidence button,.ct-evidence summary{cursor:pointer}
.ct-evidence button:disabled{opacity:.6;cursor:not-allowed}
.ct-evidence :is(button,select,input,a,summary,pre):focus-visible{outline:3px solid var(--accent,#3668db);outline-offset:2px}
.ct-evidence label{display:flex;align-items:center;gap:8px;min-height:44px}
.ct-evidence .ct-dialog-controls label:first-child{flex:1 1 240px}
.ct-evidence select{max-width:100%;width:100%}
.ct-evidence .ct-dialog-tabs{display:flex;flex:none;gap:6px;padding:8px 20px;border-bottom:1px solid var(--border,#ccd1db);overflow:auto}
.ct-evidence [role=tab]{flex:1;white-space:nowrap;border-color:transparent}
.ct-evidence [role=tab][aria-selected=true]{border-color:var(--accent,#3668db);color:var(--accent,#3668db);font-weight:700}
.ct-evidence .ct-dialog-body{flex:1;min-height:0;overflow:auto;padding:4px 20px 20px;overscroll-behavior:contain}
.ct-evidence .ct-dialog-notice{color:var(--muted,#606b7c);font-size:.9rem;overflow-wrap:anywhere}
.ct-evidence .ct-dialog-live{flex:none;min-height:24px;padding:2px 20px;font-size:.88rem;color:var(--muted,#606b7c)}
.ct-evidence .ct-dialog-card{border:1px solid var(--border,#ccd1db);border-radius:10px;padding:12px;margin:10px 0;overflow-wrap:anywhere}
.ct-evidence .ct-dialog-badge{display:inline-block;border:1px solid var(--border,#ccd1db);border-radius:20px;padding:3px 9px;margin:0 6px 4px 0;font-size:.85rem}
.ct-evidence .ct-dialog-badge[data-tone=success],.ct-evidence .ct-dialog-badge[data-tone=green]{color:#167142}
.ct-evidence .ct-dialog-badge[data-tone=danger],.ct-evidence .ct-dialog-badge[data-tone=error],.ct-evidence .ct-dialog-badge[data-tone=red]{color:#b32d3e}
.ct-evidence .ct-dialog-badge[data-tone=warning],.ct-evidence .ct-dialog-badge[data-tone=amber]{color:#936000}
.ct-evidence .ct-dialog-fields{display:grid;grid-template-columns:minmax(75px,auto) minmax(0,1fr);gap:6px 16px;margin:10px 0}
.ct-evidence dt{color:var(--muted,#606b7c)}
.ct-evidence dd{margin:0;overflow-wrap:anywhere}
.ct-evidence pre{font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
.ct-evidence summary{display:flex;align-items:center;gap:8px;font-weight:600}
.ct-evidence .ct-dialog-loglayout{display:grid;grid-template-columns:240px minmax(0,1fr);gap:16px;margin-top:12px}
.ct-evidence .ct-dialog-files{display:flex;flex-direction:column;gap:6px;max-height:44dvh;overflow:auto;margin-top:8px}
.ct-evidence .ct-dialog-files button{text-align:left;overflow-wrap:anywhere}
.ct-evidence .ct-dialog-files [aria-pressed=true]{border-color:var(--accent,#3668db);background:var(--panel-2,var(--panel,#fff))}
.ct-evidence .ct-dialog-toolbar input[type=search]{flex:1;max-width:100%}
.ct-evidence .ct-dialog-searchlabel{display:block}
.ct-evidence .ct-dialog-searchlabel input{width:100%}
.ct-evidence .ct-dialog-logtext{max-height:48dvh;overflow:auto;padding:12px;border:1px solid var(--border,#ccd1db);border-radius:8px;overscroll-behavior:contain}
.ct-evidence .ct-dialog-logtext[data-wrap=false]{white-space:pre;overflow-wrap:normal}
.ct-evidence mark{background:#ffe18a;color:#211d10}
.ct-evidence video,.ct-evidence img{display:block;max-width:100%;max-height:48dvh;margin:12px 0}
.ct-evidence .ct-dialog-download{display:inline-flex;align-items:center;text-decoration:underline}
@media(max-width:600px){.ct-evidence{width:calc(100vw - 12px);max-width:calc(100vw - 12px);height:94dvh;max-height:94dvh;border-radius:10px}.ct-evidence .ct-dialog-head{padding:10px 12px}.ct-evidence .ct-dialog-tabs{padding:6px 12px}.ct-evidence .ct-dialog-body{padding:4px 12px 12px}.ct-evidence .ct-dialog-loglayout{grid-template-columns:minmax(0,1fr)}.ct-evidence .ct-dialog-files{max-height:160px}.ct-evidence .ct-dialog-controls{gap:6px}.ct-evidence .ct-dialog-context{font-size:.8rem}}
@media(prefers-reduced-motion:reduce){.ct-evidence,.ct-evidence *{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
`

function badge(status, dimension = 'execution') {
  const normalized = status === 'ok' ? 'passed' : status === 'skip' ? 'skipped' : status
  const meta = statusMeta(normalized || 'unknown', dimension)
  return `<span class="ct-dialog-badge" data-tone="${esc(meta.tone)}">${esc(meta.label)}</span>`
}

function fields(entries) {
  return `<dl class="ct-dialog-fields">${entries.map(([name, value]) => `<dt>${esc(name)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`
}

function details(record) {
  return ['expected', 'actual', 'detail', 'note', 'evidence'].filter((key) => record[key] != null && record[key] !== '')
    .map((key) => `<div><b>${({ expected: '期望', actual: '实际', detail: '详情', note: '备注', evidence: '证据引用' })[key]}</b><pre>${esc(record[key])}</pre></div>`).join('')
}

function errorText(error) {
  const code = error?.reason ?? error?.code ?? error?.error ?? null
  const known = { not_uploaded: '日志尚未上传', expired: '日志包已过期', scan_rejected: '安全扫描拒绝', missing: '日志包缺失', ARTIFACT_EXPIRED: '日志包已过期', ARTIFACT_NOT_FOUND: '日志包缺失' }
  return [known[code], code == null ? null : valueText(code), error?.message, error?.detail].filter(Boolean).join(' · ') || '证据加载失败，原因未记录'
}

function checkedResponse(data) {
  if (!data || data.ok === false) throw new Error(errorText(data))
  return data
}

function fileKind(file) {
  if (/\.(webm|mp4|ogv|ogg|mov)$/i.test(file.path) || file.kind === 'video' || String(file.kind).startsWith('video/')) return 'video'
  if (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(file.path) || file.kind === 'image') return 'image'
  if (file.kind === 'binary' || /\.(zip|gz|7z|pdf|exe|dll|woff2?|bin|sqlite|db)$/i.test(file.path)) return 'binary'
  return file.kind === 'text' || /\.(log|txt|json|jsonl|xml|html|css|[cm]?js|ts|csv|ya?ml|md|out|err)$/i.test(file.path) ? 'text' : 'binary'
}

export function createEvidenceDialog({ api, repo, taskId }) {
  const id = `ct-evidence-${++nextDialogId}`
  const style = document.createElement('style')
  style.dataset.ctEvidenceStyle = id
  style.textContent = STYLES
  document.head.append(style)
  const dialog = document.createElement('dialog')
  dialog.className = 'ct-evidence'
  dialog.setAttribute('aria-labelledby', `${id}-title`)
  dialog.setAttribute('aria-describedby', `${id}-context`)
  dialog.setAttribute('aria-modal', 'true')
  dialog.innerHTML = `<header class="ct-dialog-head">
    <div class="ct-dialog-titlebar"><h2 id="${id}-title">云端测试证据</h2><button type="button" data-action="close" autofocus>关闭</button></div>
    <div class="ct-dialog-context" id="${id}-context"></div>
    <div class="ct-dialog-controls"><label>执行单元<select data-control="run" aria-label="执行单元"></select></label><label>尝试<select data-control="attempt" aria-label="尝试"></select></label></div>
  </header><nav class="ct-dialog-tabs" role="tablist" aria-label="证据类型">${Object.entries(TABS).map(([key, label]) => `<button type="button" role="tab" id="${id}-tab-${key}" aria-controls="${id}-${key}" data-tab="${key}" aria-selected="false" tabindex="-1">${label}</button>`).join('')}</nav>
  <div class="ct-dialog-live" role="status" aria-live="polite" aria-atomic="true"></div>
  <main class="ct-dialog-body">${Object.keys(TABS).map((key) => `<section id="${id}-${key}" data-panel="${key}" role="tabpanel" aria-labelledby="${id}-tab-${key}" tabindex="0" hidden></section>`).join('')}</main>`
  document.body.append(dialog)
  const find = (selector) => dialog.querySelector(selector)
  const panel = (name) => find(`[data-panel="${name}"]`)
  const listeners = []
  const on = (target, event, callback, options) => {
    target.addEventListener(event, callback, options)
    listeners.push(() => target.removeEventListener(event, callback, options))
  }
  let disposed = false, opened = false, generation = 0, logIntent = 0
  let round, nodes = [], selectedRun = null, selectedAttempt = null, activeTab = 'report', observedAt
  let triggerElement = null, focusScope = null, background = [], fallback = false
  let logStates = new Map(), timelines = new Map(), diagnostics = new Map(), comparisons = new Map(), comparisonTargets = new Map(), diagnosticBusy = new Set(), diagnosticMessages = new Map(), experienceSubmitting = false, tabScroll = new Map()
  const preferences = new Map()
  const requests = new Map()
  const say = (text) => { find('.ct-dialog-live').textContent = text }
  const currentNode = () => nodes.find((node) => String(node.runId) === selectedRun)
  const contextKey = () => JSON.stringify([round?.submissionId, selectedRun, selectedAttempt])
  const activeRequests = () => {
    generation += 1
    logIntent += 1
    for (const request of requests.values()) request.controller.abort()
    requests.clear()
  }
  const begin = (slot) => {
    requests.get(slot)?.controller.abort()
    const request = { generation, controller: new AbortController() }
    requests.set(slot, request)
    return { signal: request.controller.signal, valid: () => opened && !disposed && generation === request.generation && requests.get(slot) === request && !request.controller.signal.aborted }
  }
  function logState() {
    const key = contextKey()
    if (!logStates.has(key)) {
      const pref = preferences.get(key) || {}
      logStates.set(key, { files: null, artifactId: null, attempt: null, legacy: false, truncated: false, path: pref.path || '', filter: pref.filter || '', search: pref.search || '', wrap: pref.wrap !== false, scroll: new Map(pref.scroll || []), text: null, displayedPath: null, forcedArtifact: null, promise: null })
    }
    return logStates.get(key)
  }
  function saveReading() {
    if (!round) return
    const state = logStates.get(contextKey())
    if (state) {
      const pre = find('.ct-dialog-logtext')
      if (pre && state.displayedPath) state.scroll.set(state.displayedPath, [pre.scrollTop, pre.scrollLeft])
      preferences.set(contextKey(), { path: state.path, filter: state.filter, search: state.search, wrap: state.wrap, scroll: [...state.scroll] })
    }
    tabScroll.set(`${contextKey()}:${activeTab}`, find('.ct-dialog-body').scrollTop)
  }
  function attemptOptions(node) {
    return [...new Set([...list(node?.attempts).map((item) => attemptKey(item.attempt)), attemptKey(node?.reportAttempt), attemptKey(node?.artifact?.attempt), selectedAttempt].filter((item) => item != null))]
  }
  function renderHeader() {
    const node = currentNode()
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区'
    find('.ct-dialog-context').textContent = `仓库：${repo || '未记录'} · 任务：${taskId} · 所选正式轮：${round.roundNo == null ? '序号未记录' : `第 ${round.roundNo} 轮`} · 提交：${round.submissionId} · 运行：${selectedRun || '未选择'} · ${selectedAttempt == null ? '运行级（未指定尝试）' : `尝试 ${selectedAttempt}`} · 数据截至：${timeText(observedAt)} · 时区：${zone} · 固定轮次快照，不自动刷新`
    find('[data-control="run"]').innerHTML = nodes.filter((item) => item.runId != null).map((item) => `<option value="${esc(item.runId)}">${esc(runLabel(item))} · ${esc(item.runId)}</option>`).join('') || '<option value="">本轮无运行记录</option>'
    find('[data-control="run"]').value = selectedRun || ''
    find('[data-control="run"]').disabled = !nodes.some((item) => item.runId != null)
    find('[data-control="attempt"]').innerHTML = '<option value="">运行级（未指定尝试）</option>' + attemptOptions(node).map((value) => `<option value="${esc(value)}">尝试 ${esc(value)}</option>`).join('')
    find('[data-control="attempt"]').value = selectedAttempt || ''
    find('[data-control="attempt"]').disabled = !node
  }
  function renderReport() {
    const active = [round, ...nodes].some((node) => ['active', 'running', 'queued', 'preparing', 'uploading'].includes(node.status))
    const rows = (items, mutation) => items.map((node) => `<article class="ct-dialog-card"><h4>${esc(runLabel(node))}</h4>
      ${badge(mutation ? node.state : node.status, mutation ? 'mutationVerdict' : 'execution')}
      ${mutation ? `<p>原始执行：${badge(node.status)}</p>` : ''}
      ${fields([['运行', node.runId], ['已记录尝试', list(node.attempts).length ? `${list(node.attempts).length} 次尝试，${Math.max(0, list(node.attempts).length - 1)} 次重试` : '未记录'], ['耗时', node.totalMs == null ? '未记录' : formatDuration(node.totalMs)]])}
      ${node.summary ? `<pre>${esc(node.summary)}</pre>` : ''}${node.reason ? `<p>原因：${esc(node.reason)}</p>` : ''}
      ${node.runId == null ? '' : `<button type="button" data-action="node-checks" data-run="${esc(node.runId)}">查看检查项</button>`}</article>`).join('') || '<p class="ct-dialog-notice">本轮无此类记录，不判定为通过。</p>'
    const formal = nodes.filter((node) => node.kind !== 'mutation')
    const mutations = nodes.filter((node) => node.kind === 'mutation')
    panel('report').innerHTML = `<h3>${active ? '阶段报告' : '本轮报告'} · ${round.roundNo == null ? '轮次序号未记录' : `第 ${esc(round.roundNo)} 轮`}</h3>
      <p class="ct-dialog-notice">仅展示所选正式轮的已记录事实；本轮执行通过不等于任务验收完成。${round.historical ? '正在查看历史轮，保留原结果。' : ''}</p>
      ${badge(round.status)}${fields([['提交', round.submissionId], ['创建时间', timeText(round.createdAt)], ['绑定', round.bindingId], ['数据截至', timeText(observedAt)]])}
      <button type="button" data-action="copy-submission">复制提交标识</button>
      <h3>正式执行 · 已记录 ${formal.length} 项</h3>${rows(formal, false)}
      <h3>变异验卷 · 已记录 ${mutations.length} 项</h3>${rows(mutations, true)}
      ${list(round.steps).filter((step) => ['prepare', 'execute', 'mutation'].includes(step.kind)).map((step) => `<section class="ct-dialog-card"><h4>${esc(step.label || ({ prepare: '准备', execute: '执行', mutation: '变异验卷' })[step.kind])}</h4><p>${esc(step.summary || '未记录摘要')}</p></section>`).join('')}`
  }
  function renderChecks() {
    const node = currentNode()
    if (!node) { panel('checks').textContent = '本轮没有可查看的运行检查项。'; return }
    const owner = attemptKey(node.reportAttempt)
    if (selectedAttempt != null && owner !== selectedAttempt) {
      panel('checks').textContent = owner == null ? `尝试 ${selectedAttempt} 的检查项不可用：仅有运行级报告，尝试归属未记录。请切换到运行级查看，不将其归入本次尝试。` : `尝试 ${selectedAttempt} 的检查项不可用：已有报告属于尝试 ${owner}，不能作为所选尝试的检查项。`
      return
    }
    panel('checks').innerHTML = `<h3>检查项</h3><p class="ct-dialog-notice">${owner == null ? '运行级报告，尝试归属未记录。' : `报告归属：尝试 ${esc(owner)}。`}不是所有尝试的完整报告。</p>` +
      (list(node.checks).map((check) => `<article class="ct-dialog-card"><h4>${esc(check.name || check.caseKey || '未命名检查项')}</h4>${badge(check.status)}${check.durationMs == null ? '' : `<span>${esc(formatDuration(check.durationMs))}</span>`}<details><summary>检查详情</summary>${details(check) || '<p>未记录详情。</p>'}</details></article>`).join('') || '<p>未记录检查项，不判定为通过。</p>')
  }
  function timelineSource(step, data) {
    const source = step.source || (['recorded', 'synthesized'].includes(data.source) ? data.source : null)
    return source === 'recorded' ? '已记录' : source === 'synthesized' || source === 'inferred' ? '由结果推断' : '来源未逐项记录（旧接口可能混合记录与推断）'
  }
  function renderTimeline(data) {
    const groups = new Map()
    for (const step of list(data.steps)) {
      const owner = attemptKey(step.attempt)
      if (selectedAttempt != null && owner != null && owner !== selectedAttempt) continue
      if (!groups.has(owner)) groups.set(owner, [])
      groups.get(owner).push(step)
    }
    panel('timeline').innerHTML = `<h3>执行时间线</h3><p class="ct-dialog-notice">按所选运行读取已返回事件，不代表截至时间的历史快照；未记录时间不推测时刻。运行级摘要不代表所选尝试结论。</p>
      ${groups.size ? '' : '<p>未记录时间线。</p>'}
      ${data.summary == null ? '' : `<details><summary>运行级摘要</summary><pre>${esc(data.summary)}</pre></details>`}
      ${data.failureAnalysis == null ? '' : `<details><summary>运行级失败分析</summary><pre>${esc(data.failureAnalysis)}</pre></details>`}
      ${selectedAttempt != null && !groups.has(selectedAttempt) ? '<p>所选尝试没有已返回的时间线事件。</p>' : ''}
      ${[...groups].map(([owner, steps]) => `<section data-timeline-attempt="${esc(owner || '')}"><h3>${owner == null ? '运行级事件 · 尝试归属未记录' : `尝试 ${esc(owner)}`}</h3>${steps.map((step) => {
        const evidence = step.evidence && typeof step.evidence === 'object' && !Array.isArray(step.evidence) ? step.evidence : {}
        const path = step.logPath || evidence.logPath || evidence.path
        return `<article class="ct-dialog-card"><h4>${esc(step.name || '未命名事件')}</h4>${badge(step.status)}<span class="ct-dialog-badge">${esc(timelineSource(step, data))}</span>
          ${fields([['时间', timeText(step.at)], ['耗时', step.durationMs == null ? '未记录' : formatDuration(step.durationMs)]])}
          <details><summary>事件详情</summary>${details(step) || '<p>未记录详情。</p>'}</details>
          ${path ? `<button type="button" data-action="timeline-log" data-path="${esc(path)}" data-attempt="${esc(owner || '')}" data-artifact="${esc(evidence.artifactId || step.artifactId || '')}">看日志</button>` : ''}</article>`
      }).join('')}</section>`).join('')}`
  }
  function renderDiagnostics(data) {
    const analysis = data.failureAnalysis || {}
    const suggestions = list(data.suggestions)
    const status = data.status || '未知'
    panel('diagnostics').innerHTML = `<h3>失败诊断</h3><p class="ct-dialog-notice">运行级结果：${esc(status)} · 单元 ${esc(data.unit || '未记录')}:${esc(data.side || '未记录')} · 分类、建议和相似项仅基于本次运行及同仓已记录数据；未复核建议不会写入经验库。</p>
      ${diagnosticMessages.get(selectedRun) ? `<p role="status">${esc(diagnosticMessages.get(selectedRun))}</p>` : ''}
      ${analysis.hasFailure ? `<article class="ct-dialog-card"><h4>${esc(analysis.categoryZh || analysis.category || '失败原因未分类')}</h4>${fields([['失败阶段', data.phase || '未记录'], ['首错用例', analysis.firstCaseKey || '未记录'], ['终结原因', data.terminalReason || '未记录']])}<details><summary>失败摘要与依据</summary><pre>${esc(analysis.text || '未生成失败摘要')}</pre></details></article>` : `<p class="ct-dialog-notice">没有可用于诊断的失败检查项。运行状态为 ${esc(status)}；这不代表未执行项已通过。</p>`}
      <h4>可执行建议</h4>${suggestions.map((suggestion) => {
        const feedback = suggestion.feedback
        const busy = diagnosticBusy.has(suggestion.suggestionId)
        return `<article class="ct-dialog-card" data-diagnostic-suggestion="${esc(suggestion.suggestionId)}"><h4>${esc(suggestion.title)}</h4><p>${esc(suggestion.reason)}</p><p>${esc(suggestion.nextStep)}</p><details><summary>证据来源</summary><pre>${esc(suggestion.evidence)}</pre></details>
          ${feedback ? `<p role="status">${feedback.action === 'confirm' ? '已确认建议' : '已忽略建议'} · ${esc(feedback.author || '未记录操作者')} · ${esc(timeText(feedback.createdAt))}${feedback.note ? ` · ${esc(feedback.note)}` : ''}</p>` : `<div class="ct-dialog-toolbar"><button type="button" data-action="diagnostic-feedback" data-suggestion-id="${esc(suggestion.suggestionId)}" data-feedback-action="confirm"${busy ? ' disabled' : ''}>${busy ? '正在提交…' : '确认建议'}</button><button type="button" data-action="diagnostic-feedback" data-suggestion-id="${esc(suggestion.suggestionId)}" data-feedback-action="ignore"${busy ? ' disabled' : ''}>忽略建议</button></div>`}</article>`
      }).join('') || '<p class="ct-dialog-notice">没有建议可确认或忽略。</p>'}
      <h4>相似失败</h4>${list(data.similarFailures).map((item) => `<article class="ct-dialog-card"><h4>${esc(item.case_key || '未记录用例')} · ${esc(item.failure_class || '未分类')}</h4><p>发生 ${esc(item.occurrence_count || 1)} 次 · ${esc(item.status || '未知状态')}</p><pre>${esc(item.error_signature || '无错误摘要')}</pre></article>`).join('') || '<p class="ct-dialog-notice">同仓暂无匹配的历史失败。</p>'}
      <h4>已审核经验</h4>${list(data.similarExperiences).map((item) => `<article class="ct-dialog-card"><h4>${esc(item.title || '未命名经验')}</h4><p>${esc(item.content || '')}</p><p class="ct-dialog-notice">审核时间：${esc(timeText(item.reviewedAt))}</p></article>`).join('') || '<p class="ct-dialog-notice">同仓暂无匹配的已审核经验。</p>'}
      ${analysis.hasFailure ? `<form data-experience-form class="ct-dialog-card"><h4>提交解决经验</h4><p class="ct-dialog-notice">提交后状态为“未验证”，经过人工审核后才会标记为已确认经验。</p><label class="ct-dialog-searchlabel">解决办法<textarea data-control="experience-resolution" maxlength="4000" required rows="4"></textarea></label><button type="submit"${experienceSubmitting ? ' disabled' : ''}>${experienceSubmitting ? '正在提交…' : '提交待审核反馈'}</button></form>` : ''}`
  }
  async function submitExperienceFeedback(event) {
    event.preventDefault()
    const data = diagnostics.get(selectedRun), input = panel('diagnostics').querySelector('[data-control="experience-resolution"]')
    if (experienceSubmitting) return
    if (!data || !input?.value.trim()) { say('请填写解决办法后再提交'); return }
    const analysis = data.failureAnalysis || {}
    const scope = { unit: data.unit, side: data.side, phase: data.phase, category: analysis.category || 'unknown', caseKey: analysis.firstCaseKey || null }
    const evidence = { runId: data.runId, caseKey: analysis.firstCaseKey || null, terminalReason: data.terminalReason || null, source: 'stored_run_report' }
    const feedback = {
      repo: data.repo, runId: data.runId, failureId: data.similarFailures?.[0]?.failure_id || null,
      sourceType: 'run', failureSummary: `${analysis.categoryZh || analysis.category || '失败'} · ${analysis.firstCaseKey || 'case 未记录'}`,
      resolutionSummary: input.value.trim(), scope, evidence,
    }
    experienceSubmitting = true
    renderDiagnostics(data)
    const request = begin('experience-feedback'), run = selectedRun
    try {
      const response = checkedResponse(await api.submitExperienceFeedback(feedback, { signal: request.signal }))
      if (!request.valid()) return
      experienceSubmitting = false
      diagnostics.delete(run)
      diagnosticMessages.set(run, response.feedback?.verificationStatus === 'unverified' || response.feedback?.verification_status === 'unverified'
        ? '解决经验已提交，当前为未验证状态，等待人工审核。' : '解决经验已提交，请在反馈清单查看审核状态。')
      await loadDiagnostics()
      say('未验证解决经验已提交')
    } catch (error) {
      if (!request.valid()) return
      experienceSubmitting = false
      diagnosticMessages.set(run, `解决经验未提交：${errorText(error)}`)
      renderDiagnostics(data)
      say('解决经验提交失败，未显示为已提交')
    }
  }
  async function loadDiagnostics() {
    if (!currentNode()) { panel('diagnostics').textContent = '本轮没有可查看的运行诊断。'; return }
    if (diagnostics.has(selectedRun)) { renderDiagnostics(diagnostics.get(selectedRun)); return }
    panel('diagnostics').textContent = '正在加载失败诊断…'
    const request = begin('diagnostics'), run = selectedRun
    try {
      const data = checkedResponse(await api.getDiagnostics(run, { signal: request.signal }))
      if (!request.valid()) return
      assertOwnership(data, null, null)
      diagnostics.set(run, data)
      renderDiagnostics(data)
      say('失败诊断已加载')
    } catch (error) {
      if (!request.valid()) return
      panel('diagnostics').textContent = errorText(error)
      say('失败诊断加载失败，原因已保留')
    }
  }
  async function submitDiagnosticFeedback(button) {
    const run = selectedRun, suggestionId = button.dataset.suggestionId, action = button.dataset.feedbackAction
    diagnosticBusy.add(suggestionId)
    diagnosticMessages.delete(run)
    if (diagnostics.has(run)) renderDiagnostics(diagnostics.get(run))
    const request = begin('diagnostic-feedback')
    try {
      await api.submitDiagnosticFeedback(run, suggestionId, { action, signal: request.signal })
      if (!request.valid()) return
      diagnostics.delete(run)
      diagnosticBusy.delete(suggestionId)
      diagnosticMessages.set(run, action === 'confirm' ? '建议确认已记录。' : '建议忽略已记录。')
      await loadDiagnostics()
      say(action === 'confirm' ? '建议确认已审计' : '建议忽略已审计')
    } catch (error) {
      if (!request.valid()) return
      diagnosticBusy.delete(suggestionId)
      diagnosticMessages.set(run, `反馈未记录：${errorText(error)}`)
      if (diagnostics.has(run)) renderDiagnostics(diagnostics.get(run))
      say('反馈写入失败，未显示为已记录')
    }
  }
  function compareOptions() {
    return list(round?.runs).filter((node) => node?.runId != null && String(node.runId) !== selectedRun)
  }
  function renderComparison(data, selectedId) {
    const options = compareOptions()
    const selector = `<label>对比运行<select data-control="compare-run" aria-label="对比基准运行">${options.map((node) => `<option value="${esc(node.runId)}"${String(node.runId) === String(selectedId) ? ' selected' : ''}>${esc(runLabel(node))} · ${esc(node.status || '未知')}</option>`).join('')}</select></label>`
    if (!data) {
      panel('compare').innerHTML = `<h3>运行比较</h3>${selector}<p class="ct-dialog-notice">${options.length ? '选择本正式轮中的另一运行以比较配置、用例集合、结果和耗时。' : '当前正式轮没有其他可比较的运行。'}</p>`
      return
    }
    const labels = { suitePlanId: '套件计划', suiteLockSha256: '套件锁', requiredCaseSetSha256: '必需用例集', profileRevisionId: '执行配置', profileSha256: '执行配置摘要', runnerImageId: '运行镜像', imageManifestSha256: '镜像清单摘要', policyRevisionId: '策略版本', policySha256: '策略摘要' }
    const configs = Object.entries(data.configuration || {}).map(([key, item]) => `<li>${esc(labels[key] || key)}：${esc(item.before || '未记录')} → ${esc(item.after || '未记录')} ${item.equal ? '（相同）' : '（变化/缺失）'}</li>`).join('') || '<li>冻结配置未记录。</li>'
    const changes = list(data.statusChanges).map((item) => `<li>${esc(item.caseKey)}：${esc(item.before)} → ${esc(item.after)}</li>`).join('') || '<li>共同用例状态未变化，或缺少可比较用例。</li>'
    const failures = (items) => list(items).map((item) => `<li>${esc(item.caseKey)} · ${esc(item.status)}${item.detail ? ` · ${esc(item.detail)}` : ''}</li>`).join('') || '<li>没有记录失败检查项。</li>'
    panel('compare').innerHTML = `<h3>运行比较</h3>${selector}<p class="ct-dialog-notice">左侧 ${esc(data.left.runId)} → 右侧 ${esc(data.right.runId)}。先检查集合变化；只有配置、lane 和集合都一致时，整体结果与耗时才可直接比较。</p>
      <article class="ct-dialog-card"><h4>${data.comparable ? '统计口径一致' : '当前结果不可直接比较'}</h4>${data.comparable ? '<p>冻结配置、执行 lane 和用例集合一致。</p>' : `<ul>${list(data.comparabilityReasons).map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>`}
      ${fields([['前次状态', data.left.status], ['本次状态', data.right.status], ['前次耗时', data.left.durationMs == null ? '未记录' : formatDuration(data.left.durationMs)], ['本次耗时', data.right.durationMs == null ? '未记录' : formatDuration(data.right.durationMs)], ['耗时变化', data.durationDeltaMs == null ? '未知' : `${data.durationDeltaMs > 0 ? '+' : ''}${formatDuration(Math.abs(data.durationDeltaMs))}`], ['共同检查项', `${data.denominator.common} / ${data.denominator.before} → ${data.denominator.after}`]])}</article>
      <article class="ct-dialog-card"><h4>用例集合</h4><p>新增：${esc(data.caseSet.added.join('、') || '无')} · 移除：${esc(data.caseSet.removed.join('、') || '无')}</p><p>共同检查项：${esc(data.caseSet.common)}</p></article>
      <article class="ct-dialog-card"><h4>冻结配置</h4><ul>${configs}</ul></article><article class="ct-dialog-card"><h4>共同用例状态变化</h4><ul>${changes}</ul></article>
      <div class="ct-dialog-loglayout"><article class="ct-dialog-card"><h4>前次失败</h4><ul>${failures(data.failedChecks.before)}</ul></article><article class="ct-dialog-card"><h4>本次失败</h4><ul>${failures(data.failedChecks.after)}</ul></article></div>`
  }
  async function loadComparison() {
    const options = compareOptions()
    if (!options.length) { renderComparison(null, null); return }
    const against = comparisonTargets.get(selectedRun) || String(options[0].runId)
    comparisonTargets.set(selectedRun, against)
    const key = `${selectedRun}\0${against}`
    if (comparisons.has(key)) { renderComparison(comparisons.get(key), against); return }
    renderComparison(null, against)
    panel('compare').insertAdjacentHTML('beforeend', '<p>正在比较所选运行…</p>')
    const request = begin('compare'), run = selectedRun
    try {
      const data = checkedResponse(await api.compareRuns(run, against, { signal: request.signal }))
      if (!request.valid()) return
      if (String(data?.left?.runId || '') !== run || String(data?.right?.runId || '') !== against) throw new Error('比较响应不属于当前所选的两个运行。')
      assertOwnership(data, null, null)
      comparisons.set(key, data)
      renderComparison(data, against)
      say('运行比较已加载')
    } catch (error) {
      if (!request.valid()) return
      panel('compare').insertAdjacentHTML('beforeend', `<p role="status">${esc(errorText(error))}</p>`)
      say('运行比较失败，原因已保留')
    }
  }
  function renderEvidencePack() {
    if (!currentNode()) { panel('pack').textContent = '本轮没有可导出的运行证据。'; return }
    const url = `/api/testing/runs/${encodeURIComponent(selectedRun)}/evidence-pack`
    panel('pack').innerHTML = `<h3>可复现证据包</h3><p class="ct-dialog-notice">导出包含脱敏运行摘要、冻结用例锁、检查结果、阶段日志摘要和制品哈希。不会包含源码、原始日志正文或制品归档。</p>
      <article class="ct-dialog-card"><h4>所选运行</h4>${fields([['Run ID', selectedRun], ['状态', currentNode().status || '未记录'], ['单元', `${currentNode().unit || '未记录'}:${currentNode().side || '未记录'}`]])}
      <a class="ct-dialog-download" href="${esc(url)}">下载证据包 ZIP</a><p class="ct-dialog-notice">下载后运行 <code>node scripts/verify-evidence-pack.mjs --file &lt;下载文件&gt;</code> 校验清单、每个文件的 SHA-256 和 ZIP 条目集合。</p></article>`
  }
  async function loadTimeline() {
    if (!currentNode()) { panel('timeline').textContent = '本轮没有可查看的运行时间线。'; return }
    if (timelines.has(selectedRun)) { renderTimeline(timelines.get(selectedRun)); return }
    panel('timeline').textContent = '正在加载时间线…'
    const request = begin('timeline'), run = selectedRun
    try {
      const data = checkedResponse(await api.getTimeline(run, { signal: request.signal }))
      if (!request.valid()) return
      assertOwnership(data, null, null)
      timelines.set(run, data)
      renderTimeline(data)
      say('时间线已加载')
    } catch (error) {
      if (!request.valid()) return
      panel('timeline').textContent = errorText(error)
      say('时间线加载失败，原因已保留')
    }
  }
  function renderLogShell(state) {
    panel('logs').innerHTML = `<h3>运行日志</h3><p class="ct-dialog-notice" data-log-package></p>
      <p class="ct-dialog-notice" data-log-error></p><div class="ct-dialog-loglayout"><aside>
      <label class="ct-dialog-searchlabel">搜索文件<input type="search" data-control="file-search" aria-label="搜索文件" placeholder="仅搜索已返回清单"></label>
      <div class="ct-dialog-files" aria-label="日志文件"></div></aside><div>
      <div class="ct-dialog-toolbar"><label class="ct-dialog-searchlabel">正文搜索<input type="search" data-control="text-search" aria-label="正文搜索（仅已加载范围）" placeholder="仅搜索已加载正文"></label>
      <label><input type="checkbox" data-control="wrap">自动换行</label><button type="button" data-action="copy-log" disabled>复制已加载文本</button></div>
      <p class="ct-dialog-notice" data-search-result></p><div data-log-content></div></div></div>`
    find('[data-control="file-search"]').value = state.filter
    find('[data-control="text-search"]').value = state.search
    find('[data-control="wrap"]').checked = state.wrap
    renderFiles(state)
    renderPackage(state)
  }
  function renderFiles(state) {
    const filtered = list(state.files).filter((file) => String(file.path).toLocaleLowerCase().includes(state.filter.toLocaleLowerCase()))
    find('.ct-dialog-files').innerHTML = filtered.map((file) => `<button type="button" data-action="file" data-path="${esc(file.path)}" aria-pressed="${file.path === state.path}">${esc(file.path)}${file.size == null ? '' : ` · ${esc(file.size)} 字节`}</button>`).join('') || `<p class="ct-dialog-notice">${state.files == null ? '等待文件清单' : state.files.length ? '没有匹配的文件' : '文件清单为空'}</p>`
  }
  function renderPackage(state) {
    find('[data-log-package]').textContent = state.files == null ? '正在读取文件清单…' : `${state.legacy ? '最新包（旧接口未提供 artifactId，无法锁定；内容可能变化，不代表历史尝试）' : `已锁定日志包：${state.artifactId}`} · 包归属：${state.attempt == null ? '尝试未记录' : `尝试 ${state.attempt}`}。${state.truncated ? '日志包已截断，仅包含服务端保留文件。' : ''}非实时流，不保证完整历史。`
  }
  function preferredArtifact(state) {
    if (state.forcedArtifact) return state.forcedArtifact
    const node = currentNode()
    const attempt = list(node?.attempts).find((item) => attemptKey(item.attempt) === selectedAttempt)
    const owned = attempt?.artifact?.artifactId || attempt?.artifactId
    if (selectedAttempt != null && owned) return owned
    const artifact = node?.artifact
    return selectedAttempt == null || attemptKey(artifact?.attempt) === selectedAttempt ? artifact?.artifactId || null : null
  }
  function assertOwnership(data, artifactId, expectedAttempt) {
    if (data.runId != null && String(data.runId) !== selectedRun) throw new Error('证据不可用：返回的运行与所选运行不匹配。')
    if (artifactId != null && String(data.artifactId ?? '') !== String(artifactId)) throw new Error('证据不可用：接口未返回所锁定的日志包，已阻止跨包读取。')
    if (expectedAttempt != null && attemptKey(data.attempt) !== expectedAttempt) throw new Error(`尝试 ${expectedAttempt} 的日志不可用：返回包的尝试归属不匹配或未记录，不能用最新包替代。`)
  }
  async function ensureFiles(state) {
    if (state.files != null) return true
    if (state.promise) return state.promise
    const request = begin('list'), run = selectedRun, desiredAttempt = selectedAttempt, artifactId = preferredArtifact(state)
    const promise = (async () => {
      try {
        const data = checkedResponse(await api.getLogs(run, { ...(artifactId == null ? {} : { artifactId }), signal: request.signal }))
        if (!request.valid()) return false
        assertOwnership(data, artifactId, desiredAttempt)
        if (desiredAttempt != null && !data.artifactId) throw new Error(`尝试 ${desiredAttempt} 的日志不可用：旧接口只支持最新包，无法锁定历史尝试。请切换运行级查看最新包。`)
        if (!Array.isArray(data.files)) throw new Error('文件清单格式不可用，未读取任何文件。')
        state.files = data.files.filter((file) => file && typeof file.path === 'string')
        state.artifactId = data.artifactId || null
        state.attempt = attemptKey(data.attempt)
        state.legacy = !state.artifactId
        state.truncated = !!data.truncated
        return true
      } catch (error) {
        if (request.valid()) { find('[data-log-package]').textContent = '日志不可用'; find('[data-log-error]').textContent = errorText(error); say('日志加载失败，原因已保留') }
        return false
      }
    })().finally(() => { if (state.promise === promise) state.promise = null })
    state.promise = promise
    return promise
  }
  function renderText(state) {
    const root = find('[data-log-content]')
    const previous = root.querySelector('.ct-dialog-logtext')
    const position = previous ? [previous.scrollTop, previous.scrollLeft] : state.scroll.get(state.displayedPath) || [0, 0]
    root.replaceChildren()
    const notice = document.createElement('p')
    notice.className = 'ct-dialog-notice'
    notice.textContent = `${state.displayedPath} · ${state.textTruncated ? '正文已截断，仅显示服务端返回的部分。' : '仅显示本次加载的文本。'}搜索和复制仅覆盖已加载范围。`
    const pre = document.createElement('pre')
    pre.className = 'ct-dialog-logtext'
    pre.tabIndex = 0
    pre.setAttribute('aria-label', '已加载日志正文')
    pre.dataset.wrap = String(state.wrap)
    const text = state.text || '', query = state.search.toLocaleLowerCase(), haystack = text.toLocaleLowerCase()
    let cursor = 0, count = 0
    // 原始日志只写文本节点；搜索命中使用 mark，不将日志插入 innerHTML。
    if (query) {
      let index
      while ((index = haystack.indexOf(query, cursor)) !== -1) {
        count += 1
        if (count <= 1000) {
          pre.append(document.createTextNode(text.slice(cursor, index)))
          const mark = document.createElement('mark')
          mark.textContent = text.slice(index, index + query.length)
          pre.append(mark)
        }
        cursor = index + query.length
        if (count === 1000) { pre.append(document.createTextNode(text.slice(cursor))); break }
      }
    }
    if (count < 1000) pre.append(document.createTextNode(text.slice(cursor)))
    find('[data-search-result]').textContent = query ? `已加载范围内${count === 1000 ? '至少 ' : ''}${count} 处匹配${count === 1000 ? '（最多标记 1000 处）' : ''}` : '正文搜索仅覆盖已加载范围。'
    root.append(notice, pre)
    pre.scrollTop = position[0]
    pre.scrollLeft = position[1]
    find('[data-action="copy-log"]').disabled = false
  }
  function logUrl(path, state) {
    const url = new URL(api.logUrl(selectedRun, path, state.artifactId ? { artifactId: state.artifactId } : {}), document.baseURI)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('不安全的日志地址，已阻止打开。')
    return url.href
  }
  async function selectFile(path) {
    const state = logState()
    logIntent += 1
    const request = begin('file')
    const file = list(state.files).find((item) => item.path === path)
    if (!file) { find('[data-log-error]').textContent = `所锁定日志包中没有文件：${path}。未回退到其他包或文件。`; return }
    saveReading()
    state.path = path
    renderFiles(state)
    find('[data-log-error]').textContent = ''
    const kind = fileKind(file)
    try {
      if (kind !== 'text') {
        const url = logUrl(path, state)
        state.text = null
        state.displayedPath = path
        const content = find('[data-log-content]')
        content.replaceChildren()
        find('[data-action="copy-log"]').disabled = true
        find('[data-search-result]').textContent = '媒体与二进制文件不进行正文搜索。'
        if (kind === 'video' || kind === 'image') {
          const media = document.createElement(kind === 'video' ? 'video' : 'img')
          if (kind === 'video') { media.controls = true; media.preload = 'none'; media.setAttribute('aria-label', `日志视频：${path}`) } else { media.alt = `日志图片：${path}` }
          media.src = url
          content.append(media)
        } else {
          const note = document.createElement('p')
          note.textContent = '二进制文件不作为文本显示，请下载后使用对应工具查看。'
          content.append(note)
        }
        const link = document.createElement('a')
        link.className = 'ct-dialog-download'
        link.href = url
        link.download = path.split('/').pop()
        link.textContent = '下载文件'
        content.append(link)
        say('文件已选择')
        return
      }
      say(`正在加载：${path}`)
      const data = checkedResponse(await api.getLog(selectedRun, path, { ...(state.artifactId ? { artifactId: state.artifactId } : {}), signal: request.signal }))
      if (!request.valid()) return
      assertOwnership(data, state.artifactId, state.artifactId ? state.attempt : null)
      if (data.path != null && data.path !== path) throw new Error('日志路径不匹配，已阻止展示错误文件。')
      if (state.attempt != null && data.attempt != null && state.attempt !== attemptKey(data.attempt)) throw new Error('最新包已变化，尝试归属不一致；未展示新包文本。')
      if (typeof data.text !== 'string') throw new Error('响应不是可查看的文本，未渲染二进制内容。')
      if (/\u0000/.test(data.text)) throw new Error('检测到二进制内容，未作为文本展示。请下载文件查看。')
      state.text = data.text
      state.displayedPath = path
      state.textTruncated = !!data.truncated
      // 切换文件时恢复该文件的阅读位置，不沿用上个文件的滚动量。
      find('[data-log-content]').replaceChildren()
      renderText(state)
      say('日志文本已加载')
    } catch (error) {
      if (!request.valid()) return
      find('[data-log-error]').textContent = `${errorText(error)}${state.displayedPath ? ` 仍保留先前已加载的文件：${state.displayedPath}。` : ''}`
      say('文件加载失败，原因已保留')
    }
  }
  async function loadLogs(path = null) {
    if (!currentNode()) { panel('logs').textContent = '本轮没有可查看的运行日志。'; return }
    const state = logState(), ticket = ++logIntent, gen = generation
    if (!find('[data-log-content]')) renderLogShell(state)
    const ready = await ensureFiles(state)
    if (!ready || !opened || generation !== gen || ticket !== logIntent) return
    renderFiles(state)
    renderPackage(state)
    if (path != null || state.displayedPath == null) {
      const wanted = path ?? (state.files.some((file) => file.path === state.path) ? state.path : state.files[0]?.path)
      if (wanted != null) await selectFile(wanted)
    } else if (state.text != null) renderText(state)
    else await selectFile(state.displayedPath)
  }
  async function setTab(tab) {
    if (!Object.hasOwn(TABS, tab)) tab = 'report'
    saveReading()
    activeTab = tab
    for (const name of Object.keys(TABS)) {
      const button = find(`[data-tab="${name}"]`)
      button.setAttribute('aria-selected', String(name === tab))
      button.tabIndex = name === tab ? 0 : -1
      panel(name).hidden = name !== tab
    }
    find('.ct-dialog-body').scrollTop = tabScroll.get(`${contextKey()}:${tab}`) || 0
    if (tab === 'checks') renderChecks()
    if (tab === 'timeline') await loadTimeline()
    if (tab === 'diagnostics') await loadDiagnostics()
    if (tab === 'compare') await loadComparison()
    if (tab === 'pack') renderEvidencePack()
    if (tab === 'logs') await loadLogs()
  }
  function changeSelection(run, attempt) {
    saveReading()
    activeRequests()
    selectedRun = run
    selectedAttempt = attemptKey(attempt)
    for (const state of logStates.values()) state.promise = null
    panel('logs').replaceChildren()
    panel('timeline').replaceChildren()
    renderHeader()
    renderChecks()
    say('已切换所选运行证据，正式轮保持不变')
  }
  async function copyText(text, message) {
    const gen = generation
    try {
      if (!navigator.clipboard?.writeText) throw new Error('浏览器不支持剪贴板，请手动选择文本复制。')
      await navigator.clipboard.writeText(String(text))
      if (opened && generation === gen) say(message)
    } catch (error) { if (opened && generation === gen) say(`复制失败：${error.message}`) }
  }
  async function handleClick(event) {
    const button = event.target.closest('button')
    if (!button || !dialog.contains(button) || !opened) return
    if (button.dataset.tab) { await setTab(button.dataset.tab); return }
    const action = button.dataset.action
    if (action === 'close') close()
    if (action === 'diagnostic-feedback') { await submitDiagnosticFeedback(button); return }
    if (action === 'copy-submission') await copyText(round.submissionId, '提交标识已复制')
    if (action === 'copy-log' && logState().text != null) await copyText(logState().text, '已复制当前加载范围的日志文本')
    if (action === 'file') await selectFile(button.dataset.path)
    if (action === 'node-checks') { changeSelection(button.dataset.run, null); await setTab('checks') }
    if (action === 'timeline-log') {
      const path = button.dataset.path, owner = attemptKey(button.dataset.attempt), artifactId = button.dataset.artifact || null
      // 明确等待同包文件清单，再定位文件；不依靠固定延迟猜测请求何时完成。
      if (owner !== selectedAttempt) changeSelection(selectedRun, owner)
      const state = logState()
      if (artifactId && artifactId !== state.artifactId) {
        activeRequests()
        state.files = null; state.promise = null; state.displayedPath = null; state.text = null; state.forcedArtifact = artifactId
        panel('logs').replaceChildren()
      }
      await setTabForLogLink(path)
    }
  }
  async function setTabForLogLink(path) {
    saveReading()
    activeTab = 'logs'
    for (const name of Object.keys(TABS)) {
      const button = find(`[data-tab="${name}"]`)
      button.setAttribute('aria-selected', String(name === 'logs'))
      button.tabIndex = name === 'logs' ? 0 : -1
      panel(name).hidden = name !== 'logs'
    }
    find('.ct-dialog-body').scrollTop = 0
    await loadLogs(path)
  }
  on(dialog, 'click', (event) => { void handleClick(event) })
  on(dialog, 'submit', (event) => {
    if (event.target.matches('form[data-experience-form]')) void submitExperienceFeedback(event)
  })
  on(dialog, 'change', (event) => {
    const control = event.target.dataset.control
    if (control === 'compare-run') {
      comparisonTargets.set(selectedRun, event.target.value)
      comparisons.delete(`${selectedRun}\0${event.target.value}`)
      void loadComparison()
    }
    if (control === 'run' || control === 'attempt') {
      changeSelection(control === 'run' ? event.target.value : selectedRun, control === 'run' ? null : event.target.value)
      void setTab(activeTab)
    }
    if (control === 'wrap') { const state = logState(); state.wrap = event.target.checked; if (state.text != null) renderText(state) }
  })
  on(dialog, 'input', (event) => {
    const state = logState()
    if (event.target.dataset.control === 'file-search') { state.filter = event.target.value; renderFiles(state) }
    if (event.target.dataset.control === 'text-search') { state.search = event.target.value; if (state.text != null) renderText(state) }
  })
  on(dialog, 'error', (event) => {
    if (!opened || !dialog.contains(event.target) || !['IMG', 'VIDEO'].includes(event.target.tagName)) return
    const notice = find('[data-log-error]')
    if (notice) notice.textContent = '媒体加载失败；浏览器未提供具体业务原因。请通过下载链接查看服务端响应，不将其判断为执行失败。'
    say('媒体未能加载，已保留文件引用')
  }, true)
  on(dialog, 'scroll', (event) => {
    if (event.target.classList?.contains('ct-dialog-logtext')) {
      const state = logState()
      if (state.displayedPath) state.scroll.set(state.displayedPath, [event.target.scrollTop, event.target.scrollLeft])
    }
  }, true)
  on(dialog, 'keydown', (event) => {
    const tab = event.target.closest('[role="tab"]')
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const names = Object.keys(TABS), index = names.indexOf(tab.dataset.tab)
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length
      find(`[data-tab="${names[next]}"]`).focus()
      void setTab(names[next])
    }
    if (fallback && event.key === 'Tab') {
      const targets = [...dialog.querySelectorAll('button,select,input,a[href],summary,[tabindex="0"]')].filter((element) => !element.disabled && element.tabIndex >= 0 && !element.closest('[hidden]'))
      const first = targets[0], last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  })
  on(document, 'keydown', (event) => {
    if (opened && fallback && event.key === 'Escape') { event.preventDefault(); close() }
  })
  on(dialog, 'cancel', (event) => { event.preventDefault(); close() })
  on(dialog, 'close', () => { if (opened && !dialog.open) close() })

  function restoreFocus() {
    for (const [element, wasInert] of background) {
      if (!wasInert) { element.inert = false; element.removeAttribute('inert') }
    }
    background = []
    const entry = '[data-cloud-testing-entry], [data-gate-node], .ct-panel button[aria-expanded], .ct-root button[aria-expanded]'
    const target = triggerElement?.isConnected ? triggerElement : (focusScope?.isConnected ? focusScope.querySelector(entry) : null) || document.querySelector(entry)
    if (target && !target.closest('[inert]')) target.focus()
  }
  function close() {
    if (!opened) return
    saveReading()
    opened = false
    activeRequests()
    for (const media of dialog.querySelectorAll('video')) { try { media.pause() } catch { /* 测试环境可能未实现媒体暂停。 */ } }
    if (typeof dialog.close === 'function') { try { dialog.close() } catch { /* 降级环境通过 open 属性关闭。 */ } }
    dialog.removeAttribute('open')
    restoreFocus()
  }
  async function open(options) {
    if (disposed) throw new Error('证据窗口已经释放，不能重新打开。')
    if (!options?.round) throw new Error('打开证据窗口必须传入所选正式轮快照。')
    if (opened) close()
    // JSON 投影只包含事实数据，深拷贝防止外层轮询原地更新导致历史正文换轮。
    round = JSON.parse(JSON.stringify(options.round))
    observedAt = options.observedAt ?? null
    const direct = [...list(round.runs).map((node) => ({ ...node, kind: node.kind || 'run' })), ...list(round.mutations).map((node) => ({ ...node, kind: 'mutation' }))]
    nodes = direct.length ? direct : list(round.steps).flatMap((step) => list(step.nodes).map((node) => ({ ...node, kind: step.kind === 'mutation' ? 'mutation' : node.kind || 'run' })))
    selectedRun = options.runId == null ? String(nodes.find((node) => node.runId != null)?.runId ?? '') || null : String(options.runId)
    selectedAttempt = attemptKey(options.attempt)
    if (selectedRun && !currentNode()) throw new Error('所选运行不属于传入的正式轮，已拒绝打开。')
    triggerElement = options.trigger || document.activeElement
    focusScope = triggerElement?.closest?.('.ct-panel, .ct-root, .gate-card, .task-detail') || null
    logStates = new Map(); timelines = new Map(); diagnostics = new Map(); comparisons = new Map(); comparisonTargets = new Map(); diagnosticBusy = new Set(); diagnosticMessages = new Map(); experienceSubmitting = false; tabScroll = new Map()
    for (const name of Object.keys(TABS)) panel(name).replaceChildren()
    renderHeader()
    renderReport()
    say('已固定所选正式轮快照')
    opened = true
    activeRequests()
    fallback = false
    if (typeof dialog.showModal === 'function') { try { dialog.showModal() } catch { fallback = true } } else fallback = true
    if (!dialog.open) { fallback = true; dialog.setAttribute('open', '') }
    dialog.classList.toggle('ct-dialog-fallback', fallback)
    // 浏览器原生 top-layer 已提供模态隔离；显式保留原有 inert 状态供降级环境使用。
    background = [...document.body.children].filter((element) => element !== dialog && element.tagName !== 'SCRIPT' && element.tagName !== 'STYLE').map((element) => [element, element.inert || element.hasAttribute('inert')])
    for (const [element] of background) { element.inert = true; element.setAttribute('inert', '') }
    find('[data-action="close"]').focus()
    await setTab(options.tab || 'report')
  }
  function dispose() {
    if (disposed) return
    close()
    disposed = true
    activeRequests()
    for (const remove of listeners) remove()
    dialog.remove()
    style.remove()
    logStates.clear(); timelines.clear(); diagnostics.clear(); comparisons.clear(); comparisonTargets.clear(); diagnosticBusy.clear(); diagnosticMessages.clear(); preferences.clear(); tabScroll.clear()
    triggerElement = null; focusScope = null; round = null; nodes = []
  }
  return { open, close, dispose }
}
