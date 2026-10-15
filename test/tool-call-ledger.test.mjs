/**
 * tool-call-ledger.test.mjs — 链路网关方案 §4/§16 完成标准
 *
 * 经 buildApp() + 真实 /mcp HTTP，覆盖五种情况：
 *  1. 首次执行写工具 → tool_calls 落 finished + 存 response_text；
 *  2. 同一 call_id 已 finished → 回放，不重复推进 tasks.phase（且只一行 finished）；
 *  3. 同一 call_id 仍 started → -32002 CALL_IN_PROGRESS，不执行工具；
 *  4. isError（门禁拒绝路径产出 isError:true 的 MCP 结果）→ 记 status=error；
 *  5. activityToolBlock 拒绝 → 也有 finished 行（status=error）。
 * G2 降级：extractToolResult 纯函数覆盖 SSE 多帧捕获 + 截不到正文。
 *
 * 只建一次性隔离库（setup-test-db），禁止写 data/team.db。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server.js'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { harnessStart } from '../harness/state-machine.js'
import { getToolCall, extractToolResult, markFinished } from '../db/tool-calls.js'

const SLUG = `ledger-${Date.now().toString(36)}`
const USER = 'ledger-tester'
let app = null
let server = null
let base = null

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

beforeAll(async () => {
  await ensureRepository(db, SLUG, null)
  app = buildApp()
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  try { server?.close() } catch { /* ignore */ }
  try {
    const rows = await db.prepare('SELECT task_id FROM tasks WHERE repo=?').all(SLUG)
    for (const r of rows) {
      await db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
      await db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
      await db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
    }
    await db.prepare('DELETE FROM tasks WHERE repo=?').run(SLUG)
    await db.prepare('DELETE FROM tool_calls WHERE repo=?').run(SLUG)
  } catch { /* ignore */ }
})

async function postMcp(body, extraHeaders = {}) {
  return fetch(`${base}/mcp`, { method: 'POST', headers: { ...JSON_HEADERS, ...extraHeaders }, body: JSON.stringify(body) })
}

async function readRpc(res) {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
    return dataLine ? JSON.parse(dataLine.slice(5).trim()) : null
  }
  return res.json()
}

/** 建一个已 initialize 的会话，返回 sessionId */
async function initSession() {
  const res = await postMcp({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ledger-test', version: '1.0.0' } },
  })
  const body = await readRpc(res)
  expect(body.result?.serverInfo?.name).toBeTruthy()
  const sid = res.headers.get('mcp-session-id')
  await postMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid })
  return sid
}

async function phaseOf(taskId) {
  const row = await db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(SLUG, taskId)
  return row?.phase || null
}

async function countRows(callId) {
  const r = await db.prepare('SELECT COUNT(*) c FROM tool_calls WHERE call_id=?').get(callId)
  return Number(r.c)
}

