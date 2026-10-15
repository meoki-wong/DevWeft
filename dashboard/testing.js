/**
 * dashboard/testing.js — 测试资产库 + 运行进度的看板/REST API
 *
 * 双前缀设计：
 *  - /v1/test-specs      ：MCP 工具与 AI coding 的编程入口（提交/查询/取内容）
 *  - /api/testing/*      ：看板面板入口（清单/流转/聚合，写操作记审计）
 *
 * 数据源：data/team.db（schema v9 test_specs + test_submissions/test_runs）
 */
import db from '../db.js'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTestSpec, listTestSpecs, transitionTestSpec, normalizeRepoId, getE2eInjectMode, setE2eInjectMode, E2E_INJECT_MODES } from '../testing/test-specs.js'
import { createBlobStore } from '../testing/blobs.js'
import { readZipCentralEntries } from '../scanner/zipscan.mjs'
import { recordAuditEvent } from '../audit/index.js'
import { setRepoGateMode, GATE_MODES, isCloudTestingEnabled, getRepoGateMode } from '../harness/testing-gate.js'
import { buildTimeline, buildSummary, buildFailureAnalysis } from '../testing/report-timeline.js'
import {
  listRepoEnvAccounts,
  setRepoEnvAccount,
  clearRepoEnvAccount,
  getDefaultTestEnv,
  setDefaultTestEnv,
  ENV_ACCOUNT_ENVS,
} from '../testing/accounts.js'
import { requeueRun } from '../testing/leases.js'
import { grantGateRetryBudget } from '../harness/loop.js'
import { evaluateAcCoverage, getTaskAcceptance, describeMutationVerification } from '../harness/testing-gate.js'
import { resolveRepoWorkspacePath, getRepoPlatformProfile } from '../testing/repo-platform.js'
import { getTenantContextHints } from '../testing/tenant-config.js'
import { resolveGatePolicy, previewGatePolicy, setPlatformSetting, getPlatformSetting, upsertGateRiskRule, listGateRiskRules, isDynamicGateEnabled } from '../harness/gate-policy.js'
import { qualityDashboard, registerEscape, listEscapes } from '../testing/quality-metrics.js'
import { quarantineSpec, listQuarantined, exitQuarantine, ensureFlakyColumns } from '../testing/flaky.js'
import { forceStopTask } from '../harness/stop-task.js'
import { readTaskTestingView as readTestingView, readCloudTestingStatus, loadRunArtifactEntries as readArtifactEntries, utf8Tail, buildTaskTrace, buildCoverageMap, buildDevStats, buildPlatformStatus, buildNightlyReport } from './testing-read-model.js'
import { lanhuConfigured } from '../testing/lanhu-gateway.js'

// 既有 previewGatePolicy 会 ensure 表结构/补写配置，不满足 GET 只读约束，故不注入。
const testingReaders = { getTaskAcceptance, evaluateAcCoverage, describeMutationVerification, getRepoGateMode }

function requireReadSpec(sha256) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'test-specs')
  const p = join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256)
  if (!existsSync(p)) return ''
  return readFileSync(p, 'utf8')
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO = 'demo-app'
const REVIEW_STATUSES = ['draft', 'reviewed', 'active', 'archived', 'orphan-candidate']
const LOG_TEXT_EXT = /\.(xml|json|log|txt|md)$/i
const LOG_IMAGE_EXT = /\.(png|jpg|jpeg|webm)$/i
const LOG_VIEW_MAX_BYTES = 512 * 1024

// dashboard 与 server 同进程，直接读 blobs 内容寻址存储（不走 HMAC 一次性下载——那是给外部客户端的）
const blobs = createBlobStore(join(__dirname, '..', 'data', 'blobs'))

function err400(res, msg) { res.status(400).json({ error: msg }) }
function err404(res, msg) { res.status(404).json({ error: msg }) }
/** §14：base_url 校验（http(s) 开头、可解析、无路径/search/hash，去尾斜杠保存） */
function validateBaseUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!/^https?:\/\//i.test(s)) return { ok: false, reason: 'base_url 必须以 http:// 或 https:// 开头' }
  let u
  try { u = new URL(s) } catch { return { ok: false, reason: 'base_url 不是合法 URL' } }
  if (u.search) return { ok: false, reason: 'base_url 不允许带 query' }
  if (u.hash) return { ok: false, reason: 'base_url 不允许带 hash' }
  if (u.pathname && u.pathname !== '/') return { ok: false, reason: 'base_url 不允许带路径' }
  return { ok: true, url: s.replace(/\/+$/, '') }
}
function safeJson(s, fb = []) {
  try {
    return JSON.parse(s || (typeof fb === 'string' ? fb : JSON.stringify(fb)))
  } catch {
    return fb
  }
}

/** 看板聚合：资产库统计 + 最近 M 组运行摘要（/api/testing/overview 共用）。 */
export async function testingOverview(rawRepo) {
  // test_specs.repo_id 存 UUID；看板传 slug，必须归一（否则统计恒 0 的既有坑）；'all' = 跨项目聚合不过滤
  const repo = rawRepo === 'all' ? null : await normalizeRepoId(rawRepo)
  const repoWhere = repo ? 'WHERE repo_id = ?' : ''
  const rp = repo ? [repo] : []
  const stats = await db
    .prepare(
      `SELECT review_status, COUNT(*) as c FROM test_specs ${repoWhere} GROUP BY review_status`
    )
    .all(...rp)
  const statMap = Object.fromEntries(stats.map((r) => [r.review_status, r.c]))
  const orphans = await db
    .prepare(
      `SELECT feature_key, feature_title, fail_streak, last_result, updated_at
       FROM test_specs ${repo ? 'WHERE repo_id = ? AND' : 'WHERE'} review_status = 'orphan-candidate' ORDER BY updated_at DESC`
    )
    .all(...rp)
  const recent = await db
    .prepare(
      `SELECT s.submission_id, s.status, s.created_at,
              g.required_units_json,
              (SELECT COUNT(*) FROM test_runs r WHERE r.run_group_id = g.run_group_id AND r.status = 'passed') as passed_units,
              (SELECT COUNT(*) FROM test_runs r WHERE r.run_group_id = g.run_group_id) as total_units
       FROM test_submissions s JOIN run_groups g ON g.submission_id = s.submission_id
       ${repo ? 'WHERE s.repo_id = ?' : ''} ORDER BY s.created_at DESC LIMIT 10`
    )
    .all(...rp)
  return {
    specs: {
      total: Object.values(statMap).reduce((a, b) => a + b, 0),
      byStatus: statMap,
      orphans,
    },
    recentRuns: recent,
  }
}

// 保留旧导出与默认读者；隔离测试直接导入 testing-read-model，不加载此路由模块。
export async function readTaskTestingView(conn, query, readers = testingReaders) {
  return readTestingView(conn, query, readers)
}

