import { escapeHtml as h, formatDateTime, formatDuration, statusMeta, modeLabel, sideLabel, runLabel, attemptLabel,
  durationOf, firstError, canRequeue, executionStats, mutationStats, executionText, isRunning, list, text } from './model.js'

let panelSequence = 0
const value = (v) => h(v == null || v === '' ? '未记录' : v)
const date = (v) => h(formatDateTime(v))
const attr = (name, v) => ` ${name}="${h(v)}"`
const disabled = (v) => v ? ' disabled' : ''
const number = (v) => v == null ? '未记录' : h(v)
const badge = (state, dimension = 'execution', label = null) => {
  const meta = statusMeta(state, dimension)
  return `<span class="ct-badge ct-tone-${meta.tone}${isRunning(state) ? ' ct-is-running' : ''}"><span aria-hidden="true">${meta.icon}</span>${h(label || meta.label)}</span>`
}
const button = (action, label, attributes = '', classes = '') => `<button type="button" class="ct-button ${classes}" data-action="${action}"${attributes}>${label}</button>`
const roundName = (round) => round.roundNo == null ? '正式轮（编号未记录）' : `正式轮 #${round.roundNo}`
const field = (label, v, copy = false) => `<div class="ct-field"><dt>${h(label)}</dt><dd>${value(v)}${copy && v != null ? button('copy', '复制', attr('data-copy', v) + attr('aria-label', `复制${label}`), 'ct-copy') : ''}</dd></div>`
const sourceValue = (item) => item?.value == null ? '未记录' : `${text(item.value)}（${({ receipt: '提交回执', principal: '身份记录', inferred: '推断', recorded: '已记录' })[item.source] || '来源未记录'}）`

