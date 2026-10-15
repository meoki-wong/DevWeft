import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const STATIC_TIMEOUT_MS = 600000
// vitest 单 spec 超时 5 分钟（unit 资产逐文件执行，失败摘要互不影响）
const VITEST_TIMEOUT_MS = 300000
// unit 资产暂存目录：spec 与平台 vitest 配置、JSON 报告都落这里，跑完整体清理
const UNIT_STAGING_DIR = '.awp-unit-specs'

/**
 * eslint 参数：只 lint 本次任务改动文件（changed-files.json）。
 * --no-ignore：改动文件即使在 .eslintignore 基线也要检查（改了就要干净），
 * 因此不再需要 eslint-ratchet 单独拦基线命中。
 */
export function eslintArgs(targetFiles = null) {
  const base = ['--ext', '.vue,.js,.jsx,.cjs,.mjs']
  if (Array.isArray(targetFiles) && targetFiles.length) {
    return [...base, '--no-ignore', ...targetFiles]
  }
  return base
}

export function runStaticChecks({ workspaceDir, cases, runDir = null }) {
  const out = []
  for (const c of cases) {
    // vitest case 展开为每资产一条 check（test:unit-spec/<featureKey>），支撑 fail_streak 治理回写
    if (c.caseKey === 'test:static/vitest') {
      out.push(...runVitestSpecs({ workspaceDir, runDir }))
      continue
    }
    // eslint case 搭车执行：租户自定义检查 + 样式复用率（不新增 suite case，套件/锁零改动）。
    // 三者任一失败 → 本 check failed（product 类，烧迭代）；skipped 不影响判定。
    if (c.caseKey === 'test:static/eslint') {
      const started = Date.now()
      const lint = runCase(c.caseKey, workspaceDir, runDir)
      const tenant = runTenantChecks({ workspaceDir, runDir })
      const style = runStyleReuse({ workspaceDir, runDir })
      const blocking = [lint, ...tenant, ...style]
      const status = blocking.some((e) => e.status === 'error')
        ? 'error'
        : blocking.some((e) => e.status === 'failed')
          ? 'failed'
          : 'passed'
      const detail = blocking
        .map((e) => (e.detail ? `[${e.caseKey}] ${e.detail}` : null))
        .filter(Boolean)
        .join('\n')
      const check = { caseKey: c.caseKey, status, durationMs: Math.max(0, Date.now() - started) }
      if (detail) check.detail = detail
      out.push(check)
      continue
    }
    // eslint 基线 ratchet：改动命中 .eslintignore 豁免即 failed（基线只减不增，防改动被存量豁免吞掉）
    if (c.caseKey === 'test:static/eslint-ratchet') {
      out.push(runEslintRatchet({ workspaceDir, runDir }))
      continue
    }
    const started = Date.now()
    const { status, detail } = runCase(c.caseKey, workspaceDir, runDir)
    const check = { caseKey: c.caseKey, status, durationMs: Math.max(0, Date.now() - started) }
    if (detail) check.detail = detail
    out.push(check)
  }
  return out
}

function zeroUnitTotals() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, executed: 0 }
}

/** 无 unit 资产的空跑：passed + execution.reason（门禁据此区分「该仓没资产」与「跑了但没证据」） */
function vitestSkipped(reason, detail) {
  return [{
    caseKey: 'test:static/vitest',
    status: 'passed',
    durationMs: 0,
    detail,
    execution: { verified: false, reason, specs: [], totals: zeroUnitTotals() },
  }]
}

/** 读租户配置：awp.config.json / .awp/config.json；解析失败标记 __invalid */
function readTenantConfig(workspaceDir) {
  for (const p of [join(workspaceDir, 'awp.config.json'), join(workspaceDir, '.awp', 'config.json')]) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
    } catch {
      return { __invalid: true }
    }
  }
  return null
}

/**
 * test:static/tenant-checks：租户自定义 shell/npm 检查（VM 内隔离执行，快照内自包含）。
 * 任一失败 → product 类（计分、烧迭代、药方带脚本输出）。
 */
