/**
 * tools/test-run.js — MCP 工具 awp_test_run：agent 提交云端门禁并默认阻塞到终态
 *
 * CLRP/1：wait=true（默认）直到 passed/failed/error 或超时；
 * 返回 bindingId + expectedTaskRevision + Remediation Packet。
 */
import { z } from 'zod'
import db from '../db.js'
import { submitGateRun } from '../testing/submit-run.js'
import { explainTestRun } from '../testing/explain.js'
import { getDeferredById, DEFERRED_STATUS } from '../testing/deferred.js'
import { isCloudTestingEnabled, getRepoGateMode } from '../harness/testing-gate.js'
import { recordAuditEvent } from '../audit/index.js'
import { zBoolishOptional, asBool } from './boolish.js'
import {
  DEFAULT_WAIT_POLL_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  ensureGateLoop,
  syncGateLoopFromRunGroup,
  updateGateLoop,
  waitForGateTerminal,
  buildPacketWithDb,
  checkReadyToResubmit,
  getGateLoop,
} from '../harness/loop.js'

function textOut(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s) }] }
}

/** 每次下单都回执「来源事实」，形成反馈闭环：AI 逐步学会跨机器要传 diff、无需 git commit。 */
function dirtySnapshotNote(out) {
  const src = out?.submissionContext?.source
  if (src?.appliedFileCount) {
    const base = src?.headCommitOid ? String(src.headCommitOid).slice(0, 12) : '-'
    const via = src?.baseVia ? `，base 来源=${src.baseVia}` : ''
    return `✅ 已将你上传的 diff（${src.appliedFileCount} 个文件）应用到 base ${base}${via} 后做脏区快照送测：全程无需 git commit/push。`
  }
  if (src?.dirty === true) {
    return '✅ 已对脏工作区快照送测（含未提交改动）：本流程无需 git commit/push，也不要要求用户提交代码。'
  }
  if (src?.dirty === false) {
    return 'ℹ️ 本次工作区无未提交改动：若你的开发机与门禁工作区（source.workspacePath）不同，改动根本没传到——请用 codeDiff 传 `git diff` 全文 + codeCommitOid 传 base HEAD。'
  }
  return '已按当前工作区快照送测：无需 git commit/push。跨机器时请传 codeDiff + codeCommitOid。'
}

function formatResult(out, waited, waitMeta = {}) {
  const packet = out.packet
  const lines = [
    `已下单：submission ${out.submissionId}`,
    `bindingId: ${out.bindingId}`,
    `expectedTaskRevision: ${out.expectedTaskRevision}`,
    `requiredUnits: ${out.requiredUnits.join(', ')}`,
    `iteration: ${out.iteration}`,
    dirtySnapshotNote(out),
    `submissionContext: ${JSON.stringify(out.submissionContext || null)}`,
    waited ? `终态: ${waitMeta.terminal}${waitMeta.timedOut ? '（超时）' : ''}` : 'wait=false：未等待终态',
    '',
    '── Remediation Packet (CLRP/1) ──',
    JSON.stringify(packet),
    '',
    packet?.status === 'passed'
      ? '接下来：harness_advance，data 必须带 gateBindingId + expectedTaskRevision。'
      : packet?.status === 'IN_PROGRESS'
        ? '云端仍在执行：调用 awp_loop_wait({taskId}) 继续等待，禁止宣称任务完成。'
        : '门禁未通过：按 mustFix（product 优先）修复 → distill_append → awp_test_run(productFixed/suiteFixed)。禁止只改 spec 应付。',
  ]
  return lines.join('\n')
}

