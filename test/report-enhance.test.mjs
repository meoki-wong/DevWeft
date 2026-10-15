/**
 * AI 测试报告增强：中文分步 / 时间线合成 / 执行摘要 / 失败分析
 */
import { describe, expect, it } from 'vitest'
import {
  describeStep,
  inferExpected,
  actionLabel,
  describeCheck,
} from '../runner/report-steps.js'
import {
  buildTimeline,
  buildSummary,
  buildFailureAnalysis,
  statusZh,
} from '../testing/report-timeline.js'

describe('report-steps 中文描述', () => {
  it('goto → 打开页面', () => {
    expect(describeStep({ action: 'goto', target: '/app/activityManage' })).toContain('打开页面')
    expect(describeStep({ action: 'goto', target: '/app/x' })).toContain('/app/x')
  })
  it('click → 点击元素', () => {
    expect(describeStep({ action: 'click', target: '[data-test=submit]' })).toBe('点击 [data-test=submit]')
  })
  it('fill 带内容', () => {
    const s = describeStep({ action: 'fill', target: '#name', args: ['活动A'] })
    expect(s).toContain('填写')
    expect(s).toContain('活动A')
  })
  it('spec-start 中文', () => {
    expect(describeStep({ action: 'spec-start', target: 'activity-list' })).toContain('开始执行考卷')
  })
  it('locator.click', () => {
    expect(describeStep({ action: 'locator.click', target: 'getByTestId(btn)' })).toContain('点击元素')
  })
  it('inferExpected', () => {
    expect(inferExpected({ action: 'goto' })).toBeTruthy()
    expect(inferExpected({ action: 'click' })).toBeTruthy()
  })
  it('actionLabel fallback', () => {
    expect(actionLabel('unknown-action')).toBe('unknown-action')
  })
  it('describeCheck e2e/unit/static', () => {
    expect(describeCheck({ caseKey: 'test:spec/foo', status: 'passed' }).name).toContain('E2E 考卷')
    expect(describeCheck({ caseKey: 'test:unit-spec/bar', status: 'failed' }).name).toContain('单测资产')
    expect(describeCheck({ caseKey: 'test:static/eslint', status: 'passed' }).name).toContain('静态检查')
  })
})