export function runTenantChecks({ workspaceDir } = {}) {
  const started = Date.now()
  const cfg = readTenantConfig(workspaceDir)
  if (!cfg) {
    return [{ caseKey: 'test:static/tenant-checks', status: 'passed', durationMs: 0, detail: 'skipped: 无 awp.config.json（租户未定制）' }]
  }
  if (cfg.__invalid) {
    return [{ caseKey: 'test:static/tenant-checks', status: 'failed', durationMs: 0, detail: 'awp.config.json 解析失败（JSON 语法错误）' }]
  }
  const checks = Array.isArray(cfg.checks) ? cfg.checks : []
  if (!checks.length) {
    return [{ caseKey: 'test:static/tenant-checks', status: 'passed', durationMs: 0, detail: 'skipped: checks 未声明' }]
  }
  const failed = []
  let ran = 0
  for (const c of checks) {
    if (!c || !c.name || !c.script) continue
    const timeout = Math.min(600000, Number(c.timeout) > 0 ? Number(c.timeout) * 1000 : 120000)
    ran += 1
    try {
      const r = spawnSync('cmd.exe', ['/c', c.script], { cwd: workspaceDir, timeout, encoding: 'utf8' })
      if (r.status !== 0) {
        failed.push(
          `${c.name}: exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}\n` +
            String(r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-6).join('\n') +
            (r.stderr ? `\n[stderr] ${String(r.stderr).slice(-300)}` : '')
        )
      }
    } catch (e) {
      failed.push(`${c.name}: ${e.message}`)
    }
  }
  return [
    {
      caseKey: 'test:static/tenant-checks',
      status: failed.length ? 'failed' : 'passed',
      durationMs: Math.max(0, Date.now() - started),
      detail: failed.length
        ? `租户自定义检查失败（${failed.length}/${ran}）：\n${failed.join('\n---\n')}`
        : `租户自定义检查通过（${ran} 项）`,
    },
  ]
}

/**
 * test:static/style-reuse：样式复用率（租户阈值经 host 写入 input/static-config.json）。
 * 运行业务仓自带的 scripts/analyze-styles；未启用/无工具/无改动 → skipped。
 */
export function runStyleReuse({ workspaceDir, runDir } = {}) {
  const started = Date.now()
  const cfgPath = runDir ? join(runDir, 'input', 'static-config.json') : null
  if (!cfgPath || !existsSync(cfgPath)) {
    return [{ caseKey: 'test:static/style-reuse', status: 'passed', durationMs: 0, detail: 'skipped: 租户未启用样式复用检查' }]
  }
  let threshold = 0
  try {
    threshold = Number(JSON.parse(readFileSync(cfgPath, 'utf8')).styleReuseThreshold) || 0
  } catch {
    threshold = 0
  }
  if (threshold <= 0) {
    return [{ caseKey: 'test:static/style-reuse', status: 'passed', durationMs: 0, detail: 'skipped: 阈值未配置' }]
  }
  const analyzer = join(workspaceDir, 'scripts', 'analyze-styles', 'index.js')
  if (!existsSync(analyzer)) {
    return [{ caseKey: 'test:static/style-reuse', status: 'error', durationMs: 0, detail: 'analyze-styles 工具不在快照中（无法判卷，按 infra 处理）' }]
  }
  const lintable = loadLintableChangedFiles(workspaceDir, runDir)
  const styleFiles = (lintable.files || []).filter((f) => /\.(vue|less)$/i.test(f))
  if (!styleFiles.length) {
    return [{ caseKey: 'test:static/style-reuse', status: 'passed', durationMs: 0, detail: 'skipped: 本任务无 .vue/.less 改动' }]
  }
  // analyze-styles 工具自带 80% 阈值口径；租户阈值仅控制"是否启用 + 判定口径提示"
  const r = spawnSync('node', [analyzer, '--check', ...styleFiles], {
    cwd: workspaceDir,
    timeout: 120000,
    encoding: 'utf8',
  })
  // 优先回传可收敛/判定相关行，避免 tail 截掉真正 equiv>0 的真凶（Agent 否则会误改自己的干净代码）
  const allLines = String(r.stdout || '').split(/\r?\n/).filter(Boolean)
  const critical = allLines.filter((l) => /可收敛|存在等价|\[reuse\]|目标文件|类定义|复用已有|打回|放行/i.test(l))
  const rest = allLines.filter((l) => !critical.includes(l))
  const tail = [...critical.slice(0, 8), ...rest.slice(-4)].filter(Boolean).join('\n')
  return [
    {
      caseKey: 'test:static/style-reuse',
      status: r.status === 0 ? 'passed' : 'failed',
      durationMs: Math.max(0, Date.now() - started),
      detail:
        (r.status === 0 ? `样式复用率 ≥ ${threshold}% 通过` : `样式复用率 < ${threshold}%，打回 EXECUTE 重写`) +
        (tail ? `\n${tail}` : ''),
    },
  ]
}

