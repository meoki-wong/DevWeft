/**
 * gate-ledger.test.mjs — 批次一：失败账本与豁免安全
 *
 * 1. 跨页面归因：spec pages 命中改动文件 → suite 重判 product（真回归不豁免）
 * 2. 迭代豁免：纯考卷失败（归因后仍 suite）→ iteration 不烧
 * 3. 沉淀豁免：纯考卷失败 → findUnsummarizedGateFailure 返回 null
 * 4. requeueRun：仅 infra_error/lost 可重推，业务失败拒绝
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { attributeSuiteChecks } from '../testing/impact.js'
import { ensureGateLoop, getGateLoop, nextGateLoopIteration } from '../harness/loop.js'
import { findUnsummarizedGateFailure } from '../harness/testing-gate.js'
import { requeueRun } from '../testing/leases.js'

/* ── 归因单测：极简自建表（只建 impact.js 触碰的四张表） ── */
async function impactDb({ pages, changed }) {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE repositories (repo_id TEXT PRIMARY KEY);
    CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, snapshot_id TEXT);
    CREATE TABLE business_snapshots (snapshot_id TEXT PRIMARY KEY, changed_files_json TEXT);
    CREATE TABLE test_specs (repo_id TEXT, feature_key TEXT, version INTEGER, pages_json TEXT);
  `)
  await db.prepare(`INSERT INTO repositories VALUES ('r1')`).run()
  await db.prepare(`INSERT INTO test_bindings VALUES ('b1', 's1')`).run()
  await db.prepare(`INSERT INTO business_snapshots VALUES ('s1', ?)`).run(changed ? JSON.stringify(changed) : null)
  if (pages) {
    await db.prepare(`INSERT INTO test_specs VALUES ('r1', 'flight-check', 1, ?)`).run(JSON.stringify(pages))
  }
  return db
}

const suiteCheck = {
  caseKey: 'test:spec/flight-check',
  class: 'suite',
  featureKey: 'flight-check',
  status: 'failed',
  detail: 'selector timeout',
}

describe('失败归因（跨页面回归）', () => {
  it('spec pages 命中改动文件 → suite 重判 product 并带归因', async () => {
    const db = await impactDb({ pages: ['views/catalog'], changed: ['src/views/catalog/index.vue'] })
    const r = await attributeSuiteChecks(db, { repoId: 'r1', bindingId: 'b1', checks: [suiteCheck] })
    expect(r.checks[0].class).toBe('product')
    expect(r.checks[0].attribution).toBe('cross-page-regression')
    expect(r.attributed[0].featureKey).toBe('flight-check')
  })

  it('pages 无交集 → 保持 suite（考卷问题，可豁免）', async () => {
    const db = await impactDb({ pages: ['views/catalog'], changed: ['src/views/other/index.vue'] })
    const r = await attributeSuiteChecks(db, { repoId: 'r1', bindingId: 'b1', checks: [suiteCheck] })
    expect(r.checks[0].class).toBe('suite')
    expect(r.attributed).toHaveLength(0)
  })

  it('无 pages 声明 / 无改动清单 → 不归因，原样返回', async () => {
    const dbNoPages = await impactDb({ changed: ['src/views/catalog/index.vue'] })
    expect((await attributeSuiteChecks(dbNoPages, { repoId: 'r1', bindingId: 'b1', checks: [suiteCheck] })).checks[0].class).toBe('suite')
    const dbNoChanged = await impactDb({ pages: ['views/catalog'] })
    expect((await attributeSuiteChecks(dbNoChanged, { repoId: 'r1', bindingId: 'b1', checks: [suiteCheck] })).checks[0].class).toBe('suite')
  })
})

/* ── 迭代豁免 / 沉淀豁免：全链路夹具 ── */
async function ledgerDb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-ledger-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  // 生产库 experiences 有 task_id 列（harness/migrate.js 补列）；测试库对齐，否则按"表结构差异降级放行"设计恒放行
  try { await db.exec(`ALTER TABLE experiences ADD COLUMN task_id TEXT`) } catch { /* 列已存在 */ }
  // 夹具只关心判卷链路；关闭 FK 以便不铺 binding/snapshot 全链（归因取不到清单时走豁免分支）
  db.pragma('foreign_keys = OFF')
  // 摘掉 test_runs 的防跨仓 trigger（夹具没有完整 binding/task 链）
  for (const t of await db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='test_runs'`).all()) {
    await db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`)
  }
  // v8 已建 experiences 表（experience_id 主键）；放一条带 task_id 的旧经验用于"失败后无新经验"断言
  await db.prepare(
    `INSERT INTO experiences(experience_id, repo_id, task_id, title, content, source_type, source_id, created_at, updated_at)
     VALUES ('e0', 'r1', 'T-AC-1', 'old', 'old', 'manual', 'x', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`
  ).run()
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'alice', 'alice', 'active', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, status, author_principal_id, created_at, updated_at)
     VALUES ('ti1', 'r1', 'T-AC-1', 1, 1, 'EXECUTE', 'open', 'p1', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES ('r1', 'T-AC-1', 'ti1', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO test_submissions(submission_id, repo_id, task_instance_id, binding_id, client_request_id, principal_id, expected_task_revision, status, created_at, finished_at)
     VALUES ('s1', 'r1', 'ti1', 'b1', 'cr-1', 'p1', 1, 'error', 't', 't'), ('s2', 'r1', 'ti1', 'b1', 'cr-2', 'p1', 1, 'error', 't2', 't2')`
  ).run()
  return db
}

