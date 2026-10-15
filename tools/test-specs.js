/**
 * tools/test-specs.js — 测试资产库 MCP 工具（feature-key 模式）
 *
 * 契约前移：工具 description / 返回体内嵌平台 E2E 规则与 golden 模板，
 * 使 AI 写 spec 时不必依赖仓内 md。submit 时服务端静态校验（裸 goto / 缺 side 拒绝）。
 */
import { z } from 'zod'
import {
  submitTestSpec, getTestSpec, listTestSpecs, activeSpecsForRepo, previewImpactedSpecs,
} from '../testing/test-specs.js'
import db from '../db.js'
import { changedFilesForBinding } from '../testing/impact.js'
import { getRepoTestPolicy } from '../testing/repo-policies.js'
import { isCloudTestingEnabled } from '../harness/testing-gate.js'
import { getReviewMode } from '../testing/reviewers.js'
import {
  GOLDEN_E2E_SPEC,
  GOLDEN_UNIT_SPEC,
  SPEC_PLATFORM_RULES,
  formatSpecRulesForAgent,
} from '../testing/spec-contract.js'

const DEFAULT_REPO = 'demo-app'

function textOut(s) {
  return { content: [{ type: 'text', text: s }] }
}

async function contractFooter(repo) {
  let policy
  try {
    policy = await getRepoTestPolicy(db, repo)
  } catch {
    policy = { enforceSpecContract: false }
  }
  if (!policy.enforceSpecContract) {
    return [
      '',
      '── 说明 ──',
      '当前项目未启用 project 专用 E2E 契约校验（repo_test_policies.enforce_spec_contract=0）。',
      '按本项目通用约定编写即可；使用 awp guest 运行时可由管理员开启契约策略。',
    ].join('\n')
  }
  return [
    '',
    '── 平台 E2E 契约（本项目已启用，submit 会校验）──',
    formatSpecRulesForAgent(),
    '',
    '── Golden 模板（可复制修改）──',
    GOLDEN_E2E_SPEC.trim(),
  ].join('\n')
}

function specSummary(spec) {
  const lines = [
    `feature_key: ${spec.feature_key}  v${spec.version}  [${spec.review_status}]`,
    `标题: ${spec.feature_title || '（无）'}  来源需求: ${spec.demand_ref || '（无）'}  作者: ${spec.author}`,
    `类型: ${spec.spec_type}  执行侧: ${spec.side || '双侧'}  最近执行: ${spec.last_result || '（未执行）'}  连续失败: ${spec.fail_streak}`,
  ]
  if (spec.history?.length) lines.push(`历史版本: ${spec.history.map((h) => 'v' + h.version).join(', ')}`)
  return lines.join('\n')
}