describe('report-timeline', () => {
  const run = {
    run_id: 'r1',
    unit: 'web',
    side: 'web',
    status: 'failed',
    terminal_reason: 'UNITS_FAILED',
    created_at: '2026-09-17T10:00:00.000Z',
    started_at: '2026-09-17T10:00:05.000Z',
    finished_at: '2026-09-17T10:02:00.000Z',
    total_ms: 115000,
  }
  const attempts = [
    {
      attempt: 1,
      status: 'failed',
      started_at: '2026-09-17T10:00:05.000Z',
      finished_at: '2026-09-17T10:02:00.000Z',
      image_id: 'golden-v12',
      worker: 'WIN-01',
      steps_json: JSON.stringify([
        {
          at: '2026-09-17T10:00:10.000Z',
          phase: 'lease',
          name: '领取执行租约（lease）',
          status: 'ok',
          expected: '成功占用 worker 执行槽',
          actual: 'attempt=1',
        },
        {
          at: '2026-09-17T10:00:30.000Z',
          phase: 'e2e',
          name: '点击 [data-test=submit-btn]',
          action: 'click',
          target: '[data-test=submit-btn]',
          status: 'failed',
          expected: '接口返回 200',
          actual: '接口返回 400',
          caseKey: 'test:spec/submit',
        },
        {
          at: '2026-09-17T10:01:00.000Z',
          phase: 'check',
          name: 'E2E 考卷《submit》失败',
          status: 'failed',
          caseKey: 'test:spec/submit',
          expected: '页面断言全部通过',
          actual: '接口返回 400',
        },
      ]),
    },
  ]
  const checks = [
    {
      caseKey: 'test:spec/submit',
      status: 'failed',
      durationMs: 30000,
      detail: 'expect status 200 got 400\nDOM_PROBE url=/app/x',
    },
    {
      caseKey: 'test:static/eslint',
      status: 'passed',
      durationMs: 1000,
    },
  ]

  it('buildTimeline 含中文名与 expected/actual', () => {
    const tl = buildTimeline({ run, attempts, checks })
    expect(tl.length).toBeGreaterThan(3)
    const lease = tl.find((s) => s.name?.includes('领取执行租约'))
    expect(lease?.expected).toBeTruthy()
    const click = tl.find((s) => s.name?.includes('点击'))
    expect(click?.expected).toBe('接口返回 200')
    expect(click?.actual).toBe('接口返回 400')
    // eslint check 若未在 recorded 中出现会补一行
    const eslint = tl.find((s) => s.caseKey === 'test:static/eslint')
    expect(eslint?.name).toContain('静态检查')
    expect(eslint?.name).toContain('通过')
  })

  it('每步带来源与 attempt；合成检查项没有伪造时间', () => {
    const tl = buildTimeline({ run, attempts, checks, reportAttempt: 1 })
    expect(tl.every((s) => ['recorded', 'synthesized'].includes(s.source) && Object.hasOwn(s, 'attempt'))).toBe(true)
    expect(tl.find((s) => s.name.includes('尝试开始'))).toMatchObject({ attempt: 1, source: 'recorded' })
    expect(tl.find((s) => s.name.includes('领取执行租约'))).toMatchObject({ attempt: 1, source: 'recorded' })
    expect(tl.find((s) => s.caseKey === 'test:static/eslint')).toMatchObject({ source: 'synthesized', attempt: 1, at: null, timeSource: 'unrecorded' })
    expect(tl.find((s) => s.phase === 'queue')).toMatchObject({ attempt: null, source: 'recorded' })
  })

  it('多个尝试同 caseKey 不互相覆盖，也不拿早期步骤吞掉最新报告', () => {
    const first = { ...attempts[0], steps_json: JSON.stringify([{ at: run.started_at, phase: 'check', caseKey: 'same', name: 'same', status: 'failed' }]) }
    const second = { attempt: 2, status: 'passed', started_at: run.finished_at }
    const check = [{ caseKey: 'same', status: 'passed', detail: '最新尝试通过' }]
    const tl = buildTimeline({ run, attempts: [first, second], checks: check, reportAttempt: 2 })
    const earlier = tl.find((s) => s.caseKey === 'same' && s.attempt === 1)
    expect(earlier.status).toBe('failed')
    expect(earlier.actual).toBeUndefined()
    expect(tl.find((s) => s.caseKey === 'same' && s.attempt === 2)).toMatchObject({ source: 'synthesized', status: 'ok', at: null })
    const unknown = buildTimeline({ run, attempts: [first, second], checks: check })
    expect(unknown.find((s) => s.caseKey === 'same' && s.source === 'synthesized').attempt).toBeNull()
  })

  it('报告自身 attempt 可正常读取，明确关联后才补充 expected/actual', () => {
    const a = { ...attempts[0], steps_json: JSON.stringify([{ phase: 'check', caseKey: 'test:spec/submit', status: 'failed' }]) }
    const tl = buildTimeline({ run: { ...run, report_json: '{"attempt":1}' }, attempts: [a], checks })
    expect(tl.find((s) => s.caseKey === 'test:spec/submit')).toMatchObject({ attempt: 1, source: 'recorded', timeSource: 'unrecorded', actual: checks[0].detail })
  })

  it('混合时区按真实时间排序，已有 synthesized 来源不会冒充 recorded', () => {
    const a = { attempt: 1, steps_json: JSON.stringify([
      { at: '2026-09-17T18:00:20+08:00', name: '较早' },
      { at: '2026-09-17T10:00:30Z', name: '较晚', source: 'synthesized' },
    ]) }
    const tl = buildTimeline({ run, attempts: [a] })
    expect(tl.findIndex((s) => s.name === '较早')).toBeLessThan(tl.findIndex((s) => s.name === '较晚'))
    expect(tl.find((s) => s.name === '较晚')).toMatchObject({ source: 'synthesized', timeSource: 'synthesized' })
  })

  it.each(['null', '{}', '{bad', '[null]'])('损坏或非数组 steps %s 不使整个时间线崩溃', (steps_json) => {
    const tl = buildTimeline({ run, attempts: [{ attempt: 1, status: 'error', steps_json }], checks })
    expect(tl.find((s) => s.name.includes('尝试失败'))).toMatchObject({ at: null, source: 'synthesized', attempt: 1 })
  })

  it('buildSummary 中文结论', () => {
    const sum = buildSummary({ run, checks, attempts })
    expect(sum.passed).toBe(1)
    expect(sum.failed).toBe(1)
    expect(sum.text).toContain('通过 1')
    expect(sum.text).toContain('失败')
    expect(sum.text).toContain('结论')
    expect(sum.statusZh).toBe('失败')
  })

  it('buildFailureAnalysis 首错与建议', () => {
    const fa = buildFailureAnalysis({ run, checks, attempts })
    expect(fa.hasFailure).toBe(true)
    expect(fa.firstCaseKey).toBe('test:spec/submit')
    expect(fa.categoryZh).toBeTruthy()
    expect(fa.text).toContain('首错用例')
    expect(fa.text).toContain('建议')
  })

  it('passed run 无失败分析正文', () => {
    const okRun = { ...run, status: 'passed', terminal_reason: null }
    const okChecks = [{ caseKey: 'test:static/eslint', status: 'passed', durationMs: 1 }]
    const fa = buildFailureAnalysis({ run: okRun, checks: okChecks, attempts: [] })
    expect(fa.hasFailure).toBe(false)
  })

  it('statusZh 映射', () => {
    expect(statusZh('passed')).toBe('通过')
    expect(statusZh('timed_out')).toBe('超时')
  })
})
