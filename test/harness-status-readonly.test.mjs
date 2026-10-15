/**
 * harness_status 默认只读：不写 gate_loops.history
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import db from '../db.js'
import { harnessStart, harnessStatus, harnessAdvance } from '../harness/state-machine.js'

const REPO = 'demo-app'
let taskId

beforeEach(async () => {
  taskId = `st-ro-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const r = await harnessStart({
    taskId,
    requirement: `status-readonly-smoke-${taskId}`,
    author: 'tester',
    repo: REPO,
    type: 'FIX',
  })
  expect(r.ok).toBe(true)
})

afterEach(async () => {
  try {
    await db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(REPO, taskId)
    await db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(REPO, taskId)
    await db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(REPO, taskId)
    await db.prepare('DELETE FROM tasks WHERE repo=? AND task_id=?').run(REPO, taskId)
  } catch { /* ignore */ }
})

describe('harness_status readonly', () => {
  it('repeated status does not grow history_json', async () => {
    // 推进到 EXECUTE 以便 status 会触发历史 sync 路径
    await harnessAdvance({ taskId, to: 'execute', data: { size: 'S', type: 'FIX' }, author: 'tester', repo: REPO })

    const before = await db.prepare('SELECT history_json, updated_at FROM gate_loops WHERE repo=? AND task_id=?').get(REPO, taskId)
    const beforeHist = JSON.parse(before?.history_json || '[]').length
    const beforeUpd = before?.updated_at

    await harnessStatus({ taskId, repo: REPO })
    await harnessStatus({ taskId, repo: REPO })
    await harnessStatus({ taskId, repo: REPO })

    const after = await db.prepare('SELECT history_json, updated_at FROM gate_loops WHERE repo=? AND task_id=?').get(REPO, taskId)
    const afterHist = JSON.parse(after?.history_json || '[]').length
    expect(afterHist).toBe(beforeHist)
    expect(after?.updated_at).toBe(beforeUpd)
  })
})
