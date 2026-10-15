/**
 * rule-artifacts.js — 规则资产化（v30）
 *
 * 闭环：experience reviewed → rule_artifacts(draft) → activate → drift_stats 前后窗口效果
 */
import { columnExists } from '../db/dialect-helpers.js'
import { uuidv7, utcNow } from '../testing/ids.js'

export async function ensureRuleArtifactsTable(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS rule_artifacts (
      rule_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      detection_command TEXT,
      source_experience_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('draft','active','deprecated','revoked')),
      owner TEXT,
      applies_to_json TEXT,
      activated_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ra_repo ON rule_artifacts(repo, status);
    CREATE INDEX IF NOT EXISTS idx_ra_exp ON rule_artifacts(source_experience_id);
  `)
}

export async function createRuleArtifactFromExperience(db, {
  repo,
  experienceId,
  title,
  condition = {},
  detectionCommand = null,
  owner = null,
  appliesTo = null,
  now = utcNow(),
}) {
  await ensureRuleArtifactsTable(db)
  const ruleId = `rule-${uuidv7().slice(0, 8)}`
  await db.prepare(
    `INSERT INTO rule_artifacts(
       rule_id, repo, title, condition_json, detection_command, source_experience_id,
       version, status, owner, applies_to_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?)`
  ).run(
    ruleId, repo, title || `Rule from ${experienceId}`,
    JSON.stringify(condition || {}), detectionCommand, experienceId,
    owner, appliesTo ? JSON.stringify(appliesTo) : null, now, now
  )
  return { ruleId, status: 'draft' }
}

export async function activateRuleArtifact(db, { ruleId, owner = null, now = utcNow() }) {
  await ensureRuleArtifactsTable(db)
  const info = await db
    .prepare(
      `UPDATE rule_artifacts SET status='active', activated_at=?, owner=COALESCE(?, owner), updated_at=?
       WHERE rule_id=? AND status IN ('draft','deprecated')`
    )
    .run(now, owner, now, ruleId)
  if (info.changes !== 1) {
    const row = await db.prepare('SELECT status FROM rule_artifacts WHERE rule_id=?').get(ruleId)
    if (!row) return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: `INVALID_STATUS:${row.status}` }
  }
  return { ok: true, ruleId, status: 'active' }
}

export async function revokeRuleArtifact(db, { ruleId, owner = null, now = utcNow() }) {
  await ensureRuleArtifactsTable(db)
  await db.prepare(
    `UPDATE rule_artifacts SET status='revoked', revoked_at=?, owner=COALESCE(?, owner), updated_at=?
     WHERE rule_id=?`
  ).run(now, owner, now, ruleId)
  return { ok: true, ruleId, status: 'revoked' }
}

/**
 * 规则效果：激活前 N 周 vs 后 N 周，按 module 统计 ai-drift 数。
 * 对协作层（repo/module）与 v8（repo_id）结构都尽量兼容。
 */
export async function measureRuleEffect(db, { repo, ruleId, weeks = 2, now = utcNow() }) {
  await ensureRuleArtifactsTable(db)
  const rule = await db.prepare('SELECT * FROM rule_artifacts WHERE rule_id=?').get(ruleId)
  if (!rule) return { ok: false, error: 'NOT_FOUND' }
  const activatedAt = rule.activated_at || rule.created_at
  const beforeStart = new Date(new Date(activatedAt).getTime() - weeks * 7 * 24 * 3600 * 1000).toISOString()
  const afterEnd = now

  const expCols = new Set(
    // 方言感知列探测(§2.8)
    (await Promise.all(['repo', 'repo_id'].map(async (c) => (await columnExists(db, 'experiences', c)) ? c : null))).filter(Boolean)
  )
  const repoCol = expCols.has('repo') ? 'repo' : expCols.has('repo_id') ? 'repo_id' : null
  if (!repoCol) {
    return {
      ok: true,
      ruleId,
      status: rule.status,
      activatedAt,
      weeks,
      before: [],
      after: [],
      improved: [],
      notImproved: [],
      unlinkedHighFreq: [],
      note: 'experiences schema unrecognized',
    }
  }
  const modCol = expCols.has('module') ? 'module' : 'NULL AS module'
  const tagCol = expCols.has('tags') ? 'tags' : expCols.has('tags_json') ? 'tags_json' : null
  const ruleCol = expCols.has('rule_ref') ? 'rule_ref' : null

  const countDrift = async (from, to) => {
    if (!tagCol) return []
    const statusFilter = expCols.has('status') ? `AND status != 'obsolete'` : ''
    return await db
      .prepare(
        `SELECT ${modCol}, COUNT(*) AS c FROM experiences
         WHERE ${repoCol}=? AND ${tagCol} LIKE '%ai-drift%' ${statusFilter}
           AND created_at >= ? AND created_at < ?
         GROUP BY ${modCol === 'NULL AS module' ? '1' : 'module'} ORDER BY c DESC`
      )
      .all(repo, from, to)
  }

  const before = await countDrift(beforeStart, activatedAt)
  const after = await countDrift(activatedAt, afterEnd)
  const beforeMap = Object.fromEntries(before.map((r) => [r.module || '', r.c]))
  const afterMap = Object.fromEntries(after.map((r) => [r.module || '', r.c]))
  const modules = new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])
  const improved = []
  const notImproved = []
  for (const m of modules) {
    const b = beforeMap[m] || 0
    const a = afterMap[m] || 0
    if (a < b) improved.push({ module: m, before: b, after: a })
    else if (a >= b && b > 0) notImproved.push({ module: m, before: b, after: a })
  }

  let unlinked = []
  if (tagCol && ruleCol) {
    try {
      const statusFilter = expCols.has('status') ? `AND status != 'obsolete'` : ''
      unlinked = await db
        .prepare(
          `SELECT ${modCol}, COUNT(*) AS c FROM experiences
           WHERE ${repoCol}=? AND ${tagCol} LIKE '%ai-drift%' ${statusFilter}
             AND (${ruleCol} IS NULL OR ${ruleCol} = '')
           GROUP BY ${modCol === 'NULL AS module' ? '1' : 'module'} ORDER BY c DESC LIMIT 10`
        )
        .all(repo)
    } catch { /* ignore */ }
  }

  return {
    ok: true,
    ruleId,
    status: rule.status,
    activatedAt,
    weeks,
    before,
    after,
    improved,
    notImproved,
    unlinkedHighFreq: unlinked,
  }
}
