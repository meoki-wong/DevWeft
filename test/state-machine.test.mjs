import { describe, it, expect, afterAll } from 'vitest'
import db from '../db.js'
import { harnessStart, harnessStatus, harnessAdvance } from '../harness/state-machine.js'

const REPO = 'vitest-sm'
const TASK = `vitest-sm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

afterAll(async () => {
  await db.prepare('DELETE FROM tasks WHERE repo = ? AND task_id = ?').run(REPO, TASK)
  await db.prepare('DELETE FROM task_versions WHERE repo = ? AND task_id = ?').run(REPO, TASK)
})

describe('harness 状态机（主路径）', () => {
  it('harnessStart 开启任务 → phase=RECEIVE', async () => {
    const r = await harnessStart({ taskId: TASK, requirement: '单测', type: 'FIX', author: 'tester', repo: REPO })
    expect(r.ok).toBe(true)
    expect(r.status.phase).toBe('receive')
  })

  it('RECEIVE 的下一活动可推进', async () => {
    const r = await harnessAdvance({ taskId: TASK, to: 'execute', data: { size: 'M' }, author: 'tester', repo: REPO })
    expect(r.ok).toBe(true)
    expect(r.to).toBe('execute')
  })

  it('未到的活动不能跳', async () => {
    const r = await harnessAdvance({ taskId: TASK, to: 'done', author: 'tester', repo: REPO })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ACTIVITY_MISMATCH')
  })

  it('harnessStatus 的允许跳转来自活动计划', async () => {
    const s = await harnessStatus({ taskId: TASK, repo: REPO })
    expect(s.ok).toBe(true)
    expect(s.allowedTransitions.some((t) => t.to === 'static')).toBe(true)
    expect(s.allowedTransitions.some((t) => t.to === 'aborted')).toBe(true)
    expect(s.allowedTransitions.every((t) => t.to === t.to.toLowerCase())).toBe(true)
  })

  it('推进到 smoke 后 tasks.phase=smoke，open 实例投影为 VERIFY（方案 §6.3）', async () => {
    // UI_DEV 的活动计划含 smoke；F 主路径任务不含
    const uiTask = `${TASK}-ui`
    const started = await harnessStart({ taskId: uiTask, requirement: '单测 smoke', type: 'UI_DEV', author: 'tester', repo: REPO })
    expect(started.ok, JSON.stringify(started).slice(0, 200)).toBe(true)
    // UI_DEV 计划：receive→retrieve→plan→execute→static→smoke，逐段推进
    for (const [to, data] of [['retrieve', {}], ['plan', {}], ['execute', { decisions: ['范围确认'] }]]) {
      const step = await harnessAdvance({ taskId: uiTask, to, data, author: 'tester', repo: REPO })
      expect(step.ok, JSON.stringify(step).slice(0, 200)).toBe(true)
    }
    // execute→smoke 守卫要求新鲜 L1
    await db.prepare(
      `INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
       VALUES ('smoke-l1', ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'L1', 'web', 'x.vue', 1, 0, '', 'tester', ?, ?)`
    ).run(REPO, REPO, uiTask, new Date().toISOString())
    const toStatic = await harnessAdvance({ taskId: uiTask, to: 'static', data: { size: 'M' }, author: 'tester', repo: REPO })
    expect(toStatic.ok, JSON.stringify(toStatic).slice(0, 200)).toBe(true)
    const r = await harnessAdvance({ taskId: uiTask, to: 'smoke', data: { size: 'M' }, author: 'tester', repo: REPO })
    expect(r.ok, JSON.stringify(r).slice(0, 200)).toBe(true)
    const stored = await db.prepare('SELECT phase FROM tasks WHERE repo = ? AND task_id = ?').get(REPO, uiTask)
    expect(stored.phase).toBe('smoke')
    const inst = await db.prepare(
      `SELECT phase FROM task_instances
       WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=?) AND external_task_id=? AND status='open'`
    ).get(REPO, uiTask)
    // 没有实例行时推进仍然成功；有 open 实例则其 phase 必须是旧名 VERIFY
    if (inst) expect(inst.phase).toBe('VERIFY')
    await db.prepare('DELETE FROM verify_reports WHERE id = ?').run('smoke-l1')
    await db.prepare('DELETE FROM tasks WHERE repo = ? AND task_id = ?').run(REPO, uiTask)
    await db.prepare('DELETE FROM task_versions WHERE repo = ? AND task_id = ?').run(REPO, uiTask)
    await db.prepare('DELETE FROM gate_loops WHERE repo = ? AND task_id = ?').run(REPO, uiTask)
  })

  it('MCP 视图带 allowedTransitions，且 to 与 advance 枚举一致', async () => {
    const s = await harnessStatus({ taskId: TASK, repo: REPO, view: 'mcp' })
    expect(s.allowedTransitions.some((t) => t.to === 'static')).toBe(true)
    expect(s.allowedTransitions.some((t) => t.to === 'aborted')).toBe(true)
    const advanceEnum = ['retrieve', 'plan', 'execute', 'static', 'smoke', 'distill', 'done', 'aborted']
    for (const hop of s.allowedTransitions) expect(advanceEnum).toContain(hop.to)
  })
})
