import { uuidv7, utcNow } from '../testing/ids.js'
import { loadRunGroupChecks, classifyRunChecks } from './loop.js'
import { attributeSuiteChecks } from '../testing/impact.js'
import { lockedCasesForRun } from '../testing/asset-lock.js'
import * as gatePolicyMod from './gate-policy.js'
import { phaseToActivity } from './activity-plan.js'
import { getRepoPlatformProfile } from '../testing/repo-platform.js'

// M 级仅对页面与集成类任务追加项目配置的 smoke lanes。
const UI_TYPES = new Set(['UI_DEV', 'FEATURE', 'INTEGRATION'])

function compileRule(source) {
  return new RegExp(source, 'i')
}

/** Infer configured lanes from changed paths. Missing rules or no matches stay unresolved. */
export function inferSidesFromChangedFiles(files, rules = null) {
  if (!Array.isArray(files) || !files.length) return null
  const sideRules = rules?.sides && typeof rules.sides === 'object' ? rules.sides : {}
  const sideNames = Object.keys(sideRules)
  if (!sideNames.length) return null
  const both = (rules.both || []).map(compileRule)
  const compiledSides = Object.fromEntries(sideNames.map((side) => [side, (sideRules[side] || []).map(compileRule)]))
  const selected = new Set()
  for (const raw of files) {
    const file = String(raw || '').replace(/\\/g, '/').replace(/^\.\//, '')
    if (!file) continue
    if (both.some((re) => re.test(file))) {
      for (const side of sideNames) selected.add(side)
      continue
    }
    for (const [side, patterns] of Object.entries(compiledSides)) {
      if (patterns.some((re) => re.test(file))) selected.add(side)
    }
  }
  return selected.size ? sideNames.filter((side) => selected.has(side)) : null
}

export function requiredUnitsForSize(size, sides = []) {
  if (size === 'S') return ['static:na']
  if (size === 'M' || size === 'L') return ['static:na', ...sides.map((side) => `smoke:${side}`)]
  return []
}

/**
 * 体量策略（防过量测试）：size + type + 改动端
 *  S → static；M/L + UI type → static + 对应端 smoke（改啥测啥）；L 无 sides 时双侧
 *
 * changeKind:
 *  - full：产品代码变更（默认）→ static + smoke
 *  - spec-only：产品快照未变、仅考卷更新且上次 static 已绿 → 只跑 smoke（跳过 static）
 */
export function requiredUnitsForTask({ size, type = null, sides, changeKind = 'full' } = {}) {
  if (size === 'S') {
    return ['static:na']
  }
  if (size === 'M' || size === 'L') {
    const specOnly = changeKind === 'spec-only'
    const units = specOnly ? [] : ['static:na']
    const needSmoke = size === 'L' || UI_TYPES.has(type) || specOnly
    if (needSmoke && Array.isArray(sides) && sides.length) {
      for (const side of sides) units.push(`smoke:${side}`)
    }
    if (!units.length) units.push('static:na')
    return units
  }
  return []
}

/**
 * 判定本次下单是否「仅考卷刷新」：
 * 产品 snapshot tree+head 与最近一次 formal passed 相同，且该轮 static:na 已 passed。
 */
export async function detectChangeKind(db, { repoSlug, taskId, snapshotTreeOid }) {
  if (!snapshotTreeOid) return 'full'
  try {
    const rows = await db
      .prepare(
        `SELECT bs.snapshot_tree_oid, r.unit, r.status, g.run_group_id, s.created_at
         FROM test_submissions s
         JOIN legacy_task_mappings m ON m.task_instance_id = s.task_instance_id
         JOIN run_groups g ON g.submission_id = s.submission_id AND g.kind = 'formal'
         JOIN test_runs r ON r.run_group_id = g.run_group_id
         JOIN test_bindings b ON b.binding_id = g.binding_id
         JOIN business_snapshots bs ON bs.snapshot_id = b.snapshot_id
         JOIN repositories rep ON rep.repo_id = s.repo_id
         WHERE rep.slug = ? AND m.legacy_task_id = ? AND g.status = 'passed'
         ORDER BY s.created_at DESC, s.submission_id DESC LIMIT 40`
      )
      .all(repoSlug, taskId)
    if (!rows.length) return 'full'
    const latest = rows[0]
    // HEAD 相同不代表工作区 tree 相同；缺 tree 也不能证明产品未变。
    if (!latest.snapshot_tree_oid || latest.snapshot_tree_oid !== snapshotTreeOid) return 'full'
    const staticGreen = rows.some((r) => r.unit === 'static' && r.status === 'passed'
      && r.run_group_id === latest.run_group_id)
    return staticGreen ? 'spec-only' : 'full'
  } catch {
    return 'full'
  }
}

/** 提交前纯 AC 覆盖检查：只看本轮实际执行的冻结卷，不读取旧 binding、变异或 F2P。
 *  nightly（夜间全量回归合成任务）豁免：其 AC 是"全部 active 考卷执行通过"，
 *  覆盖关系由提交本身天然满足，且真实考卷的 acceptanceRefs 不可能引用合成 AC id——
 *  预检对它必然误拦（2026-10-02：nightly 自上线起每次下单都死于 AC_COVERAGE_MISSING）。
 *  标记只由 testing/nightly.js 服务端写入，guest 侧 meta 合并为白名单，无法自注入。 */
export function preflightSubmissionAc({ mode, size, acceptance = [], specs = [], taskId = null, nightly = false }) {
  const applicable = !nightly && canonicalGateMode(mode) === 'enforce' && ['M', 'L'].includes(size)
    && Array.isArray(acceptance) && acceptance.length > 0
  if (!applicable) return { applicable: false, ok: true, missing: [], covered: [] }
  const covered = new Set()
  for (const spec of specs) {
    // 其它任务的 AC-1 不能冒充本任务 AC-1；无归属的公共卷仍可覆盖。
    if (spec.demandRef && spec.demandRef !== taskId) continue
    for (const ref of Array.isArray(spec.acceptanceRefs) ? spec.acceptanceRefs : []) covered.add(ref)
  }
  const missing = acceptance.filter((a) => !covered.has(a.id)).map((a) => a.id)
  return { applicable: true, ok: missing.length === 0, missing,
    covered: acceptance.filter((a) => covered.has(a.id)).map((a) => a.id) }
}

export async function sidesFromBinding(db, bindingId) {
  try {
    const row = await db.prepare('SELECT resolved_sides_json FROM test_bindings WHERE binding_id=?').get(bindingId)
    if (!row?.resolved_sides_json) return null
    const sides = JSON.parse(row.resolved_sides_json)
    return Array.isArray(sides) && sides.length ? sides : null
  } catch {
    return null
  }
}

/** 从最近 formal run_group 读取实际下单的 requiredUnits（spec-only 轮可能无 static） */
export async function unitsFromLastFormalGroup(db, { repoSlug, taskId, bindingId = null }) {
  try {
    const row = bindingId
      ? await db
          .prepare(
            `SELECT g.required_units_json FROM run_groups g
             WHERE g.binding_id=? AND g.kind='formal' AND g.gate_eligible=1
             ORDER BY g.created_at DESC LIMIT 1`
          )
          .get(bindingId)
      : await db
          .prepare(
            `SELECT g.required_units_json FROM run_groups g
             JOIN test_submissions s ON s.submission_id=g.submission_id
             JOIN legacy_task_mappings m ON m.task_instance_id=s.task_instance_id
             JOIN repositories r ON r.repo_id=m.repo_id
             WHERE r.slug=? AND m.legacy_task_id=? AND g.kind='formal' AND g.gate_eligible=1
             ORDER BY g.created_at DESC LIMIT 1`
          )
          .get(repoSlug, taskId)
    if (!row?.required_units_json) return null
    const units = JSON.parse(row.required_units_json)
    return Array.isArray(units) && units.length ? units : null
  } catch {
    return null
  }
}

/** 从 harness tasks 表读任务类型（服务端唯一真相）；表不存在（纯 testing 库/测试环境）时回落 null */
export async function lookupTaskType(db, repoSlug, legacyTaskId) {
  try {
    return (await db.prepare('SELECT type FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, legacyTaskId))?.type || null
  } catch {
    return null
  }
}

export function isPlatformGateTransition(from, to, _size) {
  const f = phaseToActivity(from)
  const t = phaseToActivity(to)
  return f === 'execute' && (t === 'static' || t === 'smoke' || t === 'done')
}

/** enforce_s / enforce_ml / enforce_all 读作同一档 enforce，不再按 size 拆。 */
export function canonicalGateMode(mode) {
  if (mode === 'enforce_s' || mode === 'enforce_ml' || mode === 'enforce_all') return 'enforce'
  return mode
}

export function shouldEnforceNewGate(mode, _size) {
  return canonicalGateMode(mode) === 'enforce'
}

/**
 * 统一门禁决策（生产与测试共用真相）。
 * 优先拆分错误码：NOT_SUBMITTED / IN_PROGRESS / UNITS_FAILED / BINDING_STALE / TASK_REVISION_CONFLICT
 */
export async function evaluateGateDecision(db, {
  repoSlug,
  taskId,
  size,
  gateBindingId = null,
  expectedTaskRevision = null,
  changedFiles = null,
}) {
  const mode = await getRepoGateMode(db, repoSlug)
  let policy = null
  try {
    const { resolveGatePolicy } = gatePolicyMod
    policy = await resolveGatePolicy(db, { repoSlug, taskId, size, changedFiles })
  } catch {
    policy = null
  }
  const enforcement = policy && policy.enabled
    ? shouldEnforceNewGate(policy.effectiveMode, size)
    : shouldEnforceNewGate(mode, size)
  const evaluation = await evaluateNewGate(db, {
    repoSlug,
    taskId,
    size,
    gateBindingId,
    expectedTaskRevision,
  })
  return {
    mode: policy?.effectiveMode || mode,
    staticMode: mode,
    policy,
    enforcement,
    shouldBlock: enforcement && evaluation.wouldBlock,
    ...evaluation,
  }
}

export async function getRepoGateMode(db, repoSlug) {
  const row = await db.prepare(
    `SELECT m.mode FROM repo_gate_modes m
     JOIN repositories r ON r.repo_id = m.repo_id
     WHERE r.slug=?`
  ).get(repoSlug)
  return row?.mode || 'legacy'
}

export async function ensureRepoGateMode(db, repoId, slug, now = utcNow()) {
  const existing = await db.prepare('SELECT mode FROM repo_gate_modes WHERE repo_id=?').get(repoId)
  if (existing) return existing.mode
  const mode = getRepoPlatformProfile(slug)?.gateMode || 'observe'
  await db.prepare('INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)').run(repoId, mode, now)
  return mode
}

/** 云端测试 gate mode 全集：disabled = 该仓独立关闭云端测试（可插拔开关，互不影响其他仓） */
export const GATE_MODES = ['legacy', 'observe', 'enforce_s', 'enforce_all', 'enforce_ml', 'disabled']

/** 云端测试是否启用：disabled / legacy 均不下单（legacy=传统本地守卫，与看板文案一致） */
export async function isCloudTestingEnabled(db, repoSlug) {
  const mode = await getRepoGateMode(db, repoSlug)
  return mode !== 'disabled' && mode !== 'legacy'
}

/** 管理开关：按仓设置 gate mode（看板/运维 API 用） */
export async function setRepoGateMode(db, repoSlug, mode, now = utcNow()) {
  if (!GATE_MODES.includes(mode)) {
    throw new Error(`INVALID_GATE_MODE: ${mode}（合法值：${GATE_MODES.join(' / ')}）`)
  }
  const repo = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
  if (!repo) throw new Error(`UNRESOLVED_REPO: ${repoSlug}`)
  const cur = await db.prepare('SELECT repo_id FROM repo_gate_modes WHERE repo_id=?').get(repo.repo_id)
  if (cur) {
    await db.prepare('UPDATE repo_gate_modes SET mode=?, updated_at=? WHERE repo_id=?').run(mode, now, repo.repo_id)
  } else {
    await db.prepare('INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)').run(repo.repo_id, mode, now)
  }
  return mode
}

function block(code, message, bindingId = null, extras = {}) {
  return {
    code,
    message,
    bindingId,
    runId: extras.runId || null,
    details: extras.details || {},
  }
}

async function lookupTaskInstance(db, repoSlug, legacyTaskId) {
  return await db.prepare(
    `SELECT t.task_instance_id, t.revision, t.active_binding_id, t.repo_id, t.status
     FROM legacy_task_mappings m
     JOIN repositories r ON r.repo_id = m.repo_id
     JOIN task_instances t ON t.task_instance_id = m.task_instance_id
     WHERE r.slug=? AND m.legacy_task_id=?`
  ).get(repoSlug, legacyTaskId)
}

/** 读 binding 冻结的执行清单；无清单（升级前的旧 binding）返回 null → 门禁回落旧判定 */
async function bindingAssetLock(db, bindingId) {
  try {
    const row = await db.prepare('SELECT canonical_binding_json FROM test_bindings WHERE binding_id=?').get(bindingId)
    const doc = JSON.parse(row?.canonical_binding_json || '{}')
    return Array.isArray(doc.assetLock?.specs) ? doc.assetLock : null
  } catch {
    return null
  }
}

function caseKeyForLockedSpec(spec) {
  return spec.specType === 'unit' ? `test:unit-spec/${spec.featureKey}` : `test:spec/${spec.featureKey}`
}

/**
 * 单个 required unit 的证据核对（run 状态 + attestation + 逐用例执行证据）。
 * run 整体 passed 只说明"它自称跑了"，冻结清单里的每个必测用例必须各自有可核对的执行记录：
 *  - 缺 check（用例根本没出现在报告里）
 *  - check 非 passed
 *  - unit 资产无执行计数（execution.executed = 0，即"退出码 0 但没跑用例"）
 *  - 报告的资产摘要与冻结清单不一致（跑了别的版本）
 * 任一命中 → 不得放行。旧 binding 无清单时维持原判定（升级过渡）。
 */
export async function unitEvidence(db, bindingId, unitKey) {
  const [unit, side] = String(unitKey).split(':')
  const row = await db.prepare(
    `SELECT r.run_id, r.status, r.report_json FROM test_runs r
     JOIN run_groups g ON g.run_group_id = r.run_group_id
     WHERE r.binding_id=? AND r.unit=? AND r.side=? AND r.purpose='gate'
       AND g.kind='formal' AND g.gate_eligible=1
     ORDER BY r.created_at DESC LIMIT 1`
  ).get(bindingId, unit, side)
  const unitLabel = `${unit}:${side}`
  if (!row) return { ok: false, code: 'IN_PROGRESS', message: `required unit 未通过：${unitLabel}`, details: { unit: unitLabel, runStatus: 'missing' } }
  if (['queued', 'active', 'running'].includes(row.status)) {
    return { ok: false, code: 'IN_PROGRESS', message: `required unit 未通过：${unitLabel}`, details: { unit: unitLabel, runStatus: row.status, runId: row.run_id } }
  }
  if (row.status !== 'passed') {
    return { ok: false, code: 'UNITS_FAILED', message: `required unit 未通过：${unitLabel}`, details: { unit: unitLabel, runStatus: row.status, runId: row.run_id } }
  }
  const att = await db.prepare(
    `SELECT 1 FROM run_attestations a
     JOIN accepted_run_results x ON x.run_id=a.run_id AND x.attempt=a.attempt AND x.lease_epoch=a.lease_epoch
     WHERE a.run_id=?`
  ).get(row.run_id)
  if (!att) {
    return {
      ok: false,
      code: 'ATTESTATION_MISSING',
      message: `required unit 无验收凭据：${unitLabel}（run passed 但缺 attestation/accepted result）`,
      details: { unit: unitLabel, runId: row.run_id },
    }
  }
  const lock = await bindingAssetLock(db, bindingId)
  if (!lock) return { ok: true, runId: row.run_id, legacy: true }
  let checks = []
  try {
    checks = JSON.parse(row.report_json || '{}').checks || []
  } catch {
    checks = []
  }
  const byKey = new Map((Array.isArray(checks) ? checks : []).map((c) => [String(c?.caseKey || ''), c]))
  const required = lockedCasesForRun(lock, { unit, side })
  const missing = []
  for (const spec of required) {
    const caseKey = caseKeyForLockedSpec(spec)
    const c = byKey.get(caseKey)
    if (!c) {
      missing.push({ caseKey, featureKey: spec.featureKey, version: spec.version, reason: 'no-execution-record' })
      continue
    }
    if (c.status !== 'passed') {
      missing.push({ caseKey, featureKey: spec.featureKey, version: spec.version, reason: `check-${c.status}` })
      continue
    }
    if (spec.specType === 'unit') {
      const executed = Number(c.execution?.executed)
      if (!Number.isFinite(executed) || executed <= 0) {
        missing.push({ caseKey, featureKey: spec.featureKey, version: spec.version, reason: 'no-test-executed' })
        continue
      }
    }
    if (c.asset?.blobSha256 && spec.blobSha256 && c.asset.blobSha256 !== spec.blobSha256) {
      missing.push({ caseKey, featureKey: spec.featureKey, version: spec.version, reason: 'asset-sha-mismatch' })
    }
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'EXECUTION_EVIDENCE_INCOMPLETE',
      message:
        `执行证据不完整：${unitLabel} 有 ${missing.length}/${required.length} 个必测用例缺有效执行记录`,
      details: { unit: unitLabel, runId: row.run_id, requiredCount: required.length, missing },
    }
  }
  return { ok: true, runId: row.run_id, requiredCount: required.length }
}

export async function evaluateNewGate(db, {
  repoSlug,
  taskId,
  size,
  gateBindingId = null,
  expectedTaskRevision = null,
}) {
  // 可插拔开关：该仓云端测试关闭 → 永不拦截
  if (await getRepoGateMode(db, repoSlug) === 'disabled') {
    return { wouldBlock: false, requiredUnits: [], blockedBy: [], instance: null, disabled: true }
  }
  const instance = await lookupTaskInstance(db, repoSlug, taskId)
  const sides = instance?.active_binding_id ? await sidesFromBinding(db, instance.active_binding_id) : null
  const boundUnits = await unitsFromLastFormalGroup(db, {
    repoSlug,
    taskId,
    bindingId: gateBindingId || instance?.active_binding_id || null,
  })
  const requiredUnits =
    boundUnits ||
    requiredUnitsForTask({
      size,
      type: await lookupTaskType(db, repoSlug, taskId),
      sides,
    })
  const blockedBy = []
  if (!instance || instance.status !== 'open') {
    blockedBy.push(block('NOT_SUBMITTED', '无可用 task instance / active binding（请先 awp_test_run wait=true）', null, { details: { taskId } }))
    return { wouldBlock: true, requiredUnits, blockedBy, instance: null }
  }
  if (expectedTaskRevision != null && instance.revision !== expectedTaskRevision) {
    blockedBy.push(block('TASK_REVISION_CONFLICT', 'task revision 不匹配（中间有新提交，必须重新下单）', instance.active_binding_id, {
      details: { expectedTaskRevision, actualRevision: instance.revision },
    }))
  }
  if (!gateBindingId || !instance.active_binding_id) {
    blockedBy.push(block('NOT_SUBMITTED', '缺少 gateBindingId 或 active binding（请 awp_test_run 并等待终态）', instance.active_binding_id))
  } else if (gateBindingId !== instance.active_binding_id) {
    blockedBy.push(block('TASK_BINDING_SUPERSEDED', 'gateBindingId 不是当前 active binding', instance.active_binding_id, {
      details: { gateBindingId },
    }))
  }
  const bindingId = gateBindingId && gateBindingId === instance.active_binding_id ? gateBindingId : null
  if (bindingId) {
    for (const unit of requiredUnits) {
      // run 状态 + attestation + 逐用例执行证据一起核对（test_runs 自称 passed 不作为放行依据）
      const ev = await unitEvidence(db, bindingId, unit)
      if (ev.ok) continue
      blockedBy.push(block(ev.code, ev.message, bindingId, { details: ev.details }))
    }
  }
  return {
    wouldBlock: blockedBy.length > 0,
    requiredUnits,
    blockedBy,
    instance,
  }
}

/**
 * DONE 终态硬门禁：enforce 档位下禁止在云端未绿时宣称完成。
 * observe / legacy / disabled 不拦（与 shouldEnforceNewGate 语义一致）。
 */
export async function checkDoneGate(db, {
  repoSlug,
  taskId,
  size,
  mode = null,
  gateBindingId = null,
  expectedTaskRevision = null,
}) {
  const resolvedMode = mode || await getRepoGateMode(db, repoSlug)
  if (resolvedMode === 'disabled') {
    return { ok: true, code: 'DISABLED_BYPASS', mode: resolvedMode, enforcement: false }
  }
  if (!shouldEnforceNewGate(resolvedMode, size)) {
    return { ok: true, code: null, mode: resolvedMode, enforcement: false }
  }
  let bindingId = gateBindingId || null
  let revision = expectedTaskRevision
  if (!bindingId) {
    try {
      const loopRow = await db.prepare(
        `SELECT last_binding_id, last_expected_revision FROM gate_loops WHERE repo=? AND task_id=?`
      ).get(repoSlug, taskId)
      bindingId = loopRow?.last_binding_id || null
      if (revision == null && Number.isInteger(loopRow?.last_expected_revision)) {
        revision = loopRow.last_expected_revision
      }
    } catch {
      bindingId = null
    }
  }
  const evaluation = await evaluateNewGate(db, {
    repoSlug,
    taskId,
    size,
    gateBindingId: bindingId,
    expectedTaskRevision: revision,
  })
  if (evaluation.wouldBlock) {
    return {
      ok: false,
      code: 'GATE_NOT_GREEN',
      mode: resolvedMode,
      enforcement: true,
      bindingId,
      requiredUnits: evaluation.requiredUnits,
      blockedBy: evaluation.blockedBy,
      message:
        '云端门禁未绿：禁止 harness_advance(DONE)。须 awp_test_run(wait=true) 至 passed，' +
        'advance 时带 gateBindingId + expectedTaskRevision；disabled 仓才可本地直通。',
    }
  }
  return {
    ok: true,
    code: null,
    mode: resolvedMode,
    enforcement: true,
    bindingId: bindingId || evaluation.instance?.active_binding_id || null,
    requiredUnits: evaluation.requiredUnits,
  }
}

export async function recordObserveEvent(db, {
  repoSlug,
  taskId,
  transition,
  mode,
  legacyWouldBlock,
  evaluation,
  gateBindingId,
  now = utcNow(),
}) {
  const repo = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
  if (!repo) return null
  const newWouldBlock = evaluation.wouldBlock ? 1 : 0
  const legacy = legacyWouldBlock ? 1 : 0
  const eventId = uuidv7()
  await db.prepare(
    `INSERT INTO gate_observe_events(
       event_id, repo_id, task_instance_id, legacy_task_id, transition, mode,
       legacy_would_block, new_would_block, differ, gate_binding_id, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    repo.repo_id,
    evaluation.instance?.task_instance_id || null,
    taskId,
    transition,
    mode,
    legacy,
    newWouldBlock,
    legacy !== newWouldBlock ? 1 : 0,
    gateBindingId || null,
    JSON.stringify({
      requiredUnits: evaluation.requiredUnits,
      blockedBy: evaluation.blockedBy,
    }),
    now
  )
  return eventId
}

export async function testingPolicy(db, { repoSlug, taskId, phase, size, nextTo = null }) {
  const mode = await getRepoGateMode(db, repoSlug)
  // 关闭态：给 harness_status / context pack 一个明确的"不走云端"视图
  if (mode === 'disabled') {
    return {
      mode,
      enabled: false,
      actor: 'agent',
      humanMustNotRunOps: true,
      requiredUnits: [],
      submitRequired: false,
      submitBefore: [],
      advanceFields: [],
      taskId,
      hint: '该项目云端测试未启用（disabled）：无需 awp_test_run 下单、不提交测试资产，完成后直接 harness_advance。',
    }
  }
  const instance = await lookupTaskInstance(db, repoSlug, taskId)
  const sides = instance?.active_binding_id ? await sidesFromBinding(db, instance.active_binding_id) : null
  const requiredUnits = requiredUnitsForTask({
    size,
    type: await lookupTaskType(db, repoSlug, taskId),
    sides,
  })
  const submitBefore = []
  const phaseActivity = phaseToActivity(phase)
  if (phaseActivity === 'execute' && size === 'S') submitBefore.push('done')
  if (phaseActivity === 'execute' && (size === 'M' || size === 'L')) submitBefore.push('static')
  // 分级强制档：当前体量不在强制范围 → 不提示下单（observe 仍提示，保持双跑数据）
  const enforcedHere = shouldEnforceNewGate(mode, size)
  const scopedSubmit =
    (mode === 'enforce_s' || mode === 'enforce_ml') && !enforcedHere
      ? { submitRequired: false, submitBefore: [] }
      : {}
  return {
    mode,
    actor: 'agent',
    humanMustNotRunOps: true,
    requiredUnits,
    submitRequired: nextTo ? isPlatformGateTransition(phase, nextTo, size) : submitBefore.length > 0,
    submitBefore,
    advanceFields: ['gateBindingId', 'expectedTaskRevision'],
    taskId,
    ...scopedSubmit,
  }
}

/**
 * 失败经验强制沉淀（反哺闭环）：任务最近一次 formal 门禁组 failed 时，
 * 必须存在一条晚于失败完成时间、关联本 task 的经验（distill_append 写入即 pending 进评审队列）。
 * 返回需拦截的失败组信息；无需拦截返回 null。
 */
export async function findUnsummarizedGateFailure(db, { repoSlug, taskId }) {
  // 云端测试已关闭的仓：历史失败不再拦截推进
  if (await getRepoGateMode(db, repoSlug) === 'disabled') return null
  const group = await db.prepare(
    `SELECT g.run_group_id, g.status, s.finished_at
     FROM run_groups g
     JOIN test_submissions s ON s.submission_id = g.submission_id
     JOIN legacy_task_mappings m ON m.task_instance_id = s.task_instance_id
     JOIN repositories r ON r.repo_id = m.repo_id
     WHERE r.slug=? AND m.legacy_task_id=? AND g.kind='formal'
     ORDER BY g.created_at DESC LIMIT 1`
  ).get(repoSlug, taskId)
  if (!group || group.status !== 'failed' || !group.finished_at) return null
  // 纯考卷失败（归因后仍 suite）：错题本已自动入库，不强制沉淀开发经验
  try {
    const repo = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug)
    const { checks } = await loadRunGroupChecks(db, group.run_group_id)
    const attributed = await attributeSuiteChecks(db, { repoId: repo?.repo_id, bindingId: group.binding_id, checks })
    if (classifyRunChecks(attributed.checks, null).overall === 'suite') return null
  } catch {
    /* 归因不可用时按原逻辑（业务失败仍拦截） */
  }
  // experiences 表结构差异（如纯 testing 库的 v8 版无 task_id 列）时降级放行，不卡死流程
  try {
    const lesson = await db.prepare(
      'SELECT 1 FROM experiences WHERE task_id=? AND created_at > ? LIMIT 1'
    ).get(taskId, group.finished_at)
    return lesson ? null : group
  } catch {
    return null
  }
}

/** AC 校验：结构合法（1..20 条，id 唯一，type 限 ui/contract/data，text 须为可验证断言）。合法返回 null。 */
export function validateAcceptance(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > 20) return 'AC 清单须为 1~20 条'
  const ids = new Set()
  for (const a of list) {
    if (!a || typeof a !== 'object') return 'AC 项须为对象 {id, text, type}'
    if (!a.id || typeof a.id !== 'string' || !/^AC-\d{1,3}$/.test(a.id)) return `AC id 须形如 AC-1（收到：${JSON.stringify(a.id ?? null)}）`
    if (ids.has(a.id)) return `AC id 重复：${a.id}`
    ids.add(a.id)
    if (!a.text || typeof a.text !== 'string' || a.text.trim().length < 4) return `AC-${a.id} 的 text 须为可验证断言（≥4 字，禁止"页面正常"这类空话）`
    if (!['ui', 'contract', 'data'].includes(a.type)) return `AC-${a.id} 的 type 须为 ui/contract/data 之一`
  }
  return null
}

/**
 * 观测路径豁免（判定侧与注入侧对称）：
 * 注入侧 filterSpecsForSpecInject 在 scoped 模式下只把「考卷 pages ∩ 本次改动 ≠ ∅」的卷放进
 * binding assetLock；没被选中的卷根本没被 gate run 执行，不可能产出 mutation/f2p 结论——
 * 判定侧若仍要求它们的验卷结论，会形成确定性死锁（改动全是工程配置文件时 100% 复现：
 * assetLock 空 → report 无 test:spec check → ensureMutationRuns 无事可做 → f2p 永远 unknown）。
 * 以任务当前 active binding 的 assetLock 冻结清单为准（注入的最终事实，与真实执行一致；
 * inject_all_e2e=on 时清单全量，自然不排除）。
 * 排除边界：旧 binding（assetLock 上线前，全量注入语义）/ 无 active binding / 查询失败 →
 * 不排除（维持严格判定，宁可卡不可假放行）。
 */
/**
 * 变异验卷（暗卷）逐卷明细：把「覆盖任务 AC 且落在观测路径上的考卷 × 其最近一次 mutation run × 最近一次 f2p 判定」拼成可视化行。
 * 仅看板 by-task 视图按需调用（不在 harness_status 热路径）。返回：
 *   { total, verified, running, queued, specs:[ {featureKey,title,version,acRefs,mvVerified,runStatus,verdict,anchor,durationMs,startedAt,finishedAt} ] }
 */
export async function describeMutationVerification(db, { repoSlug, taskId }) {
  const out = { total: 0, verified: 0, running: 0, queued: 0, specs: [] }
  const repoId = (await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug))?.repo_id
  if (!repoId) return out
  let bindingId = null
  try {
    bindingId = (await db
      .prepare(
        `SELECT t.active_binding_id AS b FROM task_instances t
         JOIN repositories r ON r.repo_id = t.repo_id
         WHERE r.slug = ? AND t.external_task_id = ? ORDER BY t.epoch DESC LIMIT 1`
      )
      .get(repoSlug, taskId))?.b || null
  } catch {
    bindingId = null
  }
  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT feature_key, feature_title, version, mutation_verified, mutation_verdict, acceptance_refs_json, spec_type, side FROM test_specs
         WHERE repo_id = ? AND acceptance_refs_json IS NOT NULL
           AND ((review_status='active' AND (demand_ref IS NULL OR demand_ref = ?)) OR (review_status='draft' AND demand_ref = ?) OR (review_status='archived' AND demand_ref = ?))`
      )
      .all(repoId, taskId, taskId, taskId)
  } catch {
    return out
  }
  const byKey = new Map()
  for (const r of rows) {
    const prev = byKey.get(r.feature_key)
    if (!prev || Number(r.version) > Number(prev.version)) byKey.set(r.feature_key, r)
  }
  for (const r of byKey.values()) {
    // 观测路径外的考卷本轮门禁不注入、不可能有验卷结论 → 不进明细
    if (!await isSpecOnActiveBindingPath(db, { repoSlug, taskId, featureKey: r.feature_key })) continue
    // 注入盲区：卷在 assetLock 内但本门禁不跑其 smoke lane（如 size=S）→ 永不执行 → 不进明细（与 evaluateAcCoverage 判定侧一致）
    if (!await isSpecSmokeLaneScheduled(db, { repoSlug, taskId, specType: r.spec_type, side: r.side, bindingId })) continue
    const mv = Number(r.mutation_verified) === 1
    let run = null
    if (bindingId) {
      try {
        run = await db
          .prepare(
            `SELECT status, started_at, finished_at, total_ms, terminal_reason FROM test_runs
             WHERE binding_id = ? AND purpose = 'mutation' AND payload_json LIKE ? ORDER BY created_at DESC LIMIT 1`
          )
          .get(bindingId, `%"featureKey":"${r.feature_key}"%`)
      } catch {
        run = null
      }
    }
    let runStatus
    if (mv) runStatus = 'done'
    else if (run && (run.status === 'active' || run.status === 'running')) runStatus = 'running'
    else if (run && run.status === 'queued') runStatus = 'queued'
    else runStatus = 'pending'
    if (mv) out.verified += 1
    else if (runStatus === 'running') out.running += 1
    else if (runStatus === 'queued') out.queued += 1
    let f2p = null
    try {
      f2p = await db
        .prepare(
          `SELECT f2p_status, detail FROM spec_f2p_results WHERE repo_id = ? AND feature_key = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(repoId, r.feature_key)
    } catch {
      f2p = null
    }
    const det = String(f2p?.detail || '')
    const am = det.match(/@([^\s]+)\s+(\S+)->(\S+)/)
    const anchor = am ? `${String(am[1]).split('/').pop()} ${am[2]}→${am[3]}` : null
    let verdict = 'pending'
    if (mv) {
      if (/killed/.test(det) || f2p?.f2p_status === 'ok') verdict = 'killed'
      else if (/not-covered/.test(det)) verdict = 'not-covered'
      else if (/survived-cap-exempt/.test(det)) verdict = 'survived-cap'
      else if (f2p?.f2p_status === 'always_pass') verdict = 'weak'
      else verdict = 'exempt'
    }
    let acRefs = []
    try {
      acRefs = JSON.parse(r.acceptance_refs_json || '[]').map(String)
    } catch {
      acRefs = []
    }
    out.specs.push({
      featureKey: r.feature_key,
      title: r.feature_title || '',
      version: r.version,
      acRefs,
      mvVerified: mv ? 1 : 0,
      runStatus,
      verdict,
      anchor,
      durationMs: run?.total_ms ?? null,
      startedAt: run?.started_at || null,
      finishedAt: run?.finished_at || null,
    })
  }
  out.total = out.specs.length
  const rank = { running: 0, queued: 1, pending: 2, done: 3 }
  out.specs.sort((a, b) => (rank[a.runStatus] ?? 9) - (rank[b.runStatus] ?? 9) || String(a.featureKey).localeCompare(String(b.featureKey)))
  return out
}

export async function isSpecOnActiveBindingPath(db, { repoSlug, taskId, featureKey }) {
  if (!featureKey) return true
  try {
    const row = await db
      .prepare(
        `SELECT b.canonical_binding_json FROM test_bindings b
         JOIN task_instances t ON t.task_instance_id = b.task_instance_id
         JOIN repositories r ON r.repo_id = t.repo_id
         WHERE r.slug = ? AND t.external_task_id = ? AND t.active_binding_id = b.binding_id
         ORDER BY t.epoch DESC LIMIT 1`
      )
      .get(repoSlug, taskId)
    if (!row) return true // 无 active binding：未提交或旧数据，维持严格判定
    const lock = JSON.parse(row.canonical_binding_json || '{}')?.assetLock
    if (!lock || !Array.isArray(lock.specs)) return true // 旧 binding：全量注入语义
    return lock.specs.some((s) => s?.featureKey === featureKey)
  } catch {
    return true // 信息不足维持严格判定
  }
}

/**
 * 判定一张考卷本轮门禁是否真的会被执行到（从而可能产出 mutation/f2p 结论）。
 * 与 isSpecOnActiveBindingPath 互补：后者判「是否被注入 assetLock」，本函数判「注入后是否会被 smoke lane 执行」。
 *
 * 背景（2026-09-24 V267-4 死锁）：size=S 门禁 requiredUnits 恒为 ['static:na']（见 requiredUnitsForTask），
 * M 级非 UI type 也可能不跑 smoke；但 assetLock 仍可能冻结 e2e/smoke 考卷（覆盖 AC）。这类考卷被注入却
 * 永不被 smoke lane 执行 → gate run 报告无 test:spec/* check → ensureMutationRuns 永不触发 → mutation_verified
 * 恒为 0。若判定侧仍要求其验卷结论，即形成确定性死锁（判定要验卷、执行侧永不调度 smoke run）。
 *
 * 保守边界（维持严格、不豁免）：unit 卷在 static lane 执行 → true；side 未配置时无法定位 smoke 单元 → true；
 *   查询失败 → true。仅当「明确 e2e/smoke 卷 + 明确 side + 该 side 的 smoke 不在实际 requiredUnits」时 → false（豁免）。
 */
export async function isSpecSmokeLaneScheduled(db, { repoSlug, taskId, specType, side, bindingId = null }) {
  if (specType !== 'e2e' && specType !== 'smoke') return true // unit 等在 static lane 执行，与 smoke 无关
  if (!side || side === 'na') return true // side 未知无法定位 smoke 单元，保守维持严格
  try {
    // 优先用实际下单的 requiredUnits（run_groups 为权威事实）
    const actual = await unitsFromLastFormalGroup(db, { repoSlug, taskId, bindingId })
    if (Array.isArray(actual) && actual.length) return actual.includes(`smoke:${side}`)
    // 回退：按 size/type/sides 重算 requiredUnits
    const task = await db.prepare('SELECT size, type FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId)
    const size = task?.size || null
    // size=S：requiredUnitsForTask 恒返回 ['static:na']（与 sides 无关）→ 确定不跑 smoke → 豁免
    if (size === 'S') return false
    // size=M/L：是否含 smoke 取决于 resolvedSides；sides 未知（无 active binding）无法确定 → 保守维持严格
    if (size === 'M' || size === 'L') {
      const sides = bindingId ? await sidesFromBinding(db, bindingId) : null
      if (!Array.isArray(sides) || !sides.length) return true
      const units = requiredUnitsForTask({ size, type: task?.type || null, sides, changeKind: 'full' })
      return units.includes(`smoke:${side}`)
    }
    return true // size 未知/未分类 → 无法确定 requiredUnits → 保守维持严格判定
  } catch {
    return true // 信息不足维持严格判定
  }
}

/**
 * AC 覆盖率：任务冻结的 AC 清单 vs active 考卷的 acceptanceRefs。
 * 无 AC 清单 → { applicable:false }（S 级/未接 AC 的仓自然回落现状）。
 * 三重验卷状态（按覆盖 AC 且落在观测路径上的考卷聚合）：
 *   mutationPending：考卷尚未通过变异验卷（暗卷抓不到 = 废卷）
 *   f2pStatus：ok=有 F2P 有效证明 / pending=未验证 / bad=always_pass 等废卷 / none=覆盖卷全部豁免
 */
export async function evaluateAcCoverage(db, { repoSlug, taskId }) {
  let acs = []
  try {
    const task = await db.prepare('SELECT meta FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId)
    acs = JSON.parse(task?.meta || '{}')?.acceptance || []
  } catch {
    acs = []
  }
  if (!Array.isArray(acs) || !acs.length) {
    return { applicable: false, total: 0, missing: [], covered: [], mutationPending: false, f2pStatus: 'none' }
  }
  const repoId = (await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(repoSlug))?.repo_id
  // active binding：供 isSpecSmokeLaneScheduled 精确定位本轮实际 requiredUnits（run_groups）
  let activeBindingId = null
  try {
    activeBindingId = (await db
      .prepare(
        `SELECT t.active_binding_id AS b FROM task_instances t
         JOIN repositories r ON r.repo_id = t.repo_id
         WHERE r.slug = ? AND t.external_task_id = ? ORDER BY t.epoch DESC LIMIT 1`
      )
      .get(repoSlug, taskId))?.b || null
  } catch {
    activeBindingId = null
  }
  let rows = []
  try {
    rows = await db
      .prepare(
        `SELECT spec_id, feature_key, version, acceptance_refs_json, mutation_verified, spec_type, side FROM test_specs
         WHERE repo_id = ? AND acceptance_refs_json IS NOT NULL
           AND ((review_status='active' AND (demand_ref IS NULL OR demand_ref = ?)) OR (review_status='draft' AND demand_ref = ?) OR (review_status='archived' AND demand_ref = ?))`
      )
      .all(repoId, taskId, taskId, taskId)
  } catch {
    rows = []
  }
  // 版本漂移修复：同一 feature_key 可能同时有「被取代的 active 旧版」和「本任务 draft 新版」，
  // 旧版可能从未被本轮 binding 冻结/变异测到（mv=0）。只对生效版本（version 最大者）判验卷。
  {
    const byKey = new Map()
    for (const r of rows) {
      const prev = byKey.get(r.feature_key)
      if (!prev || Number(r.version) > Number(prev.version)) byKey.set(r.feature_key, r)
    }
    rows = [...byKey.values()]
  }
  const covered = new Set()
  let mutationPending = false
  let f2pBad = 0
  let f2pOkCount = 0
  let f2pUnknown = 0
  let f2pWarn = 0 // always_pass（等价/弱卷）：质量告警，不阻断闭环
  let exemptSurvivedCap = 0 // D：「疑似等价变异」豁免（未杀中达上限）——非真实杀中，需盖章留痕
  let exemptNotCovered = 0  // D：「改动行无可翻算子」豁免——同样非真实杀中
  const mutationExempt = [] // D：豁免通过的考卷清单 [{featureKey, kind}]，供看板/status 如实标注「非真杀中」
  const offPath = [] // 观测路径豁免的考卷：改动不在其 pages 上，本轮不要求验卷结论
  const offPathNoSmoke = [] // 注入盲区豁免：卷在 assetLock 内但本门禁不跑其 smoke lane（如 size=S），永不执行
  let mvTotal = 0
  let mvVerified = 0
  // v37：把「已放行」拆成「真杀中」与「豁免放行」。verdict 为 null = 老库数据未回填，按未区分处理。
  let mvVerifiedCaught = 0   // verdict='caught'：spec 真跑并抓住暗题——唯一算有效证明
  let mvVerifiedUnknown = 0 // verdict 未记录（v37 前的历史数据），计入 verified 但不计 caught
  for (const r of rows) {
    let refs = []
    try {
      refs = JSON.parse(r.acceptance_refs_json || '[]').map(String)
    } catch { /* 单条坏数据不阻断 */ }
    const hits = refs.filter((ref) => acs.some((a) => a.id === ref))
    for (const ref of hits) covered.add(ref)
    if (!hits.length) continue
    // 对称豁免：该卷不在 active binding 的注入清单内（改动不在其观测路径上）→
    // gate run 根本没执行它，不可能有验卷结论，不计入三重判定（见 isSpecOnActiveBindingPath）
    if (!await isSpecOnActiveBindingPath(db, { repoSlug, taskId, featureKey: r.feature_key })) {
      offPath.push(r.feature_key)
      continue
    }
    // 注入盲区豁免：该卷虽被冻结进 assetLock，但本任务门禁 requiredUnits 不含其 side 的 smoke 单元
    // （典型 size=S 只跑 static:na）→ e2e/smoke 卷永不被执行，不可能产出 mutation/f2p 结论；
    // 若仍要求 mutation_verified 会确定性死锁（判定要验卷、执行侧永不调度 smoke run）。
    if (!await isSpecSmokeLaneScheduled(db, { repoSlug, taskId, specType: r.spec_type, side: r.side, bindingId: activeBindingId })) {
      offPath.push(r.feature_key)
      offPathNoSmoke.push(r.feature_key)
      continue
    }
    mvTotal += 1
    if (Number(r.mutation_verified) === 1) {
      mvVerified += 1
      // v37：mutation_verified=1 含「豁免放行」语义（没造出变异 / 疑似等价变异）。
      // 只有 verdict='caught' 才是真正的「考卷抓住了暗题」证明；豁免的计入有效通过率会虚高。
      const verdict = r.mutation_verdict == null ? null : String(r.mutation_verdict)
      if (verdict === null) mvVerifiedUnknown += 1
      else if (verdict === 'caught') mvVerifiedCaught += 1
      else if (verdict === 'survived') mvVerified -= 1
      // not_applicable / exempt_equiv 留在 mvVerified 里表示「已放行」，但不进 mvVerifiedCaught
    } else mutationPending = true
    // F2P 状态：该考卷最近一次 f2p 判定
    try {
      const f2p = await db
        .prepare(
          `SELECT f2p_status, detail FROM spec_f2p_results
           WHERE repo_id = ? AND feature_key = ? ORDER BY created_at DESC LIMIT 1`
        )
        .get(repoId, r.feature_key)
      if (!f2p) f2pUnknown += 1
      else if (f2p.f2p_status === 'ok') f2pOkCount += 1
      else if (f2p.f2p_status === 'always_pass') f2pWarn += 1
      // R6：not_covered / survived-cap 豁免是「有结论的放行」→ warn 留痕不阻断；
      // 仅真 inconclusive（build/infra，无豁免 detail）保持 unknown→pending 等重验
      else if (f2p.f2p_status === 'skipped') {
        const det = String(f2p.detail || '')
        if (/^mutation survived-cap-exempt/.test(det)) { f2pWarn += 1; exemptSurvivedCap += 1; mutationExempt.push({ featureKey: r.feature_key, kind: 'survived-cap' }) }
        else if (/^mutation not-covered/.test(det)) { f2pWarn += 1; exemptNotCovered += 1; mutationExempt.push({ featureKey: r.feature_key, kind: 'not-covered' }) }
        else f2pUnknown += 1
      }
      else f2pBad += 1
    } catch {
      f2pUnknown += 1
    }
  }
  let mvRunning = 0
  let mvQueued = 0
  if (mvTotal > 0 && mvVerified < mvTotal) {
    try {
      const ab = (await db.prepare(`SELECT t.active_binding_id AS bid FROM task_instances t
         JOIN repositories r ON r.repo_id = t.repo_id
         WHERE r.slug = ? AND t.external_task_id = ? ORDER BY t.epoch DESC LIMIT 1`).get(repoSlug, taskId))?.bid
      if (ab) {
        for (const g of await db.prepare(`SELECT status, COUNT(*) AS c FROM test_runs WHERE binding_id = ? AND purpose = 'mutation' GROUP BY status`).all(ab)) {
          if (g.status === 'active' || g.status === 'running') mvRunning += g.c
          else if (g.status === 'queued') mvQueued += g.c
        }
      }
    } catch { /* progress best-effort */ }
  }

  const missing = acs.filter((a) => !covered.has(a.id)).map((a) => a.id)
  // F2P 聚合：无任何记录 → pending；有废卷 → bad；全部有效 → ok；部分有效 → pending（等全部）；
  // 覆盖 AC 的考卷全部被观测路径豁免（本轮无可验之卷）→ none（放行，见 isSpecOnActiveBindingPath）
  const f2pStatus = f2pBad > 0 ? 'bad' : f2pUnknown > 0 ? 'pending' : (f2pOkCount > 0 || f2pWarn > 0) ? 'ok' : offPath.length > 0 ? 'none' : 'pending'
  return {
    applicable: true,
    total: acs.length,
    missing,
    covered: [...covered],
    mutationPending,
    f2pStatus,
    f2pDetail: { ok: f2pOkCount, bad: f2pBad, unknown: f2pUnknown, warn: f2pWarn, exemptOffPath: offPath.length, exemptNoSmoke: offPathNoSmoke.length, exemptSurvivedCap, exemptNotCovered },
    mutation: {
      total: mvTotal,
      verified: mvVerified,
      // v37：verifiedCaught = 真正「杀中暗题」的卷数；verified − verifiedCaught 即豁免/未区分部分。
      // 汇报变异有效性时应优先看 verifiedCaught/total，否则通过率会被「没考也通过」抬高。
      verifiedCaught: mvVerifiedCaught,
      verifiedUnknown: mvVerifiedUnknown,
      running: mvRunning,
      queued: mvQueued,
    },
    mutationExempt,
    offPath,
    offPathNoSmoke,
  }
}

/**
 * AC 纪律判定（纯函数，供 harnessAdvance 与单测）：返回 null = 放行；否则 { code, blockedBy }。
 *  - M/L 任务进入 EXECUTE 前必须带 AC 清单（enforce_all/enforce_ml 仓）
 *      L 路径：PLAN → EXECUTE
 *      M/S 中路径：CLASSIFY → EXECUTE（v27 后与 L 对齐，堵住 M 跳过 PLAN 的缺口）
 *  - 进入 EXECUTE 后 AC 冻结：赛后改 AC → AC_FROZEN
 *  - 结构不合法 → AC_INVALID
 */
export function checkAcDiscipline({ phase, to, size, mode, metaAcceptance = null, acceptanceInput = null, snapshotFrozen = false }) {
  const from = phaseToActivity(phase)
  const target = phaseToActivity(to)
  const enteringExecute = target === 'execute' && from !== 'execute'
  if (acceptanceInput) {
    const invalid = validateAcceptance(acceptanceInput)
    if (invalid) return { code: 'AC_INVALID', blockedBy: [invalid] }
  }
  const frozen = Array.isArray(metaAcceptance) && metaAcceptance.length > 0
  const enforce = canonicalGateMode(mode) === 'enforce'
  if (enteringExecute && enforce && (size === 'M' || size === 'L')) {
    if (!acceptanceInput && !frozen) {
      return {
        code: 'AC_REQUIRED',
        blockedBy: [
          '进入 execute 前必须产出 AC：data.acceptance=[{id:"AC-1", text:"可验证断言", type:"ui|contract|data"}]。',
          '每条都要能变成测试断言。第一次产品快照之后不可再改。',
        ],
      }
    }
  }
  if (snapshotFrozen && acceptanceInput && frozen) {
    if (JSON.stringify(acceptanceInput) !== JSON.stringify(metaAcceptance)) {
      return {
        code: 'AC_FROZEN',
        blockedBy: ['AC 已在第一次产品快照时冻结，禁止再改。需求变了请开新任务。'],
      }
    }
  }
  return null
}

/** 供看板/状态查询：读任务冻结的 AC 清单 */
export async function getTaskAcceptance(db, { repoSlug, taskId }) {
  try {
    const task = await db.prepare('SELECT meta FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId)
    return JSON.parse(task?.meta || '{}')?.acceptance || []
  } catch {
    return []
  }
}

/**
 * 断言强度评分（纯函数）：对 spec 内容按断言类型打分。
 *   只查元素存在 = 1 分（弱）
 *   data-test 选择器 = +1
 *   接口断言（page.route / waitForResponse / fetch）= +2
 *   数据比较 / 状态断言 = +2
 *   空态 / 边界路径 = +1
 * 棘轮：基线只升不降。
 */
export function scoreAssertionStrength(content) {
  if (typeof content !== 'string') return 0
  let score = 0
  if (/waitForSelector|locator\(/.test(content)) score += 1
  if (/data-test/.test(content)) score += 1
  if (/page\.route|waitForResponse|fetch\(/.test(content)) score += 2
  if (/toBe\(|toEqual\(|toContain\(|toBeGreaterThan|toHaveLength/.test(content)) score += 2
  if (/Empty|empty|0\s*条|零条/.test(content)) score += 1
  return score
}
