/**
 * collaboration.js — 协作类工具（经验评审 / 规则 PR 草稿 / 周报）
 * 晋升闭环：distill_review_queue 筛选 → generate_rule_pr 生成草稿 → PR review → 合入规则
 */
import { z } from 'zod'
import db from '../db.js'
import { scoreDistillHitMiss } from '../harness/metrics.js'
import { listExperiencePending } from '../testing/failures.js'

/** distill_review_queue：待评审经验列表（规则负责人周会使用） */
function registerReviewQueue(server) {
  server.registerTool(
    'distill_review_queue',
    {
      title: '待评审经验队列（规则负责人）',
      description: '返回经验库中待评审（pending）条目，供规则负责人筛选晋升。可传 status 查看其他状态。',
      inputSchema: {
        status: z.enum(['pending', 'reviewed', 'obsolete', 'all']).optional().describe('默认 pending'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        limit: z.number().optional().describe('返回条数上限，默认 50'),
        includeFailure: z.boolean().optional().describe('是否并入云端测试自动沉淀的待审批条目（source=failure），默认 true')
      }
    },
    async ({ status = 'pending', repo = 'demo-app', limit = 50, includeFailure = true } = {}) => {
      let sql = 'SELECT * FROM experiences WHERE '
      const params = []
      if (status === 'all') {
        sql += '1=1'
      } else {
        sql += 'status = ?'
        params.push(status)
      }
      if (repo !== 'all') {
        sql += ' AND repo = ?'
        params.push(repo)
      }
      sql += ' ORDER BY created_at DESC LIMIT ?'
      params.push(limit)

      const rows = await db.prepare(sql).all(...params)
      const out = rows.map(e => {
        const tags = JSON.parse(e.tags || '[]')
        return `- ${e.id} [${e.source}] @${e.author} ${e.created_at.slice(0, 10)}${e.task_id ? `（任务 ${e.task_id}）` : ''}${tags.length ? ` [${tags.join(',')}]` : ''}\n  ${e.content.slice(0, 200)}`
      })

      // 并入云端测试自动沉淀的待审批条目：这些行在 experience_pending 表，
      // 由 failure-writeback 在 run 终态时自动立案，此前没有任何工具能取出来，
      // 导致「云端测试 → 经验反哺」这条链断掉。
      const failLines = []
      if (includeFailure && (status === 'pending' || status === 'all')) {
        try {
          const repoRow = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repo)
          if (repoRow) {
            const pend = await listExperiencePending(db, {
              repoId: repoRow.repo_id,
              status: 'pending_review',
              limit,
            })
            for (const p of pend) {
              failLines.push(
                `- pending:${p.pending_id} [failure:${p.failure_class}] 立案=${String(p.source_id).slice(0, 12)} ${p.created_at.slice(0, 10)}\n  ${String(p.content || '').slice(0, 200)}`
              )
            }
          }
        } catch {
          // experience_pending 未启用（云端测试未启用）时静默跳过，不影响主队列
        }
      }

      if (!rows.length && !failLines.length) {
        return { content: [{ type: 'text', text: `经验库无 ${status} 条目（repo=${repo}）` }] }
      }
      const parts = []
      if (out.length) parts.push(`待评审 ${out.length} 条：\n` + out.join('\n'))
      if (failLines.length) {
        parts.push(
          `待评审 ${failLines.length} 条（云端测试自动沉淀，source=failure）：\n` +
            failLines.join('\n') +
            '\n  → 用 distill_promote(pendingId="pending:<id>", action=promote|link|reject) 审批'
        )
      }
      return { content: [{ type: 'text', text: parts.join('\n\n') }] }
    }
  )
}

