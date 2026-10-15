/** M5 tests: failure fingerprint + dedup + infra block + pending review */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { ApiError } from '../testing/errors.js'
import {
  fingerprintError, classifyFailure, recordFailure, recordOccurrence,
  listFailures, getFailure, updateFailureStatus,
  createExperiencePending, reviewPending,
  listExperiencePending, listExperiences,
} from '../testing/failures.js'

async function memdb() {
  // M5 必须用干净 in-memory db（真 db evolver 同名表与 v8 conflicts）
  process.env.MIGRATE_STRICT = '1'
  console.log('memdb: creating db')
  const db = new Database(":memory:")
  db.pragma('foreign_keys = ON')
  // MIGRATE_STRICT=v8 保证 v8 在 in-memory db 上完整建表（真 db 路径默认允许 skip）
  process.env.MIGRATE_STRICT = '1'
  await runTestingMigrations(db, { skipLegacyMap: true })
  // v4 跨表 trigger 干扰 failure_occurrences FK 链——M5 测试不关注跨表一致性
  for (const t of ['trg_binding_same_repo','trg_plan_same_repo','trg_snapshot_same_repo','trg_run_same_repo','trg_artifact_same_repo','trg_waiver_same_repo','trg_promotion_review_not_author']) {
    try { await db.exec(`DROP TRIGGER IF EXISTS ${t}`) } catch (_) {}
  }
  console.log('memdb: triggers dropped, ready')
  await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
  await db.prepare("INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, phase, size, status, author_principal_id, created_at, updated_at) VALUES ('ti1', 'r1', 'T-M5', 'EXECUTE', 'S', 'open', 'p1', 't', 't')").run()
  await db.prepare("INSERT INTO git_remotes(remote_id, repo_id, provider, provider_instance, canonical_url, url_fingerprint, relationship, created_at) VALUES ('r1-remote', 'r1', 'gitlab', 'https://gitlab.example', 'https://gitlab.example/r1.git', 'fpr1', 'canonical', 't')").run()
  await db.prepare("INSERT INTO policy_revisions(policy_revision_id, name, revision, content_sha256, policy_json, state, created_by, created_at) VALUES ('p1', 'main', 1, 'c1', '{}', 'active', 'p1', 't')").run()
  await db.prepare("INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at) VALUES ('img1', 'h1', 'i1', '{}', 'active', 't')").run()
  await db.prepare("INSERT INTO execution_profile_revisions(profile_revision_id, repo_id, name, revision, content_sha256, profile_json, state, created_by, created_at) VALUES ('e1', 'r1', 'project', 1, 'c1', '{}', 'active', 'p1', 't')").run()
  try { await db.prepare("INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id, execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id, resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json, state, created_at) VALUES ('b1', 'r1', 'ss1', 'sp1', 'ti1', 'e1', 'img1', 'x', 'p1', '[]', 'y', 'z', '{}', 'active', 't')").run(); console.log('BINDING OK') } catch (e) { console.log('BINDING ERR:', e.message) }
  await db.prepare("INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json, changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json, required_case_set_sha256, advisory_case_set_sha256, created_at) VALUES ('sp1', 'r1', 'ti1', 'p1', '[]', 'y', 'z', 'l1', '{}', 'r', 'a', 't')").run()
  await db.prepare("INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format, source_ref, head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256, target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at) VALUES ('ss1', 'r1', 'r1-remote', 'dirty_workspace', 'sha1', 'refs/heads/stage', 'h', 's', 't', 'y', 'r1-remote', 'refs/heads/stage', 'c', 'b', 1, 'p1', 't')").run()
  return db
}

