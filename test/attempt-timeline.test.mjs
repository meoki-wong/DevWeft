import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'

describe('run_attempts.steps_json (v22)', () => {
  it('migration adds steps_json column for timeline', async () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-tl-')), 't.db'))
    db.pragma('foreign_keys = ON')
    await runTestingMigrations(db, { skipLegacyMap: true })
    const cols = (await db.prepare('PRAGMA table_info(run_attempts)').all()).map((c) => c.name)
    expect(cols).toContain('steps_json')
    const mig = await db.prepare('SELECT name FROM schema_migrations WHERE version=22').get()
    expect(mig?.name).toBe('attempt_steps_timeline')
  })
})
