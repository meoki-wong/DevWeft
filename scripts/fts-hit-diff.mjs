#!/usr/bin/env node
/**
 * fts-hit-diff.mjs — 方案第 7 节：全文检索命中集合差集报告（§13.1）
 *
 * 行为：
 *   1. 只读连接切换前的 team.db（FTS5）与导入后的 PostgreSQL（pg_trgm ILIKE）
 *   2. 关键词：脚本参数传入的列表；未传时使用 border-radius / Empty / verify，
 *      并在报告中写明这是默认词、不是生产语料的全集
 *   3. 对 docs 与 experiences 分别输出旧引擎命中 id 集合与新引擎命中 id 集合的差集
 *   4. 报告写入 docs/fts-hit-diff-report.md；差集非空仍以退出码 0 结束，
 *      但报告第一节必须是「差集非空」；差集为空则第一节写「差集为空」
 *   5. 无法连接任一侧 → 退出码 1
 *   6. 不断言排序与 bm25
 *
 * 用法：node scripts/fts-hit-diff.mjs [--db data/team.db] [--pg-url postgresql://...] [关键词...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}
const DB_PATH = path.resolve(arg('db', path.join(root, 'data', 'team.db')))
const PG_URL = process.env.AWP_PG_URL || arg('pg-url', null)
// 关键词：位置参数；跳过 flag 及其值；支持逗号分隔
const FLAG_WITH_VALUE = new Set(['--db', '--pg-url', '--keywords'])
const rawKeywords = []
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith('--')) {
    if (FLAG_WITH_VALUE.has(a)) i++ // 跳过 flag 的值
    continue
  }
  rawKeywords.push(a)
}
const keywords = rawKeywords.flatMap((k) => k.split(',').map((s) => s.trim()).filter(Boolean))
const USING_DEFAULT_KEYWORDS = keywords.length === 0
if (USING_DEFAULT_KEYWORDS) keywords.push('border-radius', 'Empty', 'verify')

if (!fs.existsSync(DB_PATH)) {
  console.error(`[fts-diff] 无法连接 SQLite 源库 ${DB_PATH}`)
  process.exit(1)
}
if (!PG_URL) {
  console.error('[fts-diff] 无法连接 PostgreSQL：需要 --pg-url 或 AWP_PG_URL')
  process.exit(1)
}

const { default: Database } = await import('better-sqlite3')
const { createPostgresHandle } = await import('../db/postgres-driver.mjs')

let sqlite, pg
try {
  sqlite = new Database(DB_PATH, { readonly: true, fileMustExist: true })
} catch (e) {
  console.error(`[fts-diff] 无法连接 SQLite：${e.message}`)
  process.exit(1)
}
try {
  pg = await createPostgresHandle({ connectionString: PG_URL })
} catch (e) {
  console.error(`[fts-diff] 无法连接 PostgreSQL：${e.message}`)
  process.exit(1)
}

const ftsEscape = (kw) => `"${String(kw).replace(/"/g, '""')}"`

function oldHits(table, keyword) {
  if (table === 'docs') {
    return sqlite
      .prepare(
        `SELECT d.id FROM docs d JOIN docs_fts f ON d.rowid = f.rowid WHERE docs_fts MATCH ?`
      )
      .all(ftsEscape(keyword))
      .map((r) => String(r.id))
  }
  return sqlite
    .prepare(
      `SELECT e.id FROM experiences e JOIN experiences_fts f ON e.rowid = f.rowid WHERE experiences_fts MATCH ?`
    )
    .all(ftsEscape(keyword))
    .map((r) => String(r.id))
}

async function newHits(table, keyword) {
  const like = `%${keyword}%`
  if (table === 'docs') {
    const r = await pg
      .prepare('SELECT id FROM docs WHERE content ILIKE $1 OR name ILIKE $1 OR category ILIKE $1')
      .all(like)
    return r.map((x) => String(x.id))
  }
  const r = await pg
    .prepare('SELECT id FROM experiences WHERE content ILIKE $1 OR module ILIKE $1 OR tags ILIKE $1')
    .all(like)
  return r.map((x) => String(x.id))
}

let anyDiff = false
const lines = []
// 第一节必须是差集结论（§13.1：非空/为空）
lines.push('# 差集结论', '', anyDiff ? '差集非空' : '差集为空', '')
lines.push('# docs/fts-hit-diff-report.md — 全文检索命中集合差集（方案 §13.1）')
lines.push('')
lines.push(`- 生成时间：${new Date().toISOString()}`)
lines.push(`- SQLite 源：${DB_PATH}（FTS5 trigram）`)
lines.push(`- PostgreSQL：${PG_URL.replace(/\/\/.*@/, '//***@')}（pg_trgm ILIKE）`)
lines.push(
  USING_DEFAULT_KEYWORDS
    ? '- 关键词：**默认词** border-radius / Empty / verify（这是默认词，不是生产语料的全集，§13.1）'
    : `- 关键词（脚本参数）：${keywords.join(' / ')}`
)
lines.push('')

for (const table of ['docs', 'experiences']) {
  lines.push(`## ${table}`)
  for (const kw of keywords) {
    const oldSet = new Set(oldHits(table, kw))
    const newSet = new Set(await newHits(table, kw))
    const onlyOld = [...oldSet].filter((x) => !newSet.has(x))
    const onlyNew = [...newSet].filter((x) => !oldSet.has(x))
    if (onlyOld.length || onlyNew.length) anyDiff = true
    lines.push(`- 关键词「${kw}」：旧引擎 ${oldSet.size} 命中 / 新引擎 ${newSet.size} 命中`)
    lines.push(`  - 仅旧引擎：${onlyOld.length ? onlyOld.slice(0, 50).join(', ') : '（无）'}${onlyOld.length > 50 ? ` …共 ${onlyOld.length}` : ''}`)
    lines.push(`  - 仅新引擎：${onlyNew.length ? onlyNew.slice(0, 50).join(', ') : '（无）'}${onlyNew.length > 50 ? ` …共 ${onlyNew.length}` : ''}`)
  }
  lines.push('')
}

fs.writeFileSync(path.join(root, 'docs', 'fts-hit-diff-report.md'), lines.join('\n'))
console.log(`[fts-diff] 报告已写入 docs/fts-hit-diff-report.md（${anyDiff ? '差集非空' : '差集为空'}）`)

sqlite.close()
await pg.close()
process.exit(0)
