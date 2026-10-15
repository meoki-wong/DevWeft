import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { authenticateBearer } from '../../testing/auth.js'
import { createBlobStore } from '../../testing/blobs.js'
import { bootstrapTestingPlatform } from '../../testing/bootstrap.js'
import { createTestSubmission } from '../../testing/submissions.js'
import { lookupOpenTask } from '../../testing/tasks.js'
import { documentSha256 } from '../../contracts/version.mjs'
import { uuidv7, utcNow } from '../../testing/ids.js'
import { buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp, collectTaskChangedFiles } from '../../testing/snapshots.js'

const CANARY_TASK = 'AWP-STATIC-CANARY'
const OID = 'b'.repeat(40)
const DUMMY_PREFIX = 'awp-static-canary:'

function isDummyBundle(blobRoot, sha256, size) {
  if (!sha256 || size > 2048) return false
  try {
    const p = createBlobStore(blobRoot).contentPath(sha256)
    const head = readFileSync(p).subarray(0, DUMMY_PREFIX.length).toString('utf8')
    return head === DUMMY_PREFIX
  } catch {
    return size < 256
  }
}

async function queuedStatic(db) {
  return await db.prepare(
    `SELECT r.run_id, s.bundle_size, s.bundle_sha256
     FROM test_runs r
     JOIN test_bindings b ON b.binding_id=r.binding_id
     JOIN business_snapshots s ON s.snapshot_id=b.snapshot_id
     WHERE r.status='queued' AND r.unit='static' AND r.side='na' AND r.desired_state='running'
     ORDER BY r.created_at ASC LIMIT 1`
  ).get()
}

async function abandonDummyQueued(db, runId) {
  const now = utcNow()
  await db.prepare(
    `UPDATE test_runs SET status='error', terminal_reason='infra_error', finished_at=?
     WHERE run_id=? AND status='queued'`
  ).run(now, runId)
}

async function storeBundle(blobs, sha256, size, buf) {
  const prep = blobs.prepare({ kind: 'git-bundle', sha256, size })
  if (!prep.alreadyExists) await blobs.writeUpload(prep.uploadId, buf)
}

export async function ensureCanaryStaticRun(db, {
  blobRoot,
  remoteUrl = null,
  token,
  workspacePath = null,
} = {}) {
  const queued = await queuedStatic(db)
  if (queued) {
    const dummy = isDummyBundle(blobRoot, queued.bundle_sha256, queued.bundle_size)
    if (!workspacePath || !dummy) {
      return {
        reused: true,
        runId: queued.run_id,
        bundleSha256: queued.bundle_sha256,
        bundleSize: queued.bundle_size,
      }
    }
    await abandonDummyQueued(db, queued.run_id)
  }

  const boot = await bootstrapTestingPlatform(db, { remoteUrl, rotateToken: !token })
  const authToken = token || boot.token
  if (!authToken) throw new Error('缺少 bootstrap-admin token')
  if (!boot.remoteId) throw new Error('控制面没有登记 git remote，请先完成一键部署')

  const now = utcNow()
  let task = await lookupOpenTask(db, boot.repoId, CANARY_TASK)
  if (!task) {
    const taskInstanceId = uuidv7()
    await db.prepare(
      `INSERT INTO task_instances(
         task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status,
         author_principal_id, created_at, updated_at
       ) VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'S', 'open', ?, ?, ?)`
    ).run(taskInstanceId, boot.repoId, CANARY_TASK, boot.principalId, now, now)
    await db.prepare(
      `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
       VALUES (?, ?, ?, ?)`
    ).run(boot.repoId, CANARY_TASK, taskInstanceId, now)
    task = await lookupOpenTask(db, boot.repoId, CANARY_TASK)
  }

  const principal = await authenticateBearer(db, `Bearer ${authToken}`)
  const blobs = createBlobStore(blobRoot)
  let git
  let bundle
  if (workspacePath) {
    const snap = buildDirtyWorkspaceSnapshot(workspacePath, { withBundle: true })
    try {
      await storeBundle(blobs, snap.bundleSha256, snap.bundleSize, readFileSync(snap.bundlePath))
      git = {
        objectFormat: 'sha1',
        sourceRef: 'refs/heads/feature-static-canary',
        headCommitOid: snap.headCommitOid,
        snapshotCommitOid: snap.snapshotCommitOid,
        snapshotTreeOid: snap.snapshotTreeOid,
        changedPathsSha256: snap.changedPathsSha256,
        // 金丝雀按脏区快照交卷：起点=快照 HEAD → 只认脏改动，不把 HEAD 上无关提交算进来
        changedFiles: collectTaskChangedFiles(workspacePath, snap.changedPaths, {
          startHeadOid: snap.headCommitOid,
        }),
        targetRemoteId: boot.remoteId,
        targetRef: 'refs/heads/stage',
        targetCommitOid: snap.headCommitOid,
        mr: null,
      }
      bundle = { sha256: snap.bundleSha256, size: snap.bundleSize }
    } finally {
      cleanupSnapshotTmp(snap)
    }
  } else {
    const payload = Buffer.from(`${DUMMY_PREFIX}${now}`)
    const sha = createHash('sha256').update(payload).digest('hex')
    await storeBundle(blobs, sha, payload.length, payload)
    git = {
      objectFormat: 'sha1',
      sourceRef: 'refs/heads/feature-static-canary',
      headCommitOid: OID,
      snapshotCommitOid: OID,
      snapshotTreeOid: OID,
      changedPathsSha256: documentSha256([]),
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      mr: null,
    }
    bundle = { sha256: sha, size: payload.length }
  }

  const created = await createTestSubmission(db, blobs, {
    clientRequestId: uuidv7(),
    repoId: boot.repoId,
    sourceRemoteId: boot.remoteId,
    branchIncarnationId: null,
    taskInstanceId: CANARY_TASK,
    expectedTaskRevision: task.revision,
    git,
    bundle,
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
  const run = await db.prepare('SELECT run_id FROM test_runs WHERE run_group_id=?').get(created.formalRunGroupId)
  return {
    reused: false,
    runId: run.run_id,
    submissionId: created.submissionId,
    bindingId: created.bindingId,
    bundleSha256: bundle.sha256,
    bundleSize: bundle.size,
  }
}

export { CANARY_TASK, DUMMY_PREFIX }