async function seedFormalFailure(db, { terminal = 'failed', reportChecks }) {
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible, required_units_json, status, created_at)
     VALUES ('g1', 'r1', 's1', 'b1', 'formal', 0, '["static:na"]', ?, 't')`
  ).run(terminal)
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, unit, side, purpose, status, desired_state, terminal_reason, report_json, created_at)
     VALUES ('run1', 'g1', 'b1', 'r1', 'ti1', 'smoke', 'web', 'gate', ?, 'running', NULL, ?, 't')`
  ).run(terminal, JSON.stringify({ checks: reportChecks }))
}

describe('迭代豁免与沉淀豁免（纯考卷失败）', () => {
  it('纯 suite 失败 → iteration 不烧；product 失败 → 正常 +1', async () => {
    const db = await ledgerDb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T-AC-1' })
    await seedFormalFailure(db, {
      reportChecks: [{ caseKey: 'test:spec/flight-check', status: 'failed', detail: 'Cannot navigate to invalid URL' }],
    })
    const r1 = await nextGateLoopIteration(db, { repoSlug: 'demo-app', taskId: 'T-AC-1' })
    expect(r1).toEqual({ next: 0, exempted: true })
    // 改成业务失败（product）→ 正常计数
    await seedFormalFailure2(db)
    const r2 = await nextGateLoopIteration(db, { repoSlug: 'demo-app', taskId: 'T-AC-1' })
    expect(r2.next).toBe(1)
  })

  it('纯 suite 失败 → 沉淀豁免（有 experiences 表也不拦）', async () => {
    const db = await ledgerDb()
    await seedFormalFailure(db, {
      reportChecks: [{ caseKey: 'test:spec/flight-check', status: 'failed', detail: 'Cannot navigate to invalid URL' }],
    })
    // 失败时间之后无新经验，但纯考卷失败 → 不拦
    expect(await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-AC-1' })).toBeNull()
  })

  it('业务失败 → 沉淀拦截仍在（已有机制不回归）', async () => {
    const db = await ledgerDb()
    await seedFormalFailure2(db)
    const blocked = await findUnsummarizedGateFailure(db, { repoSlug: 'demo-app', taskId: 'T-AC-1' })
    expect(blocked).not.toBeNull()
    expect(blocked.run_group_id).toBe('g2')
  })
})

// 业务失败夹具（单独组，避免与上一组串扰）
async function seedFormalFailure2(db) {
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible, required_units_json, status, created_at)
     VALUES ('g2', 'r1', 's2', 'b1', 'formal', 0, '["static:na"]', 'failed', 't2')`
  ).run()
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, unit, side, purpose, status, desired_state, terminal_reason, report_json, created_at)
     VALUES ('run2', 'g2', 'b1', 'r1', 'ti1', 'static', 'na', 'gate', 'failed', 'running', NULL, ?, 't2')`
  ).run(JSON.stringify({ checks: [{ caseKey: 'test:static/eslint', status: 'failed', detail: 'no-unused-vars' }] }))
}

