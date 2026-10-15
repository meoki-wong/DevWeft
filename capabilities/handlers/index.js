/**
 * capabilities/handlers/index.js — 方案 §9：租户能力 handler 注册表。
 *
 * 约束（§15.2）：
 *   - handler 文件只能放在本仓库 capabilities/handlers/ 目录，并在本文件登记；
 *     禁止按数据库记录或 awp.config.json 去 import 业务仓路径。
 *   - 未在本表登记的 handler_id → resolveCapability 返回 CAPABILITY_HANDLER_MISSING，
 *     不得回落 default。
 *
 * handler 签名（按组合类）：
 *   replace（harness.activityPlan）      : (defaultResult, params, ctx) => 新结果（整体替换）
 *   params  （harness.instructions 等）  : (defaultResult, params, ctx) => 新结果（基于现有输出改参数/文案）
 *   floor   （harness.guard/gate.policy）: (defaultResult, params, ctx) => { blockedBy: [...] }
 *                                           —— 只能追加阻断项，不能删减/放行
 */
const HANDLERS = new Map()

export function registerHandler(handlerId, fn) {
  if (typeof fn !== 'function') throw new Error(`handler ${handlerId} 必须是函数`)
  HANDLERS.set(handlerId, fn)
  return handlerId
}

export function getHandler(handlerId) {
  return HANDLERS.get(handlerId) || null
}

export function hasHandler(handlerId) {
  return HANDLERS.has(handlerId)
}

export function listHandlers() {
  return [...HANDLERS.keys()]
}
