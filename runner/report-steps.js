/**
 * report-steps.js — 测试步骤中文描述与结构化记录（业界 AI 报告骨架）
 *
 * 每一步统一字段：
 *   name(中文操作) | action | target | expected | actual | status | durationMs | evidence | note
 */

const ACTION_ZH = {
  goto: '打开页面',
  click: '点击',
  fill: '填写',
  type: '输入',
  press: '按键',
  check: '勾选',
  uncheck: '取消勾选',
  selectOption: '选择下拉项',
  hover: '悬停',
  focus: '聚焦',
  tap: '轻触',
  setInputFiles: '上传文件',
  waitForSelector: '等待元素出现',
  waitForURL: '等待 URL 变化',
  waitForLoadState: '等待页面加载',
  waitForTimeout: '等待（硬等待）',
  waitForFunction: '等待条件成立',
  waitForResponse: '等待接口响应',
  scrollIntoViewIfNeeded: '滚动到可见区域',
  evaluate: '执行页面脚本',
  dragTo: '拖拽',
  route: '拦截网络请求',
  unroute: '取消网络拦截',
  reload: '刷新页面',
  'spec-start': '开始执行考卷',
  'spec-pass': '考卷执行通过',
  'spec-fail': '考卷执行失败',
  'locator.click': '点击元素',
  'locator.fill': '填写输入框',
  'locator.type': '逐字输入',
  'locator.press': '元素上按键',
  'locator.check': '勾选',
  'locator.uncheck': '取消勾选',
  'locator.tap': '轻触元素',
  'locator.hover': '悬停元素',
  'locator.focus': '聚焦元素',
  'locator.selectOption': '选择下拉项',
  'locator.scrollIntoViewIfNeeded': '滚动元素到可见',
  'locator.clear': '清空输入',
  'locator.setInputFiles': '上传文件',
}

const PHASE_ZH = {
  queue: '排队',
  lease: '租约',
  inject: '注入',
  network: '网络',
  vm: '虚拟机',
  e2e: '页面操作',
  check: '用例',
  attempt: '尝试',
  result: '结果',
  done: '终态',
  static: '静态检查',
  install: '安装依赖',
  smoke: '冒烟',
}

export function actionLabel(action) {
  const a = String(action || '')
  if (ACTION_ZH[a]) return ACTION_ZH[a]
  if (a.startsWith('locator.')) return `操作元素 ${a.slice('locator.'.length)}`
  return a || '执行'
}

export function phaseLabel(phase) {
  return PHASE_ZH[String(phase || '')] || String(phase || '')
}

/**
 * 把 Playwright 风格 action 记录翻译成中文操作描述。
 * @param {{action, target, args?, status?}} step
 */
export function describeStep(step) {
  const action = String(step?.action || '')
  const target = step?.target == null ? '' : String(step.target)
  const args = Array.isArray(step?.args) ? step.args : []
  const label = actionLabel(action)

  if (action === 'goto') {
    return `打开页面 ${target || args[0] || ''}`.trim()
  }
  if (action === 'spec-start') {
    return `开始执行考卷《${target}》`
  }
  if (action === 'spec-pass') {
    return `考卷《${target}》执行通过`
  }
  if (action === 'spec-fail') {
    return `考卷《${target}》执行失败`
  }
  if (action === 'waitForResponse') {
    return `等待接口响应 ${target || args[0] || ''}`.trim()
  }
  if (action === 'route') {
    return `拦截网络请求 ${target || args[0] || ''}`.trim()
  }
  if (/fill|type/.test(action) && args.length) {
    return `${label} ${target || ''} ← ${String(args[0]).slice(0, 40)}`.trim()
  }
  if (/selectOption/.test(action) && args.length) {
    return `${label} ${target || ''} → ${typeof args[0] === 'object' ? JSON.stringify(args[0]).slice(0, 40) : String(args[0])}`.trim()
  }
  if (/press/.test(action) && args.length) {
    return `${label} ${target || ''}（键 ${args[0]}）`.trim()
  }
  if (target) {
    return `${label} ${target}`.trim()
  }
  if (args.length) {
    return `${label} ${args.join(' ')}`.trim()
  }
  return label
}

