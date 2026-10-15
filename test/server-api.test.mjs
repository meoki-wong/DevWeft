/**
 * server-api.test.mjs — 控制面 HTTP/MCP 层测试（阶段 2 / T2.2）
 *
 * 用 buildApp()（零副作用工厂）+ 真实 HTTP 调用，覆盖此前零测试的核心接入面：
 *  1. MCP initialize → session 建立、bootstrap instructions 注入；
 *  2. **MCP 硬门禁**：未 harness_start 直接调门禁类工具 → isError + 引导文案（平台最核心的拦截）；
 *  3. MCP 全链：harness_start → harness_status（RECEIVE），连接级 username 注入 author；
 *  4. 连接级 repo：非法 ?repo= 直接 400（防串仓）；合法 repo 自动注入工具参数；
 *  5. /api/health、/api/rules-version 就绪形状。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server.js'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'

const SLUG = `api-${Date.now().toString(36)}`
const USER = 'api-tester'
let app = null
let server = null
let base = null

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
  } catch { /* ignore */ }
})

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
}

async function postMcp(path, body, extraHeaders = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

async function readRpc(res) {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
    return JSON.parse(dataLine.slice(5).trim())
  }
  return res.json()
}

/** 建一个已 initialize 的 MCP 会话，返回 sessionId */
async function initSession() {
  const res = await postMcp('/mcp', {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'vitest-api', version: '1.0.0' } },
  })
  expect(res.status).toBe(200)
  const body = await readRpc(res)
  expect(body.result?.serverInfo?.name).toBeTruthy()
  // bootstrap instructions：工作流铁律必须注入（AI 的第一阶段上下文）
  const instructions = body.result?.instructions || ''
  expect(instructions.length).toBeGreaterThan(0)
  const sid = res.headers.get('mcp-session-id')
  expect(sid).toBeTruthy()
  // notifications/initialized（通知，无需响应体）
  await postMcp('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': sid })
  return sid
}

describe('MCP 接入面', () => {
  it('硬门禁：未 harness_start 调 harness_advance → isError + 引导文案', async () => {
    const sid = await initSession()
    const res = await postMcp('/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'harness_advance', arguments: { taskId: 'T-NOPE', to: 'execute' } },
    }, { 'mcp-session-id': sid })
    expect(res.status).toBe(200)
    const body = await readRpc(res)
    // 关键断言：isError + 引导文案（而不是让 advance 落到业务层）
    expect(body.result?.isError).toBe(true)
    const text = body.result?.content?.[0]?.text || ''
    expect(text).toContain('bootstrap required')
    expect(text).toContain('harness_start')
  })

  it('全链：harness_start → status(RECEIVE)，连接 username 注入 author', async () => {
    const sid = await initSession()
    const startRes = await postMcp('/mcp', {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'harness_start', arguments: { requirement: `接口测试任务 ${randomUUID().slice(0, 8)}`, type: 'FIX' } },
    }, { 'mcp-session-id': sid, 'x-awp-username': USER, 'x-awp-repo': SLUG })
    const startBody = await readRpc(startRes)
    expect(startBody.result?.isError).toBeUndefined()
    const startText = startBody.result?.content?.[0]?.text || ''
    const startData = JSON.parse(startText)
    expect(startData.ok).toBe(true)
    const taskId = startData.taskId
    expect(taskId).toBeTruthy()

    // author 被连接身份覆盖（AI 自报的占位作者不落库）
    const taskRow = await db.prepare('SELECT author, repo FROM tasks WHERE task_id=?').get(taskId)
    expect(taskRow.author).toBe(USER)
    expect(taskRow.repo).toBe(SLUG)

    // status → RECEIVE
    const statusRes = await postMcp('/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'harness_status', arguments: { taskId } },
    }, { 'mcp-session-id': sid })
    const statusBody = await readRpc(statusRes)
    const statusData = JSON.parse(statusBody.result?.content?.[0]?.text || '{}')
    expect(statusData.phase).toBe('receive')
  })

  it('tools/list 含 harness 工具（防 IDE 搜不到工具降级）', async () => {
    const sid = await initSession()
    const res = await postMcp('/mcp', {
      jsonrpc: '2.0', id: 5, method: 'tools/list',
    }, { 'mcp-session-id': sid })
    const body = await readRpc(res)
    const names = (body.result?.tools || []).map((t) => t.name)
    expect(names).toContain('harness_start')
    expect(names).toContain('harness_advance')
    expect(names).toContain('awp_test_run')
  })
})

describe('连接级参数与就绪端点', () => {
  it('非法 ?repo= → 400（防任务串仓）', async () => {
    const res = await postMcp('/mcp?repo=Bad_Slug_大写', {
      jsonrpc: '2.0', id: 6, method: 'tools/list',
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('非法 repo')
  })

  it('/api/health 与 /api/rules-version 就绪', async () => {
    const health = await fetch(`${base}/api/health`)
    expect(health.status).toBe(200)
    const hb = await health.json()
    expect(hb.ok).toBe(true)
    expect(hb.version).toBeTruthy()

    const rules = await fetch(`${base}/api/rules-version`)
    expect(rules.status).toBe(200)
    const rb = await rules.json()
    expect(rb.version).toBeTruthy()
  })
})
