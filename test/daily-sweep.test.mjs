/**
 * 每日 05:00 例行清理（2026-09-26 决策）：
 * 1. computeNextRunAt 本地时区下次 5 点计算
 * 2. dailySweepUnfinishedTasks：结束所有未完成任务（终态不动）；forceStopTask 链路
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { computeNextRunAt, dailySweepUnfinishedTasks } from '../harness/stop-task.js'

async function seedTask(phase) {
  const taskId = `T-sweep-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, completed, pending, decisions, meta, author, created_at, updated_at)
     VALUES ('demo-app', (SELECT repo_id FROM repositories WHERE slug = 'demo-app'), ?, '清扫测试任务', 'FIX', ?, '[]', '[]', '[]', '{}', 'tester', ?, ?)`
  ).run(taskId, phase, now, now)
  return taskId
}

describe('computeNextRunAt（每日 5 点，本地时区）', () => {
  it('当日未到 5 点 → 当天 05:00', () => {
    const next = computeNextRunAt(new Date(2026, 8, 26, 3, 30, 0), 5)
    expect(next.getDate()).toBe(26)
    expect(next.getHours()).toBe(5)
    expect(next.getMinutes()).toBe(0)
  })
  it('当日已过 5 点 → 明天 05:00', () => {
    const next = computeNextRunAt(new Date(2026, 8, 26, 6, 0, 0), 5)
    expect(next.getDate()).toBe(27)
    expect(next.getHours()).toBe(5)
  })
  it('恰好 05:00 整 → 明天（不重复执行）', () => {
    const next = computeNextRunAt(new Date(2026, 8, 26, 5, 0, 0), 5)
    expect(next.getDate()).toBe(27)
  })
})

describe('dailySweepUnfinishedTasks', () => {
  it('所有未完成任务被结束（ABORTED + closed_at），终态任务不动', async () => {
    const open1 = await seedTask('execute')
    const open2 = await seedTask('plan')
    const done = await seedTask('done')
    const aborted = await seedTask('aborted')

    const res = await dailySweepUnfinishedTasks({ destroyVm: false, reason: '测试清扫' })
    expect(res.swept).toBeGreaterThanOrEqual(2)

    const get = async (id) => await db.prepare('SELECT phase, closed_at, meta FROM tasks WHERE repo=? AND task_id=?').get('demo-app', id)
    for (const id of [open1, open2]) {
      const row = await get(id)
      expect(row.phase).toBe('aborted')
      expect(row.closed_at).toBeTruthy()
      expect(JSON.parse(row.meta).abortReason).toContain('测试清扫')
    }
    expect((await get(done)).phase).toBe('done')
    expect((await get(aborted)).phase).toBe('aborted')

    const audit = await db.prepare(
      `SELECT COUNT(*) c FROM audit_events WHERE event_type='task_stopped' AND detail LIKE '%测试清扫%'`
    ).get()
    expect(audit.c).toBeGreaterThanOrEqual(2)
  })

  it('清扫幂等：连续两次第二次 swept 为 0（无未完成任务）', async () => {
    const before = await dailySweepUnfinishedTasks({ destroyVm: false })
    const again = await dailySweepUnfinishedTasks({ destroyVm: false })
    expect(again.swept).toBe(0)
    expect(before.swept).toBeGreaterThanOrEqual(0)
  })
})