/**
 * test:static/eslint-ratchet：已废弃（2026-09-10）。
 * 改为 eslint 对 changed-files 使用 --no-ignore 直接检查，基线命中不再单独拦。
 * 旧 suite registry 若仍含本 case → 一律 passed + advisory，避免误伤门禁。
 */
export function runEslintRatchet({ workspaceDir, runDir } = {}) {
  const started = Date.now()
  return {
    caseKey: 'test:static/eslint-ratchet',
    status: 'passed',
    durationMs: Math.max(0, Date.now() - started),
    detail: 'skipped: ratchet 已废弃；eslint --no-ignore 检查本任务改动文件',
  }
}

/**
 * test:static/vitest：跑 worker 注入的 unit 类测试资产（input/test-specs/unit/）。
 *
 * 真执行协议：
 *  - 平台自有 vitest 配置（不继承业务仓配置），JSON reporter 落报告文件
 *  - 判定看报告里的用例计数，不看退出码了事：
 *      0 发现 / 0 执行（全 skip）/ 报告缺失 / 超时被杀 → error（不可当通过）
 *      有用例失败 → failed；有用例真的执行且全过 → passed
 *  - 每条资产回传 execution（total/passed/failed/skipped），门禁据此核对"真的跑了"
 * 无 unit 资产 → passed + execution.reason=no-unit-assets（该仓没有单测资产，不是执行失败）
 * 体量不再决定是否执行：S 级同样跑（"没有可执行资产" ≠ "体量小所以跳过"）
 */
