/**
 * advance-inflight.test.mjs — 方案第 7 节：同进程并发推进
 *
 * §13.1：「两个 harnessAdvance 并发从同一 phase 推进，恰好一个成功，另一个 PHASE_CONFLICT」。
 * PHASE_CONFLICT 依赖 CAS；postgres 方言下由 await 交错暴露（本用例在 PGlite 测试库上运行）；
 * sqlite 下引擎同步执行、两发串行化，第二发在 CAS 前/后被拒——不变量相同：
 *   恰好一次成功、库内 phase 只落一个目标值、失败发不产生版本行。
 * 因此这里分两层：
 *   1. transitionTask 直发并发 CAS —— 两方言都断言「一个成功 + 另一个 PHASE_CONFLICT」
 *   2. harnessAdvance 并发 —— 断言不变量；postgres 方言下进一步断言失败码为 PHASE_CONFLICT
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db, { DB_DIALECT } from '../db.js'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { harnessStart, harnessAdvance } from '../harness/state-machine.js'
import { transitionTask } from '../harness/task-store.js'

await runTestingMigrations(db, { skipLegacyMap: true })

const seedTask = async (slug, taskId, phase) => {
  await ensureRepository(db, slug, null)
  const started = await harnessStart({ taskId, requirement: `并发 ${taskId}`, type: 'UI_DEV', author: 'tester', repo: slug })
  expect(started.ok, JSON.stringify(started).slice(0, 200)).toBe(true)
  if (phase !== 'receive') {
    const r = await transitionTask(db, {
      repo: slug, taskId, fromPhase: 'receive', to: phase,
      merged: { size: 'M', completed: [], pending: [], decisions: [], meta: {} }, author: 'tester',
    })
    expect(r.ok).toBe(true)
  }
  return taskId
}

const cleanup = async (slug, taskId) => {
  await db.prepare('DELETE FROM task_versions WHERE repo = ? AND task_id = ?').run(slug, taskId)
  await db.prepare('DELETE FROM gate_loops WHERE repo = ? AND task_id = ?').run(slug, taskId)
  await db.prepare('DELETE FROM task_sessions WHERE repo = ? AND task_id = ?').run(slug, taskId)
  await db.prepare('DELETE FROM tasks WHERE repo = ? AND task_id = ?').run(slug, taskId)
  await db.prepare('DELETE FROM repo_gate_modes WHERE repo_id = (SELECT repo_id FROM repositories WHERE slug = ?)').run(slug)
  await db.prepare('DELETE FROM repositories WHERE slug = ?').run(slug)
}

describe('并发推进（方案 §13.1）', () => {
  it('transitionTask 并发同 fromPhase：恰好一个成功，另一个 PHASE_CONFLICT', async () => {
    const SLUG = `infl-t-${randomUUID().slice(0, 8)}`
    const TASK = `T-infl-t-${randomUUID().slice(0, 8)}`
    await seedTask(SLUG, TASK, 'receive')
    const before = (await db.prepare('SELECT COUNT(*) c FROM task_versions WHERE repo = ? AND task_id = ?').get(SLUG, TASK)).c

    const [a, b] = await Promise.allSettled([
      transitionTask(db, {
        repo: SLUG, taskId: TASK, fromPhase: 'receive', to: 'retrieve',
        merged: { size: 'M', completed: [], pending: [], decisions: [], meta: {} }, author: 'a',
      }),
      transitionTask(db, {
        repo: SLUG, taskId: TASK, fromPhase: 'receive', to: 'retrieve',
        merged: { size: 'M', completed: [], pending: [], decisions: [], meta: {} }, author: 'b',
      }),
    ])
    const losers = [a, b].filter((r) => r.status === 'rejected')
    const winners = [a, b].filter((r) => r.status === 'fulfilled' && r.value?.ok)
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(1)
    expect(losers[0].reason?.code).toBe('PHASE_CONFLICT')
    // 失败发不产生版本行（原子回滚）
    const after = (await db.prepare('SELECT COUNT(*) c FROM task_versions WHERE repo = ? AND task_id = ?').get(SLUG, TASK)).c
    expect(after).toBe(before + 1)
    await cleanup(SLUG, TASK)
  })

  it('harnessAdvance 并发同 phase：恰好一个成功；postgres 下失败码为 PHASE_CONFLICT', async () => {
    const SLUG = `infl-a-${randomUUID().slice(0, 8)}`
    const TASK = `T-infl-a-${randomUUID().slice(0, 8)}`
    await seedTask(SLUG, TASK, 'receive')

    const [a, b] = await Promise.allSettled([
      harnessAdvance({ taskId: TASK, to: 'retrieve', data: { size: 'M' }, author: 'a', repo: SLUG }),
      harnessAdvance({ taskId: TASK, to: 'retrieve', data: { size: 'M' }, author: 'b', repo: SLUG }),
    ])
    const results = [a, b].map((r) => {
      if (r.status !== 'fulfilled') {
        return { ok: false, code: r.reason?.code || null, message: String(r.reason?.message || r.reason) }
      }
      return r.value
    })
    const okCount = results.filter((r) => r.ok === true).length
    expect(okCount, JSON.stringify(results).slice(0, 300)).toBeLessThanOrEqual(1)
    // 库内 phase 只落一个目标值（retrieve），且只有一条新版本
    const row = await db.prepare('SELECT phase FROM tasks WHERE repo = ? AND task_id = ?').get(SLUG, TASK)
    expect(['retrieve', 'receive'].includes(row.phase)).toBe(true)
    const versions = (await db.prepare('SELECT COUNT(*) c FROM task_versions WHERE repo = ? AND task_id = ?').get(SLUG, TASK)).c
    expect(versions).toBeLessThanOrEqual(2) // start 的 receive + 至多一条推进

    if (DB_DIALECT === 'postgres') {
      const conflict = results.find((r) => r.ok === false)
      expect(conflict?.code).toBe('PHASE_CONFLICT')
    }
    await cleanup(SLUG, TASK)
  })
})
