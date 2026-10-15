/**
 * gate-mode-disabled.test.mjs — 云端测试独立可插拔（按仓 disabled 开关）
 *
 * disabled 语义：该仓门禁永不拦截、testingPolicy 给"不走云端"视图、
 * 失败经验不再拦截推进；其他仓不受影响；不会被 seedRepoGateModesEnforce 拉回 enforce。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations, seedRepoGateModes } from '../testing/migrate.js'
import { seedRepoGateModesEnforce } from '../testing/repo-policies.js'
import { upsertRepoTestPolicy } from '../testing/repo-policies.js'
import {
  GATE_MODES,
  getRepoGateMode,
  isCloudTestingEnabled,
  setRepoGateMode,
  evaluateGateDecision,
  evaluateNewGate,
  testingPolicy,
  findUnsummarizedGateFailure,
} from '../harness/testing-gate.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-gateoff-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  // migrate 可能已 seed 默认租户；幂等补齐
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('project', 'demo-app', 'project', 'refs/heads/stage', 't', 't')
     ON CONFLICT DO NOTHING`
  ).run()
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('other', 'test-plain-repo', 'other', 'refs/heads/master', 't', 't')
     ON CONFLICT DO NOTHING`
  ).run()
  // 测试固定使用上述 slug；若 migrate 已 seed 同 slug 不同 id，则以 slug 查询为准
  // 迁移不再自动 seed 业务数据：显式调用按仓门禁档种子（project=observe，其余=legacy）
  await seedRepoGateModes(db)
  return db
}

describe('gate mode = disabled（云端测试按仓可插拔）', () => {
  it('开关可设可查，disabled 时 isCloudTestingEnabled=false', async () => {
    const db = await memdb()
    // migrate 种子：project 默认 observe（可云端测），plain 默认 observe（不强制拦截）
    expect(await getRepoGateMode(db, 'test-plain-repo')).toBe('observe')
    expect(await isCloudTestingEnabled(db, 'test-plain-repo')).toBe(true)
    await setRepoGateMode(db, 'test-plain-repo', 'observe')
    expect(await isCloudTestingEnabled(db, 'test-plain-repo')).toBe(true)
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    expect(await getRepoGateMode(db, 'test-plain-repo')).toBe('disabled')
    expect(await isCloudTestingEnabled(db, 'test-plain-repo')).toBe(false)
    // project 不受 plain 开关影响
    expect(await getRepoGateMode(db, 'demo-app')).toBe('observe')
    expect(await isCloudTestingEnabled(db, 'demo-app')).toBe(true)
  })

  it('开关可来回切：disabled → enforce_all 恢复', async () => {
    const db = await memdb()
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    await setRepoGateMode(db, 'test-plain-repo', 'enforce_all')
    expect(await getRepoGateMode(db, 'test-plain-repo')).toBe('enforce_all')
    expect(await isCloudTestingEnabled(db, 'test-plain-repo')).toBe(true)
  })

  it('非法 mode 与未知仓明确报错', async () => {
    const db = await memdb()
    await expect(setRepoGateMode(db, 'test-plain-repo', 'off')).rejects.toThrow(/INVALID_GATE_MODE/)
    await expect(setRepoGateMode(db, 'no-such-repo', 'disabled')).rejects.toThrow(/UNRESOLVED_REPO/)
    expect(GATE_MODES).toContain('disabled')
  })

  it('disabled：门禁评估永不拦截（enabled 仓则 NOT_SUBMITTED 拦截）', async () => {
    const db = await memdb()
    // enabled + enforce：无 task instance → NOT_SUBMITTED 拦截
    await setRepoGateMode(db, 'demo-app', 'enforce_all')
    expect((await evaluateNewGate(db, { repoSlug: 'demo-app', taskId: 't1', size: 'M' })).wouldBlock).toBe(true)
    // disabled：同一场景不拦
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    const evalOff = await evaluateNewGate(db, { repoSlug: 'test-plain-repo', taskId: 't1', size: 'M' })
    expect(evalOff.wouldBlock).toBe(false)
    expect(evalOff.disabled).toBe(true)
  })

  it('disabled：testingPolicy 给"不走云端"视图（enabled 仓要求先下单）', async () => {
    const db = await memdb()
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    await setRepoGateMode(db, 'demo-app', 'enforce_all')
    const off = await testingPolicy(db, { repoSlug: 'test-plain-repo', taskId: 't1', phase: 'EXECUTE', size: 'M', nextTo: 'VERIFY' })
    expect(off.enabled).toBe(false)
    expect(off.submitRequired).toBe(false)
    expect(off.requiredUnits).toEqual([])
    expect(off.hint).toContain('未启用')
    const on = await testingPolicy(db, { repoSlug: 'demo-app', taskId: 't1', phase: 'EXECUTE', size: 'M', nextTo: 'VERIFY' })
    expect(on.submitRequired).toBe(true)
    expect(on.advanceFields).toContain('gateBindingId')
  })

  it('disabled：失败经验拦截解除（无历史失败时本就返回 null，这里锁语义不回归）', async () => {
    const db = await memdb()
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'test-plain-repo', taskId: 't1' })).toBeNull()
  })

  it('seedRepoGateModesEnforce 不会把 disabled 拉回 enforce_all', async () => {
    const db = await memdb()
    const otherId = (await db.prepare(`SELECT repo_id FROM repositories WHERE slug='test-plain-repo'`).get())?.repo_id
    expect(otherId).toBeTruthy()
    await upsertRepoTestPolicy(db, { repoId: otherId, enforceSpecContract: true, enableSides: false })
    await setRepoGateMode(db, 'test-plain-repo', 'disabled')
    await seedRepoGateModesEnforce(db)
    expect(await getRepoGateMode(db, 'test-plain-repo')).toBe('disabled')
  })

  it('enforce_ml 读作 enforce：S 与 M 都拦截', async () => {
    const db = await memdb()
    await setRepoGateMode(db, 'test-plain-repo', 'enforce_ml')
    const m = await evaluateGateDecision(db, { repoSlug: 'test-plain-repo', taskId: 't1', size: 'M' })
    expect(m.enforcement).toBe(true)
    expect(m.shouldBlock).toBe(true)
    const s = await evaluateGateDecision(db, { repoSlug: 'test-plain-repo', taskId: 't1', size: 'S' })
    expect(s.enforcement).toBe(true)
    expect(s.shouldBlock).toBe(true)
    const sPol = await testingPolicy(db, { repoSlug: 'test-plain-repo', taskId: 't1', phase: 'EXECUTE', size: 'S', nextTo: 'DONE' })
    expect(sPol.submitRequired).toBe(true)
    const mPol = await testingPolicy(db, { repoSlug: 'test-plain-repo', taskId: 't1', phase: 'EXECUTE', size: 'M', nextTo: 'VERIFY' })
    expect(mPol.submitRequired).toBe(true)
    expect(mPol.advanceFields).toContain('gateBindingId')
  })

  it('enforce_s 读作 enforce：M 也要下单', async () => {
    const db = await memdb()
    await setRepoGateMode(db, 'test-plain-repo', 'enforce_s')
    const mPol = await testingPolicy(db, { repoSlug: 'test-plain-repo', taskId: 't1', phase: 'EXECUTE', size: 'M', nextTo: 'VERIFY' })
    expect(mPol.submitRequired).toBe(true)
    const mDec = await evaluateGateDecision(db, { repoSlug: 'test-plain-repo', taskId: 't1', size: 'M' })
    expect(mDec.enforcement).toBe(true)
    const sPol = await testingPolicy(db, { repoSlug: 'test-plain-repo', taskId: 't1', phase: 'EXECUTE', size: 'S', nextTo: 'DONE' })
    expect(sPol.submitRequired).toBe(true)
  })
})
