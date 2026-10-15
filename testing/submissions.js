import { tableExists } from '../db/dialect-helpers.js'
import fs from 'node:fs'
import { ApiError, rejectUnknownFields } from './errors.js'

/** 每 run 的 infra 静默重试预算（首跑 + 重试次数-1）；DB CHECK 上限 3 */
export function defaultMaxAttempts(env = process.env) {
  const n = Number.parseInt(env.AWP_RUN_MAX_ATTEMPTS || '3', 10)
  if (!Number.isFinite(n)) return 3
  return Math.max(1, Math.min(3, n))
}
import { persistBinding, casSetActiveBinding } from './bindings.js'
import { SCHEMA_VERSION } from '../contracts/version.mjs'
import { uuidv7, utcNow } from './ids.js'
import { resolveMinimalSuitePlan } from './suite-plan.js'
import { lookupOpenTask } from './tasks.js'
import { requiredUnitsForTask, detectChangeKind, getRepoGateMode, preflightSubmissionAc } from '../harness/testing-gate.js'
import { canonicalizeChangedPaths } from './snapshots.js'
import { buildAssetLock, submissionSpecRows } from './asset-lock.js'
import { filterSpecsForSpecInject, getE2eInjectMode } from './test-specs.js'
import { recordAuditEvent } from '../audit/index.js'
import {
  ensureSubmissionGuardSchema, assertSourceReady, guardSubmissionEvidence,
  executableSpecs, submissionGuardError, readSubmissionReceipt,
} from './submission-guard.js'

