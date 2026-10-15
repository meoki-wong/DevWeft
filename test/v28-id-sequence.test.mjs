/**
 * v28 id_sequences：替换 COUNT(*)+1
 *
 * 方案 §13.3：改为针对基线后结构，不执行 SQLite 历史脚本。
 * 直接建 id_sequences 表（基线形状），验证 nextId / backfillIdSequence 逻辑。
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { createIdSequencesTable, nextId, backfillIdSequence } from '../db/id-sequence.js'

/** 基线后结构的最小库：id_sequences + experiences（回填用） */
function baselineDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  createIdSequencesTable(db)
  // 回填目标表：基线形状的 experiences（仅需 id 列）
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id TEXT PRIMARY KEY, repo TEXT, content TEXT, status TEXT, author TEXT,
      tags TEXT, created_at TEXT, updated_at TEXT
    )
  `)
  return db
}

describe('id-sequence（基线后结构）', () => {
  it('allocates unique sequential ids without COUNT+1', async () => {
    const db = baselineDb()
    const ids = []
    for (let i = 0; i < 5; i++) ids.push(await nextId(db, 'exp'))
    expect(new Set(ids).size).toBe(5)
    expect(ids[0].startsWith('exp-')).toBe(true)
    const nums = ids.map((id) => Number(id.split('-')[2]))
    expect(nums).toEqual([1, 2, 3, 4, 5])
    db.close()
  })

  it('does not reuse id after delete (no COUNT regression)', async () => {
    const db = baselineDb()
    const a = await nextId(db, 'exp')
    const b = await nextId(db, 'exp')
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    await db.prepare(`UPDATE id_sequences SET next = 10 WHERE scope = ?`).run(`exp:${day}`)
    const c = await nextId(db, 'exp')
    expect(Number(c.split('-')[2])).toBe(10)
    expect(c).not.toBe(a)
    expect(c).not.toBe(b)
    db.close()
  })

  it('backfill jumps past existing max id for today', async () => {
    const db = baselineDb()
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    await db.prepare(
      `INSERT INTO experiences (id, repo, content, status, author, tags, created_at, updated_at)
       VALUES (?, 'r', 'c', 'pending', 'a', '[]', 't', 't')`
    ).run(`exp-${day}-007`)
    const next = backfillIdSequence(db, 'exp', 'experiences', 'id')
    expect(next).toBe(8)
    const id = await nextId(db, 'exp')
    expect(Number(id.split('-')[2])).toBe(8)
    db.close()
  })

  it('id_sequences table exists in baseline shape', () => {
    const db = baselineDb()
    const t = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='id_sequences'`).get()
    expect(t).toBeTruthy()
    expect(t.sql).toContain('scope TEXT PRIMARY KEY')
    expect(t.sql).toContain('next')
    db.close()
  })

  it('exp and rep sequences are independent', async () => {
    const db = baselineDb()
    expect(await nextId(db, 'exp')).toMatch(/^exp-\d{8}-001$/)
    expect(await nextId(db, 'rep')).toMatch(/^rep-\d{8}-001$/)
    expect(await nextId(db, 'exp')).toMatch(/^exp-\d{8}-002$/)
    db.close()
  })
})
