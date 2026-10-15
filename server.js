/**
 * server.js — agent-workflow-platform 服务器入口（SQLite + MCP 协议，多租户）
 * 端点：
 *   POST/GET/DELETE /mcp        MCP 协议（IDE 接入）
 *   POST /api/report            verify.sh 验证结果上报
 *   GET  /api/health            健康检查（service setup and monitoring）
 *   GET  /api/rules-version     规范版本（L0 一致性检查用）
 *   POST /api/deploy            自部署：git pull + pm2 restart agent-workflow-platform
 */
import express from 'express'
import crypto from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { registerRecordsTools } from './tools/records.js'
import { registerCollaborationTools } from './tools/collaboration.js'
import { registerKnowledgeTools } from './tools/knowledge.js'
import { registerHarnessTools } from './tools/harness.js'
import { registerTestSpecTools } from './tools/test-specs.js'
import { registerTestRunTools } from './tools/test-run.js'
import { registerLoopTools } from './tools/loop.js'
import { registerSkillTools } from './tools/skills.js'
import { registerLanhuTools } from './tools/lanhu.js'
import { runNightlyRegression } from './testing/nightly.js'
import { harnessStatus, harnessAdvance, sweepStaleTasks } from './harness/state-machine.js'
import { dailySweepUnfinishedTasks, computeNextRunAt } from './harness/stop-task.js'
import { buildBootstrapInstructions } from './harness/bootstrap-instructions.js'
import { phaseToActivity, toolsForActivity } from './harness/activity-plan.js'
import { PHASE_LABELS, SIZE_LABELS, TOOL_LABELS, describeAuditEvent } from './harness/labels.js'
import { AUTHOR_TOOLS, resolveToolAuthor, normalizeRepoSlug } from './harness/author.js'
import { mountAuditRoutes } from './audit/routes.js'
import { mountDashboardApi, flywheelStats } from './dashboard/api.js'
import { mountTestingDashboard } from './dashboard/testing.js'
import { mountHealthRoutes } from './dashboard/health.js'
import {
  recordMcpToolCall,
  recordMcpInit,
  recordHttpEvent,
  recordAuditEvent,
} from './audit/index.js'
import { mountTestingRoutes } from './testing/routes.js'
import { reconcileRuns } from './testing/leases.js'
import { createBackgroundOwner } from './db/background-owner.js'
import { isStandbyControlPlane } from './db/standby.js'
import { startReadinessBootstrap, openDbWithRetry } from './db/ready-bootstrap.mjs'
import { sweepWorkerHeartbeats } from './testing/workers.js'
import { seedSuiteRegistry } from './testing/suite-registry.js'
import { getRepoPlatformProfile } from './testing/repo-platform.js'
import { findPrincipalBySubject } from './testing/auth.js'
import { SYSTEM_SUBJECT } from './testing/migrate.js'
import { resolveTaskRepo } from './harness/tenant-ref.js'
import { enforceHarnessRepoAcl } from './harness/repo-acl.js'
import { runWithTenant } from './db/tenant-context.js'
import {
  getToolCall,
  isWriteTool,
  insertStarted,
  markFinished,
  releaseStarted,
  buildReplayMessage,
  callInProgressMessage,
  finishedWithoutBodyMessage,
  extractToolResult,
  buildLinkFork,
} from './db/tool-calls.js'
import db, { initDB, openDb, nextExpId, nextRepId, DB_DIALECT } from './db.js'
import { CONTRACT_VERSION, SCHEMA_VERSION } from './contracts/version.mjs'
import { SCHEMA_CHECKSUM } from './testing/migrate.js'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT || 8787
// Runner mTLS 证书（模块级读取；配置证书后 header 回退自动关闭）
const runnerTlsCert = process.env.AWP_RUNNER_TLS_CERT || ''
const runnerTlsKey = process.env.AWP_RUNNER_TLS_KEY || ''
const runnerTlsCa = process.env.AWP_RUNNER_TLS_CA || ''
// MCP 会话注册表（/mcp 路由与 session 清扫共用；每次进程一份）
const SESSION_TTL_MS = 30 * 60 * 1000
const sessions = new Map()
// 链路网关方案 §4：/api/health 版本读 package.json，禁止再写死 1.0.0
const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

function destroySession(id) {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try { s.transport?.close?.() } catch { /* ignore */ }
  try { s.server?.close?.() } catch { /* ignore */ }
}

// 初始化数据库
initDB()

// suites/ 目录内容变化（如新增 case）时自动发布新 suite revision 并推进 active channel
//（suite-registry 按内容 sha256 幂等，内容未变零写入）——挪到 start() openDb 之后（postgres 代理）
async function reseedSuiteRegistry() {
  try {
    const system = await findPrincipalBySubject(db, SYSTEM_SUBJECT)
    if (!system) return
    const repos = await db.prepare('SELECT repo_id, slug FROM repositories').all()
    for (const repo of repos) {
      const profile = getRepoPlatformProfile(repo.slug)
      if (profile?.suiteSlug) {
        await seedSuiteRegistry(db, { repoId: repo.repo_id, suiteSlug: profile.suiteSlug, createdBy: system.principal_id })
      }
    }
  } catch (e) {
    console.error(`suite registry reseed: ${e.message}`)
  }
}

const HARNESS_ENTRY_TOOLS = new Set(['harness_start', 'harness_status'])

const ACTIVITY_SCOPED_TOOLS = new Set([
  'awp_test_run',
  'awp_loop_wait',
  'awp_loop_resume',
  'verify_report',
  'distill_append',
  'awp_test_spec_submit',
  'awp_test_spec_get',
  'query_docs',
  'list_docs',
  'awp_task_attach',
  'awp_task_attach_list',
  'awp_impact_preview',
  'awp_design_tools',
  'awp_design_call',
])

async function activityToolBlock(toolName, args) {
  if (!toolName || !ACTIVITY_SCOPED_TOOLS.has(toolName)) return null
  const taskId = args?.taskId
  if (!taskId) return null
  let row = null
  try {
    // 归属解析：not found 维持放行（return null）；ambiguous 返回错误字符串，
    // 不得拿某一行的 phase 判断活动（方案 §5.1）
    const resolved = await resolveTaskRepo(db, { taskId, repo: args?.repo || null })
    if (!resolved.ok) {
      if (resolved.code === 'AMBIGUOUS_TASK_REPO') {
        return `AMBIGUOUS_TASK_REPO: 任务 ${taskId} 在多个仓存在且未传 repo，禁止按任一行判断活动；请显式传 repo。`
      }
      return null
    }
    row = await db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(resolved.repo, String(taskId))
  } catch {
    return null
  }
  if (!row?.phase) return null
  const activity = phaseToActivity(row.phase)
  if (new Set(toolsForActivity(activity)).has(toolName)) return null
  return `TOOL_NOT_IN_ACTIVITY: 当前活动 ${activity} 不允许调用 ${toolName}。nextTool 见 harness_status。`
}
// 注意：task_state 不要放进 GATED——它是旧协作路径；IDE 工具目录缓存缺失 harness_* 时，
// 若连 task_state 也门禁，agent 会「调不到 harness_start + task_state 被拒」死锁并降级普通开发。
const HARNESS_GATED_TOOLS = new Set([
  'harness_advance',
  'awp_test_run',
  'verify_report',
  'distill_append',
])
/** 带 taskId 的工具：未传 repo 时按任务归属注入，禁止静默默认 demo-app */
const TOOL_NEEDS_REPO = new Set([
  'harness_status',
  'harness_advance',
  'awp_test_run',
  'awp_loop_wait',
  'awp_loop_resume',
  'verify_report',
  'task_state',
  'distill_append',
  'awp_task_attach',
  'awp_task_attach_list',
  'awp_impact_preview',
])

