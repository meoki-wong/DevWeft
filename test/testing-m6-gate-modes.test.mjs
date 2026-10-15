/** M6 tests: repo gate mode 切换与 gate 行为 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import {
  getRepoGateMode, transitionRepoGateMode, listRepoGateModes, gateBlocksRun,
} from '../testing/repo-gate-modes.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m6-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
  return db
}

describe('M6: repo gate modes', () => {
  it('default mode is observe (v3 seedRepoGateModes)', async () => {
    const db = await memdb()
    const m = await getRepoGateMode(db, { repoId: 'r1' })
    expect(m.mode).toBe('observe')
  })
  it('transitionRepoGateMode allows sequential upgrade', async () => {
    const db = await memdb()
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_s', actorPrincipalId: 'p1' })
    expect((await getRepoGateMode(db, { repoId: 'r1' })).mode).toBe('enforce_s')
  })
  it('blocks skip-level upgrade (legacy → enforce_s in one step)', async () => {
    const db = await memdb()
    // 强制 legacy
    await db.prepare("INSERT OR REPLACE INTO repo_gate_modes(repo_id, mode, updated_at) VALUES ('r1', 'legacy', '2026-01-01T00:00:00.000Z')").run()
    await expect(transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_all', actorPrincipalId: 'p1' })).rejects.toThrow(/INVALID_SCHEMA/)
  })
  it('enforce_s → enforce_all requires 24h enforcement_s age', async () => {
    const db = await memdb()
    // 立即切到 enforce_s（用固定 fake time，否则用 today+now 默认）
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_s', actorPrincipalId: 'p1', now: t0 })
    // 立即切 enforce_all - 应失败（enforce_s 才 0ms）
    await expect(transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_all', actorPrincipalId: 'p1', now: t0 })).rejects.toThrow(/SUITE_REVOKED/)
    // 25h 后切 - 应成功（同样的 fake time 系列）
    const t25 = new Date(t0.getTime() + 25 * 3600 * 1000)
    const r = await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_all', actorPrincipalId: 'p1', now: t25 })
    expect(r.mode).toBe('enforce_all')
  })
  it('downgrade is always allowed', async () => {
    const db = await memdb()
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_s', actorPrincipalId: 'p1' })
    const r = await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'legacy', actorPrincipalId: 'p1' })
    expect(r.mode).toBe('legacy')
  })
})

describe('M6: gate blocks vs advisory', () => {
  it('legacy mode never blocks', async () => {
    const db = await memdb()
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'legacy', actorPrincipalId: 'p1' })
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'L' })).toBe(false)
  })
  it('observe mode never blocks (advisory only)', async () => {
    const db = await memdb()
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'L' })).toBe(false)
  })
  it('enforce_s 与 enforce_ml 都按 enforce 拦截，不再按 size 拆', async () => {
    const db = await memdb()
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_s', actorPrincipalId: 'p1' })
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'S' })).toBe(true)
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'M' })).toBe(true)
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'L' })).toBe(true)
  })
  it('enforce_all blocks all sizes', async () => {
    const db = await memdb()
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const t25 = new Date(t0.getTime() + 25 * 3600 * 1000)
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_s', actorPrincipalId: 'p1', now: t0 })
    await transitionRepoGateMode(db, { repoId: 'r1', toMode: 'enforce_all', actorPrincipalId: 'p1', now: t25 })
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'S' })).toBe(true)
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'M' })).toBe(true)
    expect(await gateBlocksRun(db, { repoId: 'r1', size: 'L' })).toBe(true)
  })
})
