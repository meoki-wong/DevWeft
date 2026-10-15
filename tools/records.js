/**
 * records.js — 记录读写类工具（经验库 / 任务库 / 验证上报 / 偏差度量）
 * 全部写入走 SQLite prepared statements（原子性 + 并发安全）
 * 多租户：所有工具有可选 repo 参数，默认 demo-app
 */
import { isPostgres, columnExists } from '../db/dialect-helpers.js'
import { z } from 'zod'
import db, { nextExpId, nextRepId } from '../db.js'
import { ftsEscape } from '../tools/knowledge.js'
import { harnessAdvance, harnessStart } from '../harness/state-machine.js'
import { recordAuditEvent } from '../audit/index.js'
import { updateGateLoop, getGateLoop } from '../harness/loop.js'
import { ensureTenantRepo } from '../testing/migrate.js'
import { zBoolish, zBoolishOptional, zNumishOptional, asBool, asInt } from './boolish.js'
import {
  createRuleArtifactFromExperience,
  measureRuleEffect,
  ensureRuleArtifactsTable,
} from '../testing/rule-artifacts.js'
import { reviewPending, listExperiencePending } from '../testing/failures.js'

/** 解析评审人：author 字符串 → principal_id（experience_pending.reviewed_by 是外键） */
async function resolveReviewerPrincipalId(author) {
  const row = await db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(author)
  return row?.principal_id || null
}

