/**
 * report-timeline.js — 测试报告时间线 / 执行摘要 / 失败分析（中文）
 *
 * 输入：test_runs + run_attempts(steps_json) + report_json.checks
 * 输出：与 /api/testing/runs/:id/timeline 兼容的增强结构
 */
import { describeCheck, describeStep } from '../runner/report-steps.js'

const STATUS_ZH = {
  passed: '通过',
  failed: '失败',
  error: '错误',
  skipped: '跳过',
  queued: '排队中',
  active: '执行中',
  lost: '丢失',
  timed_out: '超时',
  canceled: '已取消',
}

export function statusZh(s) {
  return STATUS_ZH[String(s || '')] || String(s || '')
}

/**
 * 从 checks + attempts 合成中文分步时间线。
 * @param {object} run test_runs 行
 * @param {Array} attempts run_attempts 行（含 steps_json）
 * @param {Array} checks report_json.checks
 */
export function buildTimeline({ run, attempts = [], checks = [], reportAttempt }) {
  if (reportAttempt === undefined) {
    try { reportAttempt = JSON.parse(run.report_json || '{}')?.attempt } catch { /* 旧报告无尝试归属 */ }
  }
  reportAttempt = Number.isInteger(reportAttempt) && reportAttempt > 0 ? reportAttempt : null
  const timeline = []
  const push = (s) => {
    const step = { ...s, at: s.at ?? null, attempt: s.attempt ?? null,
      source: s.source || (s.at ? 'recorded' : 'synthesized'),
      timeSource: s.at ? s.source === 'synthesized' ? 'synthesized' : 'recorded' : 'unrecorded' }
    timeline.push(step)
    return step
  }

  push({
    at: run.created_at,
    phase: 'queue',
    name: '任务入队，等待 worker 领取',
    status: 'ok',
    detail: `unit=${run.unit || '-'} side=${run.side || '-'}`,
    expected: '有空闲 worker 接单',
    actual: '已进入队列',
  })
  if (run.started_at) {
    push({
      at: run.started_at,
      phase: 'queue',
      name: 'worker 开始执行本 run',
      status: 'ok',
      expected: '租约建立并进入执行',
      actual: 'started_at 已写入',
    })
  }

  for (const a of attempts) {
    let recorded = []
    try {
      const parsed = a.steps_json ? JSON.parse(a.steps_json) : []
      recorded = Array.isArray(parsed) ? parsed.filter((s) => s && typeof s === 'object') : []
    } catch {
      recorded = []
    }
    push({
      at: a.started_at,
      attempt: a.attempt,
      phase: 'attempt',
      name: `第 ${a.attempt} 次尝试开始`,
      status: 'ok',
      detail: [
        a.worker ? `worker=${a.worker}` : null,
        a.image_id ? `镜像=${a.image_id}` : null,
      ].filter(Boolean).join(' · ') || null,
      durationMs:
        a.started_at && a.finished_at
          ? Date.parse(a.finished_at) - Date.parse(a.started_at)
          : null,
    })

    if (recorded.length) {
      for (const s of recorded) {
        // 已是中文 name 的 recorded steps 直接透传；若是旧英文 action 则补中文
        const step = { ...s, attempt: a.attempt, source: s.source === 'synthesized' ? 'synthesized' : 'recorded' }
        if (!step.name && step.action) {
          step.name = describeStep(step)
        }
        if (s.phase === 'check' && !step.expected && reportAttempt === a.attempt) {
          // 仅使用归属明确的本次报告补充，旧 run 级报告不复制到每次尝试。
          const c = checks.find((x) => x.caseKey === s.caseKey || s.name === x.caseKey)
          if (c) {
            const d = describeCheck(c)
            step.expected = step.expected || d.expected
            step.actual = step.actual || (c.status === 'passed' ? d.actual : c.detail || d.actual)
            step.name = step.name || d.name
          }
        }
        push(step)
      }
    } else if (a.status === 'error' || a.status === 'lost') {
      push({
        at: a.finished_at || null,
        source: 'synthesized',
        phase: 'attempt',
        name: `第 ${a.attempt} 次尝试失败`,
        status: 'failed',
        detail: a.error_code || a.status,
        actual: a.error_detail || a.error_code || a.status,
        attempt: a.attempt,
      })
    }

    if (a.finished_at) {
      push({
        at: a.finished_at,
        phase: 'attempt',
        name: `第 ${a.attempt} 次尝试结束：${statusZh(a.status)}`,
        status: a.status === 'passed' ? 'ok' : a.status === 'failed' || a.status === 'error' ? 'failed' : 'ok',
        detail: a.status,
        attempt: a.attempt,
      })
    }
  }

  // checks：若未出现在 recorded steps 里，补中文用例行
  const reportSteps = timeline.filter((t) => reportAttempt !== null && t.attempt === reportAttempt)
  const recordedNames = new Set(reportSteps.map((t) => t.name))
  for (const c of checks) {
    const d = describeCheck(c)
    if (recordedNames.has(d.name) || recordedNames.has(c.caseKey)) continue
    // 已有同 caseKey 的 recorded 行则跳过
    if (reportSteps.some((t) => t.caseKey === c.caseKey && t.phase === 'check')) continue
    push({
      // 报告只有结果，没有检查项发生时间；不得借用 run 结束时刻冒充记录。
      at: null,
      source: 'synthesized',
      attempt: reportAttempt,
      phase: 'check',
      name: d.name,
      status: c.status === 'passed' ? 'ok' : c.status === 'skipped' ? 'skip' : 'failed',
      detail: c.detail || null,
      durationMs: c.durationMs ?? null,
      expected: d.expected,
      actual: d.actual,
      caseKey: c.caseKey,
      actionCount: c.actionCount ?? null,
      logPath: 'output/agent.log',
      e2eLogPath: String(c.caseKey || '').startsWith('test:spec/')
        ? `logs/e2e-actions-${String(c.caseKey).slice('test:spec/'.length).replace(/[^\w.-]+/g, '_')}.json`
        : null,
      asset: c.asset || undefined,
    })
  }

  if (run.finished_at) {
    push({
      at: run.finished_at,
      phase: 'done',
      name: `运行终态：${statusZh(run.status)}`,
      status:
        run.status === 'passed'
          ? 'ok'
          : run.status === 'failed' || run.status === 'error'
            ? 'failed'
            : 'ok',
      detail: run.terminal_reason || null,
      expected: 'run 产生明确终态',
      actual: `${run.status}${run.terminal_reason ? ` / ${run.terminal_reason}` : ''}`,
    })
  }

  timeline.sort((x, y) => {
    const a = Date.parse(x.at), b = Date.parse(y.at)
    if (!Number.isFinite(a)) return Number.isFinite(b) ? 1 : 0
    if (!Number.isFinite(b)) return -1
    return a - b
  })
  return timeline
}