async function createServer(sessionCtx = {}) {
  const server = new McpServer(
    { name: 'agent-workflow-platform', version: '1.0.0' },
    { instructions: await buildBootstrapInstructions(sessionCtx) }
  )
  // harness 先注册：部分 IDE 工具目录/搜索只索引前若干个工具，把入口工具排前降低「搜不到 harness_start」概率
  registerHarnessTools(server)
  registerRecordsTools(server)
  registerCollaborationTools(server)
  registerKnowledgeTools(server)
  registerTestSpecTools(server)
  registerTestRunTools(server)
  registerLoopTools(server)
  registerSkillTools(server)
  registerLanhuTools(server)
  return server
}

// ─── buildApp：组装完整 Express 应用（路由+中间件+子路由挂载），不启动定时器/监听 ───
// 副作用（对账定时器、SSE 桥、listen、mTLS）全部在 start()——测试用 buildApp() 拿 app。
export function buildApp() {
const app = express()
app.use(express.json({ limit: '50mb' }))

// MCP clients may send an Origin header; enable CORS for configured origins.
app.use((req, res, next) => {
  // Streamable HTTP compatibility: some older clients send only Accept: application/json,
  // MCP SDK 会 406 拒绝。此处无条件补全 Accept，避免「连接成功但 tools/list 失败」。
  if (req.path === '/mcp' || req.path === '/message') {
    const acc = String(req.headers.accept || '')
    if (!acc.includes('text/event-stream')) {
      req.headers.accept = acc
        ? `${acc}, text/event-stream`
        : 'application/json, text/event-stream'
    }
    if (!acc.includes('application/json') && !acc.includes('*/*')) {
      req.headers.accept = `${req.headers.accept}, application/json`
    }
  }
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, mcp-session-id, x-awp-username, x-awp-repo, x-awp-call-id, Accept, Last-Event-ID'
  )
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, mcp-session-id')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }
  next()
})

// 看板 HTML 动态注入构建戳：静态资源 ?v= 缓存击穿 + 侧栏版本可见（重启即 bump）
const DASH_BUILD = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
app.get('/dashboard.html', (req, res) => {
  const html = readFileSync(path.join(__dirname, 'public', 'dashboard.html'), 'utf8').replaceAll('%BUILD%', DASH_BUILD)
  res.type('html').setHeader('Cache-Control', 'no-cache').send(html)
})
app.use(express.static(path.join(__dirname, 'public'), {
  // 协商缓存：每次使用前 revalidate（etag 命中走 304），杜绝 SPA 长开页面跑旧 JS
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}))

mountAuditRoutes(app)
mountDashboardApi(app)
mountTestingDashboard(app)
mountTestingRoutes(app, { tlsRequired: Boolean(runnerTlsCert && runnerTlsKey) })

// 任务存在性 + 是否非终态检查（API 门禁复用，替代 CI 的执行点）
const TERMINAL = new Set(['DONE', 'ABORTED'])
async function checkTaskOpen(taskId, repo) {
  if (!taskId) return { exists: false, open: false, phase: null }
  const row = await db.prepare('SELECT phase FROM tasks WHERE repo = ? AND task_id = ?').get(repo || 'demo-app', taskId)
  if (!row) return { exists: false, open: false, phase: null }
  return { exists: true, open: !TERMINAL.has(row.phase), phase: row.phase }
}

app.get('/', (req, res) => {
  res.redirect('/dashboard.html')
})

// ─── MCP 协议端点（多 session） ─────────────────────────────
// SESSION_TTL_MS / sessions / destroySession 已提升至模块级（与 start() 的清扫定时器共用）

// MCP Streamable HTTP：SDK 要求 Accept 同时含 application/json 与 text/event-stream。
// Some older clients send only application/json → SDK 直接 406，表现为「连上了但拉不到工具」。
// 此处在业务 handler 与 hono 转 Web Request 之前强制补齐（含 rawHeaders）。
function forceMcpAccept(req) {
  const want = 'application/json, text/event-stream'
  const acc = String(req.headers.accept || req.headers.Accept || '')
  if (acc.includes('application/json') && acc.includes('text/event-stream')) return
  req.headers.accept = want
  req.headers.Accept = want
  try {
    if (Array.isArray(req.rawHeaders)) {
      const rh = req.rawHeaders
      let i = 0
      let hit = false
      while (i < rh.length) {
        if (String(rh[i]).toLowerCase() === 'accept') {
          rh[i + 1] = want
          hit = true
          break
        }
        i += 2
      }
      if (!hit) rh.push('Accept', want)
    }
  } catch { /* ignore */ }
  // debug: 证明 shim 确实改到了 rawHeaders（hono 从这里读）
  try {
    const rhAcc = []
    for (let i = 0; i < (req.rawHeaders || []).length; i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === 'accept') rhAcc.push(req.rawHeaders[i + 1])
    }
    console.log(`[mcp-accept] path=${req.path} before='${acc}' rawHeaders.accept='${rhAcc.join('|')}'`)
  } catch { /* ignore */ }
}

