/**
 * verify-evidence.js — 本地验证证据时效与借用限制
 *
 * v29 字段：workspace_head / code_snapshot_sha / output_sha256 /
 *          command_exit_code / started_at / finished_at / source
 *
 * 灰度（platform_settings）：
 *   verify_strict_freshness     = { enabled: false }  默认：只记录，不拦截
 *   verify_allow_repo_l2_fallback = { enabled: true } 默认仍允许 L2 仓级 fallback（兼容）
 *   verify_cross_repo_health      = { enabled: true } 默认仍允许跨仓 activity 判健康（兼容）
 */
import { getPlatformSetting } from '../harness/gate-policy.js'

export const FRESHNESS_KEY = 'verify_strict_freshness'
export const L2_FALLBACK_KEY = 'verify_allow_repo_l2_fallback'
export const CROSS_REPO_HEALTH_KEY = 'verify_cross_repo_health'

export async function isStrictFreshness(db) {
  const s = await getPlatformSetting(db, FRESHNESS_KEY, null)
  if (s == null) return false
  if (typeof s === 'boolean') return s
  if (typeof s === 'object') return Boolean(s.enabled)
  return s === true || s === 'true' || s === '1' || s === 'on'
}

export async function allowRepoL2Fallback(db) {
  const s = await getPlatformSetting(db, L2_FALLBACK_KEY, true)
  if (s == null) return true
  if (typeof s === 'boolean') return s
  if (typeof s === 'object') return s.enabled !== false
  return s !== false && s !== 'false' && s !== '0'
}

export async function allowCrossRepoHealth(db) {
  const s = await getPlatformSetting(db, CROSS_REPO_HEALTH_KEY, true)
  if (s == null) return true
  if (typeof s === 'boolean') return s
  if (typeof s === 'object') return s.enabled !== false
  return s !== false && s !== 'false' && s !== '0'
}

/**
 * 校验单条 verify_report 是否满足 freshness。
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function validateVerifyEvidence(row, {
  repo,
  taskId,
  anchorAt = null,
  workspaceHead = null,
  requireTaskMatch = true,
} = {}) {
  const reasons = []
  if (!row) {
    return { ok: false, reasons: ['no_verify_report'] }
  }
  if (requireTaskMatch && taskId && row.task_id && row.task_id !== taskId) {
    reasons.push('cross_task_borrow')
  }
  if (requireTaskMatch && taskId && !row.task_id) {
    reasons.push('missing_task_id')
  }
  if (repo && row.repo && row.repo !== repo) {
    reasons.push('cross_repo_borrow')
  }
  if (anchorAt && row.created_at && row.created_at < anchorAt) {
    reasons.push('stale_before_anchor')
  }
  if (workspaceHead && row.workspace_head && row.workspace_head !== workspaceHead) {
    reasons.push('workspace_head_mismatch')
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * 判断某条 pass 能否作为门禁证据。
 * 非 strict：always ok（兼容现状），但返回 reasons 供 warn 日志。
 * strict：按 validateVerifyEvidence。
 */
export async function acceptAsGateEvidence(db, row, opts = {}) {
  const v = validateVerifyEvidence(row, opts)
  if (!await isStrictFreshness(db)) {
    return { ok: true, reasons: v.reasons, strict: false }
  }
  return { ...v, strict: true }
}

/**
 * 在任务进入 EXECUTE 时写入证据锚点（meta.evidenceAnchorAt / evidenceWorkspaceHead）。
 */
export async function stampEvidenceAnchor(db, { repo, taskId, workspaceHead = null, now = new Date() }) {
  const row = await db.prepare('SELECT meta FROM tasks WHERE repo=? AND task_id=?').get(repo, taskId)
  if (!row) return null
  let meta = {}
  try {
    meta = JSON.parse(row.meta || '{}')
  } catch { meta = {} }
  meta.evidenceAnchorAt = now.toISOString()
  if (workspaceHead) meta.evidenceWorkspaceHead = workspaceHead
  await db.prepare('UPDATE tasks SET meta=? WHERE repo=? AND task_id=?').run(JSON.stringify(meta), repo, taskId)
  return meta
}
