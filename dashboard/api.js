/**
 * dashboard/api.js — 看板 REST API
 * 经验库浏览 / 评审（对应 distill_set_status 语义）+ 知识库查看 + 任务列表 + 总览聚合
 * 写操作（评审）统一记审计事件，经 SSE 实时广播到调用流
 */
import { isPostgres } from '../db/dialect-helpers.js'
import db from '../db.js'
import { ftsEscape } from '../tools/knowledge.js'
import { recordAuditEvent, queryAuditEvents } from '../audit/index.js'
import { readTaskGateSummaries, taskTestingKey } from './testing-read-model.js'

const DEFAULT_REPO = 'demo-app'
const EXP_STATUSES = ['pending', 'reviewed', 'obsolete']

/** 飞轮仪表聚合（/api/dashboard/flywheel 与 /api/overview 共用） */
export async function flywheelStats(repo) {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString()
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString()

  const pending = (await db
    .prepare("SELECT COUNT(*) as c FROM experiences WHERE repo = ? AND status = 'pending'")
    .get(repo)).c

  // distill_query 命中 / 未命中（audit_events 的 detail 已带中文结论）
  const q = await db
    .prepare(`SELECT detail FROM audit_events WHERE tool_name = 'distill_query' AND repo = ? AND created_at >= ?`)
    .all(repo, since30)
  let distillHit = 0
  let distillMiss = 0
  const missKeywords = new Set()
  for (const r of q) {
    const m = (r.detail || '').match(/未命中[:：]\s*(.+)/)
    if (m) {
      distillMiss++
      missKeywords.add(m[1].trim().slice(0, 40))
    } else {
      distillHit++
    }
  }

  const driftWeek = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM experiences WHERE repo = ? AND tags LIKE '%ai-drift%' AND status != 'obsolete' AND created_at >= ?`
    )
    .get(repo, since7)).c

  const modules = (await db
    .prepare(
      `SELECT module, COUNT(*) as c FROM experiences WHERE repo = ? AND tags LIKE '%ai-drift%' AND status != 'obsolete' AND created_at >= ? GROUP BY module ORDER BY c DESC LIMIT 5`
    )
    .all(repo, since30))
    .map((r) => `${r.module || '未标注'}(${r.c})`)
    .join(' ') || '无'

  return {
    pending,
    driftWeek,
    distillHit,
    distillMiss,
    reuseCount: distillHit,
    missKeywords: [...missKeywords].slice(0, 12),
    modules,
  }
}

/** 经验库列表查询（FTS 优先，关键词过短 / 语法错误回退 LIKE） */
async function queryExperiences({ repo, status, source, module, keyword, limit, offset }) {
  const where = []
  const params = []
  if (repo && repo !== 'all') {
    where.push('e.repo = ?')
    params.push(repo)
  }
  if (status && status !== 'all') {
    where.push('e.status = ?')
    params.push(status)
  }
  if (source && source !== 'all') {
    where.push('e.source = ?')
    params.push(source)
  }
  if (module) {
    where.push('e.module = ?')
    params.push(module)
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const kw = (keyword || '').trim()

  let rows
  if (kw) {
    const ftsWhere = whereSql ? `AND ${whereSql}` : ''
    // §2.8:postgres 直接走 pg_trgm ILIKE(基线 GIN),无 FTS5
    if (isPostgres(db)) {
      const pgWhere = whereSql ? `${whereSql} AND e.content ILIKE ?` : 'WHERE e.content ILIKE ?'
      rows = await db
        .prepare(`SELECT e.* FROM experiences e ${pgWhere} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, `%${kw}%`, limit, offset)
      const total = (await db
        .prepare(`SELECT COUNT(*) as c FROM experiences e ${pgWhere}`)
        .get(...params, `%${kw}%`)).c
      return { rows, total }
    }
    try {
      rows = await db
        .prepare(`
          SELECT e.* FROM experiences e
          JOIN experiences_fts f ON e.rowid = f.rowid
          WHERE experiences_fts MATCH ? ${ftsWhere}
          ORDER BY rank LIMIT ? OFFSET ?
        `)
        .all(ftsEscape(kw), ...params, limit, offset)
    } catch {
      rows = []
    }
    if (rows.length) {
      const total = (await db
        .prepare(`
          SELECT COUNT(*) as c FROM experiences e
          JOIN experiences_fts f ON e.rowid = f.rowid
          WHERE experiences_fts MATCH ? ${ftsWhere}
        `)
        .get(ftsEscape(kw), ...params)).c
      return { rows, total }
    }
    // trigram 需要 ≥3 字符；短词 / FTS 语法异常时 LIKE 兜底
    const likeWhere = whereSql ? `${whereSql} AND e.content LIKE ?` : 'WHERE e.content LIKE ?'
    rows = await db
      .prepare(`SELECT e.* FROM experiences e ${likeWhere} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, `%${kw}%`, limit, offset)
    const total = (await db
      .prepare(`SELECT COUNT(*) as c FROM experiences e ${likeWhere}`)
      .get(...params, `%${kw}%`)).c
    return { rows, total }
  }

  rows = await db
    .prepare(`SELECT e.* FROM experiences e ${whereSql} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset)
  const total = (await db.prepare(`SELECT COUNT(*) as c FROM experiences e ${whereSql}`).get(...params)).c
  return { rows, total }
}

