/**
 * testing/contract-engine.js — 契约层引擎（通用，租户只提供 fixture 数据）
 *
 * 职责：
 *  - 校验 fixture 是否符合 contracts/contract-fixture.schema.json（轻量手写校验，零依赖）
 *  - 将 fixture 转为 guest 可执行的 route 计划（match + mock + expect）
 *  - 校验 E2E 考卷是否达到「断言三件套」最低标准（网络/数据/边界 至少两类）
 *  - 平台策略：repo_test_policies.enforce_spec_contract 控制告警 vs 硬拒
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = join(__dirname, '..', 'contracts', 'contract-fixture.schema.json')

let cachedSchema = null
export function loadContractFixtureSchema() {
  if (cachedSchema) return cachedSchema
  try {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))
  } catch {
    cachedSchema = null
  }
  return cachedSchema
}

/** 轻量 fixture 校验（不引 ajv；覆盖 schema 中的硬约束） */
export function validateContractFixture(fixture) {
  const errors = []
  const warnings = []
  if (!fixture || typeof fixture !== 'object') {
    return { ok: false, errors: ['fixture 必须是对象'], warnings }
  }
  if (!fixture.featureKey || typeof fixture.featureKey !== 'string') {
    errors.push('featureKey 必填（string）')
  }
  if (typeof fixture.side !== 'string' || !fixture.side.trim()) {
    errors.push('side must be a non-empty lane name')
  }
  if (!Array.isArray(fixture.routes) || !fixture.routes.length) {
    errors.push('routes 至少 1 条')
  } else {
    const ids = new Set()
    for (const [i, r] of fixture.routes.entries()) {
      if (!r?.id) errors.push(`routes[${i}].id 必填`)
      else if (ids.has(r.id)) errors.push(`routes[${i}].id 重复：${r.id}`)
      else ids.add(r.id)
      if (!r?.match || typeof r.match !== 'object') {
        errors.push(`routes[${i}].match 必填`)
        continue
      }
      const m = r.match
      if (!m.method) errors.push(`routes[${i}].match.method 必填`)
      if (!m.pathEquals && !m.pathIncludes && !m.pathRegex) {
        errors.push(`routes[${i}].match 需要 pathEquals|pathIncludes|pathRegex 之一`)
      }
      if (m.pathRegex) {
        try { new RegExp(m.pathRegex) } catch { errors.push(`routes[${i}].match.pathRegex 非法`) }
      }
      if (!r.mock && !r.response) {
        warnings.push(`routes[${i}] 未声明 mock/response，将只做匹配不改写响应`)
      }
      if (r.mock?.status != null && (r.mock.status < 100 || r.mock.status > 599)) {
        errors.push(`routes[${i}].mock.status 非法`)
      }
    }
  }
  const scenarios = Array.isArray(fixture.scenarios) ? fixture.scenarios : []
  for (const need of ['empty', 'boundary', 'no-permission']) {
    if (!scenarios.includes(need)) {
      warnings.push(`建议包含场景 ${need}（空态/边界/权限）`)
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/** 断言三件套：A 网络 B 数据 C 边界 —— 至少两类 */
export function scoreAssertionTriad(content) {
  const text = String(content || '')
  const network =
    /page\.route\s*\(/.test(text) ||
    /waitForResponse\s*\(/.test(text) ||
    /awp\.contract\./.test(text) ||
    /expectRequest\s*\(/.test(text)
  const data =
    /expect\s*\(\s*[^)]+\)\s*\.\s*toHaveText/.test(text) ||
    /expect\s*\(\s*[^)]+\)\s*\.\s*toHaveValue/.test(text) ||
    /expect\s*\(\s*[^)]+\)\s*\.\s*toContainText/.test(text) ||
    /fixture\.|sample\.|payload\./.test(text) ||
    /getByTestId\s*\([^)]+\)\s*\.\s*toHaveText/.test(text) ||
    /\bassert(?:\.(?:ok|equal|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|match|doesNotMatch|throws|rejects))?\s*\(/.test(text)
  const boundary =
    /empty|空态|no-permission|无权限|boundary|边界|maxLength|toBeEmpty|Empty/i.test(text) ||
    /mockStatus|status\s*[:=]\s*(401|403|500)/.test(text)
  const kinds = [network && 'network', data && 'data', boundary && 'boundary'].filter(Boolean)
  return {
    network,
    data,
    boundary,
    kinds,
    score: kinds.length,
    ok: kinds.length >= 2,
  }
}

/**
 * E2E 契约硬校验（提交期）。
 * @param {object} opts
 * @param {string} opts.content spec 源码
 * @param {object|null} opts.fixture 已解析 fixture
 * @param {boolean} opts.enforce 是否硬拒（false=仅 warning）
 */
export function validateE2eAgainstContract({ content, fixture = null, enforce = true }) {
  const errors = []
  const warnings = []
  const triad = scoreAssertionTriad(content)

  if (!triad.network && !triad.data) {
    const msg =
      '断言深度不足：E2E 必须包含网络断言（page.route/waitForResponse/awp.contract）与数据断言（toHaveText 等）中的至少两类（当前：' +
      (triad.kinds.join(',') || '无') +
      '）'
    if (enforce) errors.push(msg)
    else warnings.push(msg)
  } else if (!triad.ok) {
    warnings.push(`断言三件套仅覆盖 ${triad.kinds.join('+')}，建议补齐空态/边界/权限`)
  }

  if (fixture) {
    const fv = validateContractFixture(fixture)
    errors.push(...fv.errors)
    warnings.push(...fv.warnings)
    if (fixture.featureKey && !String(content).includes(String(fixture.featureKey))) {
      warnings.push(`spec 未引用 featureKey=${fixture.featureKey}（建议在注释或 contract helper 中引用）`)
    }
  } else if (enforce && triad.network) {
    warnings.push('声明了网络断言但未关联 contract fixture（fixtureRef），建议补齐数据源')
  }

  // 禁止裸 waitForSelector 作为唯一断言
  if (/waitForSelector\s*\(/.test(content) && !triad.data && !/expect\s*\(/.test(content) && !/toBeVisible|toHaveText|waitForResponse/.test(content)) {
    const msg = '禁止仅 waitForSelector 作为断言；请改用 web-first assertions（toBeVisible/toHaveText 等）'
    if (enforce) errors.push(msg)
    else warnings.push(msg)
  }

  return { ok: errors.length === 0, errors, warnings, triad }
}

/** fixture → guest route 计划（注入 runDir/input/contracts.json） */
export function buildGuestContractPlan(fixture) {
  if (!fixture) return null
  const routes = (fixture.routes || []).map((r) => ({
    id: r.id,
    match: r.match,
    mock: r.mock || null,
    response: r.response || null,
    expectUi: r.expectUi || null,
  }))
  return {
    version: fixture.version || 1,
    featureKey: fixture.featureKey,
    side: fixture.side,
    scenarios: fixture.scenarios || [],
    routes,
    ui: fixture.ui || null,
  }
}

/**
 * 按 repo 读取契约开关。
 * enforce_spec_contract: true/false；缺省 false（告警）→ 观察后开 true
 */
export async function isContractEnforced(db, repoSlug) {
  try {
    const row = await db.prepare(
      `SELECT p.enforce_spec_contract FROM repo_test_policies p
       JOIN repositories r ON r.repo_id=p.repo_id WHERE r.slug=?`
    ).get(repoSlug)
    return Boolean(row?.enforce_spec_contract)
  } catch {
    return false
  }
}

/** 从 suites/<slug>/repo/fixtures/contracts/<featureKey>.json 读取 */
export function loadTenantContractFixture(repoSlug, featureKey, { suitesRoot = null } = {}) {
  const root = suitesRoot || join(__dirname, '..', 'suites')
  const p = join(root, repoSlug, 'repo', 'fixtures', 'contracts', `${String(featureKey).replace(/[^\w.-]/g, '')}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
  } catch {
    return { __invalid: true, path: p }
  }
}