describe('tool_calls 账本（§4/§16）', () => {
  it('1) 首次执行写工具 → finished + 存 response_text', async () => {
    const sid = await initSession()
    const callId = randomUUID()
    const res = await postMcp(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'harness_start', arguments: { requirement: `账本首执 ${randomUUID().slice(0, 8)}`, type: 'FIX', repo: SLUG } } },
      { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }
    )
    const body = await readRpc(res)
    expect(body.result?.isError).toBeFalsy()

    const row = await getToolCall(db, callId)
    expect(row).toBeTruthy()
    expect(row.state).toBe('finished')
    expect(row.status).toBe('ok')
    expect(row.tool_name).toBe('harness_start')
    // 写工具必须存正文
    expect(row.response_text && row.response_text.length > 0).toBe(true)
    const parsed = JSON.parse(row.response_text)
    expect(parsed.ok).toBe(true)
    expect(countRows(callId)).resolves.toBe(1)
  })

  it('2) 同 call_id 已 finished → 回放，不重复推进 tasks.phase', async () => {
    const sid = await initSession()
    // 先建一个 FIX 任务（phase=RECEIVE）
    const taskId = `adv-${randomUUID().slice(0, 8)}`
    const created = await harnessStart({ taskId, requirement: '账本推进任务', type: 'FIX', author: USER, repo: SLUG })
    expect(created.ok).toBe(true)
    const beforePhase = await phaseOf(taskId)

    const callId = randomUUID()
    const advanceBody = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'harness_advance', arguments: { taskId, to: 'execute', repo: SLUG } } }
    const first = await readRpc(await postMcp(advanceBody, { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }))
    const afterFirst = await phaseOf(taskId)
    const rowFirst = await getToolCall(db, callId)
    expect(rowFirst.state).toBe('finished')

    // 同 call_id 再发一次：应回放，绝不重复执行（phase 不再变化）
    const replay = await readRpc(await postMcp(advanceBody, { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }))
    const afterReplay = await phaseOf(taskId)

    expect(afterReplay).toBe(afterFirst) // 回放绝不重复执行：phase 与首次一致
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first)) // 回放与首次正文一致
    expect(rowFirst.state).toBe('finished')
    expect(countRows(callId)).resolves.toBe(1) // 只一行
  })

  it('3) 同 call_id 仍 started → -32002 CALL_IN_PROGRESS，不执行工具', async () => {
    const callId = randomUUID()
    // 直接造一条 started 行（模拟进程在标 finished 前退出）
    const now = new Date().toISOString()
    await db
      .prepare(`INSERT INTO tool_calls (call_id, repo, task_id, tool_name, phase, state, status, response_text, started_at, finished_at)
                VALUES (?, ?, 'T-LEDGER-NONE', 'harness_status', NULL, 'started', NULL, NULL, ?, NULL)`)
      .run(callId, SLUG, now)

    const res = await postMcp(
      { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'harness_status', arguments: { taskId: 'T-LEDGER-NONE', repo: SLUG } } },
      { 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }
    )
    const body = await readRpc(res)
    expect(body.error?.code).toBe(-32002)
    expect(body.error?.message).toContain('CALL_IN_PROGRESS')
    // 行仍是 started，未被执行改状态
    const row = await getToolCall(db, callId)
    expect(row.state).toBe('started')
  })

  it('4) isError（门禁拒绝）→ status=error', async () => {
    // 全新会话未 harness_start → 调门禁类工具 harness_advance → bootstrap 拒绝，产出 isError:true
    const sid = await initSession()
    const callId = randomUUID()
    const res = await postMcp(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'harness_advance', arguments: { taskId: 'T-X', to: 'execute', repo: SLUG } } },
      { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }
    )
    const body = await readRpc(res)
    expect(body.result?.isError).toBe(true)
    const row = await getToolCall(db, callId)
    expect(row.state).toBe('finished')
    expect(row.status).toBe('error')
    expect(row.response_text).toContain('bootstrap required')
  })

  it('5) activityToolBlock 拒绝 → 也有 finished 行', async () => {
    const sid = await initSession()
    // 先 harness_start 让会话 seenHarness=true（否则先撞 bootstrap）
    const taskId = `act-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId, requirement: '活动门禁', type: 'FIX', author: USER, repo: SLUG })
    await postMcp(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'harness_status', arguments: { taskId, repo: SLUG } } },
      { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG }
    )
    // RECEIVE 活动不允许 awp_test_run → activityToolBlock 拒绝
    const callId = randomUUID()
    const res = await postMcp(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'awp_test_run', arguments: { taskId, repo: SLUG } } },
      { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }
    )
    const body = await readRpc(res)
    expect(body.result?.isError).toBe(true)
    const text = body.result?.content?.[0]?.text || ''
    expect(text).toContain('TOOL_NOT_IN_ACTIVITY')
    const row = await getToolCall(db, callId)
    expect(row.state).toBe('finished')
    expect(row.status).toBe('error')
  })
})

describe('G2 正文截获降级（extractToolResult）', () => {
  it('SSE 多帧：命中 id 的 data 行解析出 isError 与正文', () => {
    const sse = [
      'event: message',
      `data: {"jsonrpc":"2.0","id":42,"result":{"content":[{"type":"text","text":"part1"}],"isError":false}}`,
      '',
      'event: message',
      `data: {"jsonrpc":"2.0","id":43,"result":{"content":[{"type":"text","text":"other-id"}]}}`,
      '',
    ].join('\n')
    const r = extractToolResult(sse, 42)
    expect(r.found).toBe(true)
    expect(r.isError).toBe(false)
    expect(r.text).toBe('part1')
  })

  it('单条 JSON：isError:true → found 且 error', () => {
    const json = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'boom' }], isError: true } })
    const r = extractToolResult(json, 7)
    expect(r.found).toBe(true)
    expect(r.isError).toBe(true)
    expect(r.text).toBe('boom')
  })

  it('截不到正文：空/无匹配 id → found=false（写工具据此留 started）', () => {
    expect(extractToolResult('', 1).found).toBe(false)
    expect(extractToolResult('data: {"jsonrpc":"2.0","id":99,"result":{"content":[]}}', 1).found).toBe(false)
  })
})

describe('链路归因落库（served_by_link / failover_from）', () => {
  it('1) 带网关归因头的 tools/call → 行带 served_by_link / failover_from', async () => {
    const sid = await initSession()
    const taskId = `attr-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId, requirement: '归因首执', type: 'FIX', author: USER, repo: SLUG })
    const callId = randomUUID()
    const res = await postMcp(
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'harness_status', arguments: { taskId, repo: SLUG } } },
      {
        'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId,
        'x-awp-served-by': 'backup', 'x-awp-failover-from': 'primary',
      }
    )
    const body = await readRpc(res)
    expect(body.result?.isError).toBeFalsy()
    const row = await getToolCall(db, callId)
    expect(row.state).toBe('finished')
    expect(row.served_by_link).toBe('backup')
    expect(row.failover_from).toBe('primary')
  })

  it('2) 同 call_id 回放带不同归因头 → 行保持首次归因（DO NOTHING 语义不破坏）', async () => {
    const sid = await initSession()
    const taskId = `attr-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId, requirement: '归因回放', type: 'FIX', author: USER, repo: SLUG })
    const callId = randomUUID()
    const advanceBody = { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'harness_advance', arguments: { taskId, to: 'execute', repo: SLUG } } }
    await readRpc(await postMcp(advanceBody, {
      'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId,
      'x-awp-served-by': 'primary',
    }))
    // 同 call_id 重放：换了链路（不同归因头），也绝不能改写首次归因
    await readRpc(await postMcp(advanceBody, {
      'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId,
      'x-awp-served-by': 'backup', 'x-awp-failover-from': 'primary',
    }))
    const row = await getToolCall(db, callId)
    expect(row.served_by_link).toBe('primary')
    expect(row.failover_from).toBeNull()
  })

  it('3) markFinished 只补空归因（COALESCE），不覆盖既有值', async () => {
    const callId = `coalesce-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    await db
      .prepare(`INSERT INTO tool_calls (call_id, repo, task_id, tool_name, state, status, response_text, started_at, finished_at, served_by_link)
                VALUES (?, ?, 'T-ATTR', 'harness_status', 'started', NULL, NULL, ?, NULL, 'primary')`)
      .run(callId, SLUG, now)
    await markFinished(db, { callId, status: 'ok', responseText: 'x', servedByLink: 'backup' })
    let row = await getToolCall(db, callId)
    expect(row.state).toBe('finished')
    expect(row.served_by_link).toBe('primary') // 已有归因不被覆盖
    // 无归因的行 → 补空
    const callId2 = `coalesce-${randomUUID().slice(0, 8)}`
    await db
      .prepare(`INSERT INTO tool_calls (call_id, repo, task_id, tool_name, state, status, response_text, started_at, finished_at)
                VALUES (?, ?, 'T-ATTR', 'harness_status', 'started', NULL, NULL, ?, NULL)`)
      .run(callId2, SLUG, now)
    await markFinished(db, { callId: callId2, status: 'ok', responseText: 'x', servedByLink: 'backup' })
    row = await getToolCall(db, callId2)
    expect(row.served_by_link).toBe('backup')
  })

  it('4) 无网关头时降级 AWP_LINK_LABEL 环境变量', async () => {
    const sid = await initSession()
    const taskId = `attr-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId, requirement: '归因降级', type: 'FIX', author: USER, repo: SLUG })
    const callId = randomUUID()
    const prev = process.env.AWP_LINK_LABEL
    process.env.AWP_LINK_LABEL = 'standalone-link'
    try {
      const res = await postMcp(
        { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'harness_status', arguments: { taskId, repo: SLUG } } },
        { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId }
      )
      const body = await readRpc(res)
      expect(body.result?.isError).toBeFalsy()
      const row = await getToolCall(db, callId)
      expect(row.served_by_link).toBe('standalone-link')
      expect(row.failover_from).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.AWP_LINK_LABEL
      else process.env.AWP_LINK_LABEL = prev
    }
  })

  it('5) /api/harness/status 合并 linkFork（端到端：归因行 → 分叉读模型 → 响应字段）', async () => {
    const sid = await initSession()
    const taskId = `attr-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId, requirement: '归因status合并', type: 'FIX', author: USER, repo: SLUG })
    // 会话预热：经 MCP 调一次入口工具置 seenHarness，避免 advance 撞 bootstrap 拒绝
    await postMcp(
      { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'harness_status', arguments: { taskId, repo: SLUG } } },
      { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG }
    )
    const callId = randomUUID()
    const advance = await readRpc(await postMcp(
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'harness_advance', arguments: { taskId, to: 'execute', repo: SLUG } } },
      {
        'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG, 'x-awp-call-id': callId,
        'x-awp-served-by': 'backup', 'x-awp-failover-from': 'primary',
      }
    ))
    expect(advance.result?.isError).toBeFalsy()
    const res = await fetch(`${base}/api/harness/status?taskId=${encodeURIComponent(taskId)}&repo=${encodeURIComponent(SLUG)}`, { headers: { 'x-awp-username': USER } })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.linkFork).not.toBeNull()
    expect(data.linkFork.forkCallId).toBe(callId)
    expect(typeof data.linkFork.primaryLabel).toBe('string')
    expect(data.linkFork.primaryLabel.length).toBeGreaterThan(0)
    expect(typeof data.linkFork.backupLabel).toBe('string')
    expect(data.linkFork.backupLabel.length).toBeGreaterThan(0)
    expect(data.linkFork.forkAt).toBeTruthy()
    // 对照：无切换的任务 → linkFork 为 null
    const taskId2 = `attr-${randomUUID().slice(0, 8)}`
    await harnessStart({ taskId: taskId2, requirement: '归因status对照', type: 'FIX', author: USER, repo: SLUG })
    const res2 = await fetch(`${base}/api/harness/status?taskId=${encodeURIComponent(taskId2)}&repo=${encodeURIComponent(SLUG)}`, { headers: { 'x-awp-username': USER } })
    const data2 = await res2.json()
    expect(data2.ok).toBe(true)
    expect(data2.linkFork).toBeNull()
  })
})
