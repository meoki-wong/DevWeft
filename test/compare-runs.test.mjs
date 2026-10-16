import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { compareTestRuns } from '../testing/compare-runs.js'

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE test_runs(run_id TEXT, repo_id TEXT, binding_id TEXT, run_group_id TEXT, unit TEXT, side TEXT, purpose TEXT, status TEXT, terminal_reason TEXT, total_ms INTEGER, created_at TEXT, started_at TEXT, finished_at TEXT, report_json TEXT);
    CREATE TABLE test_bindings(binding_id TEXT, suite_plan_id TEXT, required_case_set_sha256 TEXT, execution_profile_revision_id TEXT, runner_image_id TEXT, runner_image_manifest_sha256 TEXT, policy_revision_id TEXT);
    CREATE TABLE suite_plans(suite_plan_id TEXT, lock_sha256 TEXT);
    CREATE TABLE execution_profile_revisions(profile_revision_id TEXT, content_sha256 TEXT);
    CREATE TABLE runner_images(image_id TEXT, manifest_sha256 TEXT);
    CREATE TABLE policy_revisions(policy_revision_id TEXT, content_sha256 TEXT);
    INSERT INTO suite_plans VALUES ('suite','lock-1');
    INSERT INTO execution_profile_revisions VALUES ('profile','profile-hash');
    INSERT INTO runner_images VALUES ('image','image-hash');
    INSERT INTO policy_revisions VALUES ('policy','policy-hash');
    INSERT INTO test_bindings VALUES
      ('b1','suite','cases-ab','profile','image','image-hash','policy'),
      ('b2','suite','cases-ab','profile','image','image-hash','policy'),
      ('b3','suite','cases-bc','profile','image','image-hash','policy');
    INSERT INTO test_runs VALUES
      ('r1','repo-a','b1','g1','static','linux','gate','failed','assertion_failed',1200,'2026-01-01',NULL,'2026-01-01','{"checks":[{"caseKey":"a","status":"passed"},{"caseKey":"b","status":"failed","detail":"bad"}]}'),
      ('r2','repo-a','b2','g2','static','linux','gate','passed',NULL,900,'2026-01-02',NULL,'2026-01-02','{"checks":[{"caseKey":"a","status":"passed"},{"caseKey":"b","status":"passed"}]}'),
      ('r3','repo-a','b3','g3','static','linux','gate','failed','assertion_failed',1500,'2026-01-03',NULL,'2026-01-03','{"checks":[{"caseKey":"b","status":"failed"},{"caseKey":"c","status":"passed"}]}'),
      ('foreign','repo-b','b2','g4','static','linux','gate','passed',NULL,900,'2026-01-02',NULL,'2026-01-02','{"checks":[]}');
  `)
})
afterEach(() => db.close())

describe('run comparison evidence and comparability', () => {
  it('compares status and duration when frozen configuration and case set match', async () => {
    const result = await compareTestRuns(db, 'r1', 'r2')
    expect(result).toMatchObject({ ok: true, comparable: true, durationDeltaMs: -300,
      caseSet: { equal: true, added: [], removed: [], common: 2 },
      statusChanges: [{ caseKey: 'b', before: 'failed', after: 'passed' }],
      failedChecks: { before: [{ caseKey: 'b', status: 'failed', detail: 'bad' }], after: [] },
      denominator: { before: 2, after: 2, common: 2 } })
  })

  it('surfaces changed cases first and marks incomparable runs instead of claiming improvement', async () => {
    const result = await compareTestRuns(db, 'r1', 'r3')
    expect(result).toMatchObject({ comparable: false, caseSet: { equal: false, added: ['c'], removed: ['a'], common: 1 } })
    expect(result.comparabilityReasons).toContain('检查项集合发生变化')
    expect(result.configuration.requiredCaseSetSha256.equal).toBe(false)
  })

  it('rejects cross-repository comparisons and missing/same run inputs', async () => {
    expect(await compareTestRuns(db, 'r1', 'foreign')).toMatchObject({ status: 403 })
    expect(await compareTestRuns(db, 'r1', 'absent')).toMatchObject({ status: 404 })
    expect(await compareTestRuns(db, 'r1', 'r1')).toMatchObject({ status: 400 })
  })
})
