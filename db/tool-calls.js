/**
 * db/tool-calls.js — 链路网关方案 §4/§15/§16：tool_calls 幂等账本核心逻辑（方言无关 DB 访问 + 纯消息构造）。
 *
 * - server.js 在 tools/call 各分支调用；不取代 audit_events（recordMcpToolCall 保持原样另写审计）。
 * - 两方言共用：db.prepare(...).get/run 在 sqlite 同步、postgres 句柄异步，调用点一律 await。
 * - 回放消息形状见 §15；status=error → isError true。写工具无正文禁止记 finished（§16），由调用点决定。
 */

// §3 写工具名单：重放时若已有结束记录则回放不再执行；无正文时禁止标 finished。
export const WRITE_TOOLS = new Set([
  'harness_start',
  'harness_advance',
  'distill_append',
  'distill_set_status',
  'update_doc',
  'update_docs_batch',
  'lesson_record',
  'verify_report',
  'task_state',
  'awp_test_spec_submit',
  'awp_test_run',
  'awp_loop_resume',
  'awp_task_attach',
  'generate_rule_pr',
])

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name)
}

/** 读取现有账本行；无则 null。 */
export async function getToolCall(db, callId) {
  return db.prepare('SELECT * FROM tool_calls WHERE call_id = ?').get(callId)
}

/** 进入工具前落 started；同一 call_id 已有行则不插入（§4.1）。servedByLink/failoverFrom 为链路归因（仅随首次插入落库）。 */
export async function insertStarted(db, { callId, repo = null, taskId = null, toolName = null, phase = null, servedByLink = null, failoverFrom = null }) {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO tool_calls (call_id, repo, task_id, tool_name, phase, state, status, response_text, started_at, finished_at, served_by_link, failover_from)
       VALUES (?, ?, ?, ?, ?, 'started', NULL, NULL, ?, NULL, ?, ?)
       ON CONFLICT (call_id) DO NOTHING`
    )
    .run(callId, repo, taskId, toolName, phase, now, servedByLink, failoverFrom)
}

/** 落 finished + status + 正文；仅当前仍为 started 才更新（避免覆盖已回放结论）。servedByLink 只补空、不覆盖既有归因。 */
export async function markFinished(db, { callId, status, responseText = null, servedByLink = null }) {
  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE tool_calls SET state = 'finished', status = ?, response_text = ?, finished_at = ?, served_by_link = COALESCE(served_by_link, ?)
       WHERE call_id = ? AND state = 'started'`
    )
    .run(status, responseText, now, servedByLink, callId)
}

/**
 * 门禁/拒绝路径直接落一条 finished+error 行（§4.4）。这些路径无业务提交，可独立写账本。
 * 已存在同 call_id 行（极少并发）时 DO UPDATE 收敛为 error 结论。
 */
