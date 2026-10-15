/**
 * tenant-context.js — 方案 §8/§14.1：请求级租户上下文（AsyncLocalStorage）。
 *
 * server.js 在解析出请求归属 repo 后以 runWithTenant(repoId, fn) 包裹处理链；
 * postgres 驱动在租户上下文存在时，对事务外的单条语句自动套
 * 「BEGIN → SET LOCAL app.tenant_id → 语句 → COMMIT」（§14.1 禁止会话级 SET）。
 * sqlite 方言无 RLS：上下文被设置但不产生任何行为差异。
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const als = new AsyncLocalStorage()

/** 在租户上下文内执行 fn（tenantId = repositories.repo_id） */
export function runWithTenant(tenantRepoId, fn) {
  return als.run({ tenantId: tenantRepoId }, fn)
}

/** 当前请求的租户 repo_id；无上下文返回 null（owner/admin 路径） */
export function getTenantId() {
  return als.getStore()?.tenantId ?? null
}
