/**
 * harness/loop.js — 门禁闭环协议 CLRP/1
 *
 * 职责：
 *  - gate_loops 环状态读写（断点唯一真相）
 *  - task_sessions 租约（谁在驱动闭环）
 *  - check 级失败分类（suite / product / infra）
 *  - Remediation Packet 构建
 *  - 下单后阻塞等待终态（wait）
 */
import { uuidv7, utcNow } from '../testing/ids.js'
import { phaseToActivity } from './activity-plan.js'
import { CLRP_PROTOCOL } from '../contracts/version.mjs'
import { attributeSuiteChecks } from '../testing/impact.js'

export const DEFAULT_MAX_ITERATIONS = 5
export const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000
export const DEFAULT_WAIT_TIMEOUT_MS = 45 * 60 * 1000
export const DEFAULT_WAIT_POLL_MS = 1000

const LOOP_STATES = [
  'coding',
  'waiting_gate',
  'remediation_suite',
  'remediation_product',
  'green_pending_advance',
  'needs_human',
  'paused_ops',
]

const FORBIDDEN_COMPLETE = [
  '宣称任务完成',
  '向用户输出「已完成 / 可提测 / 可合并」',
  '在 phase=DONE 前结束工作并当作交付',
  '跳过 distill 直接 harness_advance',
  '使用过期 gateBindingId',
  'harness_start 另开近似任务冒充完成',
]

// ─── gate_loops ───────────────────────────────────────────────

export async function getGateLoop(db, { repo, taskId }) {
  const row = await db
    .prepare('SELECT * FROM gate_loops WHERE repo=? AND task_id=?')
    .get(repo, taskId)
  return row ? parseLoopRow(row) : null
}

export async function ensureGateLoop(db, { repo, taskId, size = null, phase = null, requiredUnits = [], now = utcNow() }) {
  const existing = await getGateLoop(db, { repo, taskId })
  if (existing) return existing
  // gate_loops.phase 只存活动名（方案决定 3 / v34 回填口径一致）
  const storedPhase = phase ? phaseToActivity(phase) : null
  await db.prepare(
    `INSERT INTO gate_loops(
      repo, tenant_id, task_id, state, iteration, max_iterations, phase, size,
      required_units_json, pending_actions_json, history_json, updated_at
    ) VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'coding', 0, ?, ?, ?, ?, '["code"]', '[]', ?)`
  ).run(repo, repo, taskId, DEFAULT_MAX_ITERATIONS, storedPhase, size, JSON.stringify(requiredUnits), now)
  return await getGateLoop(db, { repo, taskId })
}

export async function updateGateLoop(db, { repo, taskId, patch = {}, now = utcNow() }) {
  const cur = await ensureGateLoop(db, { repo, taskId, now })
  const next = {
    state: patch.state ?? cur.state,
    iteration: patch.iteration ?? cur.iteration,
    maxIterations: patch.maxIterations ?? cur.maxIterations,
    phase: patch.phase != null ? phaseToActivity(patch.phase) : cur.phase,
    size: patch.size ?? cur.size,
    requiredUnits: patch.requiredUnits ?? cur.requiredUnits,
    pendingActions: patch.pendingActions ?? cur.pendingActions,
    lastBindingId: patch.lastBindingId ?? cur.lastBindingId,
    lastExpectedRevision: patch.lastExpectedRevision ?? cur.lastExpectedRevision,
    lastSubmissionId: patch.lastSubmissionId ?? cur.lastSubmissionId,
    lastRunGroupId: patch.lastRunGroupId ?? cur.lastRunGroupId,
    lastTerminal: patch.lastTerminal ?? cur.lastTerminal,
    lastClass: patch.lastClass ?? cur.lastClass,
    awaitDistill: patch.awaitDistill ?? cur.awaitDistill,
    needsHuman: patch.needsHuman ?? cur.needsHuman,
    waiverId: patch.waiverId ?? cur.waiverId,
    history: patch.history ?? cur.history,
  }
  if (patch.appendHistory) {
    next.history = [...(cur.history || []), patch.appendHistory]
  }
  await db.prepare(
    `UPDATE gate_loops SET
      state=?, iteration=?, max_iterations=?, phase=?, size=?,
      required_units_json=?, pending_actions_json=?,
      last_binding_id=?, last_expected_revision=?, last_submission_id=?, last_run_group_id=?,
      last_terminal=?, last_class=?, await_distill=?, needs_human=?, waiver_id=?,
      history_json=?, updated_at=?
     WHERE repo=? AND task_id=?`
  ).run(
    next.state,
    next.iteration,
    next.maxIterations,
    next.phase,
    next.size,
    JSON.stringify(next.requiredUnits || []),
    JSON.stringify(next.pendingActions || []),
    next.lastBindingId,
    next.lastExpectedRevision,
    next.lastSubmissionId,
    next.lastRunGroupId,
    next.lastTerminal,
    next.lastClass,
    next.awaitDistill ? 1 : 0,
    next.needsHuman ? 1 : 0,
    next.waiverId,
    JSON.stringify(next.history || []),
    now,
    repo,
    taskId
  )
  return await getGateLoop(db, { repo, taskId })
}

function parseLoopRow(row) {
  const parse = (s, fb) => {
    try {
      return JSON.parse(s || fb)
    } catch {
      return typeof fb === 'string' ? JSON.parse(fb) : fb
    }
  }
  return {
    repo: row.repo,
    taskId: row.task_id,
    state: row.state,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    phase: row.phase,
    size: row.size,
    requiredUnits: parse(row.required_units_json, '[]'),
    pendingActions: parse(row.pending_actions_json, '[]'),
    lastBindingId: row.last_binding_id,
    lastExpectedRevision: row.last_expected_revision,
    lastSubmissionId: row.last_submission_id,
    lastRunGroupId: row.last_run_group_id,
    lastTerminal: row.last_terminal,
    lastClass: row.last_class,
    awaitDistill: Boolean(row.await_distill),
    needsHuman: Boolean(row.needs_human),
    waiverId: row.waiver_id,
    history: parse(row.history_json, '[]'),
    updatedAt: row.updated_at,
  }
}

// ─── task_sessions 租约 ────────────────────────────────────────