/**
 * 执行摘要（看板顶部一段中文）
 */
export function buildSummary({ run, checks = [], attempts = [], unit, side }) {
  const passed = checks.filter((c) => c.status === 'passed').length
  const failed = checks.filter((c) => c.status === 'failed' || c.status === 'error').length
  const skipped = checks.filter((c) => c.status === 'skipped').length
  const totalMs =
    run.started_at && run.finished_at
      ? Date.parse(run.finished_at) - Date.parse(run.started_at)
      : run.total_ms ?? null
  const lines = []
  lines.push(
    `用例结果：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}（共 ${checks.length}）`
  )
  if (totalMs != null) lines.push(`总耗时：${Math.round(totalMs / 1000)}s`)
  if (attempts.length > 1) lines.push(`共经历 ${attempts.length} 次尝试（含重试）`)
  const failedKeys = checks
    .filter((c) => c.status === 'failed' || c.status === 'error')
    .map((c) => c.caseKey)
  if (failedKeys.length) lines.push(`失败项：${failedKeys.join('、')}`)
  const verdict =
    run.status === 'passed'
      ? '结论：本 run 通过'
      : run.status === 'skipped'
        ? '结论：本 run 跳过'
        : `结论：本 run ${statusZh(run.status)}${run.terminal_reason ? `（${run.terminal_reason}）` : ''}`
  lines.push(verdict)
  return {
    unit: unit ?? run.unit,
    side: side ?? run.side,
    status: run.status,
    statusZh: statusZh(run.status),
    passed,
    failed,
    skipped,
    total: checks.length,
    durationMs: totalMs,
    attemptCount: attempts.length,
    failedCaseKeys: failedKeys,
    text: lines.join('\n'),
  }
}

