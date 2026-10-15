/**
 * gateway/server.js — 链路网关方案 §7 总入口进程（只在 Windows 主机器启动，听 8787）。
 *
 * 只依赖 express + node 内置；禁止 import db.js/server.js/harness/testing/tools/dashboard/db-link-schema/links.sql；
 * 不连接数据库，不持有 AWP_PG_URL。路由从控制面 /api/links/runtime 拉取并写本地快照（见 store.js）。
 * buildGatewayApp(deps) 为可注入依赖的工厂（测试用，零副作用）；start() 才启定时器与监听。
 */
import express from 'express'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRouteStore } from './store.js'
import { createHealthMonitor } from './health.js'
import { createSessionStore } from './session.js'
import { chooseCandidates, prioritizeBoundLink, attemptOnce, pipeResponseToClient, FailoverError } from './route.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// 转发的请求头白名单（§15）：不含客户端 mcp-session-id；idempotency-key 供 /v1/blobs:prepare 等幂等路由使用（备用机远程 blob 上传经网关时不被剥离）
const FORWARD_HEADERS = ['content-type', 'accept', 'authorization', 'x-awp-username', 'x-awp-repo', 'last-event-id', 'idempotency-key']

function safeJson(buf) {
  try {
    if (!buf || !buf.length) return null
    return JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf))
  } catch {
    return null
  }
}

function readRepoFrom(req, sessionStore) {
  const q = req.query?.repo || req.headers['x-awp-repo'] || null
  if (q) return String(q).toLowerCase()
  const extId = req.headers['mcp-session-id']
  const s = extId && sessionStore ? sessionStore.get(extId) : null
  return s?.repo || null
}

function buildForwardHeaders(req, callId, internalSessionId) {
  const h = {}
  for (const name of FORWARD_HEADERS) {
    const v = req.headers[name.toLowerCase()]
    if (v != null) h[name] = Array.isArray(v) ? v[0] : v
  }
  // Accept 补全（§7.3：缺 text/event-stream 或 application/json 时补上）
  if (req.path === '/mcp' || req.path === '/message') {
    let acc = String(h['accept'] || '')
    if (!acc.includes('text/event-stream')) acc = acc ? `${acc}, text/event-stream` : 'application/json, text/event-stream'
    if (!acc.includes('application/json') && !acc.includes('*/*')) acc = `${acc}, application/json`
    h['accept'] = acc
  }
  if (callId) h['x-awp-call-id'] = callId
  if (internalSessionId) h['mcp-session-id'] = internalSessionId
  return h
}

function extractInternalSessionId(response) {
  let sid = response.headers.get('mcp-session-id') || response.headers.get('Mcp-Session-Id') || null
  if (!sid) {
    // 大小写都认：forEach 兜底
    response.headers.forEach((v, k) => { if (k.toLowerCase() === 'mcp-session-id') sid = v })
  }
  return sid
}

function makeTransportLogger(logFile) {
  if (!logFile) return () => {}
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }) } catch { /* ignore */ }
  return (entry) => {
    const line = `${entry.at}\t${entry.method}\t${entry.path}\trepo=${entry.repo || '-'}\tcall=${entry.callId || '-'}\ttried=${(entry.tried || []).join(',')} \tfinal=${entry.finalLinkId || '-'}\tms=${entry.ms}\t${entry.result}\n`
    fs.appendFile(logFile, line, () => {})
  }
}

