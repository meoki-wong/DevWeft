/**
 * 考卷刷新跳过 static + 工作流测试节点
 */
import { describe, expect, it } from 'vitest'
import { requiredUnitsForTask, detectChangeKind, unitsFromLastFormalGroup } from '../harness/testing-gate.js'
import { buildTestNodes } from '../harness/labels.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'

describe('requiredUnitsForTask changeKind', () => {
  it('full M/L 含 static', () => {
    expect(requiredUnitsForTask({ size: 'M', type: 'UI_DEV', sides: ['web'] })).toEqual(['static:na', 'smoke:web'])
    expect(requiredUnitsForTask({ size: 'L', type: 'FEATURE', sides: ['web', 'admin'] })).toEqual([
      'static:na',
      'smoke:web',
      'smoke:admin',
    ])
  })

  it('spec-only M/L 跳过 static', () => {
    expect(requiredUnitsForTask({ size: 'M', type: 'UI_DEV', sides: ['web'], changeKind: 'spec-only' })).toEqual([
      'smoke:web',
    ])
    expect(requiredUnitsForTask({ size: 'L', sides: ['web', 'admin'], changeKind: 'spec-only' })).toEqual([
      'smoke:web',
      'smoke:admin',
    ])
  })

  it('S 仍只 static', () => {
    expect(requiredUnitsForTask({ size: 'S', changeKind: 'spec-only' })).toEqual(['static:na'])
  })
})

describe('buildTestNodes', () => {
  it('L 任务含考卷+云端门禁节点', () => {
    const n = buildTestNodes({
      phase: 'EXECUTE',
      size: 'L',
      acCoverage: { applicable: true, total: 4, missing: ['AC-2'], covered: ['AC-1'] },
      requiredUnits: ['smoke:web'],
      changeKind: 'spec-only',
    })
    expect(n.enabled).toBe(true)
    expect(n.nodes.map((x) => x.id)).toEqual(['specs', 'cloud_gate'])
    expect(n.nodes[0].status).toBe('current')
    expect(n.nodes[1].summary).toMatch(/spec-only|跳过 static/)
  })
})

describe('detectChangeKind / unitsFromLastFormalGroup', () => {
  it('产品树相同且 static 已绿 → spec-only', async () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-kind-')), 't.db'))
    db.pragma('foreign_keys = ON')
    await runTestingMigrations(db, { skipLegacyMap: true })
    for (const t of await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%same_repo%'`).all()) {
      try { await db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`) } catch { /* ignore */ }
    }
    db.pragma('foreign_keys = OFF')
    await db.prepare(
      `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
       VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
       VALUES ('p1', 'a', 'a', 'active', 't', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type, status, author_principal_id, created_at, updated_at)
       VALUES ('ti1', 'r1', 'T1', 1, 1, 'EXECUTE', 'M', 'UI_DEV', 'open', 'p1', 't', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
       VALUES ('r1', 'T1', 'ti1', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO git_remotes(remote_id, repo_id, provider, provider_instance, canonical_url, url_fingerprint, relationship, enabled, created_at)
       VALUES ('rem1', 'r1', 'gitlab', 'x', 'https://x', 'fp1', 'canonical', 1, 't')`
    ).run()
    await db.prepare(
      `INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, branch_incarnation_id, snapshot_kind, object_format,
         source_ref, head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
         target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
       VALUES ('snap1', 'r1', 'rem1', NULL, 'dirty_workspace', 'sha1',
         'refs/heads/f', 'head1', 'c1', 'tree1', 'cp1',
         'rem1', 'refs/heads/stage', 'head1', 'aa', 1, 'p1', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json, state, created_at)
       VALUES ('b1', 'r1', 'snap1', 'sp1', 'ti1', 'ep1', 'img1', 'mh', 'pol1', '["web"]', 'cp1', 'rq', '{}', 'active', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id, binding_id, expected_task_revision, status, created_at)
       VALUES ('sub1', 'cr1', 'p1', 'r1', 'ti1', 'b1', 1, 'passed', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible, required_units_json, status, created_at)
       VALUES ('rg1', 'r1', 'sub1', 'b1', 'formal', 1, '["static:na","smoke:web"]', 'passed', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, unit, side, purpose, status, created_at)
       VALUES ('run1', 'rg1', 'b1', 'r1', 'ti1', 'static', 'na', 'gate', 'passed', 't')`
    ).run()

    const kind = await detectChangeKind(db, {
      repoSlug: 'demo-app',
      taskId: 'T1',
      snapshotTreeOid: 'tree1',
      headCommitOid: 'head1',
    })
    expect(kind).toBe('spec-only')
    expect(await unitsFromLastFormalGroup(db, { repoSlug: 'demo-app', taskId: 'T1', bindingId: 'b1' })).toEqual([
      'static:na',
      'smoke:web',
    ])

    const kind2 = await detectChangeKind(db, {
      repoSlug: 'demo-app',
      taskId: 'T1',
      snapshotTreeOid: 'tree-other',
      headCommitOid: 'head-other',
    })
    expect(kind2).toBe('full')
  })
})
