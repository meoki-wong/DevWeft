/**
 * testing/quality-metrics.js — 测试质量北极星与过程指标（只读聚合）
 * 数据源：gate_loops / flake_events / spec_f2p_results / escape_events / audit
 */
import { utcNow, uuidv7 } from './ids.js'

export async function ensureQualityTables(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS escape_events (
      escape_id     TEXT PRIMARY KEY,
      repo_id       TEXT,
      task_id       TEXT,
      binding_id    TEXT,
      detected_at   TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT 'manual',
      symptom       TEXT NOT NULL,
      root_cause    TEXT,
      linked_specs  TEXT,
      gap_type      TEXT,
      status        TEXT NOT NULL DEFAULT 'open',
      owner         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_escape_repo ON escape_events(repo_id, status);

    CREATE TABLE IF NOT EXISTS spec_enhancements (
      enhancement_id TEXT PRIMARY KEY,
      repo_id        TEXT,
      feature_key    TEXT,
      gap_type       TEXT,
      reason         TEXT,
      from_escape_id TEXT,
      status         TEXT NOT NULL DEFAULT 'open',
      owner          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
  `)
}

export async function registerEscape(db, {
  repoId = null,
  taskId = null,
  bindingId = null,
  source = 'manual',
  symptom,
  rootCause = null,
  linkedSpecs = [],
  gapType = null,
  owner = null,
  now = utcNow(),
}) {
  await ensureQualityTables(db)
  const id = uuidv7()
  await db.prepare(
    `INSERT INTO escape_events(
       escape_id, repo_id, task_id, binding_id, detected_at, source, symptom, root_cause,
       linked_specs, gap_type, status, owner, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    id, repoId, taskId, bindingId, now, source, symptom, rootCause,
    JSON.stringify(linkedSpecs || []), gapType, owner, now, now
  )
  // 正反馈：生成增强需求单
  const enhId = uuidv7()
  await db.prepare(
    `INSERT INTO spec_enhancements(
       enhancement_id, repo_id, feature_key, gap_type, reason, from_escape_id, status, owner, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
  ).run(
    enhId, repoId, (linkedSpecs && linkedSpecs[0]) || null, gapType || 'missing_spec',
    symptom, id, owner, now, now
  )
  return { escapeId: id, enhancementId: enhId }
}

export async function listEscapes(db, { repoId = null, status = null, limit = 100 } = {}) {
  await ensureQualityTables(db)
  const where = []
  const params = []
  if (repoId) { where.push('repo_id=?'); params.push(repoId) }
  if (status) { where.push('status=?'); params.push(status) }
  const sql = `SELECT * FROM escape_events${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`
  return await db.prepare(sql).all(...params, limit)
}

/**
 * 变异四态统计（2026-09-26 修复死指标）：
 * detail 是文本（leases.js 判卷时写入），不是 JSON——按文本模式归类四态。
 * killed        → 'mutation killed ...'
 * survived      → 'mutation survived @...'（非 cap-exempt）
 * not_covered   → 'mutation not-covered ...' / 'mutation survived-cap-exempt ...'（豁免）
 * invalid       → 其余（inconclusive：构建/环境失败，'mutation run ... without spec verdict'）
 */
function classifyMutationDetail(detail) {
  const d = String(detail || '')
  if (/^mutation killed/.test(d)) return 'killed'
  if (/^mutation survived-cap-exempt/.test(d)) return 'not_covered'
  if (/^mutation not-covered/.test(d)) return 'not_covered'
  if (/^mutation survived/.test(d)) return 'survived'
  return 'invalid'
}

export async function mutationFourStateStats(db, { repoId = null, since = null } = {}) {
  try {
    const where = []
    const params = []
    if (repoId) { where.push('r.repo_id=?'); params.push(repoId) }
    if (since) { where.push('r.created_at>=?'); params.push(since) }
    const sql = `
      SELECT r.detail FROM spec_f2p_results r
      JOIN test_specs s ON s.repo_id = r.repo_id AND s.feature_key = r.feature_key AND s.version = r.version
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    `
    const rows = await db.prepare(sql).all(...params)
    const stats = { killed: 0, survived: 0, invalid: 0, not_covered: 0, unknown: 0 }
    for (const row of rows) {
      const st = classifyMutationDetail(row?.detail)
      if (st in stats) stats[st]++
      else stats.unknown++
    }
    const legal = stats.killed + stats.survived
    const score = legal > 0 ? Math.round((stats.killed / legal) * 100) : null
    return { ...stats, mutationScore: score, legalMutants: legal }
  } catch {
    return { killed: 0, survived: 0, invalid: 0, not_covered: 0, unknown: 0, mutationScore: null, legalMutants: 0 }
  }
}

export async function iterationStats(db, { repoId = null, repoSlug = null, days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const rows = await db
      .prepare(
        `SELECT iteration, last_terminal FROM gate_loops WHERE updated_at >= ?`
      )
      .all(since)
    const iters = rows.map((r) => Number(r.iteration || 0)).filter((n) => n >= 0).sort((a, b) => a - b)
    if (!iters.length) return { count: 0, median: null, p90: null, mean: null }
    const mid = Math.floor(iters.length / 2)
    const median = iters.length % 2 ? iters[mid] : Math.round((iters[mid - 1] + iters[mid]) / 2)
    const p90 = iters[Math.min(iters.length - 1, Math.floor(iters.length * 0.9))]
    const mean = Math.round((iters.reduce((a, b) => a + b, 0) / iters.length) * 10) / 10
    return { count: iters.length, median, p90, mean }
  } catch {
    return { count: 0, median: null, p90: null, mean: null }
  }
}

export async function flakeStats(db, { repoId = null, days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const where = ['created_at>=?']
    const params = [since]
    if (repoId) { where.push('repo_id=?'); params.push(repoId) }
    const rows = await db
      .prepare(`SELECT kind FROM flake_events WHERE ${where.join(' AND ')}`)
      .all(...params)
    const byKind = {}
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] || 0) + 1
    const quarantined = (await db
      .prepare(`SELECT COUNT(*) AS c FROM test_specs WHERE review_status='quarantine'`)
      .get()).c
    return { byKind, quarantined, total: rows.length }
  } catch {
    return { byKind: {}, quarantined: 0, total: 0 }
  }
}

export async function deniedStats(db, { repoSlug = null, days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString()
    const where = ["created_at >= ?", "event_type IN ('resubmit_denied','advance_denied')"]
    const params = [since]
    if (repoSlug) { where.push('repo=?'); params.push(repoSlug) }
    const rows = await db
      .prepare(`SELECT event_type, COUNT(*) AS c FROM audit_events WHERE ${where.join(' AND ')} GROUP BY event_type`)
      .all(...params)
    const out = { resubmit_denied: 0, advance_denied: 0 }
    for (const r of rows) out[r.event_type] = r.c
    return out
  } catch {
    return { resubmit_denied: 0, advance_denied: 0 }
  }
}

/**
 * 汇总质量页数据（按 repo 可选）
 */
export async function qualityDashboard(db, { repoSlug = null, repoId = null, days = 30 } = {}) {
  await ensureQualityTables(db)
  return {
    generatedAt: utcNow(),
    repoSlug,
    mutation: await mutationFourStateStats(db, { repoId, since: new Date(Date.now() - days * 86400000).toISOString() }),
    iterations: await iterationStats(db, { repoSlug, days }),
    flake: await flakeStats(db, { repoId, days }),
    denied: await deniedStats(db, { repoSlug, days }),
    escapes: await listEscapes(db, { repoId, limit: 20 }),
    enhancements: await (async () => {
      try {
        return await db
          .prepare('SELECT * FROM spec_enhancements ORDER BY created_at DESC LIMIT 20')
          .all()
      } catch { return [] }
    })(),
  }
}