export function mountTestingDashboard(app) {
  // ── 看板面板入口（/api/testing）──────────────────────────────

  // P0-2b：deferred 队列健康——主机停摆导致云测静默积压时给看板一个显式红灯数据源。
  app.get('/api/testing/deferred-health', async (req, res) => {
    try {
      const { getDeferredHealth } = await import('../testing/deferred.js')
      const health = await getDeferredHealth(db)
      res.json({ ok: true, ...health })
    } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }) }
  })

  /** 测试资产目录：指标 + 模块树 + 过滤列表（独立「测试资产」页）
   * 注意：不能挂在 /api/testing/specs/catalog，会被 /api/testing/specs/:featureKey 抢走 */
  app.get('/api/testing/spec-catalog', async (req, res) => {
    try {
      const repoQ = req.query.repo || DEFAULT_REPO
      const allRepos = repoQ === 'all'
      const q = String(req.query.q || '').trim().toLowerCase()
      const type = req.query.type || ''
      const status = req.query.status || ''
      const side = req.query.side || ''
      const sort = req.query.sort || 'updated'

      let specs = await listTestSpecs({ repoId: allRepos ? null : repoQ })
      // 全部项目时补 slug，便于卡片展示
      if (allRepos) {
        const slugMap = new Map(
          (await db.prepare('SELECT repo_id, slug FROM repositories').all()).map((r) => [r.repo_id, r.slug])
        )
        specs = specs.map((s) => ({ ...s, slug: slugMap.get(s.repo_id) || s.repo_id }))
      }
      const metrics = {
        total: specs.length,
        active: specs.filter((s) => s.review_status === 'active').length,
        draft: specs.filter((s) => s.review_status === 'draft').length,
        orphan: specs.filter((s) => s.review_status === 'orphan-candidate').length,
        streak3: specs.filter((s) => (s.fail_streak || 0) >= 3).length,
        byType: { e2e: 0, smoke: 0, unit: 0 },
      }
      for (const s of specs) {
        if (metrics.byType[s.spec_type] != null) metrics.byType[s.spec_type] += 1
      }

      let items = specs
      if (type) items = items.filter((s) => s.spec_type === type)
      if (status) items = items.filter((s) => s.review_status === status)
      if (side) items = items.filter((s) => (s.side || 'both') === side)
      if (q) {
        items = items.filter((s) =>
          String(s.feature_key || '').toLowerCase().includes(q) ||
          String(s.feature_title || '').toLowerCase().includes(q) ||
          String(s.demand_ref || '').toLowerCase().includes(q) ||
          String(s.slug || '').toLowerCase().includes(q)
        )
      }
      items = [...items].sort((a, b) => {
        if (sort === 'streak') return (b.fail_streak || 0) - (a.fail_streak || 0)
        if (sort === 'key') return String(a.feature_key).localeCompare(String(b.feature_key))
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
      })

      const modules = new Map()
      for (const s of specs) {
        const mod = String(s.feature_key || '').split('-').slice(0, 2).join('-') || 'other'
        if (!modules.has(mod)) modules.set(mod, [])
        modules.get(mod).push({
          featureKey: s.feature_key,
          status: s.review_status,
          lastResult: s.last_result,
          version: s.version,
        })
      }
      const tree = [...modules.entries()]
        .map(([module, keys]) => ({
          module,
          count: keys.length,
          active: keys.filter((k) => k.status === 'active').length,
          failed: keys.filter((k) => k.lastResult === 'failed').length,
          keys: keys.sort((a, b) => a.featureKey.localeCompare(b.featureKey)),
        }))
        .sort((a, b) => a.module.localeCompare(b.module))

      res.json({
        repo: repoQ,
        metrics,
        tree,
        items: items.map((s) => ({
          featureKey: s.feature_key,
          featureTitle: s.feature_title,
          demandRef: s.demand_ref,
          author: s.author,
          specType: s.spec_type,
          side: s.side,
          version: s.version,
          reviewStatus: s.review_status,
          lastResult: s.last_result,
          failStreak: s.fail_streak || 0,
          historyCount: (s.history || []).length + 1,
          updatedAt: s.updated_at,
          createdAt: s.created_at,
          slug: s.slug || null,
          scope: s.scope || 'task',
        })),
      })
    } catch (e) {
      err400(res, e.message)
    }
  })

  /** 资产详情：meta + 源码 + 版本历史 */
  app.get('/api/testing/spec-catalog/:featureKey', async (req, res) => {
    try {
      const repoQ = req.query.repo || DEFAULT_REPO
      const version = req.query.version ? Number(req.query.version) : null
      // 全部项目：按 feature_key 在任意仓找最新/指定版本
      let spec
      if (repoQ === 'all') {
        const row = await db
          .prepare(
            `SELECT * FROM test_specs WHERE feature_key=? ${version ? 'AND version=?' : ''}
             ORDER BY version DESC LIMIT 1`
          )
          .get(...(version ? [req.params.featureKey, version] : [req.params.featureKey]))
        if (!row) return err404(res, `资产不存在：${req.params.featureKey}`)
        const slug = (await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(row.repo_id))?.slug
        spec = {
          ...row,
          content: requireReadSpec(row.blob_sha256),
          slug,
        }
      } else {
        spec = await getTestSpec({ repoId: repoQ, featureKey: req.params.featureKey, version })
      }
      const repoIdForHist = spec.repo_id || await normalizeRepoId(repoQ)
      const history = await db
        .prepare(
          `SELECT version, review_status, last_result, fail_streak, author, updated_at, spec_type, side
           FROM test_specs
           WHERE repo_id = ? AND feature_key = ?
           ORDER BY version DESC`
        )
        .all(repoIdForHist, req.params.featureKey)
      res.json({
        meta: {
          featureKey: spec.feature_key,
          featureTitle: spec.feature_title,
          demandRef: spec.demand_ref,
          author: spec.author,
          specType: spec.spec_type,
          side: spec.side,
          version: spec.version,
          reviewStatus: spec.review_status,
          lastResult: spec.last_result,
          failStreak: spec.fail_streak,
          entry: spec.entry,
          codeCommitOid: spec.code_commit_oid,
          updatedAt: spec.updated_at,
          slug: spec.slug || null,
        },
        content: spec.content,
        history,
      })
    } catch (e) {
      err404(res, `资产不存在：${req.params.featureKey}`)
    }
  })

  /** 资产关联的最近执行（caseKey 含 featureKey） */
  app.get('/api/testing/spec-catalog/:featureKey/runs', async (req, res) => {
    try {
      const fk = req.params.featureKey
      const repoQ = req.query.repo || DEFAULT_REPO
      const like = `%test:spec/${fk}%`
      const like2 = `%test:unit-spec/${fk}%`
      let rows
      if (repoQ === 'all') {
        rows = await db
          .prepare(
            `SELECT r.run_id, r.unit, r.side, r.status, r.finished_at, r.created_at,
                    g.submission_id, r.report_json
             FROM test_runs r
             JOIN run_groups g ON g.run_group_id = r.run_group_id
             WHERE r.report_json LIKE ? OR r.report_json LIKE ?
             ORDER BY r.created_at DESC LIMIT 20`
          )
          .all(like, like2)
      } else {
        const repoId = await normalizeRepoId(repoQ)
        rows = await db
          .prepare(
            `SELECT r.run_id, r.unit, r.side, r.status, r.finished_at, r.created_at,
                    g.submission_id, r.report_json
             FROM test_runs r
             JOIN run_groups g ON g.run_group_id = r.run_group_id
             WHERE r.repo_id = ? AND (r.report_json LIKE ? OR r.report_json LIKE ?)
             ORDER BY r.created_at DESC LIMIT 20`
          )
          .all(repoId, like, like2)
      }
      res.json(
        rows.map((r) => {
          let check = null
          try {
            const checks = JSON.parse(r.report_json || 'null')?.checks || []
            check = checks.find((c) => String(c.caseKey || '').includes(fk)) || null
          } catch { /* ignore */ }
          return {
            runId: r.run_id,
            unit: r.unit,
            side: r.side,
            status: r.status,
            createdAt: r.created_at,
            finishedAt: r.finished_at,
            submissionId: r.submission_id,
            checkStatus: check?.status || null,
            checkDetail: check?.detail || null,
          }
        })
      )
    } catch (e) {
      err400(res, e.message)
    }
  })

  // CLRP 门禁闭环：活跃 loop + 租约（断点续作可见性）
  app.get('/api/testing/gate-loops', async (req, res) => {
    try {
      const rows = await db
        .prepare(
          `SELECT g.*, s.owner_subject, s.session_id, s.expires_at AS session_expires_at, s.client_name
           FROM gate_loops g
           LEFT JOIN task_sessions s
             ON s.repo = g.repo AND s.task_id = g.task_id AND s.released_at IS NULL
           WHERE g.state != 'coding' OR g.iteration > 0 OR g.needs_human = 1
           ORDER BY g.updated_at DESC LIMIT 50`
        )
        .all()
      const parsed = rows.map((r) => ({
        repo: r.repo,
        taskId: r.task_id,
        state: r.state,
        iteration: r.iteration,
        maxIterations: r.max_iterations,
        phase: r.phase,
        size: r.size,
        requiredUnits: safeJson(r.required_units_json),
        pendingActions: safeJson(r.pending_actions_json),
        lastBindingId: r.last_binding_id,
        lastTerminal: r.last_terminal,
        lastClass: r.last_class,
        awaitDistill: Boolean(r.await_distill),
        needsHuman: Boolean(r.needs_human),
        history: safeJson(r.history_json),
        updatedAt: r.updated_at,
        owner: r.owner_subject || null,
        sessionId: r.session_id || null,
        sessionExpiresAt: r.session_expires_at || null,
        clientName: r.client_name || null,
      }))
      res.json(parsed)
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 看板「云端测试」聚合状态（只读、单一真相）：把散在 submissions/runs/attempts/gate_loop 的
  // 多条状态收敛成一个节点级状态，根治“某轮 run passed 就画完成 → 又重开”的错觉。
  // finished 仅在任务真越过 EXECUTE（VERIFY/DONE/CLOSED）或环终态时才 true；中间轮次绿不算结束。
  app.get('/api/testing/cloud-status', async (req, res) => {
    try {
      const taskId = String(req.query.taskId || '').trim()
      if (!taskId) return err400(res, '缺少 taskId')
      const repo = String(req.query.repo || DEFAULT_REPO).trim()

      const read = async (tx) => await readCloudTestingStatus(tx, { taskId, repo }, testingReaders)
      res.json(await db.tx(read))
    } catch (e) {
      err400(res, e.message)
    }
  })

  // needs_human 人工处置：waiver 解除并补发迭代预算后允许继续闭环
  app.post('/api/testing/gate-loops/waiver', async (req, res) => {
    const { repo = DEFAULT_REPO, taskId, author, note, extraIterations } = req.body || {}
    if (!taskId || !author) return err400(res, '缺少 taskId / author')
    try {
      const granted = await grantGateRetryBudget(db, {
        repo,
        taskId,
        actor: author,
        extraIterations: Number(extraIterations) > 0 ? Number(extraIterations) : undefined,
      })
      if (!granted.granted && granted.code === 'NO_GATE_LOOP') return err404(res, granted.reason)
      await recordAuditEvent({
        tool_name: 'gate_loop_waiver',
        repo,
        task_id: taskId,
        detail: granted.granted
          ? `waiver ${granted.waiverId} by ${author}${note ? `: ${note}` : ''} maxIterations=${granted.maxIterations}`
          : `noop by ${author}: ${granted.reason}`,
      })
      res.json({
        ok: true,
        granted: granted.granted,
        waiverId: granted.waiverId || null,
        maxIterations: granted.loop?.maxIterations ?? null,
        taskId,
        repo,
      })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 云端测试独立可插拔：按仓开关（disabled = 该仓不走云端测试，其他仓不受影响）
  app.get('/api/testing/gate-mode', async (req, res) => {
    try {
      const repo = req.query.repo || DEFAULT_REPO
      const rows = await db
        .prepare(
          `SELECT r.slug, r.display_name, COALESCE(m.mode, 'legacy') AS mode, m.updated_at
           FROM repositories r
           LEFT JOIN repo_gate_modes m ON m.repo_id = r.repo_id
           ORDER BY r.slug`
        )
        .all()
      res.json({
        allowedModes: GATE_MODES,
        repo,
        mode: rows.find((x) => x.slug === repo)?.mode || 'legacy',
        enabled: await isCloudTestingEnabled(db, repo),
        repos: rows.map((x) => ({ ...x, enabled: x.mode !== 'disabled' })),
      })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/gate-mode', async (req, res) => {
    const { repo, mode, author } = req.body || {}
    if (!repo || !mode) return err400(res, '缺少 repo / mode')
    try {
      const applied = await setRepoGateMode(db, repo, mode)
      await recordAuditEvent({
        tool_name: 'repo_gate_mode_set',
        repo,
        task_id: null,
        detail: `mode=${applied}${author ? ` by ${author}` : ''}`,
      })
      res.json({ ok: true, repo, mode: applied, enabled: await isCloudTestingEnabled(db, repo) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 变异验卷可观测：排队/执行/终态一览（无需查库）
  app.get('/api/testing/mutations', async (req, res) => {
    try {
      const repo = req.query.repo || null
      let sql = `
        SELECT r.run_id, r.status, r.next_attempt, r.max_attempts,
               r.created_at, r.started_at, r.finished_at, r.terminal_reason,
               r.payload_json, g.status AS group_status, rep.slug
        FROM test_runs r
        LEFT JOIN run_groups g ON g.run_group_id = r.run_group_id
        LEFT JOIN repositories rep ON rep.repo_id = r.repo_id
        WHERE r.purpose = 'mutation'
      `
      const params = []
      if (repo) {
        sql += ' AND rep.slug = ?'
        params.push(repo)
      }
      sql += ' ORDER BY r.created_at DESC LIMIT 100'
      const rows = await db.prepare(sql).all(...params)
      const items = rows.map((r) => {
        let fk = null
        try { fk = JSON.parse(r.payload_json || '{}').featureKey || null } catch { /* ignore */ }
        return {
          runId: r.run_id,
          featureKey: fk,
          status: r.status,
          attempt: `${r.next_attempt}/${r.max_attempts}`,
          terminalReason: r.terminal_reason,
          groupStatus: r.group_status,
          repo: r.slug,
          createdAt: r.created_at,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          durationMs:
            r.started_at && r.finished_at
              ? Date.parse(r.finished_at) - Date.parse(r.started_at)
              : null,
        }
      })
      const summary = {
        total: items.length,
        queued: items.filter((i) => i.status === 'queued').length,
        running: items.filter((i) => i.status === 'active' || i.status === 'running').length,
        passed: items.filter((i) => i.status === 'passed').length,
        failed: items.filter((i) => i.status === 'failed').length,
        error: items.filter((i) => i.status === 'error').length,
      }
      res.json({ ok: true, summary, items })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 租户健康检查：工作区 / gate / active 考卷是否齐
  app.get('/api/testing/projects/:slug/health', async (req, res) => {
    try {
      const slug = req.params.slug
      const repo = await db.prepare('SELECT repo_id, slug, enabled FROM repositories WHERE slug=?').get(slug)
      if (!repo) return err404(res, `未登记租户：${slug}`)
      const mode = await getRepoGateMode(db, slug)
      const ws = resolveRepoWorkspacePath(slug)
      const profile = getRepoPlatformProfile(slug)
      let activeSpecs = 0
      let orphanSpecs = 0
      try {
        activeSpecs = (await db.prepare(
          "SELECT COUNT(*) c FROM test_specs WHERE repo_id=? AND review_status='active'"
        ).get(repo.repo_id)).c
        orphanSpecs = (await db.prepare(
          "SELECT COUNT(*) c FROM test_specs WHERE repo_id=? AND review_status='orphan-candidate'"
        ).get(repo.repo_id)).c
      } catch { /* ignore */ }
      const issues = []
      if (!ws || !existsSync(ws)) issues.push('WORKSPACE_MISSING')
      if (!profile) issues.push('PLATFORM_PROFILE_MISSING')
      if (mode === 'disabled') issues.push('GATE_DISABLED')
      res.json({
        ok: issues.length === 0,
        slug,
        mode,
        workspace: ws ? { path: ws, exists: existsSync(ws) } : null,
        hasProfile: Boolean(profile),
        activeSpecs,
        orphanSpecs,
        issues,
      })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 项目管理（看板「项目管理」视图）：所有接入项目聚合 —— 档位 / 工作区 / 账号
  // QUERY_CLASS: ADMIN —— 跨租户列出全部 repositories，仅管理端使用（方案 §2.7/§7.1）
  app.get('/api/testing/projects', async (req, res) => {
    try {
      const repos = await db
        .prepare(
          `SELECT r.slug, r.display_name, COALESCE(m.mode, 'legacy') AS mode
           FROM repositories r
           LEFT JOIN repo_gate_modes m ON m.repo_id = r.repo_id
           ORDER BY r.slug`
        )
        .all()
      let platform = {}
      try {
        const raw = JSON.parse(
          readFileSync(join(__dirname, '..', 'data', 'repo-platform.json'), 'utf8')
        )
        platform = raw.repos || {}
      } catch { /* 无配置文件：仅显示已登记仓 */ }
      // 链路网关方案 §9：全局启用链路 + 项目首选（无行/空 = 走主链路）
      const allLinks = await db.prepare('SELECT link_id, name FROM links WHERE enabled = 1 ORDER BY sort_order, link_id').all()
      const prefRows = await db.prepare("SELECT repo, link_id FROM project_links WHERE link_id IS NOT NULL AND link_id <> ''").all()
      const prefMap = Object.fromEntries(prefRows.map((p) => [p.repo, p.link_id]))
      const linkBrief = allLinks.map((l) => ({ link_id: l.link_id, name: l.name }))
      const projects = await Promise.all(repos.map(async (r) => {
        const p = platform[r.slug] || null
        const ws = p?.workspacePath || resolveRepoWorkspacePath(r.slug) || null
        let specCount = 0
        try {
          const rid = await normalizeRepoId(r.slug)
          specCount = (await db.prepare('SELECT COUNT(*) c FROM test_specs WHERE repo_id=?').get(rid)).c
        } catch { /* 表不存在等：计 0 */ }
        return {
          slug: r.slug,
          display_name: r.display_name,
          mode: r.mode,
          enabled: r.mode !== 'disabled',
          e2eInjectMode: await getE2eInjectMode(db, r.slug),
          e2eInjectModes: E2E_INJECT_MODES,
          workspace: ws ? { path: ws, exists: existsSync(ws) } : null,
          profile: p ? { defaultSides: p.defaultSides || [], casePrefix: p.casePrefix || null } : null,
          accounts: await listRepoEnvAccounts(db, r.slug),
          defaultEnv: await getDefaultTestEnv(db, r.slug),
          tenant: getTenantContextHints(r.slug),
          defaultLinkId: prefMap[r.slug] || null,
          links: linkBrief,
          specCount,
        }
      }))
      res.json({ ok: true, envs: ENV_ACCOUNT_ENVS, defaultEnv: 'qa', projects })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // ─── 链路池与项目首选（链路网关方案 §9）─────────────────
  // GET /api/links：只返回表里的字段（探活/熔断在网关，此处不返回健康）
  app.get('/api/links', async (req, res) => {
    try {
      const links = await db.prepare('SELECT link_id, name, base_url, sort_order, is_primary, enabled, created_at, updated_at FROM links ORDER BY sort_order, link_id').all()
      res.json({ ok: true, links })
    } catch (e) { err400(res, e.message) }
  })

  // GET /api/links/runtime：供网关拉取，无鉴权。只返回启用链路 + 已设首选的项目
  app.get('/api/links/runtime', async (req, res) => {
    try {
      const links = await db.prepare('SELECT link_id, base_url, is_primary FROM links WHERE enabled = 1 ORDER BY sort_order, link_id').all()
      const prefs = await db.prepare("SELECT repo, link_id FROM project_links WHERE link_id IS NOT NULL AND link_id <> ''").all()
      res.json({
        links: links.map((l) => ({ linkId: l.link_id, baseUrl: l.base_url, isPrimary: Number(l.is_primary) })),
        projects: prefs.map((p) => ({ repo: p.repo, linkId: p.link_id })),
      })
    } catch (e) { err400(res, e.message) }
  })

  // POST /api/links：新增。校验 base_url；sort_order 缺省 max+1；is_primary=1 同事务降级旧主链路
  app.post('/api/links', async (req, res) => {
    try {
      const body = req.body || {}
      const nm = String(body.name ?? '').trim()
      if (!nm) return err400(res, 'name 必填')
      const vr = validateBaseUrl(body.baseUrl ?? body.base_url)
      if (!vr.ok) return err400(res, vr.reason)
      const wantPrimary = Number(body.isPrimary ?? body.is_primary ?? 0) === 1
      const linkId = String(body.linkId ?? body.link_id ?? '').trim() || randomUUID()
      const en = body.enabled == null ? 1 : (Number(body.enabled) ? 1 : 0)
      const now = new Date().toISOString()
      await db.tx(async (tx) => {
        let so = body.sortOrder ?? body.sort_order
        if (so == null || so === '') {
          const mx = await tx.prepare('SELECT MAX(sort_order) m FROM links').get()
          so = Number(mx?.m ?? -1) + 1
        }
        so = Number(so)
        if (wantPrimary) await tx.prepare('UPDATE links SET is_primary = 0, updated_at = ? WHERE is_primary = 1').run(now)
        await tx.prepare(
          'INSERT INTO links (link_id, name, base_url, sort_order, is_primary, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(linkId, nm, vr.url, so, wantPrimary ? 1 : 0, en, now, now)
      })
      res.json({ ok: true, linkId })
    } catch (e) { err400(res, e.message) }
  })

  // POST /api/links/:linkId：改名称/地址/序号/enabled；禁止停用主链路
  app.post('/api/links/:linkId', async (req, res) => {
    try {
      const { linkId } = req.params
      const row = await db.prepare('SELECT * FROM links WHERE link_id = ?').get(linkId)
      if (!row) return err404(res, '链路不存在')
      const body = req.body || {}
      const now = new Date().toISOString()
      const nm = body.name != null ? String(body.name).trim() : row.name
      if (!nm) return err400(res, 'name 不能为空')
      let url = row.base_url
      if (body.baseUrl != null || body.base_url != null) {
        const vr = validateBaseUrl(body.baseUrl ?? body.base_url)
        if (!vr.ok) return err400(res, vr.reason)
        url = vr.url
      }
      const so = body.sortOrder != null || body.sort_order != null ? Number(body.sortOrder ?? body.sort_order) : Number(row.sort_order)
      let en = Number(row.enabled)
      if (body.enabled != null) en = Number(body.enabled) ? 1 : 0
      if (Number(row.is_primary) === 1 && en === 0) return err400(res, '禁止停用主链路')
      await db.prepare('UPDATE links SET name=?, base_url=?, sort_order=?, enabled=?, updated_at=? WHERE link_id=?').run(nm, url, so, en, now, linkId)
      res.json({ ok: true })
    } catch (e) { err400(res, e.message) }
  })

  // DELETE /api/links/:linkId：禁止删主链路；删时把指向它的项目首选置空
  app.delete('/api/links/:linkId', async (req, res) => {
    try {
      const { linkId } = req.params
      const row = await db.prepare('SELECT * FROM links WHERE link_id = ?').get(linkId)
      if (!row) return err404(res, '链路不存在')
      if (Number(row.is_primary) === 1) return err400(res, '禁止删除主链路')
      const now = new Date().toISOString()
      await db.tx(async (tx) => {
        await tx.prepare('UPDATE project_links SET link_id = NULL, updated_at = ? WHERE link_id = ?').run(now, linkId)
        await tx.prepare('DELETE FROM links WHERE link_id = ?').run(linkId)
      })
      res.json({ ok: true })
    } catch (e) { err400(res, e.message) }
  })

  // POST /api/testing/projects/:slug/default-link：body { linkId:string|null }
  app.post('/api/testing/projects/:slug/default-link', async (req, res) => {
    try {
      const slug = String(req.params.slug || '').toLowerCase()
      const linkId = (req.body || {}).linkId
      const now = new Date().toISOString()
      if (linkId == null || linkId === '') {
        await db.prepare('DELETE FROM project_links WHERE repo = ?').run(slug)
        return res.json({ ok: true, linkId: null })
      }
      const link = await db.prepare('SELECT link_id, enabled FROM links WHERE link_id = ?').get(String(linkId))
      if (!link) return err400(res, 'linkId 不存在')
      if (Number(link.enabled) !== 1) return err400(res, 'linkId 必须指向启用中的链路')
      await db.prepare(
        'INSERT INTO project_links (repo, link_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (repo) DO UPDATE SET link_id = excluded.link_id, updated_at = excluded.updated_at'
      ).run(slug, String(linkId), now)
      res.json({ ok: true, linkId: String(linkId) })
    } catch (e) { err400(res, e.message) }
  })

  // 质量度量：infra/一次通过/考卷健康（正反馈观测）
  app.get('/api/testing/metrics', async (req, res) => {
    try {
      const repo = req.query.repo || null
      const days = Math.min(30, Math.max(1, Number(req.query.days) || 7))
      const since = new Date(Date.now() - days * 86400000).toISOString()
      let repoJoin = ''
      const params = [since]
      if (repo) {
        repoJoin = ' AND rep.slug = ?'
        params.push(repo)
      }
      const groups = await db.prepare(`
        SELECT g.status, COUNT(*) c FROM run_groups g
        LEFT JOIN repositories rep ON rep.repo_id = g.repo_id
        WHERE g.kind='formal' AND g.created_at >= ?${repoJoin}
        GROUP BY g.status
      `).all(...params)
      const attempts = await db.prepare(`
        SELECT r.status, r.terminal_reason, COUNT(*) c FROM test_runs r
        LEFT JOIN repositories rep ON rep.repo_id = r.repo_id
        WHERE r.purpose='gate' AND r.created_at >= ?${repoJoin}
        GROUP BY r.status, r.terminal_reason
      `).all(...params)
      const specs = repo
        ? await db.prepare(`
            SELECT review_status, scope, COUNT(*) c FROM test_specs s
            JOIN repositories rep ON rep.repo_id=s.repo_id
            WHERE rep.slug=? GROUP BY review_status, scope
          `).all(repo)
        : await db.prepare(`
            SELECT review_status, scope, COUNT(*) c FROM test_specs
            GROUP BY review_status, scope
          `).all()
      const groupTotal = groups.reduce((s, r) => s + r.c, 0)
      const groupPassed = groups.find((r) => r.status === 'passed')?.c || 0
      const runTotal = attempts.reduce((s, r) => s + r.c, 0)
      const infra = attempts.filter((r) => r.terminal_reason === 'infra_error' || r.status === 'error').reduce((s, r) => s + r.c, 0)
      const assertion = attempts.filter((r) => r.terminal_reason === 'assertion_failed').reduce((s, r) => s + r.c, 0)
      const f2p = await db.prepare(`
        SELECT f2p_status, COUNT(*) c FROM spec_f2p_results
        WHERE created_at >= ? GROUP BY f2p_status
      `).all(since)
      res.json({
        ok: true,
        days,
        repo: repo || 'all',
        gate: {
          groups: groupTotal,
          passed: groupPassed,
          passRate: groupTotal ? +(groupPassed / groupTotal).toFixed(3) : null,
          byStatus: Object.fromEntries(groups.map((r) => [r.status, r.c])),
        },
        runs: {
          total: runTotal,
          infra,
          assertion,
          infraRate: runTotal ? +(infra / runTotal).toFixed(3) : null,
        },
        specs: specs.map((r) => ({
          reviewStatus: r.review_status,
          scope: r.scope || 'task',
          count: r.c,
        })),
        f2p: Object.fromEntries(f2p.map((r) => [r.f2p_status, r.c])),
      })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 考卷 scope：task ↔ regression（决定是否始终注入）
  app.post('/api/testing/specs/scope', async (req, res) => {
    const { repo, featureKey, scope, author } = req.body || {}
    if (!repo || !featureKey || !['task', 'regression'].includes(scope)) {
      return err400(res, '需要 repo / featureKey / scope(task|regression)')
    }
    try {
      const rid = await normalizeRepoId(repo)
      const r = await db.prepare(
        `UPDATE test_specs SET scope=?, updated_at=? WHERE repo_id=? AND feature_key=? AND review_status='active'`
      ).run(scope, new Date().toISOString(), rid, featureKey)
      await recordAuditEvent({
        tool_name: 'spec_scope_set',
        repo,
        task_id: null,
        detail: `${featureKey} → ${scope}${author ? ` by ${author}` : ''} (${r.changes})`,
      })
      res.json({ ok: true, changed: r.changes, repo, featureKey, scope })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 经验聚合：近 N 天同类 distill 计数，供「经验→规范」候选
  app.get('/api/testing/distill-clusters', async (req, res) => {
    try {
      const days = Math.min(60, Math.max(1, Number(req.query.days) || 14))
      const since = new Date(Date.now() - days * 86400000).toISOString()
      const rows = await db.prepare(`
        SELECT repo, content, created_at, author FROM experiences
        WHERE category='dev' AND created_at >= ?
        ORDER BY created_at DESC LIMIT 500
      `).all(since)
      // 粗聚：按 content 前 80 字作 key
      const map = new Map()
      for (const r of rows) {
        const key = String(r.content || '').replace(/\s+/g, ' ').slice(0, 80)
        if (!map.has(key)) map.set(key, { key, count: 0, repos: new Set(), last: r.created_at })
        const g = map.get(key)
        g.count += 1
        if (r.repo) g.repos.add(r.repo)
        if (r.created_at > g.last) g.last = r.created_at
      }
      const clusters = [...map.values()]
        .filter((g) => g.count >= 3)
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)
        .map((g) => ({ key: g.key, count: g.count, repos: [...g.repos], last: g.last, hint: 'Repeated failures can be turned into a reusable project rule.' }))
      res.json({ ok: true, days, clusters })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 项目 E2E 注入策略：scoped（默认）/ all / regression_only
  app.post('/api/testing/projects/:slug/e2e-inject-mode', async (req, res) => {
    const { slug } = req.params
    const { mode, author } = req.body || {}
    try {
      const applied = await setE2eInjectMode(db, slug, mode)
      await recordAuditEvent({
        tool_name: 'e2e_inject_mode_set',
        repo: slug,
        task_id: null,
        detail: `mode=${applied.mode}${author ? ` by ${author}` : ''}`,
      })
      res.json({ ok: true, ...applied })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 账号设置/清除（password 只进 secret-broker；GET 永不回明文）
  app.post('/api/testing/projects/:slug/account', async (req, res) => {
    const { slug } = req.params
    const { env, username, password, action } = req.body || {}
    try {
      if (action === 'clear') {
        const out = await clearRepoEnvAccount(db, { repoIdOrSlug: slug, env })
        await recordAuditEvent({
          tool_name: 'repo_env_account_clear',
          repo: slug,
          task_id: null,
          detail: `env=${env}`,
        })
        return res.json({ ok: true, ...out })
      }
      const out = await setRepoEnvAccount(db, { repoIdOrSlug: slug, env, username, password })
      await recordAuditEvent({
        tool_name: 'repo_env_account_set',
        repo: slug,
        task_id: null,
        detail: `env=${env} username=${username}`,
      })
      res.json({ ok: true, ...out })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 默认测试环境切换（integration lane 按此环境执行）
  app.post('/api/testing/projects/:slug/default-env', async (req, res) => {
    const { slug } = req.params
    const { env } = req.body || {}
    try {
      const out = await setDefaultTestEnv(db, slug, env)
      await recordAuditEvent({
        tool_name: 'repo_default_env_set',
        repo: slug,
        task_id: null,
        detail: `defaultTestEnv=${env}`,
      })
      res.json({ ok: true, ...out })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // infra 挂起的人工重推：仅 infra_error/lost 终态可重新入队（重置重试预算，记审计）
  app.post('/api/testing/runs/:runId/requeue', async (req, res) => {
    const { runId } = req.params
    const { author } = req.body || {}
    try {
      const out = await requeueRun(db, runId, { actor: author || 'dashboard' })
      let slug = out.repoId
      try { slug = (await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(out.repoId))?.slug || out.repoId } catch { }
      await recordAuditEvent({
        tool_name: 'run_requeue',
        repo: slug,
        task_id: null,
        detail: `run=${runId} by ${author || 'dashboard'}`,
      })
      res.json({ ok: true, runId, status: 'queued' })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 审核档位切档（off/record/auto/ai/human，默认 record=行为不变）
  app.post('/api/testing/review-mode', async (req, res) => {
    const { repo, mode, author } = req.body || {}
    const REVIEW_MODES = ['off', 'record', 'auto', 'ai', 'human']
    if (!repo || !mode) return err400(res, '缺少 repo / mode')
    if (!REVIEW_MODES.includes(mode)) return err400(res, `mode 需为 ${REVIEW_MODES.join(' / ')}`)
    try {
      const repoId = await normalizeRepoId(repo)
      await db.prepare(
        `UPDATE repo_test_policies SET review_mode = ?, updated_at = ? WHERE repo_id = ?`
      ).run(mode, new Date().toISOString(), repoId)
      await recordAuditEvent({
        tool_name: 'review_mode_set',
        repo,
        task_id: null,
        detail: `review_mode=${mode}${author ? ` by ${author}` : ''}`,
      })
      res.json({ ok: true, repo, mode })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 平台设置：worker 并发数（1~3）/ 依赖缓存层（dep_cache）/ 变异静态预筛（mutation_static_skip）
  const PLATFORM_SETTING_KEYS = {
    worker_concurrency: { min: 1, max: 3, type: 'int' },
    dep_cache: { allowed: ['on', 'off'] },
    mutation_static_skip: { allowed: ['on', 'off'] },
  }
  app.get('/api/testing/platform-settings', async (req, res) => {
    try {
      // 双列兼容：优先 value，空则回退 value_json（避免 v26 只有 value_json 时整接口 500）
      const rows = await db.prepare('SELECT key, value, value_json FROM platform_settings').all()
      const pick = (k) => {
        const r = rows.find((x) => x.key === k)
        if (!r) return undefined
        if (r.value != null && r.value !== '') return r.value
        if (r.value_json != null && r.value_json !== '') {
          try {
            const p = JSON.parse(r.value_json)
            return typeof p === 'object' && p !== null ? r.value_json : String(p)
          } catch {
            return r.value_json
          }
        }
        return undefined
      }
      const envN = Number.parseInt(process.env.AWP_WORKER_CONCURRENCY || '', 10)
      const concurrency = Number.parseInt(pick('worker_concurrency') || '', 10) || (Number.isFinite(envN) ? envN : 2)
      res.json({
        ok: true,
        workerConcurrency: Math.max(1, Math.min(3, concurrency)),
        depCache: pick('dep_cache') || 'off',
        mutationStaticSkip: pick('mutation_static_skip') || 'off',
        allowed: PLATFORM_SETTING_KEYS,
      })
    } catch (e) { err400(res, e.message) }
  })

  app.post('/api/testing/platform-settings', async (req, res) => {
    const { key, value, author } = req.body || {}
    const spec0 = PLATFORM_SETTING_KEYS[key]
    if (!spec0) return err400(res, `不支持的设置项：${key}（支持 ${Object.keys(PLATFORM_SETTING_KEYS).join(' / ')}）`)
    if (spec0.type === 'int') {
      const n = Number.parseInt(value, 10)
      if (!Number.isFinite(n) || n < spec0.min || n > spec0.max) return err400(res, `${key} 须为 ${spec0.min}~${spec0.max}`)
    } else if (spec0.allowed && !spec0.allowed.includes(value)) {
      return err400(res, `${key} 须为 ${spec0.allowed.join(' / ')}`)
    }
    try {
      const now = new Date().toISOString()
      const v = String(value)
      // 双写 value + value_json，兼容读方
      await db.prepare(
        `INSERT INTO platform_settings(key, value, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value=excluded.value,
           value_json=excluded.value_json,
           updated_at=excluded.updated_at`
      ).run(key, v, JSON.stringify(v), now)
      await recordAuditEvent({ tool_name: 'platform_setting_set', repo: 'shared', task_id: null, detail: `${key}=${value} by ${author || 'dashboard'}` })
      res.json({ ok: true, key, value: v })
    } catch (e) { err400(res, e.message) }
  })

  // 失败立案（M5 旁路产物）
  app.get('/api/testing/failures', async (req, res) => {
    try {
      const rows = await db
        .prepare(
          `SELECT * FROM test_failures ORDER BY last_seen_at DESC LIMIT 50`
        )
        .all()
      res.json(rows)
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/experience-pending', async (req, res) => {
    try {
      const rows = await db
        .prepare(`SELECT * FROM experience_pending ORDER BY created_at DESC LIMIT 50`)
        .all()
      res.json(rows)
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 资产清单（支持 repo/author/demand/status/hint 过滤，按 feature_key 分组最新版 + history）
  app.get('/api/testing/specs', async (req, res) => {
    const repo = req.query.repo || DEFAULT_REPO
    const rows = await listTestSpecs({
      repoId: repo === 'all' ? null : repo,
      author: req.query.author || null,
      demandRef: req.query.demand || null,
      reviewStatus: req.query.status || null,
      featureHint: req.query.hint || null,
    })
    res.json(rows)
  })

  // 资产详情（看板点开单个 feature）
  app.get('/api/testing/specs/:featureKey', async (req, res) => {
    try {
      const version = req.query.version ? Number(req.query.version) : null
      const spec = await getTestSpec({ repoId: req.query.repo || DEFAULT_REPO, featureKey: req.params.featureKey, version })
      res.json(spec)
    } catch (e) {
      err404(res, `资产不存在：${req.params.featureKey}`)
    }
  })

  // 评审流转（看板人工确认：draft/reviewed → active，或归档/orphan 处置）
  app.post('/api/testing/specs/:featureKey/transition', async (req, res) => {
    const { version, reviewStatus, author } = req.body || {}
    if (!version) return err400(res, '缺少 version')
    if (!REVIEW_STATUSES.includes(reviewStatus)) {
      return err400(res, `reviewStatus 需为 ${REVIEW_STATUSES.join(' / ')}`)
    }
    if (!author) return err400(res, '缺少操作人 author')
    try {
      const spec = await transitionTestSpec({
        repoId: req.body.repoId || DEFAULT_REPO,
        featureKey: req.params.featureKey,
        version,
        reviewStatus,
        reviewer: `human:${author}`,
        notes: req.body.notes || null,
      })
      await recordAuditEvent({
        tool_name: 'test_spec_transition',
        repo: req.body.repoId || DEFAULT_REPO,
        detail: `feature=${req.params.featureKey} v${version} -> ${reviewStatus} by ${author}`,
      })
      res.json(spec)
    } catch (e) {
      err404(res, `资产不存在：${req.params.featureKey}`)
    }
  })

  // 看板聚合：资产统计 + orphan 清单 + 最近 M 组运行
  // 个人效能反馈（2026-09-26）：定位是开发者个人成长反馈，不是考核
  app.get('/api/testing/dev-stats', async (req, res) => {
    try {
      const author = req.query.author
      if (!author) return err400(res, 'author 必填')
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
      res.json({ ok: true, ...await buildDevStats(db, { author: String(author), days }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 平台状态自助页（2026-09-26）：回答"是平台挂了还是我的问题"
  app.get('/api/testing/platform-status', async (req, res) => {
    try {
      res.json({ ok: true, ...await buildPlatformStatus(db, { lanhu: { configured: lanhuConfigured() } }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 夜间全量回归：报告 + 手动触发（运维/验证用；定时 03:00 自动跑）
  app.get('/api/testing/nightly', async (req, res) => {
    try {
      res.json({ ok: true, ...await buildNightlyReport(db, { repoSlug: req.query.repo || 'demo-app', limit: Math.min(30, Number(req.query.limit) || 7) }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/nightly/run', (req, res) => {
    try {
      const author = req.body?.author || 'dashboard'
      const repoSlug = req.body?.repo || 'demo-app'
      // 懒加载：nightly→state-machine→migrate 的模块加载链会读 schema 文件，
      // 不得在"只读模型"测试的 fs 模拟下提前加载
      import('../testing/nightly.js')
        .then(async ({ runNightlyRegression }) => await runNightlyRegression({ repoSlug: String(repoSlug), author: `human:${author}` }))
        .then((r) => res.json({ ok: Boolean(r.ok), ...r }))
        .catch((e) => err400(res, e.message))
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 任务全流程追踪（2026-09-26 运维埋点配套）：按 taskId 串任务/版本/提交/run/attempt/审计/经验
  app.get('/api/testing/trace/:taskId', async (req, res) => {
    try {
      const trace = await buildTaskTrace(db, { taskId: req.params.taskId, repo: req.query.repo || null })
      if (!trace.task && !trace.instance) return err404(res, `任务不存在：${req.params.taskId}`)
      res.json({ ok: true, ...trace })
    } catch (e) {
      err400(res, e.message)
    }
  })

  // 仓级需求→考卷覆盖地图（2026-09-26）：哪些需求没卷、哪些 AC 没覆盖
  app.get('/api/testing/coverage-map', async (req, res) => {
    try {
      const repo = req.query.repo || 'demo-app'
      res.json({ ok: true, ...await buildCoverageMap(db, { repo: String(repo) }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/overview', async (req, res) => {
    const repo = req.query.repo || DEFAULT_REPO
    res.json(await testingOverview(repo))
  })

  // ── 任务级云端测试聚合（任务详情内嵌展示的数据源）────────────────

  /**
   * 按 harness taskId 查云端门禁测试全貌。
   * 注意：test_submissions.task_instance_id 存的是 testing 侧 UUID，
   * harness taskId 对应 task_instances.external_task_id，必须 JOIN 转换。
   */
  app.get('/api/testing/by-task/:taskId', async (req, res) => {
    try {
      // 同一只读事务内取总数、页边界与状态，避免并发提交造成序号/total 不一致。
      const read = async (tx) => await readTaskTestingView(tx, {
        taskId: req.params.taskId, repo: req.query.repo || null,
        limit: req.query.limit, before: req.query.before || null,
      })
      res.json(await db.tx(read))
    } catch (e) { err400(res, e.message) }
  })

  // ── 运行日志（artifact.zip 内的文本/图片，看板直接读 blobs）───────

  /** 取 run 最新 artifact 的 zip 条目（不存在/被扫描拒绝/已过期时给原因文案） */
  async function loadRunArtifactEntries(runId, artifactId = null) {
    return readArtifactEntries(db, { runId, artifactId }, {
      contentPath: blobs.contentPath, existsSync, readFileSync, readZipCentralEntries,
    })
  }

  // 分步流程时间线：结束后点开逐步追踪（优先 steps_json，历史 run 用 attempt/checks 合成）
  // 中文分步 + expected/actual + 执行摘要 + 失败分析（report-timeline）
  app.get('/api/testing/runs/:runId/timeline', async (req, res) => {
    const run = await db
      .prepare(
        `SELECT run_id, unit, side, status, terminal_reason, report_json,
                created_at, started_at, finished_at, total_ms
         FROM test_runs WHERE run_id = ?`
      )
      .get(req.params.runId)
    if (!run) return err404(res, '运行不存在')
    let checks = [], reportAttempt = null
    try {
      const report = JSON.parse(run.report_json || '{}')
      checks = Array.isArray(report?.checks) ? report.checks : []
      reportAttempt = Number.isInteger(report?.attempt) && report.attempt > 0 ? report.attempt : null
    } catch { /* 无报告 */ }
    const attempts = await db
      .prepare(
        `SELECT a.attempt, a.status, a.started_at, a.finished_at, a.heartbeat_at,
                a.error_code, a.error_detail, a.image_id, a.steps_json, w.hostname AS worker
         FROM run_attempts a LEFT JOIN workers w ON w.worker_id = a.worker_id
         WHERE a.run_id = ? ORDER BY a.attempt`
      )
      .all(run.run_id)
    let timeline
    let summary
    let failure
    try {
      timeline = buildTimeline({ run, attempts, checks, reportAttempt })
      summary = buildSummary({ run, checks, attempts })
      failure = buildFailureAnalysis({ run, checks, attempts })
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message })
    }
    res.json({
      ok: true,
      runId: run.run_id,
      unit: run.unit,
      side: run.side,
      status: run.status,
      terminalReason: run.terminal_reason,
      source: attempts.some((a) => a.steps_json) ? 'recorded' : 'synthesized',
      reportAttempt,
      summary,
      failureAnalysis: failure,
      steps: timeline,
    })
  })

  // 日志文件清单
  app.get('/api/testing/runs/:runId/logs', async (req, res) => {
    const run = await db.prepare('SELECT run_id FROM test_runs WHERE run_id = ?').get(req.params.runId)
    if (!run) return err404(res, '运行不存在')
    const r = await loadRunArtifactEntries(req.params.runId, req.query.artifactId == null ? null : String(req.query.artifactId))
    if (r.error) return res.json({ ok: false, reason: r.error, files: [], artifactId: r.artifactId, attempt: r.attempt })
    res.json({
      ok: true,
      artifactId: r.artifact.artifact_id,
      attempt: r.artifact.attempt,
      truncated: !!r.artifact.artifact_truncated,
      files: r.entries.map((e) => ({
        path: e.name,
        size: e.uncompressedSize,
        kind: LOG_TEXT_EXT.test(e.name) ? 'text' : LOG_IMAGE_EXT.test(e.name) ? 'image' : 'binary',
      })),
    })
  })

  // 单个日志文件内容（文本截尾 512KB；图片/视频以二进制流出）
  app.get('/api/testing/runs/:runId/log', async (req, res) => {
    const filePath = String(req.query.path || '')
    if (!filePath || filePath.includes('..') || filePath.startsWith('/')) return err400(res, 'path 不合法')
    const r = await loadRunArtifactEntries(req.params.runId, req.query.artifactId == null ? null : String(req.query.artifactId))
    if (r.error) return res.status(404).json({ error: r.error, artifactId: r.artifactId, attempt: r.attempt })
    const entry = r.entries.find((e) => e.name === filePath)
    if (!entry) return res.status(404).json({ error: `日志包内不存在：${filePath}`,
      artifactId: r.artifact.artifact_id, attempt: r.artifact.attempt })
    let buf
    try {
      buf = entry.inflate()
    } catch (e) {
      return res.status(500).json({ error: `解压失败：${e.message}`,
        artifactId: r.artifact.artifact_id, attempt: r.artifact.attempt })
    }
    res.setHeader('X-Artifact-Id', r.artifact.artifact_id)
    res.setHeader('X-Artifact-Attempt', String(r.artifact.attempt))
    if (LOG_IMAGE_EXT.test(filePath)) {
      const mime = filePath.endsWith('.png') ? 'image/png' : filePath.endsWith('.webm') ? 'video/webm' : 'image/jpeg'
      res.setHeader('Content-Type', mime)
      return res.send(buf)
    }
    const tail = utf8Tail(buf, LOG_VIEW_MAX_BYTES)
    res.json({ ok: true, path: filePath, size: entry.uncompressedSize, ...tail,
      artifactId: r.artifact.artifact_id, attempt: r.artifact.attempt })
  })

  // 一键中止任务：ABORTED + 取消云端 run + 关 VM（AI 侧 harness_status 可见）
  app.post('/api/harness/stop', async (req, res) => {
    try {
      const { taskId, repo, reason, author } = req.body || {}
      if (!taskId) return err400(res, '缺少 taskId')
      const out = await forceStopTask({
        taskId: String(taskId),
        repo: repo ? String(repo) : 'demo-app',
        reason: reason ? String(reason) : null,
        author: author || 'dashboard',
      })
      res.status(out.ok ? 200 : 400).json(out)
    } catch (e) {
      err400(res, e.message)
    }
  })

  // ─── 测试质量 / 动态门禁 / flaky / escape ───────────────────
  app.get('/api/testing/quality', async (req, res) => {
    try {
      const slug = req.query.repo ? String(req.query.repo) : null
      const repo = slug ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug) : null
      res.json({ ok: true, ...await qualityDashboard(db, { repoSlug: slug, repoId: repo?.repo_id || null }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/gate-policy/preview', async (req, res) => {
    try {
      const { repo, taskId, size, changedFiles, author } = req.body || {}
      if (!repo) return err400(res, 'repo 必填')
      const policy = await previewGatePolicy(db, {
        repoSlug: String(repo),
        taskId: taskId || null,
        size: size || null,
        changedFiles: Array.isArray(changedFiles) ? changedFiles : null,
        author: author || null,
      })
      await recordAuditEvent({
        eventType: 'admin_mutation',
        toolName: 'gate_policy_preview',
        method: 'HTTP',
        repo: String(repo),
        taskId: taskId || null,
        author: author || 'dashboard',
        status: 'ok',
        detail: `policy preview decision=${policy.decision} hash=${policy.policyHash}`,
        payload: policy.factors,
      })
      res.json({ ok: true, policy })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/gate-policy', async (req, res) => {
    try {
      const slug = req.query.repo ? String(req.query.repo) : null
      if (!slug) return err400(res, 'repo 必填')
      const policy = await resolveGatePolicy(db, { repoSlug: slug, taskId: req.query.taskId ? String(req.query.taskId) : null })
      res.json({ ok: true, dynamicEnabled: await isDynamicGateEnabled(db), policy })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/dynamic-gate', async (req, res) => {
    try {
      const { enabled, largeDiffThreshold, newAuthor } = req.body || {}
      const cur = await getPlatformSetting(db, 'dynamic_gate', { enabled: false })
      const next = { enabled: enabled != null ? Boolean(enabled) : Boolean(cur?.enabled) }
      await setPlatformSetting(db, 'dynamic_gate', next)
      if (largeDiffThreshold != null) await setPlatformSetting(db, 'large_diff_threshold', Number(largeDiffThreshold))
      if (newAuthor != null) await setPlatformSetting(db, 'dynamic_gate_new_author', { enabled: Boolean(newAuthor) })
      await recordAuditEvent({
        eventType: 'admin_mutation',
        toolName: 'dynamic_gate',
        method: 'HTTP',
        status: 'ok',
        author: req.body?.author || 'dashboard',
        detail: `dynamic_gate enabled=${next.enabled}`,
        payload: req.body || {},
      })
      res.json({ ok: true, dynamic_gate: next })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/risk-rules', async (req, res) => {
    try {
      const slug = req.query.repo ? String(req.query.repo) : null
      const repo = slug ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug) : null
      res.json({ ok: true, rules: await listGateRiskRules(db, { repoId: repo?.repo_id || null }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/risk-rules', async (req, res) => {
    try {
      const { repo, pattern, effect, note, enabled, ruleId } = req.body || {}
      if (!pattern) return err400(res, 'pattern 必填')
      const repoRow = repo ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(String(repo)) : null
      const out = await upsertGateRiskRule(db, {
        ruleId: ruleId || null,
        repoId: repoRow?.repo_id || null,
        pattern: String(pattern),
        effect: effect || 'enforce',
        note: note || null,
        enabled: enabled !== false,
      })
      await recordAuditEvent({
        eventType: 'admin_mutation',
        toolName: 'risk_rule_upsert',
        method: 'HTTP',
        repo: repo || null,
        author: req.body?.author || 'dashboard',
        status: 'ok',
        detail: `risk rule ${out.ruleId} ${pattern}`,
        payload: req.body || {},
      })
      res.json({ ok: true, ...out })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/quarantine', async (req, res) => {
    try {
      await ensureFlakyColumns(db)
      const slug = req.query.repo ? String(req.query.repo) : null
      const repo = slug ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug) : null
      res.json({ ok: true, items: await listQuarantined(db, { repoId: repo?.repo_id || null }) })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/quarantine/exit', async (req, res) => {
    try {
      const { featureKey, to, reason, author } = req.body || {}
      if (!featureKey) return err400(res, 'featureKey 必填')
      const out = await exitQuarantine(db, { featureKey: String(featureKey), to: to || 'active', reason: reason || null })
      await recordAuditEvent({
        eventType: 'quarantine_exit',
        toolName: 'quarantine_exit',
        method: 'HTTP',
        author: author || 'dashboard',
        status: 'ok',
        detail: `${featureKey} → ${out.to}`,
        payload: req.body || {},
      })
      res.json({ ok: true, ...out })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.post('/api/testing/escapes', async (req, res) => {
    try {
      const { repo, taskId, symptom, gapType, owner, source, rootCause, linkedSpecs } = req.body || {}
      if (!symptom) return err400(res, 'symptom 必填')
      const repoRow = repo ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(String(repo)) : null
      const out = await registerEscape(db, {
        repoId: repoRow?.repo_id || null,
        taskId: taskId || null,
        source: source || 'manual',
        symptom: String(symptom),
        rootCause: rootCause || null,
        linkedSpecs: Array.isArray(linkedSpecs) ? linkedSpecs : [],
        gapType: gapType || null,
        owner: owner || null,
      })
      await recordAuditEvent({
        eventType: 'escape_registered',
        toolName: 'escape_register',
        method: 'HTTP',
        repo: repo || null,
        taskId: taskId || null,
        author: owner || 'dashboard',
        status: 'ok',
        detail: `escape ${out.escapeId}`,
        payload: { symptom, gapType },
      })
      res.json({ ok: true, ...out })
    } catch (e) {
      err400(res, e.message)
    }
  })

  app.get('/api/testing/escapes', async (req, res) => {
    try {
      const slug = req.query.repo ? String(req.query.repo) : null
      const repo = slug ? await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug) : null
      res.json({ ok: true, items: await listEscapes(db, { repoId: repo?.repo_id || null }) })
    } catch (e) {
      err400(res, e.message)
    }
  })
}