export async function acquireTaskSession(db, {
  repo,
  taskId,
  ownerSubject,
  clientName = null,
  state = 'coding',
  ttlMs = DEFAULT_SESSION_TTL_MS,
  now = new Date(),
}) {
  const nowIso = now.toISOString()
  const expires = new Date(now.getTime() + ttlMs).toISOString()
  const active = await db
    .prepare(
      `SELECT * FROM task_sessions
       WHERE repo=? AND task_id=? AND released_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(repo, taskId, nowIso)
  if (active && active.owner_subject !== ownerSubject) {
    return {
      ok: false,
      error: `TASK_SESSION_HELD`,
      owner: active.owner_subject,
      sessionId: active.session_id,
      state: active.state,
      expiresAt: active.expires_at,
    }
  }
  if (active) {
    await db.prepare(
      `UPDATE task_sessions SET heartbeat_at=?, expires_at=?, state=?, client_name=COALESCE(?, client_name)
       WHERE session_id=?`
    ).run(nowIso, expires, state, clientName, active.session_id)
    return { ok: true, sessionId: active.session_id, resumed: true, owner: ownerSubject }
  }
  const sessionId = uuidv7()
  await db.prepare(
    `INSERT INTO task_sessions(
      session_id, repo, tenant_id, task_id, owner_subject, client_name, state,
      heartbeat_at, created_at, expires_at
    ) VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?)`
  ).run(sessionId, repo, repo, taskId, ownerSubject, clientName, state, nowIso, nowIso, expires)
  return { ok: true, sessionId, resumed: false, owner: ownerSubject }
}

export async function heartbeatTaskSession(db, { repo, taskId, ownerSubject, ttlMs = DEFAULT_SESSION_TTL_MS, now = new Date() }) {
  const nowIso = now.toISOString()
  const expires = new Date(now.getTime() + ttlMs).toISOString()
  const info = await db
    .prepare(
      `UPDATE task_sessions SET heartbeat_at=?, expires_at=?
       WHERE repo=? AND task_id=? AND owner_subject=? AND released_at IS NULL`
    )
    .run(nowIso, expires, repo, taskId, ownerSubject)
  return info.changes > 0
}

export async function releaseTaskSession(db, { repo, taskId, ownerSubject = null, now = new Date() }) {
  if (ownerSubject) {
    await db.prepare(
      `UPDATE task_sessions SET released_at=?
       WHERE repo=? AND task_id=? AND owner_subject=? AND released_at IS NULL`
    ).run(now.toISOString(), repo, taskId, ownerSubject)
  } else {
    await db.prepare(
      `UPDATE task_sessions SET released_at=? WHERE repo=? AND task_id=? AND released_at IS NULL`
    ).run(now.toISOString(), repo, taskId)
  }
}

export async function getActiveTaskSession(db, { repo, taskId, now = new Date() }) {
  return (
    await db
      .prepare(
        `SELECT * FROM task_sessions
         WHERE repo=? AND task_id=? AND released_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(repo, taskId, now.toISOString()) || null
  )
}

export async function listResumableTasks(db, { ownerSubject = null, repo = null, limit = 20, now = new Date() } = {}) {
  const params = [now.toISOString()]
  let sql = `
    SELECT s.repo, s.task_id, s.owner_subject, s.state AS session_state, s.heartbeat_at,
           g.state, g.iteration, g.max_iterations, g.pending_actions_json, g.needs_human,
           g.last_binding_id, g.last_terminal, g.last_class, g.phase, g.size
    FROM task_sessions s
    LEFT JOIN gate_loops g ON g.repo=s.repo AND g.task_id=s.task_id
    WHERE s.released_at IS NULL AND s.expires_at > ?`
  if (ownerSubject) {
    sql += ' AND s.owner_subject=?'
    params.push(ownerSubject)
  }
  if (repo) {
    sql += ' AND s.repo=?'
    params.push(repo)
  }
  sql += ' ORDER BY s.heartbeat_at DESC LIMIT ?'
  params.push(limit)
  return await db.prepare(sql).all(...params)
}

// ─── 失败分类 ──────────────────────────────────────────────────

const SUITE_DETAIL_RE =
  /cannot navigate to invalid url|missing default run|side mismatch|unexpected token|syntaxerror|spec 缺少 default|expect is not defined|referenceerror|typeerror|cannot find (?:package|module)|err_module_not_found|err_package_path_not_exported/i
const INFRA_DETAIL_RE =
  /proxy_not_reachable|enotfound|econnrefused|etimedout|vhdx|hyper-?v|permission denied|infra_error|registry|build_failed|exit=134|outofmemory|out of memory|reportexternalallocationlimit|0x8007000e|0x800705aa|playwright_(?:unavailable|expect_unavailable|runtime_invalid)|browserType\.launch|target page, context or browser has been closed/i

const ERROR_KIND_CLASS = Object.freeze({
  script_syntax: 'suite', script_import: 'suite', script_runtime: 'suite',
  selector_timeout: 'suite', assertion: 'product', page_runtime: 'product', build: 'product', infra: 'infra',
})

function checkErrorKind(check) {
  const explicit = check?.errorKind
  if (Object.hasOwn(ERROR_KIND_CLASS, explicit)) return explicit
  // 兼容中间层仅保留 detail 的旧报告，不从任意错误正文猜断言类型。
  const prefix = /^\[(script_syntax|script_import|script_runtime|selector_timeout|assertion|page_runtime|build|infra)\]/.exec(String(check?.detail || ''))
  if (prefix) return prefix[1]
  const detail = String(check?.detail || '')
  if (/^PLAYWRIGHT_(?:UNAVAILABLE|EXPECT_UNAVAILABLE|RUNTIME_INVALID):/.test(detail)) return 'infra'
  if (/\bexpect is not defined\b/.test(detail)) return 'script_runtime'
  if (/^(?:Error \[ERR_MODULE_NOT_FOUND\]:|Cannot find (?:package|module))/.test(detail)) return 'script_import'
  return null
}

