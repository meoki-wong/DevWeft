/**
 * testing/submit-run.js — 云端门禁下单公共逻辑
 *
 * MCP 工具 awp_test_run（tools/test-run.js）与 CLI scripts/submit-m-task.mjs 共用，
 * 防两份逻辑漂移。流程：
 *   resolve configured workspace → snapshot changes and bundle → upload blobs → ensure task instance (idempotent)
 *   → createTestSubmission（体量策略在 submissions.js 内生效）→ 清理快照临时目录
 *
 * 体量/类型一律以服务端 tasks 表为准（防 AI 虚报）；无 harness 记录时回落 M。
 * 备用机（AWP_STANDBY=1）提交时，bundle 通过 HTTP 上传到主机的 blob 存储（解决主机 worker 找不到的问题）。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBlobStoreForEnv as createBlobStoreForEnvImpl, resolveBlobUploadBase } from './blob-store-env.js'
import { createTestSubmission } from './submissions.js'
import { lookupOpenTask } from './tasks.js'
import { createPrincipal } from './auth.js'
import { uuidv7, utcNow } from './ids.js'
import { nextGateLoopIteration } from '../harness/loop.js'
import { recordAuditEvent } from '../audit/index.js'
import {
  buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp, resolveTaskChangedFiles,
  prefetchOrigin, ensurePristineWorkspace, alignWorkspaceBase, applyWorkspaceDiff,
} from './snapshots.js'
import {
  beginSourceAttempt, completeSourceAttempt, failSourceAttempt, submissionGuardError, safeContextText,
} from './submission-guard.js'
import { DEFAULT_REPO, resolveRepoWorkspacePath, getRepoPlatformProfile, withDeployWorkspaceEnv } from './repo-platform.js'
import { isStandbyControlPlane } from '../db/standby.js'
import { recordDeferredSubmission } from './deferred.js'
import { worktreeIsolationEnabled, createIsolatedWorktree, releaseIsolatedWorktree, deferredApplyCheckEnabled, assertDiffParseable } from './workspace-pool.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function getGateLoopIteration(db, repoSlug, taskId) {
  try {
    const row = await db.prepare('SELECT iteration FROM gate_loops WHERE repo=? AND task_id=?').get(repoSlug, taskId)
    return row?.iteration ?? 0
  } catch {
    return 0
  }
}

/** harness tasks 表查询（体量/类型/任务起点唯一真相）；表不存在（纯 testing 库/测试环境）时回落 null */
async function lookupHarnessTask(db, repoSlug, taskId) {
  try {
    return await db.prepare('SELECT size, type, meta FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId) || null
  } catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) {
      if (/no such table/i.test(String(e?.message || e))) return null
      throw e
    }
    try {
      return await db.prepare('SELECT size, type FROM tasks WHERE repo=? AND task_id=?').get(repoSlug, taskId) || null
    } catch (e2) {
      if (/no such table|no such column/i.test(String(e2?.message || e2))) return null
      throw e2
    }
  }
}

/** 从 tasks.meta 解析 harness_start 记下的任务起点 HEAD */
function parseStartHeadOid(metaField) {
  try {
    const meta =
      typeof metaField === 'string'
        ? JSON.parse(metaField || '{}')
        : metaField && typeof metaField === 'object'
          ? metaField
          : {}
    const oid = meta?.startHeadOid
    return typeof oid === 'string' && /^[a-f0-9]{7,40}$/i.test(oid) ? oid : null
  } catch {
    return null
  }
}

// 备用机/主机 blob 存储决策与地址解析已抽到 testing/blob-store-env.js（与 test-specs 共用，避免循环依赖）。
// re-export 保持既有调用方（含单测）从 submit-run 导入的兼容性。
export { resolveBlobUploadBase }
const createBlobStoreForEnv = createBlobStoreForEnvImpl

/**
 * 确保门禁 task_instance 存在（幂等：同 external_task_id 复用 open 实例）。
 * size 以 harness tasks 表记录为准；仅有已关闭实例时 epoch 递增开新实例。
 */
