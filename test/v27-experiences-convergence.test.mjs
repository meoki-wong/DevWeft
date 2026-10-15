/**
 * v27 experiences schema convergence
 * 覆盖：真库协作层结构下 reviewPending(promoted) 可插入；v27 列与索引落账。
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations, applyVersionedMigration } from '../testing/migrate.js'
import {
  createExperiencePending,
  reviewPending,
  listExperiences,
} from '../testing/failures.js'

/** 模拟真库：先建 db.js 协作层 experiences，再跑 testing 迁移 */
async function realPathDb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // 与 db.js initDB 的 experiences 保持同构
  await db.exec(`
    CREATE TABLE IF NOT EXISTS experiences (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT DEFAULT 'auto',
      status      TEXT DEFAULT 'pending',
      author      TEXT NOT NULL,
      module      TEXT,
      task_id     TEXT,
      rule_ref    TEXT,
      tags        TEXT DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
  `)
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')
     ON CONFLICT DO NOTHING`
  ).run()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'u1', 'u1', 'active', 't', 't')
     ON CONFLICT DO NOTHING`
  ).run()
  return db
}

describe('v27 experiences convergence', () => {
  it('registers version 27 and adds v27 columns on unified experiences', async () => {
    const db = await realPathDb()
    const ver = await db.prepare('SELECT version, name FROM schema_migrations WHERE version=27').get()
    expect(ver).toBeTruthy()
    expect(ver.name).toBe('experience_schema_convergence')
    const cols = (await db.prepare('PRAGMA table_info(experiences)').all()).map((c) => c.name)
    for (const c of ['title', 'source_type', 'source_id', 'reviewer', 'confidence', 'fingerprint', 'promotion_type']) {
      expect(cols).toContain(c)
    }
    // 老数据 source_type 回填为 manual
    await db.prepare(
      `INSERT INTO experiences (id, repo, tenant_id, content, source, status, author, created_at, updated_at)
       VALUES ('exp-old-1', 'demo-app', (SELECT repo_id FROM repositories WHERE slug = 'demo-app'), 'legacy', 'auto', 'pending', 'a', 't', 't')`
    ).run()
    const old = await db.prepare(`SELECT source_type FROM experiences WHERE id='exp-old-1'`).get()
    expect(old.source_type).toBe('manual')
    // 索引存在
    const idx = await db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_exp_fingerprint','idx_exp_created')`).all()
    expect(idx.map((r) => r.name).sort()).toEqual(['idx_exp_created', 'idx_exp_fingerprint'])
    db.close()
  })

  it('promoted_to_experience writes unified schema on real-path db', async () => {
    const db = await realPathDb()
    const pid = (await db.prepare(`SELECT principal_id FROM principals LIMIT 1`).get())?.principal_id
    const rid = (await db.prepare(`SELECT repo_id FROM repositories WHERE slug='demo-app'`).get())?.repo_id
    expect(pid).toBeTruthy()
    expect(rid).toBeTruthy()
    const p = await createExperiencePending(db, {
      repoId: rid,
      sourceId: 'fail-1',
      failureClass: 'product',
      content: 'X is not defined when clicking submit',
      title: 'submit click NPE',
    })
    const r = await reviewPending(db, {
      pendingId: p.pendingId,
      action: 'promoted_to_experience',
      reviewerPrincipalId: pid,
    })
    expect(r.experienceId).toBeTruthy()
    const row = await db.prepare('SELECT * FROM experiences WHERE id=?').get(r.experienceId)
    expect(row).toBeTruthy()
    expect(row.repo).toBe('demo-app')
    expect(row.status).toBe('reviewed')
    expect(row.source_type).toBe('test_failure')
    expect(row.source_id).toBe('fail-1')
    expect(row.title).toBe('submit click NPE')
    expect(row.reviewer).toBe(pid)
    expect(row.confidence).toBe(0.5)
    expect(row.category).toBe('product')
    expect(await listExperiences(db, { repoId: rid })).toHaveLength(1)
    expect(await listExperiences(db, { repoId: 'demo-app' })).toHaveLength(1)
    db.close()
  })

  it('v27 is idempotent on second run', async () => {
    const db = await realPathDb()
    const colsBefore = (await db.prepare('PRAGMA table_info(experiences)').all()).length
    await runTestingMigrations(db, { skipLegacyMap: true })
    const colsAfter = (await db.prepare('PRAGMA table_info(experiences)').all()).length
    expect(colsAfter).toBe(colsBefore)
    db.close()
  })
})

describe('applyVersionedMigration atomicity (v27+ runner)', () => {
  it('failed apply does not register version in schema_migrations', async () => {
    const db = new Database(':memory:')
    await db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)`)
    expect(() => applyVersionedMigration(db, {
        version: 99,
        name: 'boom',
        checksum: 'abc',
        apply: () => {
          throw new Error('apply failed mid-way')
        },
      })).toThrow(/apply failed/)
    const row = await db.prepare('SELECT * FROM schema_migrations WHERE version=99').get()
    expect(row).toBeUndefined()
    db.close()
  })

  it('successful apply registers version; re-run is no-op', async () => {
    const db = new Database(':memory:')
    await db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, checksum TEXT, applied_at TEXT)`)
    let calls = 0
    const apply = () => { calls += 1 }
    await applyVersionedMigration(db, { version: 98, name: 'ok', checksum: 'h1', apply })
    await applyVersionedMigration(db, { version: 98, name: 'ok', checksum: 'h1', apply })
    expect(calls).toBe(1)
    const row = await db.prepare('SELECT checksum FROM schema_migrations WHERE version=98').get()
    expect(row.checksum).toBe('h1')
    db.close()
  })
})
