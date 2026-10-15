/**
 * §20 M5 failure fingerprint + classification + dedup + pending review
 * §23 infra/canary 不进 experience（trigger 在 schema 兜底）
 * v27：promote 写入统一到协作层 experiences（id/repo/...），真库可用
 */
import { columnExists } from '../db/dialect-helpers.js'
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { createHash } from 'node:crypto'

const FAILURE_PHASES = ['snapshot','install','static','build','vite_start','smoke','artifact','unknown']
const FAILURE_CLASSES = [
  'unclassified','product','regression','dependency_input','product_hang',
  'flaky','infra','registry_infra','vm_infra','suite','environment',
]
const INFRA_CLASSES = ['infra','registry_infra','vm_infra','environment']

/** 规范化错误签名：取前 8 行非空 + 去 \r + trim */
function normalizeStack(text) {
  if (!text) return ''
  return String(text)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).join('|')
}

export function fingerprintError(version, phase, rawStack) {
  if (!Number.isInteger(version) || version < 1) throw new ApiError('INVALID_SCHEMA')
  if (!FAILURE_PHASES.includes(phase)) throw new ApiError('INVALID_SCHEMA')
  const norm = normalizeStack(rawStack)
  return createHash('sha256').update(`${version}\u0000${phase}\u0000${norm}`).digest('hex')
}

/** §20.3 infra 分类启发式：含 NPM/Network/VHD/permission/system32 → infra 类 */
export function classifyFailure({ phase, rawStack }) {
  const text = (rawStack || '').toLowerCase()
  if (/npm (err!|warn|registry)|enotfound|econnrefused|etimedout|http 5\d\d/.test(text) && /npm|npmrc/.test(text)) return 'registry_infra'
  if (/hyper-?v|vhdx|\.vhdx|get-vm|mount-vhd|virtualization/.test(text)) return 'vm_infra'
  if (/permission denied|access is denied|not found|missing module|cannot find module/.test(text) && /system32|\\windows\\/.test(text)) return 'infra'
  if (/disconnected|connection reset|timeout/.test(text) && /(npm|git|node)/.test(text)) return 'infra'
  if (/vite |build failed|transform error|syntax error/.test(text) && phase === 'build') return 'environment'
  return 'unclassified'
}

/** §20.5 去重：同 (repo, fingerprint_version, fingerprint) 走 active UNIQUE（仅 open/triaged） */
export async function recordFailure(db, body, { now = new Date() } = {}) {
  if (!body.repoId || !body.bindingId || !body.taskInstanceId || !body.errorSignature) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (!FAILURE_PHASES.includes(body.failurePhase)) throw new ApiError('INVALID_SCHEMA')
  if (!FAILURE_CLASSES.includes(body.failureClass)) throw new ApiError('INVALID_SCHEMA')
  const fp = body.fingerprint || fingerprintError(body.fingerprintVersion || 1, body.failurePhase, body.errorSignature)
  const nowIso = now.toISOString()
  // 查找 active failure
  const existing = await db.prepare(
    `SELECT * FROM test_failures
     WHERE repo_id=? AND fingerprint_version=? AND fingerprint=? AND status IN ('open','triaged')`
  ).get(body.repoId, body.fingerprintVersion || 1, fp)
  if (existing) {
    await db.prepare(
      `UPDATE test_failures
       SET occurrence_count = occurrence_count + 1, last_seen_at = ?,
           reviewed_by = COALESCE(?, reviewed_by),
           review_note = COALESCE(?, review_note)
       WHERE failure_id = ?`
    ).run(nowIso, body.reviewerPrincipalId || null, body.reviewNote || null, existing.failure_id)
    return { failureId: existing.failure_id, deduped: true, occurrence: existing.occurrence_count + 1 }
  }
  const failureId = uuidv7()
  try {
    await db.prepare(
      `INSERT INTO test_failures(
         failure_id, repo_id, binding_id, task_instance_id,
         failure_phase, failure_class, fingerprint_version, fingerprint,
         case_key, spec_file, test_title, error_signature,
         occurrence_count, status, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)`
    ).run(
      failureId, body.repoId, body.bindingId, body.taskInstanceId,
      body.failurePhase, body.failureClass, body.fingerprintVersion || 1, fp,
      body.caseKey || null, body.specFile || null, body.testTitle || null, body.errorSignature,
      nowIso, nowIso
    )
    process.stderr.write(`recordFailure INSERT OK\n`)
  } catch (e) {
    console.log('recordFailure INSERT ERR:', e.message, 'binding_id=', body.bindingId, 'task=', body.taskInstanceId)
    throw e
  }
  return { failureId, deduped: false, fingerprint: fp, createdAt: nowIso }
}