export function buildGatewayApp(deps = {}) {
  const {
    store = createRouteStore(),
    health = createHealthMonitor(),
    sessions = createSessionStore(),
    fetchImpl = globalThis.fetch,
    connectTimeoutMs = 2000,
    headerTimeoutMs = 15000,
    logFile = null,
  } = deps

  const log = makeTransportLogger(logFile)
  const app = express()
  app.use(express.raw({ type: () => true, limit: '50mb' }))

  // CORS + Accept 补全 + OPTIONS 204（§7.3）
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, x-awp-username, x-awp-repo, x-awp-call-id, Accept, Last-Event-ID')
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, mcp-session-id')
    if (req.method === 'OPTIONS') { res.status(204).end(); return }
    next()
  })

  // GET /api/mcp/ping —— 网关自答（不做业务表计数）
  app.get('/api/mcp/ping', (req, res) => {
    const links = store.listLinks().map((l) => ({
      link_id: l.linkId,
      base_url: l.baseUrl,
      circuit_open: health.isCircuitOpen(l.linkId),
    }))
    res.json({ ok: true, streamable: '/mcp', sse: '/sse', message: '/message', health: '/api/health', activeSessions: sessions.size(), links })
  })

  /** 通用转发：给定候选，按 §7.4 尝试（仅头到达前失败才换链）。返回 { ok, linkId }。 */
  async function forward(req, res, { repo, replayBody }) {
    const startedAt = Date.now()
    const method = req.method
    const callId = (req.headers['x-awp-call-id'] || (method === 'POST' ? crypto.randomUUID() : null))
    const extId = req.headers['mcp-session-id']
    const session = extId ? sessions.get(extId) : null
    const body = replayBody != null ? replayBody : (Buffer.isBuffer(req.body) && req.body.length ? req.body : null)
    const parsed = safeJson(body)
    const isInitialize = parsed && parsed.method === 'initialize'

    let { candidates } = chooseCandidates({ store, health, repo })
    // 会话已绑链路且仍在候选列表 → 放最前（§7.4.3）
    // P2-1：默认保持会话粘性（钉在已绑定链路，保证 MCP 会话连续性）。设 AWP_GW_STICKY_REBALANCE_MS>0 后，
    // 会话绑定超过该时长即不再强钉 → 回归按首选/主链路选序（主恢复后新请求自动回切；旧链路会话经重握手续用）。
    const rebalanceMs = Number(process.env.AWP_GW_STICKY_REBALANCE_MS || 0)
    const boundAt = session && session.boundAt != null ? session.boundAt : (session && session.lastSeen) || 0
    const boundAge = Date.now() - Number(boundAt)
    if (session && session.linkId && (!rebalanceMs || boundAge <= rebalanceMs)) {
      candidates = prioritizeBoundLink(candidates, session.linkId)
    }
    if (!candidates.length) {
      res.status(503).json({ error: 'NO_HEALTHY_LINK', detail: '无可用链路' })
      log({ at: new Date().toISOString(), method, path: req.path, repo, callId, tried: [], finalLinkId: null, ms: Date.now() - startedAt, result: 'fail' })
      return { ok: false }
    }

    const tried = []
    for (const link of candidates) {
      tried.push(link.linkId)
      // 换到未握手的链路且已存有 initialize 正文 → 先重握手拿内部会话号（§7.4.5 / §15）
      let internalSid = session && session.linkId === link.linkId ? session.internalId : null
      const savedInit = replayBody == null && session ? session.initializeBody : null
      if (!internalSid && savedInit && !isInitialize) {
        const hs = await handshake(link, savedInit, fetchImpl, { connectTimeoutMs, headerTimeoutMs })
        if (hs) internalSid = hs
      }
      // 允许一次「同链路重握手」以处理 -32001（§7.4.8 / §15）；重握手失败或第二次仍 -32001 → 换下一条
      let rehandled = false
      for (;;) {
        const headers = buildForwardHeaders(req, callId, internalSid)
        // 链路归因标注：告知控制面由哪条链路应答；发生换链时附带此前失败的链路列表（UI 链路分叉数据源）
        headers['x-awp-served-by'] = link.linkId
        if (tried.length > 1) headers['x-awp-failover-from'] = tried.slice(0, -1).join(',')
        let response
        try {
          ;({ response } = await attemptOnce(link, { method, pathWithQuery: req.originalUrl, headers, body }, { fetchImpl, connectTimeoutMs, headerTimeoutMs }))
        } catch (err) {
          if (err instanceof FailoverError) break // 头到达前失败 → 下一条链路
          break
        }

        const newInternal = extractInternalSessionId(response)
        // 绑定/刷新对外会话
        if (isInitialize && newInternal) {
          const created = sessions.create({ linkId: link.linkId, internalId: newInternal })
          const cs = sessions.get(created)
          if (cs) cs.repo = repo || null
          sessions.setInitializeBody(created, body ? safeJson(body) : null)
          res.setHeader('mcp-session-id', created)
        } else if (extId && newInternal) {
          sessions.bind(extId, { linkId: link.linkId, internalId: newInternal })
          res.setHeader('mcp-session-id', extId)
        } else if (extId) {
          res.setHeader('mcp-session-id', extId)
        }

        const ctype = String(response.headers.get('content-type') || '').toLowerCase()
        // 仅对 application/json（且尚未向客户端写出响应头）缓冲判定 -32001；SSE/长任务流式转发不换链路
        if (!isInitialize && ctype.includes('application/json') && !res.headersSent) {
          const text = await response.text().catch(() => '')
          let errCode = null
          try { errCode = JSON.parse(text)?.error?.code } catch { /* 非 JSON-RPC 错误体 */ }
          if (errCode === -32001 && savedInit && !rehandled) {
            const hs = await handshake(link, savedInit, fetchImpl, { connectTimeoutMs, headerTimeoutMs })
            if (hs) { internalSid = hs; rehandled = true; continue }
            break // 重握手拿不到会话号 → 换下一条
          }
          if (errCode === -32001 && rehandled) break // 同链路第二次仍 -32001 → 换下一条
          // 正常/其他结果：把缓冲的 JSON 正文原样转发（响应头尚未发出）
          res.status(response.status)
          response.headers.forEach((v, k) => {
            const kk = k.toLowerCase()
            if (kk === 'connection' || kk === 'transfer-encoding' || kk === 'content-length' || kk === 'content-encoding' || kk === 'mcp-session-id') return
            try { res.setHeader(k, v) } catch { /* ignore */ }
          })
          res.end(Buffer.from(text))
          log({ at: new Date().toISOString(), method, path: req.path, repo, callId, tried, finalLinkId: link.linkId, ms: Date.now() - startedAt, result: 'ok' })
          return { ok: true, linkId: link.linkId }
        }

        // 其余：原样流式转发（含 initialize、SSE、以及无 savedInit 的 -32001），此后不再换链路
        pipeResponseToClient(res, response)
        log({ at: new Date().toISOString(), method, path: req.path, repo, callId, tried, finalLinkId: link.linkId, ms: Date.now() - startedAt, result: 'ok' })
        return { ok: true, linkId: link.linkId }
      }
      // 内层 break → 尝试下一条链路
    }
    // 全失败且零响应头 → 502（§7.4 / §1 锁定）
    if (!res.headersSent) res.status(502).json({ error: 'BAD_GATEWAY', detail: '所有链路在响应头到达前均不可用' })
    log({ at: new Date().toISOString(), method, path: req.path, repo, callId, tried, finalLinkId: null, ms: Date.now() - startedAt, result: 'fail' })
    return { ok: false }
  }

  // /mcp POST/GET/DELETE、/sse GET、/message POST → 选路转发（§7.3）
  app.post('/mcp', async (req, res) => { await forward(req, res, { repo: readRepoFrom(req, sessions) }) })
  app.get('/mcp', async (req, res) => { await forward(req, res, { repo: readRepoFrom(req, sessions) }) })
  app.delete('/mcp', async (req, res) => { await forward(req, res, { repo: readRepoFrom(req, sessions) }) })
  app.get('/sse', async (req, res) => { await forward(req, res, { repo: readRepoFrom(req, sessions) }) })
  app.post('/message', async (req, res) => { await forward(req, res, { repo: readRepoFrom(req, sessions) }) })

  // POST /api/deploy → 只转发主链路（§7.3）
  app.post('/api/deploy', async (req, res) => {
    const primary = store.primaryLink()
    if (!primary) { res.status(503).json({ error: 'NO_PRIMARY_LINK' }); return }
    await forward(req, res, { repo: null, replayBody: Buffer.isBuffer(req.body) && req.body.length ? req.body : null })
  })

  // 其余 /api、/、/dashboard.html、静态 → 最健康列表序号最小的一条（不按项目分流，§7.3）
  const genericForward = async (req, res) => { await forward(req, res, { repo: null }) }
  app.get('/', genericForward)
  app.get('/dashboard.html', genericForward)
  app.use('/api', genericForward)
  app.use(genericForward)

  return { app, store, health, sessions }
}

