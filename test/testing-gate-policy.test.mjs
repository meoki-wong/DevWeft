/**
 * 体量策略（requiredUnitsForTask）+ 失败经验强制沉淀（findUnsummarizedGateFailure）
 * + 门禁下单任务实例（ensureGateTaskInstance）单元测试。
 *
 * 注意：memdb 迁移后关掉 FK——本文件测查询/判定逻辑，不为 seed 数据搭整条
 * business_snapshots→suite_plans→test_bindings 外键链。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { requiredUnitsForTask, findUnsummarizedGateFailure } from '../harness/testing-gate.js'
import { ensureGateTaskInstance } from '../testing/submit-run.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-policy-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  return db
}

/** 最小 harness tasks 表（memdb 只有 testing schema；列子集够体量策略查询用） */
async function createHarnessTasksTable(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT NOT NULL, repo TEXT NOT NULL, size TEXT, type TEXT,
    PRIMARY KEY (repo, task_id)
  )`)
}

async function insertHarnessTask(db, { taskId, repo = 'demo-app', size = 'M', type = 'FEATURE' }) {
  await db.prepare('INSERT INTO tasks(task_id, repo, size, type) VALUES (?, ?, ?, ?)').run(taskId, repo, size, type)
}

describe('requiredUnitsForTask 体量策略', () => {
  it('S 级只跑静态扫描', () => {
    expect(requiredUnitsForTask({ size: 'S', type: 'UI_DEV' })).toEqual(['static:na'])
    expect(requiredUnitsForTask({ size: 'S', type: null })).toEqual(['static:na'])
  })

  it('M 级未声明端时不默认双侧冒烟', () => {
    for (const type of ['UI_DEV', 'FEATURE', 'INTEGRATION']) {
      expect(requiredUnitsForTask({ size: 'M', type })).toEqual(['static:na'])
    }
    for (const type of ['FIX', 'RELEASE', null]) {
      expect(requiredUnitsForTask({ size: 'M', type })).toEqual(['static:na'])
    }
  })

  it('L 级未声明端时只有 static', () => {
    expect(requiredUnitsForTask({ size: 'L', type: 'FIX' })).toEqual(['static:na'])
    expect(requiredUnitsForTask({ size: 'L', type: 'FIX', sides: ['web', 'admin'] })).toEqual(['static:na', 'smoke:web', 'smoke:admin'])
  })

  it('未知体量返回空', () => {
    expect(requiredUnitsForTask({ size: 'X', type: 'FEATURE' })).toEqual([])
    expect(requiredUnitsForTask({})).toEqual([])
  })
})

describe('findUnsummarizedGateFailure 失败经验强制沉淀', () => {
  async function seedGateRun(db, { status, finishedAt }) {
    const repoId = await ensureRepository(db, 'demo-app', 'p1')
    const now = new Date().toISOString()
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status,
         author_principal_id, created_at, updated_at)
       VALUES ('ti-1', ?, 'T-POLICY', 1, 1, 'EXECUTE', 'M', 'open', 'p1', ?, ?)`
    ).run(repoId, now, now)
    await db.prepare(
      'INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at) VALUES (?, ?, ?, ?)'
    ).run(repoId, 'T-POLICY', 'ti-1', now)
    await db.prepare(
      `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
         binding_id, expected_task_revision, status, created_at, finished_at)
       VALUES ('sub-1', 'c-1', 'p1', ?, 'ti-1', 'b-1', 1, ?, ?, ?)`
    ).run(repoId, status, now, finishedAt)
    await db.prepare(
      `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
         required_units_json, status, created_at)
       VALUES ('rg-1', ?, 'sub-1', 'b-1', 'formal', 1, '[]', ?, ?)`
    ).run(repoId, status, now)
    return repoId
  }

  it('最近 formal 组 failed 且无晚于失败的经验 → 返回拦截信息', async () => {
    const db = await memdb()
    await seedGateRun(db, { status: 'failed', finishedAt: '2026-09-08T10:00:00Z' })
    // 补列模拟生产 experiences 结构（db.js 版带 task_id）
    await db.exec('ALTER TABLE experiences ADD COLUMN task_id TEXT')
    const hit = await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-POLICY' })
    expect(hit?.run_group_id).toBe('rg-1')
  })

  it('experiences 表无 task_id 列（v8 版结构差异）→ 降级放行不卡死', async () => {
    const db = await memdb()
    await seedGateRun(db, { status: 'failed', finishedAt: '2026-09-08T10:00:00Z' })
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-POLICY' })).toBeNull()
  })

  it('失败后已写本任务经验 → 放行', async () => {
    const db = await memdb()
    const repoId = await seedGateRun(db, { status: 'failed', finishedAt: '2026-09-08T10:00:00Z' })
    // memdb 的 experiences 是 schema-v8 版（无 task_id 列），补列模拟生产 db.js 版结构
    await db.exec('ALTER TABLE experiences ADD COLUMN task_id TEXT')
    await db.prepare(
      `INSERT INTO experiences(experience_id, repo_id, title, content, source_type, source_id,
         created_at, updated_at, task_id)
       VALUES ('e-1', ?, 't', 'c', 'test_failure', 'rg-1', '2026-09-08T11:00:00Z', '2026-09-08T11:00:00Z', 'T-POLICY')`
    ).run(repoId)
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-POLICY' })).toBeNull()
  })

  it('最近组 passed / 无组 → 放行', async () => {
    const db = await memdb()
    await seedGateRun(db, { status: 'passed', finishedAt: '2026-09-08T10:00:00Z' })
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-POLICY' })).toBeNull()
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-NONE' })).toBeNull()
  })
})

