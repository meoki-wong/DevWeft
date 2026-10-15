/**
 * rls-tenant.test.mjs — 方案 §8/§14.3：行级安全四场景（PGlite）
 *
 * 1. 事务 A 看不到事务 B 的 tasks 行（tenant-a / tenant-b 互不可见，各自可见 shared）
 * 2. 同一连接上，前一个事务结束后，下一个事务读不到上一个 app.tenant_id（SET LOCAL 不泄漏）
 * 3. 工人角色能领到另一个 repo_id 的排队 run（awp_worker 无租户策略，全局队列可领）
 * 4. 租户角色执行领取语句时是权限错误，不是空结果（awp_tenant 无 test_runs 权限 → 42501）
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { createPostgresHandle } from '../db/postgres-driver.mjs'
import { runWithTenant } from '../db/tenant-context.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
let pg, db

beforeAll(async () => {
  pg = new PGlite(fs.mkdtempSync(path.join(os.tmpdir(), 'awp-rls-')), { extensions: { pg_trgm } })
  db = await createPostgresHandle({ poolLike: pg })
  await db.exec(fs.readFileSync(path.join(root, 'sql', 'postgres', 'baseline.sql'), 'utf8'))
  await db.exec(fs.readFileSync(path.join(root, 'sql', 'postgres', 'rls.sql'), 'utf8'))

  // 租户目录:r1(tenant-a) / r2(tenant-b) / shared
  for (const [id, slug] of [['r1', 'tenant-a'], ['r2', 'tenant-b'], ['r-shared', 'shared']]) {
    await db.prepare(`INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, enabled, created_at, updated_at)
      VALUES (?, ?, ?, 'refs/heads/stage', 1, 't', 't')`).run(id, slug, slug)
  }
  // tasks:每个租户一行 + shared 一行
  // [task_id, repo slug, tenant_id=repo_id] —— 原参数错位导致 tenant_id 塞进了 task id
  for (const [tid, slug, repoId] of [['t-a', 'tenant-a', 'r1'], ['t-b', 'tenant-b', 'r2'], ['t-s', 'shared', 'r-shared']]) {
    await db.prepare(`INSERT INTO tasks(task_id, repo, tenant_id, requirement, type, phase, author, created_at, updated_at)
      VALUES (?, ?, ?, 'rls', 'FIX', 'receive', 'a', 't', 't')`).run(tid, slug, repoId)
  }
  // 每个 repo 造一条完整 FK 链:remote→snapshot→instance→plan→binding→run_group→run
  // (test_bindings 域触发器要求全链同仓,方案 §13.1 基线触发器)
  await db.prepare(`INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
    VALUES ('p-sys', 'system:probe', 'probe', 'active', 't', 't')`).run()
  for (const repo of ['r1', 'r2']) {
    const suf = repo
    await db.prepare(`INSERT INTO git_remotes(remote_id, repo_id, provider, provider_instance, canonical_url, url_fingerprint, relationship, enabled, created_at)
      VALUES ('rem-' || ?, ?, 'gitlab', 'gitlab.example', 'https://x/' || ?, 'fp-' || ?, 'canonical', 1, 't')`).run(suf, repo, suf, suf)
    await db.prepare(`INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format,
        head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
        target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
      VALUES ('snap-' || ?, ?, 'rem-' || ?, 'dirty_workspace', 'sha1', 'h', 's', 'tr', 'cp', 'rem-' || ?, 'refs/heads/stage', 'tc', 'bd', 1, 'p-sys', 't')`)
      .run(suf, repo, suf, suf)
    await db.prepare(`INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at)
      VALUES ('ti-' || ?, ?, 'T-probe', 1, 1, 'EXECUTE', 'M', 'open', 'p-sys', 't', 't')`).run(suf, repo)
    await db.prepare(`INSERT INTO policy_revisions(policy_revision_id, name, revision, content_sha256, policy_json, state, created_by, created_at)
      VALUES ('pol-' || ?, 'p-' || ?, 1, 'cs-' || ?, '{}', 'active', 'p-sys', 't')`).run(suf, suf, suf)
    await db.prepare(`INSERT INTO execution_profile_revisions(profile_revision_id, repo_id, name, revision, content_sha256, profile_json, state, created_by, created_at)
      VALUES ('epr-' || ?, ?, 'p-' || ?, 1, 'cs-' || ?, '{}', 'active', 'p-sys', 't')`).run(suf, repo, suf, suf)
    await db.prepare(`INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at)
      VALUES ('img-' || ?, 'ms-' || ?, 'vs-' || ?, '{}', 'active', 't')`).run(suf, suf, suf)
    await db.prepare(`INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id,
        resolved_sides_json, changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
        required_case_set_sha256, advisory_case_set_sha256, created_at)
      VALUES ('plan-' || ?, ?, 'ti-' || ?, 'pol-' || ?, '["na"]', 'cp-' || ?, 'eo-' || ?, 'ls-' || ?, '{}', 'rc-' || ?, 'ac-' || ?, 't')`)
      .run(suf, repo, suf, suf, suf, suf, suf, suf, suf)
    await db.prepare(`INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
        execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
        resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json, state, created_at)
      VALUES ('b-' || ?, ?, 'snap-' || ?, 'plan-' || ?, 'ti-' || ?, 'epr-' || ?, 'img-' || ?, 'ms-' || ?, 'pol-' || ?,
        '["na"]', 'cp', 'rc', '{}', 'active', 't')`)
      .run(suf, repo, suf, suf, suf, suf, suf, suf, suf)
    await db.prepare(`INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id, binding_id, expected_task_revision, status, created_at)
      VALUES ('sub-' || ?, 'cr-' || ?, 'p-sys', ?, 'ti-' || ?, 'b-' || ?, 1, 'running', 't')`)
      .run(suf, suf, repo, suf, suf)
    await db.prepare(`INSERT INTO run_groups(run_group_id, submission_id, repo_id, binding_id, kind, required_units_json, gate_eligible, status, created_at)
      VALUES ('rg-' || ?, 'sub-' || ?, ?, 'b-' || ?, 'formal', '["static:na"]', 1, 'failed', 't')`).run(suf, suf, repo, suf)
    await db.prepare(`INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, unit, side, purpose, status, desired_state, next_attempt, lease_epoch, created_at)
      VALUES ('run-' || ?, 'rg-' || ?, 'b-' || ?, ?, 'ti-' || ?, 'static', 'na', 'gate', 'queued', 'running', 0, 0, 't')`)
      .run(suf, suf, suf, repo, suf)
  }
})

afterAll(async () => {
  // db.close() → pool.end() → poolLike.close()，PGlite 已随之关闭。
  // 不要再 pg.close()：二次关闭会抛 "PGlite is closed"，且未 await 的 rejection 逃出 try/catch 变成 unhandledRejection。
  try { await db.close() } catch { /* ignore */ }
})

