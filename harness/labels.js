/**
 * labels.js — Harness 工作流中文标签（看板 / MCP 响应共用）
 */
import { phaseToActivity } from './activity-plan.js'

export const PHASE_LABELS = {
  RECEIVE: { name: '接收需求', summary: '记录并确认需求原文，明确要做什么' },
  CLASSIFY: { name: '任务分级', summary: '判定规模 S/M/L 和任务类型，决定走哪条流程' },
  LOCATE: { name: '定位上下文', summary: '检索规范文档与团队经验，弄清改动范围' },
  PLAN: { name: '制定计划', summary: '列出待办清单、技术决策，确认后再写代码' },
  EXECUTE: { name: '编码执行', summary: '修改代码，每文件改完跑 verify.sh L1' },
  VERIFY: { name: '功能验证', summary: '云端门禁为准；云端不可用时用本地 L2 兜底' },
  DISTILL: { name: '经验沉淀', summary: '把踩坑写入团队经验库，供后人检索' },
  DONE: { name: '任务完成', summary: '工作流结束，可提测或合码' },
  receive: { name: '接收需求', summary: '记录需求原文' },
  retrieve: { name: '定位上下文', summary: '检索规范与团队经验，弄清改动范围' },
  plan: { name: '制定计划', summary: '列出待办、技术决策和验收清单，确认后再写代码' },
  execute: { name: '编码', summary: '修改代码并上报 L1' },
  static: { name: '静态检查', summary: '产品变更时的静态门禁' },
  smoke: { name: '冒烟', summary: '只跑已确定的端' },
  distill: { name: '沉淀', summary: '可选，不阻断完成' },
  done: { name: '完成', summary: '工作流结束' },
  aborted: { name: '已中止', summary: '任务已停止' },
  ABORTED: { name: '已中止', summary: '任务已停止：编码/测试/云端 VM 均已终止，禁止复活；新需求请开新任务' },
}

export const SIZE_LABELS = {
  S: '小改动（单行修复/配置）',
  M: '中改动（单页面/单模块）',
  L: '大改动（跨模块/新功能）',
}

/** 工作流只画活动计划里的节点 */
export function buildWorkflowView(currentPhase, _size = null, verifyMode = null, activities = null) {
  const current = phaseToActivity(currentPhase)
  const nodes = activities?.length
    ? (activities.includes('done') ? [...activities] : [...activities, 'done'])
    : [current, 'done']
  const currentIdx = nodes.indexOf(current)
  const cloudOk = verifyMode?.source === 'cloud'
  return nodes.map((activity, idx) => {
    let label = PHASE_LABELS[activity] || { name: activity, summary: '' }
    if ((activity === 'static' || activity === 'smoke') && cloudOk) {
      label = { name: label.name, summary: '以云端门禁为准；未绿不能完成' }
    } else if ((activity === 'static' || activity === 'smoke') && verifyMode?.source === 'local') {
      label = { name: label.name, summary: '云端暂不可用，用本地 verify.sh L2 兜底' }
    }
    let status = 'pending'
    if (current === 'done' || current === 'aborted') status = 'done'
    else if (activity === current) status = 'current'
    else if (currentIdx >= 0 && idx < currentIdx) status = 'done'
    return { phase: activity, name: label.name, summary: label.summary, status }
  })
}

/**
 * 任务节点上的测试子节点（考卷 / 云端门禁），避免「测完又重测」无结构体感。
 * @param {object} opts
 * @param {string} opts.phase 当前 harness 阶段
 * @param {string|null} opts.size
 * @param {object|null} opts.gateLoop
 * @param {object|null} opts.acCoverage evaluateAcCoverage 结果
 * @param {string[]|null} opts.requiredUnits
 */
