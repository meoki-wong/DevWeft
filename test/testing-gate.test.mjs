import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { buildContextPack } from '../harness/context.js'
import {
  evaluateNewGate,
  getRepoGateMode,
  isPlatformGateTransition,
  requiredUnitsForSize,
  shouldEnforceNewGate,
  testingPolicy,
} from '../harness/testing-gate.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-gate-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

describe('harness testing gate (observe)', () => {
  it('maps required units and gate transitions from size', () => {
    expect(requiredUnitsForSize('S')).toEqual(['static:na'])
    expect(requiredUnitsForSize('M', ['client', 'admin'])).toEqual(['static:na', 'smoke:client', 'smoke:admin'])
    expect(isPlatformGateTransition('EXECUTE', 'DONE', 'S')).toBe(true)
    expect(isPlatformGateTransition('EXECUTE', 'VERIFY', 'M')).toBe(true)
    expect(isPlatformGateTransition('VERIFY', 'DONE', 'M')).toBe(false)
    expect(shouldEnforceNewGate('observe', 'S')).toBe(false)
    expect(shouldEnforceNewGate('enforce_s', 'S')).toBe(true)
    expect(shouldEnforceNewGate('enforce_s', 'M')).toBe(true)
    expect(shouldEnforceNewGate('enforce_ml', 'S')).toBe(true)
  })

  it('bootstraps project into observe and does not invent human ops', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, { rotateToken: true })
    expect(await getRepoGateMode(db, 'demo-app')).toBe('observe')
    const other = await ensureRepository(db, 'other-repo', boot.principalId)
    expect(await getRepoGateMode(db, 'other-repo')).toBe('legacy')
    const policy = await testingPolicy(db, {
      repoSlug: 'demo-app',
      taskId: 'T-1',
      phase: 'EXECUTE',
      size: 'S',
      nextTo: 'DONE',
    })
    expect(policy.humanMustNotRunOps).toBe(true)
    expect(policy.actor).toBe('agent')
    expect(policy.submitRequired).toBe(true)
    const pack = buildContextPack('EXECUTE', { size: 'S', testing: policy })
    expect(pack.instructions).toMatch(/禁止让用户执行/)
    expect(pack.testing.mode).toBe('observe')
    expect(other).toBeTruthy()
  })

  it('observe evaluation blocks new gate without a binding but is not enforce', async () => {
    const db = await memdb()
    await bootstrapTestingPlatform(db, { rotateToken: true })
    const evaluation = await evaluateNewGate(db, {
      repoSlug: 'demo-app',
      taskId: 'missing-task',
      size: 'S',
    })
    expect(evaluation.wouldBlock).toBe(true)
    expect(evaluation.blockedBy[0].code).toBe('NOT_SUBMITTED')
    expect(shouldEnforceNewGate('observe', 'S')).toBe(false)
  })
})
