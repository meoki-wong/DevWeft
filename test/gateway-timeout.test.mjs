/**
 * gateway-timeout.test.mjs — P1-B：慢而健康的响应不得被误 failover
 *
 * 旧实现：connectTimer 固定倒计时（示例 500ms），连接已建立、仅服务端 3.5s 才回首字节时会被误 abort → 换链路。
 * 修复后：连接阶段只靠拒绝连接快速失败；慢首字节由 headerTimer（此处 60s）判定 → 仍由 primary 应答。
 */
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
import { buildGatewayApp } from '../gateway/server.js'
import { createHealthMonitor } from '../gateway/health.js'
import { createSessionStore } from '../gateway/session.js'

const cleanups = []
afterEach(async () => { while (cleanups.length) { const fn = cleanups.pop(); try { await fn() } catch { /* ignore */ } } })

async function startSlowUpstream(delayMs, tag, requests) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({ tag, body })
      // 连接已建立，故意延迟回首字节
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] }, upstream: tag }))
      }, delayMs)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => new Promise((r) => server.close(r)))
  return `http://127.0.0.1:${server.address().port}`
}
async function deadPort() {
  const srv = http.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  const port = srv.address().port; await new Promise((r) => srv.close(r)); return `http://127.0.0.1:${port}`
}
function mkStore(links) {
  return { listLinks: () => links, primaryLink: () => links.find((l) => Number(l.isPrimary) === 1) || links[0] || null, getLink: (id) => links.find((l) => l.linkId === id) || null, getProjectLink: () => null }
}

describe('gateway P1-B 慢响应不误 failover', () => {
  it('connectTimer(500) 旧杀手移除：primary 3.5s 回首字节仍由 primary 应答', async () => {
    const primaryReq = []
    const backupReq = []
    const primary = await startSlowUpstream(3500, 'primary', primaryReq)
    const backup = await deadPort() // 备用不可用：若误 failover 会 502，从而反证未误换链
    const store = mkStore([
      { linkId: 'primary', baseUrl: primary, isPrimary: 1, sortOrder: 0 },
      { linkId: 'backup', baseUrl: backup, isPrimary: 0, sortOrder: 1 },
    ])
    const { app } = buildGatewayApp({ store, health: createHealthMonitor(), sessions: createSessionStore(), connectTimeoutMs: 500, headerTimeoutMs: 60000 })
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
    cleanups.push(() => new Promise((r) => server.close(r)))
    const base = `http://127.0.0.1:${server.address().port}`
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'noop', arguments: {} } }) })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.upstream).toBe('primary')
    expect(primaryReq.length).toBe(1)
  })
})