/* ── requeue：infra 可推，业务失败拒绝 ── */
async function requeueDb() {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE run_groups (run_group_id TEXT PRIMARY KEY, repo_id TEXT, submission_id TEXT, binding_id TEXT, required_units_json TEXT DEFAULT '["smoke:web"]', status TEXT DEFAULT 'error', finished_at TEXT);
    CREATE TABLE test_runs (
      run_id TEXT PRIMARY KEY, run_group_id TEXT, repo_id TEXT, unit TEXT DEFAULT 'smoke', side TEXT DEFAULT 'web',
      status TEXT, terminal_reason TEXT, desired_state TEXT DEFAULT 'running', next_attempt INTEGER DEFAULT 2,
      lease_epoch INTEGER DEFAULT 0, finished_at TEXT
    );
    CREATE TABLE test_submissions (submission_id TEXT PRIMARY KEY, repo_id TEXT, status TEXT DEFAULT 'error', client_request_id TEXT, principal_id TEXT, binding_id TEXT, expected_task_revision INTEGER DEFAULT 1, started_at TEXT, finished_at TEXT);
  `)
  await db.prepare(`INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, required_units_json, status, finished_at) VALUES ('g1','r1','s1','b1','["smoke:web"]','error',NULL)`).run()
  await db.prepare(`INSERT INTO test_submissions(submission_id, repo_id, status) VALUES ('s1','r1','error')`).run()
  return db
}

describe('requeueRun（infra 人工重推）', () => {
  it('infra_error/lost 可重推：run 回 queued、组与提交拉回 running、重试预算重置', async () => {
    const db = await requeueDb()
    await db.prepare(`INSERT INTO test_runs(run_id, run_group_id, repo_id, unit, side, status, terminal_reason, desired_state, next_attempt, lease_epoch) VALUES ('run1','g1','r1','smoke','web','error','infra_error','running',2,0)`).run()
    const out = await requeueRun(db, 'run1', { actor: 'ops' })
    expect(out.status).toBe('queued')
    const run = await db.prepare('SELECT * FROM test_runs WHERE run_id=?').get('run1')
    expect(run.status).toBe('queued')
    expect(run.terminal_reason).toBeNull()
    expect(run.next_attempt).toBe(0)
    expect((await db.prepare('SELECT status FROM run_groups WHERE run_group_id=?').get('g1')).status).toBe('running')
    expect((await db.prepare('SELECT status FROM test_submissions WHERE submission_id=?').get('s1')).status).toBe('running')
  })

  it('业务失败（assertion_failed）禁止重推', async () => {
    const db = await requeueDb()
    await db.prepare(`INSERT INTO test_runs(run_id, run_group_id, repo_id, unit, side, status, terminal_reason, desired_state, next_attempt, lease_epoch) VALUES ('run2','g1','r1','smoke','web','error','assertion_failed','running',2,0)`).run()
    await expect(requeueRun(db, 'run2')).rejects.toThrow(/REQUEUE_NOT_ALLOWED/)
  })

  it('非终态/不存在明确报错', async () => {
    const db = await requeueDb()
    await db.prepare(`INSERT INTO test_runs(run_id, run_group_id, repo_id, unit, side, status, terminal_reason, desired_state, next_attempt, lease_epoch) VALUES ('run3','g1','r1','smoke','web','queued',NULL,'running',0,0)`).run()
    await expect(requeueRun(db, 'run3')).rejects.toThrow(/REQUEUE_NOT_ALLOWED/)
    await expect(requeueRun(db, 'nope')).rejects.toThrow(/RUN_NOT_FOUND/)
  })
})