function runVitestSpecs({ workspaceDir, runDir }) {
  const unitDir = runDir ? join(runDir, 'input', 'test-specs', 'unit') : null
  if (!unitDir || !existsSync(join(unitDir, 'manifest.json'))) {
    return vitestSkipped('no-unit-assets', 'skipped: no unit specs')
  }
  // 容忍 UTF-8 BOM（Windows 工具链可能添加）
  const manifestRaw = readFileSync(join(unitDir, 'manifest.json'), 'utf8').replace(/^﻿/, '')
  let manifest
  try {
    manifest = JSON.parse(manifestRaw)
  } catch (err) {
    return vitestSkipped('manifest-invalid', `skipped: unit manifest 解析失败（${err.message}）`)
  }
  const specs = Array.isArray(manifest.specs) ? manifest.specs : []
  if (!specs.length) return vitestSkipped('no-unit-assets', 'skipped: no unit specs')
  const vitestBin = join(workspaceDir, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitestBin)) {
    return [{
      caseKey: 'test:static/vitest',
      status: 'error',
      durationMs: 0,
      detail: 'VITEST_UNAVAILABLE: 业务仓未安装 vitest（需先加 devDependency 并提交 lock）',
      execution: { verified: false, reason: 'vitest-unavailable', specs: [], totals: zeroUnitTotals() },
    }]
  }
  const stagingDir = join(workspaceDir, UNIT_STAGING_DIR)
  mkdirSync(stagingDir, { recursive: true })
  const startedAll = Date.now()
  try {
    const configPath = writePlatformVitestConfig(stagingDir, workspaceDir)
    const checks = []
    const evidence = []
    for (const s of specs) {
      const featureKey = String(s.featureKey || '')
      const entry = String(s.entry || '')
      const caseKey = `test:unit-spec/${featureKey}`
      if (!entry || !existsSync(join(unitDir, entry))) {
        checks.push({
          caseKey,
          status: 'error',
          durationMs: 0,
          detail: `UNIT_SPEC_MISSING: ${entry || '(empty entry)'} 不在注入目录中`,
          execution: { verified: false, reason: 'spec-missing', totals: zeroUnitTotals() },
        })
        evidence.push({ featureKey, entry, status: 'error', reason: 'spec-missing', ...zeroUnitTotals() })
        continue
      }
      copyFileSync(join(unitDir, entry), join(stagingDir, entry))
      const started = Date.now()
      const reportPath = join(stagingDir, `report-${featureKey.replace(/[^\w.-]+/g, '_') || 'spec'}.json`)
      rmSync(reportPath, { force: true })
      const r = spawnSync(
        process.execPath,
        [vitestBin, 'run', '--config', configPath, '--reporter=json', `--outputFile=${reportPath}`, `${UNIT_STAGING_DIR}/${entry}`],
        { cwd: workspaceDir, encoding: 'utf8', timeout: VITEST_TIMEOUT_MS },
      )
      const report = readVitestReport(reportPath)
      const verdict = judgeVitestRun({ exitCode: r.status, signal: r.signal, report })
      const stats = verdict.stats || zeroUnitTotals()
      const check = {
        caseKey,
        status: verdict.status,
        durationMs: Math.max(0, Date.now() - started),
        title: `单测资产《${featureKey}》`,
        expected: '注入的 unit 测试全部执行且通过',
        actual:
          verdict.status === 'passed'
            ? `通过（total=${stats.total}）`
            : verdict.reason || null,
        execution: {
          verified: verdict.status === 'passed',
          reason: verdict.reason,
          spec: entry,
          ...stats,
        },
      }
      check.detail = vitestDetail({ verdict, stats, entry, report, stdout: r.stdout, stderr: r.stderr })
      checks.push(check)
      evidence.push({ featureKey, entry, status: verdict.status, reason: verdict.reason, ...stats })
    }
    const totals = evidence.reduce((acc, e) => ({
      total: acc.total + e.total,
      passed: acc.passed + e.passed,
      failed: acc.failed + e.failed,
      skipped: acc.skipped + e.skipped,
      executed: acc.executed + e.executed,
    }), zeroUnitTotals())
    const status = checks.some((c) => c.status === 'error')
      ? 'error'
      : checks.some((c) => c.status === 'failed')
        ? 'failed'
        : 'passed'
    // 聚合 check：门禁按它核对每条资产的执行证据（缺证据/未执行一律 blocking）
    const aggregate = {
      caseKey: 'test:static/vitest',
      status,
      durationMs: Math.max(0, Date.now() - startedAll),
      title: `单测资产聚合（${specs.length} 条）`,
      expected: '全部 unit 资产执行且通过',
      actual: `total=${totals.total} passed=${totals.passed} failed=${totals.failed} skipped=${totals.skipped}`,
      detail:
        `unit 资产 ${specs.length} 个：用例 total=${totals.total} passed=${totals.passed} ` +
        `failed=${totals.failed} skipped=${totals.skipped}`,
      execution: { verified: status === 'passed', reason: status === 'passed' ? null : 'spec-failed', specs: evidence, totals },
    }
    return [aggregate, ...checks]
  } finally {
    rmSync(stagingDir, { recursive: true, force: true })
  }
}