/** distill_append：经验写入（status 一律 pending，晋升需人工 review） */
function registerDistillAppend(server) {
  server.registerTool(
    'distill_append',
    {
      title: '写入经验（进化日志）',
      description:
        '将一次踩坑/发现的规则经验写入团队共享经验库。content 建议包含：触发场景/错误写法/正确写法/验证命令。source=user 人工总结，auto 为 AI 自动沉淀（两者都进待评审队列，晋升需 review）。',
      inputSchema: {
        content: z.string().describe('经验内容（触发/错误/正确/验证命令）'),
        source: z.enum(['user', 'auto']).optional().describe('来源：user=人工总结 / auto=AI 自动沉淀'),
        taskId: z.string().optional().describe('关联任务 id（可空）'),
        author: z.string().describe('写入人（必填，可追溯）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        tags: z.array(z.string()).optional().describe('标签，如 tech-debt / distill / migrated / ai-drift'),
        module: z.string().optional().describe('关联业务模块名（如 activityManage），用于偏差按模块统计'),
        ruleRef: z.string().optional().describe('关联已固化规则的位置（如 AGENTS.md §硬规则），正反馈追踪用'),
        category: z
          .enum(['dev', 'test'])
          .optional()
          .describe('经验类别：dev=开发经验（默认，pending 走人工审核）/ test=测试考卷经验（免审直接生效）')
      }
    },
    async ({ content, source = 'auto', taskId = null, author, repo = 'demo-app', tags = [], module = null, ruleRef = null, category = 'dev' }) => {
      const id = await nextExpId()
      const now = new Date().toISOString()
      const cat = category === 'test' ? 'test' : 'dev'
      const status = cat === 'test' ? 'reviewed' : 'pending'
      await db.prepare(`
        INSERT INTO experiences (id, repo, tenant_id, content, source, status, category, author, module, task_id, rule_ref, tags, created_at, updated_at)
        VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, repo, repo, content, source, status, cat, author, module, taskId, ruleRef, JSON.stringify(tags), now, now)
      // 失败后 distill：清 await_distill，允许进入修复/重提
      if (taskId) {
        try {
          const loop = await getGateLoop(db, { repo, taskId })
          if (loop?.awaitDistill) {
            await updateGateLoop(db, { repo, taskId, patch: { awaitDistill: 0 } })
          }
        } catch {
          /* ignore */
        }
      }
      return { content: [{ type: 'text', text: `已写入经验库：${id}（category=${cat}，status=${status}${cat === 'test' ? '，免审直接生效' : '，等待评审晋升'}）` }] }
    }
  )
}

/** distill_query：经验检索（FTS5 全文检索 + repo 过滤） */
// QUERY_CLASS: PLATFORM —— 经验检索属平台级查询（方案 §2.7/§7.1；原 topRelatedExperiences 已并入此工具）
function registerDistillQuery(server) {
  server.registerTool(
    'distill_query',
    {
      title: '检索团队经验库',
      description: '按关键词检索团队共享经验（FTS5 全文检索 + BM25 排序），默认排除已废弃条目。支持按项目(repo)、状态(status)、模块(module)过滤。',
      inputSchema: {
        keyword: z.string().describe('关键词，如 manualChunks / keep-alive / 白屏'),
        repo: z.string().optional().describe('项目标识，默认 demo-app；传 shared 搜跨项目通用经验'),
        status: z.enum(['pending', 'reviewed', 'obsolete', 'all']).optional().describe('按状态过滤，默认排除 obsolete'),
        limit: z.number().optional().describe('返回条数上限，默认 10'),
        module: z.string().optional().describe('按业务模块过滤（如 activityManage）'),
        category: z.enum(['dev', 'test', 'all']).optional().describe('按类别过滤：dev=开发经验（写码时查）/ test=测试考卷经验（修脚本时查）；默认 all'),
        hasRuleRef: zBoolishOptional.describe('只看已关联规则（ruleRef 非空）的经验')
      }
    },
    async ({ keyword, repo = 'demo-app', status = 'all', limit = 10, module = null, hasRuleRef = null, category = 'all' }) => {
      // 全文检索 + 条件过滤（§2.8：sqlite 走 FTS5 MATCH；postgres 走 pg_trgm ILIKE + GIN）
      let sql = isPostgres(db)
        ? `SELECT e.* FROM experiences e WHERE (e.content ILIKE ? OR e.module ILIKE ? OR e.tags ILIKE ?)`
        : `
        SELECT e.* FROM experiences e
        JOIN experiences_fts f ON e.rowid = f.rowid
        WHERE experiences_fts MATCH ?
      `
      const kwLike = `%${keyword}%`
      const params = isPostgres(db) ? [kwLike, kwLike, kwLike] : [ftsEscape(keyword)] // FTS5 引号转义，防语法错误
      const conditions = []
      if (repo !== 'all') {
        conditions.push('e.repo = ?')
        params.push(repo)
      }
      if (status !== 'all') {
        conditions.push('e.status = ?')
        params.push(status)
      } else {
        conditions.push("e.status != 'obsolete'")
      }
      if (module) {
        conditions.push('e.module = ?')
        params.push(module)
      }
      if (category && category !== 'all') {
        conditions.push('e.category = ?')
        params.push(category)
      }
      if (hasRuleRef === true) {
        conditions.push('e.rule_ref IS NOT NULL AND e.rule_ref != ""')
      } else if (hasRuleRef === false) {
        conditions.push('(e.rule_ref IS NULL OR e.rule_ref = "")')
      }
      if (conditions.length) {
        sql += ' AND ' + conditions.join(' AND ')
      }
      // SQLite FTS5 有 rank 字段（BM25 排序），PostgreSQL 没有 → 按创建时间排序
      sql += isPostgres(db) ? ' ORDER BY e.created_at DESC LIMIT ?' : ' ORDER BY rank LIMIT ?'
      params.push(limit)

      let rows
      try {
        rows = await db.prepare(sql).all(...params)
      } catch (e) {
        // FTS5 MATCH 语法错误（如未闭合括号 / 保留字）不应让工具抛异常中断链路
        return { content: [{ type: 'text', text: `经验库检索失败（关键词 "${keyword}" 语法不合法）：${e.message}` }] }
      }
      if (!rows.length) {
        await recordAuditEvent({
          eventType: 'mcp_tool',
          toolName: 'distill_query',
          repo,
          detail: `未命中：${keyword}`,
          argsPreview: JSON.stringify({ keyword, repo }).slice(0, 200),
        })
        return { content: [{ type: 'text', text: `经验库未命中：${keyword}` }] }
      }
      await recordAuditEvent({
        eventType: 'mcp_tool',
        toolName: 'distill_query',
        repo,
        detail: `命中 ${rows.length} 条`,
        argsPreview: JSON.stringify({ keyword, repo }).slice(0, 200),
      })
      const out = rows.map(e => {
        const tags = JSON.parse(e.tags || '[]')
        const tagStr = tags.length ? ` [${tags.join(',')}]` : ''
        return `[${e.id}] ${e.status} ${e.source} @${e.author} ${e.created_at.slice(0, 10)}${tagStr}\n${e.content.slice(0, 400)}`
      })
      return { content: [{ type: 'text', text: out.join('\n\n') }] }
    }
  )
}

/** task_state：多任务状态读写（open/update/close/get/list） */
function registerTaskState(server) {
  server.registerTool(
    'task_state',
    {
      title: '任务状态读写（团队共享 / Harness 兼容入口）',
      description:
        '团队共享任务库读写。编码工作流请优先精确调用 harness_start / harness_status（与本工具同属 MCP awp-ai）。' +
        'action: open 开启新任务（内部走 harness_start）/ update 合并更新 / close 关闭 / get 查询 / list 列出进行中任务。' +
        '若 IDE 工具列表搜不到 harness_start，可先调本工具 action=open 建立 Harness 会话。',
      inputSchema: {
        action: z.enum(['open', 'update', 'close', 'get', 'list']).describe('操作'),
        taskId: z.string().optional().describe('任务 id（open 可空，其余必填）'),
        requirement: z.string().optional().describe('open 时：需求原文'),
        type: z.string().optional().describe('open 时：FEATURE/UI_DEV/FIX/INTEGRATION/RELEASE'),
        data: z.any().optional().describe('update 时：合并字段（phase/completed/pending/decisions/blockedBy）'),
        author: z.string().optional().describe('操作人（open/update/close 必填，list/get 可空）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app')
      }
    },
    async ({ action, taskId = null, requirement = '', type = 'FEATURE', data = {}, author, repo = 'demo-app' }) => {
      if (["open", "update", "close"].includes(action) && !author) {
        return { content: [{ type: "text", text: `${action} 操作需要 author 参数` }] }
      }
      if (action === 'open') {
        const id = taskId || `${new Date().toISOString().slice(0, 10)}-${(requirement || 'task').slice(0, 12).replace(/[^\w\u4e00-\u9fa5-]/g, '')}`
        const existing = await db.prepare('SELECT task_id FROM tasks WHERE repo = ? AND task_id = ?').get(repo, id)
        if (existing) {
          return { content: [{ type: 'text', text: `任务已存在：${id}（用 update/get 操作）` }] }
        }
        const now = new Date().toISOString()
        // 新 repo 即开独立租户（与 harness_start 一致），tenant_id 回填才有据可写
        try { await ensureTenantRepo(db, repo) } catch { /* 非法 slug 交给下方 INSERT 的 NOT NULL 兜底 */ }
        await db.prepare(`
          INSERT INTO tasks (task_id, repo, tenant_id, requirement, type, phase, completed, pending, decisions, author, created_at, updated_at)
          VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, 'receive', '[]', ?, '[]', ?, ?, ?)
        `).run(id, repo, repo, requirement, type, JSON.stringify([requirement]), author, now, now)
        // 记录初始版本快照
        await db.prepare(`
          INSERT INTO task_versions (task_id, repo, tenant_id, phase, snapshot, author, created_at)
          VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'receive', ?, ?, ?)
        `).run(id, repo, repo, JSON.stringify({ requirement, type, phase: 'receive' }), author, now)
        return { content: [{ type: 'text', text: `任务已开启：${id}（phase=RECEIVE, repo=${repo}）` }] }
      }

      if (action === 'list') {
        const rows = await db.prepare(
          "SELECT * FROM tasks WHERE repo = ? AND phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted') ORDER BY updated_at DESC"
        ).all(repo)
        if (!rows.length) return { content: [{ type: 'text', text: `当前无进行中任务（repo=${repo}）` }] }
        const out = rows.map(t => `${t.task_id} [${t.type}/${t.phase}] ${t.requirement} @${t.author}`)
        return { content: [{ type: 'text', text: `进行中任务 ${rows.length} 个：\n${out.join('\n')}` }] }
      }

      if (!taskId) return { content: [{ type: 'text', text: '缺少 taskId' }] }
      const task = await db.prepare('SELECT * FROM tasks WHERE repo = ? AND task_id = ?').get(repo, taskId)
      if (!task) return { content: [{ type: 'text', text: `任务不存在：${taskId}（repo=${repo}）` }] }

      if (action === 'get') {
        // 同时返回版本时间线
        const versions = await db.prepare(
          'SELECT phase, author, created_at FROM task_versions WHERE repo = ? AND task_id = ? ORDER BY id'
        ).all(repo, taskId)
        const taskData = { ...task, completed: JSON.parse(task.completed), pending: JSON.parse(task.pending), decisions: JSON.parse(task.decisions), versions }
        return { content: [{ type: 'text', text: JSON.stringify(taskData, null, 2) }] }
      }

      if (action === 'update') {
        const now = new Date().toISOString()
        // 禁止直接改 phase — 必须走 harness_advance（团队 Harness 状态机）
        if (data.phase && data.phase !== task.phase) {
          return {
            content: [{
              type: 'text',
              text: `禁止直接修改 phase（${task.phase} → ${data.phase}）。请调用 harness_advance(taskId="${taskId}", to="${data.phase}", author="...")`,
            }],
          }
        }
        const merged = { ...task }
        for (const [k, v] of Object.entries(data)) {
          if (['completed', 'pending', 'decisions', 'blockedBy', 'requirement', 'type'].includes(k)) {
            if (Array.isArray(v)) {
              merged[k] = JSON.stringify(v)
            } else {
              merged[k] = v
            }
          }
        }
        merged.updated_at = now
        await db.prepare(`
          UPDATE tasks SET phase = ?, completed = ?, pending = ?, decisions = ?, requirement = COALESCE(?, requirement), type = COALESCE(?, type), updated_at = ?
          WHERE repo = ? AND task_id = ?
        `).run(
          merged.phase || task.phase,
          merged.completed || task.completed,
          merged.pending || task.pending,
          merged.decisions || task.decisions,
          merged.requirement || null,
          merged.type || null,
          now, repo, taskId
        )
        // 插入版本快照（四层框架 L3）
        await db.prepare(`
          INSERT INTO task_versions (task_id, repo, tenant_id, phase, snapshot, author, created_at)
          VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?)
        `).run(taskId, repo, repo, merged.phase || task.phase, JSON.stringify(merged), author, now)
        return { content: [{ type: 'text', text: `已更新：${taskId}（phase=${merged.phase || task.phase}）` }] }
      }

      if (action === 'close') {
        // 消除后门：close 一律走 harnessAdvance（DONE 守卫与 harness_advance 完全一致）
        const result = await harnessAdvance({ taskId, to: 'DONE', data: {}, author, repo })
        if (!result.ok) {
          const blocked = result.blockedBy?.length
            ? `（被门禁拦截：${result.blockedBy.join('；')}）`
            : ''
          return { content: [{ type: 'text', text: `关闭失败：${taskId}${blocked}。请先满足守卫（如 L2 验证通过、阶段推进到 VERIFY/DISTILL），再 harness_advance 到 DONE。` }] }
        }
        return { content: [{ type: 'text', text: `已关闭：${taskId}（phase=DONE，经 harness_advance，门禁已校验）` }] }
      }

      return { content: [{ type: 'text', text: `未知 action：${action}` }] }
    }
  )
}

/** lesson_record：跨仓库通用经验（repo='shared'） */
function registerLessonRecord(server) {
  server.registerTool(
    'lesson_record',
    {
      title: '记录通用经验（跨仓库）',
      description: '写入 shared 命名空间的跨项目经验，例如常见构建或 UI framework issues。实际写入 experiences 表，repo=shared。',
      inputSchema: {
        content: z.string().describe('经验内容'),
        source: z.enum(['user', 'auto']).optional(),
        author: z.string().describe('写入人（必填）'),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ content, source = 'auto', author, tags = [] }) => {
      const id = await nextExpId()
      const now = new Date().toISOString()
      await db.prepare(`
        INSERT INTO experiences (id, repo, tenant_id, content, source, status, author, tags, created_at, updated_at)
        VALUES (?, 'shared', (SELECT repo_id FROM repositories WHERE slug = 'shared'), ?, ?, 'pending', ?, ?, ?, ?)
      `).run(id, content, source, author, JSON.stringify(tags), now, now)
      return { content: [{ type: 'text', text: `已写入共享经验库：${id}（repo=shared）` }] }
    }
  )
}

/** verify_report：本地验证结果上报（团队统计/债务） */
function registerVerifyReport(server) {
  server.registerTool(
    'verify_report',
    {
      title: '上报本地验证结果',
      description: '本地 verify.sh 执行完 L1/L2/L3 后调用，将结果写入团队统计（lint 债务/复用率趋势）。',
      inputSchema: {
        level: z.enum(['L1', 'L2', 'L3']).describe('验证级别'),
        side: z.string().min(1).optional().describe('Optional repository-defined side.'),
        file: z.string().optional().describe('L1：验证文件'),
        pass: zBoolish.describe('是否通过（true/false；也接受 "true"/"false"/1/0）'),
        errors: zNumishOptional.describe('失败项数'),
        detail: z.string().optional().describe('附加说明'),
        taskId: z.string().optional().describe('关联 Harness 任务 id（verify.sh 通过 AWP_AI_TASK_ID 传入）'),
        author: z.string().describe('执行人（必填）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        workspaceHead: z.string().optional().describe('执行时 workspace HEAD commit（证据绑定）'),
        codeSnapshotSha: z.string().optional().describe('代码快照 sha'),
        outputSha256: z.string().optional().describe('输出哈希'),
        commandExitCode: zNumishOptional.describe('命令退出码'),
        startedAt: z.string().optional().describe('开始时间 ISO'),
        finishedAt: z.string().optional().describe('结束时间 ISO')
      }
    },
    async ({
      level, side = 'na', file = null, pass, errors = 0, detail = '', author,
      repo = 'demo-app', taskId = null,
      workspaceHead = null, codeSnapshotSha = null, outputSha256 = null,
      commandExitCode = null, startedAt = null, finishedAt = null,
    }) => {
      const id = await nextRepId()
      const passBool = asBool(pass, false)
      const errCount = asInt(errors, 0)
      const now = new Date().toISOString()
      const hasEvidence = await columnExists(db, 'verify_reports', 'workspace_head')
      if (hasEvidence) {
        await db.prepare(`
          INSERT INTO verify_reports (
            id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at,
            workspace_head, code_snapshot_sha, output_sha256, command_exit_code, started_at, finished_at, source
          ) VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'mcp')
        `).run(
          id, repo, repo, level, side, file, passBool ? 1 : 0, errCount, detail, author, taskId, now,
          workspaceHead, codeSnapshotSha, outputSha256,
          commandExitCode == null ? null : asInt(commandExitCode, 0),
          startedAt, finishedAt || now
        )
      } else {
        await db.prepare(`
          INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
          VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, repo, repo, level, side, file, passBool ? 1 : 0, errCount, detail, author, taskId, now)
      }
      return { content: [{ type: 'text', text: `已上报：${id} ${level} ${passBool ? '✓' : '✗'}（${author}）` }] }
    }
  )
}

