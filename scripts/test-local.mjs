/**
 * scripts/test-local.mjs — 本地测试统一入口（阶段 4 / T4.5）
 *
 * 分层执行平台测试，mode 白名单，结果汇总 + 非零退出码：
 *   node scripts/test-local.mjs unit         # 纯规则/决策函数
 *   node scripts/test-local.mjs integration  # SQLite/HTTP 集成
 *   node scripts/test-local.mjs scenarios    # 业务闭环场景
 *   node scripts/test-local.mjs all          # 全量（默认）
 *
 * 不访问远端、不启动生产服务；真实浏览器层（e2e/platform）另行运行。
 */
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mode = (process.argv[2] || 'all').toLowerCase()
const MODES = new Set(['unit', 'integration', 'scenarios', 'all'])
if (!MODES.has(mode)) {
  console.error(`未知 mode：${mode}（可用：${[...MODES].join(' / ')}）`)
  process.exit(1)
}

const SUITES = {
  unit: [
    'test/gate-verdicts.test.mjs',
    'test/coverage-complete.test.mjs',
    'test/mutation-experience.test.mjs',
    'test/platform-settings.test.mjs',
    'test/helpers/memdb.test.mjs',
    'test/guest-mutation.test.mjs',
  ],
  integration: [
    'test/platform-integrity.test.mjs',
    'test/testing-artifacts.test.mjs',
    'test/server-api.test.mjs',
    'test/api-contract.test.mjs',
    'test/f2p-gate.test.mjs',
    'test/gate-loop.test.mjs',
  ],
  scenarios: [
    'test/scenarios.test.mjs',
  ],
}

const files = mode === 'all' ? [...SUITES.unit, ...SUITES.integration, ...SUITES.scenarios] : SUITES[mode]
const runId = `run-${Date.now()}`
const outDir = mkdtempSync(join(tmpdir(), `awp-testlocal-${runId}-`))
console.log(`[test-local] mode=${mode} runId=${runId}`)
console.log(`[test-local] files=${files.length} resultsDir=${outDir}`)

const started = Date.now()
const child = spawnSync('npx', ['vitest', 'run', '--reporter=basic', ...files], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
const duration = Date.now() - started
const summary = { runId, mode, files, exitCode: child.status, durationMs: duration }
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(`[test-local] exit=${child.status} duration=${duration}ms`)
if (child.status !== 0) {
  process.exit(child.status ?? 1)
} else {
  try { rmSync(outDir, { recursive: true, force: true }) } catch { /* 保留失败现场 */ }
}
