/**
 * testing/lanhu-gateway.js — 蓝湖设计 MCP 服务端网关（2026-09-26）
 *
 * 形态（已实测验证）：Lanhu Axure Extractor 部署在 Docker，Streamable HTTP + SSE，
 * initialize 会话正常、任意 name 接受、17 个工具。平台作为 MCP Client 代理其**设计类读取工具**。
 *
 * 身份：name 强制取 MCP 连接 username（谁调用就以谁的身份，不接受工具参数伪造）。
 * 白名单：仅设计类读取工具（PRD 组对当前租户无用、say_* 写类默认排除）。
 * 降级：远端不可达 → 明确报错 + 提示可暂用 IDE 侧直连兜底；连接缓存 TTL + 失效重建。
 *
 * 配置：AWP_LANHU_MCP_URL（默认 off，显式配置后才连接）、
 *       AWP_LANHU_MCP_ROLE（默认 Frontend）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExtensionError } from '../extensions/contracts.js'

const DEFAULT_URL = 'off'
const DEFAULT_ROLE = 'Frontend'
const CLIENT_TTL_MS = 10 * 60_000
const MAX_OUTPUT_CHARS = 60_000

export const LANHU_TOOL_WHITELIST = new Set([
  'lanhu_resolve_invite_link',
  'lanhu_get_designs',
  'lanhu_get_design_overview',
  'lanhu_get_design_structure',
  'lanhu_get_design_slices',
  'lanhu_inspect_design_region',
  'lanhu_export_design_assets',
  'lanhu_get_ai_analyze_design_result',
])

export function lanhuConfigured() {
  return String(process.env.AWP_LANHU_MCP_URL || DEFAULT_URL).trim() !== 'off'
}

function lanhuBaseUrl() {
  const url = String(process.env.AWP_LANHU_MCP_URL || DEFAULT_URL).trim()
  if (url === 'off') throw new ExtensionError('EXTENSION_OPERATION_UNSUPPORTED', 'No Lanhu DesignSource is configured')
  return url
}

const clients = new Map() // username -> { client, at }

export function resetLanhuClients() {
  for (const { client } of clients.values()) {
    try { client.close() } catch { /* ignore */ }
  }
  clients.clear()
}

async function getClient(username, { timeoutMs = 8000 } = {}) {
  const key = String(username || 'anonymous').slice(0, 80)
  const hit = clients.get(key)
  if (hit && Date.now() - hit.at < CLIENT_TTL_MS) return hit.client
  if (hit) {
    try { await hit.client.close() } catch { /* ignore */ }
    clients.delete(key)
  }
  const url = `${lanhuBaseUrl()}?role=${encodeURIComponent(String(process.env.AWP_LANHU_MCP_ROLE || DEFAULT_ROLE))}&name=${encodeURIComponent(key)}`
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'devweft', version: '0.1.0' })
  await client.connect(transport, { timeoutMs })
  clients.set(key, { client, at: Date.now() })
  return client
}

/** 列出白名单内的远端工具（名称+用途摘要） */
export async function lanhuListTools(username, { timeoutMs = 8000 } = {}) {
  const client = await getClient(username, { timeoutMs })
  const { tools } = await client.listTools(undefined, { timeoutMs })
  return (tools || [])
    .filter((t) => LANHU_TOOL_WHITELIST.has(t.name))
    .map((t) => ({ name: t.name, description: String(t.description || '').split('\n').slice(0, 3).join(' ').slice(0, 300) }))
}

/** 白名单转发一次工具调用；结果提取文本并做体积守卫；连接失效自动重建重试一次 */
export async function lanhuCallTool(username, tool, args = {}, { timeoutMs = 45_000 } = {}) {
  if (!LANHU_TOOL_WHITELIST.has(String(tool))) {
    throw Object.assign(new Error(`LANHU_TOOL_FORBIDDEN: ${tool} 不在白名单（可用：${[...LANHU_TOOL_WHITELIST].join('、')}）`), { code: 'LANHU_TOOL_FORBIDDEN' })
  }
  const call = async (client) => client.callTool({ name: String(tool), arguments: args || {} }, undefined, { timeoutMs })
  let result
  try {
    result = await call(await getClient(username, { timeoutMs: 8000 }))
  } catch (e) {
    // 会话可能过期/失效：丢缓存重建再试一次
    clients.delete(String(username || 'anonymous').slice(0, 80))
    result = await call(await getClient(username, { timeoutMs: 8000 }))
  }
  const texts = (result?.content || []).filter((c) => c?.type === 'text').map((c) => String(c.text || ''))
  let out = texts.join('\n')
  const truncated = out.length > MAX_OUTPUT_CHARS
  if (truncated) out = out.slice(0, MAX_OUTPUT_CHARS) + '\n…[已截断：完整结果请缩小查询范围（单页/单区域）]'
  return { content: out, isError: Boolean(result?.isError), truncated, chars: out.length }
}

/** Provider seam; callers may inject a different DesignSource with the same listTools/callTool contract. */
export const genericDesignSource = Object.freeze({
  id: 'generic',
  async listTools() { return [] },
  async callTool() { throw new ExtensionError('EXTENSION_OPERATION_UNSUPPORTED', 'No design source is configured') },
})

export const lanhuDesignSource = Object.freeze({
  id: 'lanhu-mcp',
  listTools: lanhuListTools,
  callTool: lanhuCallTool,
})