/** drift_stats：偏差度量（ai-drift 度量）—— 周趋势 / 模块分布 / 规则关联 */
function registerDriftStats(server) {
  server.registerTool(
    'drift_stats',
    {
      title: '偏差统计（ai-drift 度量）',
      description:
        '统计 AI 产出偏差（tags 含 ai-drift 的经验）的周趋势、模块分布和规则关联情况。规则负责人用此判断：哪些模块偏差集中（需补规则）、哪些规则合入后同类偏差仍在（规则失效风险）。',
      inputSchema: {
        weeks: z.number().optional().describe('趋势统计最近 N 周，默认 4'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        module: z.string().optional().describe('只看指定模块（如 activityManage）')
      }
    },
    async ({ weeks = 4, repo = 'demo-app', module = null } = {}) => {
      // 查询所有 ai-drift 偏差
      let sql = `SELECT * FROM experiences WHERE tags LIKE '%ai-drift%' AND status != 'obsolete'`
      const params = []
      if (repo !== 'all') { sql += ' AND repo = ?'; params.push(repo) }
      if (module) { sql += ' AND module = ?'; params.push(module) }
      const drifts = await db.prepare(sql).all(...params)

      // ISO 周号
      const weekKey = d => {
        const date = new Date(d)
        const day = (date.getDay() + 6) % 7
        const thursday = new Date(date.getTime() + (3 - day) * 86400000)
        const year = thursday.getUTCFullYear()
        const firstThu = new Date(Date.UTC(year, 0, 4))
        const firstDay = (firstThu.getUTCDay() + 6) % 7
        const week = 1 + Math.round(((thursday - firstThu) / 86400000 - firstDay) / 7)
        return `${year}-W${String(week).padStart(2, '0')}`
      }

      // 周趋势
      const now = new Date()
      const weekList = []
      for (let i = weeks - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 7 * 86400000)
        weekList.push({ key: weekKey(d), count: 0 })
      }
      for (const e of drifts) {
        const k = weekKey(e.created_at)
        const w = weekList.find(x => x.key === k)
        if (w) w.count++
      }
      const trendLine = weekList.map(w => `${w.key}=${w.count}`).join(' ')

      // 模块分布
      const byModule = {}
      for (const e of drifts) {
        const m = e.module || '未标注'
        byModule[m] = (byModule[m] || 0) + 1
      }
      const moduleLine = Object.entries(byModule)
        .sort((a, b) => b[1] - a[1])
        .map(([m, c]) => `${m}:${c}`)
        .join(' ')

      // 规则关联
      const withRule = drifts.filter(e => e.rule_ref).length
      const withoutRule = drifts.length - withRule

      const thisWeek = weekList[weekList.length - 1].count
      const lastWeek = weekList.length >= 2 ? weekList[weekList.length - 2].count : null
      const trend = lastWeek === null ? '（无上周数据）' : thisWeek > lastWeek ? `↑ 较上周 +${thisWeek - lastWeek}` : thisWeek < lastWeek ? `↓ 较上周 ${thisWeek - lastWeek}` : '→ 与上周持平'

      const out = [
        `【偏差统计】ai-drift 共 ${drifts.length} 条（过滤：${repo}${module ? '/' + module : ''}）`,
        `本周新增: ${thisWeek} 条 ${trend}`,
        `周趋势(${weeks}周): ${trendLine}`,
        `模块分布: ${moduleLine || '（无）'}`,
        `规则关联: 已关联 ${withRule} 条 / 未关联 ${withoutRule} 条${withoutRule > 0 ? '（建议评审后固化为规则并回填 rule_ref）' : ''}`
      ]
      if (withoutRule > 0) {
        out.push('\n最近未关联规则的偏差（可评审固化）:')
        for (const e of drifts.filter(x => !x.rule_ref).slice(-5).reverse()) {
          out.push(`  - ${e.id} [${e.module || '未标注'}] @${e.author} ${e.created_at.slice(0, 10)}: ${e.content.slice(0, 60)}`)
        }
      }
      // 规则资产前后窗口效果（v30）
      try {
        await ensureRuleArtifactsTable(db)
        const activeRules = await db.prepare(
          `SELECT rule_id, title, activated_at FROM rule_artifacts WHERE repo=? AND status='active' ORDER BY activated_at DESC LIMIT 5`
        ).all(repo === 'all' ? 'demo-app' : repo)
        if (activeRules.length) {
          out.push('\n规则效果（激活前/后 2 周 ai-drift 对比）:')
          for (const r of activeRules) {
            const eff = await measureRuleEffect(db, { repo: repo === 'all' ? 'demo-app' : repo, ruleId: r.rule_id, weeks: 2 })
            if (!eff.ok) continue
            const imp = (eff.improved || []).map((x) => `${x.module}:${x.before}→${x.after}`).join(' ') || '—'
            const notImp = (eff.notImproved || []).map((x) => `${x.module}:${x.before}→${x.after}`).join(' ') || '—'
            out.push(`  ${r.rule_id} ${r.title?.slice(0, 40) || ''}`)
            out.push(`    下降模块: ${imp}`)
            out.push(`    未降/上升: ${notImp}`)
          }
        }
      } catch { /* 表未就绪 */ }
      return { content: [{ type: 'text', text: out.join('\n') }] }
    }
  )
}

