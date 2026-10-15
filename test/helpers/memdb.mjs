/**
 * test/helpers/memdb.mjs — 共享测试数据库工厂（阶段 0 测试地基）
 *
 * 目标：
 *  1. 每个 memdb() 拿到独立临时文件库（真实迁移 + 真实外键约束），测试互不污染；
 *  2. slug 默认随机化，根除「测试手插 repositories 撞唯一约束」这一类跨文件冲突；
 *  3. 数据只经前门（服务函数）或显式 seed 构造，禁止在新测试里裸 INSERT 业务表。
 *
 * 迁移不再自动 seed 默认租户（seedDefaultTenantRepos 已移至 db.js 生产启动路径），
 * 因此这里显式 ensureRepository，并返回 repoId 供后续 FK 使用。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations, ensureRepository } from '../../testing/migrate.js'

/** 建一个独立临时库：真实迁移 + 外键约束，不触碰真实 team.db */
export async function memdb({ slug = null, migrate = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'awp-memdb-'))
  const db = new Database(join(dir, 't.db'))
  db.pragma('foreign_keys = ON')
  if (migrate) await runTestingMigrations(db, { skipLegacyMap: true })
  const usedSlug = slug || `t-${randomUUID().slice(0, 8)}`
  const principalId = await seedPrincipal(db)
  const repoId = await ensureRepository(db, usedSlug, principalId)
  const close = () => {
    try { db.close() } catch { /* already closed */ }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return { db, repoId, slug: usedSlug, principalId, close }
}

/** 种一个可复用的 principal（测试作者/评审者基础身份） */
export async function seedPrincipal(db, subject = null) {
  const used = subject || `tester-${randomUUID().slice(0, 8)}`
  const existing = await db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(used)
  if (existing) return existing.principal_id
  const id = randomUUID()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).run(id, used, used, now, now)
  return id
}

/**
 * 种一个「带冻结 AC + active 考卷」的任务，供门禁终审矩阵使用：
 * 覆盖 harness tasks 表（AC 冻结在 tasks.meta.acceptance）与 test_specs（acceptance_refs 引用 AC）。
 */
export async function seedTaskWithAc(db, {
  repoId,
  taskId,
  slug,
  ac = [{ id: 'AC-1', text: '示例验收标准', type: 'data' }],
  spec = { featureKey: null, acceptanceRefs: ['AC-1'], mutationVerified: 0, specType: 'e2e', side: 'web' },
} = {}) {
  const now = new Date().toISOString()
  const usedTaskId = taskId || `T-${randomUUID().slice(0, 8)}`
  const usedKey = spec.featureKey || `fk-${randomUUID().slice(0, 8)}`
  const authorId = await seedPrincipal(db, 'task-author')
  // tasks 表属 db.js 基础层（testing 迁移不含）；独立测试库按最小列补建（与 db.js 同构子集）
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      repo TEXT, task_id TEXT, requirement TEXT, type TEXT, size TEXT, phase TEXT,
      completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
      meta TEXT DEFAULT '{}', author TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT,
      PRIMARY KEY (repo, task_id)
    );
  `)
  await db.prepare(
    `INSERT INTO tasks(repo, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES (?, ?, 'x', 'UI_DEV', 'M', 'EXECUTE', '["p"]', ?, 'alice', ?, ?)`
  ).run(slug, usedTaskId, JSON.stringify({ acceptance: ac }), now, now)
  // legacy_task_mappings / task_instances：门禁评估经由 task_instance 寻址
  const taskInstanceId = randomUUID()
  await db.prepare(
    `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'M', 'open', ?, ?, ?)`
  ).run(taskInstanceId, repoId, usedTaskId, authorId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)`
  ).run(repoId, usedTaskId, taskInstanceId, now)
  const specId = randomUUID()
  const fakeSha = 'a'.repeat(64)
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', ?, ?, ?, 1, 'active', ?, ?, NULL, ?, ?)`
  ).run(specId, repoId, usedKey, usedKey, spec.specType || 'e2e', `${usedKey}.spec.mjs`, fakeSha,
    spec.mutationVerified ? 1 : 0, JSON.stringify(spec.acceptanceRefs || ['AC-1']), now, now)
  return { taskId: usedTaskId, featureKey: usedKey, specId, taskInstanceId }
}