export async function ensureGateTaskInstance(db, {
  repoId,
  repoSlug,
  taskId,
  principalId,
  now = utcNow(),
}) {
  const existing = await lookupOpenTask(db, repoId, taskId)
  if (existing) {
    // 旧实例可能在 CLASSIFY 前建（mapLegacyTasks）导致 size=NULL：
    // units 算成 [] → 0 条 run → submission 永远 queued。用 harness tasks 表补齐。
    if (!existing.size) {
      const ht = await lookupHarnessTask(db, repoSlug, taskId)
      const size = ht?.size === 'S' || ht?.size === 'M' || ht?.size === 'L' ? ht.size : null
      if (size) {
        await db.prepare('UPDATE task_instances SET size=?, updated_at=? WHERE task_instance_id=?')
          .run(size, now, existing.task_instance_id)
        existing.size = size
      }
    }
    return { task: existing, created: false }
  }
  const harnessTask = await lookupHarnessTask(db, repoSlug, taskId)
  const maxEpoch = (await db
    .prepare('SELECT COALESCE(MAX(epoch),0) AS e FROM task_instances WHERE repo_id=? AND external_task_id=?')
    .get(repoId, taskId)).e
  const taskInstanceId = uuidv7()
  await db.prepare(
    `INSERT INTO task_instances(
       task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type, status,
       author_principal_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'EXECUTE', ?, ?, 'open', ?, ?, ?)`
  ).run(
    taskInstanceId, repoId, taskId, maxEpoch + 1,
    harnessTask?.size || 'M', harnessTask?.type || null, principalId, now, now
  )
  // UPSERT：重新打开（旧实例已关闭）时映射指向新实例，否则门禁评估查到 closed 实例永远 BINDING_STALE
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(repo_id, legacy_task_id)
     DO UPDATE SET task_instance_id=excluded.task_instance_id, migrated_at=excluded.migrated_at`
  ).run(repoId, taskId, taskInstanceId, now)
  return { task: await lookupOpenTask(db, repoId, taskId), created: true }
}

/**
 * 提交一次云端门禁 run（多仓：按 repoSlug 解析工作区，互不干扰）。
 * @returns {Promise<{submissionId, bindingId, expectedTaskRevision, requiredUnits, runs, taskInstanceCreated, workspacePath, repoSlug}>}
 */
export async function submitGateRun(db, {
  taskId,
  author,
  side = 'auto',
  sideReason = null,
  repoSlug = DEFAULT_REPO,
  workspacePath = null,
  sourceRef = null,
  codeCommitOid = null,
  codeDiff = null,
  triggerReason = null,
  forceLocalSnapshot = false,
  env = process.env,
}) {
  if (!taskId || !author) throw new Error('INVALID_SCHEMA: taskId/author 必填')
  const repo = await db.prepare('SELECT repo_id, slug FROM repositories WHERE slug=?').get(repoSlug)
  if (!repo) throw new Error(`UNRESOLVED_REPO: ${repoSlug}`)

  // ── 备用机（standby）不本地做云端快照：把 codeDiff 落 deferred_submissions，
  //    由主机 worker 使用配置的 repository workspace 生成 submission；跨机执行不依赖其他节点的本地仓库状态。
  //    见 testing/deferred.js + 主备切换方案 A。───
  if (isStandbyControlPlane() && !forceLocalSnapshot) {
    if (typeof codeDiff !== 'string' || !codeDiff.trim()) {
      throw new Error('STANDBY_REQUIRES_DIFF: 备用机不接受无 diff 的下单（本地快照路径已在 standby 下禁用）')
    }
    // P1-A：落表前即时结构预校验——corrupt/截断补丁立即拒绝，不再伪装成 DEFERRED 成功后延迟到主机 drain 才失败
    if (deferredApplyCheckEnabled()) assertDiffParseable(codeDiff)
    const rec = await recordDeferredSubmission(db, {
      repoId: repo.repo_id,
      taskId,
      author,
      side,
      sideReason,
      sourceRef,
      codeCommitOid,
      codeDiff,
      triggerReason,
    })
    await recordAuditEvent({
      eventType: 'submit_deferred',
      toolName: 'submitGateRun',
      method: 'internal',
      repo: repoSlug,
      taskId,
      author,
      status: 'ok',
      detail: `deferred ${rec.deferredId.slice(0, 8)} ${rec.created ? 'created' : 'reused'} status=${rec.status}`,
      payload: {
        deferredId: rec.deferredId,
        clientRequestId: rec.clientRequestId,
        created: rec.created,
        status: rec.status,
        codeCommitOid: codeCommitOid || null,
        diffBytes: codeDiff.length,
        side,
        triggerReason: triggerReason || null,
      },
    })
    process.stdout.write(`[gate] standby deferred submission queued: ${rec.deferredId} (status=${rec.status})\n`)
    return {
      deferred: true,
      deferredId: rec.deferredId,
      deferredStatus: rec.status,
      clientRequestId: rec.clientRequestId,
      submissionId: null,
      bindingId: null,
      expectedTaskRevision: null,
      requiredUnits: [],
      repoSlug,
      taskId,
      author,
      side,
    }
  }

  let snap = null
  let attemptId = null
  let submissionSource = null
  let isoPath = null
  let isoMainPath = null
  let resolvedWorkspace = workspacePath || null
  try {
    attemptId = await beginSourceAttempt(db, { repoId: repo.repo_id, taskId,
      requestedRef: sourceRef, requestedCommitOid: codeCommitOid })
    const envMerged = withDeployWorkspaceEnv(env)

    // Resolve only this repository's configured workspace.
    if (!resolvedWorkspace) {
      resolvedWorkspace = resolveRepoWorkspacePath(repoSlug, { env: envMerged, repoRoot })
    }
    if (!resolvedWorkspace) {
      const profile = getRepoPlatformProfile(repoSlug, { env: envMerged })
      if (!profile) {
        throw new Error(
          `UNCONFIGURED_REPO: ${repoSlug} 未在 data/repo-platform.json 配置，也未设置 AWP_REPO_PATH_*。` +
            `No implicit workspace fallback is configured. See data/repo-platform.example.json.`
        )
      }
      throw new Error(
        `WORKSPACE_NOT_FOUND: ${repoSlug} 工作区不存在。请设置 ${profile.workspaceEnv || 'AWP_REPO_PATH_*'} 或配置 workspacePath`
      )
    }

    const remote = await db.prepare(
      'SELECT remote_id, repo_id FROM git_remotes WHERE repo_id=? AND enabled=1 ORDER BY created_at LIMIT 1'
    ).get(repo.repo_id)
    if (!remote) throw new Error(`UNRESOLVED_REMOTE: 控制面没有登记 ${repoSlug} 的 git remote`)

    const principalId = await createPrincipal(db, { subject: author, displayName: author })
    const { task, created } = await ensureGateTaskInstance(db, {
      repoId: repo.repo_id, repoSlug, taskId, principalId,
    })

    // 对齐声明的 base（分支/commit），并（跨机器时）应用 AI 上传的 diff。
    // 复用 syncWorkspaceToRef 做 fetch/checkout；alignWorkspaceBase 提供 baseSha→branch→默认分支回退链。
    const hasDiff = typeof codeDiff === 'string' && codeDiff.trim().length > 0
    let workspaceSync = null
    let diffReceipt = null
    let prefetch = null
    const isolateWs = worktreeIsolationEnabled() && (hasDiff || sourceRef || codeCommitOid)
    if (isolateWs) {
      // P0-1：在 base commit 的隔离 detached worktree 上 checkout/apply/snapshot，主工作树零改动。
      const prep = createIsolatedWorktree({
        repoMainPath: resolvedWorkspace, baseSha: codeCommitOid, branch: sourceRef, fallbackToDefault: hasDiff,
      })
      isoMainPath = resolvedWorkspace
      isoPath = prep.isoPath
      prefetch = prep.prefetch
      workspaceSync = prep.workspaceSync
      resolvedWorkspace = isoPath
      process.stdout.write(
        `workspace sync[isolated-worktree]: ${safeContextText(workspaceSync.detail)}` +
        (workspaceSync.head ? ` head=${String(workspaceSync.head).slice(0, 12)}` : '') +
        (workspaceSync.baseVia ? ` via=${workspaceSync.baseVia}` : '') + '\n'
      )
      await recordAuditEvent({
        eventType: 'workspace_sync', toolName: 'submitGateRun', method: 'internal',
        repo: repoSlug, taskId, author,
        status: workspaceSync.ok === false ? 'error' : 'ok',
        detail: safeContextText(workspaceSync.detail),
        payload: { sourceRef: safeContextText(sourceRef), codeCommitOid: safeContextText(codeCommitOid),
          head: workspaceSync.head || null, stashRef: null, isolated: true,
          baseVia: workspaceSync.baseVia || null, prefetch: prefetch ? safeContextText(prefetch.detail) : null },
      })
    } else {
    if (hasDiff) {
      // 用户约定：每次下单先 pull 刷新远端 refs；再复位工作树，保证 base 纯净、清除上一轮 diff 残留。
      prefetch = prefetchOrigin(resolvedWorkspace)
      ensurePristineWorkspace(resolvedWorkspace)
    }
    if (sourceRef || codeCommitOid || hasDiff) {
      workspaceSync = alignWorkspaceBase(resolvedWorkspace, {
        baseSha: codeCommitOid, branch: sourceRef, fallbackToDefault: hasDiff,
      })
      process.stdout.write(
        `workspace sync: ${safeContextText(workspaceSync.detail)}` +
        (workspaceSync.head ? ` head=${String(workspaceSync.head).slice(0, 12)}` : '') +
        (workspaceSync.baseVia ? ` via=${workspaceSync.baseVia}` : '') + '\n'
      )
      await recordAuditEvent({
        eventType: 'workspace_sync',
        toolName: 'submitGateRun',
        method: 'internal',
        repo: repoSlug,
        taskId,
        author,
        status: workspaceSync.ok === false ? 'error' : 'ok',
        detail: safeContextText(workspaceSync.detail),
        payload: { sourceRef: safeContextText(sourceRef), codeCommitOid: safeContextText(codeCommitOid),
          head: workspaceSync.head || null, stashRef: workspaceSync.stashRef || null,
          baseVia: workspaceSync.baseVia || null, prefetch: prefetch ? safeContextText(prefetch.detail) : null },
      })
    }
    }

    if (attemptId && (!workspaceSync?.head || workspaceSync.ok === false)) {
      throw submissionGuardError('SOURCE_SYNC_FAILED', '显式版本同步未成功，不允许继续冻结默认工作区。')
    }
    if (hasDiff) {
      // 把 AI 的未提交改动盖到已对齐的 base 工作树上；随后 buildDirtyWorkspaceSnapshot 冻结为「base + diff」。
      diffReceipt = applyWorkspaceDiff(resolvedWorkspace, codeDiff)
      await recordAuditEvent({
        eventType: 'diff_applied',
        toolName: 'submitGateRun',
        method: 'internal',
        repo: repoSlug,
        taskId,
        author,
        status: 'ok',
        detail: `applied ${diffReceipt.fileCount} file(s) on base ${String(workspaceSync?.head || '').slice(0, 12)}`,
        // 只存指纹与文件清单，绝不存原始 diff（可能含大段代码/凭据）
        payload: { diffSha256: diffReceipt.diffSha256, fileCount: diffReceipt.fileCount,
          appliedPaths: diffReceipt.appliedPaths.slice(0, 200).map((p) => safeContextText(p)),
          baseVia: workspaceSync?.baseVia || null },
      })
    }
    snap = buildDirtyWorkspaceSnapshot(resolvedWorkspace, { withBundle: true })
    resolvedWorkspace = snap.workspacePath
    submissionSource = {
      workspacePath: snap.workspacePath, requestedRef: sourceRef, requestedCommitOid: codeCommitOid,
      headCommitOid: snap.headCommitOid, snapshotTreeOid: snap.snapshotTreeOid, dirty: snap.dirty, verified: true,
      baseVia: workspaceSync?.baseVia || null,
      codeDiffSha256: diffReceipt?.diffSha256 || null,
      appliedFileCount: diffReceipt ? diffReceipt.fileCount : null,
    }
    await completeSourceAttempt(db, { repoId: repo.repo_id, taskId, attemptId,
      headCommitOid: snap.headCommitOid, expectedHead: workspaceSync?.head })
    const changedFilesRes = resolveTaskChangedFiles(resolvedWorkspace, snap.changedPaths, {
      startHeadOid: parseStartHeadOid((await lookupHarnessTask(db, repoSlug, taskId))?.meta),
    })
    // 备用机使用远程 blob 存储（HTTP 上传到主机），主机使用本地
    const blobs = await createBlobStoreForEnv(db)
    const bundleBuf = readFileSync(snap.bundlePath)
    // 远程模式下 prepare 是异步的，本地模式是同步的（兼容两者）
    const prep = await blobs.prepare({ kind: 'git-bundle', sha256: snap.bundleSha256, size: snap.bundleSize })
    if (prep.uploadId) await blobs.writeUpload(prep.uploadId, bundleBuf)
    const createdSubmission = await createTestSubmission(db, blobs, {
      clientRequestId: uuidv7(),
      repoId: repo.repo_id,
      sourceRemoteId: remote.remote_id,
      branchIncarnationId: null,
      taskInstanceId: taskId,
      expectedTaskRevision: task.revision,
      git: {
        objectFormat: 'sha1',
        sourceRef: snap.sourceRef,
        headCommitOid: snap.headCommitOid,
        snapshotCommitOid: snap.snapshotCommitOid,
        snapshotTreeOid: snap.snapshotTreeOid,
        changedPathsSha256: snap.changedPathsSha256,
        // 任务边界归因：dirty ∪ diff(startHeadOid, HEAD)；纯脏任务不把 HEAD 上无关提交算进来
        changedFiles: changedFilesRes.paths,
        targetRemoteId: remote.remote_id,
        targetRef: 'refs/heads/stage',
        targetCommitOid: snap.headCommitOid,
      },
      bundle: { sha256: snap.bundleSha256, size: snap.bundleSize },
      suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
      executionRequest: { profile: 'auto', side },
    }, { principalId, subject: author }, { submissionSource, trigger: { reason: triggerReason } })
    if (sideReason) {
      process.stdout.write(`gate side=${side} reason=${String(sideReason).slice(0, 120)}\n`)
    }
    const runs = await db.prepare(
      'SELECT run_id, unit, side, status FROM test_runs WHERE run_group_id=? ORDER BY unit, side'
    ).all(createdSubmission.formalRunGroupId)
    await recordAuditEvent({
      eventType: 'submit',
      toolName: 'submitGateRun',
      method: 'internal',
      repo: repoSlug,
      taskId,
      author,
      status: 'ok',
      submissionId: createdSubmission.submissionId,
      bindingId: createdSubmission.bindingId,
      detail: `submission ${createdSubmission.submissionId.slice(0, 12)} units=${runs.length}`,
      payload: {
        submissionContext: createdSubmission.submissionContext,
        snapshotTreeOid: snap.snapshotTreeOid,
        changedPathsSha256: snap.changedPathsSha256,
        bundleSha256: snap.bundleSha256,
        changedFileCount: changedFilesRes.provenance.totalCount,
        changedFilesProvenance: changedFilesRes.provenance,
        runs: runs.map((r) => `${r.unit}:${r.side}`),
        changeKind: createdSubmission.changeKind || 'full',
        requiredUnits: createdSubmission.requiredUnits || null,
      },
    })
    if (createdSubmission.changeKind === 'spec-only') {
      process.stdout.write(
        `[gate] spec-only：产品树未变且上次 static 已绿 → 跳过 static，units=${JSON.stringify(createdSubmission.requiredUnits)}\n`
      )
    }
    return {
      submissionId: createdSubmission.submissionId,
      bindingId: createdSubmission.bindingId,
      expectedTaskRevision: createdSubmission.taskRevision,
      // 以实际创建的 run 为准（AI 声明的 side 已体现在 suite plan / runs）
      requiredUnits: runs.map((r) => `${r.unit}:${r.side}`),
      changeKind: createdSubmission.changeKind || 'full',
      side,
      sideReason,
      size: task.size,
      // 迭代豁免：上次失败若为纯考卷问题（suite），本次重考不烧迭代上限
      iteration: (await nextGateLoopIteration(db, { repoSlug, taskId })).next,
      runs,
      taskInstanceCreated: created,
      workspacePath: resolvedWorkspace,
      repoSlug,
      workspaceSync,
      submissionContext: createdSubmission.submissionContext,
    }
  } catch (err) {
    await failSourceAttempt(db, { repoId: repo.repo_id, taskId, attemptId, code: err.code })
    await recordAuditEvent({
      eventType: 'submit_failed',
      toolName: 'submitGateRun',
      method: 'internal',
      repo: repoSlug,
      taskId,
      author,
      status: 'error',
      detail: err.code || 'SUBMIT_FAILED',
      payload: { code: err.code || null, submissionContext: err.submissionContext || {
        trigger: { kind: 'source-rejected', reason: safeContextText(triggerReason), actor: safeContextText(author), previousSubmissionId: null },
        source: { workspacePath: safeContextText(submissionSource?.workspacePath),
          requestedRef: safeContextText(sourceRef), requestedCommitOid: safeContextText(codeCommitOid),
          headCommitOid: snap?.headCommitOid || null, snapshotTreeOid: snap?.snapshotTreeOid || null,
          dirty: snap?.dirty ?? null, verified: Boolean(snap) },
        changes: null,
      } }, 
    })
    throw err
  } finally {
    cleanupSnapshotTmp(snap)
    if (isoPath && isoMainPath) {
      // 隔离 worktree：直接释放（连目录带 .git/worktrees 元数据），无需复位主工作树。
      try { releaseIsolatedWorktree({ repoMainPath: isoMainPath, isoPath }) } catch { /* 兜底已在内部强删 */ }
    } else if (typeof codeDiff === 'string' && codeDiff.trim() && resolvedWorkspace) {
      // 复位门禁工作树：清掉本轮应用的 diff，避免污染下一次（尤其无 diff 的同机快照）提交。
      try { ensurePristineWorkspace(resolvedWorkspace) } catch { /* 复位失败不致命 */ }
    }
  }
}
