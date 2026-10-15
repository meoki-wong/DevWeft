/**
 * §7.4 candidate_binding_approvals API：创建候选 / 审批（reviewer≠author，CHECK 强制）
 * 通过有效期的 active 记录决定 candidate 是 advisory 还是 binding（gate-eligible）
 */
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

const FIELDS = [
  'approvalId', 'repoId', 'taskInstanceId', 'branchIncarnationId',
  'candidateSuiteRevisionId', 'candidateAuthorPrincipalId', 'reviewerPrincipalId',
  'reviewedAt', 'reviewNote', 'expiresAt',
]

export async function createCandidateApproval(db, body, { now = new Date() } = {}) {
  for (const k of Object.keys(body)) if (!FIELDS.includes(k)) throw new ApiError('UNKNOWN_FIELD')
  const need = ['approvalId', 'repoId', 'taskInstanceId', 'candidateSuiteRevisionId', 'candidateAuthorPrincipalId', 'reviewerPrincipalId', 'expiresAt']
  for (const k of need) if (!body[k]) throw new ApiError('INVALID_SCHEMA')
  if (Date.parse(body.expiresAt) <= Date.parse(now.toISOString())) throw new ApiError('INVALID_SCHEMA')
  const exists = await db.prepare('SELECT 1 FROM candidate_binding_approvals WHERE approval_id=?').get(body.approvalId)
  if (exists) throw new ApiError('PRECONDITION_FAILED')
  // CHECK(reviewer_principal_id <> candidate_author_principal_id) 在 schema 层就拒绝
  await db.prepare(
    `INSERT INTO candidate_binding_approvals(
       approval_id, repo_id, task_instance_id, branch_incarnation_id,
       candidate_suite_revision_id, candidate_author_principal_id, reviewer_principal_id,
       reviewed_at, review_note, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    body.approvalId, body.repoId, body.taskInstanceId,
    body.branchIncarnationId || null, body.candidateSuiteRevisionId,
    body.candidateAuthorPrincipalId, body.reviewerPrincipalId,
    body.reviewedAt || null, body.reviewNote || null, body.expiresAt,
    now.toISOString()
  )
  return { approvalId: body.approvalId, createdAt: now.toISOString() }
}

export async function approveCandidate(db, { approvalId, reviewerPrincipalId, reviewNote, now = new Date() } = {}) {
  if (!approvalId || !reviewerPrincipalId) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM candidate_binding_approvals WHERE approval_id=?').get(approvalId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (row.effective_approval !== 'pending') throw new ApiError('SUITE_REVOKED')
  // 跨 repo / reviewer≠author 已由 schema CHECK 覆盖；这里再加 expiry 检查
  if (Date.parse(row.expires_at) <= Date.parse(now.toISOString())) {
    await db.prepare("UPDATE candidate_binding_approvals SET effective_approval='expired' WHERE approval_id=?").run(approvalId)
    throw new ApiError('LEASE_EXPIRED')
  }
  await db.prepare(
    `UPDATE candidate_binding_approvals SET effective_approval='approved', reviewed_at=?, review_note=?, reviewer_principal_id=? WHERE approval_id=?`
  ).run(now.toISOString(), reviewNote || null, reviewerPrincipalId, approvalId)
  return { approvalId, approvedAt: now.toISOString() }
}

export async function rejectCandidate(db, { approvalId, reviewerPrincipalId, reviewNote, now = new Date() } = {}) {
  if (!approvalId || !reviewerPrincipalId) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM candidate_binding_approvals WHERE approval_id=?').get(approvalId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (row.effective_approval !== 'pending') throw new ApiError('SUITE_REVOKED')
  await db.prepare(
    `UPDATE candidate_binding_approvals SET effective_approval='rejected', reviewed_at=?, review_note=?, reviewer_principal_id=? WHERE approval_id=?`
  ).run(now.toISOString(), reviewNote || null, reviewerPrincipalId, approvalId)
  return { approvalId, rejectedAt: now.toISOString() }
}

export async function expireCandidateApprovals(db, { now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const r = await db.prepare(
    `UPDATE candidate_binding_approvals SET effective_approval='expired'
     WHERE effective_approval='pending' AND expires_at <= ?`
  ).run(nowIso)
  return { expired: r.changes }
}

export async function activeCandidateApproval(db, { repoId, taskInstanceId, branchIncarnationId, now = new Date() } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const where = ['repo_id = ?', "effective_approval = 'approved'", 'expires_at > ?']
  const args = [repoId, now.toISOString()]
  if (taskInstanceId) { where.push('(task_instance_id = ? OR task_instance_id IS NULL)'); args.push(taskInstanceId) }
  if (branchIncarnationId) { where.push('(branch_incarnation_id = ? OR branch_incarnation_id IS NULL)'); args.push(branchIncarnationId) }
  return await db.prepare(
    `SELECT * FROM candidate_binding_approvals WHERE ${where.join(' AND ')}
     ORDER BY reviewed_at DESC LIMIT 1`
  ).get(...args) || null
}

export async function listCandidateApprovals(db, { repoId, taskInstanceId, effectiveApproval = null } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const where = ['repo_id = ?']
  const args = [repoId]
  if (taskInstanceId) { where.push('task_instance_id = ?'); args.push(taskInstanceId) }
  if (effectiveApproval) { where.push('effective_approval = ?'); args.push(effectiveApproval) }
  return await db.prepare(
    `SELECT * FROM candidate_binding_approvals WHERE ${where.join(' AND ')} ORDER BY created_at DESC`
  ).all(...args)
}
