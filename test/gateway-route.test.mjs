/**
 * gateway-route.test.mjs — 链路网关方案 §7.4 完成标准
 *
 * 用两个本地假上游（node http），不连生产库。断言：
 *  1. 首选拒绝连接 → 落到第二条，客户端只收到一条成功响应。
 *  2. 首选返回 isError:true → 第二条收到 0 次请求。
 *  3. 首选返回 HTTP 502 且带响应头 → 第二条收到 0 次请求。
 *  4. 两条都拒绝连接 → 客户端收到 502（网关自造 BAD_GATEWAY）。
 *  5. 同一 call_id 在两次转发里相同。
 *  6. project_links 为空时打到 is_primary。
 *  7. 熔断中的链路收到 0 次请求。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import { buildGatewayApp } from '../gateway/server.js'
import { createHealthMonitor } from '../gateway/health.js'
import { createSessionStore } from '../gateway/session.js'

const cleanups = []
const JH = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()
    try { await fn() } catch { /* ignore */ }
  }
})

/** 起一个假上游；mode: ok | isError | 502 | hang（挂起不回响应头）。返回 baseUrl + 收到的请求记录。 */
async function startUpstream(mode, tag) {
  const requests = []
  let toolCalls = 0
  let sessSeq = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({
        callId: req.headers['x-awp-call-id'] || null,
        servedBy: req.headers['x-awp-served-by'] || null,
        failoverFrom: req.headers['x-awp-failover-from'] || null,
        path: req.url,
        body,
      })
      if (mode === 'hang') return // 故意不发送响应头，触发网关响应头超时
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* ignore */ }
      if (mode === 'session-lost') {
        if (parsed?.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'p-' + (++sessSeq) })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' }, instructions: '' } }))
        }
        if (parsed?.method === 'notifications/initialized') { res.writeHead(202); return res.end() }
        toolCalls++
        if (toolCalls === 1) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id ?? null, error: { code: -32001, message: 'session 已失效' } }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed?.id ?? null, result: { content: [{ type: 'text', text: `ok-after-rehandshake@${tag}` }] } }))
      }
      if (mode === '502') {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ upstream: tag, httpStatus: 502 }))
        return
      }
      if (mode === 'isError') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `tool-error@${tag}` }], isError: true } }))
        return
      }
      // ok
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: `ok@${tag}` }], isError: false }, upstream: tag }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  cleanups.push(() => new Promise((r) => server.close(r)))
  return { baseUrl: `http://127.0.0.1:${port}`, port, requests }
}

/** 取一个当前不可连接的端口（先占后放），用于「拒绝连接」。 */
async function deadPort() {
  const srv = http.createServer()
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return `http://127.0.0.1:${port}`
}

function mkStore(links, projects = []) {
  return {
    listLinks: () => links,
    primaryLink: () => links.find((l) => Number(l.isPrimary) === 1) || links[0] || null,
    getLink: (id) => links.find((l) => l.linkId === id) || null,
    getProjectLink: (repo) => {
      if (!repo) return null
      const row = projects.find((p) => p.repo === String(repo).toLowerCase())
      return row?.linkId || null
    },
  }
}

async function startGateway({ store, health }) {
  const app = buildGatewayApp({ store, health, sessions: createSessionStore(), headerTimeoutMs: 500, connectTimeoutMs: 500 })
  const server = app.app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  cleanups.push(() => new Promise((r) => server.close(r)))
  return base
}

