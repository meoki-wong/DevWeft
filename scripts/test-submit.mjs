#!/usr/bin/env node
/**
 * awp-test CLI（零侵入，给 agent 用）。cwd 必须是业务仓 git 工作区。
 * 禁止作为人工操作命令；是否提交由 Harness（harness_status / harness_advance）决定。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp } from '../testing/snapshots.js'
import { canonicalizeRemoteUrl } from '../testing/remotes.js'
import { CONTRACT_VERSION } from '../contracts/version.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const wait = args.includes('--wait')
const positional = args.filter((a) => !a.startsWith('--'))

function flag(name, fallback = null) {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = args[i + 1]
  if (!v || v.startsWith('--')) return true
  return v
}

function git(gitArgs) {
  return execFileSync('git', gitArgs, { encoding: 'utf8' }).trim()
}

function remotes() {
  const raw = git(['remote', '-v'])
  const map = new Map()
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (!m) continue
    map.set(m[1], { name: m[1], url: m[2] })
  }
  return [...map.values()]
}

function localContext() {
  const head = git(['rev-parse', 'HEAD'])
  const ref = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const sourceRef = ref === 'HEAD' ? null : `refs/heads/${ref}`
  return {
    remotes: remotes().map((r) => ({ ...r, canonicalUrl: canonicalizeRemoteUrl(r.url) })),
    sourceRef,
    headCommitOid: head,
    objectFormat: 'sha1',
  }
}

function print(obj) {
  if (json) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
  else {
    for (const [k, v] of Object.entries(obj)) {
      process.stdout.write(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}\n`)
    }
  }
}

function token() {
  if (process.env.AWP_TEST_TOKEN) return process.env.AWP_TEST_TOKEN.trim()
  const file = process.env.AWP_TEST_TOKEN_FILE
    || join(process.env.LOCALAPPDATA || homedir(), 'awp-test', 'token')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const platformRoot = process.env.AWP_TEST_PLATFORM_ROOT
  const sibling = platformRoot ? join(platformRoot, 'data', 'bootstrap-admin.token') : null
  const here = join(process.cwd(), 'data', 'bootstrap-admin.token')
  for (const p of [here, sibling].filter(Boolean)) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  }
  throw Object.assign(new Error('not authenticated'), { code: 'UNAUTHENTICATED' })
}

function baseUrl() {
  return (process.env.AWP_TEST_URL || 'http://127.0.0.1:8787').replace(/\/$/, '')
}

async function api(method, path, { body, idempotency } = {}) {
  const headers = {
    Authorization: `Bearer ${token()}`,
    'X-Client-Version': CONTRACT_VERSION,
  }
  if (idempotency) headers['Idempotency-Key'] = idempotency
  let res
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(body.length)
    res = await fetch(`${baseUrl()}${path}`, { method, headers, body })
  } else if (body) {
    headers['Content-Type'] = 'application/json'
    res = await fetch(`${baseUrl()}${path}`, { method, headers, body: JSON.stringify(body) })
  } else {
    res = await fetch(`${baseUrl()}${path}`, { method, headers })
  }
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch {
    throw Object.assign(new Error('platform unavailable'), { code: 'UNAVAILABLE', status: res.status })
  }
  if (parsed.error) {
    const err = new Error(parsed.error.code)
    err.code = parsed.error.code
    err.status = res.status
    throw err
  }
  return parsed.data
}

async function apiUpload(path, filePath, size) {
  const buf = readFileSync(filePath)
  if (buf.length !== size) {
    throw Object.assign(new Error('SNAPSHOT_HASH_MISMATCH'), { code: 'SNAPSHOT_HASH_MISMATCH' })
  }
  return api('PUT', path, { body: buf })
}

function exitFor(err) {
  const code = err.code || err.message
  if (code === 'UNAUTHENTICATED' || err.status === 401) return 3
  if (code === 'UNRESOLVED_REMOTE' || code === 'CROSS_REPO_REFERENCE') return 4
  if (code === 'SECRET_FILES_DETECTED') return 5
  if (code === 'UNAVAILABLE' || err.status === 503) return 6
  if (code === 'WORKSPACE_CHANGED_DURING_SNAPSHOT') return 9
  if (code === 'TASK_BINDING_SUPERSEDED' || code === 'BINDING_STALE') return 9
  return 2
}

function targetCommit(remoteName, targetRef) {
  const short = String(targetRef).replace(/^refs\/heads\//, '')
  try {
    return git(['rev-parse', `${remoteName}/${short}`])
  } catch {
    try {
      return git(['rev-parse', targetRef])
    } catch {
      throw Object.assign(new Error('UNRESOLVED_REMOTE'), { code: 'UNRESOLVED_REMOTE' })
    }
  }
}

function printConfirm(confirm) {
  process.stderr.write(
    [
      `repo ${confirm.repo}`,
      `source remote/project ${confirm.sourceRemote}`,
      `source ref + generation ${confirm.sourceRef}`,
      `target remote/ref/commit ${confirm.target}`,
      `task instance + revision ${confirm.taskInstance}`,
      `snapshot tree ${confirm.snapshotTree}`,
      `suite lock ${confirm.suiteLock}`,
      `execution profile ${confirm.executionProfile}`,
      `runner image ${confirm.runnerImage}`,
      '',
    ].join('\n')
  )
}

async function resolveContext(ctx) {
  return api('POST', '/v1/git-contexts:resolve', {
    idempotency: randomUUID(),
    body: {
      remotes: ctx.remotes.map((r) => ({ name: r.name, url: r.url })),
      sourceRef: ctx.sourceRef,
      headCommitOid: ctx.headCommitOid,
      objectFormat: ctx.objectFormat,
    },
  })
}

const cmd = positional[0] || 'context'
const sub = positional[1]

try {
  if (cmd === 'context' && sub !== 'resolve') {
    print(localContext())
    process.exit(0)
  }
  if (cmd === 'snapshot') {
    const snap = buildDirtyWorkspaceSnapshot(process.cwd(), { withBundle: Boolean(flag('bundle')) })
    const out = { ...snap }
    delete out.bundlePath
    print(out)
    cleanupSnapshotTmp(snap)
    process.exit(0)
  }
  if (cmd === 'resolve' || (cmd === 'context' && sub === 'resolve')) {
    const ctx = localContext()
    if (!ctx.sourceRef) throw Object.assign(new Error('detached HEAD'), { code: 'INVALID_SCHEMA' })
    print(await resolveContext(ctx))
    process.exit(0)
  }
  if (cmd === 'status') {
    const id = flag('submission')
    if (!id || id === true) throw new Error('missing --submission')
    print(await api('GET', `/v1/test-submissions/${id}`))
    process.exit(0)
  }
  if (cmd === 'submit') {
    const task = flag('task')
    const targetRemoteName = flag('target-remote') || 'origin'
    const targetRef = flag('target-ref') || 'refs/heads/stage'
    const side = flag('side') || 'auto'
    const mode = flag('mode') || 'workspace'
    const suite = flag('suite') || 'auto'
    const expectedTaskRevision = Number(flag('expected-revision') || 1)
    if (!task || task === true) throw new Error('missing --task')
    if (mode !== 'workspace') throw Object.assign(new Error('mode not implemented'), { code: 'INVALID_SCHEMA' })
    if (suite !== 'auto') throw Object.assign(new Error('INVALID_SCHEMA'), { code: 'INVALID_SCHEMA' })
    const ctx = localContext()
    if (!ctx.sourceRef) throw Object.assign(new Error('detached HEAD'), { code: 'INVALID_SCHEMA' })
    const remote = ctx.remotes.find((r) => r.name === targetRemoteName) || ctx.remotes[0]
    if (!remote) throw Object.assign(new Error('UNRESOLVED_REMOTE'), { code: 'UNRESOLVED_REMOTE' })
    const resolved = await resolveContext(ctx)
    const snap = buildDirtyWorkspaceSnapshot(process.cwd(), { withBundle: true })
    try {
      const prep = await api('POST', '/v1/blobs:prepare', {
        idempotency: randomUUID(),
        body: { kind: 'git-bundle', sha256: snap.bundleSha256, size: snap.bundleSize },
      })
      if (!prep.alreadyExists) {
        await apiUpload(prep.uploadUrl, snap.bundlePath, snap.bundleSize)
      }
      const targetOid = targetCommit(targetRemoteName, targetRef)
      const targetRemoteId = resolved.authorizedTargets?.[0]?.remoteId || resolved.sourceRemoteId
      const preview = await api('POST', '/v1/suite-plans:resolve', {
        idempotency: randomUUID(),
        body: {
          repoId: resolved.repoId,
          taskInstanceId: flag('task-instance') || task,
          expectedTaskRevision,
          branchIncarnationId: resolved.branchIncarnationId,
          headCommitOid: snap.headCommitOid,
          snapshotTreeOid: snap.snapshotTreeOid,
          changedPaths: snap.changedPaths,
          changedPathsSha256: snap.changedPathsSha256,
          targetRemoteId,
          targetRef,
          targetCommitOid: targetOid,
          candidateRevisionIds: [],
          requestedProfileName: 'auto',
          requestedSides: side,
        },
      })
      printConfirm({
        repo: resolved.repoId,
        sourceRemote: resolved.sourceRemoteId,
        sourceRef: `${ctx.sourceRef} ${resolved.branchGeneration}`,
        target: `${targetRemoteName} ${targetRef} ${targetOid}`,
        taskInstance: `${flag('task-instance') || task} ${expectedTaskRevision}`,
        snapshotTree: snap.snapshotTreeOid,
        suiteLock: preview.lockSha256,
        executionProfile: preview.executionProfileRevisionId,
        runnerImage: preview.runnerImageId,
      })
      const submission = await api('POST', '/v1/test-submissions', {
        idempotency: randomUUID(),
        body: {
          clientRequestId: randomUUID(),
          repoId: resolved.repoId,
          sourceRemoteId: resolved.sourceRemoteId,
          branchIncarnationId: resolved.branchIncarnationId,
          taskInstanceId: flag('task-instance') || task,
          expectedTaskRevision,
          git: {
            objectFormat: 'sha1',
            sourceRef: ctx.sourceRef,
            headCommitOid: snap.headCommitOid,
            snapshotCommitOid: snap.snapshotCommitOid,
            snapshotTreeOid: snap.snapshotTreeOid,
            changedPathsSha256: snap.changedPathsSha256,
            targetRemoteId,
            targetRef,
            targetCommitOid: targetOid,
            mr: null,
          },
          bundle: { sha256: snap.bundleSha256, size: snap.bundleSize },
          suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
          executionRequest: { profile: 'auto', side },
        },
      })
      print(submission)
      if (wait) {
        process.stderr.write('queued; Host Worker not in this milestone, --wait is not blocking on a VM\n')
      }
      process.exit(0)
    } finally {
      cleanupSnapshotTmp(snap)
    }
  }
  process.stderr.write('usage: node scripts/test-submit.mjs context|snapshot|resolve|submit|status [--json]\n')
  process.exit(2)
} catch (err) {
  process.stderr.write(`${err.code || err.message}\n`)
  process.exit(exitFor(err))
}
