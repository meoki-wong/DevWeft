/**
 * capability-dispatch.test.mjs — 方案 §9/§15.3：租户扩展点
 *
 * 锁死三个行为：
 *   1. 没有登记行时阶段推进与现在一致
 *   2. 未知 handler_id 得到 CAPABILITY_HANDLER_MISSING 且阶段不变（不得回落 default）
 *   3. floor 组合类：租户结果不含阻断时，default 已有的阻断仍然在（只能追加不能删减）
 */
import { describe, expect, it, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { runTestingMigrations } from '../testing/migrate.js'
import { harnessStart, harnessAdvance, harnessStatus } from '../harness/state-machine.js'
import { registerHandler } from '../capabilities/handlers/index.js'
import { resolveCapability, CAPABILITY_FEATURES } from '../harness/dispatch.js'

runTestingMigrations(db, { skipLegacyMap: true })

const REPO = `cap-${randomUUID().slice(0, 8)}`
let repoId = null

const seedRow = (feature, handlerId, params = {}) => {
  db.prepare(
    `INSERT INTO tenant_extensions(repo_id, feature, handler_id, params_json, revision, state, updated_at)
     VALUES (?, ?, ?, ?, 1, 'active', ?)`
  ).run(repoId, feature, handlerId, JSON.stringify(params), new Date().toISOString())
}

const clearRow = (feature) => {
  db.prepare('DELETE FROM tenant_extensions WHERE repo_id=? AND feature=?').run(repoId, feature)
}

/** 建任务并推进到 plan;decisions 非空时入库(decisions 为 null 则清空 pending/decisions → default guard 阻断) */
const seedTaskInPlan = async (repo, taskId, decisions = null) => {
  const started = await harnessStart({ taskId, requirement: `扩展点 ${taskId}`, type: 'UI_DEV', author: 'tester', repo })
  expect(started.ok, JSON.stringify(started).slice(0, 200)).toBe(true)
  const a1 = await harnessAdvance({ taskId, to: 'retrieve', data: { size: 'M', ...(decisions ? { decisions } : {}) }, author: 'tester', repo })
  expect(a1.ok, JSON.stringify(a1).slice(0, 200)).toBe(true)
  const a2 = await harnessAdvance({ taskId, to: 'plan', data: {}, author: 'tester', repo })
  expect(a2.ok, JSON.stringify(a2).slice(0, 200)).toBe(true)
  if (!decisions) {
    // harnessStart 会把 requirement 塞进 pending;显式清空以触发 default guard 的「plan 须记录」阻断
    db.prepare('UPDATE tasks SET pending=?, decisions=? WHERE repo=? AND task_id=?').run('[]', '[]', repo, taskId)
  }
  return taskId
}

afterAll(() => {
  const tasks = db.prepare('SELECT task_id FROM tasks WHERE repo=?').all(REPO)
  for (const t of tasks) {
    db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(REPO, t.task_id)
    db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(REPO, t.task_id)
    db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(REPO, t.task_id)
    db.prepare('DELETE FROM tasks WHERE repo=? AND task_id=?').run(REPO, t.task_id)
  }
  if (repoId) db.prepare('DELETE FROM tenant_extensions WHERE repo_id=?').run(repoId)
  db.prepare('DELETE FROM repo_gate_modes WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=?)').run(REPO)
  db.prepare('DELETE FROM repositories WHERE slug=?').run(REPO)
})

describe('租户扩展点（方案 §9）', () => {
  it('登记表 feature 集合与 §15.2 一致（7 个，组合类正确）', () => {
    expect(Object.keys(CAPABILITY_FEATURES).sort()).toEqual([
      'e2e.inject', 'gate.policy', 'harness.activityPlan', 'harness.guard',
      'harness.instructions', 'review.chain', 'static.checks',
    ])
    expect(CAPABILITY_FEATURES['harness.activityPlan']).toBe('replace')
    expect(CAPABILITY_FEATURES['harness.guard']).toBe('floor')
    expect(CAPABILITY_FEATURES['gate.policy']).toBe('floor')
  })

  it('初始化 + resolveCapability：无登记行 registered:false;非法 slug/未知 feature 拒绝', async () => {
    const started = await harnessStart({ taskId: `T-cap-init-${randomUUID().slice(0, 8)}`, requirement: '初始化仓', type: 'FIX', author: 'tester', repo: REPO })
    expect(started.ok).toBe(true)
    repoId = db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(REPO).repo_id
    expect(await resolveCapability(db, { feature: 'harness.guard', repoSlug: REPO })).toMatchObject({ ok: true, registered: false })
    expect((await resolveCapability(db, { feature: 'harness.guard', repoSlug: 'Not Valid!' })).code).toBe('INVALID_REPO_SLUG')
    expect((await resolveCapability(db, { feature: 'no.such.feature', repoSlug: REPO })).code).toBe('UNKNOWN_FEATURE')
  })

  it('场景1:没有登记行时阶段推进与现在一致(default guard 阻断 plan→execute)', async () => {
    const taskId = await seedTaskInPlan(REPO, `T-cap-a-${randomUUID().slice(0, 8)}`)
    const r = await harnessAdvance({ taskId, to: 'execute', data: {}, author: 'tester', repo: REPO })
    expect(r.ok).toBe(false)
    expect(r.blockedBy.join('')).toContain('plan 须记录 pending 或 decisions')
    const row = db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(REPO, taskId)
    expect(row.phase).toBe('plan')
  })

  it('场景2:未知 handler_id 得到 CAPABILITY_HANDLER_MISSING 且阶段不变(try/finally 清理)', async () => {
    const taskId = await seedTaskInPlan(REPO, `T-cap-b-${randomUUID().slice(0, 8)}`)
    seedRow('gate.policy', 'missing-handler-xyz')
    try {
      const r = await harnessAdvance({ taskId, to: 'execute', data: { decisions: ['x'] }, author: 'tester', repo: REPO })
      expect(r.ok).toBe(false)
      expect(r.code).toBe('CAPABILITY_HANDLER_MISSING')
      expect(r.handlerId).toBe('missing-handler-xyz')
      const row = db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(REPO, taskId)
      expect(row.phase).toBe('plan') // 阶段不变
    } finally {
      clearRow('gate.policy')
    }
  })

  it('场景3:floor——租户结果不含阻断时,default 已有的阻断仍然在', async () => {
    const taskId = await seedTaskInPlan(REPO, `T-cap-c-${randomUUID().slice(0, 8)}`)
    registerHandler('cap-test-guard', () => ({ blockedBy: [] })) // 租户 floor:不追加任何阻断
    seedRow('harness.guard', 'cap-test-guard')
    try {
      const r = await harnessAdvance({ taskId, to: 'execute', data: {}, author: 'tester', repo: REPO })
      expect(r.ok).toBe(false)
      expect(r.blockedBy.join('')).toContain('plan 须记录 pending 或 decisions')
    } finally {
      clearRow('harness.guard')
    }
  })

  it('floor:租户可以追加新的阻断项(只增不减);删除扩展后同路径放行', async () => {
    const taskId = await seedTaskInPlan(REPO, `T-cap-d-${randomUUID().slice(0, 8)}`, ['范围确认'])
    registerHandler('cap-test-guard2', () => ({ blockedBy: ['租户合规:发布窗口未开放'] }))
    seedRow('harness.guard', 'cap-test-guard2')
    try {
      // default 放行(decisions 已入库),租户 floor 追加阻断 → 仍阻断
      const r1 = await harnessAdvance({ taskId, to: 'execute', data: {}, author: 'tester', repo: REPO })
      expect(r1.ok).toBe(false)
      expect(r1.blockedBy.join('')).toContain('租户合规:发布窗口未开放')
    } finally {
      clearRow('harness.guard')
    }
    // 删除扩展后同路径放行(修订回滚语义)
    const r2 = await harnessAdvance({ taskId, to: 'execute', data: {}, author: 'tester', repo: REPO })
    expect(r2.ok, JSON.stringify(r2).slice(0, 200)).toBe(true)
  })

  it('replace:harness.activityPlan 登记后由 handler 决定活动序列', async () => {
    const taskId = `T-cap-e-${randomUUID().slice(0, 8)}`
    const started = await harnessStart({ taskId, requirement: '替换计划', type: 'UI_DEV', author: 'tester', repo: REPO })
    expect(started.ok).toBe(true)
    registerHandler('cap-test-plan', () => ['receive', 'execute']) // 跳过 retrieve/plan
    seedRow('harness.activityPlan', 'cap-test-plan')
    try {
      // UI_DEV 默认下一活动是 retrieve;替换后应为 execute
      const r = await harnessAdvance({ taskId, to: 'execute', data: { decisions: ['x'] }, author: 'tester', repo: REPO })
      expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true)
      expect(r.to).toBe('execute')
    } finally {
      clearRow('harness.activityPlan')
      db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(REPO, taskId)
      db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(REPO, taskId)
      db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(REPO, taskId)
      db.prepare('DELETE FROM tasks WHERE repo=? AND task_id=?').run(REPO, taskId)
    }
  })
})