/** generate_rule_pr：按经验 id 生成规则固化草稿（PR body） */
function registerGenerateRulePr(server) {
  server.registerTool(
    'generate_rule_pr',
    {
      title: '生成规则固化 PR 草稿',
      description:
        '按经验 id 列表生成规则追加草稿（含错误/正确/验证命令格式，对齐 DISTILL 固化协议），供规则负责人提交 PR。source=auto 的经验会标注需人工确认。',
      inputSchema: {
        ids: z.array(z.string()).describe('经验 id 列表，如 ["exp-20260808-001"]')
      }
    },
    async ({ ids }) => {
      const placeholders = ids.map(() => '?').join(',')
      const rows = await db.prepare(`SELECT * FROM experiences WHERE id IN (${placeholders})`).all(...ids)
      if (!rows.length) return { content: [{ type: 'text', text: `未找到经验：${ids.join(', ')}` }] }
      const lines = []
      lines.push('# 规则固化草稿（由 DevWeft generate_rule_pr 生成）')
      lines.push('')
      lines.push('> 以下条目来自团队经验库，经规则负责人筛选，按固化协议格式整理。')
      lines.push('')

      for (const e of rows) {
        lines.push(`## [${new Date().toISOString().slice(0, 10)}] ${e.content.split('\n')[0].slice(0, 40)}`)
        lines.push(`- 来源：${e.id}（source=${e.source}${e.source === 'auto' ? '，**需人工确认准确性**' : ''}，作者 ${e.author}，${e.created_at.slice(0, 10)}）`)
        // 尝试按固化协议字段解析 content 行
        const fieldMap = {}
        for (const line of e.content.split('\n')) {
          const m = line.match(/^\s*(触发|错误|正确|验证|存放|存量)[：:]\s*(.+)$/)
          if (m) fieldMap[m[1]] = m[2]
        }
        if (fieldMap['触发']) lines.push(`- 触发：${fieldMap['触发']}`)
        if (fieldMap['错误']) lines.push(`- 错误：${fieldMap['错误']}`)
        if (fieldMap['正确']) lines.push(`- 正确：${fieldMap['正确']}`)
        if (fieldMap['验证']) lines.push(`- 验证：${fieldMap['验证']}`)
        if (fieldMap['存放']) lines.push(`- 存放：${fieldMap['存放']}`)
        if (fieldMap['存量']) lines.push(`- 存量：${fieldMap['存量']}`)
        if (!fieldMap['触发']) {
          lines.push(`- 内容：${e.content.replace(/\n/g, ' ').slice(0, 300)}`)
          lines.push('- 固化动作：提取错误写法/正确写法/触发场景 → 按类型存放 → Grep 存量扫描')
        }
        lines.push('')
      }
      lines.push('---')
      lines.push('## 提交检查')
      lines.push('- [ ] 每条规则包含「错误示例 + 正确示例 + 验证命令」')
      lines.push('- [ ] 已 Grep 存量扫描（0 处 / ≤5 处立即修 / >5 处记 tech-debt）')
      lines.push('- [ ] 合入后回填 rule_ref（调用 distill_query 找到本条经验，更新 rule_ref）')
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }
  )
}