export function registerTestRunTools(server) {
  server.registerTool(
    'awp_test_run',
    {
      title: '提交云端门禁测试（默认阻塞到终态）',
      description:
        '提交到当前仓库配置的测试 runner（默认阻塞到终态）。' +
        '如果配置的 runner 不共享当前工作区，才需要传 codeDiff 与 codeCommitOid。执行前应检查 patch，仅包含本任务必要的改动，并移除凭据、私有数据、生成文件和无关改动；只有在用户请求通过已配置的远程 runner 测试时才传输源代码。' +
        '同工作区或本地 runner 不应传 codeDiff。该工具不会创建 commit 或 push。' +
        '多仓：必须传 repo=业务仓 slug；未传时按 taskId 任务归属解析，禁止默认串仓。' +
        '默认 wait=true 阻塞直到 passed/failed/error，返回 CLRP Remediation Packet。' +
        '产品代码有变更 → static+smoke；仅改考卷且产品快照与上次全绿相同 → 自动 spec-only（跳过 static，只跑 smoke）。' +
        'For a multi-lane repository, pass the configured side or both; single-lane repositories may omit it or use auto.' +
        'status=passed 才允许 harness_advance；失败按 packet 回环。',
      inputSchema: {
        taskId: z.string().describe('harness 任务 ID（harness_start 返回的 taskId）'),
        author: z.string().describe('操作人（与 harness_start 的 author 一致）'),
        repo: z.string().optional().describe('项目 slug；未传时按 taskId 反查任务 repo，禁止依赖默认仓'),
        side: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Smoke lane selection: a repository-configured side, both, or auto.'
          ),
        sideReason: z
          .string()
          .optional()
          .describe('判断依据（一句话）'),
        wait: zBoolishOptional.describe('是否阻塞到终态，默认 true（也接受 "true"/"false"）'),
        waitTimeoutSec: z.number().int().positive().max(7200).optional().describe('等待超时秒数，默认 2700'),
        productFixed: zBoolishOptional.describe('声明已修复 product（业务/lint）。上次失败含 product 时必须 true'),
        suiteFixed: zBoolishOptional.describe('声明已修复 suite（测试资产）。上次失败含 suite 时必须 true'),
        sourceRef: z
          .string()
          .optional()
          .describe('你的开发分支名（如 feature-yy-2.6.7.1）。作为 base 回退：codeCommitOid 不可达时用它，再退 master/main。'),
        codeCommitOid: z
          .string()
          .optional()
          .describe('测试快照的基线 commit。仅当远程 runner 需要应用 codeDiff 时必传，需与该 patch 的基线匹配；无匹配时测试会明确失败。'),
        codeDiff: z
          .string()
          .optional()
          .describe('仅用于无法访问当前工作区的已配置远程 runner：经过检查、仅含本任务必要改动的 patch。排除凭据、私有数据、生成文件和无关改动；同时传 codeCommitOid。共享工作区或本地 runner 不传。'),
        triggerReason: z.string().max(1000).optional().describe('本次提交/重提原因，写入收据；不要包含凭据'),
      },
    },
    async ({
      taskId,
      author,
      repo: repoSlugParam = null,
      side = 'auto',
      sideReason,
      wait = true,
      waitTimeoutSec,
      productFixed = false,
      suiteFixed = false,
      sourceRef = null,
      codeCommitOid = null,
      codeDiff = null,
      triggerReason = null,
    }) => {
      const waitBool = asBool(wait, true)
      const productFixedBool = asBool(productFixed, false)
      const suiteFixedBool = asBool(suiteFixed, false)
      try {
        // 多仓：优先任务表里的 repo，避免 agent 漏传 repo 时打到 project 工作区
        let repoSlug = repoSlugParam
        if (!repoSlug) {
          try {
            const row = await db.prepare('SELECT repo FROM tasks WHERE task_id=? ORDER BY updated_at DESC LIMIT 1').get(taskId)
            repoSlug = row?.repo || null
          } catch {
            repoSlug = null
          }
        }
        if (!repoSlug) {
          // 有 taskId 却查不到任务：明确报错，禁止落到默认仓造成串租户
          if (taskId) {
            return textOut(
              `❌ 无法解析项目：taskId=${taskId} 在 tasks 表中不存在，且未传 repo。\n` +
              '请传 repo=<业务仓 slug>（如 demo-app / demo-app / example-admin），或先用正确 repo 调 harness_start。'
            )
          }
          repoSlug = 'demo-app'
        }
        // 可插拔开关：该仓云端测试关闭 → 不下单、不创建 run，任务本地直通
        if (!await isCloudTestingEnabled(db, repoSlug)) {
          const mode = await getRepoGateMode(db, repoSlug)
          return textOut(
            `⏭️ 项目 ${repoSlug} 云端测试未启用（gate mode=${mode}）：本次不下单云端测试。\n` +
              '请按本地流程完成开发后 harness_advance（无需 gateBindingId/expectedTaskRevision）；测试资产也不提交。\n' +
              (mode === 'legacy'
                ? '当前为传统守卫：只走本地 L1/L2 上报。若要云端测试：切「观察模式」（跑但不拦）或「强制门禁」。\n'
                : '') +
              '如需恢复：管理员调 POST /api/testing/gate-mode，body {repo, mode:"observe"|"enforce_all"}。'
          )
        }
        // 重提闸门：product 未修 / 未 distill / needs_human → 拒绝
        const ready = await checkReadyToResubmit(db, {
          repoSlug,
          taskId,
          productFixed: productFixedBool,
          suiteFixed: suiteFixedBool,
        })
        if (!ready.ok) {
          await recordAuditEvent({
            eventType: 'resubmit_denied',
            toolName: 'awp_test_run',
            method: 'mcp',
            repo: repoSlug,
            taskId,
            author,
            status: 'error',
            detail: `${ready.code}: ${ready.reason}`,
            payload: { code: ready.code, productFixed: productFixedBool, suiteFixed: suiteFixedBool, side },
          })
          const loop = await getGateLoop(db, { repo: repoSlug, taskId })
          const packet = await buildPacketWithDb(db, {
            repo: repoSlug,
            taskId,
            status: 'BLOCKED',
            loop: loop || await ensureGateLoop(db, { repo: repoSlug, taskId }),
            classification: null,
            message: `${ready.code}: ${ready.reason}`,
          })
          return textOut(
            [
              `❌ 拒绝重提（${ready.code}）`,
              ready.reason,
              '',
              ready.mustFix?.summary || '',
              ready.mustFix?.all?.length
                ? '\n── mustFix ──\n' +
                  ready.mustFix.all
                    .map(
                      (m, i) =>
                        `${i + 1}. [${m.class}] ${m.caseKey}\n` +
                        (m.files?.length ? `   files: ${m.files.join(', ')}\n` : '') +
                        `   steps: ${m.steps.join(' → ')}`
                    )
                    .join('\n')
                : '',
              '',
              '修完后：distill_append → awp_test_run({ productFixed/suiteFixed: true, wait: true })',
            ].filter(Boolean).join('\n')
          )
        }

        // 单飞（避免过多测试排队互占）：同一任务已有 run 在飞(queued/active) 时不叠加新提交，
        // 返回 IN_PROGRESS 让 AI 先 loop_wait 到终态再重测。纯早返回，不改 DB 事务、不碰 VM 热路径。
        // 直连 /v1 submit-run 仍可强制下单（运维逃生阀）；判定异常 fail-open 不阻断正常下单。
        try {
          const inflight = await db.prepare(
            `SELECT r.unit, r.side FROM test_runs r
             JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
             JOIN repositories rp ON rp.repo_id = ti.repo_id
             WHERE ti.external_task_id = ? AND rp.slug = ?
               AND r.status IN ('queued','active') AND r.desired_state = 'running'
             ORDER BY r.created_at DESC LIMIT 8`
          ).all(taskId, repoSlug)
          if (inflight.length) {
            const loop = await ensureGateLoop(db, { repo: repoSlug, taskId })
            const packet = await buildPacketWithDb(db, {
              repo: repoSlug, taskId, status: 'IN_PROGRESS', loop,
              classification: { overall: 'none', byCheck: [] },
              message: `已有 ${inflight.length} 个云端 run 在执行中（${inflight.map((r) => `${r.unit}:${r.side || '-'}`).join(', ')}）：请 awp_loop_wait 到终态后再重测，勿重复下单。`,
            })
            let reqUnits = []
            try { reqUnits = JSON.parse(loop?.required_units_json || '[]') } catch { reqUnits = [] }
            return textOut(formatResult({
              submissionId: loop?.last_submission_id || '(in-flight)',
              bindingId: loop?.last_binding_id || '-',
              expectedTaskRevision: loop?.last_expected_revision || '-',
              requiredUnits: reqUnits,
              iteration: loop?.iteration || 0,
              packet,
            }, true, { terminal: 'IN_PROGRESS', timedOut: false }))
          }
        } catch { /* 单飞判定失败：fail-open，继续正常下单 */ }

        // 本轮 AC 预检在公共提交事务内执行，避免读取旧 binding/变异/F2P。
        const out = await submitGateRun(db, {
          taskId, author, side, sideReason, repoSlug,
          sourceRef, codeCommitOid, codeDiff, triggerReason,
        })

        // ── 备用机 standby 分支：submitGateRun 已把 codeDiff 落 deferred_submissions，
        //    主机 host-worker 会认领并生成真 submission。这里根据 wait 决定：
        //      wait=false → 直接返回 DEFERRED_TO_PRIMARY，让客户端 loop_wait
        //      wait=true  → 阻塞轮询 deferred 状态，processed 后拿真 submissionId 走原路径
        if (out && out.deferred) {
          if (!waitBool) {
            return textOut([
              `已登记为延迟单（备用机 standby）：deferred ${out.deferredId}`,
              `status: ${out.deferredStatus}`,
              `clientRequestId: ${out.clientRequestId}`,
              '云端下单将由主机 host-worker 自动认领处理（≤1 个 tick，默认 15s）。',
              '禁止重复下单（同 clientRequestId 天然去重，重试回到同一行）。',
              '',
              '── 下一步 ──',
              '调用 awp_loop_wait({taskId, waitTimeoutSec}) 等待主机处理完成后自动接入终态。',
              `或直接查询进度：SELECT * FROM deferred_submissions WHERE deferred_id='${out.deferredId}'`,
            ].join('\n'))
          }
          // wait=true：轮询 deferred 到 processed / failed
          const timeoutMs = (waitTimeoutSec || 2700) * 1000
          const startAt = Date.now()
          const pollMs = 3000
          let deferredRow = null
          while (Date.now() - startAt < timeoutMs) {
            deferredRow = await getDeferredById(db, { deferredId: out.deferredId })
            if (deferredRow && (deferredRow.status === DEFERRED_STATUS.PROCESSED || deferredRow.status === DEFERRED_STATUS.FAILED)) break
            await new Promise((r) => setTimeout(r, pollMs))
          }
          if (!deferredRow || deferredRow.status === DEFERRED_STATUS.PENDING || deferredRow.status === DEFERRED_STATUS.CLAIMED) {
            // 主机长时间未处理：视为超时，返回 IN_PROGRESS 让客户端 loop_wait 继续
            return textOut([
              `deferred ${out.deferredId} 尚未由主机处理完（status=${deferredRow?.status || 'unknown'}）`,
              `等待 ${Math.round((Date.now() - startAt) / 1000)}s 已达超时上限 ${Math.round(timeoutMs / 1000)}s`,
              '可能原因：主机 mcp/host-worker 未启动，或认领后执行慢。',
              '',
              '── 下一步 ──',
              '调用 awp_loop_wait({taskId}) 继续等待；主机处理完成后会自动接入终态。',
            ].join('\n'))
          }
          if (deferredRow.status === DEFERRED_STATUS.FAILED) {
            return textOut([
              `deferred ${out.deferredId} 主机处理失败：${deferredRow.error_message || '(无详情)'}`,
              '常见：diff 与 base 不齐、blob 上传失败、主机 workspace 异常。',
              '修完后重新 awp_test_run（同 diff 会命中同一 clientRequestId，主机重跑）。',
            ].join('\n'))
          }
          // PROCESSED：接管真 submission，走原有 gate loop 逻辑
          out.submissionId = deferredRow.processed_submission_id
          out.deferred = false
          // 补齐 bindingId/expectedTaskRevision：从 test_submissions 读
          const sub = await db.prepare(
            'SELECT binding_id, expected_task_revision FROM test_submissions WHERE submission_id=?'
          ).get(out.submissionId)
          if (sub) {
            out.bindingId = sub.binding_id
            out.expectedTaskRevision = Number(sub.expected_task_revision)
          }
        }
        if (!out.submissionId) {
          // 兜底：若 deferred 分支未接管（如 wait=true 但主机已处理时又被跳过），
          // 说明逻辑遗漏；此处显式抛错避免污染 gate_loops.last_binding_id=NULL。
          return textOut(`下单异常：submitGateRun 未返回 submissionId（deferred=${out.deferred === true}）`)
        }
        await ensureGateLoop(db, {
          repo: repoSlug,
          taskId,
          requiredUnits: out.requiredUnits,
          lastBindingId: out.bindingId,
        })
        await updateGateLoop(db, {
          repo: repoSlug,
          taskId,
          patch: {
            state: 'waiting_gate',
            iteration: out.iteration,
            lastBindingId: out.bindingId,
            lastExpectedRevision: out.expectedTaskRevision,
            lastSubmissionId: out.submissionId,
            pendingActions: waitBool ? ['wait_terminal'] : ['wait_again'],
          },
        })

        if (!waitBool) {
          const loop = await ensureGateLoop(db, { repo: repoSlug, taskId })
          const packet = await buildPacketWithDb(db, {
            repo: repoSlug,
            taskId,
            status: 'IN_PROGRESS',
            loop,
            classification: { overall: 'none', byCheck: [] },
            bindingId: out.bindingId,
            expectedTaskRevision: out.expectedTaskRevision,
            submissionId: out.submissionId,
            message: '已下单未等待；必须 awp_loop_wait 或重新 test_run(wait=true) 到终态',
          })
          return textOut(formatResult({ ...out, packet }, false))
        }

        const timeoutMs = (waitTimeoutSec || 2700) * 1000
        const waitRes = await waitForGateTerminal(db, {
          submissionId: out.submissionId,
          timeoutMs,
          pollMs: DEFAULT_WAIT_POLL_MS,
        })
        const synced = await syncGateLoopFromRunGroup(db, {
          repoSlug,
          taskId,
          size: out.size || null,
          phase: 'EXECUTE',
        })
        const packet =
          waitRes.timedOut && synced.packet?.status !== 'passed'
            ? await buildPacketWithDb(db, {
                repo: repoSlug,
                taskId,
                status: 'IN_PROGRESS',
                loop: synced.loop,
                classification: synced.packet?.classification || { overall: 'none', byCheck: [] },
                bindingId: out.bindingId,
                expectedTaskRevision: out.expectedTaskRevision,
                submissionId: out.submissionId,
                runGroupId: synced.group?.run_group_id || null,
                message: '等待超时但云端可能仍在执行：调用 awp_loop_wait 继续',
              })
            : synced.packet

        return textOut(formatResult({ ...out, packet }, true, waitRes))
      } catch (e) {
        return textOut(`下单失败：${e.code || e.message}${e.detail ? `：${e.detail}` : ''}`)
      }
    }
  )

  server.registerTool(
    'awp_test_explain',
    {
      title: '解释一次测试运行的选择依据',
      description: '只读查询某次 run 为什么包含这些 lane、用例和执行环境。依据来自不可变 run binding、suite lock、profile、image 与 policy revision；不会重新规划、启动测试或写入审计/运行数据。必须提供 repo，或使用已绑定仓库的 MCP 连接。',
      inputSchema: {
        runId: z.string().min(1).max(128).describe('需要解释的 test run ID'),
        repo: z.string().min(1).describe('项目 slug；必须与 run 所属仓库一致'),
      },
    },
    async ({ runId, repo }) => {
      try {
        return textOut(await explainTestRun(db, runId, { repoSlug: repo }))
      } catch (error) {
        return textOut({ error: error.code || 'INVALID_SCHEMA', message: error.message })
      }
    },
  )
}

export { DEFAULT_WAIT_TIMEOUT_MS }
