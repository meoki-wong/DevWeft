/**
 * 个人效能反馈 + 平台状态自助页 + nightly 报告（2026-09-26）
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { memdb, seedPrincipal } from './helpers/memdb.mjs'
import { ensureGateLoop, updateGateLoop } from '../harness/loop.js'
import { buildDevStats, buildPlatformStatus } from '../dashboard/testing-read-model.js'

describe('buildDevStats 个人效能（成长反馈口径）', () => {
  it('一次过/平均迭代/经验贡献按作者聚合', async () => {
    const author = `dev-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const mk = async (phase, iteration) => {
      const taskId = `T-st-${randomUUID().slice(0, 8)}`
      const repo = `st-${randomUUID().slice(0, 8)}`
      await ensureRepository(db, repo, 'system')
      await db.prepare(
        `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, meta, author, created_at, updated_at)
         VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'FIX', ?, '{}', ?, ?, ?)`
      ).run(repo, repo, taskId, phase, author, now, now)
      try {
        await ensureGateLoop(db, { repo, taskId })
        await updateGateLoop(db, { repo, taskId, patch: { iteration } })
      } catch { /* loop 表可选 */ }
      return { taskId, repo }
    }
    await mk('DONE', 1)   // 一次过
    await mk('DONE', 3)   // 多轮
    await mk('ABORTED', 1)
    await mk('EXECUTE', 0)
    await ensureRepository(db, 'r', 'system')
    await db.prepare(
      `INSERT INTO experiences(id, repo, tenant_id, content, source, status, category, author, created_at, updated_at)
       VALUES (?, 'r', (SELECT repo_id FROM repositories WHERE slug = 'r'), '经验一条', 'manual', 'reviewed', 'dev', ?, ?, ?)`
    ).run(`exp-${randomUUID().slice(0, 8)}`, author, now, now)

    const s = await buildDevStats(db, { author, days: 30 })
    expect(s.tasks.started).toBe(4)
    expect(s.tasks.done).toBe(2)
    expect(s.tasks.aborted).toBe(1)
    expect(s.tasks.inProgress).toBe(1)
    expect(s.tasks.firstPass).toBe(1)
    expect(s.tasks.firstPassRate).toBe(50)
    expect(s.tasks.avgIterations).toBe(2)
    expect(s.distills).toBe(1)
    expect(s.team.started).toBeGreaterThanOrEqual(4)
  })

  it('缺 author 显式报错', async () => {
    expect((await buildDevStats(db, {})).error).toBe('AUTHOR_REQUIRED')
  })
})

describe('buildPlatformStatus 平台状态聚合', () => {
  it('聚合 worker/队列/清扫/夜间/迁移信号，缺失表容错', async () => {
    const { db: mdb, close } = await memdb()
    const s = await buildPlatformStatus(mdb, { lanhu: { configured: true } })
    expect(s.version).toBe(1)
    expect(s.workers.active).toBe(0) // memdb 有 workers 表（迁移）
    expect(s.runs.queued).toBe(0)
    expect(s.lanhu.configured).toBe(true)
    expect(s.ops.lastDailySweepAt).toBeNull()
    close()
  })

  it('有数据时反映真实信号', async () => {
    const { db: mdb, repoId, close } = await memdb()
    await mdb.prepare(
      `INSERT INTO workers(worker_id, certificate_thumbprint, capabilities_json, hostname, status, last_heartbeat_at, created_at)
       VALUES ('w-test', ?, '{}', 'host', 'active', ?, ?)`
    ).run(randomUUID(), new Date().toISOString(), new Date().toISOString())
    const s = await buildPlatformStatus(mdb, {})
    expect(s.workers.active).toBe(1)
    expect(s.workers.lastHeartbeatAt).toBeTruthy()
    close()
  })
})