/** weekly_report：周报生成 —— 经验 / 评审 / 偏差 / 建议 */
function registerWeeklyReport(server) {
  server.registerTool(
    'weekly_report',
    {
      title: '生成经验进化周报',
      description:
        '规则负责人周会使用：汇总本周新增经验、待评审队列、ai-drift 偏差趋势与模块热点、规则有效性，并给出建议固化的规则。',
      inputSchema: {
        weeks: z.number().optional().describe('对比最近 N 周，默认 1（本周 vs 上周）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app')
      }
    },
    async ({ weeks = 1, repo = 'demo-app' } = {}) => {
      const startOfWeek = new Date(Date.now() - weeks * 7 * 86400000).toISOString()

      // 本周新增经验
      const newOnes = await db.prepare(
        `SELECT * FROM experiences WHERE repo = ? AND created_at >= ? AND status != 'obsolete'`
      ).all(repo, startOfWeek)
      const userCount = newOnes.filter(e => e.source === 'user').length
      const autoCount = newOnes.filter(e => e.source === 'auto').length

      // 待评审
      const pending = await db.prepare(
        `SELECT * FROM experiences WHERE repo = ? AND status = 'pending'`
      ).all(repo)
      const driftPending = pending.filter(e => {
        const tags = JSON.parse(e.tags || '[]')
        return tags.includes('ai-drift')
      })

      // ai-drift 偏差
      const newDrifts = newOnes.filter(e => {
        const tags = JSON.parse(e.tags || '[]')
        return tags.includes('ai-drift')
      })

      // 模块热点
      const byModule = {}
      for (const e of newDrifts) {
        const m = e.module || '未标注'
        byModule[m] = (byModule[m] || 0) + 1
      }
      const hotModules =
        Object.entries(byModule)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([m, c]) => `${m}(${c})`)
          .join(' ') || '无'

      // 规则有效性：已关联规则且本周仍有同类偏差
      const withRule = await db.prepare(
        `SELECT * FROM experiences WHERE repo = ? AND rule_ref IS NOT NULL AND rule_ref != '' AND status != 'obsolete'`
      ).all(repo)
      const ruleRisk = withRule.filter(e => {
        return newDrifts.some(d => d.rule_ref === e.rule_ref && d.id !== e.id)
      })
      const ruleEffective = withRule.length - ruleRisk.length

      // 建议固化 TOP：未关联规则的 ai-drift
      const allDrifts = await db.prepare(
        `SELECT * FROM experiences WHERE repo = ? AND tags LIKE '%ai-drift%' AND (rule_ref IS NULL OR rule_ref = '') AND status != 'obsolete'`
      ).all(repo)
      const suggest = allDrifts.slice(-3).reverse()

      // 健康度三指标（度量口径固化）
      const since7 = new Date(Date.now() - 7 * 86400000).toISOString()
      const driftWeekNew = await db.prepare(
        `SELECT COUNT(*) as c FROM experiences WHERE repo = ? AND tags LIKE '%ai-drift%' AND status != 'obsolete' AND created_at >= ?`
      ).all(repo, since7)
      const driftWeekCount = Array.isArray(driftWeekNew) ? driftWeekNew[0].c : (driftWeekNew?.c || 0)
      const qrows = await db.prepare(
        `SELECT detail FROM audit_events WHERE tool_name = 'distill_query' AND repo = ? AND created_at >= ?`
      ).all(repo, startOfWeek)
      let hit = 0, miss = 0
      for (const r of qrows) {
        const scored = scoreDistillHitMiss(r.detail)
        if (scored === 'miss') miss++
        else if (scored === 'hit') hit++
      }
      const hitRate = (hit + miss) > 0 ? Math.round((hit / (hit + miss)) * 100) : null

      const out = [
        '══════════ AI 经验进化周报 ══════════',
        `【本周新增经验】${newOnes.length} 条（user ${userCount} / auto ${autoCount}）`,
        `【待评审队列】${pending.length} 条（其中 ai-drift ${driftPending.length} 条）`,
        `【偏差趋势】本周 ai-drift ${newDrifts.length} 条 | 模块热点: ${hotModules}`,
        `【规则有效性】已关联规则 ${withRule.length} 条：有效 ${ruleEffective} / 失效风险 ${ruleRisk.length}${ruleRisk.length ? '（同类偏差仍出现，建议 review 该规则）' : ''}`,
        '',
        '【健康度三指标】',
        `  · pending 积压数: ${pending.length} 条（健康阈值：持续下降，>10 飘红）`,
        `  · ai-drift 周新增: ${driftWeekCount} 条（健康阈值：语义分层修复后应趋稳 ≈ 0）`,
        `  · 经验命中率: ${hitRate === null ? 'N/A（样本不足）' : hitRate + '%'}（健康阈值：应升；= 命中/(命中+未命中)）`,
        suggest.length ? '\n【建议固化 TOP 3】（按偏差频率）:' : ''
      ]
      for (const e of suggest) {
        out.push(`  - ${e.id} [${e.module || '未标注'}] ${e.content.slice(0, 50)}`)
      }
      out.push('\n操作提示: ① distill_review_queue 评审待固化 ② generate_rule_pr 生成草稿 ③ 合入后回填 rule_ref')
      return { content: [{ type: 'text', text: out.join('\n') }] }
    }
  )
}

export function registerCollaborationTools(server) {
  registerReviewQueue(server)
  registerGenerateRulePr(server)
  registerWeeklyReport(server)
}