app.post('/mcp', async (req, res) => {
  try { console.log(`[mcp-hit] ${req.method} ${req.url} accept=${req.headers.accept}`) } catch { /* ignore */ }
  forceMcpAccept(req)
  const body = req.body
  if (body && body.method) {
    const t = new Date().toLocaleTimeString()
    if (body.method === 'tools/call') {
      const args = JSON.stringify(body.params?.arguments || {}).slice(0, 120)
      process.stdout.write(`[${t}] 🔧 ${body.params?.name} ${args}\n`)
    } else if (body.method === 'initialize') {
      console.log(`[${t}] 🤝 新客户端连接`)
    } else if (body.method === 'tools/list') {
      console.log(`[${t}] 📋 查询工具列表`)
    } else if (body.method !== 'notifications/initialized') {
      console.log(`[${t}] 📨 ${body.method}`)
    }
  }

  const started = Date.now()
  // 全链路 trace：每个 tools/call 一个 uuid，贯通 submission/run/lifecycle
  const traceId = crypto.randomUUID()
  let activeSid = req.headers['mcp-session-id'] || null
  let activeClient = activeSid ? sessions.get(activeSid)?.clientName : null
  // 固定使用人：连接 URL 拼接 ?username=xxx，或请求头 x-awp-username，或环境变量 MCP_USERNAME
  const usernameFromReq = req.query?.username || req.headers['x-awp-username'] || null
  const sessionUser = activeSid ? sessions.get(activeSid)?.username : null
  const connUserEarly = usernameFromReq || sessionUser || process.env.MCP_USERNAME || null
  // 连接级 repo（静默接入）：URL ?repo=xxx 或请求头 x-awp-repo。提供但非法直接拒绝，
  // 防止手滑把任务静默串到默认仓 demo-app
  const repoNorm = normalizeRepoSlug(req.query?.repo ?? req.headers['x-awp-repo'] ?? null)
  if (repoNorm.provided && !repoNorm.ok) {
    res.status(400).json({ error: `非法 repo 参数：${repoNorm.reason}（示例 ?repo=demo-app，须全小写）` })
    return
  }
  const repoFromReq = repoNorm.slug
  const sessionRepo = activeSid ? sessions.get(activeSid)?.repo : null
  const connRepoEarly = repoFromReq || sessionRepo || null
  const activeSession = activeSid ? sessions.get(activeSid) : null
  const toolName = body?.method === 'tools/call' ? body.params?.name : null
  if (toolName && HARNESS_ENTRY_TOOLS.has(toolName) && activeSession) {
    activeSession.seenHarness = true
  }

  // ─── tool_calls 幂等账本（链路网关方案 §4/§16）：仅 tools/call 且带 JSON-RPC 请求 id ───
  // 网关重放同 call_id：已结束→回放；在途→-32002；首次→落 started 并截获写回客户端的正文。
  let ledgerCallId = null
  let ledgerSettled = false
  let ledgerServedBy = null
  let ledgerFailoverFrom = null
  if (body?.method === 'tools/call' && toolName && body?.id != null) {
    ledgerCallId = req.headers['x-awp-call-id'] || crypto.randomUUID()
    // UI 链路分叉：从网关头取应答链路归属与换链来源（无网关直连时降级 AWP_LINK_LABEL 环境变量）
    ledgerServedBy = req.headers['x-awp-served-by'] || process.env.AWP_LINK_LABEL || null
    ledgerFailoverFrom = req.headers['x-awp-failover-from'] || null
    const ledgerArgs = body.params?.arguments || {}
    const existingLedger = await getToolCall(db, ledgerCallId)
    if (existingLedger && existingLedger.state === 'finished') {
      const noBody = isWriteTool(toolName) && (existingLedger.response_text == null || existingLedger.response_text === '')
      res.json(noBody ? finishedWithoutBodyMessage(body.id) : buildReplayMessage(existingLedger, body.id))
      return
    }
    if (existingLedger && existingLedger.state === 'started') {
      res.json(callInProgressMessage(body.id))
      return
    }
    let ledgerPhase = null
    try {
      if (ledgerArgs.taskId) {
        const repoForPhase = ledgerArgs.repo || connRepoEarly || null
        const pr = repoForPhase
          ? await db.prepare('SELECT phase FROM tasks WHERE repo=? AND task_id=?').get(repoForPhase, String(ledgerArgs.taskId))
          : await db.prepare('SELECT phase FROM tasks WHERE task_id=?').get(String(ledgerArgs.taskId))
        ledgerPhase = pr?.phase || null
      }
    } catch { /* 定位不到 phase 留空 */ }
    await insertStarted(db, {
      callId: ledgerCallId,
      repo: ledgerArgs.repo || connRepoEarly || null,
      taskId: ledgerArgs.taskId ? String(ledgerArgs.taskId) : null,
      toolName,
      phase: ledgerPhase,
      servedByLink: ledgerServedBy,
      failoverFrom: ledgerFailoverFrom,
    })
    // G2（§16）：包一层 res.write/res.end 记录写给客户端的正文；并在 flush 响应给客户端【之前】
    // 完成账本结算（写工具须存正文），消除「响应已达客户端、markFinished 尚未提交」的竞态。
    let awpCaptured = ''
    const origWrite = res.write.bind(res)
    const origEnd = res.end.bind(res)
    const appendChunk = (chunk) => {
      try {
        if (chunk == null) return
        if (typeof chunk === 'string') awpCaptured += chunk
        else awpCaptured += Buffer.from(chunk).toString('utf8') // Buffer / Uint8Array / ArrayBuffer 统一按 utf8 解码
      } catch { /* ignore */ }
    }
    const deliver = (chunk, enc, cb) => { try { return origEnd(chunk, enc, cb) } catch { return res } }
    res.write = (chunk, enc, cb) => { appendChunk(chunk); return origWrite(chunk, enc, cb) }
    res.end = (chunk, enc, cb) => {
      appendChunk(chunk)
      // 门禁/异常/会话失效已显式结算（ledgerSettled=true）→ 直接投递
      if (!ledgerCallId || ledgerSettled) return deliver(chunk, enc, cb)
      ledgerSettled = true
      const extracted = extractToolResult(awpCaptured, body.id)
      if (extracted.found) {
        markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: extracted.isError ? 'error' : 'ok', responseText: extracted.text })
          .then(() => deliver(chunk, enc, cb), () => deliver(chunk, enc, cb))
        return res
      }
      if (!isWriteTool(body.params?.name)) {
        markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'ok', responseText: '' })
          .then(() => deliver(chunk, enc, cb), () => deliver(chunk, enc, cb))
        return res
      }
      // 写工具截不到正文：留 started（§16），直接投递，重放再执行
      return deliver(chunk, enc, cb)
    }
  }
  // 硬门禁：本连接尚未 harness_start/status 时，门禁类工具直接 isError 引导先开会话
  //（含无 session 的裸 tools/call，防绕过 initialize）
  const harnessBootstrapHint =
    toolName &&
    HARNESS_GATED_TOOLS.has(toolName) &&
    (!activeSession || !activeSession.seenHarness)
      ? 'MCP bootstrap required: first call harness_start (new task) or harness_status (resume). ' +
        'These tools ARE registered on server awp-ai (verify via tools/list; exact names: harness_start, harness_status, harness_advance). ' +
        '若 IDE 工具面板搜不到：请断开并重连 awp-ai MCP（或强制刷新工具列表），然后用「精确名称」直接调用 harness_start，禁止模糊搜索后降级普通开发。' +
        ' Business AGENTS.md is bootstrap only.'
      : null
  // 任务负责人 / 经验作者一律归到 MCP 连接 username（禁止 AI 写自己的名字）。
  // 连接未带 username 时降级为 agent:<client> 占位（2026-09-26 决策）：归属仍统一、可追踪，不打断存量客户端。
  if (body?.method === 'tools/call' && AUTHOR_TOOLS.has(toolName)) {
    if (!body.params.arguments || typeof body.params.arguments !== 'object') {
      body.params.arguments = {}
    }
    const resolvedAuthor = resolveToolAuthor(body.params.arguments.author, connUserEarly, {
      forceConn: true,
    })
    body.params.arguments.author =
      resolvedAuthor || `agent:${String(activeClient || 'unknown').slice(0, 40)}`
  }
  // 连接绑定了 repo 时，未显式传 repo 的工具调用统一注入；显式传的以参数为准
  if (body?.method === 'tools/call' && connRepoEarly) {
    if (!body.params.arguments || typeof body.params.arguments !== 'object') {
      body.params.arguments = {}
    }
    if (body.params.arguments.repo == null || body.params.arguments.repo === '') {
      body.params.arguments.repo = connRepoEarly
    }
  }
  // 未绑定连接 repo 且工具带 taskId：按任务真实归属注入，避免默认串到 demo-app
  // 方案 §5.1：查找走 resolveTaskRepo；ambiguous 时工具调用返回错误，不得注入 repo
  let ambiguousTaskRepo = false
  if (body?.method === 'tools/call' && !connRepoEarly && TOOL_NEEDS_REPO.has(toolName)) {
    if (!body.params.arguments || typeof body.params.arguments !== 'object') {
      body.params.arguments = {}
    }
    const args = body.params.arguments
    if ((args.repo == null || args.repo === '') && args.taskId) {
      const resolved = await resolveTaskRepo(db, { taskId: args.taskId, repo: null })
      if (resolved.ok) {
        args.repo = resolved.repo
      } else if (resolved.code === 'AMBIGUOUS_TASK_REPO') {
        ambiguousTaskRepo = true
      }
      // TASK_NOT_FOUND：不注入（与原「查不到行就不注入」行为一致）
    }
  }

  // 硬门禁：taskId 跨仓歧义且未传 repo → 工具调用报错，禁止按任一行注入/判断
  if (ambiguousTaskRepo && body?.id != null) {
    await recordMcpToolCall({
      sessionId: activeSid,
      toolName,
      args: body.params?.arguments || {},
      clientName: activeSession?.clientName || null,
      author: connUserEarly,
      status: 'error',
      durationMs: 0,
      detail: 'AMBIGUOUS_TASK_REPO',
      traceId,
    })
    const ledgerText = `AMBIGUOUS_TASK_REPO: 任务 ${body.params?.arguments?.taskId} 在多个仓存在且连接未绑定 repo。请显式传 repo 参数后重试；禁止按任一行默认归属。`
    if (ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: ledgerText }) }
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{
          type: 'text',
          text: ledgerText,
        }],
        isError: true,
      },
    })
    return
  }

  // 入口权限（方案第 4 节）：repo 注入完成后按最终 repo 校验 harness_repo_acl
  //（缺省 off 行为不变；on 时写工具要 submit、读工具要 read_result）
  const aclDenial = await enforceHarnessRepoAcl(db, {
    toolName,
    repo: body?.params?.arguments?.repo || connRepoEarly || null,
    username: connUserEarly,
  })
  if (aclDenial && body?.id != null) {
    await recordMcpToolCall({
      sessionId: activeSid,
      toolName,
      args: body.params?.arguments || {},
      clientName: activeSession?.clientName || null,
      author: connUserEarly,
      status: 'error',
      durationMs: 0,
      detail: aclDenial.code,
      traceId,
    })
    const aclText = `${aclDenial.code}: ${(aclDenial.blockedBy || []).join('；')}`
    if (ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: aclText }) }
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: aclText }],
        isError: true,
      },
    })
    return
  }

  // 硬门禁：本连接尚未 harness_start/status 时，门禁类工具直接 isError 引导先开会话
  if (harnessBootstrapHint && body?.id != null) {
    await recordMcpToolCall({
      sessionId: activeSid,
      toolName,
      args: body.params?.arguments || {},
      clientName: activeSession?.clientName || null,
      author: connUserEarly,
      status: 'error',
      durationMs: 0,
      detail: 'harness bootstrap required',
      traceId,
    })
    if (ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: harnessBootstrapHint }) }
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: harnessBootstrapHint }],
        isError: true,
      },
    })
    return
  }

  const activityBlock = await activityToolBlock(toolName, body?.params?.arguments)
  if (activityBlock && body?.id != null) {
    if (ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: activityBlock }) }
    res.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: activityBlock }],
        isError: true,
      },
    })
    return
  }

  // §14.1:租户请求在此上下文内执行(postgres 方言下驱动自动 SET LOCAL app.tenant_id)
  const tenantRepoSlug = body?.params?.arguments?.repo || connRepoEarly || null
  const dispatchMcp = async () => {
  try {
    const method = body?.method
    const existing = activeSid && sessions.get(activeSid)
    // 会话丢失（PM2 重启 / TTL 清扫）：initialize 可重建；其它方法明确要求重连，禁止静默新建孤立 McpServer
    if (activeSid && !existing && method !== 'initialize' && method !== 'notifications/initialized') {
      // 会话失效：工具从未执行，先释放在途预约（删除仍为 started 的行），让网关重放同 call_id 时真正执行
      if (ledgerCallId) { ledgerSettled = true; await releaseStarted(db, ledgerCallId) }
      res.status(404).json({
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: {
          code: -32001,
          message:
            `MCP session 已失效（server 重启或超过 ${Math.round(SESSION_TTL_MS / 60000)} 分钟空闲）。` +
            '请客户端重新 initialize（勿带旧 mcp-session-id）。',
        },
      })
      return
    }
    if (existing) {
      existing.lastSeen = Date.now()
      if (usernameFromReq) existing.username = usernameFromReq
      if (repoFromReq) existing.repo = repoFromReq
      await existing.transport.handleRequest(req, res, body)
    } else {
      const sessionId = crypto.randomUUID()
      activeSid = sessionId
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      })
      const sessionUsername = usernameFromReq || process.env.MCP_USERNAME || null
      const sessionRepoInit = repoFromReq || null
      const server = await createServer({ repo: sessionRepoInit, username: sessionUsername })
      const ci = body?.method === 'initialize' ? body.params?.clientInfo : null
      activeClient = ci?.name || null
      sessions.set(sessionId, {
        transport,
        server,
        lastSeen: Date.now(),
        clientName: activeClient,
        clientVersion: ci?.version || null,
        username: sessionUsername,
        repo: sessionRepoInit,
        seenHarness: false,
        kind: 'http',
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    }

    // 本次连接固定归属的使用人（会话级优先，其次环境变量兜底）
    const connUser = usernameFromReq || sessions.get(activeSid)?.username || process.env.MCP_USERNAME || null

    if (body?.method === 'initialize') {
      const ci = body.params?.clientInfo || {}
      await recordMcpInit({
        sessionId: activeSid,
        clientName: ci.name,
        clientVersion: ci.version,
        author: connUser,
      })
    } else if (body?.method === 'tools/call') {
      await recordMcpToolCall({
        sessionId: activeSid,
        toolName: body.params?.name,
        args: body.params?.arguments || {},
        clientName: activeClient,
        author: connUser,
        status: 'ok',
        durationMs: Date.now() - started,
        traceId,
      })
      // 账本结算已在被包装的 res.end 内完成（flush 响应前）；此处无需重复。
    }
  } catch (err) {
    if (body?.method === 'tools/call') {
      await recordMcpToolCall({
        sessionId: activeSid,
        toolName: body.params?.name,
        args: body.params?.arguments || {},
        clientName: activeClient,
        author: sessions.get(activeSid)?.username || process.env.MCP_USERNAME || null,
        status: 'error',
        durationMs: Date.now() - started,
        detail: String(err.message || err),
        traceId,
      })
      if (ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: `INTERNAL_ERROR: ${String(err.message || err)}` }) }
    }
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) })
  }
  }

  // 租户上下文包裹(§14.1):有 repo 的请求以该 repo_id 运行;无 repo → owner 路径
  try {
    const tenantSlug = String(tenantRepoSlug || '').toLowerCase()
    const tenantRow = tenantSlug
      ? db.prepare('SELECT repo_id FROM repositories WHERE slug = ?').get(tenantSlug)
      : null
    if (tenantRow) await runWithTenant(tenantRow.repo_id, dispatchMcp)
    else await dispatchMcp()
  } catch (e) {
    // 租户上下文构建阶段报错：工具未执行，落 finished+error（仅当仍为 started）
    if (body?.method === 'tools/call' && ledgerCallId) { ledgerSettled = true; await markFinished(db, { callId: ledgerCallId, servedByLink: ledgerServedBy, status: 'error', responseText: `INTERNAL_ERROR: ${String(e.message || e)}` }) }
    if (!res.headersSent) res.status(500).json({ error: String(e.message || e) })
  }
})