export function classifyCheck({ caseKey, status, detail, errorKind }) {
  if (status === 'passed' || status === 'skipped') return null
  const kind = checkErrorKind({ errorKind, detail })
  if (kind) return ERROR_KIND_CLASS[kind]
  const key = String(caseKey || '')
  const text = String(detail || '')
  if (key.startsWith('test:spec/') || key.startsWith('test:unit-spec/')) {
    if (INFRA_DETAIL_RE.test(text) && !SUITE_DETAIL_RE.test(text)) return 'infra'
    return 'suite'
  }
  if (key.includes('eslint-ratchet')) return 'product'
  if (key.includes('eslint') || key.includes('hard-rules') || key.includes('translation') || key.includes('vitest')) {
    return 'product'
  }
  if (key.includes('smoke') && SUITE_DETAIL_RE.test(text)) return 'suite'
  if (INFRA_DETAIL_RE.test(text)) return 'infra'
  if (SUITE_DETAIL_RE.test(text)) return 'suite'
  if (status === 'error') return 'infra'
  return 'product'
}

export function classifyRunChecks(checks = [], terminalReason = null) {
  const terminalInfra = terminalReason === 'infra_error' || terminalReason === 'timed_out'
  const byCheck = []
  for (const c of checks || []) {
    if (!c || c.status === 'passed' || c.status === 'skipped') continue
    // 归因结论优先：attributeSuiteChecks 已把跨页面真回归改判 product，
    // 这里再按 caseKey 重新推导会把结论盖回 suite（修复闭环最大的归因断点）
    // 明确的错误类型比路径交集更可靠：脚本/依赖问题不能因改动命中页面而变成业务回归。
    const errorKind = checkErrorKind(c)
    const attributed = c.class === 'product' || c.class === 'suite' || c.class === 'infra' ? c.class : null
    const cls = errorKind ? ERROR_KIND_CLASS[errorKind] : attributed || classifyCheck(c)
    if (!cls) continue
    byCheck.push({
      caseKey: c.caseKey,
      class: cls,
      ...(errorKind ? { errorKind } : {}),
      attributed: Boolean(attributed && (!errorKind || attributed === cls)),
      detail: c.detail ? String(c.detail).slice(0, 500) : null,
      errorSignature: c.detail ? String(c.detail).slice(0, 200) : null,
      featureKey: String(c.caseKey || '').startsWith('test:spec/')
        ? String(c.caseKey).slice('test:spec/'.length)
        : String(c.caseKey || '').startsWith('test:unit-spec/')
          ? String(c.caseKey).slice('test:unit-spec/'.length)
          : null,
      hints: hintsFor(cls, c),
    })
  }
  if (terminalInfra) return { overall: 'infra', byCheck }
  if (!byCheck.length) {
    return { overall: terminalReason === 'assertion_failed' ? 'product' : 'none', byCheck }
  }
  const classes = new Set(byCheck.map((x) => x.class))
  let overall = 'product'
  if (classes.size === 1) overall = [...classes][0]
  else if (classes.has('suite')) overall = classes.has('infra') && !classes.has('product') ? 'mixed' : 'mixed'
  else if (classes.has('infra') && !classes.has('product')) overall = 'infra'
  return { overall, byCheck }
}

function hintsFor(cls, check) {
  const key = String(check.caseKey || '')
  const errorKind = checkErrorKind(check)
  if (errorKind === 'script_import') return [
    '考卷模块导入失败，不是业务断言失败；先核对依赖和 ESM 导出。',
    'Guest 仅分发 playwright/playwright-core；优先从 run({page,baseURL,expect}) 解构官方 expect，或 import {expect} from "playwright/test"。',
    '不要改成 @playwright/test/vitest，也不要给业务仓补测试依赖；Node 内置 assert 可以保留。',
  ]
  if (errorKind === 'script_syntax' || errorKind === 'script_runtime') return [
    '考卷语法/运行错误，不代表业务回归；先定位 detail 中的异常，修复 spec 后再提交。',
    'expect 不是全局变量；使用时从 run({page,baseURL,expect}) 解构，已有自定义断言/Node assert 无需改写。',
  ]
  if (errorKind === 'selector_timeout') return [
    '选择器操作超时，尚不能认定业务回归；先核对路由、数据准备和真实 DOM。',
    '结合 DOM_PROBE 与截图确认 data-test 落点、可见性和遮挡；禁止仅加长超时或盲改业务代码。',
  ]
  if (errorKind === 'assertion') return [
    '真实断言未满足：对照 expected/received、fixture 与截图定位业务行为；不是导入或脚本运行异常。',
    '确认业务预期后修复实现，禁止删除或弱化断言来变绿；修复后重提验证。',
  ]
  if (cls === 'suite') {
    const h = []
    h.push('这是平台契约/测试资产问题，不是业务回归——优先改 spec 再重提')
    h.push('page.goto 必须使用 runner 注入的 baseURL 拼完整 URL，禁止裸相对路径')
    h.push('Single-lane assets must declare the matching side from the repository profile.')
    h.push('确认 data-test 属性最终出现在页面 DOM 中；自定义组件可能需要在其原生子元素上设置选择器')
    h.push('先读 detail 里的 DOM_PROBE（selectorHit/tabs/dataTest）与 artifact 截图，禁止盲改')
    h.push('空态（0 条记录）也是合法断言路径')
    if (key.startsWith('test:spec/') || key.startsWith('test:unit-spec/')) {
      h.push('先 awp_test_spec_get 阅读全文，修复后 awp_test_spec_submit（自动 version+1）')
    }
    return h
  }
  if (cls === 'product') {
    return [
      '必须修复业务代码 / 存量 lint（禁止只改测试脚本应付）',
      '对报告中的每个文件执行 eslint 并修净，再 distill_append',
      '重提 awp_test_run 时必须传 productFixed=true',
    ]
  }
  if (cls === 'infra') {
    return [
      '平台/VM/网络问题：不计入迭代上限，也不算业务失败',
      '已自动重试仍失败时，运维可在看板「重新入队」把本场考试推回队列',
      '等待恢复期间任务挂起（paused_ops），恢复后原考试继续，无需重新下单',
    ]
  }
  return []
}

/** 从 eslint/detail 里抽出业务仓相对路径，便于 mustFix 清单 */
export function extractFilesFromDetail(detail) {
  const text = String(detail || '')
  const files = new Set()
  // Windows 绝对路径 → src/... 或 scripts/...
  const abs = text.matchAll(/[A-Za-z]:\\[^\s|:]+\\((?:src|scripts|public)\\[^\s|:]+)/g)
  for (const m of abs) files.add(m[1].replace(/\\/g, '/'))
  // posix / 相对
  const rel = text.matchAll(/(?:^|[\s|:])((?:src|scripts|public)\/[\w./-]+\.(?:vue|js|jsx|cjs|mjs))/g)
  for (const m of rel) files.add(m[1])
  return [...files].sort()
}

