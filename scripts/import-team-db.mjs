#!/usr/bin/env node
/**
 * import-team-db.mjs — 方案第 7 节：SQLite → PostgreSQL 一次性导入
 *
 * 行为（§13.1）：
 *   1. 只读打开切换前的 data/team.db
 *   2. 目标 PostgreSQL 先执行 sql/postgres/baseline.sql（幂等要求空库；不重放任何 SQLite 迁移）
 *   3. 按外键拓扑序逐表导入；布尔 0/1 → false/true；时间列保持 TEXT ISO
 *   4. 比较每张表的行数；tasks 额外比较 (tenant_id, task_id) 集合
 *   5. 全部一致 → 登记 schema_migrations postgres_baseline（版本按账本推导，见
 *      db/postgres-baseline.js）并以退出码 0 结束；任何不一致 → 退出码 1
 *      （此时不要把 AWP_DB_DIALECT 设为 postgres）
 *
 * 用法：
 *   node scripts/import-team-db.mjs [--db data/team.db] [--pg-url postgresql://...] [--truncate]
 *   （测试可传 --pglite <目录> 以 PGlite 作为目标；生产必须用真 PostgreSQL）
 * 导入前必须停止业务进程（停写窗口，§13.2）；secret-broker 不参与导入。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPostgresHandle } from '../db/postgres-driver.mjs'
import { ensurePostgresBaselineRegistered } from '../db/postgres-baseline.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const DB_PATH = path.resolve(arg('db', path.join(root, 'data', 'team.db')))
const PG_URL = process.env.AWP_PG_URL || arg('pg-url', null)
const PGLITE_DIR = arg('pglite', null) // 测试用：PGlite 数据目录替代真 PG
const TRUNCATE = process.argv.includes('--truncate')
const BASELINE = path.join(root, 'sql', 'postgres', 'baseline.sql')

if (!fs.existsSync(DB_PATH)) {
  console.error(`[import] 未找到 SQLite 源库 ${DB_PATH}`)
  process.exit(1)
}
if (!PG_URL && !PGLITE_DIR) {
  console.error('[import] 需要 --pg-url / AWP_PG_URL（生产）或 --pglite <目录>（测试）')
  process.exit(1)
}

const { default: Database } = await import('better-sqlite3')
const src = new Database(DB_PATH, { readonly: true, fileMustExist: true })
console.log(`[import] 源库（只读）: ${DB_PATH}`)
console.log('[import] 确认业务进程已停止（停写窗口）——本脚本不做进程检查')

let pg
if (PGLITE_DIR) {
  const { PGlite } = await import('@electric-sql/pglite')
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm')
  const pglite = new PGlite(PGLITE_DIR, { extensions: { pg_trgm } })
  pg = await createPostgresHandle({ poolLike: pglite })
  console.log(`[import] 目标 PGlite 已连接: ${PGLITE_DIR}`)
} else {
  pg = await createPostgresHandle({ connectionString: PG_URL })
  console.log('[import] 目标 PostgreSQL 已连接')
}

// 布尔语义列：应用层写 0/1，PG 侧为 SMALLINT（与 sqlite 同构），导入原样透传、不转 true/false
const BOOLEAN_COLUMNS = new Set([])

// 1) 基线
console.log('[import] 执行 sql/postgres/baseline.sql …')
await pg.exec(fs.readFileSync(BASELINE, 'utf8'))
console.log('[import] 基线完成')

// 2) 表清单与拓扑序（直接沿用 SQLite 源库的 sqlite_master）
//    只导入 PG 基线存在的表：sqlite 侧多出的 evolver/ev2 域表（约 48 张，含 evolver_journal
//    38.9 万行）由 evolver 子系统自带存储，本次不迁（§17 范围外）
const pgTables = new Set(
  (
    await pg
      .prepare(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)
      .all()
  ).map((r) => r.table_name)
)
const allSqliteTables = src
  .prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
     ORDER BY name`
  )
  .all()
  .map((r) => r.name)
const tables = allSqliteTables.filter((t) => pgTables.has(t))
const skippedTables = allSqliteTables.filter((t) => !pgTables.has(t))
if (skippedTables.length) {
  console.log(`[import] 跳过 PG 基线不存在的表（${skippedTables.length} 张，不迁移）: ${skippedTables.join(', ')}`)
}

{
  const deps = new Map(tables.map((t) => [t, new Set()]))
  for (const t of tables) {
    const fks = src.prepare('PRAGMA foreign_key_list(' + t + ')').all()
    for (const fk of fks) if (fk.table !== t && tables.includes(fk.table)) deps.get(t).add(fk.table)
  }
  const ordered = []
  const state = new Map()
  const visit = (name) => {
    if (state.get(name) === 2) return
    if (state.get(name) === 1) throw new Error('外键循环依赖: ' + name)
    state.set(name, 1)
    for (const d of deps.get(name)) visit(d)
    state.set(name, 2)
    ordered.push(name)
  }
  for (const t of tables) visit(t)
  tables.length = 0
  tables.push(...ordered)
}

if (TRUNCATE) {
  await pg.exec('BEGIN')
  for (const t of [...tables].reverse()) {
    await pg.prepare(`TRUNCATE TABLE ${t} CASCADE`).run()
  }
  await pg.exec('COMMIT')
  console.log('[import] 已清空目标表（--truncate）')
}

// 3) 逐表导入（单表单事务；时间列 TEXT 原样；布尔 0/1 → false/true；每 200 行批量 INSERT）
//    列取 sqlite∩PG 交集：生产库可能存在历史漂移列（当前代码不认），跳过并记日志
const BATCH_SIZE = 200
const countReport = []
for (const t of tables) {
  const cols = src.prepare(`PRAGMA table_info(${t})`).all()
  if (!cols.length) {
    console.warn(`[import] 跳过空定义表 ${t}`)
    continue
  }
  const pgColRows = await pg
    .prepare(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`)
    .all(t)
  const pgCols = new Set(pgColRows.map((r) => r.column_name))
  const matched = cols.filter((c) => pgCols.has(c.name))
  const skippedCols = cols.filter((c) => !pgCols.has(c.name)).map((c) => c.name)
  if (skippedCols.length) {
    console.warn(`[import] ${t} 跳过 PG 无此列（历史漂移）: ${skippedCols.join(', ')}`)
  }
  if (!matched.length) {
    console.warn(`[import] 跳过无交集列的表 ${t}`)
    continue
  }
  const colNames = matched.map((c) => c.name)
  const boolIdx = new Set(matched.map((c, i) => (BOOLEAN_COLUMNS.has(`${t}.${c.name}`) ? i : -1)).filter((i) => i >= 0))

  const rows = src.prepare(`SELECT ${colNames.map((c) => `"${c}"`).join(', ')} FROM ${t}`).all()
  await pg.exec('BEGIN')
  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE)
      const params = []
      const valueRows = batch.map((row) => {
        const ph = colNames.map((c, j) => {
          const raw = row[c]
          if (boolIdx.has(j)) params.push(raw === 1 || raw === true ? true : raw === 0 || raw === false ? false : raw)
          else params.push(raw)
          return `$${params.length}`
        })
        return `(${ph.join(', ')})`
      })
      const insertSql = `INSERT INTO ${t} (${colNames.join(', ')}) VALUES ${valueRows.join(', ')}`
      await pg.prepare(insertSql).run(...params)
    }
    await pg.exec('COMMIT')
  } catch (e) {
    await pg.exec('ROLLBACK')
    console.error(`[import] 表 ${t} 导入失败: ${e.message}`)
    process.exit(1)
  }
  countReport.push({ table: t, source: rows.length })
  console.log(`[import] ${t}: ${rows.length} 行`)
}

// 4) 行数对账
let mismatch = 0
for (const { table, source } of countReport) {
  const dest = (await pg.prepare(`SELECT COUNT(*) c FROM ${table}`).get()).c
  if (Number(dest) !== Number(source)) {
    console.error(`[import] 行数不一致 ${table}: sqlite=${source} pg=${dest}`)
    mismatch++
  }
}

// 5) tasks (tenant_id, task_id) 集合对账
{
  const srcSet = new Set(
    src.prepare('SELECT tenant_id, task_id FROM tasks').all().map((r) => `${r.tenant_id}|${r.task_id}`)
  )
  const dstRows = await pg.prepare('SELECT tenant_id, task_id FROM tasks').all()
  const dstSet = new Set(dstRows.map((r) => `${r.tenant_id}|${r.task_id}`))
  let diff = 0
  for (const k of srcSet) if (!dstSet.has(k)) { console.error(`[import] 缺失: tasks(${k})`); diff++ }
  for (const k of dstSet) if (!srcSet.has(k)) { console.error(`[import] 多余: tasks(${k})`); diff++ }
  if (diff) mismatch++
}

// 5.5) 同步 IDENTITY 序列（导入写入了显式 id，序列必须越过 max(id)，否则后续 INSERT 撞主键）
{
  const identCols = await pg
    .prepare(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema='public' AND is_identity='YES'`
    )
    .all()
  for (const { table_name: t, column_name: c } of identCols) {
    await pg
      .exec(`SELECT setval(pg_get_serial_sequence('${t}', '${c}'), COALESCE((SELECT MAX(${c}) FROM ${t}), 0) + 1, false)`)
    console.log(`[import] IDENTITY 序列已同步: ${t}.${c}`)
  }
}

// 6) postgres_baseline 登记（口径复用 db/postgres-baseline.js，与 openDb() 完全一致）
if (mismatch === 0) {
  const reg = await ensurePostgresBaselineRegistered(pg)
  console.log(`[import] 对账全部一致；postgres_baseline 已登记（v${reg.version}，${reg.action}）`)
  console.log('[import] 现在才允许把 AWP_DB_DIALECT 设为 postgres 并重启业务进程')
} else {
  console.error(`[import] 对账存在 ${mismatch} 处不一致 —— 禁止把方言改为 postgres`)
}

src.close()
await pg.close()
process.exit(mismatch === 0 ? 0 : 1)
