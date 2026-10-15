/**
 * guest static lane 的 test:static/vitest 真执行协议单测：
 *  - 判定看 vitest JSON 报告（用例计数），不看退出码了事
 *  - 0 发现 / 0 执行 / 缺报告 / 超时被杀 → error（不可当通过）
 *  - 无资产 → passed + execution.reason=no-unit-assets（可被门禁区分）
 *  - S 级不再跳过；无 vitest 报 VITEST_UNAVAILABLE
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runStaticChecks, judgeVitestRun, summarizeVitestReport } from '../runner/guest-agent/static.mjs'
import { needsVitestRuntime } from '../runner/guest-agent/install.mjs'

/** 假 vitest：按 --outputFile 写 JSON 报告，按 spec 文件名决定报告形态与退出码 */
const FAKE_VITEST = `import fs from 'node:fs'
const args = process.argv.slice(2)
const outArg = args.find((a) => a.startsWith('--outputFile=')) || ''
const out = outArg ? outArg.slice('--outputFile='.length) : ''
const file = args[args.length - 1] || ''
const base = file.split(/[\\\\/]/).pop()
const emit = (obj, code) => { if (out) fs.writeFileSync(out, JSON.stringify(obj)); process.exit(code) }
const empty = { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [] }
if (base.includes('fail')) {
  console.error('FAIL')
  emit({ success: false, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: file, status: 'failed', assertionResults: [
      { status: 'failed', title: 't', fullName: 'suite > t', failureMessages: ['AssertionError: expected 1 to be 2'] }] }] }, 1)
} else if (base.includes('skip')) {
  emit({ success: true, numTotalTests: 1, numPassedTests: 0, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, testResults: [] }, 0)
} else if (base.includes('empty')) {
  emit({ success: true, ...empty }, 0)
} else if (base.includes('noreport')) {
  console.error('crashed before writing report')
  process.exit(1)
} else {
  emit({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    testResults: [{ name: file, status: 'passed', assertionResults: [{ status: 'passed', title: 'a', fullName: 'suite > a' }] }] }, 0)
}
`

function fixture({ size = 'M', specs = [], withVitest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'awp-vitest-'))
  const workspaceDir = join(root, 'workspace')
  const runDir = join(root, 'run')
  mkdirSync(workspaceDir, { recursive: true })
  if (specs.length) {
    const unitDir = join(runDir, 'input', 'test-specs', 'unit')
    mkdirSync(unitDir, { recursive: true })
    for (const s of specs) writeFileSync(join(unitDir, s.entry), '// spec\n', 'utf8')
    writeFileSync(
      join(unitDir, 'manifest.json'),
      JSON.stringify({ size, specs: specs.map((s) => ({ featureKey: s.featureKey, entry: s.entry })) }),
    )
  }
  if (withVitest) {
    const vitestDir = join(workspaceDir, 'node_modules', 'vitest')
    mkdirSync(vitestDir, { recursive: true })
    writeFileSync(join(vitestDir, 'vitest.mjs'), FAKE_VITEST)
  }
  return { workspaceDir, runDir }
}

const VITEST_CASE = { caseKey: 'test:static/vitest' }
const OK_SPEC = { featureKey: 'amount-ok', entry: 'amount-ok.unit.spec.mjs' }

function findCheck(checks, caseKey) {
  return checks.find((c) => c.caseKey === caseKey)
}