/**
 * 按 class 拆强制清单：product 必须修业务；suite 必须修资产。
 * mixed 时两类都要清，禁止只改 spec 就重提。
 */
export function buildMustFixList(classification) {
  const byCheck = classification?.byCheck || []
  const product = []
  const suite = []
  for (const c of byCheck) {
    const item = {
      caseKey: c.caseKey,
      class: c.class,
      files: extractFilesFromDetail(c.detail),
      detail: c.detail ? String(c.detail).slice(0, 280) : null,
      steps:
        c.class === 'product'
          ? [
              `修复 ${c.caseKey} 涉及的业务/lint 问题`,
              ...(extractFilesFromDetail(c.detail).length
                ? [extractFilesFromDetail(c.detail).map((f) => `eslint --fix ${f}`).join(' 且 ')]
                : ['对报告中的文件跑 eslint 并修净']),
              'distill_append 总结（taskId 必填）',
              'awp_test_run 重提时传 productFixed=true',
            ]
          : [
              `awp_test_spec_get 读 ${c.featureKey || c.caseKey}`,
              '按平台契约修 spec（baseURL / side / data-test）',
              'awp_test_spec_submit',
              'distill_append',
              'awp_test_run 重提时传 suiteFixed=true',
            ],
    }
    if (c.class === 'product') product.push(item)
    else if (c.class === 'suite') suite.push(item)
    else if (c.class === 'infra') {
      /* infra 不进 mustFix */
    }
  }
  const mustFix = []
  // product 优先：mixed 时先逼业务修复，避免只改 spec
  for (const p of product) mustFix.push({ ...p, order: 'product-first' })
  for (const s of suite) mustFix.push({ ...s, order: 'suite' })
  return {
    product,
    suite,
    all: mustFix,
    requiresProductFix: product.length > 0,
    requiresSuiteFix: suite.length > 0,
    summary:
      product.length && suite.length
        ? 'mixed：必须同时修 product（业务/lint）与 suite（测试资产），禁止只改 spec 重提'
        : product.length
          ? 'product：必须先修业务/lint，禁止只改 spec 重提'
          : suite.length
            ? 'suite：必须修测试资产后再重提'
            : '',
  }
}

/**
 * 重提前闸门：
 * - needs_human 禁止
 * - await_distill 未清禁止（失败后必须先 distill_append）
 * - 有 product 未声明已修 → 禁止（productFixed）
 * - 有 suite 未声明已修 → 禁止（suiteFixed）
 * - evidence 与上次失败 submission 完全相同 → 禁止（NO_NEW_EVIDENCE）
 */
export async function checkReadyToResubmit(db, {
  repoSlug,
  taskId,
  productFixed = false,
  suiteFixed = false,
  evidence = null,
}) {
  const loop = await getGateLoop(db, { repo: repoSlug, taskId })
  if (!loop) return { ok: true, reason: null, mustFix: null }

  if (loop.needsHuman) {
    return {
      ok: false,
      code: 'NEEDS_HUMAN',
      reason: `迭代已达上限 ${loop.iteration}/${loop.maxIterations}，禁止重提，需人工处理`,
      mustFix: null,
    }
  }

  // 从最近 failed 组重建 mustFix
  let classification = null
  let lastFailedGroup = null
  try {
    const group = await latestFormalRunGroup(db, { repoSlug, taskId })
    if (group && (group.status === 'failed' || group.status === 'error')) {
      lastFailedGroup = group
      const { checks, terminalReason } = await loadRunGroupChecks(db, group.run_group_id)
      classification = classifyRunChecks(checks, terminalReason)
    }
  } catch {
    classification = null
    lastFailedGroup = null
  }
  const mf = buildMustFixList(classification)

  if (loop.awaitDistill && (!classification || (classification.overall !== 'infra' && classification.overall !== 'suite'))) {
    return {
      ok: false,
      code: 'AWAIT_DISTILL',
      reason:
        '上次门禁失败后尚未 distill_append（taskId 必填）。禁止直接重提；先写经验再修再测。',
      mustFix: mf,
    }
  }

  if (mf.requiresProductFix && !productFixed) {
    return {
      ok: false,
      code: 'PRODUCT_NOT_FIXED',
      reason:
        '存在 product 失败（业务/lint）。禁止只改测试脚本重提。请先修净报告中的文件并 distill_append，再 awp_test_run({productFixed:true})。',
      mustFix: mf,
    }
  }

  if (mf.requiresSuiteFix && !suiteFixed) {
    return {
      ok: false,
      code: 'SUITE_NOT_FIXED',
      reason:
        '存在 suite 失败（测试资产）。请 awp_test_spec_get/submit 修复后再 awp_test_run({suiteFixed:true})。',
      mustFix: mf,
    }
  }

  // 同证据重提：上次 formal 失败且本次 bundle/tree/changedPaths 与失败 snapshot 逐项相同
  // 例外：上次分类为 infra（环境故障）时允许同快照重提——修的是 runner/VM/脚本，不是业务代码，
  // 强制改代码属于逼 AI 空转应付门禁。
  const lastWasInfra =
    classification?.overall === 'infra' ||
    loop.lastClass === 'infra' ||
    (lastFailedGroup && String(lastFailedGroup.status || '').includes('error') && loop.lastClass !== 'product' && loop.lastClass !== 'suite' && loop.lastClass === 'infra')
  if (evidence && lastFailedGroup && !lastWasInfra) {
    try {
      const lastSnap = await db.prepare(
        `SELECT s.bundle_sha256, s.snapshot_tree_oid, s.changed_paths_sha256, s.head_commit_oid
         FROM run_groups g
         JOIN test_bindings b ON b.binding_id = g.binding_id
         JOIN business_snapshots s ON s.snapshot_id = b.snapshot_id
         WHERE g.run_group_id = ?`
      ).get(lastFailedGroup.run_group_id)
      if (lastSnap) {
        const sameBundle =
          evidence.bundleSha256 && lastSnap.bundle_sha256 && evidence.bundleSha256 === lastSnap.bundle_sha256
        const sameTree =
          evidence.snapshotTreeOid &&
          lastSnap.snapshot_tree_oid &&
          evidence.snapshotTreeOid === lastSnap.snapshot_tree_oid
        const sameChanged =
          evidence.changedPathsSha256 &&
          lastSnap.changed_paths_sha256 &&
          evidence.changedPathsSha256 === lastSnap.changed_paths_sha256
        const sameHead =
          evidence.headCommitOid &&
          lastSnap.head_commit_oid &&
          evidence.headCommitOid === lastSnap.head_commit_oid
        if (sameBundle || (sameTree && sameChanged && sameHead)) {
          return {
            ok: false,
            code: 'NO_NEW_EVIDENCE',
            reason:
              '与上次失败 submission 的快照证据完全相同（bundle/tree/changedPaths/HEAD 均未变）。' +
              '禁止空转重提：请先修改代码或测试资产，产生新的工作区快照后再 awp_test_run。',
            mustFix: mf,
            lastRunGroupId: lastFailedGroup.run_group_id,
          }
        }
      }
    } catch {
      /* 证据比对失败不阻断（兼容旧库缺列） */
    }
  }

  return { ok: true, reason: null, mustFix: mf.all.length ? mf : null }
}

