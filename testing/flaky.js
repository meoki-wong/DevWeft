/**
 * testing/flaky.js — Flaky 治理（通用引擎）
 * 检测 → 签名区分 → quarantine → 人审清理
 * escalate-only：quarantine 结果不计入门禁，但必须留痕。
 */
import { columnExists } from '../db/dialect-helpers.js'
import { utcNow, uuidv7 } from './ids.js'

export const FLAKE_RETRY_LIMIT = 1
export const FLAKE_SUSPECT_QUARANTINE_THRESHOLD = 3
export const QUARANTINE_AUTO_ORPHAN_DAYS = 30

/** 归一化错误签名：caseKey + detail 前缀 */
export function errorSignature(caseKey, detail, { maxLen = 120 } = {}) {
  const d = String(detail || '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<ts>')
    .replace(/\b[0-9a-f]{6,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
  return `${caseKey || 'unknown'}::${d}`
}

export async function ensureFlakyColumns(db) {
  const cols = (await Promise.all(['flake_suspect_count', 'quarantined_at', 'quarantine_reason', 'quality_score', 'last_error_signature', 'flaky_runs_json'].map(async (c) => (await columnExists(db, 'test_specs', c)) ? c : null))).filter(Boolean)
  const alters = []
  if (!cols.includes('flake_suspect_count')) {
    await db.exec(`ALTER TABLE test_specs ADD COLUMN flake_suspect_count INTEGER NOT NULL DEFAULT 0`)
    alters.push('flake_suspect_count')
  }
  if (!cols.includes('quarantined_at')) {
    await db.exec(`ALTER TABLE test_specs ADD COLUMN quarantined_at TEXT`)
    alters.push('quarantined_at')
  }
  if (!cols.includes('quarantine_reason')) {
    await db.exec(`ALTER TABLE test_specs ADD COLUMN quarantine_reason TEXT`)
    alters.push('quarantine_reason')
  }
  if (!cols.includes('quality_score')) {
    await db.exec(`ALTER TABLE test_specs ADD COLUMN quality_score REAL`)
    alters.push('quality_score')
  }
  if (!cols.includes('last_error_signature')) {
    await db.exec(`ALTER TABLE test_specs ADD COLUMN last_error_signature TEXT`)
    alters.push('last_error_signature')
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS flake_events (
      event_id     TEXT PRIMARY KEY,
      repo_id      TEXT,
      feature_key  TEXT,
      case_key     TEXT,
      signature    TEXT,
      kind         TEXT NOT NULL,
      detail       TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flake_fk ON flake_events(feature_key, created_at);
  `)
  return alters
}

/**
 * guest 侧重试后回写。
 * @param {object} opts
 * @param {boolean} opts.passedAfterRetry 同 attempt 重试后是否通过
 */
export async function recordFlakeRetry(db, { repoId, featureKey, caseKey, signature, passedAfterRetry, detail = null, now = utcNow() }) {
  await ensureFlakyColumns(db)
  await db.prepare(
    `INSERT INTO flake_events(event_id, repo_id, feature_key, case_key, signature, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuidv7(), repoId, featureKey, caseKey, signature, passedAfterRetry ? 'retry_pass' : 'retry_fail', detail, now)

  if (passedAfterRetry) {
    const row = await db
      .prepare('SELECT flake_suspect_count FROM test_specs WHERE feature_key=?')
      .get(featureKey)
    const next = (row?.flake_suspect_count || 0) + 1
    await db.prepare(
      `UPDATE test_specs SET flake_suspect_count=?, last_error_signature=?, updated_at=?
       WHERE feature_key=?`
    ).run(next, signature, now, featureKey)
    if (next >= FLAKE_SUSPECT_QUARANTINE_THRESHOLD) {
      await quarantineSpec(db, { repoId, featureKey, reason: `flake_suspect=${next}`, now })
    }
    return { flakeSuspect: next, quarantined: next >= FLAKE_SUSPECT_QUARANTINE_THRESHOLD }
  }
  return { flakeSuspect: null, quarantined: false }
}

/**
 * 是否应计入门禁：quarantined_at 非空则否。
 * 注意：review_status CHECK 无 quarantine 档，隔离用独立列，避免破坏状态机。
 */
export function countsTowardGate(specRow) {
  if (!specRow) return true
  if (specRow.quarantined_at) return false
  return true
}

export async function quarantineSpec(db, { repoId, featureKey, reason, now = utcNow() }) {
  await ensureFlakyColumns(db)
  await db.prepare(
    `UPDATE test_specs SET quarantined_at=?, quarantine_reason=?, updated_at=?
     WHERE feature_key=?`
  ).run(now, reason, now, featureKey)
  await db.prepare(
    `INSERT INTO flake_events(event_id, repo_id, feature_key, case_key, signature, kind, detail, created_at)
     VALUES (?, ?, ?, ?, ?, 'quarantine_enter', ?, ?)`
  ).run(uuidv7(), repoId, featureKey, featureKey, null, reason, now)
  return { featureKey, quarantined: true }
}

export async function exitQuarantine(db, { featureKey, to = 'active', reason = null, now = utcNow() }) {
  await ensureFlakyColumns(db)
  // to 仅作审计标签；不改 review_status（CHECK 约束无 quarantine）
  await db.prepare(
    `UPDATE test_specs SET quarantined_at=NULL, quarantine_reason=NULL, updated_at=?
     WHERE feature_key=?`
  ).run(now, featureKey)
  await db.prepare(
    `INSERT INTO flake_events(event_id, repo_id, feature_key, case_key, signature, kind, detail, created_at)
     VALUES (?, NULL, ?, ?, ?, 'quarantine_exit', ?, ?)`
  ).run(uuidv7(), featureKey, featureKey, null, JSON.stringify({ to, reason }), now)
  return { featureKey, to }
}

export async function listQuarantined(db, { repoId = null } = {}) {
  await ensureFlakyColumns(db)
  const where = [`quarantined_at IS NOT NULL`]
  const params = []
  if (repoId) {
    where.push('repo_id=?')
    params.push(repoId)
  }
  return await db
    .prepare(
      `SELECT feature_key, flake_suspect_count, quarantined_at, quarantine_reason, last_error_signature, review_status
       FROM test_specs WHERE ${where.join(' AND ')} ORDER BY quarantined_at DESC`
    )
    .all(...params)
}

/** 超期自动解除隔离（记 orphan 标签） */
export async function sweepQuarantine(db, { now = new Date(), maxDays = QUARANTINE_AUTO_ORPHAN_DAYS } = {}) {
  await ensureFlakyColumns(db)
  const cutoff = new Date(now.getTime() - maxDays * 86400000).toISOString()
  const rows = await db
    .prepare(
      `SELECT feature_key, quarantined_at FROM test_specs
       WHERE quarantined_at IS NOT NULL AND quarantined_at < ?`
    )
    .all(cutoff)
  for (const r of rows) {
    await exitQuarantine(db, { featureKey: r.feature_key, to: 'orphan', reason: `quarantine>${maxDays}d` })
  }
  return { orphaned: rows.length, items: rows }
}

/**
 * 质量分：只用于排序/提示，不改判定。
 * score = 100 - flake*10 - quarantine*30 + 有 mutation kill 的加成由调用方传
 */
export function computeQualityScore({ flakeSuspectCount = 0, quarantined = false, mutationKillRate = null } = {}) {
  let s = 100 - Number(flakeSuspectCount || 0) * 10
  if (quarantined) s -= 30
  if (mutationKillRate != null) s = s * 0.7 + Number(mutationKillRate) * 30
  return Math.max(0, Math.min(100, Math.round(s)))
}

export async function updateQualityScore(db, featureKey, score, now = utcNow()) {
  await ensureFlakyColumns(db)
  await db.prepare('UPDATE test_specs SET quality_score=?, updated_at=? WHERE feature_key=?').run(score, now, featureKey)
  return score
}