export function registerTestSpecTools(server) {
  // 1. lookup：开发改动前先查相关测试资产（强制第一步）
  server.registerTool(
    'awp_test_lookup',
    {
      title: '查找相关测试资产',
      description:
        '开发涉及 UI/页面/业务流程改动时必须先调用：按功能关键词查找已有的测试资产。' +
        '命中则阅读其内容并在开发后同步更新（awp_test_spec_submit 会自动递增版本）；' +
        '未命中则开发完成后用 awp_test_spec_submit 创建。' +
        '写 spec 必须遵守平台契约：run({page,baseURL})、goto 用 baseURL、单侧传 side、优先 data-test。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        featureHint: z.string().describe('功能关键词（如 审核流程/门店列表/登录），支持部分匹配'),
      },
    },
    async ({ repo = DEFAULT_REPO, featureHint }) => {
      const rows = await listTestSpecs({ repoId: repo, featureHint })
      if (!rows.length) {
        return textOut(
          `没有匹配「${featureHint}」的测试资产。\n` +
            `如属全新业务场景，开发完成后用 awp_test_spec_submit 创建` +
            `（featureKey：模块-功能-动作，小写连字符；近义重复会被拒绝）。\n` +
            await contractFooter(repo)
        )
      }
      const body = rows.map((r) => specSummary(r)).join('\n\n')
      return textOut(
        `找到 ${rows.length} 个相关测试资产（提交更新用 awp_test_spec_submit，featureKey 原样传入）：\n\n${body}\n` +
          await contractFooter(repo)
      )
    }
  )

  // 2. get：取完整 spec 内容
  server.registerTool(
    'awp_test_spec_get',
    {
      title: '获取测试资产内容',
      description:
        '按 featureKey 获取测试资产全文（Playwright spec 源码）。用于更新前阅读现有断言。' +
        '返回末尾附平台契约；改完后 awp_test_spec_submit，禁止裸 page.goto。',
      inputSchema: {
        featureKey: z.string().describe('业务功能键（lookup 返回的 feature_key）'),
        repo: z.string().optional().describe('项目标识'),
        version: z.number().optional().describe('历史版本号，缺省取最新'),
      },
    },
    async ({ featureKey, repo = DEFAULT_REPO, version }) => {
      try {
        const spec = await getTestSpec({ repoId: repo, featureKey, version: version || null })
        return textOut(`${specSummary(spec)}\n\n--- spec 内容 ---\n${spec.content}\n` + await contractFooter(repo))
      } catch (e) {
        return textOut(`未找到：${featureKey}（${e.message}）\n` + await contractFooter(repo))
      }
    }
  )

  // 3. submit：创建/更新（幂等：内容未变不产生新版本）
  server.registerTool(
    'awp_test_spec_submit',
    {
      title: '提交测试资产（创建/更新）',
      description:
        '提交测试资产（创建/更新）。同 featureKey 自动 version+1。\n' +
        '【仅 project 等启用 enforce_spec_contract 的项目】submit 会校验平台契约：\n' +
        formatSpecRulesForAgent() +
        '\n【project 模板】\n' +
        GOLDEN_E2E_SPEC +
        '其他项目：默认不强制上述契约，按各自 runner 约定编写。\n' +
        'side（可选）：repository profile 中配置的 lane 名称。更新前先 awp_test_spec_get。',
      inputSchema: {
        featureKey: z.string().describe('业务功能键（模块-功能-动作，小写连字符）'),
        featureTitle: z.string().optional().describe('功能标题（人读）'),
        demandRef: z.string().optional().describe('关联需求标识'),
        specType: z.enum(['e2e', 'smoke', 'unit']).optional().describe('资产类型，默认 e2e'),
        side: z.string().min(1).optional().describe('Repository profile 中配置的 smoke lane 名称'),
        codeCommitOid: z.string().optional().describe('当前业务仓库 HEAD commit'),
        author: z.string().optional().describe('提交者标识（如 developer/wangyongfeng）。缺省记 ai-coding-agent'),
        content: z
          .string()
          .describe(
            'spec 全文。必须 export default async function run({ page, baseURL })；page.goto 用 `${baseURL}/...`'
          ),
        pages: z
          .array(z.string())
          .optional()
          .describe('Pages or source directories covered by this test, used for impact attribution.'),
        acceptanceRefs: z
          .array(z.string())
          .optional()
          .describe('对应任务 AC 清单的 id（如 ["AC-1","AC-2"]），门禁按 AC 覆盖率判定'),
        repo: z.string().optional().describe('项目标识'),
        taskId: z
          .string()
          .optional()
          .describe('harness 任务 ID：传入则考卷先 draft（任务私有），本任务门禁可跑；整组全绿后自动晋升 active'),
      },
    },
    async ({ featureKey, featureTitle, demandRef, specType, side, codeCommitOid, content, author, repo = DEFAULT_REPO, pages, acceptanceRefs, taskId = null }) => {
      try {
        // 可插拔开关：云端测试关闭的仓不创建/更新测试资产（查询类工具不受限）
        if (!await isCloudTestingEnabled(db, repo)) {
          return textOut(
            `❌ 项目 ${repo} 云端测试未启用（gate mode=disabled）：不创建/更新测试资产。\n` +
              '查询类工具（awp_test_lookup / awp_test_spec_get / awp_test_list）仍可用。\n' +
              '如需恢复：管理员调 POST /api/testing/gate-mode，body {repo, mode:"enforce_all"}。'
          )
        }
        const policy = await getRepoTestPolicy(db, repo)
        const spec = await submitTestSpec({
          repoId: repo,
          featureKey,
          featureTitle,
          demandRef,
          taskId,
          author: author || 'ai-coding-agent',
          specType: specType || 'e2e',
          side: policy.enableSides ? (side || null) : null,
          codeCommitOid,
          content,
          pages: pages || null,
          acceptanceRefs: acceptanceRefs || null,
        })
        const reviewLine = taskId
          ? `任务草稿（taskId=${taskId}）：仅本任务门禁注入；正式组全绿后自动晋升 active。不进公共池。`
          : spec.review_status === 'active'
            ? (spec.review_decision === 'rejected'
                ? `已生效，但审核记录到问题（${spec.reviewed_by || ''}）：${spec.review_notes || ''}\n` +
                  `当前档位不阻塞，资产已参与门禁。请按上述问题修正后重新提交。`
                : `已生效（审核者：${spec.reviewed_by || '未记录'}），参与下一次门禁。`)
            : `当前状态 ${spec.review_status}，未参与门禁。审核者：${spec.reviewed_by || '—'}；` +
              `意见：${spec.review_notes || '—'}\n` +
              `如需生效，请由评审人在看板确认，或联系管理员调整该仓的 review_mode。`
        return textOut(
          `已提交：${featureKey} v${spec.version} [${spec.review_status}]（entry: ${spec.entry}，执行侧: ${spec.side || '双侧'}）。\n` +
            reviewLine +
            `\n连续失败 3 次自动 orphan-candidate。` +
            (policy.enforceSpecContract
              ? `\n本项目已启用 E2E 契约；下单 awp_test_run 的 side 应与资产一致。`
              : '')
        )
      } catch (e) {
        const hint =
          e.code === 'INVALID_SPEC_CONTRACT' || String(e.message).includes('INVALID_SPEC_CONTRACT')
            ? `\n\n违反平台契约。请对照模板修复后重试：\n${GOLDEN_E2E_SPEC}\n规则：\n${formatSpecRulesForAgent()}`
            : ''
        return textOut(`提交失败：${e.message}${e.detail ? ` — ${e.detail}` : ''}${hint}`)
      }
    }
  )

  // 4. list：资产清单
  server.registerTool(
    'awp_test_list',
    {
      title: '列出测试资产',
      description: '列出测试资产库清单（可按项目/作者/需求/状态过滤）。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识'),
        author: z.string().optional().describe('按作者过滤'),
        demand: z.string().optional().describe('按需求标识过滤'),
        status: z
          .enum(['draft', 'reviewed', 'active', 'archived', 'orphan-candidate'])
          .optional()
          .describe('按状态过滤'),
      },
    },
    async ({ repo = DEFAULT_REPO, author, demand, status }) => {
      const rows = await listTestSpecs({ repoId: repo, author, demandRef: demand, reviewStatus: status })
      if (!rows.length) return textOut('（无测试资产）')
      return textOut(`共 ${rows.length} 个测试资产：\n\n` + rows.map((r) => specSummary(r)).join('\n\n'))
    }
  )

  // 5. active：runner 执行注入视图
  server.registerTool(
    'awp_test_active_specs',
    {
      title: '查看参与门禁执行的资产',
      description: '列出当前项目下 active 状态、会随 M 级门禁执行的测试资产。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识'),
      },
    },
    async ({ repo = DEFAULT_REPO }) => {
      const rows = await activeSpecsForRepo(repo)
      if (!rows.length) return textOut('（无 active 资产——awp_test_spec_submit 提交后即 active）')
      return textOut(rows.map((r) => `${r.feature_key} v${r.version}（entry: ${r.entry} side=${r.side || 'both'}）`).join('\n'))
    }
  )

  // 6. review_status：查看审核状态（只读，agent 不可改审核结论）
  server.registerTool(
    'awp_test_spec_review_status',
    {
      title: '查看测试资产审核状态',
      description:
        '查看指定 featureKey（或缺省列出全项目待审）的审核状态与审核意见。' +
        '只读工具：审核结论由平台审核链产出，agent 不可修改。' +
        '若状态为 draft/reviewed，说明该资产未参与门禁，需评审人在看板确认。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        featureKey: z.string().optional().describe('业务功能键；缺省则列出全部待审资产'),
        status: z
          .enum(['draft', 'reviewed', 'active', 'archived', 'orphan-candidate'])
          .optional()
          .describe('按状态过滤（仅在未传 featureKey 时生效）'),
      },
    },
    async ({ repo = DEFAULT_REPO, featureKey, status }) => {
      const policy = await getRepoTestPolicy(db, repo)
      const mode = getReviewMode(policy)
      const head = `审核档位：${mode}${policy.enforceSpecContract ? '（契约校验已启用）' : ''}\n`

      if (featureKey) {
        try {
          const s = await getTestSpec({ repoId: repo, featureKey })
          return textOut(
            head +
              `\n${featureKey} v${s.version}  [${s.review_status}]\n` +
              `审核者：${s.reviewed_by || '（未审核）'}\n` +
              `审核时间：${s.reviewed_at || '—'}\n` +
              `审核结论：${s.review_decision || '—'}\n` +
              `审核意见：${s.review_notes || '—'}\n` +
              `最近执行：${s.last_result || '（未执行）'}  连续失败：${s.fail_streak}`
          )
        } catch (e) {
          return textOut(`未找到：${featureKey}（${e.message}）`)
        }
      }

      const rows = await listTestSpecs({ repoId: repo, reviewStatus: status || null })
      const pending = rows.filter((r) => r.review_status === 'draft' || r.review_status === 'reviewed')
      if (!rows.length) return textOut(head + '\n（无测试资产）')
      return textOut(
        head +
          `\n共 ${rows.length} 个资产，其中待审 ${pending.length} 个：\n\n` +
          rows
            .map(
              (r) =>
                `${r.feature_key} v${r.version} [${r.review_status}] ` +
                `${r.review_decision || ''} ${r.review_notes ? '— ' + r.review_notes : ''}`
            )
            .join('\n')
      )
    }
  )
  server.registerTool(
    'awp_impact_preview',
    {
      title: '改动影响面预检',
      description:
        '按改动文件反查哪些 active 考卷的观测路径（pages 声明）会受波及——写码后/送测前调用，' +
        '提前预知本次改动可能影响的老卷。基于卷声明的 pages（未声明 pages 的卷不参与预检）；' +
        'regression 范围的卷全量常跑，会一并列出。',
      inputSchema: {
        repo: z.string().optional().describe('项目 slug'),
        taskId: z.string().optional().describe('任务 id（未传 files 时自动取该任务最近一次送测的改动文件）'),
        files: z
          .array(z.string())
          .max(50)
          .optional()
          .describe('改动文件相对路径列表；传了则优先于 taskId'),
      },
    },
    async ({ repo = 'demo-app', taskId = null, files = null }) => {
      try {
        let list = Array.isArray(files) ? files.filter(Boolean).map(String) : []
        if (!list.length && taskId) {
          try {
            const loop = await db.prepare('SELECT last_binding_id FROM gate_loops WHERE repo=? AND task_id=?').get(repo, String(taskId))
            if (loop?.last_binding_id) list = await changedFilesForBinding(db, loop.last_binding_id) || []
          } catch { /* ignore */ }
        }
        if (!list.length) {
          return textOut('没有改动文件可预检：传 files（改动文件相对路径），或先完成一次 awp_test_run 再按 taskId 预检。')
        }
        const rows = await previewImpactedSpecs({ repoId: repo, changedFiles: list })
        const head = `影响面预检（${list.length} 个改动文件）：波及 ${rows.length} 张 active 卷\n`
        if (!rows.length) return textOut(head + '✅ 没有既有考卷的观测路径与本次改动相交。')
        return textOut(
          head +
          rows
            .map(
              (r) =>
                `⚠️ ${r.featureKey} v${r.version} [${r.specType}${r.side ? ':' + r.side : ''}]` +
                `${r.scope === 'regression' ? '（回归常跑）' : ''}` +
                ` 最近执行:${r.lastResult || '未执行'}${r.failStreak ? ` 连败${r.failStreak}` : ''}` +
                ` — ${r.title || ''}`
            )
            .join('\n') +
          '\n（受波及的卷如送测失败，先判断是产品问题还是卷需更新；用 awp_test_spec_get 看卷内容）'
        )
      } catch (e) {
        return textOut(`预检失败：${e.message}`)
      }
    }
  )
}

export { GOLDEN_E2E_SPEC, GOLDEN_UNIT_SPEC, SPEC_PLATFORM_RULES }