app.get('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id']
  const s = sid && sessions.get(sid)
  if (!s) {
    // Streamable HTTP 客户端在 SSE 模式下 GET /mcp：无 session 时用明确协议错误，避免当成「服务挂了」
    res.status(404).json({
      error: 'session 不存在或已过期',
      hint: '请 POST /mcp 重新 initialize；或改用兼容端点 GET /sse + POST /message（older SSE clients）',
      health: '/api/health',
    })
    return
  }
  s.lastSeen = Date.now()
  await s.transport.handleRequest(req, res, req.body)
})

app.delete('/mcp', async (req, res) => {
  const sid = req.headers['mcp-session-id']
  const s = sid && sessions.get(sid)
  if (!s) {
    res.status(404).json({ error: 'session 不存在' })
    return
  }
  destroySession(sid)
  res.status(200).end()
})

// ─── 兼容旧 SSE MCP（older MCP clients use GET /sse + POST /message）──
const sseSessions = new Map()

app.get('/sse', async (req, res) => {
  try {
    const sessionId = crypto.randomUUID()
    const usernameFromReq = req.query?.username || req.headers['x-awp-username'] || null
    const repoNorm = normalizeRepoSlug(req.query?.repo ?? req.headers['x-awp-repo'] ?? null)
    if (repoNorm.provided && !repoNorm.ok) {
      res.status(400).json({ error: `非法 repo 参数：${repoNorm.reason}` })
      return
    }
    const transport = new SSEServerTransport('/message', res)
    const server = await createServer({ repo: repoNorm.slug || null, username: usernameFromReq || process.env.MCP_USERNAME || null })
    sseSessions.set(transport.sessionId, {
      transport,
      server,
      lastSeen: Date.now(),
      username: usernameFromReq || process.env.MCP_USERNAME || null,
      repo: repoNorm.slug || null,
      seenHarness: false,
      kind: 'sse',
      clientName: req.headers['user-agent'] || 'sse-client',
    })
    // 与 Streamable 共用 lastSeen 语义：tools/call 时按 transport.sessionId 回写
    sessions.set(transport.sessionId, sseSessions.get(transport.sessionId))
    res.on('close', () => {
      sseSessions.delete(transport.sessionId)
      sessions.delete(transport.sessionId)
      try { server.close() } catch { /* ignore */ }
    })
    // connect() 内部会 start()；再 start() 会抛 "already started"，some clients appear connected but do not load tools
    await server.connect(transport)
    console.log(`[${new Date().toLocaleTimeString()}] 🤝 SSE 客户端连接 session=${String(transport.sessionId).slice(0, 8)}…`)
  } catch (err) {
    console.error(`[mcp-sse] 连接失败: ${err.message}`)
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) })
  }
})

