/**
 * audit/index.js — 调用审计：落库 + 实时广播
 */
import db from '../db.js'
import { runAuditMigrations } from './migrate.js'
import { publishAuditEvent } from './broker.js'
import { describeAuditEvent } from '../harness/labels.js'

runAuditMigrations()

function pickAuthor(payload = {}) {
  return (
    payload.author ||
    payload.data?.author ||
    payload.arguments?.author ||
    null
  )
}

async function pickRepo(payload = {}) {
  const explicit =
    payload.repo || payload.arguments?.repo || payload.repoSlug || null
  if (explicit) return explicit
  // 未显式传 repo 时禁止静默记成默认仓：优先用 taskId 反查任务真实归属
  const taskId =
    payload.taskId || payload.task_id || payload.data?.taskId || payload.arguments?.taskId || null
  if (taskId) {
    try {
      const row = await db
        .prepare('SELECT repo FROM tasks WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(String(taskId))
      if (row?.repo) return row.repo
    } catch { /* ignore */ }
  }
  return null
}

function pickTaskId(payload = {}) {
  return (
    payload.taskId ||
    payload.task_id ||
    payload.data?.taskId ||
    payload.arguments?.taskId ||
    null
  )
}

function previewArgs(obj, max = 200) {
  try {
    const s = JSON.stringify(obj ?? {})
    return s.length > max ? `${s.slice(0, max)}…` : s
  } catch {
    return ''
  }
}

const SENSITIVE_KEY = /token|password|secret|grant|authorization|api[_-]?key|private/i

/** 脱敏后序列化 payload（≤64KB）；写入失败返回 null，绝不抛 */
export function safePayloadJson(obj, maxBytes = 64 * 1024) {
  try {
    const scrub = (v, depth = 0) => {
      if (depth > 8 || v == null) return v ?? null
      if (Array.isArray(v)) return v.slice(0, 200).map((x) => scrub(x, depth + 1))
      if (typeof v === 'object') {
        const out = {}
        for (const [k, val] of Object.entries(v)) {
          if (SENSITIVE_KEY.test(k)) {
            out[k] = '[redacted]'
            continue
          }
          out[k] = scrub(val, depth + 1)
        }
        return out
      }
      if (typeof v === 'string' && v.length > 4000) return v.slice(0, 4000) + '…'
      return v
    }
    let s = JSON.stringify(scrub(obj ?? null))
    if (s.length > maxBytes) s = s.slice(0, maxBytes - 2) + '"}'
    return s
  } catch {
    return null
  }
}

/**
 * @param {object} evt
 */
export async function recordAuditEvent(evt) {
  const now = new Date().toISOString()
  // 归属优先级：显式 author → 任务归属人（同 task_id 的任务作者）→ 留空
  // 这样「整个任务期间产生的所有操作（上报/验证/经验/推进）」都算作当前使用人
  let resolvedAuthor = evt.author || null
  if (!resolvedAuthor && evt.taskId) {
    try {
      const t = await db
        .prepare('SELECT author FROM tasks WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(String(evt.taskId))
      if (t?.author) resolvedAuthor = t.author
    } catch { /* ignore */ }
  }
  const row = {
    event_type: evt.eventType || 'unknown',
    session_id: evt.sessionId || null,
    tool_name: evt.toolName || null,
    method: evt.method || null,
    author: resolvedAuthor,
    repo: evt.repo || null,
    task_id: evt.taskId || null,
    client_name: evt.clientName || null,
    args_preview: evt.argsPreview || null,
    status: evt.status || 'ok',
    duration_ms: evt.durationMs ?? null,
    detail: evt.detail || null,
    created_at: now,
    trace_id: evt.traceId || null,
    submission_id: evt.submissionId || null,
    run_id: evt.runId || null,
    attempt: evt.attempt ?? null,
    binding_id: evt.bindingId || null,
    payload_json: evt.payload != null ? safePayloadJson(evt.payload) : (evt.payloadJson || null),
    phase: evt.phase || null,
  }

  try {
    const info = await db
      .prepare(
        `INSERT INTO audit_events
         (event_type, session_id, tool_name, method, author, repo, task_id, client_name, args_preview, status, duration_ms, detail, created_at,
          trace_id, submission_id, run_id, attempt, binding_id, payload_json, phase)
         VALUES (@event_type, @session_id, @tool_name, @method, @author, @repo, @task_id, @client_name, @args_preview, @status, @duration_ms, @detail, @created_at,
          @trace_id, @submission_id, @run_id, @attempt, @binding_id, @payload_json, @phase)`
      )
      .run(row)

    const event = { id: Number(info.lastInsertRowid), ...row }
    event.summary_zh = describeAuditEvent(event)
    publishAuditEvent(event)
    return event
  } catch (err) {
    // 旧库未迁完时退回精简列，保证主流程不被埋点打断
    console.error(`[audit] recordAuditEvent 失败: ${err.message}`)
    try {
      const info = await db
        .prepare(
          `INSERT INTO audit_events
           (event_type, session_id, tool_name, method, author, repo, task_id, client_name, args_preview, status, duration_ms, detail, created_at)
           VALUES (@event_type, @session_id, @tool_name, @method, @author, @repo, @task_id, @client_name, @args_preview, @status, @duration_ms, @detail, @created_at)`
        )
        .run(row)
      const event = { id: Number(info.lastInsertRowid), ...row }
      event.summary_zh = describeAuditEvent(event)
      publishAuditEvent(event)
      return event
    } catch (err2) {
      console.error(`[audit] recordAuditEvent 回退仍失败: ${err2.message}`)
      return null
    }
  }
}

/** 高频执行链路事件（与看板审计分表，防 audit_events 膨胀） */
export async function recordLifecycleEvent({
  runId = null,
  attempt = null,
  leaseEpoch = null,
  eventType,
  detail = null,
  traceId = null,
  repoId = null,
  taskId = null,
}) {
  try {
    const { uuidv7, utcNow } = requireIds()
    const id = uuidv7()
    const created = utcNow()
    await db.prepare(
      `INSERT INTO run_lifecycle_events(
         event_id, run_id, attempt, lease_epoch, event_type, detail_json, trace_id, repo_id, task_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      runId,
      attempt,
      leaseEpoch,
      eventType,
      detail != null ? safePayloadJson(detail) : null,
      traceId,
      repoId,
      taskId,
      created
    )
    // 实时推送：host-worker 生命周期（acquire/complete/reject）→ 看板 SSE，避免 5s 轮询
    try {
      publishAuditEvent({
        id: `lc-${id}`,
        event_type: 'run_lifecycle',
        tool_name: 'test_run_status',
        method: 'lifecycle',
        run_id: runId,
        attempt,
        status: 'ok',
        repo: repoId || null,
        task_id: taskId || null,
        detail: `${eventType}${detail ? ` ${String(JSON.stringify(detail)).slice(0, 80)}` : ''}`,
        created_at: created,
      })
    } catch { /* ignore */ }
    return { eventId: id, createdAt: created }
  } catch (err) {
    console.error(`[audit] recordLifecycleEvent 失败: ${err.message}`)
    return null
  }
}

function requireIds() {
  // 延迟 import 避免与 testing 包循环依赖（uuidv7 无状态）
  return {
    uuidv7: () => {
      // 使用 crypto.randomUUID 作 lifecycle id（无序即可）
      return globalThis.crypto?.randomUUID?.() || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    },
    utcNow: () => new Date().toISOString(),
  }
}

/** MCP tools/call 快捷记录 */
export async function recordMcpToolCall({ sessionId, toolName, args, clientName, status = 'ok', durationMs, detail, author = null, traceId = null }) {
  const evt = await recordAuditEvent({
    eventType: 'mcp_tool',
    sessionId,
    toolName,
    method: 'tools/call',
    author: author || pickAuthor(args),
    repo: await pickRepo(args),
    taskId: pickTaskId(args),
    clientName,
    argsPreview: previewArgs(args),
    status,
    durationMs,
    detail,
    traceId,
    payload: args,
  })
  if (evt && !detail) {
    try {
      await db.prepare('UPDATE audit_events SET detail = ? WHERE id = ?').run(evt.summary_zh, evt.id)
      evt.detail = evt.summary_zh
    } catch { /* ignore */ }
  }
  return evt
}

export async function recordMcpInit({ sessionId, clientName, clientVersion, author = null }) {
  const evt = await recordAuditEvent({
    eventType: 'mcp_init',
    sessionId,
    method: 'initialize',
    author,
    clientName: clientName || 'unknown',
    argsPreview: clientVersion ? `v${clientVersion}` : '',
    detail: '新客户端连接',
  })
  await db.prepare('UPDATE audit_events SET detail = ? WHERE id = ?').run(evt.summary_zh, evt.id)
  evt.detail = evt.summary_zh
  return evt
}

export async function recordHttpEvent({ eventType, payload, status, detail, durationMs }) {
  const evt = await recordAuditEvent({
    eventType,
    method: 'HTTP',
    author: pickAuthor(payload),
    repo: await pickRepo(payload),
    taskId: pickTaskId(payload),
    argsPreview: previewArgs(payload),
    status,
    detail,
    durationMs,
  })
  if (!detail) {
    await db.prepare('UPDATE audit_events SET detail = ? WHERE id = ?').run(evt.summary_zh, evt.id)
    evt.detail = evt.summary_zh
  }
  return evt
}

export async function queryAuditEvents({ author, sessionId, repo, toolName, limit = 100, sinceId = 0 } = {}) {
  let sql = "SELECT * FROM audit_events WHERE id > ? AND event_type != 'http_harness_status'"
  const params = [sinceId || 0]
  if (author) {
    sql += ' AND author = ?'
    params.push(author)
  }
  if (sessionId) {
    sql += ' AND session_id = ?'
    params.push(sessionId)
  }
  if (repo) {
    sql += ' AND repo = ?'
    params.push(repo)
  }
  if (toolName) {
    sql += ' AND tool_name = ?'
    params.push(toolName)
  }
  sql += ' ORDER BY id DESC LIMIT ?'
  params.push(limit)
  return await db.prepare(sql).all(...params)
}

/**
 * 全链路时间线：按 taskId / submissionId / traceId 聚合 audit + lifecycle。
 */
export async function queryTrace({ taskId = null, submissionId = null, traceId = null, repo = null, limit = 500 } = {}) {
  if (!taskId && !submissionId && !traceId) {
    return { ok: false, error: '需要 taskId / submissionId / traceId 之一' }
  }
  const auditWhere = []
  const auditParams = []
  if (traceId) { auditWhere.push('trace_id = ?'); auditParams.push(traceId) }
  if (submissionId) { auditWhere.push('submission_id = ?'); auditParams.push(submissionId) }
  if (taskId) { auditWhere.push('task_id = ?'); auditParams.push(taskId) }
  if (repo) { auditWhere.push('repo = ?'); auditParams.push(repo) }
  const audit = await db
    .prepare(
      `SELECT id, event_type, session_id, tool_name, method, author, repo, task_id, client_name,
              args_preview, status, duration_ms, detail, created_at,
              trace_id, submission_id, run_id, attempt, binding_id, payload_json, phase
       FROM audit_events
       WHERE (${auditWhere.join(' OR ')})
       ORDER BY id ASC LIMIT ?`
    )
    .all(...auditParams, limit)

  // lifecycle：优先 trace，其次从 audit 里收集 run_id
  const runIds = [...new Set(audit.map((e) => e.run_id).filter(Boolean))]
  let lifecycle = []
  try {
    const lcWhere = []
    const lcParams = []
    if (traceId) { lcWhere.push('trace_id = ?'); lcParams.push(traceId) }
    if (taskId) { lcWhere.push('task_id = ?'); lcParams.push(taskId) }
    if (runIds.length) {
      lcWhere.push(`run_id IN (${runIds.map(() => '?').join(',')})`)
      lcParams.push(...runIds)
    }
    if (lcWhere.length) {
      lifecycle = await db
        .prepare(
          `SELECT event_id, run_id, attempt, lease_epoch, event_type, detail_json, trace_id, repo_id, task_id, created_at
           FROM run_lifecycle_events
           WHERE ${lcWhere.join(' OR ')}
           ORDER BY created_at ASC LIMIT ?`
        )
        .all(...lcParams, limit)
    }
  } catch { lifecycle = [] }

  const events = [
    ...audit.map((e) => ({ source: 'audit', at: e.created_at, ...e })),
    ...lifecycle.map((e) => ({
      source: 'lifecycle',
      at: e.created_at,
      event_type: e.event_type,
      run_id: e.run_id,
      attempt: e.attempt,
      detail: e.detail_json,
      trace_id: e.trace_id,
      task_id: e.task_id,
      event_id: e.event_id,
    })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))

  return {
    ok: true,
    filters: { taskId, submissionId, traceId, repo },
    counts: { audit: audit.length, lifecycle: lifecycle.length },
    events,
  }
}

export async function listAuditAuthors(limit = 50) {
  return await db
    .prepare(
      `SELECT author, COUNT(*) as cnt, MAX(created_at) as last_at
       FROM audit_events WHERE author IS NOT NULL AND author != ''
       GROUP BY author ORDER BY last_at DESC LIMIT ?`
    )
    .all(limit)
}

export async function listAuditSessions({ author, limit = 30 } = {}) {
  let sql = `
    SELECT session_id, client_name, author, COUNT(*) as cnt,
           MIN(created_at) as started_at, MAX(created_at) as last_at
    FROM audit_events
    WHERE session_id IS NOT NULL
  `
  const params = []
  if (author) {
    sql += ' AND author = ?'
    params.push(author)
  }
  sql += ' GROUP BY session_id ORDER BY last_at DESC LIMIT ?'
  params.push(limit)
  return await db.prepare(sql).all(...params)
}

export { subscribeAudit } from './broker.js'
