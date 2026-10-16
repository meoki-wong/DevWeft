/**
 * gate-execution-evidence.test.mjs — P0 证据链单测
 *
 * 1. 冻结清单：buildAssetLock / lockedCasesForRun 的选定与稳定哈希
 * 2. 门禁证据：run 自称 passed 不再够——必测用例必须各自有执行记录
 *    （缺 check / 未执行 / 摘要不符 / 无 attestation 一律 blocking）
 * 3. 重推链路：attempt 序号永久递增，清零预算不再撞 run_attempts 主键
 */
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { unitEvidence } from '../harness/testing-gate.js'
import { buildAssetLock, lockedCasesForRun } from '../testing/asset-lock.js'
import { loadLockedSpecs } from '../testing/test-specs.js'
import { acquireLease, requeueRun } from '../testing/leases.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

function specRow(over = {}) {
  return {
    spec_id: 's1',
    feature_key: 'amount-format',
    spec_type: 'unit',
    entry: 'amount-format.unit.spec.mjs',
    blob_sha256: SHA_A,
    version: 1,
    side: null,
    scope: 'task',
    pages_json: null,
    ...over,
  }
}

describe('执行资产冻结清单', () => {
  it('同一集合生成同一 sha256，排序稳定；版本变化改变 sha', async () => {
    const a = buildAssetLock([specRow(), specRow({ spec_id: 's2', feature_key: 'b-flow', spec_type: 'e2e', side: 'web', blob_sha256: SHA_B })])
    const b = buildAssetLock([specRow({ spec_id: 's2', feature_key: 'b-flow', spec_type: 'e2e', side: 'web', blob_sha256: SHA_B }), specRow()])
    expect(a.sha256).toBe(b.sha256)
    const c = buildAssetLock([specRow({ version: 2, blob_sha256: SHA_B })])
    expect(c.sha256).not.toBe(buildAssetLock([specRow()]).sha256)
  })

  it('按 unit/side 选卷：static 取 unit 卷，smoke 只取本 lane 的 e2e 卷', async () => {
    const lock = buildAssetLock([
      specRow(),
      specRow({ spec_id: 's2', feature_key: 'web-flow', spec_type: 'e2e', side: 'web', blob_sha256: SHA_B }),
      specRow({ spec_id: 's3', feature_key: 'admin-flow', spec_type: 'e2e', side: 'admin', blob_sha256: SHA_B }),
      specRow({ spec_id: 's4', feature_key: 'shared-flow', spec_type: 'e2e', side: null, blob_sha256: SHA_B }),
    ])
    expect(lockedCasesForRun(lock, { unit: 'static' }).map((s) => s.featureKey)).toEqual(['amount-format'])
    expect(lockedCasesForRun(lock, { unit: 'smoke', side: 'web' }).map((s) => s.featureKey)).toEqual(['shared-flow', 'web-flow'])
    expect(lockedCasesForRun(lock, { unit: 'smoke', side: 'admin' }).map((s) => s.featureKey)).toEqual(['admin-flow', 'shared-flow'])
  })

  it('loadLockedSpecs：清单内容不可用 → 抛错（fail-closed，不降级成"少跑一卷"）', async () => {
    const lock = buildAssetLock([specRow({ blob_sha256: '0'.repeat(64) })])
    expect(() => loadLockedSpecs(lock)).toThrow()
  })
})

