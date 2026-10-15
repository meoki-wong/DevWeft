#!/usr/bin/env node
/**
 * converge-async.mjs — 第 7 节 await 化收敛循环
 *
 * 迭代：提取（生产运行文件 + 测试 helper）的 async 导出名单 → 对生产文件与全部测试文件
 * 跑 codemod --await-names → 直到一轮内没有任何文件再变化（或达到上限）。
 * 生产文件集合见 PROD；历史迁移路径（testing/migrate.js、migrate-v31.js、harness/migrate.js、
 * audit/migrate.js、secret-broker/**、schema-*.sql）永不进入转换。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as acorn from 'acorn'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const CODEMOD = path.join(root, 'scripts', 'codemod-async-db.mjs')

const prod = fs.readFileSync(path.join(root, 'tmp-batch3.txt'), 'utf8').split(/\s+/).filter(Boolean)
  .concat([
    'harness/state-machine.js', 'harness/loop.js', 'harness/task-store.js', 'harness/guards.js',
    'harness/testing-gate.js', 'harness/gate-policy.js', 'harness/session-guard.js', 'harness/stop-task.js',
    'harness/delivery.js', 'harness/attachments.js', 'harness/tenant-ref.js', 'harness/repo-acl.js',
    'harness/transition-evaluator.js', 'harness/bootstrap-instructions.js',
    'db/id-sequence.js',
    'tools/collaboration.js', 'tools/knowledge.js', 'tools/loop.js', 'tools/records.js',
    'tools/test-run.js', 'tools/test-specs.js',
    'server.js',
    'dashboard/api.js', 'dashboard/testing.js', 'dashboard/testing-read-model.js', 'dashboard/health.js',
    'audit/index.js', 'audit/routes.js',
  ])

// 历史迁移路径：只提取名单（ensureTenantRepo 等），绝不进 codemod 转换
const extractOnly = ['testing/migrate.js']

const helpers = ['test/helpers/memdb.mjs', 'test/helpers/cas-worker.mjs', 'test/helpers/submission-chain.mjs']
  .filter((f) => fs.existsSync(path.join(root, f)))
const tests = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).map((f) => `test/${f}`)

function extractAsyncExports(file) {
  const names = new Set()
  let ast
  try {
    ast = acorn.parse(fs.readFileSync(path.join(root, file), 'utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  } catch {
    return names
  }
  const walk = (n, v) => {
    if (!n || typeof n.type !== 'string') return
    v(n)
    for (const k of Object.keys(n)) {
      if (['parent', 'loc', 'range', 'start', 'end'].includes(k)) continue
      const c = n[k]
      if (Array.isArray(c)) c.forEach((x) => { if (x && typeof x.type === 'string') { x.parent = n; walk(x, v) } })
      else if (c && typeof c.type === 'string') { c.parent = n; walk(c, v) }
    }
  }
  walk(ast, (n) => {
    if (n.type === 'ExportNamedDeclaration' && n.declaration) {
      const d = n.declaration
      if (d.type === 'FunctionDeclaration' && d.async && d.id) names.add(d.id.name)
      if (d.type === 'VariableDeclaration') d.declarations.forEach((x) => { if (x.init && x.init.async && x.id.type === 'Identifier') names.add(x.id.name) })
    }
  })
  return names
}

let allNames = new Set()
for (let round = 1; round <= 5; round++) {
  for (const f of [...prod, ...helpers, ...extractOnly]) {
    for (const n of extractAsyncExports(f)) allNames.add(n)
  }
  const namesArg = [...allNames].join(',')
  let changed = 0
  const run = (files) => {
    if (!files.length) return
    const out = execFileSync(process.execPath, [CODEMOD, '--await-names', namesArg, ...files], { encoding: 'utf8' })
    changed += (out.match(/codemod:/g) || []).length
    const fails = out.match(/FAILED:.*/g) || []
    for (const f of fails) console.error(f)
  }
  run(prod)
  run(helpers)
  run(tests)
  console.log(`round ${round}: async 名单 ${allNames.size} 个, 变更文件 ${changed}`)
  if (changed === 0) break
}
fs.writeFileSync(path.join(root, 'tmp-async-names-final.txt'), [...allNames].join(','))
console.log('converged')