app.post('/message', async (req, res) => {
  forceMcpAccept(req)
  try {
    const sid = req.query?.sessionId || req.query?.session_id
    const s = (sid && (sseSessions.get(String(sid)) || sessions.get(String(sid)))) || null
    if (!s) {
      res.status(404).json({ error: 'SSE session 不存在，请重新 GET /sse' })
      return
    }
    s.lastSeen = Date.now()
    // SSE 下也要做 harness 软引导（与 /mcp 一致）
    const body = req.body
    const toolName = body?.method === 'tools/call' ? body.params?.name : null
    if (toolName && HARNESS_ENTRY_TOOLS.has(toolName)) s.seenHarness = true
    if (
      toolName &&
      HARNESS_GATED_TOOLS.has(toolName) &&
      !s.seenHarness &&
      body?.id != null
    ) {
      res.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{
            type: 'text',
            text:
              'MCP bootstrap required: first call harness_start (new task) or harness_status (resume). ' +
              'Tools exist on server awp-ai — exact names harness_start / harness_status. ' +
              '重连 MCP 后按精确名调用，禁止模糊搜索后直接降级普通开发。',
          }],
          isError: true,
        },
      })
      return
    }
    await s.transport.handlePostMessage(req, res, body)
  } catch (err) {
    console.error(`[mcp-sse] message 失败: ${err.message}`)
    if (!res.headersSent) res.status(500).json({ error: String(err.message || err) })
  }
})

// 连接自检：for client setup and troubleshooting
app.get('/api/mcp/ping', (req, res) => {
  res.json({
    ok: true,
    streamable: '/mcp',
    sse: '/sse',
    message: '/message',
    health: '/api/health',
    activeSessions: sessions.size,
    uptimeSec: Math.round(process.uptime()),
  })
})

// ─── 健康检查端点 ──────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const counts = {
    experiences: (await db.prepare('SELECT COUNT(*) as c FROM experiences').get()).c,
    tasks: (await db.prepare('SELECT COUNT(*) as c FROM tasks').get()).c,
    docs: (await db.prepare('SELECT COUNT(*) as c FROM docs').get()).c,
      verify_reports: (await db.prepare('SELECT COUNT(*) as c FROM verify_reports').get()).c,
  }
  res.json({
    ok: true,
    version: PKG_VERSION,
    counts,
    testing: {
      contractVersion: CONTRACT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      migrationChecksum: SCHEMA_CHECKSUM,
    },
  })
})