/** 简单 expected 启发式（无显式断言时） */
export function inferExpected(step) {
  const action = String(step?.action || '')
  if (action === 'goto') return '页面成功打开，无 JS 致命错误'
  if (/click|tap/.test(action)) return '点击后页面/DOM 发生预期变化'
  if (/fill|type/.test(action)) return '输入框值变为填写内容'
  if (action === 'waitForResponse') return '接口返回且状态码符合预期'
  if (action === 'route') return '后续匹配请求被拦截并返回 fixture'
  if (/check|uncheck/.test(action)) return '复选框状态切换成功'
  if (/selectOption/.test(action)) return '下拉选中目标选项'
  if (action === 'waitForSelector') return '目标元素出现且可见'
  return null
}

/**
 * 创建步骤记录器（host/static-lane 与 guest 共用语义）。
 */
export function createStepRecorder(initial = []) {
  const steps = Array.isArray(initial) ? [...initial] : []
  const push = (step) => {
    steps.push(step)
    return step
  }
  return {
    steps,
    /**
     * @param {string} phase
     * @param {string} name 中文操作描述
     * @param {object} opts
     */
    at(phase, name, {
      status = 'ok',
      detail = null,
      durationMs = null,
      logPath = null,
      action = null,
      target = null,
      expected = null,
      actual = null,
      evidence = null,
      note = null,
      caseKey = null,
      attempt = null,
    } = {}) {
      const s = {
        at: new Date().toISOString(),
        phase,
        name,
        status,
      }
      if (detail != null) s.detail = String(detail).slice(0, 2000)
      if (durationMs != null) s.durationMs = durationMs
      if (logPath) s.logPath = logPath
      if (action) s.action = action
      if (target != null) s.target = String(target).slice(0, 200)
      if (expected) s.expected = String(expected).slice(0, 500)
      if (actual) s.actual = String(actual).slice(0, 500)
      if (evidence) s.evidence = evidence
      if (note) s.note = String(note).slice(0, 500)
      if (caseKey) s.caseKey = caseKey
      if (attempt != null) s.attempt = attempt
      return push(s)
    },
    /** 从 Playwright actionLog 转中文步骤 */
    fromActionLog(actionLog, { phase = 'e2e', caseKey = null } = {}) {
      for (const a of actionLog || []) {
        const isMeta = a.action === 'spec-start' || a.action === 'spec-pass' || a.action === 'spec-fail'
        push({
          at: a.at || new Date().toISOString(),
          phase: isMeta ? 'check' : phase,
          name: describeStep(a),
          action: a.action,
          target: a.target ?? null,
          status: a.status === 'failed' ? 'failed' : 'ok',
          durationMs: a.durationMs ?? null,
          expected: isMeta ? null : (a.expected || inferExpected(a)),
          actual: a.status === 'failed' ? (a.detail || null) : null,
          detail: a.detail || null,
          caseKey: isMeta ? a.target : caseKey,
          args: a.args || undefined,
        })
      }
      return steps
    },
    toJSON() {
      return steps
    },
  }
}

/**
 * 把 guest check 转成报告友好的中文摘要行（timeline 合成用）。
 */
export function describeCheck(c) {
  const key = String(c?.caseKey || '')
  if (key.startsWith('test:spec/')) {
    const fk = key.slice('test:spec/'.length)
    const st = c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : c.status === 'error' ? '错误' : '失败'
    return {
      name: `E2E 考卷《${fk}》${st}`,
      expected: '页面断言全部通过（网络/数据/元素）',
      actual: c.status === 'passed' ? '全部断言通过' : (c.detail || null),
      caseKey: key,
    }
  }
  if (key.startsWith('test:unit-spec/')) {
    const fk = key.slice('test:unit-spec/'.length)
    const st = c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'
    const totals = c.execution?.totals
    const totalsLine = totals
      ? `用例 total=${totals.total} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`
      : null
    return {
      name: `单测资产《${fk}》${st}`,
      expected: '注入的 unit 测试全部执行且通过',
      actual: totalsLine || c.detail || null,
      caseKey: key,
    }
  }
  if (key.startsWith('test:static/')) {
    const st = c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'
    return {
      name: `静态检查 ${key.slice('test:static/'.length)} ${st}`,
      expected: '检查规则通过',
      actual: c.detail || null,
      caseKey: key,
    }
  }
  const st = c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'
  return {
    name: `检查项 ${key || '(unknown)'} ${st}`,
    expected: null,
    actual: c.detail || null,
    caseKey: key,
  }
}

export { ACTION_ZH, PHASE_ZH }
