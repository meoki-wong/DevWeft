import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations, ensureTenantRepo } from '../testing/migrate.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-tenant-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

describe('ensureTenantRepo', () => {
  it('新 slug 创建独立租户并默认 observe', async () => {
    const db = await memdb()
    const t = await ensureTenantRepo(db, 'Sample-New-Repo')
    expect(t.created).toBe(true)
    expect(t.slug).toBe('sample-new-repo')
    const row = await db.prepare('SELECT * FROM repositories WHERE slug=?').get('sample-new-repo')
    expect(row.enabled).toBe(1)
    const mode = await db.prepare('SELECT mode FROM repo_gate_modes WHERE repo_id=?').get(t.repoId)
    expect(mode.mode).toBe('observe')
  })

  it('幂等：再次调用不重复建', async () => {
    const db = await memdb()
    const a = await ensureTenantRepo(db, 'demo-app')
    const b = await ensureTenantRepo(db, 'demo-app')
    expect(a.repoId).toBe(b.repoId)
    expect(a.created).toBe(true)
    expect(b.created).toBe(false)
    expect((await db.prepare('SELECT COUNT(*) c FROM repositories').get()).c).toBe(1)
  })

  it('非法 slug 拒绝', async () => {
    const db = await memdb()
    await expect(ensureTenantRepo(db, '../evil')).rejects.toThrow(/INVALID_REPO_SLUG/)
    await expect(ensureTenantRepo(db, '')).rejects.toThrow(/INVALID_REPO_SLUG/)
  })
})