/**
 * 平台持有 vitest 配置：写进 staging 目录，不继承业务仓配置。
 * 目的：注入资产的执行口径由平台决定（root=业务仓、仅收 staging 内 spec、node 环境），
 * 业务仓改 vitest.config 无法影响考卷是否真的跑、跑出什么。
 * 契约：unit 资产须自包含（vitest + 相对路径 import），不依赖业务仓别名/插件。
 */
function writePlatformVitestConfig(stagingDir, workspaceDir) {
  const cfg = [
    '// 平台持有（guest 生成）：单测资产的执行口径，禁止复用为业务仓配置',
    'export default {',
    `  root: ${JSON.stringify(workspaceDir.replace(/\\/g, '/'))},`,
    '  test: {',
    `    include: [${JSON.stringify(`${UNIT_STAGING_DIR}/**/*.spec.mjs`)}],`,
    "    environment: 'node',",
    '    passWithNoTests: false,',
    '    testTimeout: 30000,',
    '    hookTimeout: 30000,',
    '  },',
    '}',
    '',
  ].join('\n')
  const configPath = join(stagingDir, 'vitest.config.mjs')
  writeFileSync(configPath, cfg, 'utf8')
  return configPath
}

function readVitestReport(reportPath) {
  if (!existsSync(reportPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 从 vitest JSON 报告抽用例计数与失败断言（报告缺失返回零计数） */
export function summarizeVitestReport(report) {
  if (!report) return zeroUnitTotals()
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const files = Array.isArray(report.testResults) ? report.testResults : []
  const passed = num(report.numPassedTests)
  const failed = num(report.numFailedTests)
  return {
    total: num(report.numTotalTests),
    passed,
    failed,
    skipped: num(report.numPendingTests) + num(report.numTodoTests),
    executed: passed + failed,
    files: files.length,
  }
}

/** 失败断言摘要（最多 5 条，带测试名与首条 failureMessage） */
export function collectVitestFailures(report, limit = 5) {
  const out = []
  for (const f of (report?.testResults || [])) {
    for (const a of (f.assertionResults || [])) {
      if (a.status !== 'failed') continue
      out.push({
        title: a.fullName || a.title || '(unnamed)',
        message: String((a.failureMessages || [])[0] || '').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 700),
      })
      if (out.length >= limit) return out
    }
  }
  return out
}

/**
 * 判定单条 unit 资产是否真的跑过（纯函数，供单测）：
 * 判据顺序 = 先证明"跑了"，再判"过了没"。任何无法证明执行的形态都不得 passed。
 */
export function judgeVitestRun({ exitCode, signal = null, report = null }) {
  const stats = summarizeVitestReport(report)
  if (exitCode === null || signal) return { status: 'error', reason: 'vitest-timeout-or-killed', stats }
  if (!report) return { status: 'error', reason: 'vitest-report-missing', stats }
  if (stats.total === 0) return { status: 'error', reason: 'no-tests-discovered', stats }
  if (stats.executed === 0) return { status: 'error', reason: 'all-tests-skipped', stats }
  if (stats.failed > 0 || report.success === false) return { status: 'failed', reason: 'assertion-failed', stats }
  if (exitCode !== 0) return { status: 'error', reason: `vitest-exit-${exitCode}`, stats }
  return { status: 'passed', reason: null, stats }
}

function vitestDetail({ verdict, stats, entry, report = null, stdout, stderr }) {
  if (verdict.status === 'passed') {
    return `${entry}: 执行 ${stats.executed} 用例（passed=${stats.passed} skipped=${stats.skipped}）`
  }
  const head = `${entry}: ${verdict.reason}（total=${stats.total} passed=${stats.passed} failed=${stats.failed} skipped=${stats.skipped}）`
  if (verdict.reason === 'assertion-failed') {
    const failures = collectVitestFailures(report)
    const lines = failures.map((f) => `✗ ${f.title}\n${f.message}`)
    return [head, ...lines].join('\n').slice(0, 1200)
  }
  const tail = `${stdout || ''}\n${stderr || ''}`.split(/\r?\n/).filter((l) => l.trim()).slice(-10).join(' | ')
  return tail ? `${head}\n${tail}`.slice(0, 1200) : head
}

function runCase(caseKey, workspaceDir, runDir = null) {
  const check = String(caseKey).split(':').slice(1).join(':') || String(caseKey)
  if (check === 'static/hard-rules') {
    return walkHasEval(workspaceDir) ? { status: 'failed', detail: 'eval() usage found' } : { status: 'passed' }
  }
  if (check === 'static/eslint') {
    return runEslintReadonly(workspaceDir, runDir)
  }
  return { status: 'error', detail: `unknown case ${caseKey}` }
}

/** 从 host 注入的 changed-files.json 读本任务改动清单，过滤为可 lint 的源文件 */
export function loadLintableChangedFiles(workspaceDir, runDir) {
  const manifestPath = runDir ? join(runDir, 'input', 'changed-files.json') : null
  if (!manifestPath || !existsSync(manifestPath)) return { files: [], reason: 'no changed-files manifest' }
  let changedFiles
  try {
    changedFiles = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''))
  } catch (err) {
    return { files: null, reason: `changed-files.json parse failed: ${err.message}` }
  }
  if (!Array.isArray(changedFiles)) return { files: null, reason: 'changed-files.json not array' }
  const lintable = []
  for (const raw of changedFiles) {
    const rel = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()
    if (!rel) continue
    if (!/\.(vue|js|jsx|cjs|mjs)$/i.test(rel)) continue
    if (existsSync(join(workspaceDir, rel))) lintable.push(rel)
  }
  return { files: [...new Set(lintable)].sort(), reason: lintable.length ? null : 'no lintable changed files' }
}

