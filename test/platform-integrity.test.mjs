/**
 * platform-integrity.test.mjs — 平台完整性测试（阶段 1 / T1.2~T1.5）
 *
 * 1. 真并发 CAS：两个独立子进程从同一 phase 抢推 → 仅一次成功（IPC 屏障同步起跑）；
 * 2. 事务故障注入：SQLite 触发器 RAISE(ABORT) → transitionTask 全回滚，无半写入；
 * 3. DONE 会话释放：await transitionTask(releaseSession=true) 后活跃会话清空；
 * 4. 租约边界：过期前/过期后/心跳续期；幂等重放同 key 异内容冲突。
 *
 * 说明：真并发必须用两个进程 + IPC 屏障——同一进程内 Promise.all 包同步 SQLite
 * 调用不构成竞争（better-sqlite3 同步执行）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import db from '../db.js'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { transitionTask } from '../harness/task-store.js'
import { acquireTaskSession, getActiveTaskSession } from '../harness/loop.js'
import { acquireLease, loadActiveLease, heartbeatLease, rememberWorkerOp } from '../testing/leases.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SLUG = `pi-${Date.now().toString(36)}`
const SHA = 'a'.repeat(64)
let boot = null

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug: SLUG, remoteUrl: 'https://gitlab.example/pi/x.git' })
  await ensureRepository(db, SLUG, boot.principalId)
})

// ═══════════ 1. 真并发 CAS（两进程 + IPC 屏障） ═══════════

describe('真并发 CAS（两进程）', () => {
  it('两进程同时从 EXECUTE 抢推 VERIFY：仅一次成功、仅一条版本', async () => {
    // 独立文件库：两个进程各自打开
    const dir = mkdtempSync(join(tmpdir(), 'awp-cas-'))
    const dbPath = join(dir, 'cas.db')
    {
      const shared = new Database(dbPath)
      shared.pragma('foreign_keys = ON')
      await runTestingMigrations(shared, { skipLegacyMap: true })
      shared.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          repo TEXT, task_id TEXT, tenant_id TEXT, requirement TEXT, type TEXT, size TEXT, phase TEXT,
          completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
          meta TEXT DEFAULT '{}', author TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT,
          PRIMARY KEY (repo, task_id)
        );
        CREATE TABLE IF NOT EXISTS task_versions (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id     TEXT NOT NULL,
          repo        TEXT NOT NULL,
          tenant_id   TEXT,
          phase       TEXT,
          snapshot    TEXT NOT NULL,
          author      TEXT,
          created_at  TEXT NOT NULL
        );
      `)
      const now = new Date().toISOString()
      await shared.prepare(
        `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
         VALUES ('cas-repo-id', 'cas-repo', 'cas', 'refs/heads/stage', ?, ?)
         ON CONFLICT DO NOTHING`
      ).run(now, now)
      await shared.prepare(
        `INSERT INTO tasks(repo, task_id, tenant_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
         VALUES ('cas-repo', 'T-CAS', 'cas-repo-id', 'x', 'FIX', 'M', 'EXECUTE', '["p"]', '{}', 'alice', ?, ?)`
      ).run(now, now)
      shared.close()
    }

    const workerPath = join(__dirname, 'helpers', 'cas-worker.mjs')
    const runWorker = (id) => new Promise((resolve) => {
      const child = fork(workerPath, ['--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
      const timer = setTimeout(() => { child.kill(); resolve({ id, error: 'TIMEOUT' }) }, 15000)
      child.on('message', (msg) => {
        clearTimeout(timer)
        resolve({ id, ...msg })
        child.kill()
      })
      child.on('error', (e) => { clearTimeout(timer); resolve({ id, error: e.message }) })
      child.send('go')
    })

    const results = await Promise.all([runWorker(1), runWorker(2)])
    const oks = results.filter((r) => r.ok === true)
    const conflicts = results.filter((r) => r.code === 'PHASE_CONFLICT')
    expect(oks, JSON.stringify(results)).toHaveLength(1)
    expect(conflicts).toHaveLength(1)

    // 仅一条版本、phase 恰好推进一次
    const check = new Database(dbPath)
    const phase = (await check.prepare(`SELECT phase FROM tasks WHERE repo='cas-repo' AND task_id='T-CAS'`).get()).phase
    const versionCount = (await check.prepare(`SELECT count(*) n FROM task_versions WHERE repo='cas-repo' AND task_id='T-CAS'`).get()).n
    check.close()
    expect(phase).toBe('static')
    expect(versionCount).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  }, 30000)
})

// ═══════════ 2. 事务故障注入 ═══════════

describe('事务故障注入（transitionTask 原子性）', () => {
  async function mkTask(phase) {
    const taskId = `T-FT-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    await db.prepare(
      `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
       VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'FIX', 'M', ?, '["p"]', '{}', 'alice', ?, ?)`
    ).run(SLUG, SLUG, taskId, phase, now, now)
    return taskId
  }

  it('版本写入中途失败 → task/版本/loopPatch 全部回滚（无半写入）', async () => {
    const taskId = await mkTask('static')
    await ensureGateLoopRow(SLUG, taskId)
    const versionsBefore = await countVersions(SLUG, taskId)
    const loopBefore = await getLoopState(SLUG, taskId)

    // 注入：task_versions 插入即 ABORT（本用例专用触发器）
    await db.exec(`
      CREATE TRIGGER IF NOT EXISTS ft_inject_abort
      BEFORE INSERT ON task_versions
      WHEN NEW.phase = 'done'
      BEGIN
        SELECT RAISE(ABORT, 'injected-failure');
      END;
    `)
    try {
      await expect(transitionTask(db, {
        repo: SLUG,
        taskId,
        fromPhase: 'static',
        to: 'DONE',
        merged: { size: 'M', completed: [], pending: [], decisions: [], meta: { l3Confirmed: true } },
        author: 'tester',
        loopPatch: { state: 'green_pending_advance' },
        releaseSession: false,
      })).rejects.toThrow(/injected-failure/)
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS ft_inject_abort')
    }

    // 全回滚：phase 不变、无新版本、loopPatch 未生效
    const row = await db.prepare(`SELECT phase FROM tasks WHERE repo=? AND task_id=?`).get(SLUG, taskId)
    expect(row.phase).toBe('static')
    expect(await countVersions(SLUG, taskId)).toBe(versionsBefore)
    expect(await getLoopState(SLUG, taskId)).toBe(loopBefore)
  })

  it('CAS 冲突（phase 不匹配）→ PHASE_CONFLICT 且无版本写入', async () => {
    const taskId = await mkTask('execute')
    const versionsBefore = await countVersions(SLUG, taskId)
    await expect(transitionTask(db, {
      repo: SLUG,
      taskId,
      fromPhase: 'VERIFY', // 实际是 EXECUTE → 0 行更新
      to: 'DONE',
      merged: { size: 'M', completed: [], pending: [], decisions: [], meta: {} },
      author: 'tester',
    })).rejects.toThrow(/PHASE_CONFLICT/)
    expect(await countVersions(SLUG, taskId)).toBe(versionsBefore)
  })
})

// ═══════════ 3. DONE 会话释放 ═══════════

describe('DONE 会话释放', () => {
  it('await transitionTask(releaseSession=true) 到 DONE → 活跃会话清空、closed_at 落值', async () => {
    const taskId = await mkTask('DISTILL')
    await acquireTaskSession(db, { repo: SLUG, taskId, ownerSubject: 'sess-owner' })
    expect(await getActiveTaskSession(db, { repo: SLUG, taskId })).toBeTruthy()

    await transitionTask(db, {
      repo: SLUG,
      taskId,
      fromPhase: 'DISTILL',
      to: 'DONE',
      merged: { size: 'M', completed: [], pending: [], decisions: [], meta: { l3Confirmed: true } },
      author: 'sess-owner',
      releaseSession: true,
    })
    expect(await getActiveTaskSession(db, { repo: SLUG, taskId })).toBeNull()
    const row = await db.prepare(`SELECT phase, closed_at FROM tasks WHERE repo=? AND task_id=?`).get(SLUG, taskId)
    expect(row.phase).toBe('done')
    expect(row.closed_at).toBeTruthy()
    const sess = await db.prepare(
      `SELECT released_at FROM task_sessions WHERE repo=? AND task_id=? AND owner_subject='sess-owner'`
    ).get(SLUG, taskId)
    expect(sess.released_at).toBeTruthy()
  })
})

// ═══════════ 4. 租约边界 + 幂等 ═══════════

describe('租约边界与幂等', () => {
  it('过期前可校验、过期后 LEASE_EXPIRED、心跳续期', async () => {
    const { runId, leaseId, leaseToken, attempt, leaseEpoch, worker } = await seedQueuedRunAndAcquire()
    const lease = await db.prepare('SELECT * FROM runner_leases WHERE lease_id=?').get(leaseId)
    const expiresAt = Date.parse(lease.expires_at)

    // 过期前：可校验
    const before = await loadActiveLease(db, {
      leaseId, workerId: worker.worker_id, runId, attempt, leaseEpoch, leaseToken,
      nowIso: new Date(expiresAt - 5000).toISOString(),
    })
    expect(before.lease_id).toBe(leaseId)

    // 心跳续期 → expires_at 推进
    await heartbeatLease(db, worker, leaseId, {
      runId, workerId: worker.worker_id, attempt, leaseEpoch, leaseToken, operationSeq: 1,
    })
    const renewed = await db.prepare('SELECT expires_at FROM runner_leases WHERE lease_id=?').get(leaseId)
    expect(Date.parse(renewed.expires_at)).toBeGreaterThan(expiresAt)

    // 过期后：LEASE_EXPIRED
    await expect(loadActiveLease(db, {
      leaseId, workerId: worker.worker_id, runId, attempt, leaseEpoch, leaseToken,
      nowIso: new Date(Date.parse(renewed.expires_at) + 1000).toISOString(),
    })).rejects.toThrow(/LEASE_EXPIRED/)
  })

  it('幂等重放：同 key 同内容重放、同 key 异内容 IDEMPOTENCY_KEY_REUSED', async () => {
    // 幂等表 FK 到 runner_leases(lease_id)：用真实租约
    const { leaseId, worker: leaseWorker } = await seedQueuedRunAndAcquire()
    const body = { runId: 'r-1', workerId: leaseWorker.worker_id, attempt: 1, leaseEpoch: 1, leaseToken: 'tok' }
    const first = await rememberWorkerOp(db, {
      workerId: leaseWorker.worker_id, leaseId, operation: 'heartbeat', operationSeq: 9,
      requestBody: body, now: new Date().toISOString(),
      produce: () => ({ status: 200, data: { desiredState: 'running' } }),
    })
    expect(first.replay).toBe(false)
    // 同内容重放
    const replay = await rememberWorkerOp(db, {
      workerId: leaseWorker.worker_id, leaseId, operation: 'heartbeat', operationSeq: 9,
      requestBody: body, now: new Date().toISOString(),
      produce: () => ({ status: 200, data: { desiredState: 'running' } }),
    })
    expect(replay.replay).toBe(true)
    // 同 key 异内容 → 冲突
    await expect(rememberWorkerOp(db, {
      workerId: leaseWorker.worker_id, leaseId, operation: 'heartbeat', operationSeq: 9,
      requestBody: { ...body, attempt: 2 }, now: new Date().toISOString(),
      produce: () => ({ status: 200, data: {} }),
    })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/)
  })
})

// ═══════════ helpers ═══════════

async function mkTask(phase) {
  const taskId = `T-PI-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'FIX', 'M', ?, '["p"]', '{}', 'alice', ?, ?)`
  ).run(SLUG, SLUG, taskId, phase, now, now)
  return taskId
}
async function countVersions(repo, taskId) {
  return (await db.prepare(`SELECT count(*) n FROM task_versions WHERE repo=? AND task_id=?`).get(repo, taskId)).n
}
async function ensureGateLoopRow(repo, taskId) {
  await db.prepare(
    `INSERT INTO gate_loops(repo, tenant_id, task_id, size, state, iteration, max_iterations, needs_human, await_distill, history_json, updated_at)
     VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'M', 'coding', 0, 5, 0, 0, '[]', ?)
     ON CONFLICT(repo, task_id) DO NOTHING`
  ).run(repo, repo, taskId, new Date().toISOString())
}
async function getLoopState(repo, taskId) {
  try {
    return (await db.prepare(`SELECT state FROM gate_loops WHERE repo=? AND task_id=?`).get(repo, taskId))?.state ?? null
  } catch {
    return null
  }
}

async function seedQueuedRunAndAcquire() {
  const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: `pi-worker-${randomUUID().slice(0, 6)}` })
  const taskId = await mkTask('execute')
  const now = new Date().toISOString()
  const ti = randomUUID()
  const bindingId = randomUUID()
  const snapshotId = randomUUID()
  const planId = randomUUID()
  const groupId = randomUUID()
  const runId = randomUUID()
  const subId = `sub-pi-${randomUUID().slice(0, 8)}`
  const profileId = (await db.prepare(`SELECT profile_revision_id FROM execution_profile_revisions WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`).get(boot.repoId))?.profile_revision_id
  const imageId = (await db.prepare(`SELECT image_id FROM runner_images WHERE state='active' LIMIT 1`).get())?.image_id
  const policyId = (await db.prepare(`SELECT policy_revision_id FROM policy_revisions WHERE state='active' LIMIT 1`).get())?.policy_revision_id
  await db.prepare(
    `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
       active_binding_id, status, author_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'M', 'FEATURE', ?, 'open', ?, ?, ?)`
  ).run(ti, boot.repoId, taskId, bindingId, boot.principalId, now, now)
  await db.prepare(
    `INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format,
       head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
       target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
     VALUES (?, ?, ?, 'dirty_workspace', 'sha1', ?, ?, ?, ?, ?, 'refs/heads/stage', ?, ?, 128, ?, ?)`
  ).run(snapshotId, boot.repoId, boot.remoteId, 'h'.repeat(40), 's'.repeat(40), 't'.repeat(40), 'c'.repeat(64), boot.remoteId, 'g'.repeat(40), SHA, boot.principalId, now)
  await db.prepare(
    `INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json,
       changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
       required_case_set_sha256, advisory_case_set_sha256, created_at)
     VALUES (?, ?, ?, ?, '["web"]', ?, ?, ?, '{}', ?, ?, ?)`
  ).run(planId, boot.repoId, ti, policyId, 'c'.repeat(64), 'e'.repeat(64), `lock-${planId}`, 'r'.repeat(64), 'a'.repeat(64), now)
  await db.prepare(
    `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
       execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
       resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
       state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["web"]', ?, ?, '{}', 'active', ?)`
  ).run(bindingId, boot.repoId, snapshotId, planId, ti, profileId, imageId, SHA, policyId, 'c'.repeat(64), 'r'.repeat(64), now)
  await db.prepare(
    `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
       binding_id, expected_task_revision, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'running', ?)`
  ).run(subId, `cr-${subId}`, boot.principalId, boot.repoId, ti, bindingId, now)
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
       required_units_json, status, created_at)
     VALUES (?, ?, ?, ?, 'formal', 1, '["smoke:web"]', 'running', ?)`
  ).run(groupId, boot.repoId, subId, bindingId, now)
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
       unit, side, purpose, status, desired_state, max_attempts, next_attempt, lease_epoch, created_at)
     VALUES (?, ?, ?, ?, ?, 'smoke', 'web', 'gate', 'queued', 'running', 2, 0, 0, ?)`
  ).run(runId, groupId, bindingId, boot.repoId, ti, now)
  const lease = await acquireLease(db, worker)
  expect(lease).toBeTruthy()
  return { ...lease, worker }
}