// ─── 本地验证上报端点（verify.sh curl 直调） ────────────────
app.post('/api/report', async (req, res) => {
  const { level, side, file, pass, errors, detail, author, repo, taskId } = req.body || {}
  if (!level || author === undefined) {
    res.status(400).json({ error: '缺少必填字段：level / author' })
    return
  }
  // curl/MCP 包装层可能把布尔序列化成字符串："false" 不能被当成 true
  const passBool = pass === true || pass === 1 || pass === '1' || String(pass).toLowerCase() === 'true'
  const errCount = errors === undefined || errors === null || errors === '' ? 0 : Number(errors)
  // 门禁：关联任务必须存在且非终态（杜绝上报到已结束任务）
  if (taskId) {
    const t = await checkTaskOpen(taskId, repo)
    if (!t.exists) {
      res.status(400).json({ error: `关联任务不存在：${taskId}` })
      return
    }
    if (!t.open) {
      res.status(400).json({ error: `任务 ${taskId} 已处于终态 ${t.phase}，不可再上报验证结果` })
      return
    }
  }
  const repoVal = repo || 'demo-app'
  const tenantRowRep = db.prepare('SELECT repo_id FROM repositories WHERE slug = ?').get(String(repoVal).toLowerCase())
  const runInTenant = (fn) => (tenantRowRep ? runWithTenant(tenantRowRep.repo_id, fn) : fn())
  const id = await runInTenant(async () => nextRepId())

  await db.prepare(`
    INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
    VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, repoVal, repoVal, level, side || 'na', file || null, passBool ? 1 : 0, Number.isFinite(errCount) ? errCount : 0, detail || '', author, taskId || null, new Date().toISOString())

  await recordHttpEvent({
    eventType: 'http_verify',
    payload: req.body,
    status: passBool ? 'ok' : 'fail',
    detail: `${level} ${file || ''} pass=${passBool}`,
  })

  console.log(`[${new Date().toLocaleTimeString()}] 📊 ${level} ${repoVal} ${side} ${file || ''} pass=${passBool} @${author}`)
  // 无 taskId 的上报不计入任何任务门禁（守卫按 task_id 查询）——当场警告，避免白跑
  const warning = taskId
    ? undefined
    : `未携带 taskId：本次 ${level} 上报不计入任何任务的门禁判定。请设置 AWP_AI_TASK_ID=<taskId> 后重跑，或用 verify_report 工具带 taskId 补登记。`
  res.json({ ok: true, id, ...(warning ? { warning } : {}) })
})

app.get('/api/harness/labels', (req, res) => {
  res.json({ ok: true, phases: PHASE_LABELS, sizes: SIZE_LABELS, tools: Object.keys(TOOL_LABELS) })
})

// ─── Harness REST（非 MCP 客户端：CI / 脚本 / Web） ─────────
app.get('/api/harness/status', async (req, res) => {
  const { taskId, repo } = req.query
  if (!taskId) {
    res.status(400).json({ error: '缺少 taskId' })
    return
  }
  // 入口权限（方案第 4 节）：缺省 off 行为不变
  const aclDenial = await enforceHarnessRepoAcl(db, {
    toolName: 'harness_status',
    repo: repo ? String(repo) : null,
    username: req.headers['x-awp-username'] || req.query.username || process.env.MCP_USERNAME || null,
  })
  if (aclDenial) {
    res.status(403).json({ error: aclDenial.code, blockedBy: aclDenial.blockedBy })
    return
  }
  const result = await harnessStatus({ taskId: String(taskId), repo: repo ? String(repo) : undefined })
  // UI 链路分叉：合并所有链路切换事件（无切换/缺列/查询异常时为空，绝不影响 status 本身）
  try {
    const forkResult = await buildLinkFork(db, { taskId: String(taskId), repo: repo ? String(repo) : null })
    result.linkFork = forkResult.fork // 向后兼容：最近一次 fork 事件
    result.linkEvents = forkResult.events // 新字段：所有切换事件（fork/recover 时间序列）
  } catch {
    result.linkFork = null
    result.linkEvents = []
  }
  // 只读查询不写审计，避免看板 SSE 死循环
  res.json(result)
})

app.post('/api/harness/advance', async (req, res) => {
  const { taskId, to, data, author, repo } = req.body || {}
  if (!taskId || !to || !author) {
    res.status(400).json({ error: '缺少必填字段：taskId / to / author' })
    return
  }
  // 入口权限（方案第 4 节）：按最终 repo（参数优先）校验；缺省 off 行为不变
  const aclDenial = await enforceHarnessRepoAcl(db, {
    toolName: 'harness_advance',
    repo: repo || null,
    username: req.headers['x-awp-username'] || author || process.env.MCP_USERNAME || null,
  })
  if (aclDenial) {
    res.status(403).json({ error: aclDenial.code, blockedBy: aclDenial.blockedBy })
    return
  }
  const result = await harnessAdvance({ taskId, to, data: data || {}, author, repo })
  await recordHttpEvent({
    eventType: 'http_harness_advance',
    payload: req.body,
    status: result.ok ? 'ok' : 'fail',
    detail: result.ok ? `${result.from}→${result.to}` : result.error,
  })
  res.json(result)
})

// ─── 经验库写入端点（drift-auto.mjs / 脚本 / CI 直调，镜像 distill_append）───
app.post('/api/distill', async (req, res) => {
  const { content, source, author, repo, tags, module, taskId, ruleRef } = req.body || {}
  if (!content || author === undefined) {
    res.status(400).json({ error: '缺少必填字段：content / author' })
    return
  }
  // 门禁：source=auto 必须携带合法 taskId（存在且非终态），杜绝无归属偏差污染经验库
  if ((source || 'auto') === 'auto') {
    if (!taskId) {
      res.status(400).json({ error: 'source=auto 时必须携带 taskId（关联 Harness 任务）' })
      return
    }
    const t = await checkTaskOpen(taskId, repo)
    if (!t.exists) {
      res.status(400).json({ error: `关联任务不存在：${taskId}` })
      return
    }
    if (!t.open) {
      res.status(400).json({ error: `任务 ${taskId} 已处于终态 ${t.phase}，auto 偏差不可再写入` })
      return
    }
  }
  const repoVal = repo || 'demo-app'
  const tenantRowExp = db.prepare('SELECT repo_id FROM repositories WHERE slug = ?').get(String(repoVal).toLowerCase())
  const runInTenantExp = (fn) => (tenantRowExp ? runWithTenant(tenantRowExp.repo_id, fn) : fn())
  const id = await runInTenantExp(async () => nextExpId())
  const now = new Date().toISOString()
  await db.prepare(`
    INSERT INTO experiences (id, repo, tenant_id, content, source, status, author, module, task_id, rule_ref, tags, created_at, updated_at)
    VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, repoVal, repoVal, content, source || 'auto', author, module || null, taskId || null, ruleRef || null, JSON.stringify(tags || []), now, now)
  console.log(`[${new Date().toLocaleTimeString()}] 🧪 经验写入 ${id} @${author} (source=${source || 'auto'})`)
  res.json({ ok: true, id, status: 'pending' })
})

// ─── 规范版本（L0 一致性检查，改查 docs 表：规范才是版本真相源） ──
app.get('/api/rules-version', async (req, res) => {
  const latest = await db.prepare('SELECT MAX(updated_at) as latest FROM docs').get()
  res.json({ version: '1.0.0', updatedAt: latest?.latest || null })
})

// ─── 规则单一真源 manifest（供通用项目规则同步脚本使用）──
app.get('/api/rules-manifest', async (req, res) => {
  const row = await db.prepare("SELECT content, updated_by, updated_at FROM docs WHERE repo = 'shared' AND name = 'RULES_MANIFEST'").get()
  if (!row) {
    res.status(404).json({ error: 'RULES_MANIFEST 未初始化' })
    return
  }
  const rules = String(row.content).split('\n').map((s) => s.trim()).filter(Boolean)
  res.json({ rules, ruleCount: rules.length, author: row.updated_by, updatedAt: row.updated_at })
})

// ─── 知识库版本历史（规范上云保险丝：历史 / diff / 回滚）──
app.get('/api/docs/versions', async (req, res) => {
  const { name, repo = 'demo-app' } = req.query
  if (!name) {
    res.status(400).json({ error: '缺少 name' })
    return
  }
  const rows = await db.prepare(
    'SELECT id, version, content_before, content_after, category_before, category_after, author, created_at FROM docs_versions WHERE repo = ? AND name = ? ORDER BY version DESC'
  ).all(repo, name)
  res.json({ ok: true, name, repo, count: rows.length, versions: rows })
})

app.post('/api/docs/rollback', async (req, res) => {
  const { name, repo = 'demo-app', versionId, author } = req.body || {}
  if (!name || !versionId || !author) {
    res.status(400).json({ error: '缺少必填字段：name / versionId / author' })
    return
  }
  const v = await db.prepare('SELECT content_after, category_after FROM docs_versions WHERE repo = ? AND name = ? AND id = ?').get(repo, name, versionId)
  if (!v) {
    res.status(404).json({ error: '版本不存在' })
    return
  }
  const now = new Date().toISOString()
  // 回滚 = 以该版本 content_after 再写一次（自然产生新快照，保留完整时间线）
  await db.prepare(`
    INSERT INTO docs (repo, tenant_id, name, category, content, updated_at, updated_by)
    VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?)
    ON CONFLICT(repo, name) DO UPDATE SET
      category = COALESCE(excluded.category, docs.category),
      content = excluded.content,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).run(repo, repo, name, v.category_after || null, v.content_after, now, author)
  await db.prepare(`
    INSERT INTO docs_versions (repo, tenant_id, name, version, content_before, content_after, category_before, category_after, author, created_at)
    VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, (SELECT COALESCE(MAX(version),0)+1 FROM docs_versions WHERE repo = ? AND name = ?), '[rollback]', ?, ?, ?, ?, ?)
  `).run(repo, repo, name, repo, name, v.content_after, v.category_after || null, v.category_after || null, author, now)
  res.json({ ok: true, name, repo, message: `已回滚到版本 #${versionId}` })
})

