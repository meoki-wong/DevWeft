/**
 * ac-offpath-exempt.test.mjs — 观测路径豁免（判定侧与注入侧对称）
 *
 * 背景：scoped 注入模式下，考卷 pages 与本次 changed-files 无交集时不会进入 binding
 * assetLock，gate run 不执行该卷 → 永远产不出 mutation/f2p 结论；判定侧若仍要求
 * 验卷结论会形成确定性死锁（改动全是工程配置文件时 100% 复现）。
 * isSpecOnActiveBindingPath 以任务 active binding 的 assetLock 冻结清单为准豁免；
 * 旧 binding / 无 active binding / 信息不足 → 维持严格判定。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { recordSpecF2p } from '../testing/f2p.js'
import { evaluateAcCoverage, isSpecOnActiveBindingPath } from '../harness/testing-gate.js'

const AC = [{ id: 'AC-801', text: '豁免语义正确', type: 'data' }]
const FK = 'ac-offpath-test'
const BINDING = 'b-offpath-1'
const INSTANCE = 'i-offpath-1'

async function memdb({ withActiveBinding = true, assetLockSpecs = [], omitAssetLock = false } = {}) {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'ac-offpath-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  // 本测试只关心判定逻辑：最小构造 binding/instance，不级联造 snapshot/suite_plan，
  // 移除跨表 repo 一致性触发器（trg_binding_same_repo 会因缺失行抛 CROSS_REPO_REFERENCE）
  await db.prepare(`DROP TRIGGER IF EXISTS trg_binding_same_repo`).run()
  await db.exec(`
    CREATE TABLE tasks (
      repo TEXT, task_id TEXT, requirement TEXT, type TEXT, size TEXT, phase TEXT,
      completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
      meta TEXT DEFAULT '{}', author TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT,
      PRIMARY KEY (repo, task_id)
    );
  `)
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO tasks(repo, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES ('demo-app', 'T-OFFPATH-1', 'x', 'UI_DEV', 'L', 'EXECUTE', '["p"]', ?, 'alice', 't', 't')`
  ).run(JSON.stringify({ acceptance: AC }))
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
       created_at, updated_at)
     VALUES ('sp1', 'r1', ?, 'ac-offpath-test', 'test', 'e2e', 'ac-offpath-test.spec.mjs',
       ?, 1, 'active', 0, '["AC-801"]', '["views/somePage"]', 't', 't')`
  ).run(FK, 'b'.repeat(64))
  if (withActiveBinding) {
    const canonical = omitAssetLock
      ? { schemaVersion: 1 }
      : { schemaVersion: 1, assetLock: { schemaVersion: 1, specs: assetLockSpecs, sha256: 'c'.repeat(64) } }
    await db.prepare(
      `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256,
         canonical_binding_json, state, created_at)
       VALUES (?, 'r1', ?, ?, ?, 'epr-1', 'img-1', ?, 'pol-1', '["web"]', ?, ?, ?, 'active', 't')`
    ).run(BINDING, 'snap-' + BINDING, 'plan-' + BINDING, INSTANCE, 'a'.repeat(64), 'e'.repeat(64), 'f'.repeat(64), JSON.stringify(canonical))
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
         active_binding_id, status, author_principal_id, created_at, updated_at)
       VALUES (?, 'r1', 'T-OFFPATH-1', 1, 1, 'EXECUTE', 'L', 'FEATURE', ?, 'open', 'tester', 't', 't')`
    ).run(INSTANCE, BINDING)
  }
  return db
}

describe('isSpecOnActiveBindingPath 纯函数', () => {
  it('assetLock 含该卷 → true（在观测路径上）', async () => {
    const db = await memdb({ assetLockSpecs: [{ featureKey: FK }] })
    expect(await isSpecOnActiveBindingPath(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1', featureKey: FK })).toBe(true)
  })

  it('assetLock 为空 → false（改动不在其观测路径上）', async () => {
    const db = await memdb({ assetLockSpecs: [] })
    expect(await isSpecOnActiveBindingPath(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1', featureKey: FK })).toBe(false)
  })

  it('无 active binding → true（维持严格）', async () => {
    const db = await memdb({ withActiveBinding: false })
    expect(await isSpecOnActiveBindingPath(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1', featureKey: FK })).toBe(true)
  })

  it('旧 binding 无 assetLock 字段 → true（全量注入语义，维持严格）', async () => {
    const db = await memdb({ omitAssetLock: true })
    expect(await isSpecOnActiveBindingPath(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1', featureKey: FK })).toBe(true)
  })

  it('空 featureKey → true（防御）', async () => {
    const db = await memdb({ assetLockSpecs: [] })
    expect(await isSpecOnActiveBindingPath(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1', featureKey: '' })).toBe(true)
  })
})

describe('evaluateAcCoverage 观测路径豁免（端到端）', () => {
  it('改动不在观测路径：mv=0 无 f2p 也不阻塞（offPath 豁免，f2pStatus=none）', async () => {
    const db = await memdb({ assetLockSpecs: [] })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1' })
    expect(r.applicable).toBe(true)
    expect(r.missing).toEqual([]) // AC 仍算被覆盖（豁免只免验卷，不免覆盖）
    expect(r.mutationPending).toBe(false)
    expect(r.f2pStatus).toBe('none')
    expect(r.offPath).toEqual([FK])
    expect(r.f2pDetail.exemptOffPath).toBe(1)
  })

  it('在观测路径上：维持严格（mv=0 → mutationPending，无记录 → pending）', async () => {
    const db = await memdb({ assetLockSpecs: [{ featureKey: FK }] })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1' })
    expect(r.mutationPending).toBe(true)
    expect(r.f2pStatus).toBe('pending')
    expect(r.offPath).toEqual([])
  })

  it('复合：豁免卷 + 已验卷混合 → 按被要求卷聚合（ok），offPath 只记豁免卷', async () => {
    const db = await memdb({ assetLockSpecs: [{ featureKey: 'ac-offpath-verified' }] })
    await db.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
         blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
         created_at, updated_at)
       VALUES ('sp2', 'r1', 'ac-offpath-verified', 't', 'test', 'e2e', 'v.spec.mjs',
         ?, 1, 'active', 1, '["AC-801"]', '["views/somePage"]', 't', 't')`
    ).run('d'.repeat(64))
    await recordSpecF2p(db, {
      runId: 'r2', repoId: 'r1', featureKey: 'ac-offpath-verified', version: 1,
      baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'failed', snapshotResult: 'passed',
    })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1' })
    expect(r.mutationPending).toBe(false)
    expect(r.f2pStatus).toBe('ok')
    expect(r.offPath).toEqual([FK])
    expect(r.f2pDetail.ok).toBe(1)
    expect(r.f2pDetail.exemptOffPath).toBe(1)
  })

  it('无 active binding：维持严格（不豁免）', async () => {
    const db = await memdb({ withActiveBinding: false })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-OFFPATH-1' })
    expect(r.mutationPending).toBe(true)
    expect(r.f2pStatus).toBe('pending')
    expect(r.offPath).toEqual([])
  })
})