/* ── 门禁证据：最小 testing 表（只建 unitEvidence 触碰的六张表） ── */
async function gateDb({ lock = null, report = null, runStatus = 'passed', withAttestation = true, unit = 'static', side = 'na' } = {}) {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, canonical_binding_json TEXT);
    CREATE TABLE run_groups (run_group_id TEXT PRIMARY KEY, kind TEXT, gate_eligible INTEGER);
    CREATE TABLE test_runs (
      run_id TEXT PRIMARY KEY, run_group_id TEXT, binding_id TEXT, unit TEXT, side TEXT,
      purpose TEXT, status TEXT, report_json TEXT, created_at TEXT
    );
    CREATE TABLE run_attestations (run_id TEXT, attempt INTEGER, lease_epoch INTEGER);
    CREATE TABLE accepted_run_results (run_id TEXT, attempt INTEGER, lease_epoch INTEGER);
  `)
  await db.prepare(`INSERT INTO run_groups VALUES ('g1','formal',1)`).run()
  await db.prepare(`INSERT INTO test_bindings VALUES ('b1', ?)`).run(JSON.stringify(lock ? { assetLock: lock } : {}))
  await db.prepare(
    `INSERT INTO test_runs VALUES ('run1','g1','b1',?,?,'gate',?,?,'2026-09-16T00:00:00.000Z')`
  ).run(unit, side, runStatus, report ? JSON.stringify({ checks: report }) : null)
  if (withAttestation) {
    await db.prepare(`INSERT INTO run_attestations VALUES ('run1',1,1)`).run()
    await db.prepare(`INSERT INTO accepted_run_results VALUES ('run1',1,1)`).run()
  }
  return db
}

const UNIT_LOCK = buildAssetLock([specRow()])
const unitCheck = (over = {}) => ({
  caseKey: 'test:unit-spec/amount-format',
  status: 'passed',
  execution: { verified: true, reason: null, total: 3, passed: 3, failed: 0, skipped: 0, executed: 3 },
  ...over,
})

describe('门禁核对逐用例执行证据', () => {
  it('清单内用例有真实执行计数 → 放行', async () => {
    const ev = await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck()] }), 'b1', 'static:na')
    expect(ev.ok).toBe(true)
    expect(ev.requiredCount).toBe(1)
  })

  it('退出码 0 但没跑用例（executed=0 / 无 execution）→ 不放行', async () => {
    const noCount = await unitEvidence(
      await gateDb({ lock: UNIT_LOCK, report: [unitCheck({ execution: { verified: false, reason: 'all-tests-skipped', executed: 0, total: 1, passed: 0, failed: 0, skipped: 1 } })] }),
      'b1', 'static:na'
    )
    expect(noCount.ok).toBe(false)
    expect(noCount.code).toBe('EXECUTION_EVIDENCE_INCOMPLETE')
    expect(noCount.details.missing[0].reason).toBe('no-test-executed')
    const legacyGuest = await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck({ execution: undefined })] }), 'b1', 'static:na')
    expect(legacyGuest.ok).toBe(false)
    expect(legacyGuest.details.missing[0].reason).toBe('no-test-executed')
  })

  it('必测用例根本没出现在报告里 → 不放行', async () => {
    const ev = await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [{ caseKey: 'test:static/eslint', status: 'passed' }] }), 'b1', 'static:na')
    expect(ev.ok).toBe(false)
    expect(ev.details.missing[0].reason).toBe('no-execution-record')
  })

  it('报告里该用例失败 → 不放行', async () => {
    const ev = await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck({ status: 'failed' })] }), 'b1', 'static:na')
    expect(ev.ok).toBe(false)
    expect(ev.details.missing[0].reason).toBe('check-failed')
  })

  it('e2e：跑的是别的版本（内容摘要不符）→ 不放行', async () => {
    const lock = buildAssetLock([specRow({ spec_type: 'e2e', side: null, blob_sha256: SHA_B })])
    const ev = await unitEvidence(
      await gateDb({
        lock,
        unit: 'smoke',
        side: 'web',
        report: [{ caseKey: 'test:spec/amount-format', status: 'passed', asset: { version: 1, blobSha256: SHA_A } }],
      }),
      'b1', 'smoke:web'
    )
    expect(ev.ok).toBe(false)
    expect(ev.details.missing[0].reason).toBe('asset-sha-mismatch')
  })

  it('e2e：清单里另一 lane 的卷不算本 lane 必测；报告摘要一致 → 放行', async () => {
    const lock = buildAssetLock([
      specRow({ spec_type: 'e2e', side: 'admin', blob_sha256: SHA_B }),
      specRow({ spec_id: 's2', feature_key: 'shared-flow', spec_type: 'e2e', side: null, blob_sha256: SHA_A }),
    ])
    const db = await gateDb({
      lock,
      unit: 'smoke',
      side: 'web',
      report: [{ caseKey: 'test:spec/shared-flow', status: 'passed', asset: { version: 1, blobSha256: SHA_A } }],
    })
    const ev = await unitEvidence(db, 'b1', 'smoke:web')
    expect(ev.ok).toBe(true)
    expect(ev.requiredCount).toBe(1)
  })

  it('缺 attestation / 未终态 / 失败 / 旧 binding 无清单', async () => {
    expect((await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck()], withAttestation: false }), 'b1', 'static:na')).code).toBe('ATTESTATION_MISSING')
    expect((await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck()], runStatus: 'active' }), 'b1', 'static:na')).code).toBe('IN_PROGRESS')
    expect((await unitEvidence(await gateDb({ lock: UNIT_LOCK, report: [unitCheck()], runStatus: 'failed' }), 'b1', 'static:na')).code).toBe('UNITS_FAILED')
    const legacy = await unitEvidence(await gateDb({ lock: null, report: [unitCheck()] }), 'b1', 'static:na')
    expect(legacy.ok).toBe(true)
    expect(legacy.legacy).toBe(true)
  })
})

/* ── 重推链路：最小 lease 表 ── */
async function leaseDb() {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE workers (worker_id TEXT PRIMARY KEY, last_heartbeat_at TEXT);
    CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, runner_image_id TEXT);
    CREATE TABLE run_groups (
      run_group_id TEXT PRIMARY KEY, repo_id TEXT, submission_id TEXT, binding_id TEXT,
      kind TEXT, gate_eligible INTEGER, required_units_json TEXT, status TEXT, finished_at TEXT
    );
    CREATE TABLE test_submissions (submission_id TEXT PRIMARY KEY, status TEXT, started_at TEXT, finished_at TEXT);
    CREATE TABLE test_runs (
      run_id TEXT PRIMARY KEY, run_group_id TEXT, binding_id TEXT, repo_id TEXT, task_instance_id TEXT,
      unit TEXT, side TEXT, purpose TEXT, priority INTEGER DEFAULT 5, status TEXT, desired_state TEXT,
      max_attempts INTEGER, next_attempt INTEGER, lease_epoch INTEGER, created_at TEXT,
      started_at TEXT, finished_at TEXT, terminal_reason TEXT, result_sha256 TEXT, report_json TEXT, total_ms INTEGER
    );
    CREATE TABLE run_attempts (
      repo_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt INTEGER NOT NULL, worker_id TEXT, lease_epoch INTEGER,
      status TEXT, image_id TEXT, started_at TEXT, finished_at TEXT, error_code TEXT, heartbeat_at TEXT,
      PRIMARY KEY (run_id, attempt), UNIQUE (run_id, attempt, lease_epoch)
    );
    CREATE TABLE runner_leases (
      lease_id TEXT PRIMARY KEY, repo_id TEXT, run_id TEXT, attempt INTEGER, worker_id TEXT, lease_epoch INTEGER,
      lease_token_hash TEXT, expires_at TEXT, created_at TEXT, revoked_at TEXT
    );
  `)
  await db.prepare(`INSERT INTO workers VALUES ('w1', NULL)`).run()
  await db.prepare(`INSERT INTO test_bindings VALUES ('b1','img1')`).run()
  await db.prepare(`INSERT INTO test_submissions VALUES ('sub1','running',NULL,NULL)`).run()
  await db.prepare(`INSERT INTO run_groups VALUES ('g1','r1','sub1','b1','formal',1,'["static:na"]','running',NULL)`).run()
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, unit, side, purpose,
       status, desired_state, max_attempts, next_attempt, lease_epoch, created_at)
     VALUES ('run1','g1','b1','r1','t1','static','na','gate','queued','running',3,0,0,'2026-09-16T00:00:00.000Z')`
  ).run()
  return db
}

describe('重推后重新领取租约', () => {
  it('attempt 序号永久递增：重推清零预算不再撞主键，旧 attempt 保留', async () => {
    const db = await leaseDb()
    const w = { worker_id: 'w1' }
    const first = await acquireLease(db, w, { now: new Date('2026-09-16T00:00:10.000Z') })
    expect(first.attempt).toBe(1)
    // 模拟 infra 失败终态
    await db.prepare(`UPDATE test_runs SET status='error', terminal_reason='infra_error', next_attempt=1 WHERE run_id='run1'`).run()
    await db.prepare(`UPDATE run_attempts SET status='error', error_code='infra_error' WHERE run_id='run1' AND attempt=1`).run()
    await db.prepare(`UPDATE runner_leases SET revoked_at='2026-09-16T00:01:00.000Z' WHERE run_id='run1'`).run()

    await requeueRun(db, 'run1', { now: new Date('2026-09-16T00:02:00.000Z') })
    const requeued = await db.prepare(`SELECT status, next_attempt FROM test_runs WHERE run_id='run1'`).get()
    expect(requeued.status).toBe('queued')
    expect(requeued.next_attempt).toBe(0)

    const second = await acquireLease(db, w, { now: new Date('2026-09-16T00:02:10.000Z') })
    expect(second.attempt).toBe(2)
    const attempts = await db.prepare(`SELECT attempt, status FROM run_attempts WHERE run_id='run1' ORDER BY attempt`).all()
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2])
  })

  it('业务失败（assertion_failed）禁止重推', async () => {
    const db = await leaseDb()
    await db.prepare(`UPDATE test_runs SET status='failed', terminal_reason='assertion_failed' WHERE run_id='run1'`).run()
    await expect(requeueRun(db, 'run1')).rejects.toThrow(/REQUEUE_NOT_ALLOWED/)
  })
})
