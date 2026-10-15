/**
 * secret_ref 编排（§14.10）：控制面只持有 ref 与 grant 记录，永不接触明文。
 * capability 集合按 profile.secretCapabilitySetId 解析；project 默认走受控 npm 代理（集合为空，
 * 明文 token 不进 Guest），机制以 secret-canary 全链路验证。
 */
import { ApiError } from './errors.js'
import { uuidv7 } from './ids.js'

export const GRANT_TTL_MS = 15 * 60 * 1000

/** capability set -> [{ capability, secretRef }]。npm-readonly-v1 置空：包代理代替 Guest 注入。 */
export const SECRET_CAPABILITY_SETS = {
  'npm-readonly-v1': [],
  'guest-npm-token-v1': [
    { capability: 'npm-registry-token', secretRef: 'npm/demo-app/readonly' },
  ],
  'secret-canary-v1': [
    { capability: 'secret-canary', secretRef: 'canary/awp-secret-canary' },
  ],
}

export function capabilitiesForProfileSet(setId) {
  if (!setId) return []
  const set = SECRET_CAPABILITY_SETS[setId]
  if (!set) throw new ApiError('INVALID_SCHEMA')
  return set
}

/**
 * 在 accept 前（lease 已存在）创建 lease 绑定 grant。broker 为传输对象：
 *   { createGrant(grant) -> Promise<{secretGrantId,status}> }
 * 明文不经过本函数。broker 不可用视为 accept 失败（不得静默降级为空 ref）。
 */
export async function createGrantsForLease(db, { lease, profile, workerId, broker, now = new Date() }) {
  const entries = capabilitiesForProfileSet(profile?.secretCapabilitySetId)
  if (!entries.length) return []
  if (!broker || typeof broker.createGrant !== 'function') {
    throw new ApiError('INVALID_SCHEMA')
  }
  const expiresAt = new Date(now.getTime() + GRANT_TTL_MS).toISOString()
  const created = []
  for (const entry of entries) {
    const secretGrantId = uuidv7()
    // 必须等 broker 确认后再写控制面记录；fire-and-forget 会造成两库状态竞态
    await broker.createGrant({
      secretGrantId,
      secretRef: entry.secretRef,
      workerId,
      leaseId: lease.lease_id,
      capability: entry.capability,
      expiresAt,
    })
    await db.prepare(
      `INSERT INTO secret_grants(
         secret_grant_id, repo_id, lease_id, worker_id, capability, secret_ref,
         status, issued_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, ?)`
    ).run(
      secretGrantId,
      lease.repo_id,
      lease.lease_id,
      workerId,
      entry.capability,
      entry.secretRef,
      now.toISOString(),
      expiresAt
    )
    created.push({
      secretGrantId,
      secretRef: entry.secretRef,
      capability: entry.capability,
      expiresAt,
    })
  }
  return created
}

export async function markGrantsRevoked(db, { leaseId, now = new Date() } = {}) {
  return (await db.prepare(
    `UPDATE secret_grants SET status='revoked', revoked_at=? WHERE lease_id=? AND status IN ('issued','fetched')`
  ).run(now.toISOString(), leaseId)).changes
}

export async function markGrantsFetched(db, { leaseId, now = new Date() } = {}) {
  return (await db.prepare(
    `UPDATE secret_grants SET status='fetched', fetched_at=? WHERE lease_id=? AND status='issued'`
  ).run(now.toISOString(), leaseId)).changes
}
