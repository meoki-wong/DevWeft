import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { authenticateBearer, createPrincipal, grantRepoPermissions, issueToken } from '../testing/auth.js'
import { casSetActiveBinding, persistBinding, getBinding } from '../testing/bindings.js'
import { createBlobStore } from '../testing/blobs.js'
import { ApiError } from '../testing/errors.js'
import { rememberIdempotency } from '../testing/idempotency.js'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { canonicalizeRemoteUrl, registerRemote, resolveGitContext } from '../testing/remotes.js'
import { observeBranchRef, bindClientTipObservation } from '../testing/branches.js'
import { buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp } from '../testing/snapshots.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { SCHEMA_VERSION, bindingIdFromDocument, documentSha256 } from '../contracts/version.mjs'
import { createTestSubmission, getTestSubmission } from '../testing/submissions.js'
import { previewSuitePlan } from '../testing/suite-plan.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-m1-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const SHA = 'a'.repeat(64)
const OID = 'b'.repeat(40)

describe('M1 identity snapshot binding', () => {
  it('issues tokens and rejects unknown bearer', async () => {
    const db = await memdb()
    const pid = await createPrincipal(db, { subject: 'dev1', displayName: 'Dev' })
    const { token } = await issueToken(db, { principalId: pid })
    const p = await authenticateBearer(db, `Bearer ${token}`)
    expect(p.principalId).toBe(pid)
    await expect(authenticateBearer(db, 'Bearer not-a-real-token-value-at-all')).rejects.toThrow(ApiError)
  })

  it('canonicalizes remotes without using directory name as repo id', async () => {
    expect(canonicalizeRemoteUrl('git@gitlab.example:Web/demo-app.git')).toBe(
      'https://gitlab.example/Web/demo-app'
    )
    expect(canonicalizeRemoteUrl('https://user:pw@GitLab.Example/Web/demo-app.git/')).toBe(
      'https://gitlab.example/Web/demo-app'
    )
    const db = await memdb()
    const repoId = await ensureRepository(db, 'demo-app', await createPrincipal(db, { subject: 'sys', displayName: 's' }))
    await expect(resolveGitContext(db, {
        remotes: [{ name: 'origin', url: 'https://gitlab.example/Web/demo-app.git' }],
        sourceRef: 'refs/heads/feature-x',
        headCommitOid: OID,
        objectFormat: 'sha1',
      })).rejects.toThrow(/UNRESOLVED_REMOTE/)
    await registerRemote(db, { repoId, url: 'https://gitlab.example/Web/demo-app.git', providerInstance: 'gitlab.example' })
    const ctx = await resolveGitContext(db, {
      remotes: [{ name: 'origin', url: 'git@gitlab.example:Web/demo-app.git' }],
      sourceRef: 'refs/heads/feature-x',
      headCommitOid: OID,
      objectFormat: 'sha1',
    })
    expect(ctx.repoId).toBe(repoId)
    expect(ctx.branchIncarnationId).toBeTruthy()
    expect(ctx.branchGeneration).toBe(1)
    const again = await resolveGitContext(db, {
      remotes: [{ name: 'origin', url: 'git@gitlab.example:Web/demo-app.git' }],
      sourceRef: 'refs/heads/feature-x',
      headCommitOid: OID,
      objectFormat: 'sha1',
    })
    expect(again.branchIncarnationId).toBe(ctx.branchIncarnationId)
    const moved = await resolveGitContext(db, {
      remotes: [{ name: 'origin', url: 'git@gitlab.example:Web/demo-app.git' }],
      sourceRef: 'refs/heads/feature-x',
      headCommitOid: 'c'.repeat(40),
      objectFormat: 'sha1',
    })
    expect(moved.branchIncarnationId).toBeNull()
  })

  it('CAS active binding and stable binding_id', async () => {
    const db = await memdb()
    const pid = await createPrincipal(db, { subject: 'dev2', displayName: 'Dev' })
    const repoId = await ensureRepository(db, 'project', pid)
    const now = new Date().toISOString()
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, status, author_principal_id, created_at, updated_at)
       VALUES ('018f0000-0000-7000-8000-0000000000t1', ?, 'T-1', 1, 12, 'EXECUTE', 'open', ?, ?, ?)`
    ).run(repoId, pid, now, now)
    const imageId = 'win2025-pw-node22-20260903.1'
    await db.prepare(
      `INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at)
       VALUES (?, ?, ?, '{}', 'active', ?)`
    ).run(imageId, SHA, 'c'.repeat(64), now)
    await db.prepare(
      `INSERT INTO policy_revisions(policy_revision_id, name, revision, content_sha256, policy_json, state, created_by, created_at)
       VALUES ('018f0000-0000-7000-8000-0000000000p1', 'project', 1, ?, '{}', 'active', ?, ?)`
    ).run('d'.repeat(64), pid, now)
    await db.prepare(
      `INSERT INTO execution_profile_revisions(profile_revision_id, repo_id, name, revision, content_sha256, profile_json, state, created_by, created_at)
       VALUES ('018f0000-0000-7000-8000-0000000000e1', ?, 'project-development-mocked', 1, ?, '{}', 'active', ?, ?)`
    ).run(repoId, 'e'.repeat(64), pid, now)
    const remote = await registerRemote(db, {
      repoId,
      url: 'https://gitlab.example/Web/project.git',
      providerInstance: 'gitlab.example',
    })
    await db.prepare(
      `INSERT INTO business_snapshots(
         snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format, head_commit_oid,
         snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256, target_remote_id, target_ref,
         target_commit_oid, bundle_sha256, bundle_size, created_by, created_at
       ) VALUES ('018f0000-0000-7000-8000-0000000000s1', ?, ?, 'dirty_workspace', 'sha1', ?, ?, ?, ?, ?, 'refs/heads/stage', ?, ?, 12, ?, ?)`
    ).run(repoId, remote.remote_id, OID, OID, OID, SHA, remote.remote_id, OID, SHA, pid, now)
    await db.prepare(
      `INSERT INTO suite_plans(
         suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json,
         changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
         required_case_set_sha256, advisory_case_set_sha256, created_at
       ) VALUES ('018f0000-0000-7000-8000-0000000000u1', ?, '018f0000-0000-7000-8000-0000000000t1', '018f0000-0000-7000-8000-0000000000p1', '["web"]', ?, ?, ?, '{}', ?, ?, ?)`
    ).run(repoId, SHA, OID, 'f'.repeat(64), SHA, SHA, now)

    const doc = {
      schemaVersion: SCHEMA_VERSION,
      repoId,
      sourceRemoteId: remote.remote_id,
      branchIncarnationId: null,
      taskInstanceId: '018f0000-0000-7000-8000-0000000000t1',
      headCommitOid: OID,
      snapshotTreeOid: OID,
      changedPathsSha256: SHA,
      targetRemoteId: remote.remote_id,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      suiteLockSha256: 'f'.repeat(64),
      effectiveSuiteTreeOid: OID,
      executionProfileRevisionId: '018f0000-0000-7000-8000-0000000000e1',
      runnerImageId: imageId,
      runnerImageManifestSha256: SHA,
      policyRevisionId: '018f0000-0000-7000-8000-0000000000p1',
      resolvedSides: ['web'],
      requiredCaseSetSha256: SHA,
    }
    const row = await persistBinding(db, {
      document: doc,
      snapshotId: '018f0000-0000-7000-8000-0000000000s1',
      suitePlanId: '018f0000-0000-7000-8000-0000000000u1',
    })
    expect(row.binding_id).toBe(bindingIdFromDocument(doc))
    const cas = await casSetActiveBinding(db, {
      taskInstanceId: doc.taskInstanceId,
      bindingId: row.binding_id,
      expectedRevision: 12,
    })
    expect(cas.revision).toBe(13)
    const got = await getBinding(db, row.binding_id)
    expect(got.bindingId).toBe(row.binding_id)
    expect(got.document.repoId).toBe(repoId)
    await expect(casSetActiveBinding(db, {
        taskInstanceId: doc.taskInstanceId,
        bindingId: row.binding_id,
        expectedRevision: 12,
      })).rejects.toThrow(/TASK_REVISION_CONFLICT/)
  })

  it('stores content-addressed blobs and idempotent POST', async () => {
    const db = await memdb()
    const pid = await createPrincipal(db, { subject: 'dev3', displayName: 'Dev' })
    const dir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
    const store = createBlobStore(dir)
    const payload = Buffer.from('hello-bundle')
    const sha = createHash('sha256').update(payload).digest('hex')
    const prep = store.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
    expect(prep.alreadyExists).toBe(false)
    await store.writeUpload(prep.uploadId, payload)
    const prep2 = store.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
    expect(prep2.alreadyExists).toBe(true)
    const body = { a: 1 }
    const first = await rememberIdempotency(db, {
      principalId: pid,
      route: 'POST /v1/x',
      idempotencyKey: '018f0000-0000-7000-8000-0000000000i1',
      requestBody: body,
      produce: () => ({ status: 200, json: { ok: true } }),
    })
    const second = await rememberIdempotency(db, {
      principalId: pid,
      route: 'POST /v1/x',
      idempotencyKey: '018f0000-0000-7000-8000-0000000000i1',
      requestBody: body,
      produce: () => ({ status: 200, json: { ok: false } }),
    })
    expect(second.replay).toBe(true)
    expect(second.json.ok).toBe(true)
    expect(first.replay).toBe(false)
    await expect(rememberIdempotency(db, {
        principalId: pid,
        route: 'POST /v1/x',
        idempotencyKey: '018f0000-0000-7000-8000-0000000000i1',
        requestBody: { a: 2 },
        produce: () => ({ status: 200, json: {} }),
      })).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED/)
    await grantRepoPermissions(db, { principalId: pid, repoId: await ensureRepository(db, 'r', pid), permissions: ['submit'] })
  })

  it('builds a dirty workspace snapshot without changing the real index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-git-'))
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'i'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one')
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    const snap = buildDirtyWorkspaceSnapshot(dir)
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    expect(snap.snapshotTreeOid).toMatch(/^[a-f0-9]{40}$/)
    expect(after).toBe(before)
    const again = buildDirtyWorkspaceSnapshot(dir)
    expect(again.snapshotCommitOid).toBe(snap.snapshotCommitOid)
    rmSync(dir, { recursive: true, force: true })
  })

  it('bootstraps admin token, repo ACL and remote idempotently', async () => {
    const db = await memdb()
    const first = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      rotateToken: true,
    })
    expect(first.token).toBeTruthy()
    const principal = await authenticateBearer(db, `Bearer ${first.token}`)
    expect(principal.acl.some((a) => a.permission === 'administer')).toBe(true)
    const ctx = await resolveGitContext(db, {
      remotes: [{ name: 'origin', url: 'git@gitlab.example:Web/demo-app.git' }],
      sourceRef: 'refs/heads/x',
      headCommitOid: OID,
      objectFormat: 'sha1',
    })
    expect(ctx.repoId).toBe(first.repoId)
    const second = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
    })
    expect(second.principalId).toBe(first.principalId)
    expect(second.tokenReuse).toBe(true)
  })

  it('I06-I09 branch incarnation identity', async () => {
    const db = await memdb()
    const pid = await createPrincipal(db, { subject: 'br', displayName: 'b' })
    const repoId = await ensureRepository(db, 'project', pid)
    const origin = await registerRemote(db, {
      repoId,
      url: 'https://gitlab.example/Web/project.git',
      providerInstance: 'gitlab.example',
    })
    const fork = await registerRemote(db, {
      repoId,
      url: 'https://gitlab.example/fork/project.git',
      providerInstance: 'gitlab.example',
      relationship: 'fork',
    })
    const ref = 'refs/heads/feature-x'
    const a = await observeBranchRef(db, {
      remoteId: origin.remote_id,
      fullRef: ref,
      newTipOid: OID,
      ancestryResult: 'first',
    })
    const b = await observeBranchRef(db, {
      remoteId: fork.remote_id,
      fullRef: ref,
      newTipOid: OID,
      ancestryResult: 'first',
    })
    expect(a.branchIncarnationId).not.toBe(b.branchIncarnationId)
    expect(a.branchGeneration).toBe(1)

    const ff = await observeBranchRef(db, {
      remoteId: origin.remote_id,
      fullRef: ref,
      newTipOid: 'c'.repeat(40),
      ancestryResult: 'fast_forward',
    })
    expect(ff.branchIncarnationId).toBe(a.branchIncarnationId)
    expect(ff.branchGeneration).toBe(1)

    const rebase = await observeBranchRef(db, {
      remoteId: origin.remote_id,
      fullRef: ref,
      newTipOid: 'd'.repeat(40),
      ancestryResult: 'non_fast_forward',
    })
    expect(rebase.branchIncarnationId).not.toBe(a.branchIncarnationId)
    expect(rebase.branchGeneration).toBe(2)

    await observeBranchRef(db, {
      remoteId: fork.remote_id,
      fullRef: ref,
      observedState: 'deleted',
      ancestryResult: 'deleted',
    })
    const reborn = await observeBranchRef(db, {
      remoteId: fork.remote_id,
      fullRef: ref,
      newTipOid: 'e'.repeat(40),
      ancestryResult: 'recreated',
    })
    expect(reborn.branchGeneration).toBe(2)
    expect(reborn.branchIncarnationId).not.toBe(b.branchIncarnationId)

    const client = await bindClientTipObservation(db, {
      remoteId: origin.remote_id,
      fullRef: ref,
      headCommitOid: 'f'.repeat(40),
    })
    expect(client.unverified).toBe(true)
    expect(client.branchIncarnationId).toBeNull()
  })

  it('rejects secret paths and cleans bundle tmp', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-git-'))
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'i'], { cwd: dir })
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    expect(() => buildDirtyWorkspaceSnapshot(dir)).toThrow(/SECRET_FILES_DETECTED/)
    writeFileSync(join(dir, 'ok.txt'), 'x')
    rmSync(join(dir, '.env'))
    const tmp = mkdtempSync(join(tmpdir(), 'awp-snap-'))
    const snap = buildDirtyWorkspaceSnapshot(dir, { tmpRoot: tmp, withBundle: true })
    expect(snap.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(snap.bundleSize).toBeGreaterThan(0)
    expect(existsSync(snap.bundlePath)).toBe(true)
    cleanupSnapshotTmp(snap)
    expect(existsSync(tmp)).toBe(false)
    const after = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })
    expect(after).toContain('ok.txt')
    rmSync(dir, { recursive: true, force: true })
  })

  it('queues a submission by external task id without fake pass', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      rotateToken: true,
    })
    const now = new Date().toISOString()
    const taskInstanceId = '018f0000-0000-7000-8000-0000000000aa'
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at)
       VALUES (?, ?, 'T-EXT-1', 1, 1, 'EXECUTE', 'M', 'open', ?, ?, ?)`
    ).run(taskInstanceId, boot.repoId, boot.principalId, now, now)
    const principal = await authenticateBearer(db, `Bearer ${boot.token}`)
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
    const blobs = createBlobStore(blobDir)
    const payload = Buffer.from('git-bundle-bytes')
    const sha = createHash('sha256').update(payload).digest('hex')
    const prep = blobs.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
    await blobs.writeUpload(prep.uploadId, payload)

    const emptyPathsSha = documentSha256([])
    const preview = await previewSuitePlan(db, {
      repoId: boot.repoId,
      taskInstanceId: 'T-EXT-1',
      expectedTaskRevision: 1,
      branchIncarnationId: null,
      headCommitOid: OID,
      snapshotTreeOid: OID,
      changedPaths: [],
      changedPathsSha256: emptyPathsSha,
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      candidateRevisionIds: [],
      requestedProfileName: 'auto',
      requestedSides: 'auto',
    })
    expect(preview.lockSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(preview.requiredCaseKeys.sort()).toEqual([
      'test:smoke/fun',
      'test:smoke/store',
      'test:static/eslint',
      'test:static/hard-rules',
      'test:static/translation-fixture',
      'test:static/vitest',
    ].sort())
    expect(preview.overlayRevisionIds).toHaveLength(2)
    expect(preview.candidateLockSha256).toBeNull()

    const created = await createTestSubmission(db, blobs, {
      clientRequestId: '018f0000-0000-7000-8000-0000000000c1',
      repoId: boot.repoId,
      sourceRemoteId: boot.remoteId,
      branchIncarnationId: null,
      taskInstanceId: 'T-EXT-1',
      expectedTaskRevision: 1,
      git: {
        objectFormat: 'sha1',
        sourceRef: 'refs/heads/feature-x',
        headCommitOid: OID,
        snapshotCommitOid: OID,
        snapshotTreeOid: OID,
        changedPathsSha256: emptyPathsSha,
        targetRemoteId: boot.remoteId,
        targetRef: 'refs/heads/stage',
        targetCommitOid: OID,
        mr: null,
      },
      bundle: { sha256: sha, size: payload.length },
      suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
      executionRequest: { profile: 'auto', side: 'auto' },
    }, principal)
    expect(created.status).toBe('queued')
    expect(created.taskRevision).toBe(2)
    expect(created.suiteLockSha256).toBe(preview.lockSha256)
    const group = await db.prepare('SELECT gate_eligible, status, required_units_json FROM run_groups WHERE run_group_id=?').get(created.formalRunGroupId)
    // 空库 + task_instances.size=M：按体量策略生成 units，且 gate_eligible=1
    expect(group.status).toBe('queued')
    expect(group.gate_eligible).toBe(1)
    const units = JSON.parse(group.required_units_json)
    expect(units.length).toBeGreaterThan(0)
    // 空库无 changed_files 时可能只产出 static 单元；有 suite registry 则含 smoke
    expect(units.some((u) => u.startsWith('static') || u.startsWith('smoke'))).toBe(true)
    expect((await db.prepare('SELECT COUNT(*) AS n FROM test_runs').get()).n).toBe(units.length)
    const got = await getTestSubmission(db, created.submissionId)
    expect(got.bindingId).toBe(created.bindingId)
    await expect(createTestSubmission(db, blobs, {
        clientRequestId: '018f0000-0000-7000-8000-0000000000c2',
        repoId: boot.repoId,
        sourceRemoteId: boot.remoteId,
        branchIncarnationId: null,
        taskInstanceId: taskInstanceId,
        expectedTaskRevision: 1,
        git: {
          objectFormat: 'sha1',
          sourceRef: 'refs/heads/feature-x',
          headCommitOid: OID,
          snapshotCommitOid: OID,
          snapshotTreeOid: OID,
          changedPathsSha256: emptyPathsSha,
          targetRemoteId: boot.remoteId,
          targetRef: 'refs/heads/stage',
          targetCommitOid: OID,
          mr: null,
        },
        bundle: { sha256: sha, size: payload.length },
        suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
        executionRequest: { profile: 'auto', side: 'auto' },
      }, principal)).rejects.toThrow(/TASK_REVISION_CONFLICT/)
    await expect(previewSuitePlan(db, {
        repoId: boot.repoId,
        taskInstanceId: 'T-EXT-1',
        expectedTaskRevision: 2,
        branchIncarnationId: null,
        headCommitOid: OID,
        snapshotTreeOid: OID,
        changedPaths: ['a.txt'],
        changedPathsSha256: emptyPathsSha,
        targetRemoteId: boot.remoteId,
        targetRef: 'refs/heads/stage',
        targetCommitOid: OID,
        candidateRevisionIds: [],
        requestedProfileName: 'auto',
        requestedSides: 'auto',
      })).rejects.toThrow(/SNAPSHOT_HASH_MISMATCH/)
    rmSync(blobDir, { recursive: true, force: true })
  })
})