export async function recordReject(db, { callId, repo = null, taskId = null, toolName = null, phase = null, responseText, servedByLink = null, failoverFrom = null }) {
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT INTO tool_calls (call_id, repo, task_id, tool_name, phase, state, status, response_text, started_at, finished_at, served_by_link, failover_from)
       VALUES (?, ?, ?, ?, ?, 'finished', 'error', ?, ?, ?, ?, ?)
       ON CONFLICT (call_id) DO UPDATE SET state='finished', status='error', response_text=excluded.response_text, finished_at=excluded.finished_at`
    )
    .run(callId, repo, taskId, toolName, phase, responseText, now, now, servedByLink, failoverFrom)
}

/** 会话失效（-32001）等「工具从未执行」路径：释放在途预约（删除仍为 started 的行），让重放真正执行。 */
export async function releaseStarted(db, callId) {
  await db.prepare(`DELETE FROM tool_calls WHERE call_id = ? AND state = 'started'`).run(callId)
}

/** §15 回放消息：结束记录回放时写回与正常工具返回相同的 MCP 形状。id 用客户端本次请求的 id。 */
export function buildReplayMessage(row, reqId) {
  const isError = row.status === 'error'
  return {
    jsonrpc: '2.0',
    id: reqId,
    result: {
      content: [{ type: 'text', text: row.response_text ?? '' }],
      isError,
    },
  }
}

/** §4.5 在途：同 call_id 仍 started → JSON-RPC 错误 -32002 CALL_IN_PROGRESS。 */
export function callInProgressMessage(reqId) {
  return { jsonrpc: '2.0', id: reqId, error: { code: -32002, message: 'CALL_IN_PROGRESS' } }
}

/**
 * UI 链路分叉读模型：检测任务链上所有链路切换事件，产出 events 数组（fork/recover 时间序列）。
 * - 检测规则：优先显式 failover_from（网关换链标注），其次相邻非空 served_by_link 变化（session 级迁移）。
 * - 事件类型：fork（主→备）、recover（备→主）、switch（其他切换，防御性处理）。
 * - 只取元数据列（不取 response_text 大列）；走 (task_id, started_at) 索引；缺列（存量库未升级）时静默返回空。
 * - 标签用 links.name 解析，查不到时退回 link_id 原文；无切换/无数据 → events: []。
 * - 向后兼容：fork 字段仍返回最近一次 fork 事件（旧前端可用）。
 */
export async function buildLinkFork(db, { taskId, repo = null }) {
  if (!taskId) return { ok: true, fork: null, events: [] }
  let rows = []
  try {
    const sql = repo
      ? `SELECT call_id, tool_name, phase, state, status, served_by_link, failover_from, started_at
         FROM tool_calls WHERE task_id = ? AND (repo = ? OR repo IS NULL)
         ORDER BY started_at ASC, call_id ASC LIMIT 500`
      : `SELECT call_id, tool_name, phase, state, status, served_by_link, failover_from, started_at
         FROM tool_calls WHERE task_id = ?
         ORDER BY started_at ASC, call_id ASC LIMIT 500`
    rows = repo ? (await db.prepare(sql).all(taskId, repo)) || [] : (await db.prepare(sql).all(taskId)) || []
  } catch {
    return { ok: true, fork: null, events: [] } // 老库缺列等场景：优雅缺失
  }
  if (!rows.length) return { ok: true, fork: null, events: [] }

  // 加载链路信息：名称映射 + 主链路标识
  let links = []
  try {
    links = (await db.prepare('SELECT link_id, name, is_primary FROM links').all()) || []
  } catch { /* 缺表时退回空数组 */ }
  const nameByLink = Object.fromEntries(links.map((r) => [r.link_id, r.name]))
  const primaryLinkId = links.find((l) => Number(l.is_primary) === 1)?.link_id || 'primary'
  const label = (id) => nameByLink[id] || id || null

  // 扫描所有切换事件（时间序列）
  const events = []
  let prevLink = rows[0].served_by_link || null

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const curLink = row.served_by_link || null

    // 检测切换点：显式 failover_from 或相邻 served_by_link 变化
    let isSwitch = false
    let fromLink = null
    const toLink = curLink

    if (row.failover_from) {
      // 显式换链标注（网关在响应头写入 x-awp-failover-from）
      isSwitch = true
      fromLink = String(row.failover_from).split(',')[0]
    } else if (i > 0 && curLink && prevLink && curLink !== prevLink) {
      // 相邻 served_by_link 变化（session 级迁移，无显式 failover_from）
      isSwitch = true
      fromLink = prevLink
    }

    if (isSwitch && fromLink && toLink && fromLink !== toLink) {
      // 判断事件类型：fork（主→备）、recover（备→主）、switch（其他）
      // 如果 fromLink 不在 links 表里，假设它是主链路（未知链路通常是主链路的旧名称或临时名称）
      const fromIsPrimary = fromLink === primaryLinkId || !links.some((l) => l.link_id === fromLink)
      const toIsPrimary = toLink === primaryLinkId
      let type
      if (fromIsPrimary && !toIsPrimary) {
        type = 'fork' // 主链路故障，切换到备用链路
      } else if (!fromIsPrimary && toIsPrimary) {
        type = 'recover' // 主链路恢复，切换回主链路
      } else {
        type = 'switch' // 备→备 或 主→主（理论上不应发生，防御性处理）
      }

      events.push({
        type,
        phase: row.phase || null,
        toolName: row.tool_name || null,
        at: row.started_at,
        callId: row.call_id,
        fromLink,
        toLink,
        fromLabel: label(fromLink),
        toLabel: label(toLink),
      })
    }

    if (curLink) prevLink = curLink
  }

  if (!events.length) return { ok: true, fork: null, events: [] }

  // 向后兼容：fork 字段返回最近一次 fork 事件（旧前端可用）
  const lastFork = events.filter((e) => e.type === 'fork').pop()
  const fork = lastFork
    ? {
        forkPhase: lastFork.phase,
        primaryLabel: lastFork.fromLabel,
        backupLabel: lastFork.toLabel,
        forkAt: lastFork.at,
        forkCallId: lastFork.callId,
        forkToolName: lastFork.toolName,
      }
    : null

  return { ok: true, fork, events }
}

/** §4.2 已结束但写工具无正文：明确错误，禁止再执行。 */
export function finishedWithoutBodyMessage(reqId) {
  return {
    jsonrpc: '2.0',
    id: reqId,
    result: {
      content: [{ type: 'text', text: `CALL_FINISHED_WITHOUT_BODY: 调用 ${String(reqId)} 已结束但未存正文，禁止重放再执行。` }],
      isError: true,
    },
  }
}

/**
 * 从截获的响应正文提取 MCP tools/call 结果（§16 的 G2 捕获）。
 * 兼容两种写法：单条 application/json，或 text/event-stream 多帧（data: {...}）。
 * 命中条件：JSON-RPC 报文 id === reqId，且带 result 或 error。
 * 返回 { found, isError, text }；found=false 表示截不到本请求的结果正文。
 */
export function extractToolResult(capturedText, reqId) {
  const raw = String(capturedText || '')
  if (!raw.trim()) return { found: false, isError: false, text: '' }

  const candidates = []
  // SSE：抽取所有 data: 行的 JSON
  if (raw.includes('data:')) {
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (s.startsWith('data:')) {
        const payload = s.slice(5).trim()
        if (payload && payload !== '[DONE]') candidates.push(payload)
      }
    }
  }
  // 直接 JSON（整个正文或逐行 JSON）
  if (candidates.length === 0) {
    candidates.push(raw)
    for (const line of raw.split('\n')) {
      const s = line.trim()
      if (s.startsWith('{')) candidates.push(s)
    }
  }

  for (const payload of candidates) {
    let msg
    try {
      msg = JSON.parse(payload)
    } catch {
      continue
    }
    if (!msg || msg.id !== reqId) continue
    if (msg.error) {
      const m = msg.error.message || msg.error.code || ''
      return { found: true, isError: true, text: `JSONRPC_ERROR ${msg.error.code}: ${m}` }
    }
    if (msg.result && Array.isArray(msg.result.content)) {
      const text = msg.result.content
        .filter((c) => c && c.type === 'text')
        .map((c) => c.text ?? '')
        .join('')
      return { found: true, isError: Boolean(msg.result.isError), text }
    }
  }
  return { found: false, isError: false, text: '' }
}
