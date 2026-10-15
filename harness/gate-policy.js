/**
 * harness/gate-policy.js — 动态门禁策略引擎（通用规则 + 租户风险表）
 * escalate-only：动态强度 ≥ repoMode；放宽只能走显式 waiver。
 */
import { createHash } from 'node:crypto'
import { uuidv7, utcNow } from '../testing/ids.js'
import { getRepoGateMode, requiredUnitsForTask, lookupTaskType, inferSidesFromChangedFiles } from './testing-gate.js'
import { columnExists } from '../db/dialect-helpers.js'
import { evalPolicies } from './opa-policy.js'

export const DEFAULT_LARGE_DIFF_THRESHOLD = 15
export const DEFAULT_FAIL_STREAK = 2

/**
 * platform_settings 双列兼容：
 *  - value     ：看板/注入/并发等简单字符串（历史列）
 *  - value_json：动态门禁等结构化设置（v26）
 * 两列都允许为空，读时互相回退，避免「只有 value_json 的库」导致 SELECT value 整表失败。
 */
export async function ensurePlatformSettingsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      value_json  TEXT,
      updated_at  TEXT NOT NULL
    );
  `)
  // 方言感知列探测(§2.8):postgres 走 information_schema.columns
  const cols = (await Promise.all(['key', 'value', 'value_json'].map(async (c) => (await columnExists(db, 'platform_settings', c)) ? c : null))).filter(Boolean)
  if (!cols.includes('value')) {
    await db.exec(`ALTER TABLE platform_settings ADD COLUMN value TEXT`)
  }
  if (!cols.includes('value_json')) {
    await db.exec(`ALTER TABLE platform_settings ADD COLUMN value_json TEXT`)
  }
  // 兼容旧行：仅有 value 时补 value_json，仅有 value_json 时补 value（简单标量）
  try {
    const orphans = await db
      .prepare(`SELECT key, value, value_json FROM platform_settings WHERE value IS NULL OR value_json IS NULL`)
      .all()
    for (const r of orphans) {
      if (r.value == null && r.value_json != null) {
        let simple = null
        try {
          const parsed = JSON.parse(r.value_json)
          simple = typeof parsed === 'object' && parsed !== null ? r.value_json : String(parsed)
        } catch {
          simple = r.value_json
        }
        await db.prepare(`UPDATE platform_settings SET value=? WHERE key=?`).run(simple, r.key)
      } else if (r.value_json == null && r.value != null) {
        let json
        try {
          json = JSON.stringify(JSON.parse(r.value))
        } catch {
          json = JSON.stringify(r.value)
        }
        await db.prepare(`UPDATE platform_settings SET value_json=? WHERE key=?`).run(json, r.key)
      }
    }
  } catch { /* ignore */ }
}

export async function getPlatformSetting(db, key, fallback = null) {
  try {
    await ensurePlatformSettingsTable(db)
    const row = await db.prepare('SELECT value_json, value FROM platform_settings WHERE key=?').get(key)
    if (!row) return fallback
    if (row.value_json != null && row.value_json !== '') {
      try {
        return JSON.parse(row.value_json)
      } catch { /* fallthrough */ }
    }
    if (row.value != null && row.value !== '') {
      try {
        return JSON.parse(row.value)
      } catch {
        return row.value
      }
    }
    return fallback
  } catch {
    return fallback
  }
}

export async function setPlatformSetting(db, key, value, now = utcNow()) {
  await ensurePlatformSettingsTable(db)
  const json = JSON.stringify(value ?? null)
  const simple =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : json
  await db.prepare(
    `INSERT INTO platform_settings(key, value, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value=excluded.value,
       value_json=excluded.value_json,
       updated_at=excluded.updated_at`
  ).run(key, simple, json, now)
  return { key, value }
}

export async function isDynamicGateEnabled(db) {
  return Boolean((await getPlatformSetting(db, 'dynamic_gate', { enabled: false }))?.enabled)
}

export async function ensureGateRiskRulesTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS gate_risk_rules (
      rule_id     TEXT PRIMARY KEY,
      repo_id     TEXT,
      pattern     TEXT NOT NULL,
      effect      TEXT NOT NULL DEFAULT 'enforce',
      note        TEXT,
      enabled     INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_grr_repo ON gate_risk_rules(repo_id, enabled);
  `)
}

