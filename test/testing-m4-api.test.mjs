/** M4-B: waivers + candidate-approvals + promotion API 测试 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { ApiError } from '../testing/errors.js'
import {
  createWaiver, revokeWaiver, listWaivers, attachWaiverToPlan,
} from '../testing/waivers.js'
import {
  createCandidateApproval, approveCandidate, rejectCandidate,
  expireCandidateApprovals, activeCandidateApproval, listCandidateApprovals,
} from '../testing/candidate-approvals.js'
import {
  createProposal, transitionProposal, recordReview,
  enqueueReplayRun, markReplayRun, getProposal, listProposals,
} from '../testing/promotion.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m4b-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p2', 'u2', 'u2', 'active', 't', 't')").run()
  await db.prepare("INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, phase, size, status, author_principal_id, created_at, updated_at) VALUES ('ti1', 'r1', 'T-M4B', 'EXECUTE', 'S', 'open', 'p1', 't', 't')").run()
  await db.prepare("INSERT INTO suite_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('o1', 'project-stable', 'repo', 'r1', NULL, NULL, 0, 0, 'active', 'p1', 't')").run()
  await db.prepare("INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('sr1', 'o1', 1, 'reviewed_git', 'a', 'h', 'i', '{}', 'reviewed', 'active', 'p1', 't')").run()
  return db
}

describe('M4-B: suite_waivers', () => {
  it('createWaiver persists a non-protected case', async () => {
    const db = await memdb()
    const r = await createWaiver(db, {
      waiverId: 'w1', repoId: 'r1', taskInstanceId: 'ti1', caseKey: 'test:static/eslint',
      action: 'skip', baseSuiteRevisionId: 'sr1', reason: 'flaky in dev',
      expiresAt: '2099-01-01',
    }, { principalId: 'p1' })
    expect(r.waiverId).toBe('w1')
    expect(await listWaivers(db, { repoId: 'r1' })).toHaveLength(1)
  })
  it('createWaiver rejects protected case', async () => {
    const db = await memdb()
    await db.prepare("UPDATE suite_overlays SET protected=1 WHERE overlay_id='o1'").run()
    await expect(createWaiver(db, {
      waiverId: 'w1', repoId: 'r1', taskInstanceId: 'ti1', caseKey: 'test:static/eslint',
      action: 'skip', baseSuiteRevisionId: 'sr1', reason: 'try',
      expiresAt: '2099-01-01',
    }, { principalId: 'p1' })).rejects.toThrow(/PROTECTED_CASE_VIOLATION/)
  })
  it('createWaiver requires replacementCaseKey for replace action', async () => {
    const db = await memdb()
    await expect(createWaiver(db, {
      waiverId: 'w1', repoId: 'r1', taskInstanceId: 'ti1', caseKey: 'k',
      action: 'replace', baseSuiteRevisionId: 'sr1', reason: 'try',
      expiresAt: '2099-01-01',
    }, { principalId: 'p1' })).rejects.toThrow(/INVALID_SCHEMA/)
  })
  it('revokeWaiver marks revoked_at and is idempotent', async () => {
    const db = await memdb()
    await createWaiver(db, { waiverId: 'w1', repoId: 'r1', taskInstanceId: 'ti1', caseKey: 'k',
      action: 'skip', baseSuiteRevisionId: 'sr1', reason: 'r', expiresAt: '2099-01-01' }, { principalId: 'p1' })
    const r1 = await revokeWaiver(db, { waiverId: 'w1', principalId: 'p1' })
    expect(r1.alreadyRevoked).toBeUndefined()
    const r2 = await revokeWaiver(db, { waiverId: 'w1', principalId: 'p1' })
    expect(r2.alreadyRevoked).toBe(true)
    expect(await listWaivers(db, { repoId: 'r1', includeRevoked: true })).toHaveLength(1)
    expect(await listWaivers(db, { repoId: 'r1' })).toHaveLength(0)
  })
  it('attachWaiverToPlan checks case_key/action match', async () => {
    const db = await memdb()
    await createWaiver(db, { waiverId: 'w1', repoId: 'r1', taskInstanceId: 'ti1', caseKey: 'k',
      action: 'skip', baseSuiteRevisionId: 'sr1', reason: 'r', expiresAt: '2099-01-01' }, { principalId: 'p1' })
    await db.prepare("INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json, changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json, required_case_set_sha256, advisory_case_set_sha256, created_at) VALUES ('sp1', 'r1', 'ti1', 'pr1', '[]', 'x', 'y', 'l1', '{}', 'r', 'a', 't')").run()
    await expect(attachWaiverToPlan(db, { suitePlanId: 'sp1', waiverId: 'w1', caseKey: 'k', action: 'skip' })).resolves.toBeTruthy()
    await expect(attachWaiverToPlan(db, { suitePlanId: 'sp1', waiverId: 'w1', caseKey: 'wrong', action: 'skip' })).rejects.toThrow(/SUITE_CASE_CONFLICT/)
  })
})

describe('M4-B: candidate_binding_approvals', () => {
  it('createCandidateApproval persists and rejects same author/reviewer via CHECK', async () => {
    const db = await memdb()
    await expect(createCandidateApproval(db, {
      approvalId: 'a1', repoId: 'r1', taskInstanceId: 'ti1',
      candidateSuiteRevisionId: 'sr1', candidateAuthorPrincipalId: 'p1',
      reviewerPrincipalId: 'p1', expiresAt: '2099-01-01',
    })).rejects.toThrow(/CHECK/)
    await createCandidateApproval(db, {
      approvalId: 'a1', repoId: 'r1', taskInstanceId: 'ti1',
      candidateSuiteRevisionId: 'sr1', candidateAuthorPrincipalId: 'p1',
      reviewerPrincipalId: 'p2', expiresAt: '2099-01-01',
    })
    expect(await activeCandidateApproval(db, { repoId: 'r1', taskInstanceId: 'ti1' })).toBeNull()
  })
  it('approveCandidate flips state to approved when valid', async () => {
    const db = await memdb()
    await createCandidateApproval(db, { approvalId: 'a1', repoId: 'r1', taskInstanceId: 'ti1',
      candidateSuiteRevisionId: 'sr1', candidateAuthorPrincipalId: 'p1',
      reviewerPrincipalId: 'p2', expiresAt: '2099-01-01' })
    await approveCandidate(db, { approvalId: 'a1', reviewerPrincipalId: 'p2', reviewNote: 'lgtm' })
    const active = await activeCandidateApproval(db, { repoId: 'r1', taskInstanceId: 'ti1' })
    expect(active.review_note).toBe('lgtm')
    expect(active.reviewer_principal_id).toBe('p2')
  })
  it('approveCandidate auto-expires when past expires_at', async () => {
    const db = await memdb()
    await db.prepare("INSERT INTO candidate_binding_approvals(approval_id, repo_id, task_instance_id, branch_incarnation_id, candidate_suite_revision_id, candidate_author_principal_id, reviewer_principal_id, expires_at, created_at) VALUES ('a1', 'r1', 'ti1', NULL, 'sr1', 'p1', 'p2', '2000-01-01', '2000-01-01')").run()
    await expect(approveCandidate(db, { approvalId: 'a1', reviewerPrincipalId: 'p2' })).rejects.toThrow(/LEASE_EXPIRED/)
    expect((await db.prepare("SELECT effective_approval FROM candidate_binding_approvals WHERE approval_id='a1'").get()).effective_approval).toBe('expired')
  })
  it('expireCandidateApprovals marks pending past due', async () => {
    const db = await memdb()
    await db.prepare("INSERT INTO candidate_binding_approvals(approval_id, repo_id, task_instance_id, branch_incarnation_id, candidate_suite_revision_id, candidate_author_principal_id, reviewer_principal_id, expires_at, created_at) VALUES ('a1', 'r1', 'ti1', NULL, 'sr1', 'p1', 'p2', '2000-01-01', '2000-01-01')").run()
    const r = await expireCandidateApprovals(db)
    expect(r.expired).toBe(1)
  })
  it('rejectCandidate flips to rejected', async () => {
    const db = await memdb()
    await createCandidateApproval(db, { approvalId: 'a1', repoId: 'r1', taskInstanceId: 'ti1',
      candidateSuiteRevisionId: 'sr1', candidateAuthorPrincipalId: 'p1',
      reviewerPrincipalId: 'p2', expiresAt: '2099-01-01' })
    await rejectCandidate(db, { approvalId: 'a1', reviewerPrincipalId: 'p2' })
    const all = await listCandidateApprovals(db, { repoId: 'r1' })
    expect(all).toHaveLength(1)
    expect(all[0].effective_approval).toBe('rejected')
  })
})

describe('M4-B: promotion_proposals + replay_runs + reviews', () => {
  async function dbWithBaseTarget(db) {
    await db.prepare("INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('sr2', 'o1', 2, 'reviewed_git', 'b', 'j', 'k', '{}', 'reviewed', 'active', 'p1', 't')").run()
    return db
  }
  it('createProposal rejects same target=base revision', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await expect(createProposal(db, { proposalId: 'pp1', repoId: 'r1',
      targetSuiteRevisionId: 'sr1', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })).rejects.toThrow(/SUITE_CASE_CONFLICT/)
  })
  it('createProposal rejects duplicate active proposal for same pair', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(createProposal(db, { proposalId: 'pp2', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })).rejects.toThrow(/SUITE_CASE_CONFLICT/)
  })
  it('transitionProposal walks 5-step flow', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'diffing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'replaying', replaySummary: '{"ok":1}' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'reviewing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'merging' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'published', publishedRevisionId: 'sr2' })
    const p = await getProposal(db, 'pp1')
    expect(p.state).toBe('published')
    expect(p.published_revision_id).toBe('sr2')
    expect(p.published_at).toBeTruthy()
  })
  it('transitionProposal rejects invalid transition', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(transitionProposal(db, { proposalId: 'pp1', toState: 'published', publishedRevisionId: 'sr2' })).rejects.toThrow(/SUITE_REVOKED/)
  })
  it('recordReview rejects self-review via trigger', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(recordReview(db, { proposalId: 'pp1', reviewerPrincipalId: 'p1', verdict: 'approve' })).rejects.toThrow()
    await expect(recordReview(db, { proposalId: 'pp1', reviewerPrincipalId: 'p2', verdict: 'approve' })).resolves.toBeTruthy()
  })
  it('replay run lifecycle', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const r = await enqueueReplayRun(db, { proposalId: 'pp1', businessSnapshotId: 'bs1' })
    expect(r.status).toBe('queued')
    await markReplayRun(db, { replayRunId: r.replayRunId, status: 'passed', checksPassed: { ok: 5 } })
    const got = await db.prepare('SELECT status, finished_at, checks_passed_json FROM candidate_replay_runs WHERE replay_run_id=?').get(r.replayRunId)
    expect(got.status).toBe('passed')
    expect(JSON.parse(got.checks_passed_json).ok).toBe(5)
  })
  it('listProposals filters by repo/state', async () => {
    const db = await dbWithBaseTarget(await memdb())
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    expect(await listProposals(db, { repoId: 'r1' })).toHaveLength(1)
    expect(await listProposals(db, { repoId: 'r1', state: 'proposed' })).toHaveLength(1)
    expect(await listProposals(db, { repoId: 'r1', state: 'published' })).toHaveLength(0)
  })
})