/** distill_set_status：评审晋升（改状态 / 回填 rule_ref）—— 闭合晋升闭环 */
function registerSetStatus(server) {
  server.registerTool(
    'distill_set_status',
    {
      title: '评审经验（改状态 / 回填规则引用）',
      description:
        '规则负责人评审经验库条目：status 由 pending → reviewed（已固化为规则）/ obsolete（废弃）；可同时回填 rule_ref（关联已固化规则位置，如 AGENTS.md §硬规则），供 drift_stats 做规则有效性度量。闭合「写入(pending) → 评审 → 固化」闭环。',
      inputSchema: {
        id: z.string().describe('经验 id，如 exp-20260820-001'),
        status: z.enum(['pending', 'reviewed', 'obsolete']).describe('目标状态'),
        ruleRef: z.string().optional().describe('关联已固化规则位置（status=reviewed 时建议填）'),
        author: z.string().describe('评审人（必填，可追溯）')
      }
    },
    async ({ id, status, ruleRef = null, author }) => {
      const existing = await db.prepare('SELECT id, status, content, repo FROM experiences WHERE id = ?').get(id)
      if (!existing) {
        return { content: [{ type: 'text', text: `经验不存在：${id}` }] }
      }
      const now = new Date().toISOString()
      const hasV27 = await columnExists(db, 'experiences', 'source_type')
      if (hasV27) {
        await db.prepare(`
          UPDATE experiences
          SET status = ?, rule_ref = COALESCE(?, rule_ref),
              source_type = COALESCE(source_type, 'manual'),
              reviewer = COALESCE(reviewer, ?),
              updated_at = ?
          WHERE id = ?
        `).run(status, ruleRef, author, now, id)
      } else {
        await db.prepare(`
          UPDATE experiences
          SET status = ?, rule_ref = COALESCE(?, rule_ref), updated_at = ?
          WHERE id = ?
        `).run(status, ruleRef, now, id)
      }
      // reviewed 且未传 ruleRef：自动建 draft 规则资产，供负责人确认后 activate
      let ruleArtifact = null
      if (status === 'reviewed' && !ruleRef) {
        try {
          await ensureRuleArtifactsTable(db)
          const dup = await db.prepare(
            'SELECT rule_id FROM rule_artifacts WHERE source_experience_id=?'
          ).get(id)
          if (!dup) {
            ruleArtifact = await createRuleArtifactFromExperience(db, {
              repo: existing.repo || 'demo-app',
              experienceId: id,
              title: (existing.content || '').slice(0, 80) || `Rule from ${id}`,
              condition: { experienceId: id },
              owner: author,
            })
          } else {
            ruleArtifact = { ruleId: dup.rule_id, status: 'exists' }
          }
        } catch { /* 表未就绪时不阻断评审 */ }
      }
      const refMsg = ruleRef ? `，rule_ref=${ruleRef}` : ''
      const raMsg = ruleArtifact ? `，rule_artifact=${ruleArtifact.ruleId}(${ruleArtifact.status})` : ''
      return { content: [{ type: 'text', text: `已更新：${id}（${existing.status} → ${status}${refMsg}${raMsg}）` }] }
    }
  )
}

