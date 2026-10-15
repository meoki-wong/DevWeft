/**
 * link-schema.test.mjs — 链路网关方案 §3 完成标准
 *
 * sqlite 与 postgres 各启动一次后三张表都在；重复执行不报错、不插第二条主链路。
 * 只建临时库，禁止写 data/team.db。
 */
import { describe, expect, it, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { createPostgresHandle } from '../db/postgres-driver.mjs'
import { ensureLinkSchema } from '../db/link-schema.js'

installSqliteTx(Database)

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const TABLES = ['links', 'project_links', 'tool_calls']
const cleanups = []

async function tableCount(db, dialect) {
  let found = 0
  for (const t of TABLES) {
    const probe =
      dialect === 'postgres'
        ? db.prepare(
            `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`
          )
        : db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`)
    const row = await probe.get(t)
    if (Number(row.n) > 0) found++
  }
  return found
}

async function primaryCount(db) {
  const row = await db.prepare('SELECT COUNT(*) AS c FROM links WHERE is_primary = 1').get()
  return Number(row.c)
}

afterAll(async () => {
  for (const fn of cleanups) {
    try {
      await fn()
    } catch {
      /* 清理尽力而为 */
    }
  }
})

describe('ensureLinkSchema (sqlite)', () => {
  function memdb() {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'awp-link-sq-'))
    const db = new Database(path.join(dir, 't.db'))
    db.pragma('foreign_keys = ON')
    cleanups.push(() => db.close())
    return db
  }

  it('三张表都在 + 主链路种子恰好一行', async () => {
    const db = memdb()
    ensureLinkSchema(db)
    expect(await tableCount(db, 'sqlite')).toBe(3)
    expect(await primaryCount(db)).toBe(1)
    const seed = db.prepare("SELECT * FROM links WHERE is_primary = 1").get()
    expect(seed.link_id).toBe('primary')
    expect(seed.base_url).toBe('http://127.0.0.1:8791')
    expect(Number(seed.sort_order)).toBe(0)
    expect(Number(seed.enabled)).toBe(1)
  })

  it('重复执行不报错、不插第二条主链路', async () => {
    const db = memdb()
    ensureLinkSchema(db)
    ensureLinkSchema(db)
    ensureLinkSchema(db)
    expect(await tableCount(db, 'sqlite')).toBe(3)
    expect(await primaryCount(db)).toBe(1)
    expect(Number(db.prepare('SELECT COUNT(*) c FROM links').get().c)).toBe(1)
  })

  it('tool_calls 带链路归因列（新装 DDL 直出）', () => {
    const db = memdb()
    ensureLinkSchema(db)
    const cols = db.prepare('PRAGMA table_info(tool_calls)').all().map((c) => c.name)
    expect(cols).toContain('served_by_link')
    expect(cols).toContain('failover_from')
  })

  it('存量库缺归因列 → ensureLinkSchema 幂等补列', () => {
    const db = memdb()
    db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
      call_id TEXT PRIMARY KEY, repo TEXT, task_id TEXT, tool_name TEXT, phase TEXT,
      state TEXT NOT NULL, status TEXT, response_text TEXT, started_at TEXT NOT NULL, finished_at TEXT
    )`)
    ensureLinkSchema(db)
    ensureLinkSchema(db) // 重复执行不报错
    const cols = db.prepare('PRAGMA table_info(tool_calls)').all().map((c) => c.name)
    expect(cols).toContain('served_by_link')
    expect(cols).toContain('failover_from')
  })
})

describe('ensureLinkSchema (postgres / PGlite)', () => {
  async function pgdb() {
    const pg = new PGlite(fs.mkdtempSync(path.join(os.tmpdir(), 'awp-link-pg-')), {
      extensions: { pg_trgm },
    })
    const handle = await createPostgresHandle({ poolLike: pg })
    cleanups.push(() => pg.close())
    return handle
  }

  it('三张表都在 + 主链路种子恰好一行', async () => {
    const db = await pgdb()
    await ensureLinkSchema(db)
    expect(await tableCount(db, 'postgres')).toBe(3)
    expect(await primaryCount(db)).toBe(1)
    const seed = await db.prepare('SELECT * FROM links WHERE is_primary = 1').get()
    expect(seed.link_id).toBe('primary')
    expect(seed.base_url).toBe('http://127.0.0.1:8791')
    expect(Number(seed.sort_order)).toBe(0)
    expect(Number(seed.enabled)).toBe(1)
  })

  it('重复执行不报错、不插第二条主链路', async () => {
    const db = await pgdb()
    await ensureLinkSchema(db)
    await ensureLinkSchema(db)
    await ensureLinkSchema(db)
    expect(await tableCount(db, 'postgres')).toBe(3)
    expect(await primaryCount(db)).toBe(1)
    expect(Number((await db.prepare('SELECT COUNT(*) c FROM links').get()).c)).toBe(1)
  })

  it('部分唯一索引 links_one_primary 阻断第二条主链路（同事务改主链路除外）', async () => {
    const db = await pgdb()
    await ensureLinkSchema(db)
    const now = new Date().toISOString()
    await expect(
      db
        .prepare(
          `INSERT INTO links (link_id, name, base_url, sort_order, is_primary, enabled, created_at, updated_at)
           VALUES ('dup', 'dup', 'http://127.0.0.1:8792', 1, 1, 1, ?, ?)`
        )
        .run(now, now)
    ).rejects.toThrow()
  })

  it('tool_calls 带链路归因列（新装 DDL 直出）', async () => {
    const db = await pgdb()
    await ensureLinkSchema(db)
    const cols = await db
      .prepare(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'tool_calls' AND column_name IN ('served_by_link','failover_from')`
      )
      .all()
    expect(cols.length).toBe(2)
  })
})
