/**
 * update_doc baseVersion 乐观锁 + update_docs_batch 原子发布
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)

async function memdb() {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, name TEXT NOT NULL, category TEXT, content TEXT NOT NULL,
      updated_at TEXT NOT NULL, updated_by TEXT, UNIQUE(repo, name)
    );
    CREATE TABLE docs_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      content_before TEXT, content_after TEXT,
      category_before TEXT, category_after TEXT,
      author TEXT, created_at TEXT NOT NULL, UNIQUE(repo, name, version)
    );
  `)
  return db
}

async function writeDoc(db, { repo = 'r1', name, content, category = null, author = 'a', baseVersion = null }) {
  const now = new Date().toISOString()
  const last = await db.prepare('SELECT COALESCE(MAX(version),0) v FROM docs_versions WHERE repo=? AND name=?').get(repo, name)
  const current = last?.v || 0
  if (baseVersion != null && baseVersion !== current) {
    return { ok: false, code: 'DOC_VERSION_CONFLICT', current }
  }
  const existing = await db.prepare('SELECT content, category FROM docs WHERE repo=? AND name=?').get(repo, name)
  const next = current + 1
  const tx = async (tx) => {
    // 首次创建也记 v1，保证 baseVersion 语义完整
    await tx.prepare(
      `INSERT INTO docs_versions(repo,name,version,content_before,content_after,category_before,category_after,author,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(repo, name, next, existing?.content ?? null, content, existing?.category ?? null, category, author, now)
    await tx.prepare(
      `INSERT INTO docs(repo,name,category,content,updated_at,updated_by) VALUES (?,?,?,?,?,?)
       ON CONFLICT(repo,name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at, updated_by=excluded.updated_by`
    ).run(repo, name, category, content, now, author)
  }
  await db.tx(tx)
  return { ok: true, version: next }
}

async function writeDocsBatch(db, { repo = 'r1', docs, baseVersions = {}, author = 'a' }) {
  try {
    const results = []
    const tx = async (tx) => {
      for (const d of docs) {
        const last = await tx.prepare('SELECT COALESCE(MAX(version),0) v FROM docs_versions WHERE repo=? AND name=?').get(repo, d.name)
        const current = last?.v || 0
        if (baseVersions[d.name] != null && baseVersions[d.name] !== current) {
          const err = new Error(`DOC_VERSION_CONFLICT:${d.name}`)
          err.code = 'DOC_VERSION_CONFLICT'
          throw err
        }
        const existing = await tx.prepare('SELECT content FROM docs WHERE repo=? AND name=?').get(repo, d.name)
        const next = current + 1
        const now = new Date().toISOString()
        await tx.prepare(
          `INSERT INTO docs_versions(repo,name,version,content_before,content_after,author,created_at)
           VALUES (?,?,?,?,?,?,?)`
        ).run(repo, d.name, next, existing?.content ?? null, d.content, author, now)
        await tx.prepare(
          `INSERT INTO docs(repo,name,content,updated_at,updated_by) VALUES (?,?,?,?,?)
           ON CONFLICT(repo,name) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`
        ).run(repo, d.name, d.content, now, author)
        results.push({ name: d.name, version: next })
      }
    }
    await db.tx(tx)
    return { ok: true, results }
  } catch (e) {
    return { ok: false, error: e.message, code: e.code }
  }
}

describe('docs baseVersion + batch', () => {
  it('baseVersion mismatch → DOC_VERSION_CONFLICT', async () => {
    const db = await memdb()
    expect((await writeDoc(db, { name: 'A', content: 'v1' })).ok).toBe(true)
    expect((await writeDoc(db, { name: 'A', content: 'v2', baseVersion: 0 })).code).toBe('DOC_VERSION_CONFLICT')
    expect((await writeDoc(db, { name: 'A', content: 'v2', baseVersion: 1 })).ok).toBe(true)
    db.close()
  })

  it('batch atomic: one conflict rolls back all', async () => {
    const db = await memdb()
    await writeDoc(db, { name: 'MODULE_INDEX', content: 'idx-v1' })
    await writeDoc(db, { name: 'module-fun-a', content: 'mod-v1' })
    const r = await writeDocsBatch(db, {
      docs: [
        { name: 'MODULE_INDEX', content: 'idx-v2' },
        { name: 'module-fun-a', content: 'mod-v2' },
        { name: 'module-fun-b', content: 'new' },
      ],
      baseVersions: { 'MODULE_INDEX': 1, 'module-fun-a': 99 },
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DOC_VERSION_CONFLICT')
    // 整体回滚：INDEX 仍是 v1 内容
    expect((await db.prepare(`SELECT content FROM docs WHERE name='MODULE_INDEX'`).get()).content).toBe('idx-v1')
    expect((await db.prepare(`SELECT content FROM docs WHERE name='module-fun-a'`).get()).content).toBe('mod-v1')
    expect(await db.prepare(`SELECT content FROM docs WHERE name='module-fun-b'`).get()).toBeUndefined()
    db.close()
  })

  it('batch success all-or-nothing', async () => {
    const db = await memdb()
    await writeDoc(db, { name: 'MODULE_INDEX', content: 'idx-v1' })
    const r = await writeDocsBatch(db, {
      docs: [
        { name: 'MODULE_INDEX', content: 'idx-v2' },
        { name: 'module-fun-new', content: 'hello' },
      ],
      baseVersions: { MODULE_INDEX: 1 },
    })
    expect(r.ok).toBe(true)
    expect((await db.prepare(`SELECT content FROM docs WHERE name='MODULE_INDEX'`).get()).content).toBe('idx-v2')
    expect((await db.prepare(`SELECT content FROM docs WHERE name='module-fun-new'`).get()).content).toBe('hello')
    db.close()
  })
})