/**
 * distill_promote：审批「云端测试自动沉淀」的待评审经验。
 *
 * 背景：testing/failure-writeback.js 在 run 终态后把 product/suite/regression 类失败
 * 自动立案到 experience_pending（infra 类按§23 明确禁止进经验，避免占用 AI 沉淀预算）。
 * 但 reviewPending / listExperiencePending 此前没有任何 MCP 工具能调用，
 * 导致自动沉淀的经验静静躺在表里无人问津——云端测试反哺开发这条价值链是断的。
 *
 * action 三态（对应 experience_pending.status CHECK）：
 *   promote  → 晋升为正式经验（写 experiences，status='reviewed'）
 *   link     → 关联到已有失败立案（不新生成经验，用于去重/归并）
 *   reject   → 判定无沉淀价值（平台噪声、一次性环境问题）
 */
function registerDistillPromote(server) {
  server.registerTool(
    'distill_promote',
    {
      title: '审批云端测试自动沉淀的经验',
      description:
        '处理 distill_review_queue 中 source=failure 的条目（云端测试失败自动立案）。' +
        'action=promote 晋升为正式经验；action=link 关联到已有失败立案（归并，不新增）；action=reject 判定无沉淀价值。',
      inputSchema: {
        pendingId: z.string().describe('待审批条目 id（distill_review_queue 返回的 pending:<id>）'),
        action: z.enum(['promote', 'link', 'reject']).describe('审批动作'),
        author: z.string().describe('评审人（必填，用于追溯）'),
        note: z.string().optional().describe('评审意见'),
        linkedFailureId: z.string().optional().describe('action=link 时必填：关联的失败立案 id')
      }
    },
    async ({ pendingId, action, author, note = null, linkedFailureId = null }) => {
      const hasTable = await columnExists(db, 'experience_pending', 'pending_id')
      if (!hasTable) {
        return { content: [{ type: 'text', text: '当前部署未启用 experience_pending 表（云端测试未启用），无可审批条目。' }] }
      }
      const reviewerPrincipalId = await resolveReviewerPrincipalId(author)
      if (!reviewerPrincipalId) {
        return { content: [{ type: 'text', text: `评审人 ${author} 在 principals 表无记录，无法追溯。请先用该身份调用过任一已登记工具，或改用已登记的评审人。` }] }
      }
      const mapped = action === 'promote' ? 'promoted_to_experience' : action === 'link' ? 'linked_to_failure' : 'rejected'
      try {
        const out = await reviewPending(db, {
          pendingId,
          action: mapped,
          reviewerPrincipalId,
          note,
          linkedFailureId,
        })
        const extra = out.experienceId ? `，经验 id=${out.experienceId}` : ''
        return { content: [{ type: 'text', text: `已处理：${pendingId} → ${mapped}${extra}` }] }
      } catch (e) {
        return { content: [{ type: 'text', text: `审批失败：${e.code || e.message}` }] }
      }
    }
  )
}

export function registerRecordsTools(server) {
  registerDistillAppend(server)
  registerDistillQuery(server)
  registerTaskState(server)
  registerLessonRecord(server)
  registerVerifyReport(server)
  registerDriftStats(server)
  registerSetStatus(server)
  registerDistillPromote(server)
}