/**
 * 只 lint 本次任务改动文件；历史存量一律不扫。
 * 无 changed-files / 无 lintable 文件 → passed + skipped（不全仓扫，避免历史违规误伤）。
 */
function runEslintReadonly(workspaceDir, runDir = null) {
  const { files, reason } = loadLintableChangedFiles(workspaceDir, runDir)
  if (files === null) {
    return { status: 'error', detail: `CHANGED_FILES_INVALID: ${reason}` }
  }
  if (!files.length) {
    return { status: 'passed', detail: `skipped: ${reason || 'no changed files'}（eslint 仅检查本任务改动）` }
  }
  const extra = eslintArgs(files)
  if (extra.includes('--fix')) return { status: 'failed', detail: '--fix is not allowed in readonly lint' }
  const eslintJs = join(workspaceDir, 'node_modules', 'eslint', 'bin', 'eslint.js')
  if (existsSync(eslintJs)) {
    const r = spawnSync(process.execPath, [eslintJs, ...extra], {
      cwd: workspaceDir,
      encoding: 'utf8',
      timeout: STATIC_TIMEOUT_MS,
    })
    if (r.status === 0) return { status: 'passed', detail: `linted ${files.length} changed file(s)` }
    const lines = String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim())
    const problems = lines.filter((l) => /\serror\s|\swarning\s/.test(l) || /^[A-Za-z]:\\/.test(l)).slice(0, 14)
    const summary = lines.filter((l) => /problem/i.test(l)).slice(-1)
    const detail = [
      ...problems,
      `changed=${files.length}`,
      ...summary,
    ].filter(Boolean).join(' | ').slice(0, 900)
    return { status: 'failed', detail: detail || `eslint exit=${r.status} (no parsable output)` }
  }
  for (const rel of files) {
    const r = spawnSync(process.execPath, ['--check', join(workspaceDir, rel)], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) return { status: 'failed', detail: `syntax error: ${rel}` }
  }
  return { status: 'passed', detail: `syntax-checked ${files.length} changed file(s)` }
}

function walkHasEval(dir) {
  for (const file of listJs(dir)) {
    const text = readFileSync(file, 'utf8')
    if (text.includes('eval(')) return true
  }
  return false
}

function listJs(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) listJs(p, acc)
    else if (/\.(js|mjs|cjs)$/.test(name)) acc.push(p)
  }
  return acc
}