/**
 * 下一次迭代号：上次失败若为纯考卷问题（归因后仍 suite）→ 不烧迭代上限。
 * 业务/混合失败照常 +1；infrastructure 失败不影响迭代（状态走 paused_ops）。
 */
export async function nextGateLoopIteration(db, { repoSlug, taskId }) {
  const loop = await getGateLoop(db, { repo: repoSlug, taskId })
  const cur = loop?.iteration || 0
  try {
    const group = await latestFormalRunGroup(db, { repoSlug, taskId })
    if (group && (group.status === 'failed' || group.status === 'error')) {
      const { checks, terminalReason } = await loadRunGroupChecks(db, group.run_group_id)
      const attributed = await attributeSuiteChecks(db, { repoId: group.repo_id, bindingId: group.binding_id, checks })
      const cls = classifyRunChecks(attributed.checks, terminalReason)
      // infra 失败同样不烧迭代（与上方注释语义对齐，2026-09-26 修复：此前只豁免 suite）
      if (cls.overall === 'suite' || cls.overall === 'infra') return { next: cur, exempted: true }
    }
  } catch {
    /* 归因不可用时按正常计数，不阻塞下单 */
  }
  return { next: cur + 1, exempted: false }
}

// ─── Packet ────────────────────────────────────────────────────
export function buildRemediationPacket({
  repo,
  taskId,
  status,
  loop,
  classification,
  bindingId = null,
  expectedTaskRevision = null,
  submissionId = null,
  runGroupId = null,
  message = null,
}) {
  const overall = classification?.overall || 'none'
  const mustFix = buildMustFixList(classification)
  const canRetry =
    !loop.needsHuman &&
    loop.iteration < loop.maxIterations &&
    status !== 'passed' &&
    overall !== 'infra'
  const nextAllowed = []
  if (status === 'passed') {
    nextAllowed.push('advance')
  } else if (status === 'IN_PROGRESS' || status === 'NOT_SUBMITTED') {
    nextAllowed.push(status === 'NOT_SUBMITTED' ? 'resubmit' : 'wait_terminal')
  } else if (loop.needsHuman || loop.iteration >= loop.maxIterations) {
    nextAllowed.push('needs_human')
  } else if (overall === 'infra') {
    nextAllowed.push('ops')
  } else if (mustFix.requiresProductFix && mustFix.requiresSuiteFix) {
    nextAllowed.push('fix_product', 'fix_spec', 'distill', 'resubmit')
  } else if (mustFix.requiresProductFix) {
    nextAllowed.push('fix_product', 'distill', 'resubmit')
  } else if (mustFix.requiresSuiteFix || overall === 'suite' || overall === 'mixed') {
    nextAllowed.push('fix_spec', 'distill', 'resubmit')
  } else {
    nextAllowed.push('distill', 'fix_product', 'resubmit')
  }

  const actions = []
  const featureKeys = (classification?.byCheck || [])
    .map((c) => c.featureKey)
    .filter(Boolean)
  if (status === 'passed') {
    actions.push({
      tool: 'harness_advance',
      args: {
        taskId,
        to: loop.size === 'S' ? 'DONE' : 'VERIFY',
        data: { gateBindingId: bindingId, expectedTaskRevision },
      },
      required: true,
      note: '仅在 units 全绿后推进',
    })
  } else if (status === 'IN_PROGRESS') {
    actions.push({ tool: 'awp_loop_wait', args: { taskId }, required: true, note: '云端执行中，必须等到终态' })
  } else if (status === 'NOT_SUBMITTED') {
    actions.push({ tool: 'awp_test_run', args: { taskId, wait: true }, required: true })
  } else {
    // mixed/product：先业务，禁止只改 spec
    if (mustFix.requiresProductFix) {
      const files = [...new Set(mustFix.product.flatMap((p) => p.files))]
      // 整文件一次修净：禁止「云端报一条改一条」的盲修 round-trip
      const commands = files.length
        ? files
            .map((f) => `npx prettier --write "${f}" && npx eslint --fix "${f}" && npx eslint "${f}"`)
            .join(' && ') + '  # 本地全部 exit 0 再 awp_test_run；禁止按云端逐条盲改'
        : 'npx prettier --write <mustFix files> && npx eslint --fix <files> 并确认 exit 0'
      actions.push({
        tool: 'fix_product',
        args: {
          taskId,
          files,
          commands,
        },
        required: true,
        note: 'product 未修禁止重提；本地 prettier+eslint 一次修净，不要逐条等云端反馈',
      })
    }
    if (mustFix.requiresSuiteFix) {
      for (const fk of featureKeys) {
        actions.push({ tool: 'awp_test_spec_get', args: { featureKey: fk }, required: true })
      }
      actions.push({
        tool: 'awp_test_spec_submit',
        args: { featureKey: featureKeys[0] || '<featureKey>', note: 'fix suite per mustFix' },
        required: Boolean(featureKeys.length),
      })
    }
    actions.push({ tool: 'distill_append', args: { taskId, source: 'auto' }, required: true })
    actions.push({
      tool: 'awp_test_run',
      args: {
        taskId,
        wait: true,
        productFixed: mustFix.requiresProductFix ? true : undefined,
        suiteFixed: mustFix.requiresSuiteFix ? true : undefined,
      },
      required: true,
    })
  }
  if (overall === 'infra' && actions.length === 0) {
    actions.push({ tool: 'ops', args: {}, required: false, note: '联系平台运维，AI 不重试 infra' })
  }

  const assets = featureKeys.length
    ? {
        featureKeys,
        currentVersions: featureKeys.map(() => 0), // lookupSpecVersion(null,·)=0(无 db 快路径)
      }
    : undefined

  const packet = {
    protocol: CLRP_PROTOCOL,
    taskId,
    repo,
    status,
    loop: {
      state: loop.state,
      iteration: loop.iteration,
      maxIterations: loop.maxIterations,
      canRetry,
      nextAllowed,
    },
    classification: classification || { overall: 'none', byCheck: [] },
    mustFix,
    ...(assets ? { assets } : {}),
    actions,
    forbidden: status === 'passed' ? ['使用过期 gateBindingId'] : FORBIDDEN_COMPLETE,
    completionBlocked: status !== 'passed',
    message:
      message ||
      (status === 'passed'
        ? '云端门禁通过，可 harness_advance'
        : status === 'IN_PROGRESS'
          ? '云端执行中，禁止宣称任务完成，必须等待终态'
          : `门禁未通过（${overall}）${mustFix.summary ? '：' + mustFix.summary : ''}。必须按 mustFix/actions 回环，禁止只改 spec 应付。`),
  }
  if (bindingId) packet.bindingId = bindingId
  if (expectedTaskRevision != null) packet.expectedTaskRevision = expectedTaskRevision
  if (submissionId) packet.submissionId = submissionId
  if (runGroupId) packet.runGroupId = runGroupId
  return packet
}

