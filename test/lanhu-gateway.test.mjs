/**
 * 蓝湖设计网关（2026-09-26）：本地 mock Streamable HTTP MCP 服务
 * 验证：握手/工具列表过滤/白名单拦截/name 透传（强制取调用者身份）/结果提取
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'

let server = null
let baseUrl = ''
const seen = { names: [], calls: [] }

function jsonRpc(res, id, result) {
  res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'mock-session-1' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    seen.names.push(url.searchParams.get('name'))
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let msg = {}
      try { msg = JSON.parse(body || '{}') } catch { msg = {} }
      if (msg.method === 'initialize') {
        return jsonRpc(res, msg.id, {
          protocolVersion: msg.params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-lanhu', version: '1.0.0' },
        })
      }
      if (String(msg.method || '').startsWith('notifications/')) {
        res.writeHead(202); return res.end()
      }
      if (msg.method === 'tools/list') {
        const schema = { type: 'object', properties: {}, additionalProperties: true }
        return jsonRpc(res, msg.id, {
          tools: [
            { name: 'lanhu_get_designs', description: '设计图列表', inputSchema: schema },
            { name: 'lanhu_get_design_slices', description: '切图', inputSchema: schema },
            { name: 'lanhu_say_delete', description: '不应出现在白名单', inputSchema: schema },
          ],
        })
      }
      if (msg.method === 'tools/call') {
        seen.calls.push({ tool: msg.params?.name, args: msg.params?.arguments })
        return jsonRpc(res, msg.id, { content: [{ type: 'text', text: `DESIGN_OK:${msg.params?.name}` }], isError: false })
      }
      res.writeHead(400); res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${server.address().AddressInfo?.port || server.address().port}/mcp`
  process.env.AWP_LANHU_MCP_URL = baseUrl
})

afterAll(async () => {
  const { resetLanhuClients } = await import('../testing/lanhu-gateway.js')
  resetLanhuClients()
  server?.close()
})

describe('lanhu-gateway（服务端 MCP 代理）', () => {
  it('listTools 只暴露白名单内的设计工具', async () => {
    const { lanhuListTools, resetLanhuClients } = await import('../testing/lanhu-gateway.js')
    resetLanhuClients()
    const tools = await lanhuListTools('alice')
    const names = tools.map((t) => t.name)
    expect(names).toContain('lanhu_get_designs')
    expect(names).toContain('lanhu_get_design_slices')
    expect(names).not.toContain('lanhu_say_delete')
  })

  it('callTool 白名单转发 + name 透传调用者身份 + 文本提取', async () => {
    const { lanhuCallTool } = await import('../testing/lanhu-gateway.js')
    const r = await lanhuCallTool('alice', 'lanhu_get_designs', { url: 'https://lanhuapp.com/d/1' })
    expect(r.content).toBe('DESIGN_OK:lanhu_get_designs')
    expect(r.isError).toBe(false)
    expect(seen.names.at(-1)).toBe('alice')
    expect(seen.calls.at(-1).args.url).toBe('https://lanhuapp.com/d/1')
  })

  it('白名单外的工具（写类/未知）直接拒绝', async () => {
    const { lanhuCallTool } = await import('../testing/lanhu-gateway.js')
    await expect(lanhuCallTool('alice', 'lanhu_say_delete', {})).rejects.toThrow(/LANHU_TOOL_FORBIDDEN/)
    await expect(lanhuCallTool('alice', 'not_a_lanhu_tool', {})).rejects.toThrow(/LANHU_TOOL_FORBIDDEN/)
  })

  it('不同 username 使用不同连接身份', async () => {
    const { lanhuCallTool } = await import('../testing/lanhu-gateway.js')
    await lanhuCallTool('bob', 'lanhu_get_design_overview', {})
    expect(seen.names.at(-1)).toBe('bob')
  })
})
