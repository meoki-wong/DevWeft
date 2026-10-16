import { uuidv7 } from './ids.js'

const STATUS = new Set(['unverified', 'confirmed', 'rejected'])
const SOURCE = new Set(['run', 'manual', 'external'])
const SECRET_VALUE = /(?:bearer\s+)?(?:gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})/i
const SENSITIVE_KEY = /token|password|secret|authorization|api[_-]?key|private[_-]?key/i

function cleanText(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 必须是 1-${max} 字符文本`)
  if (SECRET_VALUE.test(value)) throw new Error(`${name} 检测到疑似密钥，请移除后再提交`)
  return value.trim()
}

function validateJson(value, name, maxBytes = 8192) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是 JSON 对象`)
  const inspect = (item, depth = 0) => {
    if (depth > 8) throw new Error(`${name} 嵌套层级过深`)
    if (Array.isArray(item)) return item.forEach((child) => inspect(child, depth + 1))
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (SENSITIVE_KEY.test(key)) throw new Error(`${name} 不允许包含敏感字段 ${key}`)
        inspect(child, depth + 1)
      }
    } else if (typeof item === 'string' && SECRET_VALUE.test(item)) throw new Error(`${name} 检测到疑似密钥，请移除后再提交`)
  }
  inspect(value)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error(`${name} 超过 ${maxBytes} 字节`)
  return json
}

export async function createExperienceFeedback(db, input, { now = new Date() } = {}) {
  const repoId = String(input.repoId || '')
  if (!repoId) throw new Error('repoId 必填')
  const sourceType = input.sourceType || (input.runId ? 'run' : 'manual')
  if (!SOURCE.has(sourceType)) throw new Error('sourceType 必须是 run、manual 或 external')
  const failureSummary = cleanText(input.failureSummary, 'failureSummary', 2000)
  const resolutionSummary = cleanText(input.resolutionSummary, 'resolutionSummary', 4000)
  const scopeJson = validateJson(input.scope, 'scope')
  const evidenceJson = validateJson(input.evidence, 'evidence')
  const runId = input.runId ? String(input.runId) : null
  const failureId = input.failureId ? String(input.failureId) : null
  if (runId) {
    const run = await db.prepare('SELECT repo_id FROM test_runs WHERE run_id=?').get(runId)
    if (!run) throw new Error('关联运行不存在')
    if (run.repo_id !== repoId) throw new Error('关联运行必须属于同一仓库')
  }
  if (failureId) {
    const failure = await db.prepare('SELECT repo_id FROM test_failures WHERE failure_id=?').get(failureId)
    if (!failure) throw new Error('关联失败记录不存在')
    if (failure.repo_id !== repoId) throw new Error('关联失败必须属于同一仓库')
  }
  const feedbackId = uuidv7(now.getTime())
  const createdAt = now.toISOString()
  await db.prepare(
    `INSERT INTO experience_feedback(
      feedback_id, repo_id, run_id, failure_id, experience_ref, author, source_type,
      failure_summary, resolution_summary, scope_json, evidence_json, verification_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?)`
  ).run(feedbackId, repoId, runId, failureId, input.experienceRef || null,
    input.author ? cleanText(input.author, 'author', 120) : null, sourceType,
    failureSummary, resolutionSummary, scopeJson, evidenceJson, createdAt)
  return {
    feedbackId, repoId, runId, failureId, sourceType, failureSummary, resolutionSummary,
    scope: JSON.parse(scopeJson), evidence: JSON.parse(evidenceJson),
    verificationStatus: 'unverified', createdAt,
  }
}

export async function reviewExperienceFeedback(db, { feedbackId, action, reviewer, note = '', now = new Date() } = {}) {
  const status = action === 'confirm' ? 'confirmed' : action === 'reject' ? 'rejected' : null
  if (!feedbackId || !status) throw new Error('需要 feedbackId 和 confirm/reject action')
  if (typeof note !== 'string' || note.length > 1000) throw new Error('note 最多 1000 字符')
  const row = await db.prepare('SELECT * FROM experience_feedback WHERE feedback_id=?').get(feedbackId)
  if (!row) return null
  if (row.verification_status !== 'unverified') throw new Error('反馈已审核，不能重复审核')
  const reviewedAt = now.toISOString()
  await db.prepare(
    `UPDATE experience_feedback SET verification_status=?, reviewed_at=?, reviewed_by=?, review_note=?
     WHERE feedback_id=? AND verification_status='unverified'`
  ).run(status, reviewedAt, reviewer || 'reviewer', note.trim() || null, feedbackId)
  const updated = await db.prepare('SELECT * FROM experience_feedback WHERE feedback_id=?').get(feedbackId)
  return { ...updated, scope: JSON.parse(updated.scope_json), evidence: JSON.parse(updated.evidence_json) }
}

export async function listExperienceFeedback(db, { repoId, status = null, limit = 50 } = {}) {
  if (!repoId) throw new Error('repoId 必填')
  if (status && !STATUS.has(status)) throw new Error('verification status 不合法')
  const safeLimit = Number.isInteger(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 50
  const rows = await db.prepare(
    `SELECT * FROM experience_feedback WHERE repo_id=?${status ? ' AND verification_status=?' : ''}
     ORDER BY created_at DESC LIMIT ?`
  ).all(...(status ? [repoId, status, safeLimit] : [repoId, safeLimit]))
  return rows.map((row) => ({ ...row, scope: JSON.parse(row.scope_json), evidence: JSON.parse(row.evidence_json) }))
}
