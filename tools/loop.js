/**
 * tools/loop.js — CLRP 闭环工具：awp_loop_wait / awp_loop_resume / awp_loop_sessions
 */
import { z } from 'zod'
import db from '../db.js'
import {
  DEFAULT_WAIT_POLL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  ensureGateLoop,
  getActiveTaskSession,
  getGateLoop,
  grantGateRetryBudget,
  listResumableTasks,
  acquireTaskSession,
  syncGateLoopFromRunGroup,
  updateGateLoop,
  waitForGateTerminal,
} from '../harness/loop.js'
import { harnessStatus } from '../harness/state-machine.js'
import { acquireOrHeartbeatSession, isStrictSessionEnabled } from '../harness/session-guard.js'

function textOut(obj) {
  return { content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] }
}

export function registerLoopTools(server) {
  server.registerTool(
    'awp_loop_wait',
    {
      title: '阻塞等待云端门禁终态',
      description:
        '对已下单任务阻塞轮询直到 formal run_group 为 passed/failed/error 或超时。' +
        '云端未完成时禁止结束会话并宣称任务完成。返回 CLRP Remediation Packet。',
      inputSchema: {
        taskId: z.string().describe('harness 任务 ID'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        waitTimeoutSec: z.number().int().positive().max(7200).optional().describe('超时秒数，默认 2700'),
      },
    },
    async ({ taskId, repo: repoParam = null, waitTimeoutSec }) => {
      try {
        let repo = repoParam
        if (!repo) {
          try {
            const row = await db.prepare('SELECT repo FROM tasks WHERE task_id=? ORDER BY updated_at DESC LIMIT 1').get(taskId)
            repo = row?.repo || 'demo-app'
          } catch {
            repo = 'demo-app'
          }
        }
        const loop = await getGateLoop(db, { repo, taskId }) || await ensureGateLoop(db, { repo, taskId })
        if (!loop.lastSubmissionId) {
          const synced = await syncGateLoopFromRunGroup(db, { repoSlug: repo, taskId, size: loop.size })
          return textOut(synced.packet)
        }
        // P2-2：服务端阻塞窗夹到"客户端安全窗"（默认 55s），未到终态即返回游标 + nextPollAfterMs，
        // 让调用方自轮询，避免长任务把 MCP 工具调用拖到客户端超时（call mcp tool timeout）。
        const MAX_BLOCK_MS = Number(process.env.AWP_LOOP_WAIT_MAX_BLOCK_MS || 55000)
        const blockMs = Math.min((waitTimeoutSec || 2700) * 1000, MAX_BLOCK_MS)
        const waitRes = await waitForGateTerminal(db, {
          submissionId: loop.lastSubmissionId,
          timeoutMs: blockMs,
          pollMs: DEFAULT_WAIT_POLL_MS,
        })
        const synced = await syncGateLoopFromRunGroup(db, {
          repoSlug: repo,
          taskId,
          size: loop.size,
          phase: loop.phase || 'EXECUTE',
        })
        if (waitRes.timedOut && synced.packet?.status !== 'passed') {
          return textOut({
            ...synced.packet,
            status: 'IN_PROGRESS',
            terminal: false,
            cursor: { taskId, repo, submissionId: loop.lastSubmissionId },
            nextPollAfterMs: Math.min(DEFAULT_WAIT_POLL_MS * 2, 15000),
            message: `云端仍在执行（本次已阻塞 ${Math.round(blockMs / 1000)}s）：再次调用 awp_loop_wait({taskId}) 续等，禁止宣称完成`,
            completionBlocked: true,
          })
        }
        return textOut(synced.packet)
      } catch (e) {
        return textOut({ ok: false, error: e.message })
      }
    }
  )

  server.registerTool(
    'awp_loop_resume',
    {
      title: '断点续作：恢复未完成门禁闭环任务',
      description:
        'IDE 断线/新会话后调用。返回未完成任务的 gateLoop、pendingActions 与 Remediation Packet。' +
        'resumable=true 时必须按 packet 续作原 taskId，禁止 harness_start 冒充完成，禁止宣称任务已完成。' +
        '迭代耗尽（needs_human）时续作会自动补发 **1 次** 测试机会（不是再给满 5 次），可直接继续 awp_test_run。',
      inputSchema: {
        taskId: z.string().optional().describe('指定任务；省略则列出我名下可续作任务'),
        author: z.string().optional().describe('owner（与 harness_start 一致）；用于过滤会话'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ taskId, author, repo: repoParam = null }) => {
      try {
        let repo = repoParam
        if (taskId && !repo) {
          try {
            const row = await db.prepare('SELECT repo FROM tasks WHERE task_id=? ORDER BY updated_at DESC LIMIT 1').get(taskId)
            repo = row?.repo || 'demo-app'
          } catch {
            repo = 'demo-app'
          }
        }
        if (!repo) repo = 'demo-app'
        if (!taskId) {
          const rows = await listResumableTasks(db, { ownerSubject: author || null, repo, limit: 20 })
          if (!rows.length) {
            return textOut({
              ok: true,
              resumable: false,
              message: '没有可续作的门禁闭环任务，可以 harness_start 开新任务',
            })
          }
          return textOut({
            ok: true,
            resumable: true,
            tasks: rows.map((r) => ({
              taskId: r.task_id,
              owner: r.owner_subject,
              state: r.state || r.session_state,
              iteration: r.iteration,
              maxIterations: r.max_iterations,
              pendingActions: safeJson(r.pending_actions_json),
              needsHuman: Boolean(r.needs_human),
              lastTerminal: r.last_terminal,
              lastClass: r.last_class,
              phase: r.phase,
              size: r.size,
            })),
            hint: '选择一个 taskId 再调 awp_loop_resume({taskId}) 或 harness_status({taskId})',
          })
        }
        const status = await harnessStatus({ taskId, repo })
        if (!status.ok) return textOut(status)
        // 先领租约，再决定是否补发预算（预算仅允许 session owner 触发）
        if (author) {
          const acquired = await acquireOrHeartbeatSession(db, {
            repo,
            taskId,
            author,
            state: status.gateLoop?.state || 'coding',
          })
          if (acquired && acquired.ok === false) {
            return textOut({
              ok: false,
              error: acquired.error || 'TASK_SESSION_HELD',
              code: 'TASK_SESSION_HELD',
              owner: acquired.owner || null,
              expiresAt: acquired.expiresAt || null,
              hint: `任务当前由 ${acquired.owner} 驱动；等待其释放或由管理员 takeover`,
            })
          }
        }
        // 迭代 5 次用完后：续作即解锁，补发预算，AICoding 可继续下单云端测试
        let retryBudget = null
        if (status.gateLoop?.needsHuman) {
          const active = await getActiveTaskSession(db, { repo, taskId })
          const isOwner = !active || !author || active.owner_subject === author
          if (!isOwner && await isStrictSessionEnabled(db)) {
            return textOut({
              ok: false,
              error: 'TASK_SESSION_HELD',
              code: 'TASK_SESSION_HELD',
              owner: active.owner_subject,
              hint: '补发测试预算仅允许当前 session owner 触发',
            })
          }
          retryBudget = await grantGateRetryBudget(db, {
            repo,
            taskId,
            actor: author || 'awp_loop_resume',
          })
        }
        const after = retryBudget?.loop
          ? await harnessStatus({ taskId, repo })
          : status
        return textOut({
          ok: true,
          taskId,
          phase: after.phase,
          completionBlocked: after.completionBlocked,
          resumable: after.resumable,
          gateLoop: after.gateLoop,
          resume: after.resume,
          retryBudget: retryBudget
            ? {
                granted: retryBudget.granted,
                waiverId: retryBudget.waiverId || null,
                added: retryBudget.added || 0,
                maxIterations: retryBudget.maxIterations || after.gateLoop?.maxIterations,
                note: retryBudget.granted
                  ? `已补发 ${retryBudget.added} 次测试机会，当前 ${after.gateLoop?.iteration}/${after.gateLoop?.maxIterations}，可继续 awp_test_run；再耗尽需再次续作`
                  : retryBudget.reason,
              }
            : null,
          session: await getActiveTaskSession(db, { repo, taskId })
            ? {
                owner: (await getActiveTaskSession(db, { repo, taskId })).owner_subject,
                expiresAt: (await getActiveTaskSession(db, { repo, taskId })).expires_at,
              }
            : null,
          hint: after.hint,
        })
      } catch (e) {
        return textOut({ ok: false, error: e.message })
      }
    }
  )

  server.registerTool(
    'awp_loop_sessions',
    {
      title: '列出活跃任务租约',
      description: '运维/排障：查看谁在持有未完成任务租约。',
      inputSchema: {
        repo: z.string().optional(),
      },
    },
    async ({ repo = 'demo-app' }) => {
      const rows = await listResumableTasks(db, { repo, limit: 50 })
      return textOut({ ok: true, sessions: rows })
    }
  )
}

function safeJson(s) {
  try {
    return JSON.parse(s || '[]')
  } catch {
    return []
  }
}

export { updateGateLoop }