function postMcp(base, { repo, callId } = {}) {
  const q = repo ? `?repo=${repo}` : ''
  return fetch(`${base}/mcp${q}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(callId ? { 'x-awp-call-id': callId } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'noop', arguments: {} } }),
  })
}

describe('gateway 选路与重放（§7.4）', () => {
  it('1) 首选拒绝连接 → 落到第二条，客户端只收到一条成功响应', async () => {
    const backup = await startUpstream('ok', 'backup')
    const primaryUrl = await deadPort()
    const store = mkStore([
      { linkId: 'primary', baseUrl: primaryUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.upstream).toBe('backup')
    expect(backup.requests.length).toBe(1)
  })

  it('2) 首选返回 isError:true → 第二条收到 0 次请求', async () => {
    const primary = await startUpstream('isError', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.result.isError).toBe(true) // 原样交回，不换链路
    expect(backup.requests.length).toBe(0)
  })

  it('3) 首选返回 HTTP 502 且带响应头 → 第二条收到 0 次请求', async () => {
    const primary = await startUpstream('502', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    expect(res.status).toBe(502) // 上游的 502 原样转发
    expect(await res.json()).toMatchObject({ upstream: 'primary' })
    expect(backup.requests.length).toBe(0)
  })

  it('4) 两条都拒绝连接 → 客户端收到 502（网关 BAD_GATEWAY）', async () => {
    const u1 = await deadPort()
    const u2 = await deadPort()
    const store = mkStore([
      { linkId: 'primary', baseUrl: u1, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: u2, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    expect(res.status).toBe(502)
    const json = await res.json()
    expect(json.error).toBe('BAD_GATEWAY')
  })

  it('5) 同一 call_id 在两次转发里相同（首选挂起→响应头超时→换第二条）', async () => {
    const primary = await startUpstream('hang', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const callId = 'fixed-call-123'
    const res = await postMcp(base, { callId })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ upstream: 'backup' })
    expect(primary.requests.length).toBe(1)
    expect(backup.requests.length).toBe(1)
    expect(primary.requests[0].callId).toBe(callId)
    expect(backup.requests[0].callId).toBe(callId)
  })

  it('6) project_links 为空时打到 is_primary', async () => {
    const primary = await startUpstream('ok', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore(
      [
        { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
        { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
      ],
      [] // 无项目首选
    )
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base, { repo: 'some-repo' })
    expect(await res.json()).toMatchObject({ upstream: 'primary' })
    expect(backup.requests.length).toBe(0)
  })

  it('7) 熔断中的链路收到 0 次请求', async () => {
    const primary = await startUpstream('ok', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const health = createHealthMonitor()
    health.forceOpen('primary') // 主链路熔断
    const base = await startGateway({ store, health })
    const res = await postMcp(base)
    expect(await res.json()).toMatchObject({ upstream: 'backup' })
    expect(primary.requests.length).toBe(0) // 熔断链路 0 请求
  })

  it('8) -32001 → 同链路重握手一次后重放成功，备用链路收到 0 请求', async () => {
    const primary = await startUpstream('session-lost', 'primary')
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    // 建立对外会话
    const initRes = await fetch(`${base}/mcp`, { method: 'POST', headers: JH, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })
    const extSid = initRes.headers.get('mcp-session-id')
    expect(extSid).toBeTruthy()
    await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JH, 'mcp-session-id': extSid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    // tools/call → 主链路首次回 -32001，网关同链路重握手后重放成功
    const callRes = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...JH, 'mcp-session-id': extSid, 'x-awp-call-id': 'cid-32001' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'noop', arguments: {} } }) })
    const json = await callRes.json()
    expect(String(json.result?.content?.[0]?.text || '')).toContain('ok-after-rehandshake')
    expect(backup.requests.length).toBe(0) // 同链路恢复，未换链路
    expect(toolCallCount(primary)).toBe(2) // tools/call 被发了两次（首次 -32001 + 重放）
  })

  it('9) 转发标注 x-awp-served-by；未换链时不带 failover-from', async () => {
    const primary = await startUpstream('ok', 'primary')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary.baseUrl, isPrimary: 1, sortOrder: 0 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    expect(res.status).toBe(200)
    expect(primary.requests.length).toBe(1)
    expect(primary.requests[0].servedBy).toBe('primary')
    expect(primary.requests[0].failoverFrom).toBeNull()
  })

  it('10) 换链时附 x-awp-failover-from（此前失败链路列表）', async () => {
    const primaryUrl = await deadPort()
    const backup = await startUpstream('ok', 'backup')
    const store = mkStore([
      { linkId: 'primary', baseUrl: primaryUrl, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup.baseUrl, isPrimary: 0, sortOrder: 1 },
    ])
    const base = await startGateway({ store, health: createHealthMonitor() })
    const res = await postMcp(base)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ upstream: 'backup' })
    expect(backup.requests.length).toBe(1)
    expect(backup.requests[0].servedBy).toBe('backup')
    expect(backup.requests[0].failoverFrom).toBe('primary')
  })
})

function toolCallCount(up) {
  return up.requests.filter((r) => r.body && r.body.includes('"tools/call"')).length
}