/** 换链路时向新控制面重握手：原样转发已保存的 initialize 正文，拿内部会话号。失败返回 null。 */
async function handshake(link, initializeBody, fetchImpl, timeouts) {
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    const { response } = await attemptOnce(link, { method: 'POST', pathWithQuery: '/mcp', headers, body: Buffer.from(JSON.stringify(initializeBody)) }, { fetchImpl, ...timeouts })
    const sid = extractInternalSessionId(response)
    // 丢弃 initialize 响应体
    try { await response.text() } catch { /* ignore */ }
    if (!sid) return null
    // 补发 notifications/initialized（无 id）到新内部会话
    const nh = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }
    try {
      const nAttempt = await attemptOnce(link, { method: 'POST', pathWithQuery: '/mcp', headers: nh, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })) }, { fetchImpl, ...timeouts })
      try { await nAttempt.response?.text?.() } catch { /* 排空即可 */ }
    } catch { /* 通知失败不阻断 */ }
    return sid
  } catch {
    return null
  }
}

// ─── start：仅生产启动调用（定时器 + 监听）；测试走 buildGatewayApp 不进这里 ───
export async function start() {
  const dataDir = path.join(ROOT, 'data')
  const routesFile = path.join(dataDir, 'gateway-routes.json')
  const logFile = path.join(dataDir, 'logs', 'gateway.log')

  const store = createRouteStore({ routesFile })
  const health = createHealthMonitor()
  const sessions = createSessionStore()
  const { app } = buildGatewayApp({
    store, health, sessions, logFile,
    // P1-B：重接口首字节预算放宽（默认 60s，可 AWP_GW_HEADER_TIMEOUT_MS 覆盖），
    // 健康的慢响应不再被误 failover；死主机仍靠拒绝连接快速失败 + 5s×3 探活熔断剔除。
    connectTimeoutMs: Number(process.env.AWP_GW_CONNECT_TIMEOUT_MS) || 2000,
    headerTimeoutMs: Number(process.env.AWP_GW_HEADER_TIMEOUT_MS) || 60000,
  })

  // 每 5s：拉路由 + 探活熔断
  setInterval(() => { store.refresh().catch(() => {}) }, 5000).unref()
  setInterval(() => { health.probeAll(store.listLinks()).catch(() => {}) }, 5000).unref()
  // 每 5min：清对外会话（30min 无请求）
  setInterval(() => { sessions.prune() }, 5 * 60 * 1000).unref()
  // 启动即拉一次
  store.refresh().catch(() => {})
  health.probeAll(store.listLinks()).catch(() => {})

  const PORT = Number(process.env.PORT) || 8787
  app.listen(PORT, () => {
    console.log(`[awp-gateway] listening on http://0.0.0.0:${PORT}`)
    console.log(`[awp-gateway] 路由快照: ${routesFile}`)
  })
}

const entryIsSelf = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const launchedByPm2 = process.env.pm_id != null && process.env.pm_exec_path != null
if (entryIsSelf || launchedByPm2) {
  await start()
}
