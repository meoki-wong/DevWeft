/**
 * M5 旁路：completeLease 后失败自动立案 + feature_key 收敛
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { writebackRunFailures } from '../testing/failure-writeback.js'
import { normalizeFeatureKey } from '../testing/test-specs.js'
import { gateBlocksRun } from '../testing/repo-gate-modes.js'

// test-specs.js imports production db — use a isolated approach: only test writeback + normalize pure fns
// and gateBlocksRun with memdb via repo-gate-modes

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-fwb-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'alice', 'a', 'active', 't', 't')`
  ).run()
  return db
}

describe('writebackRunFailures', () => {
  it('product check → recordFailure + experience_pending', async () => {
    const db = await memdb()
    // recordFailure uses the db passed in
    const r = await writebackRunFailures(db, {
      runId: 'run-1',
      status: 'failed',
      terminalReason: 'assertion_failed',
      bindingId: 'b'.repeat(64),
      taskInstanceId: 'ti-1',
      repoId: 'r1',
      checks: [{ caseKey: 'test:static/eslint', status: 'failed', detail: 'prettier' }],
    })
    expect(r.recorded).toBeGreaterThanOrEqual(1)
    expect(r.pending).toBeGreaterThanOrEqual(1)
    const f = await db.prepare('SELECT * FROM test_failures').all()
    expect(f.length).toBeGreaterThanOrEqual(1)
    expect(f[0].failure_class).toBe('product')
    const p = await db.prepare('SELECT * FROM experience_pending').all()
    expect(p.length).toBeGreaterThanOrEqual(1)
    expect(p[0].status).toBe('pending_review')
  })

  it('suite check → experience_pending class=suite', async () => {
    const db = await memdb()
    const r = await writebackRunFailures(db, {
      runId: 'run-2',
      status: 'failed',
      terminalReason: 'assertion_failed',
      bindingId: 'c'.repeat(64),
      taskInstanceId: 'ti-2',
      repoId: 'r1',
      checks: [{
        caseKey: 'test:spec/flight-check',
        status: 'failed',
        detail: 'Cannot navigate to invalid URL',
      }],
    })
    expect(r.pending).toBeGreaterThanOrEqual(1)
    const p = await db.prepare('SELECT failure_class FROM experience_pending').get()
    expect(p.failure_class).toBe('suite')
  })

  it('infra_error → recordFailure only, no experience_pending', async () => {
    const db = await memdb()
    const r = await writebackRunFailures(db, {
      runId: 'run-3',
      status: 'error',
      terminalReason: 'infra_error',
      bindingId: 'd'.repeat(64),
      taskInstanceId: 'ti-3',
      repoId: 'r1',
      checks: [],
    })
    expect(r.recorded).toBe(1)
    expect(r.pending).toBe(0)
    expect((await db.prepare('SELECT COUNT(*) c FROM experience_pending').get()).c).toBe(0)
  })
})

describe('feature_key normalize', () => {
  it('normalizes case and underscores', () => {
    expect(normalizeFeatureKey('Catalog_SampleItem')).toBe('catalog-sampleitem')
    expect(normalizeFeatureKey('flight-check-fake-order')).toBe('flight-check-fake-order')
  })
})

describe('gateBlocksRun delegates to shouldEnforceNewGate', () => {
  it('enforce_all blocks all sizes', async () => {
    const db = await memdb()
    await db.prepare(
      `INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES ('r1', 'enforce_all', 't')`
    ).run()
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'S' })).toBe(true)
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'M' })).toBe(true)
  })
  it('observe never blocks', async () => {
    const db = await memdb()
    await db.prepare(
      `INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES ('r1', 'observe', 't')`
    ).run()
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'L' })).toBe(false)
  })
})
