/**
 * opa-policy.js — 方案 §10：进程内 OPA WASM 求值器。
 *
 * - 加载 policies/mandatory/bundle 与 policies/tenants/<slug>/bundle（有则用）
 *   或 policies/default/bundle（§16.1：有 slug 包用 slug 包，否则 default）。
 * - mandatory 与所选包都要通过；合并两层的 blocked。
 * - 求值抛错或超时（POLICY_EVAL_TIMEOUT_MS，默认 2000）→ 抛 POLICY_EVAL_FAILED，不得放行。
 * - 策略不做数据库连接：input 由调用方组装（证据读取留在 JS）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const policiesRoot = path.join(here, '..', 'policies')

const TIMEOUT_MS = Number(process.env.AWP_POLICY_EVAL_TIMEOUT_MS || 2000)
let cached = null // { mandatory, default, tenants: Map(slug → bundle) }

async function loadBundle(bundleDir) {
  const { loadPolicy } = await import('@open-policy-agent/opa-wasm')
  const wasm = readFileSync(path.join(bundleDir, 'policy.wasm'))
  const data = JSON.parse(readFileSync(path.join(bundleDir, 'data.json'), 'utf8'))
  const policy = await loadPolicy(wasm)
  policy.setData(data)
  return policy
}

function scanTenants() {
  const tenantsDir = path.join(policiesRoot, 'tenants')
  const map = new Map()
  if (existsSync(tenantsDir)) {
    for (const slug of readdirSync(tenantsDir)) {
      const bundle = path.join(tenantsDir, slug, 'bundle', 'policy.wasm')
      if (existsSync(bundle)) map.set(slug, path.join(tenantsDir, slug, 'bundle'))
    }
  }
  return map
}

async function ensureLoaded() {
  if (cached) return cached
  cached = { mandatory: null, default: null, tenants: new Map() }
  const mandatoryDir = path.join(policiesRoot, 'mandatory', 'bundle', 'policy.wasm')
  const defaultDir = path.join(policiesRoot, 'default', 'bundle', 'policy.wasm')
  if (existsSync(mandatoryDir)) cached.mandatory = await loadBundle(path.join(policiesRoot, 'mandatory', 'bundle'))
  if (existsSync(defaultDir)) cached.default = await loadBundle(path.join(policiesRoot, 'default', 'bundle'))
  cached.tenants = scanTenants()
  return cached
}

function evalWithTimeout(policy, input) {
  const p = policy.evaluate(input)
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('POLICY_EVAL_TIMEOUT')), TIMEOUT_MS)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 组合求值：mandatory + (tenant | default)。
 * @returns {Promise<{ok: boolean, blocked: Array<{code,message}>, effectiveMode: string|null, sources: string[]}>}
 */
export async function evalPolicies({ tenant, feature, phase, target, size, changedFiles, author, facts, factors = [] }) {
  const input = { tenant, feature, phase, target, size, changedFiles, author, facts, factors }
  const loaded = await ensureLoaded()
  const sources = []
  let mandatoryBlocked = []
  let tierBlocked = []
  let effectiveMode = facts?.repoMode || null

  // 顺序:tier(默认/租户)先提出 effectiveMode → mandatory 以 candidateMode 复核
  //(MODE_DOWNGRADE 只升不降规则在 Rego,§16.1)
  const tenantBundle = tenant ? loaded.tenants.get(String(tenant).toLowerCase()) : null
  if (tenantBundle) {
    sources.push(`tenant:${tenant}`)
    const r = await evalWithTimeout(await loadBundle(tenantBundle), input)
    const d = r?.[0]?.result || {}
    tierBlocked = d.blocked || []
    if (d.effectiveMode) effectiveMode = d.effectiveMode
  } else if (loaded.default) {
    sources.push('default')
    const r = await evalWithTimeout(loaded.default, input)
    const d = r?.[0]?.result || {}
    tierBlocked = d.blocked || []
    if (d.effectiveMode) effectiveMode = d.effectiveMode
  } else {
    throw Object.assign(new Error('default policy bundle missing'), { code: 'POLICY_EVAL_FAILED' })
  }

  if (loaded.mandatory) {
    sources.push('mandatory')
    const mandInput = { ...input, facts: { ...facts, candidateMode: effectiveMode } }
    const r = await evalWithTimeout(loaded.mandatory, mandInput)
    const d = r?.[0]?.result || {}
    mandatoryBlocked = d.blocked || []
  } else {
    // 未编译 bundle：fail-closed（§16.1 不得放行）
    throw Object.assign(new Error('mandatory policy bundle missing'), { code: 'POLICY_EVAL_FAILED' })
  }

  const blocked = [...mandatoryBlocked, ...tierBlocked]
  return { ok: blocked.length === 0, blocked, effectiveMode, sources }
}

/** 测试/构建探针：bundle 是否就绪 */
export function bundlesReady() {
  return existsSync(path.join(policiesRoot, 'mandatory', 'bundle', 'policy.wasm'))
    && existsSync(path.join(policiesRoot, 'default', 'bundle', 'policy.wasm'))
}

export function resetPolicyCache() {
  cached = null
}
