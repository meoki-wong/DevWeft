import { tableExists } from '../db/dialect-helpers.js'
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { documentSha256 } from '../contracts/version.mjs'
import { lockedCasesForRun } from './asset-lock.js'
import { loadRunGroupChecks, classifyRunChecks } from '../harness/loop.js'

/** 独立小表按需建表；不依赖审计成功，也不受 tasks.meta 合并或实例换代影响。 */
export async function ensureSubmissionGuardSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS submission_source_guards (
      repo_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      blocked INTEGER NOT NULL CHECK(blocked IN (0,1)), request_json TEXT NOT NULL,
      error_code TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(repo_id, task_id)
    );
    CREATE TABLE IF NOT EXISTS submission_receipts (
      submission_id TEXT PRIMARY KEY REFERENCES test_submissions(submission_id),
      context_json TEXT NOT NULL, fingerprint_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `)
}

export function submissionGuardError(code, detail) {
  const error = new ApiError(code, { detail })
  error.httpStatus = 409
  return error
}

/** 只保留诊断元信息，不保留 Git stderr、环境变量、凭据或远端 URL。 */
export function safeContextText(value) {
  if (value == null) return null
  return String(value).slice(0, 2000)
    .replace(/https?:\/\/[^\s]+/gi, '[redacted-url]')
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
}

export async function assertSourceReady(db, repoId, taskId) {
  const exists = await tableExists(db, 'submission_source_guards') // 方言感知(§2.8)
  if (!exists) return
  const row = await db.prepare('SELECT blocked FROM submission_source_guards WHERE repo_id=? AND task_id=?').get(repoId, taskId)
  if (row?.blocked) {
    throw submissionGuardError('SOURCE_TARGET_REQUIRED', '此前显式版本同步未成功。必须再次显式指定 sourceRef/codeCommitOid 并成功验证；禁止省略目标回落默认工作区。')
  }
}

export async function beginSourceAttempt(db, { repoId, taskId, requestedRef, requestedCommitOid }) {
  if (!requestedRef && !requestedCommitOid) {
    await assertSourceReady(db, repoId, taskId)
    return null
  }
  await ensureSubmissionGuardSchema(db)
  const attemptId = uuidv7()
  // 先锁再同步：同步抛错、进程崩溃或重启都不能把失败目标遗忘。
  await db.prepare(`INSERT INTO submission_source_guards
    (repo_id, task_id, attempt_id, blocked, request_json, error_code, updated_at)
    VALUES (?, ?, ?, 1, ?, NULL, ?)
    ON CONFLICT(repo_id, task_id) DO UPDATE SET attempt_id=excluded.attempt_id,
      blocked=1, request_json=excluded.request_json, error_code=NULL, updated_at=excluded.updated_at`)
    .run(repoId, taskId, attemptId, JSON.stringify({
      requestedRef: safeContextText(requestedRef), requestedCommitOid: safeContextText(requestedCommitOid),
    }), utcNow())
  return attemptId
}

export async function failSourceAttempt(db, { repoId, taskId, attemptId, code }) {
  if (!attemptId) return
  await db.prepare(`UPDATE submission_source_guards SET error_code=?, updated_at=?
    WHERE repo_id=? AND task_id=? AND attempt_id=? AND blocked=1`)
    .run(/^[A-Z_]+$/.test(code || '') ? code : 'SOURCE_SYNC_FAILED', utcNow(), repoId, taskId, attemptId)
}

export async function completeSourceAttempt(db, { repoId, taskId, attemptId, headCommitOid, expectedHead }) {
  if (!attemptId) return
  if (!headCommitOid || !expectedHead || headCommitOid !== expectedHead) {
    throw submissionGuardError('SOURCE_SNAPSHOT_MISMATCH', '同步目标与冻结快照的 HEAD 不一致，来源锁保持阻断。')
  }
  const updated = await db.prepare(`UPDATE submission_source_guards SET blocked=0, error_code=NULL, updated_at=?
    WHERE repo_id=? AND task_id=? AND attempt_id=? AND blocked=1`)
    .run(utcNow(), repoId, taskId, attemptId)
  if (updated.changes !== 1) throw submissionGuardError('SOURCE_ATTEMPT_SUPERSEDED', '版本同步已被新的请求取代，请重新显式提交目标。')
}

export async function readSubmissionReceipt(db, submissionId) {
  if (!(await tableExists(db, 'submission_receipts'))) return null // 方言感知(§2.8)
  const row = await db.prepare('SELECT context_json FROM submission_receipts WHERE submission_id=?').get(submissionId)
  return row ? JSON.parse(row.context_json) : null
}

export function executableSpecs(assetLock, units) {
  const specs = new Map()
  for (const key of units) {
    const [unit, side] = key.split(':')
    for (const spec of lockedCasesForRun(assetLock, { unit, side })) {
      specs.set(`${spec.specType}:${spec.featureKey}:${spec.version}`, spec)
    }
  }
  return [...specs.values()]
}

function specContent(spec) {
  return { specType: spec.specType, side: spec.side || null, entry: spec.entry, blobSha256: spec.blobSha256 }
}

function sortedSet(items) {
  return [...new Set(items.map((item) => documentSha256(item)))].sort()
}

/** 内容而非 HEAD/bundle/身份/版本号：这些变化本身不代表有新的执行证据。 */
export async function submissionFingerprint(db, { document, plan, units }) {
  const specs = executableSpecs(document.assetLock, units)
  const profile = await db.prepare('SELECT content_sha256 FROM execution_profile_revisions WHERE profile_revision_id=?')
    .get(document.executionProfileRevisionId)
  const policy = await db.prepare('SELECT content_sha256 FROM policy_revisions WHERE policy_revision_id=?')
    .get(document.policyRevisionId)
  const layers = await db.prepare('SELECT position, content_sha256 FROM suite_plan_layers WHERE suite_plan_id=? ORDER BY position')
    .all(plan.suite_plan_id)
  const lock = JSON.parse(plan.canonical_lock_json)
  return {
    productTree: document.snapshotTreeOid,
    specsSha256: documentSha256(sortedSet(specs.map(specContent))),
    configSha256: documentSha256({
      profile: profile?.content_sha256 || document.executionProfileRevisionId,
      policy: policy?.content_sha256 || document.policyRevisionId,
      runner: document.runnerImageManifestSha256,
      sides: [...(document.resolvedSides || [])].sort(), units: [...units].sort(),
      layers: layers.map((l) => l.content_sha256),
      cases: (lock.cases || []).map((c) => ({
        caseKey: c.caseKey, protected: c.protected, replacesCaseKey: c.replacesCaseKey,
      })),
      waivers: lock.waivers || [],
    }),
  }
}

function specChanges(previous, current) {
  const index = (specs) => new Map(specs.map((s) => [`${s.specType}:${s.featureKey}`, s]))
  const before = index(previous)
  const after = index(current)
  return {
    specsAdded: [...after.keys()].filter((key) => !before.has(key)).sort(),
    specsRemoved: [...before.keys()].filter((key) => !after.has(key)).sort(),
    specsUpdated: [...after.keys()].filter((key) => before.has(key)
      && documentSha256(specContent(before.get(key))) !== documentSha256(specContent(after.get(key)))).sort(),
  }
}

/** 混合失败不能因某个 infra terminal_reason 变成纯 infra 豁免。 */
async function isInfraOnly(db, groupId) {
  const { checks, terminalReason, runs } = await loadRunGroupChecks(db, groupId)
  const classified = classifyRunChecks(checks, null)
  if (classified.byCheck.some((c) => c.class !== 'infra')) return false
  if (runs.some((r) => r.terminal_reason === 'assertion_failed')) return false
  return classifyRunChecks(checks, terminalReason).overall === 'infra'
}

export async function guardSubmissionEvidence(db, { task, document, plan, units, source = null, trigger = null, actor = null, selectedSpecs = [] }) {
  const previous = await db.prepare(`SELECT s.submission_id, g.run_group_id, g.status,
      g.required_units_json, b.canonical_binding_json, b.suite_plan_id
    FROM test_submissions s JOIN task_instances t ON t.task_instance_id=s.task_instance_id
    JOIN run_groups g ON g.submission_id=s.submission_id AND g.kind='formal'
    JOIN test_bindings b ON b.binding_id=g.binding_id
    WHERE s.repo_id=? AND t.external_task_id=?
    ORDER BY s.created_at DESC, s.submission_id DESC LIMIT 1`).get(task.repo_id, task.external_task_id)
  const fingerprint = await submissionFingerprint(db, { document, plan, units })
  const previousDoc = previous ? JSON.parse(previous.canonical_binding_json) : null
  const previousUnits = previous ? JSON.parse(previous.required_units_json) : []
  const previousFingerprint = previousDoc?.assetLock ? await submissionFingerprint(db, {
    document: previousDoc,
    plan: await db.prepare('SELECT * FROM suite_plans WHERE suite_plan_id=?').get(previous.suite_plan_id),
    units: previousUnits,
  }) : null
  const changes = {
    productChanged: previousDoc ? previousDoc.snapshotTreeOid !== document.snapshotTreeOid : null,
    ...specChanges(executableSpecs(previousDoc?.assetLock, previousUnits), executableSpecs(document.assetLock, units)),
    configChanged: previousFingerprint ? previousFingerprint.configSha256 !== fingerprint.configSha256 : null,
  }
  const infraRetry = previous && ['failed', 'error'].includes(previous.status) && await isInfraOnly(db, previous.run_group_id)
  const kind = !previous ? 'initial' : changes.productChanged ? 'product-change'
    : changes.specsAdded.length || changes.specsUpdated.length || changes.specsRemoved.length ? 'spec-change'
      : changes.configChanged ? 'config-change' : infraRetry ? 'infra-retry' : 'resubmit'
  const context = {
    trigger: {
      kind, reason: safeContextText(trigger?.reason) || kind,
      actor: safeContextText(actor), previousSubmissionId: previous?.submission_id || null,
    },
    source: {
      workspacePath: safeContextText(source?.workspacePath),
      requestedRef: safeContextText(source?.requestedRef),
      requestedCommitOid: safeContextText(source?.requestedCommitOid),
      headCommitOid: document.headCommitOid, snapshotTreeOid: document.snapshotTreeOid,
      dirty: source?.verified === true ? Boolean(source.dirty) : null,
      verified: source?.verified === true,
      provenance: source?.verified === true ? 'server-workspace' : 'client-declared',
      // 跨机器 diff 送测回执：base 如何解析、上传 diff 的指纹与应用文件数（不含原始 diff）
      baseVia: source?.baseVia || null,
      codeDiffSha256: source?.codeDiffSha256 || null,
      appliedFileCount: Number.isFinite(source?.appliedFileCount) ? source.appliedFileCount : null,
    },
    changes,
    specCommitDeclarations: selectedSpecs.filter((s) => s.code_commit_oid).map((s) => ({
      featureKey: s.feature_key, version: s.version, declaredCommitOid: safeContextText(s.code_commit_oid),
      currentTask: s.demand_ref === task.external_task_id,
      verified: false,
      comparison: source?.verified !== true ? 'unverified'
        : /^[a-f0-9]{40,64}$/i.test(s.code_commit_oid)
          ? s.code_commit_oid.toLowerCase() === document.headCommitOid.toLowerCase() ? 'matches-head' : 'conflict'
          : 'unverified',
    })),
  }
  if (previousFingerprint && ['failed', 'error'].includes(previous.status) && !infraRetry
    && documentSha256(previousFingerprint) === documentSha256(fingerprint)) {
    const error = submissionGuardError('NO_NEW_EVIDENCE', '业务 tree、执行考卷内容及执行配置均与上一失败轮相同；HEAD、bundle 或考卷版本号变化不能作为新证据。')
    error.submissionContext = context
    throw error
  }
  return { submissionContext: context, fingerprint }
}
