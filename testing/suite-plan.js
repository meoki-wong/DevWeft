import { canonicalize, documentSha256 } from '../contracts/version.mjs'
import { ApiError, rejectUnknownFields } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { canonicalizeChangedPaths } from './snapshots.js'
import { lookupOpenTask } from './tasks.js'
import { selectSuiteLayers, mergeSuiteCases } from './suite-selector.js'
import { inferSidesFromChangedFiles } from '../harness/testing-gate.js'
import { getRepoTestPolicy } from './repo-policies.js'
import { getRepoPlatformProfile } from './repo-platform.js'

function resolvedSidesFromRequest(side, changedFiles = null, { enableSides = false, impact = null, defaultSides = [] } = {}) {
  const configuredSides = Array.isArray(defaultSides) ? defaultSides : []
  if (!configuredSides.length) return []
  if (!enableSides) return configuredSides
  if (side === 'both') return configuredSides
  if (typeof side === 'string' && side !== 'auto') {
    return configuredSides.includes(side) ? [side] : null
  }
  if (Array.isArray(changedFiles) && changedFiles.length) {
    return inferSidesFromChangedFiles(changedFiles, impact)
  }
  return configuredSides.length === 1 ? configuredSides : null
}

async function computeLock(db, {
  repoId,
  taskInstanceId,
  branchIncarnationId = null,
  changedPathsSha256,
  requestedSide = 'auto',
  changedFiles = null,
}) {
  const policy = await db.prepare(
    `SELECT * FROM policy_revisions WHERE state='active' ORDER BY revision DESC LIMIT 1`
  ).get()
  const profile = await db.prepare(
    `SELECT * FROM execution_profile_revisions
     WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`
  ).get(repoId)
  const image = await db.prepare(
    `SELECT * FROM runner_images WHERE state='active' ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (!policy || !profile || !image) throw new ApiError('SUITE_REVOKED')

  const repoPolicy = await getRepoTestPolicy(db, repoId)
  const slug = (await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(repoId))?.slug
  const platformProfile = slug ? getRepoPlatformProfile(slug) : null
  const resolvedSides = resolvedSidesFromRequest(requestedSide, changedFiles, {
    enableSides: repoPolicy.enableSides,
    impact: platformProfile?.impact || null,
    defaultSides: platformProfile?.defaultSides || [],
  })
  if (repoPolicy.enableSides && !resolvedSides) {
    throw new ApiError('SIDES_PENDING', { detail: 'Unable to resolve configured test lanes. Pass a configured side, both, or changedFiles with repository impact rules.' })
  }
  const layers = await selectSuiteLayers(db, { repoId, taskInstanceId, branchIncarnationId })
  const merged = mergeSuiteCases(layers)
  const requiredCaseKeys = merged.cases.map((c) => c.caseKey)
  const overlayRevisionIds = layers.map((l) => l.revision.suite_revision_id)
  const lockCases = merged.cases.map((c) => ({
    caseKey: c.caseKey,
    protected: c.protected,
    replacesCaseKey: c.replacesCaseKey,
    overlayId: c.overlayId,
    suiteRevisionId: c.suiteRevisionId,
  }))
  const effectiveSuiteTreeOid = layers.length
    ? documentSha256(layers.map((l) => ({ overlayId: l.overlay.overlay_id, contentSha256: l.revision.content_sha256 })))
    : '0'.repeat(40)
  const lockDoc = {
    schemaVersion: 1,
    repoId,
    taskInstanceId,
    policyRevisionId: policy.policy_revision_id,
    executionProfileRevisionId: profile.profile_revision_id,
    runnerImageId: image.image_id,
    overlayRevisionIds,
    requiredCaseKeys,
    advisoryCaseKeys: [],
    cases: lockCases,
    waivers: [],
    resolvedSides,
    changedPathsSha256,
  }
  return {
    lockDoc,
    lockSha256: documentSha256(lockDoc),
    requiredCaseSetSha256: documentSha256(requiredCaseKeys),
    advisoryCaseSetSha256: documentSha256([]),
    policy,
    profile,
    image,
    resolvedSides,
    layers,
    effectiveSuiteTreeOid,
  }
}

export async function resolveMinimalSuitePlan(db, {
  repoId,
  taskInstanceId,
  branchIncarnationId = null,
  changedPathsSha256,
  requestedSide = 'auto',
  changedFiles = null,
  now = utcNow(),
}) {
  const computed = await computeLock(db, {
    repoId,
    taskInstanceId,
    branchIncarnationId,
    changedPathsSha256,
    requestedSide,
    changedFiles,
  })
  const existing = await db.prepare('SELECT * FROM suite_plans WHERE lock_sha256=?').get(computed.lockSha256)
  if (existing) return existing

  const suitePlanId = uuidv7()
  await db.prepare(
    `INSERT INTO suite_plans(
       suite_plan_id, repo_id, task_instance_id, branch_incarnation_id, policy_revision_id,
       resolved_sides_json, changed_paths_sha256, effective_suite_tree_oid, lock_sha256,
       canonical_lock_json, required_case_set_sha256, advisory_case_set_sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    suitePlanId,
    repoId,
    taskInstanceId,
    branchIncarnationId,
    computed.policy.policy_revision_id,
    JSON.stringify(computed.resolvedSides),
    changedPathsSha256,
    computed.effectiveSuiteTreeOid,
    computed.lockSha256,
    canonicalize(computed.lockDoc),
    computed.requiredCaseSetSha256,
    computed.advisoryCaseSetSha256,
    now
  )
  computed.layers.forEach(async (layer, position) => {
    await db.prepare(
      `INSERT INTO suite_plan_layers(
         suite_plan_id, position, layer, overlay_id, suite_revision_id, effective_approval, content_sha256
       ) VALUES (?, ?, ?, ?, ?, 'reviewed', ?)`
    ).run(
      suitePlanId,
      position,
      layer.overlay.layer,
      layer.overlay.overlay_id,
      layer.revision.suite_revision_id,
      layer.revision.content_sha256
    )
  })
  return await db.prepare('SELECT * FROM suite_plans WHERE suite_plan_id=?').get(suitePlanId)
}

export async function previewSuitePlan(db, body) {
  rejectUnknownFields(body, [
    'repoId', 'taskInstanceId', 'expectedTaskRevision', 'branchIncarnationId',
    'headCommitOid', 'snapshotTreeOid', 'changedPaths', 'changedPathsSha256',
    'targetRemoteId', 'targetRef', 'targetCommitOid', 'candidateRevisionIds',
    'requestedProfileName', 'requestedSides',
  ])
  if (!body.repoId || !body.taskInstanceId || !Array.isArray(body.changedPaths)) {
    throw new ApiError('INVALID_SCHEMA')
  }
  if (!Number.isInteger(body.expectedTaskRevision) || body.expectedTaskRevision < 1) {
    throw new ApiError('INVALID_SCHEMA')
  }
  const task = await lookupOpenTask(db, body.repoId, body.taskInstanceId)
  if (!task) throw new ApiError('INVALID_SCHEMA')
  if (task.revision !== body.expectedTaskRevision) throw new ApiError('TASK_REVISION_CONFLICT')

  const recomputed = canonicalizeChangedPaths(body.changedPaths)
  if (recomputed.sha256 !== body.changedPathsSha256) throw new ApiError('SNAPSHOT_HASH_MISMATCH')

  const plan = await resolveMinimalSuitePlan(db, {
    repoId: body.repoId,
    taskInstanceId: task.task_instance_id,
    branchIncarnationId: body.branchIncarnationId,
    changedPathsSha256: recomputed.sha256,
    requestedSide: body.requestedSides || 'auto',
  })
  const lock = JSON.parse(plan.canonical_lock_json)
  return {
    suitePlanId: plan.suite_plan_id,
    lockSha256: plan.lock_sha256,
    policyRevisionId: plan.policy_revision_id,
    executionProfileRevisionId: lock.executionProfileRevisionId,
    runnerImageId: lock.runnerImageId,
    overlayRevisionIds: lock.overlayRevisionIds,
    requiredCaseKeys: lock.requiredCaseKeys,
    advisoryCaseKeys: lock.advisoryCaseKeys,
    waivers: [],
    resolvedSides: JSON.parse(plan.resolved_sides_json),
    changedPathsSha256: plan.changed_paths_sha256,
    candidateLockSha256: null,
    prospectiveBindingId: null,
  }
}
