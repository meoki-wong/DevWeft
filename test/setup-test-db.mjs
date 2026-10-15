/**
 * test/setup-test-db.mjs — 单测数据库隔离（vitest setupFiles，每个 worker 进程执行一次）
 *
 * PG 方言（AWP_DB_DIALECT=postgres）：
 *   global-setup-pg.mjs 已建 awp_test 并设 AWP_PG_URL；此处 openDb() 连过来。
 *
 * sqlite 方言（默认）：
 *   默认（推荐）：empty
 *     - 在项目盘 data/.testdb-tmp/ 建「空文件库」
 *     - 不拷贝生产 team.db（避免 GB 级副本拖垮 C/D 盘）
 *     - db.js import 时 initDB + migrations 会把 schema 建齐；用例自行 seed
 *   显式拷贝真库：AWP_TESTDB_MODE=copy
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const REAL_DB = path.join(root, 'data', 'team.db')
const PROJECT_TMP = path.join(root, 'data', '.testdb-tmp')
const STALE_MS = 2 * 60 * 60 * 1000
const MODE = String(process.env.AWP_TESTDB_MODE || 'empty').toLowerCase()

function pruneStaleTestDbs() {
  const roots = new Set()
  try { roots.add(PROJECT_TMP) } catch { /* ignore */ }
  try { roots.add(os.tmpdir()) } catch { /* ignore */ }
  const now = Date.now()
  for (const base of roots) {
    let names = []
    try { names = fs.readdirSync(base) } catch { continue }
    for (const name of names) {
      if (!name.startsWith('awp-testdb-')) continue
      const full = path.join(base, name)
      try {
        const st = fs.statSync(full)
        if (!st.isDirectory()) continue
        if (globalThis.__awpTestDbPath && String(globalThis.__awpTestDbPath).startsWith(full)) continue
        if (now - st.mtimeMs < STALE_MS) continue
        fs.rmSync(full, { recursive: true, force: true })
      } catch { /* locked → skip */ }
    }
  }
}

function resolveTempRoot() {
  if (process.env.AWP_TESTDB_DIR) {
    try { fs.mkdirSync(process.env.AWP_TESTDB_DIR, { recursive: true }) } catch { /* ignore */ }
    return process.env.AWP_TESTDB_DIR
  }
  try { fs.mkdirSync(PROJECT_TMP, { recursive: true }) } catch { /* ignore */ }
  if (fs.existsSync(path.dirname(REAL_DB))) return PROJECT_TMP
  return os.tmpdir()
}

function registerCleanup(dir) {
  const cleanup = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      cleanup()
      process.exit(1)
    })
  }
}

if (process.env.AWP_DB_DIALECT === 'postgres') {
  // PG 方言：per-worker 建独立测试库并跑 baseline
  const pg = await import('pg')
  const adminUrl = process.env.AWP_PG_URL || 'postgresql://awp@127.0.0.1:5433/awp'
  const base = adminUrl.replace(/\/[^/]+$/, '')
  const workerId = process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID || '0'
  const testDbName = `awp_test_${workerId}`
  const testUrl = `${base}/${testDbName}`

  // 建库
  const adminPool = new pg.default.Pool({ connectionString: `${base}/postgres` })
  await adminPool.query(`DROP DATABASE IF EXISTS ${testDbName}`)
  await adminPool.query(`CREATE DATABASE ${testDbName}`)
  await adminPool.end()

  // 用原生 pool 跑 baseline（去掉 BEGIN/COMMIT——多语句 query() 的隐式事务会吞掉显式 COMMIT）
  const pool = new pg.default.Pool({ connectionString: testUrl })
  const client = await pool.connect()
  try {
    let baselineSql = fs.readFileSync(path.join(root, 'sql', 'postgres', 'baseline.sql'), 'utf8')
    baselineSql = baselineSql.replace(/^\s*BEGIN;\s*$/gm, '').replace(/^\s*COMMIT;\s*$/gm, '')
    await client.query(baselineSql)
    const r = await client.query(`SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema='public'`)
    console.log(`[setup-test-db] PG worker=${workerId} 库=${testDbName} 表数=${r.rows[0].c}`)
  } finally {
    client.release()
  }

  process.env.AWP_PG_URL = testUrl
  const { openDb } = await import('../db.js')
  await openDb()
} else if (!process.env.AWP_DB_PATH) {
  // sqlite 方言：建一次性副本/空库
  if (globalThis.__awpTestDbPath) {
    process.env.AWP_DB_PATH = globalThis.__awpTestDbPath
  } else {
    try { pruneStaleTestDbs() } catch { /* ignore */ }
    const tempRoot = resolveTempRoot()
    const dir = fs.mkdtempSync(path.join(tempRoot, 'awp-testdb-'))
    const dst = path.join(dir, 'team.db')

    if (MODE === 'copy') {
      try {
        if (fs.existsSync(REAL_DB)) {
          fs.copyFileSync(REAL_DB, dst)
          for (const suffix of ['-wal', '-shm']) {
            if (fs.existsSync(REAL_DB + suffix)) fs.copyFileSync(REAL_DB + suffix, dst + suffix)
          }
        }
      } catch {
        /* 复制失败 → 空库，迁移会建 schema */
      }
    } else {
      try { fs.writeFileSync(dst, '') } catch { /* ignore */ }
    }

    globalThis.__awpTestDbPath = dst
    globalThis.__awpTestDbMode = MODE
    process.env.AWP_DB_PATH = dst
    registerCleanup(dir)
  }
}