function headerHtml(state) {
  return `<header class="ct-header" data-ct-key="header"><div><h3>云端测试</h3><p class="ct-muted">当前任务与历史执行，各自保留事实</p></div>
    <div class="ct-tools">${button('refresh', state.loading ? '刷新中…' : '刷新', disabled(state.loading))}
      ${button('pause', state.paused ? '恢复自动刷新' : '暂停自动刷新', attr('aria-pressed', state.paused))}
      ${button('close', '收起', ' aria-expanded="true"')}</div></header>`
}
function summaryHtml(state) {
  const { execution, mutation, mode, assessment } = state.summary
  const totalMutation = ['killed', 'weak', 'exempt', 'active', 'inconclusive', 'unknown'].reduce((sum, key) => sum + (Number(mutation[key]) || 0), 0)
  const effective = modeLabel(mode.effective)
  const configured = modeLabel(mode.configured)
  const gateNote = mode.effective === 'observe'
    ? '云端风险告警，本层不强制拦截；其他守卫独立检查，不代表任务可以完成。'
    : ['enforce_all', 'enforce_ml', 'enforce_s'].includes(mode.effective)
      ? '拦截模式；以下只展示观测或已有记录，待实际门禁确认，不构成推进许可。'
      : mode.effective === 'disabled' || mode.effective === 'legacy'
        ? '当前云端层停用或兼容运行，不改写历史结果；其他守卫仍独立检查。'
        : '当前有效模式未知，不能用静态配置推断门禁影响。'
  const connection = state.paused ? '已暂停自动刷新' : !state.visible || state.pageHidden ? '已停止自动刷新' : state.error ? '连接异常，保留上次数据' : state.loading ? '正在刷新' : state.initialized ? '已更新' : '等待首次数据'
  const accept = state.currentAcceptance
  return `<section class="ct-current" data-ct-key="current" aria-label="当前任务摘要">
    <div class="ct-mode-line"><strong>当前有效：${h(effective)}</strong><span>配置：${h(configured)}</span>
      ${mode.effective && configured !== effective ? '<span class="ct-badge ct-tone-warning">配置与当前有效不同</span>' : ''}
      <span class="ct-muted">策略来源：${value(mode.source)}</span><span class="ct-total">正式轮总数 ${number(state.total)}</span></div>
    <div class="ct-axes">
      <section class="ct-axis" data-ct-key="execution-axis"><h4>正式执行</h4>${badge(execution.state, 'execution', execution.state === 'passed' ? '正式执行通过' : null)}
        <p class="ct-counts"><span>通过 <b>${number(execution.passed)}</b></span><span class="${execution.failed ? 'ct-danger-text' : ''}">失败 <b>${number(execution.failed)}</b></span><span>活动 <b>${number(execution.active)}</b></span></p>
        <p class="ct-muted">必需 ${number(execution.required)} · 已结束 ${number(execution.ended)}</p>
        ${list(execution.missing).length ? `<p class="ct-callout ct-tone-warning">缺少必需单元：${h(execution.missing.join('、'))}</p>` : ''}
        <p class="ct-muted">活动包含排队与执行，不表示串行进度。</p></section>
      <section class="ct-axis" data-ct-key="mutation-axis"><h4>变异验卷</h4>
        <div class="ct-mutation-counts">${[['killed', '杀中'], ['weak', '未杀中'], ['exempt', '豁免'], ['active', '活动'], ['inconclusive', '未考成'], ['unknown', '未知']].map(([key, label]) => `<span class="${key === 'weak' && mutation[key] ? 'ct-warning-text' : ''}">${label} <b>${number(mutation[key])}</b></span>`).join('')}</div>
        <p class="ct-muted">${mutation.unknown == null ? '未知范围未量化；' : ''}${totalMutation ? '仅统计有记录范围；豁免不等于真实杀中。' : '未记录当前轮变异；可能复用或豁免，但无记录不判通过。'}</p></section>
      <section class="ct-axis" data-ct-key="gate-axis"><h4>门禁影响</h4>${badge(assessment.kind, 'gateEffect')}
        <p>${h(gateNote)}</p>${list(assessment.reasons).length ? `<ul class="ct-reasons">${assessment.reasons.map((reason) => `<li>${h(typeof reason === 'string' ? reason : [reason.code, reason.detail || reason.message].filter(Boolean).join('：'))}</li>`).join('')}</ul>` : '<p class="ct-muted">没有阻塞记录也不等于验收通过。</p>'}
        <details data-ct-key="assessment-meta"><summary>观测来源与关联</summary><dl>${field('目标转换', assessment.targetTransition)}${field('观测时间', assessment.observedAt ? formatDateTime(assessment.observedAt) : null)}${field('证据引用', list(assessment.evidenceRefs).length ? text(assessment.evidenceRefs) : null)}${field('当前上下文', text(state.summary.context))}</dl></details></section>
    </div>
    <div class="ct-updated"><span role="status" aria-live="polite" data-ct-key="connection">${h(connection)}</span><span>数据截至 ${date(state.observedAt)}</span><span>最后成功 ${date(state.lastSuccessAt)}</span></div>
    <p class="ct-callout ct-tone-danger" data-ct-key="refresh-error"${state.error ? '' : ' hidden'}>刷新失败：${h(state.error)}。已保留正文与原截至时间，请手动刷新重试。</p>
    ${state.summary.version === 0 ? '<p class="ct-muted">旧接口兼容：优先使用历史投影，当前有效模式未知；不由旧节点或任务完成状态推断放行。</p>' : ''}
    <details class="ct-current-observation" data-ct-key="current-observation"><summary>当前 AC / 任务生命周期（不属于历史轮）</summary>
      <p>任务阶段：${value(state.task.phase || accept?.phase)}；生命周期完成不代表执行成功。</p>
      ${list(accept?.acceptance).map((ac) => `<p>${value(ac.id)} · ${value(ac.text)} · ${list(accept?.coverage?.covered).includes(ac.id) ? '已关联考卷，非执行通过' : list(accept?.coverage?.missing).includes(ac.id) ? '缺少关联考卷' : '关联未记录'}</p>`).join('') || '<p class="ct-muted">当前 AC 清单未记录或不适用。</p>'}
      <p class="ct-muted">本区只读观测，不向历史报告回填当前 AC 或 F2P 结论。</p>
    </details>
    <details class="ct-technical" data-ct-key="refresh-technical"><summary>更新机制</summary><p>可见且未暂停时，订阅信号与 5 秒兜底轮询合并；收起或页面隐藏停止，恢复立即刷新。同一提交内的尝试和自动验卷都不增加正式轮数。</p></details>
  </section>`
}
function navigationHtml(state, prefix) {
  const rounds = state.navigation
  const label = (round) => `${roundName(round)} · ${round.submissionId === state.latestId ? '最新' : '历史'} · ${statusMeta(executionStats(round).state).label}`
  return `<nav class="ct-navigation" data-ct-key="navigation" aria-label="正式轮导航"><h4>正式轮导航</h4>
    <div class="ct-round-select"><label for="${prefix}-round-select">选择正式轮</label><select id="${prefix}-round-select" data-action="select-round">${rounds.length ? rounds.map((round) => `<option value="${h(round.submissionId)}"${round.submissionId === state.selectedId ? ' selected' : ''}>${h(label(round))}</option>`).join('') : '<option value="">暂无正式轮</option>'}</select></div>
    <div class="ct-round-list">${rounds.map((round) => `<button type="button" class="ct-round-choice" data-action="round" data-round="${h(round.submissionId)}" data-ct-key="nav:${h(round.id)}"${round.submissionId === state.selectedId ? ' aria-current="true"' : ''}><strong>${h(roundName(round))}</strong><span>${round.submissionId === state.latestId ? '最新' : '历史'} · ${date(round.createdAt)}</span>${badge(executionStats(round).state)}</button>`).join('')}</div>
    <div class="ct-page-tools">${button('older', '较早一页', disabled(!state.page.hasMore || !state.page.nextCursor || state.pageLoading))}
      ${button('newer', '较新一页', disabled(!state.trail.length || state.pageLoading))}${button('latest', '返回最新', disabled(state.pageLoading))}</div>
    <p class="ct-muted">本页 ${state.navIds.length} 轮 / 总计 ${number(state.total)}</p><p class="ct-muted" role="status">${state.pageLoading ? '正在加载历史轮次…' : h(state.pageError || '')}</p>
    <p class="ct-muted">正式轮按提交计数，跨 epoch 保留历史。</p></nav>`
}
function evidenceButton(run, tab, label, attempt = null) {
  return button('evidence', label, attr('data-run', run.runId) + attr('data-tab', tab) + (attempt != null ? attr('data-attempt', attempt) : '') + disabled(!run.runId))
}
function attemptHtml(run, attempt) {
  return `<details class="ct-attempt" data-ct-key="${h(attempt.id)}"><summary><strong>尝试 ${value(attempt.attempt)}</strong>${badge(attempt.status)}<span>${h(formatDuration(durationOf(attempt)))}</span></summary>
    <dl>${field('开始', attempt.startedAt ? formatDateTime(attempt.startedAt) : null)}${field('结束', attempt.finishedAt ? formatDateTime(attempt.finishedAt) : null)}${field('心跳', attempt.heartbeatAt ? formatDateTime(attempt.heartbeatAt) : null)}${field('worker', attempt.worker)}${field('镜像', attempt.imageId)}</dl>
    <pre class="ct-evidence-text" tabindex="0" data-ct-key="${h(attempt.id)}:error">${h([attempt.errorCode, attempt.errorDetail].filter(Boolean).join('\n') || '本次尝试未记录错误详情')}</pre>
    <p class="ct-muted">${run.reportAttempt == null ? '仅有 run 级报告，尝试归属未记录。' : String(run.reportAttempt) === String(attempt.attempt) ? '当前检查项报告归属于本次尝试。' : `当前检查项报告属于尝试 ${run.reportAttempt}，不会作为本次尝试的报告。`}</p>
    <div class="ct-tools">${evidenceButton(run, 'checks', '尝试证据', attempt.attempt)}${evidenceButton(run, 'logs', '尝试日志', attempt.attempt)}${evidenceButton(run, 'timeline', '尝试时间线', attempt.attempt)}</div>
  </details>`
}
function requeueHtml(run, operation) {
  if (!canRequeue(run) && !operation) return ''
  const op = operation || {}
  return `<div class="ct-requeue" data-ct-key="${h(run.id)}:requeue">
    ${canRequeue(run) ? button('requeue', '重新入队', attr('data-run', run.runId) + disabled(Boolean(op.busy)), 'ct-requeue-trigger') : ''}
    ${op.confirm || op.busy ? `<div class="ct-confirm" data-ct-key="${h(run.id)}:confirm"><p>仅重试同一个 run，不新增正式轮；服务端会校验权限和当前状态，并重置该运行的重试预算。</p>
      <div class="ct-tools">${button('confirm-requeue', op.busy ? '正在提交…' : '确认重试', attr('data-run', run.runId) + disabled(op.busy))}${button('cancel-requeue', '取消', attr('data-run', run.runId) + disabled(op.busy))}</div></div>` : ''}
    <p role="status" class="${op.error ? 'ct-danger-text' : 'ct-muted'}">${h(op.error || op.message || '')}</p></div>`
}
function runHtml(run, operations) {
  const mutation = run.kind === 'mutation'
  const error = firstError(run)
  const state = !mutation && run.reason === 'infra_error' && run.status === 'error' ? 'infra_error'
    : !mutation && run.reason === 'assertion_failed' ? 'assertion_failed' : run.state
  return `<article class="ct-run" data-ct-key="${h(run.id)}" data-run-id="${h(run.runId)}">
    <header class="ct-run-head"><h4>${h(runLabel(run))}</h4><span class="ct-side">${h(sideLabel(run.side))}</span>${badge(state, mutation ? 'mutation' : 'execution')}</header>
    <div class="ct-run-facts"><span>${h(attemptLabel(run))}</span><span>${h(formatDuration(durationOf(run)))}</span>${mutation ? `<span>原始执行：${h(statusMeta(run.status).label)}</span>` : ''}</div>
    ${error ? `<p class="ct-first-error ${state === 'weak' ? 'ct-warning-text' : ''}" title="${h(error)}">${h(error)}</p><details data-ct-key="${h(run.id)}:error"><summary>异常 / 判卷证据详情</summary><pre class="ct-evidence-text" tabindex="0" data-ct-key="${h(run.id)}:error-text">${h(error)}</pre></details>` : ''}
    ${mutation ? `<p class="ct-muted">${run.sourceRunId ? '已记录精确来源，详见执行元信息' : '同提交关联；未记录精确来源 run，不推断父子关系。'} · 考卷版本 ${value(run.specVersion)}</p>` : ''}
    <div class="ct-tools ct-run-tools">${evidenceButton(run, 'checks', '查看证据')}${evidenceButton(run, 'report', '报告')}${evidenceButton(run, 'logs', '日志')}${evidenceButton(run, 'timeline', '时间线')}</div>
    ${requeueHtml(run, operations[run.runId])}
    <details class="ct-attempts" data-ct-key="${h(run.id)}:attempts"><summary>尝试记录 · ${h(attemptLabel(run))}</summary>
      ${run.attempts.map((attempt) => attemptHtml(run, attempt)).join('') || '<p class="ct-muted">尚未开始或历史尝试未记录；不假定已有一次尝试。</p>'}</details>
    <details class="ct-metadata" data-ct-key="${h(run.id)}:metadata"><summary>执行元信息</summary><dl>
      ${field('运行 ID', run.runId, true)}${mutation ? field('来源运行 ID', run.sourceRunId, true) : ''}${field('单元键', `${run.unit || '?'}:${run.side || '?'}`)}${field('执行状态', run.status)}${field('终结原因', run.reason)}
      ${field('入队', run.createdAt ? formatDateTime(run.createdAt) : null)}${field('开始', run.startedAt ? formatDateTime(run.startedAt) : null)}${field('结束', run.finishedAt ? formatDateTime(run.finishedAt) : null)}
      ${field('报告归属', run.reportAttempt == null ? 'run 级报告，尝试归属未记录' : `尝试 ${run.reportAttempt}`)}${field('证据包', run.artifact ? text(run.artifact) : null)}
      </dl></details>
  </article>`
}
function inputsHtml(round) {
  const prepare = round.steps.find((step) => step.kind === 'prepare')
  const connector = round.connector || {}
  const diff = connector.specs || {}
  const tree = connector.businessTree?.value
  return `<section class="ct-inputs" data-ct-key="${h(round.id)}:inputs-content"><h4>冻结输入与轮次差异</h4>
    <p>预检：${badge(prepare?.preflight?.state || 'unknown')} ${h(prepare?.preflight?.detail || '未记录预检，不能由已提交推断通过。')}</p>
    <p>业务快照：${tree === 'changed' ? '发生改变（快照对比推断）' : tree === 'unchanged' ? '未改变（快照对比推断）' : '变化未记录'}</p>
    <p>提交人：${h(sourceValue(round.actor))} · 触发原因：${h(sourceValue(round.trigger))}</p>
    <p class="ct-muted">与上一正式轮的冻结清单比较；不使用当前仓库考卷或当前 AC 回填历史。</p>
    <div class="ct-diff-grid">${[['added', '新增'], ['updated', '更新'], ['removed', '移除']].map(([key, label]) => `<section><h4>${label} ${diff.source === 'inferred' ? list(diff[key]).length : '未知'}</h4>${diff.source === 'inferred' ? list(diff[key]).map((spec) => `<p>${value(spec.featureKey)} · ${h(sideLabel(spec.side))} · ${spec.previousVersion != null ? `v${h(spec.previousVersion)} → ` : ''}v${value(spec.version)}</p>`).join('') || '<p class="ct-muted">无</p>' : '<p class="ct-muted">比较依据未记录</p>'}</section>`).join('')}</div>
    <details data-ct-key="${h(round.id)}:frozen-specs"><summary>本轮冻结考卷 · ${Array.isArray(prepare?.specs) ? prepare.specs.length : '清单未记录'}</summary>
      ${list(prepare?.specs).map((spec) => `<div class="ct-spec"><strong>${value(spec.featureKey)}</strong><p>v${value(spec.version)} · ${value(spec.specType)} · ${h(sideLabel(spec.side))}</p><dl>${field('考卷 hash', spec.blobSha256, true)}</dl></div>`).join('') || '<p class="ct-muted">没有可用的冻结考卷清单。</p>'}</details>
    <details data-ct-key="${h(round.id)}:input-metadata"><summary>冻结输入元信息</summary><dl>${field('快照 ID', prepare?.snapshot?.id, true)}${field('当前 tree', prepare?.snapshot?.tree || connector.tree, true)}${field('前次 tree', connector.previousTree, true)}${field('commit', prepare?.snapshot?.commit, true)}${field('上一提交', connector.previousSubmissionId, true)}${field('审计回执', round.receiptAuditId, true)}</dl></details>
    <p class="ct-muted">考卷“移除”仅指冻结清单差异，不代表仓库删除；身份和输入变化不等于已记录触发意图。</p>
  </section>`
}
function roundHtml(state, prefix, operations) {
  const round = state.selectedRound
  if (!round) return `<section class="ct-empty" data-ct-key="empty"><h4>${state.loading ? '正在读取正式轮' : '尚无可用的正式提交记录'}</h4><p>无记录不等于通过或跳过；准备、执行与验卷状态均需证据。</p></section>`
  const execution = executionStats(round)
  const mutation = mutationStats(round)
  const history = round.historical || round.submissionId !== state.latestId
  const tabs = [['execution', '执行单元'], ['mutation', '变异验卷'], ['inputs', '冻结输入与轮次差异']]
  return `<section class="ct-round-detail" data-ct-key="${h(round.id)}" data-submission-id="${h(round.submissionId)}">
    <header class="ct-round-header"><div><h3>${h(roundName(round))}</h3><p class="ct-muted">${history ? '正在查看历史轮，保留原结果' : '当前最新正式轮'} · ${date(round.createdAt)}</p></div>
      ${button('round-report', isRunning(execution.state) || execution.active ? '本轮阶段报告' : '本轮报告')}</header>
    <p class="ct-round-summary">${h(executionText(execution))} · 已结束 ${execution.ended} / 必需 ${number(execution.required)}</p>
    <p class="ct-muted">正式执行与自动验卷可能并行；本轮通过不等于任务验收完成。</p>
    ${round.staleReason ? `<p class="ct-callout ct-tone-warning">历史绑定：${h(round.staleReason)}；不改写本轮结果。</p>` : ''}
    <details class="ct-round-metadata" data-ct-key="${h(round.id)}:metadata"><summary>正式轮元信息</summary><dl>${field('提交 ID', round.submissionId, true)}${field('绑定 ID', round.bindingId, true)}${field('epoch', round.epoch)}${field('任务版本', round.expectedTaskRevision)}${field('提交原始状态', round.status)}${field('本轮证据截至', round.observedAt ? formatDateTime(round.observedAt) : null)}</dl></details>
    <div class="ct-tabs" role="tablist" aria-label="正式轮详情">${tabs.map(([tab, label]) => button('tab', label, ` role="tab" id="${prefix}-tab-${tab}" aria-controls="${prefix}-panel-${tab}" aria-selected="${state.tab === tab}" tabindex="${state.tab === tab ? '0' : '-1'}" data-tab="${tab}"`, 'ct-tab')).join('')}</div>
    <section class="ct-tab-panel" role="tabpanel" id="${prefix}-panel-execution" aria-labelledby="${prefix}-tab-execution"${state.tab === 'execution' ? '' : ' hidden'}>
      ${execution.missing.length ? `<p class="ct-callout ct-tone-warning">缺少必需单元：${h(execution.missing.join('、'))}</p>` : ''}${round.runs.map((run) => runHtml(run, operations)).join('') || '<p class="ct-empty">本轮未记录正式执行单元，不能判定通过。</p>'}</section>
    <section class="ct-tab-panel" role="tabpanel" id="${prefix}-panel-mutation" aria-labelledby="${prefix}-tab-mutation"${state.tab === 'mutation' ? '' : ' hidden'}>
      <p class="ct-muted">杀中 ${mutation.killed} · 未杀中 ${mutation.weak} · 豁免 ${mutation.exempt} · 活动 ${mutation.active} · 未考成 ${mutation.inconclusive} · 未知 ${mutation.unknown}</p>
      ${round.mutations.map((run) => runHtml(run, operations)).join('') || '<p class="ct-empty">未记录本轮 mutation；可能复用或豁免，但无证据不判通过。</p>'}</section>
    <section class="ct-tab-panel" role="tabpanel" id="${prefix}-panel-inputs" aria-labelledby="${prefix}-tab-inputs"${state.tab === 'inputs' ? '' : ' hidden'}>${inputsHtml(round)}</section>
  </section>`
}

