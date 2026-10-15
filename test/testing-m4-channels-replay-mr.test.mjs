/** M4-C: channels + replay-runner + mr-client 测试 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { publishToChannel, getActiveChannel, listChannels } from '../testing/channels.js'
import { runReplay, MockReplayRunner } from '../testing/replay-runner.js'
import { MockMRClient, openProposalMR, syncProposalMRState, mergeProposalMR } from '../testing/mr-client.js'
import { createProposal, transitionProposal } from '../testing/promotion.js'
import { ApiError } from '../testing/errors.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m4c-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare("INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at) VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p1', 'u1', 'u1', 'active', 't', 't')").run()
  await db.prepare("INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at) VALUES ('p2', 'u2', 'u2', 'active', 't', 't')").run()
  await db.prepare("INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, phase, size, status, author_principal_id, created_at, updated_at) VALUES ('ti1', 'r1', 'T-M4C', 'EXECUTE', 'S', 'open', 'p1', 't', 't')").run()
  await db.prepare("INSERT INTO suite_overlays(overlay_id, logical_name, layer, repo_id, branch_incarnation_id, task_instance_id, ordinal, protected, state, created_by, created_at) VALUES ('o1', 'project-stable', 'repo', 'r1', NULL, NULL, 0, 1, 'active', 'p1', 't')").run()
  await db.prepare("INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('sr1', 'o1', 1, 'reviewed_git', 'a', 'h', 'i', '{}', 'reviewed', 'active', 'p1', 't')").run()
  await db.prepare("INSERT INTO suite_revisions(suite_revision_id, overlay_id, revision, source_kind, tree_oid, content_sha256, manifest_sha256, manifest_json, approval_state, publication_state, created_by, created_at) VALUES ('sr2', 'o1', 2, 'reviewed_git', 'b', 'j', 'k', '{}', 'reviewed', 'active', 'p1', 't')").run()
  return db
}

describe('M4-C: suite_channels CAS publish', () => {
  it('publishToChannel writes both candidate and active channels (dual-write)', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'diffing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'replaying', replaySummary: '{}' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'reviewing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'merging' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'published', publishedRevisionId: 'sr2' })
    const r = await publishToChannel(db, { proposalId: 'pp1' }, { actorPrincipalId: 'p1' })
    expect(r.publishedAt).toBeTruthy()
    const active = await getActiveChannel(db, { overlayId: 'o1' })
    expect(active.active_revision_id).toBe('sr2')
    expect(active.revision).toBeGreaterThanOrEqual(1)
    const channels = await listChannels(db, { overlayId: 'o1' })
    expect(channels.map((c) => c.channel).sort()).toEqual(['active', 'candidate'])
  })
  it('publishToChannel requires state=published', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(publishToChannel(db, { proposalId: 'pp1' }, { actorPrincipalId: 'p1' })).rejects.toThrow(/SUITE_REVOKED/)
  })
  it('publishToChannel same revision is noop', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr1', baseSuiteRevisionId: 'sr2' }, { authorPrincipalId: 'p1' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'diffing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'replaying', replaySummary: '{}' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'reviewing' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'merging' })
    await transitionProposal(db, { proposalId: 'pp1', toState: 'published', publishedRevisionId: 'sr1' })
    await publishToChannel(db, { proposalId: 'pp1' }, { actorPrincipalId: 'p1' })
    // 再发一次同 revision：no-op
    await createProposal(db, { proposalId: 'pp2', repoId: 'r1', targetSuiteRevisionId: 'sr1', baseSuiteRevisionId: 'sr2' }, { authorPrincipalId: 'p1' })
    await transitionProposal(db, { proposalId: 'pp2', toState: 'diffing' })
    await transitionProposal(db, { proposalId: 'pp2', toState: 'replaying', replaySummary: '{}' })
    await transitionProposal(db, { proposalId: 'pp2', toState: 'reviewing' })
    await transitionProposal(db, { proposalId: 'pp2', toState: 'merging' })
    await transitionProposal(db, { proposalId: 'pp2', toState: 'published', publishedRevisionId: 'sr1' })
    const r = await publishToChannel(db, { proposalId: 'pp2' }, { actorPrincipalId: 'p1' })
    expect(r.noop).toBe(true)
  })
})

describe('M4-C: replay-runner state machine', () => {
  it('MockReplayRunner: happy path passed', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const runner = new MockReplayRunner({ defaultPass: true })
    const r = await runReplay(db, { proposalId: 'pp1', businessSnapshotId: 'bs1', runner })
    expect(r.replayRunId).toBeTruthy()
    expect(r.status).toBe('passed')
    expect(r.checksPassed.passed).toBe(5)
    const row = await db.prepare('SELECT status, finished_at, checks_passed_json FROM candidate_replay_runs WHERE replay_run_id=?').get(r.replayRunId)
    expect(row.status).toBe('passed')
    expect(JSON.parse(row.checks_passed_json).total).toBe(5)
  })
  it('MockReplayRunner: fail proposal yields failed replay', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp-fail', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const runner = new MockReplayRunner({ defaultPass: true })
    const r = await runReplay(db, { proposalId: 'pp-fail', businessSnapshotId: 'bs1', runner })
    expect(r.status).toBe('failed')
  })
  it('replay runner propagates runner errors to error state', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const badRunner = {
      async run() { throw new Error('runner explode') }
    }
    await expect(runReplay(db, { proposalId: 'pp1', businessSnapshotId: 'bs1', runner: badRunner })).rejects.toThrow(/runner explode/)
    const row = await db.prepare("SELECT status FROM candidate_replay_runs ORDER BY started_at DESC LIMIT 1").get()
    expect(row.status).toBe('error')
  })
  it('replay-runner requires runner', async () => {
    const db = await memdb()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(runReplay(db, { proposalId: 'pp1', businessSnapshotId: 'bs1', runner: null })).rejects.toThrow(/INVALID_SCHEMA/)
  })
})

describe('M4-C: MR integration (MockMRClient)', () => {
  it('openProposalMR persists mr_id and state', async () => {
    const db = await memdb()
    const mc = new MockMRClient()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const mr = await openProposalMR(mc, db, { proposalId: 'pp1', sourceBranch: 'feat/x', targetBranch: 'main', title: 't', body: 'b', repoId: 'r1' })
    expect(mr.state).toBe('opened')
    const row = await db.prepare("SELECT mr_state, mr_iid, mr_url FROM promotion_proposals WHERE proposal_id='pp1'").get()
    expect(row.mr_state).toBe('opened')
    expect(row.mr_iid).toBe('1')
    expect(row.mr_url).toContain('r1/mr/1')
  })
  it('syncProposalMRState syncs state from MR client', async () => {
    const db = await memdb()
    const mc = new MockMRClient()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    const mr = await openProposalMR(mc, db, { proposalId: 'pp1', sourceBranch: 'feat/x', targetBranch: 'main', title: 't', body: 'b', repoId: 'r1' })
    mc.setState(`r1:1`, 'mergeable')
    const s = await syncProposalMRState(mc, db, { proposalId: 'pp1', mrKey: 'r1:1' })
    expect(s.state).toBe('mergeable')
    expect((await db.prepare("SELECT mr_state FROM promotion_proposals WHERE proposal_id='pp1'").get()).mr_state).toBe('mergeable')
  })
  it('mergeProposalMR flips state to merged', async () => {
    const db = await memdb()
    const mc = new MockMRClient()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await openProposalMR(mc, db, { proposalId: 'pp1', sourceBranch: 'feat/x', targetBranch: 'main', title: 't', body: 'b', repoId: 'r1' })
    const m = await mergeProposalMR(mc, db, { proposalId: 'pp1', mrKey: 'r1:1' })
    expect(m.state).toBe('merged')
    expect((await db.prepare("SELECT mr_state FROM promotion_proposals WHERE proposal_id='pp1'").get()).mr_state).toBe('merged')
  })
  it('AbstractReplayRunner base class throws', async () => {
    const db = await memdb()
    const runner = new (await import('../testing/replay-runner.js')).AbstractReplayRunner()
    await createProposal(db, { proposalId: 'pp1', repoId: 'r1', targetSuiteRevisionId: 'sr2', baseSuiteRevisionId: 'sr1' }, { authorPrincipalId: 'p1' })
    await expect(runReplay(db, { proposalId: 'pp1', businessSnapshotId: 'bs1', runner })).rejects.toThrow(/not implemented/)
  })
})
