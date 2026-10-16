/**
 * harness.js — Harness MCP 工具（团队共享状态机，IDE 无关）
 */
import { z } from 'zod'
import { harnessStart, harnessStatus, harnessAdvance } from '../harness/state-machine.js'
import { attachTaskAsset, listTaskAttachments } from '../harness/attachments.js'
import { zBoolishOptional, asBool } from './boolish.js'
import { recordAuditEvent } from '../audit/index.js'

function asMcp(result) {
  if (!result || result.ok !== false) return result
  return {
    ok: false,
    code: result.code || result.error || 'BLOCKED',
    blockedBy: result.blockedBy || [],
    nextTool: 'harness_status',
    // CLRP Remediation Packet 完整透传：失败时的返工指引必须到达 AI（与 REST 通道一致，2026-09-26）
    packet: result.packet || null,
    message: typeof result.error === 'string' ? result.error : (result.packet?.message || null),
  }
}

function textResult(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }
}

export function registerHarnessTools(server) {
  server.registerTool(
    'harness_start',
    {
      title: '开启 Harness 任务',
      description:
        'Use this to open a new tracked task (phase=RECEIVE). Resume an unfinished task with harness_status. ' +
        'Returns taskId and harness_status/contextPack. ' +
        'If ok=false task exists, use harness_status to resume instead of starting again.',
      inputSchema: {
        requirement: z.string().describe('需求原文（禁止把旧 taskId 写进正文当关联；续作用 harness_status）'),
        type: z
          .enum(['FEATURE', 'UI_DEV', 'FIX', 'INTEGRATION', 'RELEASE'])
          .optional()
          .describe('任务类型，默认 FEATURE'),
        taskId: z.string().optional().describe('自定义任务 id（可空，自动生成）'),
        author: z.string().describe('操作人（必填）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        forceNew: zBoolishOptional.describe('显式并行新任务时 true（绕过同需求未终态防重；一般续作请用 harness_status）'),
      },
    },
    async ({ requirement, type = 'FEATURE', taskId, author, repo = 'demo-app', forceNew = false }) => {
      const result = await harnessStart({
        taskId,
        requirement,
        type,
        author,
        repo,
        forceNew: asBool(forceNew, false),
      })
      try {
        recordAuditEvent({
          eventType: result.ok ? 'harness_start_created' : 'harness_start_rejected',
          toolName: 'harness_start',
          method: 'mcp',
          repo,
          taskId: result.taskId || result.existingTaskId || taskId || null,
          author,
          status: result.ok ? 'ok' : 'error',
          detail: result.ok
            ? `created ${result.taskId}${result.autoId ? ' (autoId)' : ''}`
            : `${result.code || 'REJECTED'}: ${String(result.error || '').slice(0, 160)}`,
          payload: {
            code: result.code || null,
            existingTaskId: result.existingTaskId || null,
            matchReason: result.matchReason || null,
            autoId: Boolean(result.autoId),
          },
        })
      } catch { /* 审计失败不阻断 */ }
      return textResult(asMcp(result))
    }
  )

  server.registerTool(
    'harness_status',
    {
      title: '查询 Harness 任务状态',
      description:
        'Query phase, allowed next hops, and contextPack (required docs + step instructions). ' +
        'MUST call this before resuming an unfinished task (resumable=true) instead of harness_start. ' +
        'Use contextPack for task-phase and gate state; follow applicable repository instructions for code style, tests, and security. ' +
        'Only phase=DONE allows claiming the task is complete.',
      inputSchema: {
        taskId: z.string().describe('任务 id'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ taskId, repo = 'demo-app' }) => {
      const result = await harnessStatus({ taskId, repo, view: 'mcp' })
      return textResult(asMcp(result))
    }
  )

  server.registerTool(
    'harness_advance',
    {
      title: '推进 Harness 阶段（唯一合法改 phase 入口）',
      description:
        'ONLY legal way to change harness phase (gates validated). Never use task_state to set phase. ' +
        'Requires an active harness session (harness_start/status first). ' +
        'Leaving EXECUTE: pass gateBindingId and expectedTaskRevision from awp_test_run. ' +
        'On failure, follow the remediation packet. Do not claim completion until required configured checks have passed and the task is in its terminal phase. ' +
        'to must be a value from harness_status.allowedTransitions (retrieve/plan/execute/static/smoke/distill/done/aborted). ' +
        'Do not send legacy phase names such as CLASSIFY or EXECUTE.',
      inputSchema: {
        taskId: z.string().describe('任务 id'),
        to: z
          .enum([
            'retrieve',
            'plan',
            'execute',
            'static',
            'smoke',
            'distill',
            'done',
            'aborted',
          ])
          .describe('下一活动，必须与 harness_status.allowedTransitions[].to 一致'),
        data: z
          .record(z.any())
          .optional()
          .describe(
            '合并字段：size(S/M/L) / pending[] / decisions[] / completed[] / l3Confirmed / reason(abort) / gateBindingId / expectedTaskRevision。禁止让用户执行测试平台命令；测试由 Harness 控制。'
          ),
        author: z.string().describe('操作人（必填）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ taskId, to, data = {}, author, repo = 'demo-app' }) => {
      const result = await harnessAdvance({ taskId, to, data, author, repo, view: 'mcp' })
      return textResult(asMcp(result))
    }
  )

  server.registerTool(
    'awp_task_attach',
    {
      title: '挂载任务材料（需求/接口/设计）',
      description:
        '把需求文档/接口文档/设计稿引用挂到任务上（平台持久化，随每个活动注入 contextPack）。' +
        '跨机器场景必须传 content（文档全文或要点），不能传本地文件路径；蓝湖等外部链接传 url。' +
        'kind：requirement=需求文档 / api=接口文档 / design=设计稿引用 / other。' +
        '传了 taskId 的任务在 plan 阶段可据此草拟 AC，DONE 交付包也会引用。',
      inputSchema: {
        taskId: z.string().describe('任务 id'),
        kind: z.enum(['requirement', 'api', 'design', 'other']).describe('材料类型'),
        title: z.string().optional().describe('材料标题（如"XX需求文档 v2"）'),
        content: z.string().optional().describe('文档全文或要点（文本/markdown；跨机器场景唯一通道）'),
        url: z.string().optional().describe('外部链接（如蓝湖设计稿链接）；content 与 url 至少传一个'),
        author: z.string().describe('操作人（服务端强制取连接 username）'),
        repo: z.string().optional().describe('项目 slug'),
      },
    },
    async ({ taskId, kind, title = null, content = null, url = null, author, repo = 'demo-app' }) => {
      try {
        const r = attachTaskAsset({ repo, taskId, kind, title, content, url, author })
        return textResult(JSON.stringify({
          ok: true, ...r,
          hint: '已随任务持久化；后续每个活动的 contextPack 会自动带上摘要，全文用 awp_task_attach_list 获取。',
        }))
      } catch (e) {
        return textResult(`❌ 挂载失败：${e.message}`)
      }
    }
  )

  server.registerTool(
    'awp_task_attach_list',
    {
      title: '读取任务材料全文',
      description: '读取任务挂载的需求/接口/设计材料全文（contextPack 里只有摘要）。开发前必读 requirement 类材料。',
      inputSchema: {
        taskId: z.string().describe('任务 id'),
        repo: z.string().optional().describe('项目 slug'),
      },
    },
    async ({ taskId, repo = 'demo-app' }) => {
      const rows = listTaskAttachments(repo, taskId)
      if (!rows.length) return textResult('该任务暂无挂载材料（开发者可直接把需求文档内容用 awp_task_attach 传上来）。')
      return textResult(JSON.stringify(rows))
    }
  )
}