export function mountDashboardApi(app) {
  // ─── 经验库（看板核心新增：浏览 / 检索 / 评审） ────────────────
  app.get('/api/experiences', async (req, res) => {
    const { repo = DEFAULT_REPO, status = 'all', source = 'all', module = '', keyword = '', page = '1', pageSize = '20' } = req.query
    const p = Math.max(1, parseInt(page) || 1)
    const size = Math.min(100, Math.max(1, parseInt(pageSize) || 20))
    const { rows, total } = await queryExperiences({
      repo, status, source, module: module || null, keyword,
      limit: size, offset: (p - 1) * size,
    })

    // facets 按 repo 维度统计（与列表筛选解耦，保证 tabs / 下拉始终稳定可选）
    const repoSql = repo !== 'all' ? 'WHERE repo = ?' : ''
    const repoParams = repo !== 'all' ? [repo] : []
    const statuses = Object.fromEntries(
      (await db.prepare(`SELECT status, COUNT(*) as c FROM experiences ${repoSql} GROUP BY status`).all(...repoParams)).map((r) => [r.status, r.c])
    )
    const modules = await db
      .prepare(`SELECT module, COUNT(*) as c FROM experiences ${repoSql ? repoSql + ' AND' : 'WHERE'} module IS NOT NULL AND module != '' GROUP BY module ORDER BY c DESC LIMIT 30`)
      .all(...repoParams)
    const sources = Object.fromEntries(
      (await db.prepare(`SELECT source, COUNT(*) as c FROM experiences ${repoSql} GROUP BY source`).all(...repoParams)).map((r) => [r.source, r.c])
    )

    res.json({
      ok: true,
      items: rows,
      total,
      page: p,
      pageSize: size,
      facets: {
        statuses: { all: Object.values(statuses).reduce((a, b) => a + b, 0), ...statuses },
        sources: { all: Object.values(sources).reduce((a, b) => a + b, 0), ...sources },
        modules,
      },
    })
  })

  app.get('/api/experiences/:id', async (req, res) => {
    const row = await db.prepare('SELECT * FROM experiences WHERE id = ?').get(req.params.id)
    if (!row) {
      res.status(404).json({ error: `经验不存在：${req.params.id}` })
      return
    }
    res.json({ ok: true, item: row })
  })

  /** 评审经验：镜像 distill_set_status 语义（pending → reviewed / obsolete，可回填 rule_ref） */
  app.post('/api/experiences/:id/status', async (req, res) => {
    const { status, ruleRef, author } = req.body || {}
    if (!EXP_STATUSES.includes(status)) {
      res.status(400).json({ error: `status 必须是 ${EXP_STATUSES.join(' / ')}` })
      return
    }
    if (!author) {
      res.status(400).json({ error: '缺少评审人 author' })
      return
    }
    const row = await db.prepare('SELECT * FROM experiences WHERE id = ?').get(req.params.id)
    if (!row) {
      res.status(404).json({ error: `经验不存在：${req.params.id}` })
      return
    }
    const now = new Date().toISOString()
    await db.prepare('UPDATE experiences SET status = ?, rule_ref = COALESCE(?, rule_ref), updated_at = ? WHERE id = ?')
      .run(status, ruleRef || null, now, row.id)
    await recordAuditEvent({
      eventType: 'exp_review',
      repo: row.repo,
      taskId: row.task_id,
      author,
      argsPreview: JSON.stringify({ id: row.id, status, ruleRef: ruleRef || null }),
      detail: `【评审经验】${row.id} ${row.status} → ${status}${ruleRef ? `（规则：${ruleRef}）` : ''}`,
    })
    const fresh = await db.prepare('SELECT * FROM experiences WHERE id = ?').get(row.id)
    console.log(`[${new Date().toLocaleTimeString()}] ✅ 经验评审 ${row.id} ${row.status} → ${status} @${author}`)
    res.json({ ok: true, item: fresh })
  })

  // ─── 项目列表（顶栏全局筛选） ─────────────────────────────────
  app.get('/api/repos', async (req, res) => {
    const map = new Map()
    const bump = (repo, key, c) => {
      if (!repo) return
      if (!map.has(repo)) map.set(repo, { repo, experiences: 0, docs: 0, tasks: 0 })
      map.get(repo)[key] = c
    }
    for (const r of await db.prepare('SELECT repo, COUNT(*) as c FROM experiences GROUP BY repo').all()) bump(r.repo, 'experiences', r.c)
    for (const r of await db.prepare('SELECT repo, COUNT(*) as c FROM docs GROUP BY repo').all()) bump(r.repo, 'docs', r.c)
    for (const r of await db.prepare('SELECT repo, COUNT(*) as c FROM tasks GROUP BY repo').all()) bump(r.repo, 'tasks', r.c)
    const repos = [...map.values()].sort((a, b) => (b.experiences + b.docs + b.tasks) - (a.experiences + a.docs + a.tasks))
    res.json({ ok: true, repos, defaultRepo: DEFAULT_REPO })
  })

  // ─── 任务列表 ─────────────────────────────────────────────────
  app.get('/api/tasks', async (req, res) => {
    const { repo = 'all', status = 'open', limit = '200' } = req.query
    const size = Math.min(500, Math.max(1, parseInt(limit) || 200))
    const where = []
    const params = []
    if (repo !== 'all') {
      where.push('repo = ?')
      params.push(repo)
    }
    if (status === 'open') where.push("phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted')")
    else if (status === 'done') where.push("phase IN ('DONE', 'done')")
    else if (status === 'aborted') where.push("phase IN ('ABORTED', 'aborted')")
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const items = await db
      .prepare(`SELECT task_id, repo, requirement, type, phase, completed, pending, author, created_at, updated_at, closed_at FROM tasks ${whereSql} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, size)
    // 当前返回集合批量查询，按 (repo, taskId) 关联；不逐任务计算 AC/F2P。
    const summaries = await db.tx(async (tx) => await readTaskGateSummaries(tx, items))
    const gateMap = Object.create(null)
    const taskIdCounts = new Map()
    for (const item of items) taskIdCounts.set(item.task_id, (taskIdCounts.get(item.task_id) || 0) + 1)
    for (const item of items) {
      const entry = summaries.get(taskTestingKey(item.repo, item.task_id))
      item.gateSummary = entry.summary
      // 旧 gates 无仓库维度：同名歧义时不向任何仓串数据；新入口始终读行内 gateSummary。
      if (entry.legacy && taskIdCounts.get(item.task_id) === 1) gateMap[item.task_id] = entry.legacy
    }
    const phaseCounts = {}
    if (repo !== 'all') {
      for (const r of await db.prepare('SELECT phase, COUNT(*) as c FROM tasks WHERE repo = ? GROUP BY phase').all(repo)) phaseCounts[r.phase] = r.c
    } else {
      for (const r of await db.prepare('SELECT phase, COUNT(*) as c FROM tasks GROUP BY phase').all()) phaseCounts[r.phase] = r.c
    }
    res.json({ ok: true, items, phaseCounts, gates: gateMap })
  })

  // ─── 知识库（列表 + 详情，内容只读；版本历史 / 回滚沿用既有端点） ──
  app.get('/api/docs', async (req, res) => {
    const { repo = DEFAULT_REPO, keyword = '' } = req.query
    const where = []
    const params = []
    if (repo !== 'all') {
      where.push('repo = ?')
      params.push(repo)
    }
    if (keyword.trim()) {
      where.push('(name LIKE ? OR category LIKE ?)')
      params.push(`%${keyword.trim()}%`, `%${keyword.trim()}%`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const items = await db
      .prepare(`SELECT repo, name, category, updated_at, updated_by, LENGTH(content) as size FROM docs ${whereSql} ORDER BY category, name`)
      .all(...params)
    res.json({ ok: true, items })
  })

  app.get('/api/docs/detail', async (req, res) => {
    const { name, repo = DEFAULT_REPO } = req.query
    if (!name) {
      res.status(400).json({ error: '缺少 name' })
      return
    }
    const row = await db.prepare('SELECT repo, name, category, content, updated_at, updated_by FROM docs WHERE repo = ? AND name = ?').get(repo, name)
    if (!row) {
      res.status(404).json({ error: `文档不存在：${repo}/${name}` })
      return
    }
    const versionCount = (await db.prepare('SELECT COUNT(*) as c FROM docs_versions WHERE repo = ? AND name = ?').get(repo, name)).c
    res.json({ ok: true, doc: row, versionCount })
  })

  // ─── 总览聚合（一屏拉齐所有卡片数据） ──────────────────────────
  app.get('/api/overview', async (req, res) => {
    const repo = req.query.repo || DEFAULT_REPO
    const all = repo === 'all'
    const expWhere = all ? '' : 'WHERE repo = ?'
    const rp = all ? [] : [repo]
    const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString()

    const expTotal = (await db.prepare(`SELECT COUNT(*) as c FROM experiences ${expWhere}`).get(...rp)).c
    const expPending = (await db.prepare(`SELECT COUNT(*) as c FROM experiences ${all ? 'WHERE' : 'WHERE repo = ? AND'} status = 'pending'`).get(...rp)).c
    const tasksOpen = (await db.prepare(`SELECT COUNT(*) as c FROM tasks ${all ? "WHERE phase NOT IN ('DONE','ABORTED','done','aborted')" : "WHERE repo = ? AND phase NOT IN ('DONE','ABORTED','done','aborted')"}`).get(...rp)).c
    const docsCount = (await db.prepare(`SELECT COUNT(*) as c FROM docs ${expWhere}`).get(...rp)).c
    const eventsToday = (await db.prepare(all ? 'SELECT COUNT(*) as c FROM audit_events WHERE created_at >= ?' : 'SELECT COUNT(*) as c FROM audit_events WHERE repo = ? AND created_at >= ?').get(...(all ? [] : [repo]), todayStart)).c

    const recentExperiences = await db
      .prepare(`SELECT id, repo, content, status, source, author, module, tags, created_at FROM experiences ${all ? 'WHERE' : 'WHERE repo = ? AND'} status != 'obsolete' ORDER BY created_at DESC LIMIT 6`)
      .all(...rp)
    const recentEvents = await queryAuditEvents(all ? { limit: 10 } : { repo, limit: 10 })

    const flywheel = all
      ? await (async () => {
          // 全部项目：逐 repo 聚合后合并
          const repos = (await db.prepare('SELECT DISTINCT repo FROM experiences').all()).map((r) => r.repo)
          const merged = { pending: 0, driftWeek: 0, distillHit: 0, distillMiss: 0, missKeywords: [], modules: [] }
          for (const r of repos) {
            const s = await flywheelStats(r)
            merged.pending += s.pending
            merged.driftWeek += s.driftWeek
            merged.distillHit += s.distillHit
            merged.distillMiss += s.distillMiss
            merged.missKeywords.push(...s.missKeywords)
            if (s.modules !== '无') merged.modules.push(s.modules)
          }
          return { ...merged, reuseCount: merged.distillHit, missKeywords: [...new Set(merged.missKeywords)].slice(0, 12), modules: merged.modules.join(' · ') || '无' }
        })()
      : await flywheelStats(repo)

    res.json({
      ok: true,
      repo,
      stats: { expTotal, expPending, tasksOpen, docsCount, eventsToday },
      flywheel,
      recentExperiences,
      recentEvents,
      generatedAt: new Date().toISOString(),
    })
  })
}
