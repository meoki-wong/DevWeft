/**
 * 批次0a：DONE 硬门禁 + 同证据重提闸门（精简、可重复）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { checkDoneGate, setRepoGateMode } from '../harness/testing-gate.js'
import { checkReadyToResubmit, ensureGateLoop } from '../harness/loop.js'

const SLUG = 'demo-app'

async function memdb() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-done-'))
  const db = new Database(join(dir, 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  // 单测直接造最小链路，关闭跨仓触发器以免补齐全套父表
  for (const t of await db
    .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%same_repo%'`)
    .all()) {
    try { await db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`) } catch { /* ignore */ }
  }
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', ?, 'project', 'refs/heads/stage', 't', 't')`
  ).run(SLUG)
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'alice', 'a', 'active', 't', 't')`
  ).run()
  return db
}

describe('checkDoneGate', () => {
  it('disabled 仓：允许 DONE（本地直通）', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'disabled')
    const r = await checkDoneGate(db, { repoSlug: SLUG, taskId: 'T-DONE', size: 'M' })
    expect(r.ok).toBe(true)
    expect(r.code).toBe('DISABLED_BYPASS')
  })

  it('observe 仓：不拦 DONE', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'observe')
    const r = await checkDoneGate(db, { repoSlug: SLUG, taskId: 'T-DONE', size: 'M' })
    expect(r.ok).toBe(true)
    expect(r.enforcement).toBe(false)
  })

  it('enforce_all 且未下单：GATE_NOT_GREEN', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'enforce_all')
    const r = await checkDoneGate(db, { repoSlug: SLUG, taskId: 'T-DONE', size: 'M' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('GATE_NOT_GREEN')
  })

  it('enforce_all 有 binding 但 unit 未 passed：GATE_NOT_GREEN', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'enforce_all')
    await db.prepare(
      `INSERT INTO task_instances(
         task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type, status,
         author_principal_id, created_at, updated_at, active_binding_id
       ) VALUES ('ti1', 'r1', 'T-DONE', 1, 1, 'EXECUTE', 'M', 'FEATURE', 'open', 'p1', 't', 't', 'b1')`
    ).run()
    await db.prepare(
      `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
       VALUES ('r1', 'T-DONE', 'ti1', 't')`
    ).run()
    const r = await checkDoneGate(db, {
      repoSlug: SLUG,
      taskId: 'T-DONE',
      size: 'M',
      gateBindingId: 'b1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('GATE_NOT_GREEN')
  })

  it('gate_loops.last_binding_id 可作为 DONE 默认证据源', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'enforce_all')
    await ensureGateLoop(db, { repo: SLUG, taskId: 'T-LOOP' })
    await db.prepare(`UPDATE gate_loops SET last_binding_id='missing-binding' WHERE repo=? AND task_id=?`)
      .run(SLUG, 'T-LOOP')
    const r = await checkDoneGate(db, { repoSlug: SLUG, taskId: 'T-LOOP', size: 'M' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('GATE_NOT_GREEN')
  })
})

describe('checkReadyToResubmit NO_NEW_EVIDENCE', () => {
  async function seedFailed(db, taskId, bundleSha) {
    db.pragma('foreign_keys = OFF')
    const ti = `ti-${taskId}`
    const snap = `snap-${taskId}`
    const bind = `b-${taskId}`
    const sub = `sub-${taskId}`
    const rg = `rg-${taskId}`
    await db.prepare(
      `INSERT INTO task_instances(
         task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type, status,
         author_principal_id, created_at, updated_at
       ) VALUES (?, 'r1', ?, 1, 1, 'EXECUTE', 'M', 'FEATURE', 'open', 'p1', 't', 't')`
    ).run(ti, taskId)
    await db.prepare(
      `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
       VALUES ('r1', ?, ?, 't')`
    ).run(taskId, ti)
    await db.prepare(
      `INSERT INTO git_remotes(
         remote_id, repo_id, provider, provider_instance, canonical_url, url_fingerprint, relationship, enabled, created_at
       ) VALUES (?, 'r1', 'gitlab', 'local', ?, ?, 'canonical', 1, 't')`
    ).run(`rem-${taskId}`, `https://example.invalid/${taskId}.git`, `fp-${taskId}`)
    await db.prepare(
      `INSERT INTO branch_incarnations(
         branch_incarnation_id, repo_id, remote_id, full_ref, generation, anchor_commit_oid,
         last_observed_tip_oid, state, created_at
       ) VALUES (?, 'r1', ?, 'refs/heads/feat', 1, 'deadbeef', 'deadbeef', 'active', 't')`
    ).run(`br-${taskId}`, `rem-${taskId}`)
    await db.prepare(
      `INSERT INTO business_snapshots(
         snapshot_id, repo_id, source_remote_id, branch_incarnation_id, snapshot_kind, object_format,
         source_ref, head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
         target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at
       ) VALUES (?, 'r1', ?, ?, 'dirty_workspace', 'sha1', 'refs/heads/f', 'head1', 'c1', 'tree1', 'cp1',
                 ?, 'refs/heads/stage', 'head1', ?, 10, 'p1', 't')`
    ).run(snap, `rem-${taskId}`, `br-${taskId}`, `rem-${taskId}`, bundleSha)
    await db.prepare(
      `INSERT INTO test_bindings(
         binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256,
         policy_revision_id, resolved_sides_json, changed_paths_sha256, required_case_set_sha256,
         canonical_binding_json, state, created_at
       ) VALUES (?, 'r1', ?, 'sp-x', ?, 'ep-x', 'img-x', 'mh', 'pol-x', '["web"]', 'cp1', 'rq', '{}', 'active', 't')`
    ).run(bind, snap, ti)
    await db.prepare(
      `INSERT INTO test_submissions(
         submission_id, client_request_id, principal_id, repo_id, task_instance_id, binding_id,
         expected_task_revision, status, created_at
       ) VALUES (?, 'cr-1', 'p1', 'r1', ?, ?, 1, 'failed', 't')`
    ).run(sub, ti, bind)
    await db.prepare(
      `INSERT INTO run_groups(
         run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible, required_units_json, status, created_at
       ) VALUES (?, 'r1', ?, ?, 'formal', 1, '["static:na"]', 'failed', 't')`
    ).run(rg, sub, bind)
    db.pragma('foreign_keys = ON')
    await ensureGateLoop(db, { repo: SLUG, taskId })
  }

  it('同 bundle 重提 → NO_NEW_EVIDENCE', async () => {
    const db = await memdb()
    await seedFailed(db, 'T-EV', 'aa11')
    const r = await checkReadyToResubmit(db, {
      repoSlug: SLUG,
      taskId: 'T-EV',
      evidence: { bundleSha256: 'aa11' },
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NO_NEW_EVIDENCE')
  })

  it('证据变化 → 不是 NO_NEW_EVIDENCE', async () => {
    const db = await memdb()
    await seedFailed(db, 'T-EV2', 'bb22')
    const r = await checkReadyToResubmit(db, {
      repoSlug: SLUG,
      taskId: 'T-EV2',
      productFixed: true,
      suiteFixed: true,
      evidence: { bundleSha256: 'cc33' },
    })
    expect(r.code).not.toBe('NO_NEW_EVIDENCE')
  })
})