// 基于稳定键协调 DOM，而不是刷新 innerHTML。保留 details、滚动、焦点以及原生表单状态。
function keyOf(node) { return node.nodeType === 1 ? node.getAttribute('data-ct-key') || node.id || null : null }
function sameKind(a, b) { return a.nodeType === b.nodeType && a.nodeName === b.nodeName }
function patchElement(current, desired) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue
    return
  }
  for (const attribute of [...current.attributes]) {
    if (current.tagName === 'DETAILS' && attribute.name === 'open') continue
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name)
  }
  for (const attribute of [...desired.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value)
  }
  patchChildren(current, desired)
}
function patchChildren(parent, desired) {
  const old = [...parent.childNodes]
  const keyed = new Map(old.map((node) => [keyOf(node), node]).filter(([key]) => key))
  const used = new Set()
  let position = parent.firstChild
  for (const node of [...desired.childNodes]) {
    const key = keyOf(node)
    let current = key ? keyed.get(key) : old.find((candidate) => !used.has(candidate) && !keyOf(candidate) && sameKind(candidate, node))
    if (current && !sameKind(current, node)) current = null
    if (!current) current = node.cloneNode(true)
    else patchElement(current, node)
    used.add(current)
    if (current !== position) parent.insertBefore(current, position)
    position = current.nextSibling
  }
  for (const node of old) if (!used.has(node)) node.remove()
}
export function createCloudTestingView(root, { onAction }) {
  const doc = root.ownerDocument
  const prefix = `ct-${++panelSequence}`
  const regions = new Map()
  const signatures = new Map()
  for (const name of ['header', 'summary', 'notice', 'layout', 'feedback']) {
    const element = doc.createElement('div')
    element.className = `ct-region-${name}`
    if (name === 'feedback') { element.setAttribute('role', 'status'); element.classList.add('ct-sr-only') }
    root.append(element)
    regions.set(name, element)
  }
  const patch = (name, html) => {
    if (signatures.get(name) === html) return
    const template = doc.createElement('template')
    template.innerHTML = html
    patchChildren(regions.get(name), template.content)
    signatures.set(name, html)
  }
  const click = (event) => {
    const target = event.target.closest?.('button[data-action]')
    if (target && root.contains(target) && !target.disabled) onAction(target.dataset.action, target, event)
  }
  const change = (event) => {
    if (event.target.matches('select[data-action="select-round"]')) onAction('round', event.target, event)
  }
  const keydown = (event) => {
    const target = event.target.closest?.('[role="tab"]')
    if (!target || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tabs = [...target.parentElement.querySelectorAll('[role="tab"]')]
    const index = tabs.indexOf(target)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    onAction('tab', tabs[next], event)
    tabs[next].focus()
  }
  root.addEventListener('click', click)
  root.addEventListener('change', change)
  root.addEventListener('keydown', keydown)
  return {
    render(state, operations = {}) {
      patch('header', headerHtml(state))
      patch('summary', summaryHtml(state))
      patch('notice', `<div class="ct-new-round"${state.newRound ? '' : ' hidden'}><span role="status" aria-live="polite">${state.newRound ? '有新正式轮，当前选择保持不变。' : ''}</span>${button('latest', '查看最新轮')}</div>`)
      patch('layout', `<div class="ct-layout">${navigationHtml(state, prefix)}<section class="ct-detail" aria-label="所选正式轮">${roundHtml(state, prefix, operations)}</section></div>`)
      const select = root.querySelector('select[data-action="select-round"]')
      if (select) select.value = state.selectedId || ''
    },
    announce(message) { regions.get('feedback').textContent = message },
    dispose() {
      root.removeEventListener('click', click)
      root.removeEventListener('change', change)
      root.removeEventListener('keydown', keydown)
      for (const element of regions.values()) element.remove()
      regions.clear()
    },
  }
}