async function lookupSpecVersion(db, repo, featureKey) {
  if (!db) return 0
  try {
    const row = await db
      .prepare(
        `SELECT version FROM test_specs WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=? LIMIT 1)
         AND feature_key=? AND review_status='active' ORDER BY version DESC LIMIT 1`
      )
      .get(repo, featureKey)
    return row?.version || 0
  } catch {
    return 0
  }
}

// 绑定 db 的 packet 构建（带 asset version + 相似错题推送）
export async function buildPacketWithDb(db, args) {
  const featureKeys = (args.classification?.byCheck || []).map((c) => c.featureKey).filter(Boolean)
  const packet = buildRemediationPacket(args)
  if (featureKeys.length && db) {
    packet.assets = {
      featureKeys,
      currentVersions: await Promise.all(featureKeys.map(async (fk) => await lookupSpecVersion(db, args.repo, fk))),
    }
  }
  // 答案送上门：考卷失败时自动附上历史 test 类错题笔记（AI 不用"想起来去查"）
  if (db && args.classification?.overall === 'suite') {
    try {
      const fk = featureKeys[0] || ''
      const rows = await db
        .prepare(
          `SELECT id, content FROM experiences
           WHERE category='test' AND status != 'obsolete' AND (content LIKE ? OR content LIKE ?)
           ORDER BY updated_at DESC LIMIT 3`
        )
        .all(`%${fk}%`, `%${String(args.taskId || '')}%`)
      if (rows.length) {
        packet.relatedExperiences = rows.map((r) => ({ id: r.id, excerpt: String(r.content).slice(0, 300) }))
      }
    } catch {
      /* category 列不存在（v18 前的库）跳过 */
    }
  }
  // 答案送上门（v2，2026-09-26）：product/mixed 失败按改动文件推送历史修复经验。
  // product 失败是占比最大的一类，此前完全无经验推送；用 mustFix 抽取的改动文件名匹配错题。
  if (db && (args.classification?.overall === 'product' || args.classification?.overall === 'mixed')) {
    try {
      const files = [...new Set((args.classification?.byCheck || []).flatMap((c) => (Array.isArray(c.files) ? c.files : [])))]
        .filter(Boolean).slice(0, 5)
      const seen = new Set()
      const related = []
      for (const f of files) {
        const base = String(f).split('/').pop().replace(/\.[^.]+$/, '')
        if (!base || base.length < 4) continue
        const rows = await db
          .prepare(
            `SELECT id, category, content FROM experiences
             WHERE status != 'obsolete' AND content LIKE ?
             ORDER BY updated_at DESC LIMIT 2`
          )
          .all(`%${base}%`)
        for (const r of rows) {
          if (seen.has(r.id)) continue
          seen.add(r.id)
          related.push({ id: r.id, category: r.category, excerpt: String(r.content || '').slice(0, 300), matchedFile: f })
          if (related.length >= 3) break
        }
        if (related.length >= 3) break
      }
      if (related.length) packet.relatedExperiences = related
    } catch {
      /* 经验推送失败不阻断 packet */
    }
  }
  return packet
}

// ─── 从 run_group 终态构建 packet 并写 loop ─────────────────────

export async function latestFormalRunGroup(db, { repoSlug, taskId }) {
  try {
    return await db
      .prepare(
        `SELECT g.* FROM run_groups g
         JOIN test_submissions s ON s.submission_id=g.submission_id
         JOIN legacy_task_mappings m ON m.task_instance_id=s.task_instance_id
         JOIN repositories r ON r.repo_id=m.repo_id
         WHERE r.slug=? AND m.legacy_task_id=? AND g.kind='formal'
         ORDER BY g.created_at DESC LIMIT 1`
      )
      .get(repoSlug, taskId)
  } catch {
    return null
  }
}

/** 组级终态原因的优先级：断言失败必须赢过 infra 类原因，否则真业务失败会被整组判成 infra 放行 */
const TERMINAL_REASON_PRIORITY = [
  'assertion_failed',
  'product_hang',
  'dependency_input',
  'infra_error',
  'timed_out',
  'lost',
  'canceled',
  'superseded',
]

export async function loadRunGroupChecks(db, runGroupId) {
  const runs = await db
    .prepare(`SELECT run_id, unit, side, status, terminal_reason, report_json FROM test_runs WHERE run_group_id=?`)
    .all(runGroupId)
  const checks = []
  for (const r of runs) {
    try {
      const report = JSON.parse(r.report_json || 'null')
      for (const c of report?.checks || []) {
        checks.push({ ...c, unit: r.unit, side: r.side })
      }
    } catch {
      /* ignore */
    }
  }
  const present = runs.map((r) => r.terminal_reason).filter(Boolean)
  const terminalReason = TERMINAL_REASON_PRIORITY.find((t) => present.includes(t)) || present[present.length - 1] || null
  return { checks, terminalReason, runs }
}