/** 可见任务断言助手:以指定租户上下文开事务,返回可见的 repo 清单 */
const visibleTaskRepos = (tenantId) => db.tx(async (tx) => {
  const rows = await tx.prepare('SELECT tenant_id FROM tasks').all()
  return [...new Set(rows.map((r) => r.tenant_id))].sort()
}, { tenantId, role: 'awp_tenant' })

describe('行级安全（方案 §8/§14.3）', () => {
  it('场景1:事务 A 看不到事务 B 的 tasks 行;shared 双方可见', async () => {
    const seenA = await visibleTaskRepos('r1')
    const seenB = await visibleTaskRepos('r2')
    expect(seenA).toEqual(['r-shared', 'r1'])
    expect(seenB).toEqual(['r-shared', 'r2'])
  })

  it('场景2:SET LOCAL 不泄漏——事务结束后无租户上下文,fail-closed 看不到任何租户行', async () => {
    await db.tx(async () => {}, { tenantId: 'r1', role: 'awp_tenant' })
    // 无租户上下文的新事务:current_setting(...,true) 为 NULL → 租户分支不匹配;
    // 但 shared 分支按 §14.1 设计仍可见——断言「只见 shared,其余 fail-closed 不可见」
    const rows = await db.tx(async (tx) => {
      const setting = await tx.prepare(`SELECT current_setting('app.tenant_id', true) AS v`).get()
      expect(setting.v === '' || setting.v === null).toBe(true)
      return tx.prepare('SELECT task_id FROM tasks').all()
    }, { role: 'awp_tenant' })
    expect(rows.map((r) => r.task_id)).toEqual(['t-s'])
    // owner(池默认/admin 路径)不受 RLS 约束,仍全量可见
    const adminRows = await db.tx(async (tx) => (await tx.prepare('SELECT count(*) c FROM tasks').get()).c)
    expect(adminRows).toBe(3)
  })

  it('场景3:工人角色能领到另一个 repo_id 的排队 run(全局队列)', async () => {
    const claimed = await db.txWorker(async (tx) => {
      const queued = await tx.prepare(
        `SELECT run_id, repo_id FROM test_runs
         WHERE status='queued' AND desired_state='running'
         ORDER BY priority ASC, created_at ASC LIMIT 1`).get()
      expect(queued).toBeTruthy()
      // 明确领取的是「别的租户」的 run(worker 无租户上下文)
      const updated = await tx.prepare(
        `UPDATE test_runs SET status='active', started_at=COALESCE(started_at, 't')
         WHERE run_id=? AND status='queued' AND desired_state='running' RETURNING run_id, repo_id`)
        .get(queued.run_id)
      return updated
    })
    // 工人视角没有租户隔离:先到先得,无论 run 属于 r1 还是 r2
    expect(['run-r1', 'run-r2']).toContain(claimed.run_id)
    expect(['r1', 'r2']).toContain(claimed.repo_id)
  })

  it('场景5:请求级上下文(runWithTenant)+ 驱动自动租户事务 → 跨租户不可见', async () => {
    // 模拟 server.js:请求带 repo → runWithTenant 包裹处理链,内部用普通 prepare(自动租户事务)
    const seenR1 = await runWithTenant('r1', async () => {
      const rows = await db.prepare('SELECT task_id FROM tasks').all()
      return rows.map((r) => r.task_id).sort()
    })
    expect(seenR1).toEqual(['t-a', 't-s']) // 本租户 + shared,看不到 r2
    const seenR2 = await runWithTenant('r2', async () => {
      const rows = await db.prepare('SELECT task_id FROM tasks').all()
      return rows.map((r) => r.task_id).sort()
    })
    expect(seenR2).toEqual(['t-b', 't-s'])
    // 无上下文 → owner 路径,全量可见(看板/管理语义)
    const all = await db.prepare('SELECT count(*) c FROM tasks').get()
    expect(all.c).toBe(3)
  })

  it('场景4:租户角色执行领取语句是权限错误(insufficient_privilege),不是空结果', async () => {
    let caught = null
    await db.txTenant('r1', async (tx) => {
      try {
        // 领取语句 = acquireLease 的簿记写入(run_attempts);租户角色无 INSERT 权
        await tx.prepare(
          `INSERT INTO run_attempts(repo_id, run_id, attempt, worker_id, lease_epoch, status, started_at)
           VALUES ('r1', 'run-r1', 9, 'w1', 9, 'reserved', 't')`).run()
      } catch (e) {
        caught = e
      }
    })
    expect(caught, '必须是权限错误而非静默空结果').toBeTruthy()
    expect(String(caught.code || caught.message)).toMatch(/42501|insufficient_privilege|permission denied/i)
  })
})