describe('test:static/vitest 真执行协议', () => {
  it('无 runDir / 无 unit 资产 → passed + skipped 且 execution.reason 可区分', () => {
    const { workspaceDir, runDir } = fixture({})
    const noRunDir = runStaticChecks({ workspaceDir, cases: [VITEST_CASE] })
    expect(noRunDir[0].status).toBe('passed')
    expect(noRunDir[0].detail).toMatch(/skipped/)
    expect(noRunDir[0].execution.reason).toBe('no-unit-assets')
    const noSpecs = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(noSpecs[0].status).toBe('passed')
    expect(noSpecs[0].execution.verified).toBe(false)
  })

  it('S 级不再跳过：照常执行并回传执行证据', () => {
    const { workspaceDir, runDir } = fixture({ size: 'S', specs: [OK_SPEC], withVitest: true })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    const spec = findCheck(checks, 'test:unit-spec/amount-ok')
    expect(spec.status).toBe('passed')
    expect(spec.execution.executed).toBe(2)
    const aggregate = findCheck(checks, 'test:static/vitest')
    expect(aggregate.status).toBe('passed')
    expect(aggregate.execution.verified).toBe(true)
    expect(aggregate.execution.totals.executed).toBe(2)
  })

  it('有资产但业务仓未装 vitest → error VITEST_UNAVAILABLE', () => {
    const { workspaceDir, runDir } = fixture({ specs: [OK_SPEC] })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(checks[0].status).toBe('error')
    expect(checks[0].detail).toMatch(/VITEST_UNAVAILABLE/)
  })

  it('逐资产展开：聚合 check + pass/fail 各自归属，失败带断言明细', () => {
    const { workspaceDir, runDir } = fixture({
      specs: [OK_SPEC, { featureKey: 'amount-fail', entry: 'amount-fail.unit.spec.mjs' }],
      withVitest: true,
    })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(checks.map((c) => c.caseKey)).toEqual([
      'test:static/vitest',
      'test:unit-spec/amount-ok',
      'test:unit-spec/amount-fail',
    ])
    expect(findCheck(checks, 'test:unit-spec/amount-ok').status).toBe('passed')
    const fail = findCheck(checks, 'test:unit-spec/amount-fail')
    expect(fail.status).toBe('failed')
    expect(fail.execution.reason).toBe('assertion-failed')
    expect(fail.detail).toMatch(/AssertionError/)
    expect(findCheck(checks, 'test:static/vitest').status).toBe('failed')
  })

  it('全 skip（退出码 0）→ error，不得当通过', () => {
    const { workspaceDir, runDir } = fixture({
      specs: [{ featureKey: 'amount-skip', entry: 'amount-skip.unit.spec.mjs' }],
      withVitest: true,
    })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    const spec = findCheck(checks, 'test:unit-spec/amount-skip')
    expect(spec.status).toBe('error')
    expect(spec.execution.reason).toBe('all-tests-skipped')
  })

  it('零发现（0 用例）→ error', () => {
    const { workspaceDir, runDir } = fixture({
      specs: [{ featureKey: 'amount-empty', entry: 'amount-empty.unit.spec.mjs' }],
      withVitest: true,
    })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(findCheck(checks, 'test:unit-spec/amount-empty').status).toBe('error')
    expect(findCheck(checks, 'test:unit-spec/amount-empty').execution.reason).toBe('no-tests-discovered')
  })

  it('报告缺失（崩在写报告前）→ error，不可当通过', () => {
    const { workspaceDir, runDir } = fixture({
      specs: [{ featureKey: 'amount-noreport', entry: 'amount-noreport.unit.spec.mjs' }],
      withVitest: true,
    })
    const checks = runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(findCheck(checks, 'test:unit-spec/amount-noreport').status).toBe('error')
    expect(findCheck(checks, 'test:unit-spec/amount-noreport').execution.reason).toBe('vitest-report-missing')
  })

  it('暂存目录跑完即清理（不把考卷留进产物）', () => {
    const { workspaceDir, runDir } = fixture({ specs: [OK_SPEC], withVitest: true })
    runStaticChecks({ workspaceDir, cases: [VITEST_CASE], runDir })
    expect(() => readFileSync(join(workspaceDir, '.awp-unit-specs', 'vitest.config.mjs'), 'utf8')).toThrow()
  })

  it('非 vitest case 走原 runCase 路径不受影响', () => {
    const { workspaceDir, runDir } = fixture({})
    const checks = runStaticChecks({
      workspaceDir,
      cases: [{ caseKey: 'test:static/hard-rules' }, VITEST_CASE],
      runDir,
    })
    expect(checks.map((c) => c.caseKey)).toEqual(['test:static/hard-rules', 'test:static/vitest'])
    expect(checks[0].status).toBe('passed')
  })
})

describe('judgeVitestRun 纯函数判据', () => {
  const okReport = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 }

  it('有用例执行且全过 → passed', () => {
    expect(judgeVitestRun({ exitCode: 0, report: okReport })).toMatchObject({ status: 'passed', reason: null })
  })

  it('报告缺失 / 超时被杀 / 零发现 / 全跳过 → error', () => {
    expect(judgeVitestRun({ exitCode: 1, report: null }).reason).toBe('vitest-report-missing')
    expect(judgeVitestRun({ exitCode: null, signal: 'SIGTERM', report: okReport }).reason).toBe('vitest-timeout-or-killed')
    expect(judgeVitestRun({ exitCode: 1, report: { ...okReport, numTotalTests: 0, numPassedTests: 0 } }).reason).toBe('no-tests-discovered')
    expect(judgeVitestRun({ exitCode: 0, report: { ...okReport, numPassedTests: 0, numPendingTests: 1 } }).reason).toBe('all-tests-skipped')
  })

  it('有用例失败 → failed；退出码非零但报告全过 → error（非断言失败）', () => {
    expect(judgeVitestRun({ exitCode: 1, report: { ...okReport, success: false, numFailedTests: 1, numPassedTests: 0 } }).status).toBe('failed')
    expect(judgeVitestRun({ exitCode: 2, report: okReport }).status).toBe('error')
  })

  it('summarizeVitestReport 从报告抽计数', () => {
    expect(summarizeVitestReport(okReport)).toMatchObject({ total: 1, passed: 1, failed: 0, executed: 1 })
    expect(summarizeVitestReport(null)).toMatchObject({ total: 0, executed: 0 })
  })
})

describe('needsVitestRuntime 零接入补装判定', () => {
  it('有资产 + vitest case + 业务仓未装 → true（S 级同样补装）', () => {
    const m = fixture({ specs: [OK_SPEC] })
    expect(needsVitestRuntime({ workspaceDir: m.workspaceDir, runDir: m.runDir, unit: 'static', cases: [VITEST_CASE] })).toBe(true)
    const s = fixture({ size: 'S', specs: [OK_SPEC] })
    expect(needsVitestRuntime({ workspaceDir: s.workspaceDir, runDir: s.runDir, unit: 'static', cases: [VITEST_CASE] })).toBe(true)
  })

  it('非 static unit / 无 vitest case → false', () => {
    const { workspaceDir, runDir } = fixture({ specs: [OK_SPEC] })
    expect(needsVitestRuntime({ workspaceDir, runDir, unit: 'smoke', cases: [VITEST_CASE] })).toBe(false)
    expect(needsVitestRuntime({ workspaceDir, runDir, unit: 'static', cases: [{ caseKey: 'test:static/eslint' }] })).toBe(false)
  })

  it('业务仓已装 vitest → false（让位业务仓版本）；无资产 → false', () => {
    const installed = fixture({ specs: [OK_SPEC], withVitest: true })
    expect(needsVitestRuntime({ workspaceDir: installed.workspaceDir, runDir: installed.runDir, unit: 'static', cases: [VITEST_CASE] })).toBe(false)
    const noAssets = fixture({})
    expect(needsVitestRuntime({ workspaceDir: noAssets.workspaceDir, runDir: noAssets.runDir, unit: 'static', cases: [VITEST_CASE] })).toBe(false)
  })
})