export async function listGateRiskRules(db, { repoId = null, enabledOnly = true } = {}) {
  await ensureGateRiskRulesTable(db)
  const where = []
  const params = []
  if (repoId) {
    where.push('(repo_id = ? OR repo_id IS NULL)')
    params.push(repoId)
  }
  if (enabledOnly) where.push('enabled = 1')
  const sql = `SELECT * FROM gate_risk_rules${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
  return await db.prepare(sql).all(...params)
}

export async function upsertGateRiskRule(db, { ruleId = null, repoId = null, pattern, effect = 'enforce', note = null, enabled = true, now = utcNow() }) {
  await ensureGateRiskRulesTable(db)
  const id = ruleId || uuidv7()
  const exists = await db.prepare('SELECT rule_id FROM gate_risk_rules WHERE rule_id=?').get(id)
  if (exists) {
    await db.prepare(
      'UPDATE gate_risk_rules SET pattern=?, effect=?, note=?, enabled=?, repo_id=? WHERE rule_id=?'
    ).run(pattern, effect, note, enabled ? 1 : 0, repoId, id)
  } else {
    await db.prepare(
      `INSERT INTO gate_risk_rules(rule_id, repo_id, pattern, effect, note, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, repoId, pattern, effect, note, enabled ? 1 : 0, now)
  }
  return { ruleId: id }
}

/** 简单 glob：* 单段，** 任意 */
export function matchRiskPath(filePath, pattern) {
  const p = String(filePath || '').split('\\').join('/')
  const pat = String(pattern || '').split('\\').join('/')
  if (pat.includes('**')) {
    const parts = pat.split('**')
    const head = parts[0]
    const tail = parts[parts.length - 1]
    if (head && !p.includes(head.replace(/\*$/, ''))) return false
    if (tail && !p.endsWith(tail.replace(/^\*/, '')) && !p.includes(tail.replace(/^\*\/?/, ''))) {
      // 宽松：尾段作为 includes
      if (!p.includes(tail.replace(/^\//, '').replace(/\*/g, ''))) return false
    }
    return true
  }
  // 单 * 通配
  const rx = new RegExp(
    '^' +
      pat
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*') +
      '$'
  )
  return rx.test(p)
}

function notePolicyError(bucket, key, e) {
  const detail = String(e?.message || e)
  if (/no such table/i.test(detail)) return
  bucket.push({ key, code: 'POLICY_EVAL_FAILED', detail })
}

function hashPolicy(repoMode, effectiveMode, factors) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        repoMode,
        effectiveMode,
        factors: factors.map((f) => f.key + ':' + f.effect).sort(),
      })
    )
    .digest('hex')
    .slice(0, 16)
}