/**
 * 失败分析：首错 + 分类启发 + 建议动作（中文）
 */
export function buildFailureAnalysis({ run, checks = [], attempts = [] }) {
  const failedChecks = checks.filter((c) => c.status === 'failed' || c.status === 'error')
  if (!failedChecks.length && run.status === 'passed') {
    return { hasFailure: false, text: null }
  }
  const first = failedChecks[0] || null
  const errAttempt = attempts.find((a) => a.error_code || a.status === 'error' || a.status === 'lost')
  const categories = []
  for (const c of failedChecks) {
    categories.push(classifyFailure(c))
  }
  const primary = categories[0] || (errAttempt ? 'infra' : 'unknown')
  const tips = suggest(primary, first, errAttempt)

  const lines = []
  lines.push(`首错用例：${first?.caseKey || errAttempt?.error_code || run.terminal_reason || '(未知)'}`)
  if (first?.detail) lines.push(`首错信息：${String(first.detail).split('\n')[0].slice(0, 200)}`)
  if (errAttempt?.error_code) lines.push(`执行层错误：${errAttempt.error_code}`)
  lines.push(`失败分类：${categoryZh(primary)}`)
  if (failedChecks.length > 1) {
    lines.push(`其他失败：${failedChecks.slice(1).map((c) => c.caseKey).join('、')}`)
  }
  lines.push(`建议：${tips}`)

  return {
    hasFailure: true,
    firstCaseKey: first?.caseKey || null,
    category: primary,
    categoryZh: categoryZh(primary),
    failedChecks: failedChecks.map((c) => ({
      caseKey: c.caseKey,
      status: c.status,
      detail: c.detail || null,
    })),
    text: lines.join('\n'),
  }
}

function classifyFailure(check) {
  const d = `${check.detail || ''} ${check.caseKey || ''}`.toLowerCase()
  if (/vitest-unavailable|no-unit-assets|manifest-invalid|spec-missing/.test(d)) return 'suite'
  if (/timeout|timed.?out|etimedout/.test(d)) return 'infra'
  if (/smoke_failed|vm_|hyper-?v|vhdx/.test(d)) return 'infra'
  if (/locator|waiting for|noscript|not found|getby|selector/.test(d)) return 'suite'
  if (/expect|assert|toBe|status\(\)|400|500|validation/.test(d)) return 'product'
  if (check.status === 'error') return 'infra'
  return 'product'
}

function categoryZh(c) {
  const map = {
    product: '产品缺陷（业务断言失败）',
    suite: '考卷问题（选择器/资产/脚本）',
    infra: '环境/执行基础设施',
    flaky: '闪断（需复跑确认）',
    unknown: '未分类',
  }
  return map[c] || c
}

function suggest(category, check, errAttempt) {
  if (category === 'suite') {
    return '优先改考卷：核对 data-test 是否落在真实 DOM、断言是否过严；不要先改业务代码。'
  }
  if (category === 'infra') {
    return '查看 worker/VM 日志与镜像版本；确认依赖安装与网络代理是否正常，必要时重跑本 run。'
  }
  if (category === 'product') {
    return '按首错 detail 中的接口/DOM_PROBE 定位业务问题；修复后 distill 开发经验再重提测。'
  }
  if (errAttempt) {
    return '执行层已失败，先看 attempt error_code，再决定重跑或修环境。'
  }
  return '结合分步时间线与截图定位首错步骤。'
}

/**
 * attempt 步骤级 diff（上一绿/上一尝试 vs 本次）
 */
export function diffAttempts(prevSteps, currSteps) {
  const key = (s) => `${s.phase || ''}|${s.name || s.action || ''}|${s.caseKey || ''}`
  const prevMap = new Map((prevSteps || []).map((s) => [key(s), s]))
  const currMap = new Map((currSteps || []).map((s) => [key(s), s]))
  const becameFailed = []
  const becamePassed = []
  for (const [k, s] of currMap) {
    const p = prevMap.get(k)
    const currFail = s.status === 'failed'
    const prevFail = p && p.status === 'failed'
    if (currFail && !prevFail) becameFailed.push(s)
    if (!currFail && p && prevFail && s.status === 'ok') becamePassed.push(s)
  }
  return { becameFailed, becamePassed }
}

export { statusZh as reportStatusZh }