// ─── 飞轮仪表聚合（周会一块屏看体系转速；聚合逻辑在 dashboard/api.js 复用）──
app.get('/api/dashboard/flywheel', async (req, res) => {
  const repo = req.query.repo || 'demo-app'
  res.json({
    ok: true,
    repo,
    ...await flywheelStats(repo),
    generatedAt: new Date().toISOString(),
  })
})

// ─── 自部署端点（本地一键触发：git pull + pm2 restart agent-workflow-platform）──
// 只重启控制面进程；绝不重启全部（否则会重启 8787 网关，违背「网关不随业务发版重启」）
// 流程：pull 成功才重启；依赖变化先 npm ci；先响应再延迟重启，避免响应随进程一起被杀
const execFile = promisify(execFileCb)
app.post('/api/deploy', async (req, res) => {
  try {
    const before = (await execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname })).stdout.trim()
    const pull = await execFile('git', ['pull', '--ff-only'], { cwd: __dirname, timeout: 60_000 })
    const after = (await execFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: __dirname })).stdout.trim()

    // 依赖变更 → 先 npm ci（better-sqlite3 原生模块，lock 变了必须重装重编）
    const depsChanged = /package(?:-lock)?\.json\s+\|/.test(pull.stdout)
    let npmLog = null
    if (depsChanged) {
      npmLog = (await execFile('npm', ['ci', '--omit=dev'], { cwd: __dirname, timeout: 300_000 })).stdout
    }

    console.log(`[${new Date().toLocaleTimeString()}] 🚀 部署触发：${before} → ${after}${depsChanged ? '（依赖已更新）' : ''}`)
    res.json({
      ok: true,
      before,
      after,
      depsUpdated: depsChanged,
      pull: (pull.stdout || '').trim(),
      npm: npmLog ? npmLog.trim().split('\n').slice(-5) : null,
      restarting: true,
    })

    // 响应送达后由脱离进程执行重启（补全 pm2 常见 PATH：全局 bin / nvm）
    spawn('sh', ['-c', [
      'export PATH="$PATH:/usr/local/bin:/usr/bin:/opt/homebrew/bin:$HOME/.npm-global/bin"',
      '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"',
      'sleep 1 && pm2 restart agent-workflow-platform',
    ].join('\n')], { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    console.error(`[${new Date().toLocaleTimeString()}] ⚠ 部署失败：${err.message}`)
    res.status(500).json({ error: '部署失败', detail: (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-10) })
  }
})

// 轻量健康检查：/api/health/live + /api/health/ready（与 /api/health 全量计数互补）
mountHealthRoutes(app, { database: db })


return app
}

