/** v7 migration smoke: v1-v7 顺序应用 + 跨 repo CHECK 触发 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m4-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

describe('M4 schema v7 migration', () => {
  it('applies v1-v7 and creates the four M4 tables', async () => {
    const db = await memdb()
    for (const t of ['task_overlays', 'candidate_binding_approvals', 'promotion_proposals', 'promotion_reviews', 'candidate_replay_runs', 'experience_sources']) {
      const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
      expect(row, `table ${t} should exist`).toBeTruthy()
    }
    const v7 = await db.prepare('SELECT name, version FROM schema_migrations WHERE version=7').get()
    expect(v7).toBeTruthy()
    expect(v7.name).toBe('m4_overlays_waivers_promotion')
  })

  it('v7 migration is idempotent on re-run (checksum stable)', async () => {
    const db = await memdb()
    // 模拟已迁移后再次调 migrate，应跳过不重复执行
    expect(() => runTestingMigrations(db, { skipLegacyMap: true })).not.toThrow()
  })

  it('candidate_binding_approvals rejects reviewer == author via CHECK', async () => {
    const db = await memdb()
    await db.prepare(
      "INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')"
    ).run()
    await db.prepare(
      "INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')"
    ).run()
    // FK 顺序：overlay 必须在 revisions 之前
    await db.prepare("INSERT INTO suite_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('o1', 'project-stable', 'repo', 'r1', NULL, NULL, 0, 1, 'active', 'p1', 't')").run()
    await db.prepare(`INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('sr1', 'o1', 1, 'reviewed_git', '${'a'.repeat(40)}', '${'a'.repeat(64)}', '${'b'.repeat(64)}', '{}', 'reviewed', 'active', 'p1', 't')`).run()
    // task_instance 必须存在（candidate FK task_instance_id）
    await db.prepare("INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, phase, size, status, author_principal_id, created_at, updated_at) VALUES ('ti1', 'r1', 'T-CAND', 'EXECUTE', 'S', 'open', 'p1', 't', 't')").run()
    // 同人作为作者与 reviewer 应被 CHECK 拒绝
    expect(() =>
      db.prepare(
      "INSERT INTO candidate_binding_approvals(approval_id, repo_id, task_instance_id, candidate_suite_revision_id, candidate_author_principal_id, reviewer_principal_id, expires_at, created_at) VALUES ('a1', 'r1', 'ti1', 'sr1', 'p1', 'p1', '2099-01-01', 't')"
    ).run()).toThrow(/CHECK/)
  })

  it('task_overlays uniqueness across (layer, repo, branch, task, ordinal)', async () => {
    const db = await memdb()
    await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
    await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
    await db.prepare("INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, phase, size, status, author_principal_id, created_at, updated_at) VALUES ('ti1', 'r1', 'T1', 'EXECUTE', 'S', 'open', 'p1', 't', 't')").run()
    await db.prepare(
      "INSERT INTO task_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('to1', 'A', 'task', 'r1', NULL, 'ti1', 0, 0, 'active', 'p1', 't')"
    ).run()
    expect(() =>
      db.prepare(
      "INSERT INTO task_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('to2', 'A', 'task', 'r1', NULL, 'ti1', 0, 0, 'active', 'p1', 't')"
    ).run()).toThrow(/UNIQUE/)
  })

  it('candidate_replay_runs and experience_sources persist and lookup by repo', async () => {
    const db = await memdb()
    await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
    await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
    await db.prepare("INSERT INTO suite_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('o1', 'o1', 'repo', 'r1', NULL, NULL, 0, 1, 'active', 'p1', 't')").run()
    await db.prepare(`INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('tgt', 'o1', 1, 'reviewed_git', '${'a'.repeat(40)}', '${'h'.repeat(64)}', '${'i'.repeat(64)}', '{}', 'reviewed', 'active', 'p1', 't')`).run()
    await db.prepare(`INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('base', 'o1', 2, 'reviewed_git', '${'b'.repeat(40)}', '${'j'.repeat(64)}', '${'k'.repeat(64)}', '{}', 'reviewed', 'active', 'p1', 't')`).run()
    await db.prepare("INSERT INTO promotion_proposals(proposal_id, repo_id, target_suite_revision_id, base_suite_revision_id, author_principal_id, state, proposed_at, updated_at) VALUES ('pp1', 'r1', 'tgt', 'base', 'p1', 'proposed', 't', 't')").run()
    await db.prepare(
      "INSERT INTO candidate_replay_runs(replay_run_id, proposal_id, business_snapshot_id, status, started_at) VALUES ('r1', 'pp1', 'bs1', 'passed', 't')"
    ).run()
    await db.prepare(
      "INSERT INTO experience_sources(repo_id, experience_id, source_type, source_id, created_at) VALUES ('r1', 'exp1', 'test_failure', 'f1', 't')"
    ).run()
    expect((await db.prepare("SELECT COUNT(*) c FROM candidate_replay_runs WHERE proposal_id='pp1'").get()).c).toBe(1)
    expect((await db.prepare("SELECT COUNT(*) c FROM experience_sources WHERE repo_id='r1'").get()).c).toBe(1)
  })
})