async function persistDecision(db, { repoSlug, taskId, policy, bindingId = null }) {
  if (globalThis.__AWP_POLICY_PREVIEW__) return
  try {
    const repo = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
    await db.prepare(
      `INSERT INTO gate_policy_decisions(
         decision_id, repo_id, task_id, binding_id, repo_mode, decision, factors_json, policy_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv7(),
      repo?.repo_id || null,
      taskId,
      bindingId,
      policy.repoMode,
      policy.decision,
      JSON.stringify(policy.factors || []),
      policy.policyHash,
      utcNow()
    )
  } catch {
    /* ignore */
  }
}

/**
 * resolveGatePolicy — 统一门禁策略入口
 * @returns {{repoMode, decision, effectiveMode, factors, requiredUnits, acRequired, policyHash, enabled}}
 */
export async function resolveGatePolicy(db, {
  repoSlug,
  taskId = null,
  size = null,
  changedFiles = null,
  author = null,
  baseMode = null,
  requiredUnits = null,
}) {
  const repoMode = baseMode || await getRepoGateMode(db, repoSlug)
  const enabled = await isDynamicGateEnabled(db)
  const factors = []
  const policyErrors = []
  let effectiveMode = repoMode
  let acRequired = false
  const taskType = taskId ? await lookupTaskType(db, repoSlug, taskId) : null
  const inferredSides = Array.isArray(changedFiles) && changedFiles.length
    ? inferSidesFromChangedFiles(changedFiles)
    : changedFiles
      ? null
      : undefined
  const baseUnits = requiredUnits ?? (size ? requiredUnitsForTask({ size, type: taskType, sides: inferredSides }) : null)

  if (repoMode === 'disabled') {
    const policy = {
      repoMode,
      decision: 'disabled',
      effectiveMode: 'disabled',
      factors: [],
      requiredUnits: [],
      acRequired: false,
      policyHash: hashPolicy(repoMode, 'disabled', []),
      enabled,
    }
    await persistDecision(db, { repoSlug, taskId, policy })
    return policy
  }

  if (!enabled) {
    const decision = repoMode === 'observe' || repoMode === 'legacy' ? 'observe' : 'enforce'
    const policy = {
      repoMode,
      decision,
      effectiveMode: repoMode,
      factors: [],
      requiredUnits: baseUnits,
      acRequired: false,
      policyHash: hashPolicy(repoMode, repoMode, []),
      enabled: false,
    }
    return policy
  }

  // risk-path
  try {
    const repo = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
    const rules = await listGateRiskRules(db, { repoId: repo?.repo_id || null })
    const files = Array.isArray(changedFiles) ? changedFiles : []
    for (const f of files) {
      for (const rule of rules) {
        if (matchRiskPath(f, rule.pattern)) {
          factors.push({ key: 'risk-path', detail: f + ' ~ ' + rule.pattern, effect: rule.effect || 'enforce' })
        }
      }
    }
  } catch (e) {
    notePolicyError(policyErrors, 'risk-path', e)
  }
  const largeThreshold =
    Number(await getPlatformSetting(db, 'large_diff_threshold', DEFAULT_LARGE_DIFF_THRESHOLD)) ||
    DEFAULT_LARGE_DIFF_THRESHOLD
  if (Array.isArray(changedFiles) && changedFiles.length > largeThreshold) {
    factors.push({ key: 'large-diff', detail: 'changedFiles=' + changedFiles.length, effect: 'enforce' })
  }

  // task-fail-streak
  try {
    const loop = await db
      .prepare('SELECT iteration, last_terminal FROM gate_loops WHERE repo=? AND task_id=?')
      .get(repoSlug, taskId)
    if (
      loop &&
      (loop.last_terminal === 'failed' || loop.last_terminal === 'error') &&
      Number(loop.iteration) >= DEFAULT_FAIL_STREAK
    ) {
      factors.push({ key: 'task-fail-streak', detail: 'iteration=' + loop.iteration, effect: 'enforce' })
    }
  } catch (e) {
    notePolicyError(policyErrors, 'task-fail-streak', e)
  }
  const newAuthorOn = Boolean((await getPlatformSetting(db, 'dynamic_gate_new_author', { enabled: false }))?.enabled)
  if (newAuthorOn && author) {
    try {
      const n = (await db
        .prepare(
          `SELECT COUNT(*) AS c FROM test_submissions s
           JOIN principals p ON p.principal_id = s.principal_id
           WHERE p.subject = ?`
        )
        .get(author)).c
      if (!n) {
        factors.push({ key: 'new-author', detail: 'author=' + author, effect: 'observe' })
        acRequired = true
      }
    } catch (e) {
      notePolicyError(policyErrors, 'new-author', e)
    }
  }

  // contract-ac
  if (
    Array.isArray(changedFiles) &&
    changedFiles.some((f) => /contract|openapi|swagger/i.test(String(f)))
  ) {
    factors.push({ key: 'contract-ac', detail: '契约相关文件变更', effect: 'enforce' })
  }

  // §10:升级决策迁 OPA(default 层提出 effectiveMode;只升不降由 mandatory 层 Rego 强制)。
  // 求值抛错/超时 → POLICY_EVAL_FAILED(policyErrors 透出,不得放行)
  try {
    const opa = await evalPolicies({
      tenant: repoSlug,
      feature: 'gate.policy',
      phase: null,
      target: null,
      size,
      changedFiles: Array.isArray(changedFiles) ? changedFiles : [],
      author,
      factors,
      facts: { repoMode, candidateMode: null, dynamicGate: true },
    })
    if (opa.blocked.length) {
      for (const b of opa.blocked) notePolicyError(policyErrors, b.code || 'POLICY_BLOCKED', b.message || '')
    }
    effectiveMode = opa.effectiveMode || repoMode
  } catch (e) {
    notePolicyError(policyErrors, 'opa-eval', e.message || String(e))
  }
  const hasEnforceFactor = factors.some((f) => f.effect === 'enforce')
  let decision
  if (effectiveMode === 'observe' || effectiveMode === 'legacy') {
    decision = 'observe'
  } else if (hasEnforceFactor || effectiveMode.startsWith('enforce')) {
    decision = 'enforce'
  } else {
    decision = 'observe'
  }

  const policy = {
    repoMode,
    decision,
    effectiveMode,
    factors,
    requiredUnits: baseUnits,
    acRequired,
    policyErrors,
    error: policyErrors.length ? 'POLICY_EVAL_FAILED' : null,
    policyHash: hashPolicy(repoMode, effectiveMode, factors),
    enabled: true,
  }
  await persistDecision(db, { repoSlug, taskId, policy })
  return policy
}

/** dry-run：不落库 */
export async function previewGatePolicy(db, args) {
  const prev = globalThis.__AWP_POLICY_PREVIEW__
  globalThis.__AWP_POLICY_PREVIEW__ = true
  try {
    return await resolveGatePolicy(db, args)
  } finally {
    globalThis.__AWP_POLICY_PREVIEW__ = prev
  }
}