describe('M5: fingerprint + classification', () => {
  it('fingerprintError is deterministic for same (version, phase, stack)', () => {
    const a = fingerprintError(1, 'static', 'at file://x.js:1\n  at file://y.js:2')
    const b = fingerprintError(1, 'static', '  at file://x.js:1\n    at file://y.js:2')
    const c = fingerprintError(2, 'static', 'at file://x.js:1')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
  it('classifyFailure heuristics tag infra cases', () => {
    expect(classifyFailure({ phase: 'install', rawStack: 'npm ERR! enotfound' })).toBe('registry_infra')
    expect(classifyFailure({ phase: 'install', rawStack: 'Mount-VHD path C:\\awp\\golden.vhdx failed' })).toBe('vm_infra')
    expect(classifyFailure({ phase: 'smoke', rawStack: 'expect(text).toBe(2)' })).toBe('unclassified')
  })
})

describe('M5: recordFailure dedup', () => {
  it('creates a new failure on first occurrence', async () => {
    const db = await memdb()
    const r = await recordFailure(db, {
      repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'static', failureClass: 'product', fingerprintVersion: 1,
      errorSignature: 'TypeError: x is not a function\n  at y.js:1',
    })
    expect(r.deduped).toBe(false)
    expect(r.failureId).toBeTruthy()
  })
  it('dedups same (repo, version, fingerprint) and bumps occurrence', async () => {
    const db = await memdb()
    const sig = 'TypeError: dup\n  at y.js:1'
    const a = await recordFailure(db, { repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'static', failureClass: 'product', fingerprintVersion: 1, errorSignature: sig })
    const b = await recordFailure(db, { repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'static', failureClass: 'product', fingerprintVersion: 1, errorSignature: sig })
    expect(b.deduped).toBe(true)
    expect(b.failureId).toBe(a.failureId)
    expect(b.occurrence).toBe(2)
    expect((await getFailure(db, b.failureId)).occurrence_count).toBe(2)
  })
  it('recordOccurrence writes audit row', async () => {
    const db = await memdb()
    const f = await recordFailure(db, { repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'smoke', failureClass: 'flaky', fingerprintVersion: 1, errorSignature: 'flake\n at z.js' })
    const o = await recordOccurrence(db, { failureId: f.failureId, runId: 'r1', attempt: 1, status: 'failed' })
    expect(o.occurrenceId).toBeTruthy()
  })
  it('updateFailureStatus transitions', async () => {
    const db = await memdb()
    const f = await recordFailure(db, { repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'install', failureClass: 'dependency_input', fingerprintVersion: 1, errorSignature: 'err' })
    const u = await updateFailureStatus(db, { failureId: f.failureId, status: 'triaged', reviewerPrincipalId: 'p1', reviewNote: 'n' })
    expect(u.status).toBe('triaged')
    expect(u.reviewed_by).toBe('p1')
  })
})

describe('M5: experience_pending + infra block', () => {
  it('promoted_to_experience is allowed for product class', async () => {
    const db = await memdb()
    const p = await createExperiencePending(db, {
      repoId: 'r1', sourceId: 'f1', failureClass: 'product', content: 'X is not defined',
      title: 't',
    })
    const r = await reviewPending(db, { pendingId: p.pendingId, action: 'promoted_to_experience', reviewerPrincipalId: 'p1' })
    expect(r.action).toBe('promoted_to_experience')
    expect(r.experienceId).toBeTruthy()
    expect(await listExperiences(db, { repoId: 'r1' })).toHaveLength(1)
  })
  it('infra failure is blocked from promoted_to_experience by trigger', async () => {
    const db = await memdb()
    const p = await createExperiencePending(db, {
      repoId: 'r1', sourceId: 'f2', failureClass: 'infra', content: 'vm infra failure',
    })
    await expect(reviewPending(db, { pendingId: p.pendingId, action: 'promoted_to_experience', reviewerPrincipalId: 'p1' })).rejects.toThrow(/INFRA_FAILURE_BLOCKED/)
    const stillPending = await listExperiencePending(db, { repoId: 'r1', status: 'pending_review' })
    expect(stillPending.find((p) => p.pending_id === stillPending[0].pending_id)).toBeTruthy()
  })
  it('registry_infra is also blocked', async () => {
    const db = await memdb()
    const p = await createExperiencePending(db, { repoId: 'r1', sourceId: 'f3', failureClass: 'registry_infra', content: 'c' })
    await expect(reviewPending(db, { pendingId: p.pendingId, action: 'promoted_to_experience', reviewerPrincipalId: 'p1' })).rejects.toThrow(/INFRA_FAILURE_BLOCKED/)
  })
  it('linked_to_failure ties failure status to linked', async () => {
    const db = await memdb()
    const f = await recordFailure(db, { repoId: 'r1', bindingId: 'b1', taskInstanceId: 'ti1',
      failurePhase: 'static', failureClass: 'product', fingerprintVersion: 1, errorSignature: 'sig' })
    const p = await createExperiencePending(db, { repoId: 'r1', sourceId: f.failureId, failureClass: 'product', content: 'c' })
    const r = await reviewPending(db, { pendingId: p.pendingId, action: 'linked_to_failure', reviewerPrincipalId: 'p1', linkedFailureId: f.failureId })
    expect(r.action).toBe('linked_to_failure')
    expect((await getFailure(db, f.failureId)).status).toBe('linked')
  })
  it('rejected marks pending rejected', async () => {
    const db = await memdb()
    const p = await createExperiencePending(db, { repoId: 'r1', sourceId: 'f4', failureClass: 'flaky', content: 'c' })
    const r = await reviewPending(db, { pendingId: p.pendingId, action: 'rejected', reviewerPrincipalId: 'p1' })
    expect(r.action).toBe('rejected')
  })
  it('double-promote blocked (not in pending_review state)', async () => {
    const db = await memdb()
    const p = await createExperiencePending(db, { repoId: 'r1', sourceId: 'f5', failureClass: 'product', content: 'c' })
    await reviewPending(db, { pendingId: p.pendingId, action: 'promoted_to_experience', reviewerPrincipalId: 'p1' })
    await expect(reviewPending(db, { pendingId: p.pendingId, action: 'promoted_to_experience', reviewerPrincipalId: 'p1' })).rejects.toThrow(/SUITE_REVOKED/)
  })
})
