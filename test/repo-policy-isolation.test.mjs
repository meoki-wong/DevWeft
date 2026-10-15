import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { getRepoTestPolicy, upsertRepoTestPolicy, seedRepoTestPolicies } from '../testing/repo-policies.js'

const PROFILE_SLUG = `profile-test-${process.pid}`
const PROFILE_ENV_KEY = `AWP_REPO_PATH_${PROFILE_SLUG.replace(/[^\w]/g, '_').toUpperCase()}`

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-pol-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('profile', ?, 'profile', 'refs/heads/main', 't', 't')`
  ).run(PROFILE_SLUG)
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('other', 'unconfigured-repo', 'other', 'refs/heads/main', 't', 't')`
  ).run()
  return db
}

describe('repository test policy isolation', () => {
  it('seeds a policy only for configured workspace profiles', async () => {
    const db = await memdb()
    process.env[PROFILE_ENV_KEY] = '/tmp'
    try {
      await seedRepoTestPolicies(db)
      const configured = await getRepoTestPolicy(db, PROFILE_SLUG)
      const unconfigured = await getRepoTestPolicy(db, 'unconfigured-repo')
      expect(configured.enforceSpecContract).toBe(true)
      expect(configured.enableSides).toBe(false)
      expect(unconfigured.enforceSpecContract).toBe(false)
      expect(unconfigured.enableSides).toBe(false)
    } finally {
      delete process.env[PROFILE_ENV_KEY]
    }
  })

  it('allows independent policy changes per repository', async () => {
    const db = await memdb()
    process.env[PROFILE_ENV_KEY] = '/tmp'
    try {
      await seedRepoTestPolicies(db)
      await upsertRepoTestPolicy(db, { repoId: 'other', enforceSpecContract: true })
      expect((await getRepoTestPolicy(db, 'unconfigured-repo')).enforceSpecContract).toBe(true)
      await upsertRepoTestPolicy(db, { repoId: 'profile', enforceSpecContract: false })
      expect((await getRepoTestPolicy(db, PROFILE_SLUG)).enforceSpecContract).toBe(false)
      expect((await getRepoTestPolicy(db, 'unconfigured-repo')).enforceSpecContract).toBe(true)
    } finally {
      delete process.env[PROFILE_ENV_KEY]
    }
  })
})
