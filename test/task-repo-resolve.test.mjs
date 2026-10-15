/**
 * task-repo-resolve.test.mjs — 方案第 1 节：resolveTaskRepo 跨租户任务查找
 *
 * 锁死行为：
 *   - 两仓同一 task_id 且不传 repo → AMBIGUOUS_TASK_REPO（禁止 ORDER BY updated_at LIMIT 1）
 *   - 传对 repo → 该仓
 *   - 传错 repo → TASK_NOT_FOUND
 *   - 未传 repo 且仅一仓命中 → 自动归属该仓
 */
import { describe, expect, it, afterAll } from 'vitest'
import db from '../db.js'
import { runTestingMigrations, ensureTenantRepo } from '../testing/migrate.js'
import { resolveTaskRepo } from '../harness/tenant-ref.js'

const SUFFIX = Date.now().toString(36)
const REPO_A = `vitest-tr-a-${SUFFIX}`
const REPO_B = `vitest-tr-b-${SUFFIX}`
const TASK = `tr-task-${SUFFIX}`

// 确保迁移（含 v33 tenant_id）已在当前测试库应用；db.js import 时通常已跑
await runTestingMigrations(db, { skipLegacyMap: true })

const repoA = (await ensureTenantRepo(db, REPO_A)).repoId
const repoB = (await ensureTenantRepo(db, REPO_B)).repoId

const insertTask = async (repo, taskId) => {
  await db.prepare(
    `INSERT INTO tasks (task_id, repo, tenant_id, requirement, type, phase, author, created_at, updated_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'FIX', 'RECEIVE', 'tester', ?, ?)`
  ).run(taskId, repo, repo, '租户解析测试', new Date().toISOString(), new Date().toISOString())
}

await insertTask(REPO_A, TASK)
await insertTask(REPO_B, TASK)

afterAll(async () => {
  // FK 顺序：业务行 → gate_modes → repositories（仓库本身被 repo_gate_modes 引用）
  await db.prepare('DELETE FROM tasks WHERE task_id = ?').run(TASK)
  await db.prepare(
    'DELETE FROM repo_gate_modes WHERE repo_id IN (SELECT repo_id FROM repositories WHERE slug IN (?, ?))'
  ).run(REPO_A, REPO_B)
  await db.prepare('DELETE FROM repositories WHERE slug IN (?, ?)').run(REPO_A, REPO_B)
})

describe('resolveTaskRepo（方案 §5.1）', () => {
  it('两仓同一 task_id 且不传 repo → AMBIGUOUS_TASK_REPO', async () => {
    const r = await resolveTaskRepo(db, { taskId: TASK, repo: null })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AMBIGUOUS_TASK_REPO')
  })

  it('传对的 repo → 该仓', async () => {
    expect(await resolveTaskRepo(db, { taskId: TASK, repo: REPO_A })).toEqual({ ok: true, repo: REPO_A })
    expect(await resolveTaskRepo(db, { taskId: TASK, repo: REPO_B })).toEqual({ ok: true, repo: REPO_B })
  })

  it('传错的 repo → TASK_NOT_FOUND', async () => {
    const r = await resolveTaskRepo(db, { taskId: TASK, repo: 'demo-app' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TASK_NOT_FOUND')
  })

  it('未传 repo 且仅一仓命中 → 归属该仓', async () => {
    const solo = `tr-solo-${SUFFIX}`
    await insertTask(REPO_A, solo)
    try {
      expect(await resolveTaskRepo(db, { taskId: solo, repo: null })).toEqual({ ok: true, repo: REPO_A })
    } finally {
      await db.prepare('DELETE FROM tasks WHERE task_id = ?').run(solo)
    }
  })

  it('未传 repo 且 0 行命中 → TASK_NOT_FOUND', async () => {
    expect((await resolveTaskRepo(db, { taskId: `nope-${SUFFIX}`, repo: null })).code).toBe('TASK_NOT_FOUND')
  })
})

describe('v33 迁移：tenant_id 落地（方案 §5.1）', () => {
  it('协作表存在 tenant_id 且回填无 NULL；tasks 有 (tenant_id, task_id) 唯一索引', async () => {
    for (const t of ['tasks', 'task_versions', 'docs', 'docs_versions', 'experiences', 'verify_reports', 'gate_loops', 'task_sessions']) {
      const cols = (await db.prepare(`PRAGMA table_info(${t})`).all()).map((c) => c.name)
      expect(cols, `${t} 应有 tenant_id`).toContain('tenant_id')
      const orphan = (await db.prepare(
        `SELECT COUNT(*) c FROM ${t} WHERE tenant_id IS NULL`
      ).get()).c
      expect(orphan, `${t} 不得有 NULL tenant_id`).toBe(0)
    }
    const idx = await db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_tasks_tenant_task'`
    ).get()
    expect(idx, 'tasks 应有 (tenant_id, task_id) 唯一索引').toBeTruthy()
  })

  it('新 INSERT 不写 tenant_id → 失败（§5.4 预期行为）', async () => {
    try {
      await db.prepare(
        `INSERT INTO docs (repo, name, content, updated_at) VALUES ('shared', 'no-tenant-probe', 'x', ?)`
      ).run(new Date().toISOString())
      throw new Error('缺 tenant_id 的 INSERT 不应成功')
    } catch (e) {
      // 触发器抛 SqliteError 而非常规断言错误——只要消息匹配即视为符合 §5.4
      if (!/tenant_id NOT NULL/.test(String(e.message))) throw e
    }
    await db.prepare(`DELETE FROM docs WHERE repo='shared' AND name='no-tenant-probe'`).run()
  })
})