/**
 * 按最新 formal run_group 同步 gateLoop + 返回 packet（不改 iteration，仅在下单时 +1）。
 */
export async function syncGateLoopFromRunGroup(db, { repoSlug, taskId, size, phase = 'EXECUTE' }) {
  const loop = await ensureGateLoop(db, { repo: repoSlug, taskId, size, phase })
  const group = await latestFormalRunGroup(db, { repoSlug, taskId })
  if (!group) {
    const packet = await buildPacketWithDb(db, {
      repo: repoSlug,
      taskId,
      status: 'NOT_SUBMITTED',
      loop: { ...loop, state: loop.state === 'coding' ? 'coding' : loop.state },
      classification: { overall: 'none', byCheck: [] },
      message: '尚未下单云端门禁，必须先 awp_test_run(wait=true)',
    })
    return { loop, packet, group: null }
  }
  const { checks, terminalReason } = await loadRunGroupChecks(db, group.run_group_id)
  // 归因修正先行：suite 失败若命中本次改动文件的页面依赖 → 真回归（product），不适用考卷豁免
  const attributed = await attributeSuiteChecks(db, {
    repoId: group.repo_id,
    bindingId: group.binding_id,
    checks,
  })
  const terminal = group.status
  const classification = classifyRunChecks(attributed.checks, terminalReason)
  let state = loop.state
  let status = 'IN_PROGRESS'
  if (terminal === 'passed') {
    status = 'passed'
    state = 'green_pending_advance'
  } else if (terminal === 'failed' || terminal === 'error') {
    status = terminal === 'error' && classification.overall === 'infra' ? 'error' : 'failed'
    if (classification.overall === 'infra') state = 'paused_ops'
    else if (classification.overall === 'suite' || classification.overall === 'mixed') state = 'remediation_suite'
    else state = 'remediation_product'
  } else {
    status = 'IN_PROGRESS'
    state = 'waiting_gate'
  }
  const needsHuman = loop.needsHuman || (!loop.needsHuman && loop.iteration >= loop.maxIterations && status !== 'passed')
  // product/mixed 失败才强制沉淀；若失败后已有 distill_append（experiences.task_id 命中），
  // 禁止在 harness_status / 看板轮询再次 sync 时把 awaitDistill 写回 1（否则清了又锁，永远 AWAIT_DISTILL）
  const needDistill =
    status === 'failed' && (classification.overall === 'product' || classification.overall === 'mixed')
  let awaitDistill
  if (needDistill) {
    awaitDistill = await hasDistillAfter(db, { repo: repoSlug, taskId, since: group.finished_at || group.created_at }) ? 0 : 1
  } else if (status === 'passed') {
    awaitDistill = 0
  } else {
    awaitDistill = loop.awaitDistill
  }
  const nextLoop = await updateGateLoop(db, {
    repo: repoSlug,
    taskId,
    patch: {
      state: needsHuman && status !== 'passed' ? 'needs_human' : state,
      phase,
      size,
      lastTerminal: terminal,
      lastClass: classification.overall,
      lastRunGroupId: group.run_group_id,
      lastSubmissionId: group.submission_id,
      lastBindingId: group.binding_id,
      awaitDistill,
      needsHuman: needsHuman && status !== 'passed',
      pendingActions: pendingActionsFor(status, classification.overall, needsHuman),
      appendHistory: {
        at: utcNow(),
        runGroupId: group.run_group_id,
        terminal,
        class: classification.overall,
      },
    },
  })
  const packet = await buildPacketWithDb(db, {
    repo: repoSlug,
    taskId,
    status: nextLoop.needsHuman && status !== 'passed' ? 'NEEDS_HUMAN' : status,
    loop: nextLoop,
    classification,
    bindingId: group.binding_id,
    submissionId: group.submission_id,
    runGroupId: group.run_group_id,
  })
  // 错题笔记自动入库（test 类免审直生效）：纯考卷失败时平台代写，AI 零手动动作
  if (status === 'failed' && classification.overall === 'suite') {
    try {
      const repoRow = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
      const dup = (await db
        .prepare(
          `SELECT COUNT(*) c FROM experiences WHERE repo=? AND task_id=? AND category='test' AND created_at > ?`
        )
        .get(repoSlug, taskId, group.finished_at)).c
      if (!dup) {
        const detail = (classification.byCheck || [])
          .map((c) => `- ${c.caseKey}：${String(c.detail || '').slice(0, 200)}`)
          .join('\n')
        // 验卷结论合成：每张考卷的变异/F2P 状态一目了然
        const featureKeys = (classification.byCheck || []).map((c) => c.featureKey).filter(Boolean)
        let verdictLines = ''
        for (const fk of featureKeys) {
          const spec = await db
            .prepare(
              `SELECT feature_key, mutation_verified FROM test_specs
               WHERE repo_id=? AND feature_key=? AND review_status='active' ORDER BY version DESC LIMIT 1`
            )
            .get(repoRow?.repo_id, fk)
          if (!spec) continue
          let f2p = null
          try {
            f2p = await db
              .prepare(
                `SELECT f2p_status FROM spec_f2p_results WHERE repo_id=? AND feature_key=? ORDER BY created_at DESC LIMIT 1`
              )
              .get(repoRow?.repo_id, fk)
          } catch { /* v20 前无表 */ }
          const mv = Number(spec.mutation_verified) === 1 ? '✓已抓到暗题' : '⏳未验证'
          const fp = !f2p || f2p.f2p_status === 'skipped' ? '⏳未跑' : f2p.f2p_status === 'ok' ? '✓能区分前后' : `✗${f2p.f2p_status}`
          verdictLines += `\n${fk}：变异 ${mv}｜F2P ${fp}`
        }
        await db.prepare(
          `INSERT INTO experiences(id, repo, tenant_id, task_id, content, source, status, category, author, tags, created_at, updated_at)
           VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, 'auto', 'reviewed', 'test', 'test-platform', '["auto-exam"]', ?, ?)`
        ).run(
          `exp-auto-${uuidv7()}`,
          repoSlug,
          repoSlug,
          taskId,
          `【考卷问题·自动入库】任务 ${taskId} 的测试脚本失败。\n失败点：\n${detail || '(无明细)'}` +
            (verdictLines ? `\n\n验卷状态：${verdictLines}` : '') +
            '\n修复路径：awp_test_spec_get 读全文 → 修 spec → awp_test_spec_submit 重提（不计迭代）。',
          utcNow(),
          utcNow()
        )
      }
    } catch {
      /* experiences 结构差异（纯 testing 库 / v18 前无 category 列）：跳过自动入库 */
    }
  }
  return { loop: nextLoop, packet, group }
}

