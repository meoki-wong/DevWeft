/**
 * dispatch.js — 方案 §9：租户能力解析与组合类执行。
 *
 * resolveCapability(db, { feature, repoSlug })：
 *   - slug 校验与 ensureTenantRepo 一致：小写、^[a-z0-9][a-z0-9._-]*$、≤63，非法拒绝
 *     （不得改用 demo-app，§15.2）
 *   - 无 active 行 → { ok:true, registered:false }（调用方走 default，行为与 §8 结束时一致）
 *   - 有行且 handler_id 已在 capabilities/handlers/ 注册 → { ok:true, registered:true, handler, params }
 *   - 有行且未注册 → { ok:false, code:'CAPABILITY_HANDLER_MISSING' }（不得调用 default）
 *
 * 组合类（§15.2 表）：
 *   harness.activityPlan replace | harness.instructions params | harness.guard floor
 *   gate.policy floor | review.chain params | e2e.inject params | static.checks params
 *   floor：先跑 default，租户逻辑只能向 blockedBy 追加，不能删减；只升不降仍写在
 *   resolveGatePolicy 里面。
 */
import { buildActivityPlan } from './activity-plan.js'
import { hasHandler, getHandler as registryGet } from '../capabilities/handlers/index.js'

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/

/** §9 支持的 feature 与组合类（表驱动，防拼写漂移） */
export const CAPABILITY_FEATURES = Object.freeze({
  'harness.activityPlan': 'replace',
  'harness.instructions': 'params',
  'harness.guard': 'floor',
  'gate.policy': 'floor',
  'review.chain': 'params',
  'e2e.inject': 'params',
  'static.checks': 'params',
})

/**
 * @returns {{ ok:true, feature, registered:false }
 *          | { ok:true, feature, registered:true, handlerId, handler, params }
 *          | { ok:false, code:'CAPABILITY_HANDLER_MISSING', feature, handlerId }
 *          | { ok:false, code:'INVALID_REPO_SLUG', feature }}
 */
export async function resolveCapability(db, { feature, repoSlug }) {
  if (!CAPABILITY_FEATURES[feature]) {
    return { ok: false, code: 'UNKNOWN_FEATURE', feature }
  }
  const clean = String(repoSlug || '').toLowerCase()
  if (!SLUG_RE.test(clean) || clean.length > 63) {
    return { ok: false, code: 'INVALID_REPO_SLUG', feature }
  }
  let row = null
  try {
    row = await db
      .prepare(
        `SELECT e.handler_id, e.params_json, e.revision
         FROM tenant_extensions e
         JOIN repositories r ON r.repo_id = e.repo_id
         WHERE r.slug = ? AND e.feature = ? AND e.state = 'active'
         ORDER BY e.revision DESC LIMIT 1`
      )
      .get(clean, feature)
  } catch {
    // 表未建（旧库未跑 v36）→ 无扩展，走 default
    return { ok: true, feature, registered: false }
  }
  if (!row) return { ok: true, feature, registered: false }
  if (!hasHandler(row.handler_id)) {
    return { ok: false, code: 'CAPABILITY_HANDLER_MISSING', feature, handlerId: row.handler_id }
  }
  let params = {}
  try {
    params = JSON.parse(row.params_json || '{}')
  } catch {
    params = {}
  }
  return {
    ok: true,
    feature,
    registered: true,
    handlerId: row.handler_id,
    handler: registryGet(row.handler_id),
    params,
  }
}

/** 阶段推进前的快速检查：任一 feature 有登记但 handler 未注册 → 返回错误对象（阶段不变） */
export async function assertNoMissingHandlers(db, { repoSlug, features }) {
  for (const feature of features) {
    const cap = await resolveCapability(db, { feature, repoSlug })
    if (!cap.ok && cap.code === 'CAPABILITY_HANDLER_MISSING') return cap
  }
  return null
}

/** replace 类：harness.activityPlan —— 无登记走 default；有登记由 handler 整体替换 */
export async function buildActivityPlanDispatched(db, { repoSlug, signals }) {
  const cap = await resolveCapability(db, { feature: 'harness.activityPlan', repoSlug })
  if (!cap.ok) throw capabilityError(cap)
  if (!cap.registered) return buildActivityPlan(signals)
  const replacement = cap.handler(buildActivityPlan(signals), cap.params, { signals, repoSlug })
  return Array.isArray(replacement) ? replacement : buildActivityPlan(signals)
}

/**
 * floor 类（harness.guard / gate.policy）：default 先跑，租户 handler 只能向
 * blockedBy 追加。返回 default 的浅拷贝（blockedBy 合并去重，顺序：default 在前）。
 */
export async function applyFloorDispatched(db, { repoSlug, feature, defaultResult, ctx = {} }) {
  const cap = await resolveCapability(db, { feature, repoSlug })
  if (!cap.ok) throw capabilityError(cap)
  if (!cap.registered) return defaultResult
  const tenant = cap.handler(defaultResult, cap.params, ctx) || {}
  const combined = [...(defaultResult.blockedBy || []), ...(tenant.blockedBy || []).map(String)]
  const merged = { ...defaultResult, blockedBy: combined }
  // guard 形状(ok === blockedBy 为空):租户追加阻断 → 结果必须阻断(floor 只增不减)
  if ('ok' in defaultResult && Array.isArray(defaultResult.blockedBy)) {
    merged.ok = combined.length === 0
  }
  return merged
}

function capabilityError(cap) {
  const err = new Error(cap.code || 'CAPABILITY_ERROR')
  err.code = cap.code
  err.feature = cap.feature
  err.handlerId = cap.handlerId || null
  return err
}
