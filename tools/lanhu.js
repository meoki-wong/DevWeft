/**
 * tools/lanhu.js — 蓝湖设计 MCP 服务端代理工具（2026-09-26）
 *
 * awp_design_tools：列出白名单内的蓝湖工具（帮 AI 选）
 * awp_design_call ：白名单转发调用；name 强制取连接 username（AUTHOR_TOOLS 注入）；
 *                    传 taskId 时自动把结果摘要挂为 design 附件（任务资产化）
 * 降级：服务不可达时明确提示可暂用 IDE 侧直连 Lanhu MCP 兜底
 */
import { z } from 'zod'
import { lanhuConfigured, lanhuListTools, lanhuCallTool, LANHU_TOOL_WHITELIST } from '../testing/lanhu-gateway.js'
import { attachTaskAsset } from '../harness/attachments.js'
import { recordAuditEvent } from '../audit/index.js'

function textOut(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] }
}

const FALLBACK_HINT = '\n（蓝湖服务不可达时可暂用 IDE 侧直连 Lanhu MCP 兜底）'

export function registerLanhuTools(server) {
  server.registerTool(
    'awp_design_tools',
    {
      title: '列出蓝湖设计工具',
      description:
        '列出服务端蓝湖设计网关白名单内的工具（get_designs/structure/slices/inspect_region/export_assets 等）。' +
        '要用 awp_design_call 调用前先看这里。服务不可达时返回明确提示。',
      inputSchema: {
        author: z.string().optional().describe('操作人（服务端强制取连接 username）'),
      },
    },
    async ({ author }) => {
      if (!lanhuConfigured()) return textOut('蓝湖设计网关未启用（设置 AWP_LANHU_MCP_URL）。' + FALLBACK_HINT)
      try {
        const tools = await lanhuListTools(author)
        if (!tools.length) return textOut('蓝湖网关已连通，但白名单内没有可用工具。' + FALLBACK_HINT)
        return textOut(
          '蓝湖设计工具（服务端代理，白名单）：\n' +
          tools.map((t) => `· ${t.name} — ${t.description}`).join('\n') +
          '\n\n调用：awp_design_call({ tool, args, taskId? })；args 通常是 { url: <蓝湖链接> }'
        )
      } catch (e) {
        return textOut(`❌ 蓝湖设计服务不可达：${e.message}` + FALLBACK_HINT)
      }
    }
  )

  server.registerTool(
    'awp_design_call',
    {
      title: '获取蓝湖设计信息（服务端代理）',
      description:
        '调用蓝湖设计 MCP 白名单工具：设计图清单/结构/切图/区域标注/导出资产。' +
        'name 强制取你的连接 username（不可伪造身份）。传 taskId 时结果摘要自动挂为任务 design 附件。' +
        '结果过大时自动截断——建议按单页/单区域逐步查询。',
      inputSchema: {
        tool: z.string().describe('蓝湖工具名（先 awp_design_tools 查可用清单）'),
        args: z.record(z.any()).optional().describe('工具入参（通常是 { url: <蓝湖链接> }）'),
        taskId: z.string().optional().describe('任务 id：传了则把结果摘要挂为 design 附件，AC 草拟与 UI 验收可引用'),
        repo: z.string().optional().describe('项目 slug（挂附件用）'),
        author: z.string().optional().describe('操作人（服务端强制取连接 username）'),
      },
    },
    async ({ tool, args = {}, taskId = null, repo = 'demo-app', author }) => {
      if (!lanhuConfigured()) return textOut('蓝湖设计网关未启用（设置 AWP_LANHU_MCP_URL）。' + FALLBACK_HINT)
      const user = String(author || 'anonymous').slice(0, 80)
      try {
        const r = await lanhuCallTool(user, tool, args)
        try {
          recordAuditEvent({
            eventType: 'lanhu_design_call',
            toolName: 'awp_design_call',
            method: 'mcp',
            repo,
            taskId,
            author: user,
            status: r.isError ? 'error' : 'ok',
            detail: `${tool} chars=${r.chars}${r.truncated ? ' truncated' : ''} argsKeys=${Object.keys(args || {}).join('|')}`,
            payload: { tool, truncated: r.truncated },
          })
        } catch { /* 审计失败不阻断 */ }
        if (taskId && !r.isError) {
          try {
            attachTaskAsset({
              repo, taskId, kind: 'design',
              title: `蓝湖：${tool}`,
              url: args?.url ? String(args.url).slice(0, 500) : null,
              content: r.content.slice(0, 4000),
              author: user,
            })
          } catch { /* 挂载失败不影响返回 */ }
        }
        return textOut(r.content + (r.truncated ? '\n[结果已截断：建议缩小查询范围]' : ''))
      } catch (e) {
        try {
          recordAuditEvent({
            eventType: 'lanhu_design_call',
            toolName: 'awp_design_call',
            method: 'mcp',
            repo,
            taskId,
            author: user,
            status: 'error',
            detail: `${tool}: ${String(e.message || e).slice(0, 200)}`,
          })
        } catch { /* ignore */ }
        return textOut(`❌ 蓝湖调用失败：${e.message}` + FALLBACK_HINT)
      }
    }
  )
}

export { LANHU_TOOL_WHITELIST }
