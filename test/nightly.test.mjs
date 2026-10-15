/**
 * 夜间全量回归（2026-09-26）：
 * 1. isNightlyRun 变异排期排除（核心：全量全绿不得自动排 N 个变异 run）
 * 2. 每日05:00清扫豁免 nightly 任务
 * 3. runNightlyRegression 推进链 + meta.nightly 标记（无工作区仓 → SUBMIT_FAILED 确定性失败）
 * 4. nightly 报告
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { seedGateChain } from './helpers/submission-chain.mjs'
import { isNightlyRun } from '../testing/leases.js'
import { dailySweepUnfinishedTasks } from '../harness/stop-task.js'
import { runNightlyRegression, NIGHTLY_TASK_PREFIX } from '../testing/nightly.js'
import { buildNightlyReport } from '../dashboard/testing-read-model.js'

const slug = `nb-${randomUUID().slice(0, 8)}`
let boot = null

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug, remoteUrl: `https://git.test/${slug}.git` })
})

describe('isNightlyRun（变异排期排除的前提判定）', () => {
  it('meta.nightly=1 的任务 run → true；普通任务 run → false', async () => {
    const nightlyTask = `nightly-${randomUUID().slice(0, 8)}`
    const normalTask = `T-normal-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    for (const [tid, nightly] of [[nightlyTask, true], [normalTask, false]]) {
      await db.prepare(
        `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, meta, author, created_at, updated_at)
         VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'FIX', 'execute', ?, 'sys', ?, ?)`
      ).run(slug, slug, tid, JSON.stringify(nightly ? { nightly: true } : {}), now, now)
      const chain = await seedGateChain(db, { repoId: boot.repoId, taskId: tid, groupStatus: 'passed', runs: [{ unit: 'static', side: 'na', status: 'passed' }] })
      expect(await isNightlyRun(db, chain.runIds[0])).toBe(nightly)
    }
  })

  it('查询不到归属（孤儿 run）按 false 处理，不抛错', async () => {
    expect(await isNightlyRun(db, `run-nope-${randomUUID()}`)).toBe(false)
  })
})

describe('每日05:00清扫对 nightly 豁免', () => {
  it('nightly 任务不被清扫，普通任务正常结束', async () => {
    const nightlyTask = `${NIGHTLY_TASK_PREFIX}${randomUUID().slice(0, 8)}`
    const normalTask = `T-sweep-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    for (const tid of [nightlyTask, normalTask]) {
      await db.prepare(
        `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, meta, author, created_at, updated_at)
         VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'FIX', 'execute', '{}', 'sys', ?, ?)`
      ).run(slug, slug, tid, now, now)
    }
    await dailySweepUnfinishedTasks({ destroyVm: false })
    const get = async (id) => await db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(slug, id)
    expect((await get(normalTask)).phase).toBe('aborted')
    expect((await get(nightlyTask)).phase).toBe('execute') // 豁免：由下一轮 nightly 清理
  })
})

describe('runNightlyRegression 推进链', () => {
  it('合成任务推进到 execute + meta.nightly 标记 + 无工作区仓确定性 SUBMIT_FAILED', async () => {
    const r = await runNightlyRegression({ repoSlug: slug })
    // 该测试仓没有配置门禁工作区 → submitGateRun 确定性失败；推进链与标记必须已生效
    expect(r.ok).toBe(false)
    expect(r.code).toBe('SUBMIT_FAILED')
    const row = await db.prepare('SELECT phase, meta FROM tasks WHERE repo=? AND task_id=?').get(slug, r.taskId || `${NIGHTLY_TASK_PREFIX}${new Date().toISOString().slice(0, 10)}`)
    expect(row.phase).toBe('execute')
    expect(JSON.parse(row.meta).nightly).toBe(true)

    const report = await buildNightlyReport(db, { repoSlug: slug })
    expect(report.tasks.length).toBeGreaterThanOrEqual(1)
    expect(report.tasks[0].taskId.startsWith(NIGHTLY_TASK_PREFIX)).toBe(true)
  })

  it('连续两次启动：上一轮被清理（forceStop）', async () => {
    const first = await runNightlyRegression({ repoSlug: slug })
    const firstTaskId = first.taskId
    const second = await runNightlyRegression({ repoSlug: slug })
    expect(second.cleanedPrev).toBeGreaterThanOrEqual(1)
    const prevRow = await db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(slug, firstTaskId)
    expect(prevRow.phase).toBe('aborted')
  })
})