// ─── start：副作用集中区（定时器 / 监听 / mTLS）——仅生产启动调用，测试不进 ───
export async function start() {
// P1-C：先绑定一个最小健康端口（live=200 / ready=503），杜绝 openDb 静默卡住时"online 但从不 listen"；
// 再对 openDb 做单次超时 + 指数退避重试；总超时仍失败则显式 process.exit(1) 交 pm2 重启（restart 计数可见）。
let _readyBoot = null
try {
  _readyBoot = await startReadinessBootstrap({ port: PORT, host: '0.0.0.0' })
} catch (e) {
  console.error(`[agent-workflow-platform] 就绪端口绑定失败(${PORT})：${e.message}`)
  process.exit(1)
}
try {
  await openDbWithRetry(() => openDb(), {
    attemptTimeoutMs: Number(process.env.AWP_START_DB_ATTEMPT_TIMEOUT_MS) || 20000,
    maxWaitMs: Number(process.env.AWP_START_DB_MAX_WAIT_MS) || 300000,
    log: (m) => console.error(m),
  })
} catch (e) {
  try { await _readyBoot.close() } catch { /* ignore */ }
  console.error(`[agent-workflow-platform] 启动数据库连接最终失败，退出以便 pm2 重启：${e.message}`)
  process.exit(1)
}
// 库就绪：释放 bootstrap 端口，交由完整 app 正式监听（buildApp 及后台调度为同步装配，间隙亚秒级）
try { await _readyBoot.close() } catch { /* ignore */ }
const app = buildApp()

// ─── §5：后台职责【自动接管】——多控制面共享同一 PG 时后台管家活同一时刻只跑一份；
// 持有者进程崩溃/发版重启后，存活的另一台经会话咨询锁(878701)周期性重抢并自动接管，无需重启。
// 机制见 db/background-owner.js：非 owner 定期 try_lock、owner 保活复验；失去所有权即停全部定时器。
// sqlite 单进程默认独占。run 状态 SSE 桥也归 owner（避免双份重复推流）。一次性任务 fire 前复验所有权。
// worker-coupled 后台（nightly 下单产 blob、dailySweep 杀本机 VM）【只在非 standby 机调度】：备用机无 worker/VM/共享盘，
// 抢到锁也不跑这些（见 db/standby.js；备用机 start-node 设 AWP_STANDBY=1），从根上杜绝跨节点 blob 缺失与主机僵尸 VM。
const BG_INTERVAL_MS = Number(process.env.AWP_BG_OWNER_INTERVAL_MS) || 20000
const IS_STANDBY = isStandbyControlPlane()
let bgActive = false
const bgTimers = []
let bgDayTimer = null
let bgNightTimer = null

function startBackground() {
  if (bgActive) return
  bgActive = true
  const track = (h) => { if (h && typeof h.unref === 'function') h.unref(); bgTimers.push(h); return h }

  // 立即：注册表 reseed + 重启对账 + 超时清扫（接管当刻即执行一轮，随后进入周期）
  ;(async () => {
    try { await reseedSuiteRegistry() } catch (e) { console.error(`[agent-workflow-platform] reseed 失败: ${e.message}`) }
    try {
      const report = await reconcileRuns(db)
      console.log(`[agent-workflow-platform] 接管对账: requeued=${report.requeuedRuns.length} expiredLeases=${report.expiredLeases.length} canceled=${report.canceledRuns.length}`)
    } catch (err) { console.error(`[agent-workflow-platform] 接管对账失败: ${err.message}`) }
    try {
      const stale = await sweepStaleTasks()
      if (stale.closed) console.log(`[agent-workflow-platform] 接管任务超时清扫: ABORTED ${stale.closed} 条（>${stale.maxAgeDays} 天未推进）`)
    } catch (err) { console.error(`[agent-workflow-platform] 接管超时清扫失败: ${err.message}`) }
  })()

  // 周期：对账 + 心跳清扫 + 超时清扫（30s）
  track(setInterval(async () => {
    if (!bgActive) return
    try {
      await reconcileRuns(db)
      await sweepWorkerHeartbeats(db)
      const stale = await sweepStaleTasks()
      if (stale.closed) console.log(`[agent-workflow-platform] 任务超时清扫: ABORTED ${stale.closed}`)
    } catch (err) { console.error(`[agent-workflow-platform] sweep 失败: ${err.message}`) }
  }, 30 * 1000))

  // 每日 05:00 例行清理（自续约；fire 前复验所有权，避免极窄重叠窗口双跑）
  const scheduleDailySweep = () => {
    if (!bgActive) return
    const delay = Math.max(1000, computeNextRunAt(new Date()).getTime() - Date.now())
    bgDayTimer = setTimeout(async () => {
      if (!bgActive) return
      try {
        const res = await dailySweepUnfinishedTasks()
        console.log(
          `[agent-workflow-platform] 🌅 每日05:00任务清理: 未完成 ${res.swept} 个，已结束 ${res.stopped} 个` +
            (res.swept ? `（${res.results.filter((r) => r.ok).map((r) => `${r.repo}/${r.taskId}`).join(', ')}）` : '')
        )
      } catch (err) { console.error(`[agent-workflow-platform] 每日05:00任务清理失败: ${err.message}`) }
      scheduleDailySweep()
    }, delay)
    if (bgDayTimer && typeof bgDayTimer.unref === 'function') bgDayTimer.unref()
  }
  if (!IS_STANDBY) scheduleDailySweep() // 备用机无本地 VM：跳过会杀本机 VM 的每日清理

  // 每日夜间全量回归（默认 03:00；自续约；fire 前复验所有权——夜间不幂等，重复下单会双倍 VM 成本）
  const scheduleNightly = () => {
    if (!bgActive) return
    const hour = Number(process.env.AWP_NIGHTLY_HOUR || 3)
    const delay = Math.max(1000, computeNextRunAt(new Date(), hour).getTime() - Date.now())
    bgNightTimer = setTimeout(async () => {
      if (!bgActive) return
      try {
        if (String(process.env.AWP_NIGHTLY_REGRESSION || 'on') !== 'off') {
          const r = await runNightlyRegression()
          console.log(
            `[agent-workflow-platform] 🌙 夜间全量回归: ${r.ok ? `已下单 ${r.taskId} submission=${r.submissionId} units=${(r.requiredUnits || []).join(',')}` : `失败 ${r.code}: ${r.detail || ''}`}`
          )
        }
      } catch (err) { console.error(`[agent-workflow-platform] 夜间回归失败: ${err.message}`) }
      scheduleNightly()
    }, delay)
    if (bgNightTimer && typeof bgNightTimer.unref === 'function') bgNightTimer.unref()
  }
  if (!IS_STANDBY) scheduleNightly() // 备用机下单会产跨节点不可见 blob：跳过夜间回归

  // 云端 run 状态桥（仅 owner 推流，避免双份重复 audit event）
  {
    const lastRunStatus = new Map()
    const RUN_POLL_MS = Number(process.env.AWP_RUN_SSE_POLL_MS) || 3000
    track(setInterval(async () => {
      if (!bgActive) return
      try {
        const rows = await db.prepare(`
          SELECT r.run_id, r.status, r.unit, r.side, r.repo_id, r.task_instance_id,
                 r.finished_at,
                 ti.external_task_id AS task_id,
                 rep.slug AS repo
          FROM test_runs r
          LEFT JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
          LEFT JOIN repositories rep ON rep.repo_id = r.repo_id
          WHERE r.status IN ('queued', 'active', 'running')
             OR (r.finished_at IS NOT NULL AND r.finished_at >= ?)
          ORDER BY COALESCE(r.finished_at, r.created_at) DESC
          LIMIT 80
        `).all(new Date(Date.now() - 3 * 60 * 1000).toISOString())
        const live = new Set()
        for (const row of rows) {
          live.add(row.run_id)
          const prev = lastRunStatus.get(row.run_id)
          if (prev === row.status) continue
          // 首次看见 queued（服务刚起）不刷屏；状态跃迁才推
          if (prev === undefined && (row.status === 'queued' || row.status === 'running')) {
            lastRunStatus.set(row.run_id, row.status)
            continue
          }
          lastRunStatus.set(row.run_id, row.status)
          const runShort = String(row.run_id).slice(0, 12)
          await recordAuditEvent({
            eventType: 'test_run_status',
            toolName: 'test_run_status',
            method: 'poll',
            repo: row.repo || null,
            taskId: row.task_id || null,
            status: 'ok',
            detail:
              `run ${runShort} ${row.unit}/${row.side || '-'} ` +
              `${prev || 'new'} → ${row.status}` +
              (row.finished_at ? ` @ ${row.finished_at}` : ''),
          })
        }
        if (lastRunStatus.size > 400) {
          for (const id of [...lastRunStatus.keys()]) {
            if (!live.has(id)) lastRunStatus.delete(id)
          }
        }
      } catch (err) { console.error(`[agent-workflow-platform] run-sse poll 失败: ${err.message}`) }
    }, RUN_POLL_MS))
    console.log(`[agent-workflow-platform] run 状态 SSE 桥已启动（${RUN_POLL_MS}ms）`)
  }
}

function stopBackground() {
  if (!bgActive) return
  bgActive = false
  for (const h of bgTimers) { try { clearInterval(h) } catch { /* ignore */ } }
  bgTimers.length = 0
  if (bgDayTimer) { try { clearTimeout(bgDayTimer) } catch { /* ignore */ } bgDayTimer = null }
  if (bgNightTimer) { try { clearTimeout(bgNightTimer) } catch { /* ignore */ } bgNightTimer = null }
  console.log('[agent-workflow-platform] 后台任务已停止（失去所有权 / 下线）')
}

const bgOwner = createBackgroundOwner({
  isPostgres: DB_DIALECT === 'postgres',
  acquireClient: () => db.acquireSessionClient(),
  intervalMs: BG_INTERVAL_MS,
  onAcquire: () => { startBackground() },
  onRelease: () => { stopBackground() },
  log: (m) => console.log(`[agent-workflow-platform] ${m}`),
})
bgOwner.start()
// 进程退出：停轮询（同步部分）；会话锁依靠 PG 后端断连自动释放，另一台 ≤20s 内自动接管
process.on('exit', () => { try { Promise.resolve(bgOwner.stop()).catch(() => {}) } catch { /* ignore */ } })

// 定期清扫空闲 MCP session（本进程内存会话，须每进程各自跑）；unref 防止定时器阻止进程退出
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) destroySession(id)
  }
}, 10 * 60 * 1000).unref()

app.listen(PORT, () => {
  console.log(`[agent-workflow-platform] listening on http://0.0.0.0:${PORT}`)
  console.log(`[agent-workflow-platform] 看板: http://0.0.0.0:${PORT}/dashboard.html（总览 / 经验库 / 调用流 / 任务 / 知识库）`)
  console.log('[agent-workflow-platform] MCP: POST/GET/DELETE /mcp | audit: GET /api/audit/stream | harness: GET /api/harness/status POST /api/harness/advance')
})

// ─── Runner mTLS 监听（§14.8 workerMtls；配置证书后 header 回退自动关闭）───
if (runnerTlsCert && runnerTlsKey) {
  const https = await import('node:https').then((m) => m.default || m)
  const tlsPort = Number(process.env.AWP_RUNNER_TLS_PORT || 8443)
  const tlsServer = https.createServer({
    cert: readFileSync(runnerTlsCert),
    key: readFileSync(runnerTlsKey),
    ...(runnerTlsCa ? { ca: readFileSync(runnerTlsCa) } : {}),
    requestCert: true,
    rejectUnauthorized: false,
  }, app)
  tlsServer.listen(tlsPort, () => {
    console.log(`[agent-workflow-platform] runner mTLS listening on https://0.0.0.0:${tlsPort}`)
  })
}
}

// 主模块守卫：直接执行或 pm2 fork（argv[1]=ProcessContainerFork.js）才启动服务；被 import（测试）时只暴露 buildApp/start
const entryIsSelf = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
const launchedByPm2 = process.env.pm_id != null && process.env.pm_exec_path != null
if (entryIsSelf || launchedByPm2) {
  await start()
}
