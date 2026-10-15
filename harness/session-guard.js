/**
 * session-guard.js — 任务 session 所有权校验
 *
 * 灰度（platform_settings）：
 *   harness_strict_session = { enabled: false }  默认 warn：记录 would-block，不拦截
 *   harness_strict_session = { enabled: true }   enforce：非 owner 抛 TASK_SESSION_HELD
 *
 * 语义：
 *   - 无 active session：不拦截（与现状兼容；enforce 模式下可选择自动 acquire）
 *   - 有 active session 且 owner === author：放行并心跳续期
 *   - 有 active session 且 owner !== author：
 *       warn     → 记录 warn，放行
 *       enforce  → 抛 TASK_SESSION_HELD
 */
import { getPlatformSetting } from './gate-policy.js'
import {
  getActiveTaskSession,
  heartbeatTaskSession,
  acquireTaskSession,
} from './loop.js'

export const STRICT_SESSION_KEY = 'harness_strict_session'

export async function isStrictSessionEnabled(db) {
  const s = await getPlatformSetting(db, STRICT_SESSION_KEY, null)
  if (s == null) return false
  if (typeof s === 'boolean') return s
  if (typeof s === 'object') return Boolean(s.enabled)
  return s === true || s === 'true' || s === '1' || s === 'on'
}

/**
 * 校验作者是否有权驱动该任务。
 * @returns {{ok: true, mode: 'owner'|'free'|'acquired'|'warn', session?} |
 *           {ok: false, code: 'TASK_SESSION_HELD', detail, owner, expiresAt}}
 */
export async function assertTaskDriver(db, { repo, taskId, author, now = new Date() }) {
  if (!author) {
    // 无 author 无法判定所有权；warn/enforce 均不拦（与历史行为一致）
    return { ok: true, mode: 'free' }
  }
  const active = await getActiveTaskSession(db, { repo, taskId, now })
  if (!active) {
    return { ok: true, mode: 'free' }
  }
  if (active.owner_subject === author) {
    try {
      await heartbeatTaskSession(db, { repo, taskId, ownerSubject: author, now })
    } catch { /* 心跳失败不阻断 */ }
    return { ok: true, mode: 'owner', session: active }
  }

  const strict = await isStrictSessionEnabled(db)
  const detail = `当前由 ${active.owner_subject} 驱动，expiresAt=${active.expires_at}`
  if (strict) {
    return {
      ok: false,
      code: 'TASK_SESSION_HELD',
      detail,
      owner: active.owner_subject,
      expiresAt: active.expires_at,
    }
  }
  // warn-only：记录 would-block，放行
  try {
    process.stderr.write(
      `[session-guard] WARN would-block TASK_SESSION_HELD task=${taskId} author=${author} owner=${active.owner_subject}\n`
    )
  } catch { /* ignore */ }
  return { ok: true, mode: 'warn', session: active, wouldBlock: detail }
}

/**
 * resume 路径：领取/续期租约。他人持锁时返回 ok=false（调用方必须处理）。
 */
export async function acquireOrHeartbeatSession(db, { repo, taskId, author, state = 'coding', now = new Date() }) {
  if (!author) return { ok: true, skipped: true }
  const r = await acquireTaskSession(db, { repo, taskId, ownerSubject: author, state, now })
  if (r && r.ok === false) {
    const strict = await isStrictSessionEnabled(db)
    if (!strict) {
      try {
        process.stderr.write(
          `[session-guard] WARN resume would-block TASK_SESSION_HELD task=${taskId} author=${author} owner=${r.owner}\n`
        )
      } catch { /* ignore */ }
      return { ok: true, mode: 'warn', wouldBlock: r }
    }
    return r
  }
  return r || { ok: true }
}