export function buildTestNodes({ phase, size = null, gateLoop = null, acCoverage = null, requiredUnits = null, changeKind = null } = {}) {
  if (!size || size === 'S') {
    return {
      enabled: size === 'S',
      note: size === 'S' ? 'S 级仅 static，无独立考卷节点' : null,
      nodes: size === 'S'
        ? [{ id: 'static', name: '静态检查', status: 'pending', summary: 'S 级门禁仅 static:na' }]
        : [],
    }
  }
  const acTotal = acCoverage?.applicable ? acCoverage.total : null
  const acMissing = acCoverage?.applicable ? (acCoverage.missing || []).length : null
  const specsStatus =
    acCoverage == null
      ? 'pending'
      : !acCoverage.applicable
        ? 'skipped'
        : acMissing === 0
          ? 'done'
          : acCoverage.covered?.length
            ? 'current'
            : 'pending'
  const specsSummary =
    acCoverage == null
      ? 'PLAN 冻结 AC 后提交考卷（awp_test_spec_submit）'
      : !acCoverage.applicable
        ? '本任务无 AC 清单，考卷非强制'
        : acMissing === 0
          ? `AC 全覆盖（${acTotal} 条）`
          : `AC ${acCoverage.covered?.length || 0}/${acTotal} 已覆盖，缺 ${acMissing}：${(acCoverage.missing || []).slice(0, 6).join('、')}`

  const terminal = gateLoop?.lastTerminal || null
  const units = requiredUnits || gateLoop?.requiredUnits || null
  let gateStatus = 'pending'
  const phaseAct = phaseToActivity(phase)
  if (phaseAct === 'done') gateStatus = 'done'
  else if (terminal === 'passed') gateStatus = 'done'
  else if (phaseAct === 'static' || phaseAct === 'smoke' || phaseAct === 'execute') {
    gateStatus = terminal === 'failed' || terminal === 'error' ? 'current' : 'current'
  }
  const kindLabel =
    changeKind === 'spec-only'
      ? '本轮为考卷刷新（产品树未变）→ 只跑 smoke，跳过 static'
      : '产品有变更 → static + smoke 全量'
  const gateSummary = units?.length
    ? `units=${units.join(', ')}；${kindLabel}${terminal ? `；最近终态=${terminal}` : ''}`
    : kindLabel

  const mvNodes = []
  if (acCoverage?.applicable && acCoverage.mutation && acCoverage.mutation.total > 0) {
    const mv = acCoverage.mutation
    const done = mv.verified >= mv.total && !acCoverage.mutationPending
    const inFlight = (mv.running || 0) + (mv.queued || 0)
    const mvStatus = done ? 'done' : (inFlight > 0 || (acCoverage.covered || []).length) ? 'current' : 'pending'
    const d = acCoverage.f2pDetail || {}
    const parts = [`变异验卷 ${mv.verified}/${mv.total}`]
    if (d.ok) parts.push(`杀${d.ok}`)
    if (d.warn) parts.push(`豁免${d.warn}`)
    if (d.bad) parts.push(`废卷${d.bad}`)
    if (mv.running) parts.push(`执行中${mv.running}`)
    if (mv.queued) parts.push(`排队${mv.queued}`)
    mvNodes.push({ id: 'mutation', name: '变异验卷', status: mvStatus, summary: parts.join(' · '), clickable: true })
  }
  return {
    enabled: true,
    changeKind,
    nodes: [
      { id: 'specs', name: '考卷准备', status: specsStatus, summary: specsSummary, clickable: false },
      { id: 'cloud_gate', name: '云端门禁', status: gateStatus, summary: gateSummary, clickable: true, units: units || [] },
      ...mvNodes,
    ],
  }
}

export const TOOL_LABELS = {
  harness_start: {
    action: '开启任务',
    describe: (args) => `创建新任务，进入「接收需求」阶段${args?.requirement ? `：${String(args.requirement).slice(0, 40)}` : ''}`,
  },
  harness_status: {
    action: '查看状态',
    describe: () => '查询当前工作流阶段、允许的操作和必读文档',
  },
  harness_advance: {
    action: '推进阶段',
    describe: (args) => {
      const to = args?.to
      const label = to ? PHASE_LABELS[to] : null
      const size = args?.data?.size
      if (label) {
        let s = `进入「${label.name}」— ${label.summary}`
        if (size) s += `（规模：${SIZE_LABELS[size] || size}）`
        return s
      }
      return '推进工作流到下一阶段'
    },
  },
  get_doc: { action: '查阅规范', describe: (a) => `读取规范文档：${a?.name || ''}` },
  list_docs: { action: '列出文档', describe: () => '查看可用规范文档列表' },
  query_docs: { action: '搜索规范', describe: (a) => `全文搜索规范：${a?.keyword || ''}` },
  update_doc: { action: '更新规范', describe: (a) => `更新规范文档：${a?.name || ''}` },
  distill_query: { action: '检索经验', describe: (a) => `搜索团队经验库：${a?.keyword || ''}` },
  distill_append: { action: '写入经验', describe: () => '将踩坑/技巧写入团队经验库（待评审）' },
  task_state: { action: '任务字段', describe: (a) => `读写任务辅助字段（action=${a?.action || ''}）` },
  verify_report: { action: '上报验证', describe: (a) => `上报 ${a?.level || ''} 验证结果` },
  drift_stats: { action: '偏差统计', describe: () => '查看 AI 产出偏差趋势' },
  lesson_record: { action: '通用经验', describe: () => '记录跨项目通用经验' },
}

const HTTP_LABELS = {
  http_verify: {
    action: '本地验证',
    describe: (p) => {
      const pass = p?.pass ? '通过' : '失败'
      return `verify.sh ${p?.level || ''} ${pass}${p?.file ? `（${p.file}）` : ''}`
    },
  },
  http_harness_status: { action: '查询 Harness', describe: (p) => `REST 查询任务状态：${p?.taskId || ''}` },
  http_harness_advance: { action: '推进 Harness', describe: (p) => `REST 推进到：${PHASE_LABELS[p?.to]?.name || p?.to || ''}` },
  mcp_init: { action: '客户端连接', describe: () => 'IDE 建立 MCP 连接' },
}

export function parseArgsPreview(preview) {
  if (!preview) return {}
  try {
    return JSON.parse(preview)
  } catch {
    return {}
  }
}

/** 生成事件中文说明（看板 / 审计 detail） */
export function describeAuditEvent(ev) {
  if (ev.event_type === 'mcp_init') {
    return HTTP_LABELS.mcp_init.describe()
  }
  if (ev.event_type?.startsWith('http_')) {
    const cfg = HTTP_LABELS[ev.event_type]
    if (cfg) {
      const args = parseArgsPreview(ev.args_preview)
      return `【${cfg.action}】${cfg.describe(args)}`
    }
  }
  if (ev.tool_name && TOOL_LABELS[ev.tool_name]) {
    const cfg = TOOL_LABELS[ev.tool_name]
    const args = parseArgsPreview(ev.args_preview)
    return `【${cfg.action}】${cfg.describe(args)}`
  }
  if (ev.tool_name) {
    return `【工具调用】${ev.tool_name}`
  }
  return ev.detail || '系统事件'
}

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] || { name: phase, summary: '' }
}
