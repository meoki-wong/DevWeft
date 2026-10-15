/**
 * 任务全流程追踪（/api/testing/trace）与仓级覆盖地图（/api/testing/coverage-map）
 * 2026-09-26 运维埋点配套：只读模型，验证时间线串链与覆盖统计。
 *
 * trace 用 bootstrapTestingPlatform 前门（种齐 policy/profile/image/remote，seedGateChain 依赖），
 * coverage 用 memdb（纯统计查询，不依赖种子）。
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { memdb, seedTaskWithAc } from './helpers/memdb.mjs'
import { seedGateChain } from './helpers/submission-chain.mjs'
import { buildTaskTrace, buildCoverageMap } from '../dashboard/testing-read-model.js'

describe('buildTaskTrace 全流程时间线', () => {
  it('任务→版本→提交→run→attempt→审计串成按时间排序的一条链', async () => {
    const slug = `tr-${randomUUID().slice(0, 8)}`
    const boot = await bootstrapTestingPlatform(db, { slug, remoteUrl: `https://git.test/${slug}.git` })
    const now = new Date().toISOString()
    const taskId = `T-trace-${randomUUID().slice(0, 8)}`
    await db.prepare(
      `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, meta, author, created_at, updated_at)
       VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, '追踪测试需求', 'FIX', 'EXECUTE', '{}', 'alice', ?, ?)`
    ).run(slug, slug, taskId, now, now)
    const chain = await seedGateChain(db, {
      repoId: boot.repoId,
      taskId,
      groupStatus: 'passed',
      runs: [{ unit: 'static', side: 'na', status: 'passed' }],
    })
    await db.prepare(`UPDATE test_runs SET finished_at=? WHERE run_id=?`).run(now, chain.runIds[0])
    await db.prepare(
      `INSERT INTO task_versions(task_id, repo, tenant_id, phase, snapshot, author, created_at)
       VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'RECEIVE', '{}', 'alice', ?)`
    ).run(taskId, slug, slug, now)
    await db.prepare(
      `INSERT INTO audit_events(event_type, tool_name, method, author, repo, task_id, status, detail, created_at)
       VALUES ('harness_start_created', 'harness_start', 'mcp', 'alice', ?, ?, 'ok', 'created', ?)`
    ).run(slug, taskId, now)

    const trace = await buildTaskTrace(db, { taskId, repo: slug })
    expect(trace.task.taskId).toBe(taskId)
    expect(trace.task.author).toBe('alice')
    expect(trace.instance.taskInstanceId).toBe(chain.ti)
    expect(trace.counts.submissions).toBe(1)
    expect(trace.counts.runs).toBe(1)
    expect(trace.counts.audits).toBe(1)

    const kinds = trace.timeline.map((t) => t.kind)
    expect(kinds).toContain('task_version')
    expect(kinds).toContain('submission')
    expect(kinds).toContain('run')
    expect(kinds).toContain('run_finished')
    expect(kinds).toContain('audit')
    const ats = trace.timeline.map((t) => t.at)
    expect([...ats].sort()).toEqual(ats)
  })

  it('不存在的任务返回空 task 且不抛错', async () => {
    const trace = await buildTaskTrace(db, { taskId: `T-nope-${randomUUID().slice(0, 6)}` })
    expect(trace.task).toBeNull()
    expect(trace.timeline).toEqual([])
  })
})

describe('buildCoverageMap 仓级需求→考卷覆盖', () => {
  it('AC 覆盖统计：有卷覆盖 covered，无卷任务进 tasksWithoutSpec', async () => {
    const { db: mdb, repoId, slug, close } = await memdb()
    await seedTaskWithAc(mdb, { repoId, slug }) // AC-1 已由 spec 的 acceptance_refs 覆盖
    await seedTaskWithAc(mdb, { repoId, slug, spec: { featureKey: null, acceptanceRefs: [] } }) // 第二个任务

    const map = await buildCoverageMap(mdb, { repo: slug })
    expect(map.error).toBeUndefined()
    expect(map.totals.openTasks).toBe(2)
    const withAc = map.tasks.find((t) => t.acceptanceTotal > 0)
    expect(withAc.uncovered).toEqual([])
    expect(withAc.covered).toContain('AC-1')
    close()
  })

  it('未知仓返回显式错误而非伪造空数据', async () => {
    const { db: mdb, close } = await memdb()
    const map = await buildCoverageMap(mdb, { repo: 'nope' })
    expect(map.error).toBe('REPO_NOT_FOUND')
    close()
  })
})
