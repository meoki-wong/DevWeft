// 仅 sqlite（方案 §2.8/§7）：直接打开 data/team.db 的离线/运维工具，未做 postgres 方言迁移；
// PG 切换后如需使用，先改造为 openDb() 句柄。
/**
 * export-fixtures.mjs — 真实形态测试数据导出（阶段 3 / T3.1，一次性脚本）
 *
 * 用法：node scripts/export-fixtures.mjs [--out test/fixtures/real]
 *
 * 从 data/team.db 只读导出生产数据形态（不是业务数据本身）作为测试 fixture：
 *   - formal passed / formal failed / mutation 三种 run 的 report_json
 *   - 一条非平凡 run_attempts.steps_json（worker 侧分步时间线）
 *   - 一个含 assetLock 的 canonical_binding_json
 * 脱敏：key 命中 /token|secret|password|authorization|cookie/i 的值替换为 [REDACTED]。
 * 输出结构仅保留字段形状与统计信息，断言用的 fixture 保持与生产完全同构。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'test/fixtures/real')
mkdirSync(outDir, { recursive: true })

const SECRET_KEY = /token|secret|password|authorization|cookie|apikey|api_key/i
function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redact(v)
    }
    return out
  }
  return value
}

const db = new Database(join(root, 'data', 'team.db'), { readonly: true, fileMustExist: true })

function pickRun(kind) {
  const where = kind === 'mutation'
    ? `purpose = 'mutation'`
    : `purpose = 'gate' AND status = '${kind}'`
  const row = db.prepare(
    `SELECT run_id, purpose, status, report_json, created_at FROM test_runs
     WHERE report_json IS NOT NULL AND ${where} ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (!row || !row.report_json) return null
  const report = JSON.parse(row.report_json)
  return { ...row, report }
}

// 三种 report 形态
for (const kind of ['passed', 'failed', 'mutation']) {
  const r = pickRun(kind)
  if (!r) { console.log(`[fixtures] skip ${kind}: 无可用 run`); continue }
  const doc = {
    _meta: { source: 'production-shape', purpose: r.purpose, status: r.status, exportedAt: new Date().toISOString() },
    report: redact(r.report),
  }
  const file = join(outDir, `report-${kind}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2))
  const checks = r.report.checks || []
  console.log(`[fixtures] report-${kind}.json ← run ${r.run_id.slice(0, 12)} (${checks.length} checks)`)
}

// steps_json（分步时间线，取条数最多的一条）
const steps = db.prepare(
  `SELECT steps_json, run_id FROM run_attempts
   WHERE steps_json IS NOT NULL ORDER BY length(steps_json) DESC LIMIT 1`
).get()
if (steps) {
  const arr = JSON.parse(steps.steps_json)
  writeFileSync(
    join(outDir, 'steps.json'),
    JSON.stringify({ _meta: { source: 'production-shape', count: arr.length }, steps: redact(arr) }, null, 2)
  )
  console.log(`[fixtures] steps.json ← run ${steps.run_id.slice(0, 12)} (${arr.length} 步)`)
} else {
  console.log('[fixtures] skip steps: 无可用 steps_json')
}

// canonical binding（含 assetLock）
const binding = db.prepare(
  `SELECT canonical_binding_json, binding_id FROM test_bindings
   WHERE canonical_binding_json LIKE '%assetLock%' ORDER BY created_at DESC LIMIT 1`
).get()
if (binding) {
  const doc = JSON.parse(binding.canonical_binding_json)
  writeFileSync(
    join(outDir, 'binding.json'),
    JSON.stringify({ _meta: { source: 'production-shape' }, binding: redact(doc) }, null, 2)
  )
  const lockCount = doc.assetLock?.specs?.length ?? 0
  console.log(`[fixtures] binding.json ← binding ${binding.binding_id.slice(0, 12)} (assetLock ${lockCount} 卷)`)
} else {
  console.log('[fixtures] skip binding: 无含 assetLock 的 binding')
}

db.close()
console.log('[fixtures] done →', outDir)
