/**
 * §7.5 promotion_proposals API：5 步流程
 *   proposed → diffing → replaying → reviewing → merging → published
 *                                              └→ rejected
 * 禁止把 candidate 原记录原地改成 stable/repo/branch revision（spec 明确禁止）
 * CAS 通道（active revision 替换）+ 计划性 replay 编排在 M4-C 实现
 */
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

const VALID_TRANSITIONS = {
  proposed:  ['diffing', 'rejected'],
  diffing:   ['replaying', 'rejected'],
  replaying: ['reviewing', 'rejected'],
  reviewing: ['merging', 'rejected', 'proposed'],  // 退回重做
  merging:   ['published', 'rejected'],
  published: [],  // 终态
  rejected:  ['proposed'],  // 可重启
}

export async function createProposal(db, body, { authorPrincipalId, now = new Date() } = {}) {
  for (const k of Object.keys(body)) {
    if (!['proposalId', 'repoId', 'targetSuiteRevisionId', 'baseSuiteRevisionId', 'structuredDiff'].includes(k)) {
      throw new ApiError('UNKNOWN_FIELD')
    }
  }
  const need = ['proposalId', 'repoId', 'targetSuiteRevisionId', 'baseSuiteRevisionId']
  for (const k of need) if (!body[k]) throw new ApiError('INVALID_SCHEMA')
  // base/target 必须是不同 revision
  if (body.targetSuiteRevisionId === body.baseSuiteRevisionId) throw new ApiError('SUITE_CASE_CONFLICT')
  // 同一 overlay+content 不允许重复 proposal（content equality → 同质）
  const dup = await db.prepare(
    `SELECT 1 FROM promotion_proposals WHERE target_suite_revision_id=? AND base_suite_revision_id=? AND state IN ('proposed','diffing','replaying','reviewing','merging')`
  ).get(body.targetSuiteRevisionId, body.baseSuiteRevisionId)
  if (dup) throw new ApiError('SUITE_CASE_CONFLICT')
  const exists = await db.prepare('SELECT 1 FROM promotion_proposals WHERE proposal_id=?').get(body.proposalId)
  if (exists) throw new ApiError('PRECONDITION_FAILED')
  const nowIso = now.toISOString()
  await db.prepare(
    `INSERT INTO promotion_proposals(
       proposal_id, repo_id, target_suite_revision_id, base_suite_revision_id,
       author_principal_id, state, structured_diff_json, proposed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`
  ).run(
    body.proposalId, body.repoId, body.targetSuiteRevisionId, body.baseSuiteRevisionId,
    authorPrincipalId, body.structuredDiff || null,
    nowIso, nowIso
  )
  return { proposalId: body.proposalId, state: 'proposed', createdAt: nowIso }
}

export async function transitionProposal(db, { proposalId, toState, replaySummary, publishedRevisionId, now = new Date() } = {}) {
  if (!proposalId || !toState) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM promotion_proposals WHERE proposal_id=?').get(proposalId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  const allowed = VALID_TRANSITIONS[row.state] || []
  if (!allowed.includes(toState)) throw new ApiError('SUITE_REVOKED')
  const nowIso = now.toISOString()
  if (toState === 'published') {
    if (!publishedRevisionId) throw new ApiError('INVALID_SCHEMA')
    await db.prepare(
      `UPDATE promotion_proposals SET state=?, published_revision_id=?, published_at=?, updated_at=? WHERE proposal_id=?`
    ).run(toState, publishedRevisionId, nowIso, nowIso, proposalId)
  } else if (toState === 'replaying') {
    if (!replaySummary) throw new ApiError('INVALID_SCHEMA')
    await db.prepare(
      `UPDATE promotion_proposals SET state=?, replay_summary_json=?, updated_at=? WHERE proposal_id=?`
    ).run(toState, replaySummary, nowIso, proposalId)
  } else {
    await db.prepare(
      `UPDATE promotion_proposals SET state=?, updated_at=? WHERE proposal_id=?`
    ).run(toState, nowIso, proposalId)
  }
  return { proposalId, from: row.state, to: toState, at: nowIso }
}

export async function recordReview(db, { proposalId, reviewerPrincipalId, verdict, note, now = new Date() } = {}) {
  if (!proposalId || !reviewerPrincipalId || !verdict) throw new ApiError('INVALID_SCHEMA')
  if (!['approve', 'reject', 'request_changes'].includes(verdict)) throw new ApiError('INVALID_SCHEMA')
  const prop = await db.prepare('SELECT * FROM promotion_proposals WHERE proposal_id=?').get(proposalId)
  if (!prop) throw new ApiError('INVALID_SCHEMA')
  // 必须是作者 ≠ reviewer（v7 trg_promotion_review_not_author 已保护）
  const reviewId = uuidv7()
  await db.prepare(
    `INSERT INTO promotion_reviews(review_id, proposal_id, reviewer_principal_id, verdict, note, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(reviewId, proposalId, reviewerPrincipalId, verdict, note || null, now.toISOString())
  return { reviewId, proposalId, reviewerPrincipalId, verdict, reviewedAt: now.toISOString() }
}

export async function enqueueReplayRun(db, { proposalId, businessSnapshotId, now = new Date() } = {}) {
  if (!proposalId || !businessSnapshotId) throw new ApiError('INVALID_SCHEMA')
  const replayRunId = uuidv7()
  await db.prepare(
    `INSERT INTO candidate_replay_runs(replay_run_id, proposal_id, business_snapshot_id, status, started_at)
     VALUES (?, ?, ?, 'queued', ?)`
  ).run(replayRunId, proposalId, businessSnapshotId, now.toISOString())
  return { replayRunId, status: 'queued' }
}

export async function markReplayRun(db, { replayRunId, status, checksPassed, now = new Date() } = {}) {
  if (!replayRunId || !status) throw new ApiError('INVALID_SCHEMA')
  if (!['running', 'passed', 'failed', 'error', 'canceled'].includes(status)) throw new ApiError('INVALID_SCHEMA')
  const nowIso = now.toISOString()
  await db.prepare(
    `UPDATE candidate_replay_runs SET status=?, finished_at=?, checks_passed_json=? WHERE replay_run_id=?`
  ).run(status, nowIso, checksPassed ? JSON.stringify(checksPassed) : null, replayRunId)
  return { replayRunId, status }
}

export async function getProposal(db, proposalId) {
  return await db.prepare('SELECT * FROM promotion_proposals WHERE proposal_id=?').get(proposalId) || null
}

export async function listProposals(db, { repoId, state, limit = 50 } = {}) {
  const where = []
  const args = []
  if (repoId) { where.push('repo_id = ?'); args.push(repoId) }
  if (state) { where.push('state = ?'); args.push(state) }
  const sql = `SELECT * FROM promotion_proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY proposed_at DESC LIMIT ?`
  args.push(limit)
  return await db.prepare(sql).all(...args)
}
