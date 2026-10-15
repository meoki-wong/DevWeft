import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import {
  ensureGateLoop,
  updateGateLoop,
  getGateLoop,
  grantGateRetryBudget,
  checkReadyToResubmit,
} from '../harness/loop.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-retry-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await ensureRepository(db, 'demo-app', 'system')
  return db
}

describe('grantGateRetryBudget（续作解锁）', () => {
  it('迭代耗尽后续作：+1 次机会，清 needs_human，可重提', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { needsHuman: true, iteration: 5, maxIterations: 5, lastClass: 'product' },
    })
    expect((await checkReadyToResubmit(db, { repoSlug: 'demo-app', taskId: 'T1' })).code).toBe('NEEDS_HUMAN')

    const out = await grantGateRetryBudget(db, { repo: 'demo-app', taskId: 'T1', actor: 'aicoding' })
    expect(out.granted).toBe(true)
    expect(out.added).toBe(1)
    expect(out.maxIterations).toBe(6)
    expect(out.loop.needsHuman).toBe(false)
    expect(out.loop.iteration).toBe(5)
    expect(out.loop.state).toBe('remediation_product')
    expect((await checkReadyToResubmit(db, { repoSlug: 'demo-app', taskId: 'T1' })).ok).toBe(true)
  })

  it('仍有预算时不重复解锁', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { needsHuman: false, iteration: 2, maxIterations: 5 },
    })
    const out = await grantGateRetryBudget(db, { repo: 'demo-app', taskId: 'T1' })
    expect(out.granted).toBe(false)
    expect(out.code).toBe('BUDGET_AVAILABLE')
  })

  it('再次耗尽后再次续作，预算累加 +1 而不是一次给满', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { needsHuman: true, iteration: 5, maxIterations: 5, lastClass: 'product' },
    })
    const a = await grantGateRetryBudget(db, { repo: 'demo-app', taskId: 'T1' })
    expect(a.maxIterations).toBe(6)
    // 烧掉第 6 次
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { needsHuman: true, iteration: 6, maxIterations: 6 },
    })
    const b = await grantGateRetryBudget(db, { repo: 'demo-app', taskId: 'T1' })
    expect(b.granted).toBe(true)
    expect(b.maxIterations).toBe(7)
    expect((await getGateLoop(db, { repo: 'demo-app', taskId: 'T1' })).needsHuman).toBe(false)
  })
})