export async function recordOccurrence(db, { failureId, runId, attempt, status = 'failed' } = {}) {
  if (!failureId || !runId) throw new ApiError('INVALID_SCHEMA')
  if (!['failed', 'passed_on_diagnostic', 'dismissed'].includes(status)) throw new ApiError('INVALID_SCHEMA')
  if (!Number.isInteger(attempt) || attempt < 1) throw new ApiError('INVALID_SCHEMA')
  const occId = uuidv7()
  await db.prepare(
    `INSERT INTO failure_occurrences(occurrence_id, failure_id, run_id, attempt, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(occId, failureId, runId, attempt, status, new Date().toISOString())
  return { occurrenceId: occId }
}

export async function listFailures(db, { repoId, status, limit = 50 } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const where = ['repo_id = ?']
  const args = [repoId]
  if (status) { where.push('status = ?'); args.push(status) }
  const sql = `SELECT * FROM test_failures WHERE ${where.join(' AND ')} ORDER BY last_seen_at DESC LIMIT ?`
  args.push(limit)
  return await db.prepare(sql).all(...args)
}

export async function getFailure(db, failureId) {
  return await db.prepare('SELECT * FROM test_failures WHERE failure_id=?').get(failureId) || null
}

export async function updateFailureStatus(db, { failureId, status, reviewerPrincipalId, reviewNote, now = new Date() } = {}) {
  if (!failureId || !status) throw new ApiError('INVALID_SCHEMA')
  if (!['open', 'triaged', 'linked', 'dismissed', 'promoted'].includes(status)) throw new ApiError('INVALID_SCHEMA')
  await db.prepare(
    `UPDATE test_failures SET status=?, reviewed_by=COALESCE(?, reviewed_by), reviewed_at=COALESCE(?, reviewed_at), review_note=COALESCE(?, review_note)
     WHERE failure_id=?`
  ).run(status, reviewerPrincipalId || null, now.toISOString(), reviewNote || null, failureId)
  return await getFailure(db, failureId)
}

/** §23 experience_pending: infra 类被 trigger 拒绝 promoted_to_experience */
export async function createExperiencePending(db, body, { now = new Date() } = {}) {
  if (!body.repoId || !body.sourceId || !body.failureClass || !body.content) {
    console.error('createExperiencePending missing field:', JSON.stringify({ repo: body.repoId, src: body.sourceId, fc: body.failureClass, content: body.content }))
    throw new ApiError('INVALID_SCHEMA')
  }
  if (!FAILURE_CLASSES.includes(body.failureClass)) {
    console.error('createExperiencePending bad class:', body.failureClass, 'allowed:', FAILURE_CLASSES)
    throw new ApiError('INVALID_SCHEMA')
  }
  const pendingId = uuidv7()
  await db.prepare(
    `INSERT INTO experience_pending(
       pending_id, repo_id, source_id, failure_class, content, title, tags_json,
       status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_review', ?)`
  ).run(
    pendingId, body.repoId, body.sourceId, body.failureClass,
    body.content, body.title || null, body.tagsJson ? JSON.stringify(body.tagsJson) : null,
    now.toISOString()
  )
  return { pendingId, status: 'pending_review' }
}

/** 检测 experiences 表形态：unified（db.js 协作层）/ v8（testing 控制面 in-memory） */
async function experiencesSchemaKind(db) {
  // 方言感知列探测(§2.8):postgres 走 information_schema.columns
  const cols = (await Promise.all(['id', 'repo', 'experience_id', 'repo_id'].map(async (c) => (await columnExists(db, 'experiences', c)) ? c : null))).filter(Boolean)
  const set = new Set(cols)
  if (set.has('id') && set.has('repo')) return 'unified'
  if (set.has('experience_id') && set.has('repo_id')) return 'v8'
  return 'unknown'
}

/** repo_id → slug（找不到时原样返回，兼容 in-memory 测试） */
async function resolveRepoSlug(db, repoId) {
  try {
    const row = await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(repoId)
    return row?.slug || repoId
  } catch {
    return repoId
  }
}

/**
 * 将 pending 升级为 experiences 行。
 * 真库（unified）：写协作层主结构 + v27 增补列。
 * in-memory（v8）：保持原 v8 写入，测试路径不破。
 */
async function insertPromotedExperience(db, row, { reviewerPrincipalId, fingerprint, nowIso }) {
  const kind = await experiencesSchemaKind(db)
  const title = row.title || `Experience from ${row.source_id}`
  const content = row.content
  const tagsJson = row.tags_json || '[]'

  if (kind === 'unified') {
    const id = uuidv7()
    const repo = await resolveRepoSlug(db, row.repo_id)
    const hasSourceMeta = await db.prepare(
      `SELECT 1 FROM pragma_table_info('experiences') WHERE name='source_type'`
    ).get()
    if (hasSourceMeta) {
      await db.prepare(
        `INSERT INTO experiences(
           id, repo, tenant_id, content, source, status, category, author,
           tags, created_at, updated_at,
           title, source_type, source_id, reviewer, confidence, fingerprint, promotion_type
         ) VALUES (?, ?, ?, ?, 'auto', 'reviewed', ?, ?, ?, ?, ?, ?, 'test_failure', ?, ?, ?, ?, 'pending')`
      ).run(
        id, repo, row.repo_id, content, row.failure_class || 'test',
        reviewerPrincipalId || 'system', tagsJson, nowIso, nowIso,
        title, row.source_id, reviewerPrincipalId || null, 0.5, fingerprint || row.failure_class || null
      )
    } else {
      await db.prepare(
        `INSERT INTO experiences(
           id, repo, tenant_id, content, source, status, category, author,
           tags, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'auto', 'reviewed', ?, ?, ?, ?, ?)`
      ).run(
        id, repo, row.repo_id, content, row.failure_class || 'test',
        reviewerPrincipalId || 'system', tagsJson, nowIso, nowIso
      )
    }
    return id
  }

  if (kind === 'v8') {
    const expId = uuidv7()
    await db.prepare(
      `INSERT INTO experiences(
         experience_id, repo_id, title, content, source_type, source_id,
         origin_type, failure_fingerprint, promotion_type,
         reviewed_by, reviewed_at, confidence, tags_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'test_failure', ?, 'coding', ?, 'pending', ?, ?, ?, ?, ?, ?)`
    ).run(
      expId, row.repo_id, title, content, row.source_id,
      fingerprint || row.failure_class,
      reviewerPrincipalId, nowIso, 0.5, tagsJson, nowIso, nowIso
    )
    return expId
  }

  throw new ApiError('INVALID_SCHEMA')
}

export async function reviewPending(db, { pendingId, action, reviewerPrincipalId, note, linkedFailureId, now = new Date() } = {}) {
  if (!pendingId || !action) throw new ApiError('INVALID_SCHEMA')
  if (!['linked_to_failure', 'promoted_to_experience', 'rejected'].includes(action)) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM experience_pending WHERE pending_id=?').get(pendingId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  if (row.status !== 'pending_review') throw new ApiError('SUITE_REVOKED')
  const nowIso = now.toISOString()
  if (action === 'promoted_to_experience') {
    // trigger 自动检查 infra 拦截
    await db.prepare(
      `UPDATE experience_pending
       SET status='promoted_to_experience', reviewed_at=?, reviewed_by=?, review_note=?, linked_failure_id=?
       WHERE pending_id=?`
    ).run(nowIso, reviewerPrincipalId, note || null, linkedFailureId || null, pendingId)
    let fingerprint = null
    if (linkedFailureId) {
      const fail = await getFailure(db, linkedFailureId)
      fingerprint = fail?.fingerprint || null
    }
    const expId = await insertPromotedExperience(db, row, {
      reviewerPrincipalId,
      fingerprint,
      nowIso,
    })
    await db.prepare('UPDATE experience_pending SET linked_experience_id=? WHERE pending_id=?').run(expId, pendingId)
    return { pendingId, action, experienceId: expId }
  }
  if (action === 'linked_to_failure') {
    if (!linkedFailureId) throw new ApiError('INVALID_SCHEMA')
    await db.prepare(
      `UPDATE experience_pending
       SET status='linked_to_failure', reviewed_at=?, reviewed_by=?, review_note=?, linked_failure_id=?
       WHERE pending_id=?`
    ).run(nowIso, reviewerPrincipalId, note || null, linkedFailureId, pendingId)
    await db.prepare('UPDATE test_failures SET status=?, linked_experience_id=? WHERE failure_id=?').run('linked', pendingId, linkedFailureId)
    return { pendingId, action, linkedFailureId }
  }
  // rejected
  await db.prepare(
    `UPDATE experience_pending SET status='rejected', reviewed_at=?, reviewed_by=?, review_note=? WHERE pending_id=?`
  ).run(nowIso, reviewerPrincipalId, note || null, pendingId)
  return { pendingId, action }
}

export async function listExperiencePending(db, { repoId, status, limit = 50 } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const where = ['repo_id = ?']
  const args = [repoId]
  if (status) { where.push('status = ?'); args.push(status) }
  args.push(limit)
  return await db.prepare(
    `SELECT * FROM experience_pending WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`
  ).all(...args)
}

/**
 * 列出经验。repoId 可传 repositories.repo_id 或 slug。
 * unified 表按 repo=slug 过滤；v8 表按 repo_id 过滤。
 */
export async function listExperiences(db, { repoId, limit = 50 } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  const kind = await experiencesSchemaKind(db)
  if (kind === 'unified') {
    const slug = await resolveRepoSlug(db, repoId)
    return await db.prepare(
      'SELECT * FROM experiences WHERE repo=? ORDER BY created_at DESC LIMIT ?'
    ).all(slug, limit)
  }
  return await db.prepare(
    'SELECT * FROM experiences WHERE repo_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(repoId, limit)
}