describe('ensureGateTaskInstance 下单任务实例', () => {
  it('无实例时按 harness tasks 表的真实 size/type 创建 + 建立 legacy 映射', async () => {
    const db = await memdb()
    await createHarnessTasksTable(db)
    await insertHarnessTask(db, { taskId: 'T-NEW', size: 'L', type: 'UI_DEV' })
    const repoId = await ensureRepository(db, 'demo-app', 'p1')
    const { task, created } = await ensureGateTaskInstance(db, {
      repoId, repoSlug: 'demo-app', taskId: 'T-NEW', principalId: 'p1',
    })
    expect(created).toBe(true)
    expect(task.size).toBe('L')
    expect(task.type).toBe('UI_DEV')
    expect(task.revision).toBe(1)
    const mapping = await db.prepare(
      'SELECT task_instance_id FROM legacy_task_mappings WHERE repo_id=? AND legacy_task_id=?'
    ).get(repoId, 'T-NEW')
    expect(mapping.task_instance_id).toBe(task.task_instance_id)
  })

  it('幂等：已有 open 实例直接复用不新建', async () => {
    const db = await memdb()
    await createHarnessTasksTable(db)
    await insertHarnessTask(db, { taskId: 'T-IDEM', size: 'M', type: 'FIX' })
    const repoId = await ensureRepository(db, 'demo-app', 'p1')
    const first = await ensureGateTaskInstance(db, { repoId, repoSlug: 'demo-app', taskId: 'T-IDEM', principalId: 'p1' })
    const second = await ensureGateTaskInstance(db, { repoId, repoSlug: 'demo-app', taskId: 'T-IDEM', principalId: 'p1' })
    expect(second.created).toBe(false)
    expect(second.task.task_instance_id).toBe(first.task.task_instance_id)
  })

  it('仅有 closed 实例时 epoch 递增重开并重指映射；无 harness 记录回落 M', async () => {
    const db = await memdb()
    await createHarnessTasksTable(db)
    const repoId = await ensureRepository(db, 'demo-app', 'p1')
    const now = new Date().toISOString()
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status,
         author_principal_id, created_at, updated_at)
       VALUES ('ti-old', ?, 'T-REOPEN', 1, 3, 'DONE', 'S', 'done', 'p1', ?, ?)`
    ).run(repoId, now, now)
    await db.prepare(
      'INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at) VALUES (?, ?, ?, ?)'
    ).run(repoId, 'T-REOPEN', 'ti-old', now)
    const { task, created } = await ensureGateTaskInstance(db, {
      repoId, repoSlug: 'demo-app', taskId: 'T-REOPEN', principalId: 'p1',
    })
    expect(created).toBe(true)
    expect(task.epoch).toBe(2)
    expect(task.size).toBe('M') // 无 harness 记录回落
    const mapping = await db.prepare(
      'SELECT task_instance_id FROM legacy_task_mappings WHERE repo_id=? AND legacy_task_id=?'
    ).get(repoId, 'T-REOPEN')
    expect(mapping.task_instance_id).toBe(task.task_instance_id)
  })
})
