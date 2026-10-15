/**
 * §7.2 suite_waivers API：创建/撤销/查询；protected=true 永不允许（应用层校验）
 * 配套 bridge：suite_plan_waivers（plan↔waiver 关联）
 */
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

/** 加载 case_key 在 base_suite_revision 对应 overlay 里的 protected 标记 */
async function caseProtected(db, { repoId, caseKey, baseSuiteRevisionId }) {
  if (!baseSuiteRevisionId) return false
  const row = await db.prepare(`
    SELECT o.protected
    FROM suite_revisions r
    JOIN suite_overlays o ON o.overlay_id = r.overlay_id
    WHERE r.suite_revision_id = ? AND r.overlay_id IS NOT NULL
  `).get(baseSuiteRevisionId)
  return !!(row && row.protected === 1)
}

export async function createWaiver(db, body, { principalId, now = new Date() } = {}) {
  const allowed = ['waiverId', 'repoId', 'taskInstanceId', 'caseKey', 'action', 'baseSuiteRevisionId', 'replacementCaseKey', 'scopeBindingId', 'reason', 'expiresAt']
  for (const k of Object.keys(body)) if (!allowed.includes(k)) throw new ApiError('UNKNOWN_FIELD')
  const missing = ['waiverId', 'repoId', 'caseKey', 'action', 'baseSuiteRevisionId', 'reason', 'expiresAt'].filter((k) => !body[k])
  if (missing.length) throw new ApiError('INVALID_SCHEMA')
  if (!['skip', 'replace'].includes(body.action)) throw new ApiError('INVALID_SCHEMA')
  if (body.action === 'replace' && !body.replacementCaseKey) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (Date.parse(body.expiresAt) <= Date.parse(now.toISOString())) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (await caseProtected(db, { repoId: body.repoId, caseKey: body.caseKey, baseSuiteRevisionId: body.baseSuiteRevisionId })) {
    // §7.2: protected 用例绝不允许 waiver
    throw new ApiError('PROTECTED_CASE_VIOLATION')
  }
  const nowIso = now.toISOString()
  const exists = await db.prepare('SELECT 1 FROM suite_waivers WHERE waiver_id=?').get(body.waiverId)
  if (exists) throw new ApiError('PRECONDITION_FAILED')
  await db.prepare(
    `INSERT INTO suite_waivers(
       waiver_id, repo_id, task_instance_id, case_key, action,
       base_suite_revision_id, replacement_case_key, scope_binding_id,
       reason, approved_by, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    body.waiverId, body.repoId, body.taskInstanceId || null, body.caseKey, body.action,
    body.baseSuiteRevisionId, body.replacementCaseKey || null, body.scopeBindingId || null,
    body.reason, principalId, body.expiresAt, nowIso
  )
  return { waiverId: body.waiverId, createdAt: nowIso }
}

export async function revokeWaiver(db, { waiverId, principalId, now = new Date() } = {}) {
  if (!waiverId) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM suite_waivers WHERE waiver_id=?').get(waiverId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (row.revoked_at) return { waiverId, alreadyRevoked: true }
  await db.prepare('UPDATE suite_waivers SET revoked_at=? WHERE waiver_id=?').run(now.toISOString(), waiverId)
  return { waiverId, revokedAt: now.toISOString(), revokedBy: principalId }
}

export async function listWaivers(db, { repoId, caseKey, includeRevoked = false } = {}) {
  const where = ['repo_id = ?']
  const args = [repoId]
  if (caseKey) { where.push('case_key = ?'); args.push(caseKey) }
  if (!includeRevoked) where.push('revoked_at IS NULL')
  return await db.prepare(
    `SELECT waiver_id, repo_id, case_key, action, base_suite_revision_id,
            replacement_case_key, scope_binding_id, reason, approved_by,
            expires_at, revoked_at, created_at
     FROM suite_waivers WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC`
  ).all(...args)
}

export async function attachWaiverToPlan(db, { suitePlanId, waiverId, caseKey, action }) {
  if (!suitePlanId || !waiverId || !caseKey || !action) throw new ApiError('INVALID_SCHEMA')
  if (!['skip', 'replace'].includes(action)) throw new ApiError('INVALID_SCHEMA')
  // 校验：case_key 与 waiver 自身一致
  const w = await db.prepare('SELECT case_key, action, revoked_at FROM suite_waivers WHERE waiver_id=?').get(waiverId)
  if (!w) throw new ApiError('INVALID_SCHEMA')
  if (w.revoked_at) throw new ApiError('SUITE_REVOKED')
  if (w.case_key !== caseKey || w.action !== action) throw new ApiError('SUITE_CASE_CONFLICT')
  await db.prepare(
    `INSERT INTO suite_plan_waivers(suite_plan_id, waiver_id, case_key, action)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  ).run(suitePlanId, waiverId, caseKey, action)
  return { suitePlanId, waiverId, caseKey, action }
}