function pendingActionsFor(status, overall, needsHuman) {
  if (needsHuman) return ['needs_human']
  if (status === 'passed') return ['advance']
  if (status === 'IN_PROGRESS') return ['wait_terminal']
  if (overall === 'infra') return ['ops']
  if (overall === 'suite' || overall === 'mixed') return ['fix_spec', 'distill', 'resubmit']
  return ['distill', 'fix_product', 'resubmit']
}

/**
 * 失败时刻之后是否已有人写过经验（distill_append 带 taskId）。
 * 用于避免「写完经验 → status/轮询 sync → awaitDistill 被写回」死锁。
 */
async function hasDistillAfter(db, { repo, taskId, since }) {
  if (!taskId || !since) return false
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS hit FROM experiences
         WHERE repo = ? AND task_id = ? AND created_at >= ?
         LIMIT 1`
      )
      .get(repo, taskId, since)
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * 续作解锁：迭代耗尽（needs_human）后，AICoding/看板重新发起续作时补发测试预算。
 * 默认每次续作只 +1 次机会（不是再给满 5 次）；只抬高 max_iterations，不回退 iteration。
 * 看板 waiver 与 awp_loop_resume 共用，避免两处语义漂移。
 */
export async function grantGateRetryBudget(db, {
  repo,
  taskId,
  actor = 'resume',
  extraIterations = 1,
  now = utcNow(),
} = {}) {
  const loop = await getGateLoop(db, { repo, taskId })
  if (!loop) {
    return { granted: false, code: 'NO_GATE_LOOP', reason: `无 gateLoop：${taskId}`, loop: null }
  }
  if (!loop.needsHuman && loop.iteration < loop.maxIterations) {
    return {
      granted: false,
      code: 'BUDGET_AVAILABLE',
      reason: `仍有测试预算 ${loop.iteration}/${loop.maxIterations}，无需解锁`,
      loop,
    }
  }
  const add = Math.max(1, Number(extraIterations) || 1)
  const waiverId = `resume-${Date.now()}`
  const maxIterations = loop.maxIterations + add
  // 解锁后回到可继续修复的状态；lastClass 决定先修业务还是考卷
  let state = 'coding'
  if (loop.lastClass === 'product') state = 'remediation_product'
  else if (loop.lastClass === 'suite' || loop.lastClass === 'mixed') state = 'remediation_suite'
  const next = await updateGateLoop(db, {
    repo,
    taskId,
    now,
    patch: {
      needsHuman: false,
      maxIterations,
      state,
      pendingActions: ['code'],
      awaitDistill: 0,
      waiverId,
      appendHistory: {
        at: now,
        event: 'retry_budget_granted',
        by: actor,
        maxIterations,
        note: `续作解锁：+${add} 次测试机会，当前预算 ${loop.iteration}/${maxIterations}`,
      },
    },
  })
  try {
    await db.prepare(
      `UPDATE task_sessions SET released_at=? WHERE repo=? AND task_id=? AND released_at IS NULL`
    ).run(now, repo, taskId)
  } catch {
    /* 纯 testing 库可能无 task_sessions */
  }
  return { granted: true, waiverId, added: add, maxIterations, loop: next, actor }
}

// ─── wait 轮询 ─────────────────────────────────────────────────

export async function getSubmissionStatus(db, submissionId) {
  const sub = await db.prepare('SELECT * FROM test_submissions WHERE submission_id=?').get(submissionId)
  if (!sub) return null
  const group = await db
    .prepare(`SELECT * FROM run_groups WHERE submission_id=? AND kind='formal' ORDER BY created_at DESC LIMIT 1`)
    .get(submissionId)
  const runs = group
    ? await db.prepare('SELECT unit, side, status FROM test_runs WHERE run_group_id=?').all(group.run_group_id)
    : []
  return { submission: sub, group, runs }
}

/** 组状态可能短暂滞后于 run 终态；以「全部 run 已终态」为准提前返回 */
export function allRunsTerminal(runs = []) {
  if (!runs.length) return null
  const terminal = new Set(['passed', 'failed', 'error', 'canceled', 'timed_out', 'lost'])
  if (!runs.every((r) => terminal.has(r.status))) return null
  if (runs.every((r) => r.status === 'passed')) return 'passed'
  if (runs.some((r) => r.status === 'error' || r.status === 'timed_out' || r.status === 'lost')) return 'error'
  return 'failed'
}

/**
 * 阻塞轮询 submission 到终态。返回 { terminal, group, timedOut, polls }
 * 全部 run 终态即返回（不等 group 滞后字段，不空等到超时）。
 */
export async function waitForGateTerminal(db, {
  submissionId,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  pollMs = DEFAULT_WAIT_POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress = null,
}) {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  for (;;) {
    polls += 1
    const snap = await getSubmissionStatus(db, submissionId)
    if (!snap) return { terminal: 'missing', group: null, timedOut: false, polls }
    const runTerminal = allRunsTerminal(snap.runs)
    const groupSt = snap.group?.status || snap.submission.status
    const st =
      runTerminal ||
      (groupSt === 'passed' || groupSt === 'failed' || groupSt === 'error' || groupSt === 'canceled'
        ? groupSt
        : null)
    if (st) {
      return { terminal: st, group: snap.group, timedOut: false, polls }
    }
    if (Date.now() >= deadline) {
      return { terminal: groupSt || 'queued', group: snap.group, timedOut: true, polls }
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ polls, runs: snap.runs, waitedMs: polls * pollMs })
      } catch {
        /* ignore */
      }
    }
    await sleep(pollMs)
  }
}

export { LOOP_STATES, FORBIDDEN_COMPLETE }