export async function createTestSubmission(db, blobs, body, principal, { now = utcNow(), submissionSource = null, trigger = null } = {}) {
  rejectUnknownFields(body, [
    'clientRequestId', 'repoId', 'sourceRemoteId', 'branchIncarnationId',
    'taskInstanceId', 'expectedTaskRevision', 'git', 'bundle', 'suiteRequest', 'executionRequest',
  ])
  if (!body.clientRequestId || !body.repoId || !body.sourceRemoteId || !body.taskInstanceId) {
    throw new ApiError('INVALID_SCHEMA')
  }
  // PG int8 可能回字符串，先归一再校验
  body.expectedTaskRevision = Number(body.expectedTaskRevision)
  if (!Number.isInteger(body.expectedTaskRevision) || body.expectedTaskRevision < 1) {
    throw new ApiError('INVALID_SCHEMA')
  }
  rejectUnknownFields(body.git || {}, [
    'objectFormat', 'sourceRef', 'headCommitOid', 'snapshotCommitOid', 'snapshotTreeOid',
    'changedPathsSha256', 'targetRemoteId', 'targetRef', 'targetCommitOid', 'mr', 'changedFiles',
  ])
  rejectUnknownFields(body.bundle || {}, ['sha256', 'size'])
  rejectUnknownFields(body.suiteRequest || {}, ['mode', 'candidateRevisionIds', 'candidateApprovalIds'])
  rejectUnknownFields(body.executionRequest || {}, ['profile', 'side'])
  if (!body.git || !body.bundle || !body.suiteRequest || !body.executionRequest) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (body.suiteRequest.mode !== 'auto') throw new ApiError('INVALID_SCHEMA')
  const git = body.git
  if (!git.objectFormat || !git.sourceRef || !git.headCommitOid || !git.snapshotCommitOid
    || !git.snapshotTreeOid || !git.changedPathsSha256 || !git.targetRemoteId || !git.targetRef
    || !git.targetCommitOid || !Object.prototype.hasOwnProperty.call(git, 'mr')) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (!/^[a-f0-9]{64}$/.test(body.bundle.sha256) || !Number.isInteger(body.bundle.size) || body.bundle.size < 1) {
    throw new ApiError('INVALID_SCHEMA')
  }
  // eslint 基线 ratchet（v11）：提交时刻的改动文件清单，规范化（排序去重/路径合法性校验）后随快照入库
  let changedFilesJson = null
  if (git.changedFiles != null) {
    if (!Array.isArray(git.changedFiles) || git.changedFiles.length > 20000) throw new ApiError('INVALID_SCHEMA')
    changedFilesJson = JSON.stringify(canonicalizeChangedPaths(git.changedFiles).paths)
  }
  // 远程 blob store（备用机）：prepare/writeUpload 在主机端已做 sha256 强校验（fail-closed），
  // bundle 不在本机属预期；远程实现的 contentPath() 返回 null，若仍走本地存在性检查会恒抛 SNAPSHOT_HASH_MISMATCH。
  if (blobs.isRemote !== true) {
    const dest = blobs.contentPath(body.bundle.sha256)
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== body.bundle.size) {
      throw new ApiError('SNAPSHOT_HASH_MISMATCH')
    }
  }

  const sourceRemote = await db.prepare('SELECT * FROM git_remotes WHERE remote_id=?').get(body.sourceRemoteId)
  const targetRemote = await db.prepare('SELECT * FROM git_remotes WHERE remote_id=?').get(body.git.targetRemoteId)
  if (!sourceRemote || !targetRemote) throw new ApiError('UNRESOLVED_REMOTE')
  if (sourceRemote.repo_id !== body.repoId || targetRemote.repo_id !== body.repoId) {
    throw new ApiError('CROSS_REPO_REFERENCE')
  }

  const task = await lookupOpenTask(db, body.repoId, body.taskInstanceId)
  if (!task) throw new ApiError('INVALID_SCHEMA')
  if (task.revision !== body.expectedTaskRevision) throw new ApiError('TASK_REVISION_CONFLICT')

  const tx = async (tx) => {
    // CAS 前置复核：拒绝优先保持 revision=412，来源锁不能掩盖并发版本冲突。
    const current = await lookupOpenTask(tx, body.repoId, task.task_instance_id)
    if (!current || current.revision !== body.expectedTaskRevision) throw new ApiError('TASK_REVISION_CONFLICT')
    await assertSourceReady(tx, body.repoId, task.external_task_id)
    await ensureSubmissionGuardSchema(tx)
    const plan = await resolveMinimalSuitePlan(tx, {
      repoId: body.repoId,
      taskInstanceId: task.task_instance_id,
      branchIncarnationId: body.branchIncarnationId,
      changedPathsSha256: body.git.changedPathsSha256,
      requestedSide: body.executionRequest?.side || 'auto',
      changedFiles: body.git.changedFiles || null,
      now,
    })
    const snapshotId = uuidv7()
    await tx.prepare(
      `INSERT INTO business_snapshots(
         snapshot_id, repo_id, source_remote_id, branch_incarnation_id, snapshot_kind, object_format,
         source_ref, head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
         target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, changed_files_json, created_by, created_at
       ) VALUES (?, ?, ?, ?, 'dirty_workspace', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      snapshotId,
      body.repoId,
      body.sourceRemoteId,
      body.branchIncarnationId,
      body.git.objectFormat,
      body.git.sourceRef,
      body.git.headCommitOid,
      body.git.snapshotCommitOid,
      body.git.snapshotTreeOid,
      body.git.changedPathsSha256,
      body.git.targetRemoteId,
      body.git.targetRef,
      body.git.targetCommitOid,
      body.bundle.sha256,
      body.bundle.size,
      changedFilesJson,
      principal.principalId,
      now
    )
    const lock = JSON.parse(plan.canonical_lock_json)
    const image = await tx.prepare('SELECT manifest_sha256 FROM runner_images WHERE image_id=?').get(lock.runnerImageId)
    // 执行资产冻结：本次要跑的考卷（版本 + 内容 sha256）在提交时定死并进 bindingId，
    // 之后改卷/归档/换版本都不再影响已下单的 run（执行侧只按清单取内容）
    // 候选集与「门禁可执行考卷」同源（specsForGateInject：active + 本任务 draft + regression），
    // 并以 taskId 传入 filterSpecsForSpecInject 激活 draft 分支——否则本任务私有 draft 卷进不了
    // 冻结清单 → 跑不到 → 晋升不了 → 门禁永远判 AC_ALL_OFFPATH（归因死锁）。
    const repoSlug = (await tx.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(body.repoId))?.slug || ''
    const selectedSpecs = filterSpecsForSpecInject(await submissionSpecRows(tx, body.repoId, task.external_task_id), {
      changedFiles: body.git.changedFiles || null,
      mode: await getE2eInjectMode(tx, repoSlug),
      taskId: task.external_task_id,
    })
    const assetLock = buildAssetLock(selectedSpecs)
    const document = {
      schemaVersion: SCHEMA_VERSION,
      repoId: body.repoId,
      sourceRemoteId: body.sourceRemoteId,
      branchIncarnationId: body.branchIncarnationId,
      taskInstanceId: task.task_instance_id,
      headCommitOid: body.git.headCommitOid,
      snapshotTreeOid: body.git.snapshotTreeOid,
      changedPathsSha256: body.git.changedPathsSha256,
      targetRemoteId: body.git.targetRemoteId,
      targetRef: body.git.targetRef,
      targetCommitOid: body.git.targetCommitOid,
      suiteLockSha256: plan.lock_sha256,
      effectiveSuiteTreeOid: plan.effective_suite_tree_oid,
      executionProfileRevisionId: lock.executionProfileRevisionId,
      runnerImageId: lock.runnerImageId,
      runnerImageManifestSha256: image.manifest_sha256,
      policyRevisionId: plan.policy_revision_id,
      resolvedSides: JSON.parse(plan.resolved_sides_json),
      requiredCaseSetSha256: plan.required_case_set_sha256,
      assetLock,
      assetLockSha256: assetLock.sha256,
    }
    // 体量策略（防过量测试）：type 以服务端 tasks 表为准，不接受提交方自报；
    // tasks 表不存在（纯 testing 库/测试环境）时按无类型处理
    let harnessTask = null
    if (await tableExists(tx, 'tasks')) { // 方言感知(§2.8)
      harnessTask = await tx.prepare('SELECT * FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, task.external_task_id)
    }
    const legacyType = harnessTask?.type || null
    const size = ['S', 'M', 'L'].includes(harnessTask?.size) ? harnessTask.size : task.size
    const resolvedSides = JSON.parse(plan.resolved_sides_json || '[]')
    // 仅考卷刷新：产品树未变且上次 static 已绿 → 跳过 static，只跑 smoke（避免「测完又全量重测」）
    const changeKind = await detectChangeKind(tx, {
      repoSlug,
      taskId: task.external_task_id,
      snapshotTreeOid: body.git?.snapshotTreeOid || null,
      headCommitOid: body.git?.headCommitOid || null,
    })
    const units = requiredUnitsForTask({ size, type: legacyType, sides: resolvedSides, changeKind })
    if (!units.length) {
      throw new ApiError('UNITS_EMPTY', {
        detail: `size=${task.size || 'null'} type=${legacyType || 'null'} → requiredUnits 为空，无法下单。请先 CLASSIFY 设置 size（S/M/L）。`,
      })
    }
    const evidence = await guardSubmissionEvidence(tx, {
      task, document, plan, units, source: submissionSource, trigger, selectedSpecs,
      actor: principal.subject || principal.principalId,
    })
    const harnessMeta = JSON.parse(harnessTask?.meta || '{}')
    const ac = preflightSubmissionAc({
      mode: await getRepoGateMode(tx, repoSlug), size, taskId: task.external_task_id,
      acceptance: harnessMeta.acceptance || [],
      specs: executableSpecs(assetLock, units),
      nightly: harnessMeta.nightly === true,
    })
    if (!ac.ok) {
      const error = submissionGuardError('AC_COVERAGE_MISSING', `本轮选中且实际执行的考卷未覆盖：${ac.missing.join('、')}。请补齐 acceptanceRefs 后再提交。`)
      error.submissionContext = evidence.submissionContext
      throw error
    }
    const binding = await persistBinding(tx, { document, snapshotId, suitePlanId: plan.suite_plan_id, now })
    const cas = await casSetActiveBinding(tx, {
      taskInstanceId: task.task_instance_id, bindingId: binding.binding_id,
      expectedRevision: body.expectedTaskRevision, now,
    })
    const submissionId = uuidv7()
    await tx.prepare(
      `INSERT INTO test_submissions(
         submission_id, client_request_id, principal_id, repo_id, task_instance_id,
         binding_id, expected_task_revision, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`
    ).run(submissionId, body.clientRequestId, principal.principalId, body.repoId,
      task.task_instance_id, binding.binding_id, body.expectedTaskRevision, now)
    await tx.prepare(`INSERT INTO submission_receipts(submission_id, context_json, fingerprint_json, created_at)
      VALUES (?, ?, ?, ?)`)
      .run(submissionId, JSON.stringify(evidence.submissionContext), JSON.stringify(evidence.fingerprint), now)
    const runGroupId = uuidv7()
    const gateEligible = 1
    await tx.prepare(
      `INSERT INTO run_groups(
         run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
         required_units_json, status, created_at
       ) VALUES (?, ?, ?, ?, 'formal', ?, ?, 'queued', ?)`
    ).run(runGroupId, body.repoId, submissionId, binding.binding_id, gateEligible, JSON.stringify(units), now)
    for (const key of units) {
      const [unit, side] = key.split(':')
      // 快败：static 优先出队（priority 数值越小越先），static 挂了可少烧 smoke VM
      const priority = unit === 'static' ? 1 : 5
      await tx.prepare(
        `INSERT INTO test_runs(
           run_id, run_group_id, binding_id, repo_id, task_instance_id,
           unit, side, purpose, status, desired_state, max_attempts, priority, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'gate', 'queued', 'running', ?, ?, ?)`
      ).run(uuidv7(), runGroupId, binding.binding_id, body.repoId, task.task_instance_id, unit, side, defaultMaxAttempts(), priority, now)
    }
    return {
      submissionId,
      snapshotId,
      suitePlanId: plan.suite_plan_id,
      suiteLockSha256: plan.lock_sha256,
      bindingId: binding.binding_id,
      formalRunGroupId: runGroupId,
      candidateRunGroupId: null,
      taskRevision: cas.revision,
      status: 'queued',
      changeKind,
      requiredUnits: units,
      submissionContext: evidence.submissionContext,
    }
  }
  try {
    const result = await db.tx(tx)
    if (!submissionSource) {
      await recordAuditEvent({ eventType: 'submit', toolName: 'createTestSubmission', method: 'REST',
        repo: (await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(body.repoId))?.slug,
        taskId: task.external_task_id, author: principal.subject || principal.principalId,
        status: 'ok', submissionId: result.submissionId, bindingId: result.bindingId,
        payload: { submissionContext: result.submissionContext },
      })
    }
    return result
  } catch (error) {
    if (!submissionSource) {
      await recordAuditEvent({ eventType: 'submit_failed', toolName: 'createTestSubmission', method: 'REST',
        repo: (await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(body.repoId))?.slug,
        taskId: task.external_task_id, author: principal.subject || principal.principalId, status: 'error',
        detail: error.code || 'INVALID_SCHEMA',
        payload: { code: error.code || null, submissionContext: error.submissionContext || null },
      })
    }
    throw error
  }
}

export async function getTestSubmission(db, submissionId) {
  const row = await db.prepare('SELECT * FROM test_submissions WHERE submission_id=?').get(submissionId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  const group = await db.prepare(
    `SELECT run_group_id FROM run_groups WHERE submission_id=? AND kind='formal'`
  ).get(submissionId)
  const plan = await db.prepare(
    `SELECT suite_plan_id, lock_sha256 FROM suite_plans
     WHERE suite_plan_id=(SELECT suite_plan_id FROM test_bindings WHERE binding_id=?)`
  ).get(row.binding_id)
  const task = await db.prepare('SELECT revision FROM task_instances WHERE task_instance_id=?').get(row.task_instance_id)
  return {
    submissionId: row.submission_id,
    snapshotId: (await db.prepare('SELECT snapshot_id FROM test_bindings WHERE binding_id=?').get(row.binding_id)).snapshot_id,
    suitePlanId: plan.suite_plan_id,
    suiteLockSha256: plan.lock_sha256,
    bindingId: row.binding_id,
    formalRunGroupId: group ? group.run_group_id : null,
    candidateRunGroupId: null,
    taskRevision: task.revision,
    status: row.status,
    submissionContext: await readSubmissionReceipt(db, submissionId),
  }
}
