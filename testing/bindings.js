import { bindingIdFromDocument, SCHEMA_VERSION } from '../contracts/version.mjs'
import { ApiError } from './errors.js'
import { utcNow } from './ids.js'

export async function persistBinding(db, {
  document,
  snapshotId,
  suitePlanId,
  now = utcNow(),
}) {
  if (document.schemaVersion !== SCHEMA_VERSION) throw new ApiError('INVALID_SCHEMA')
  const bindingId = bindingIdFromDocument(document)
  const existing = await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(bindingId)
  if (existing) return existing
  await db.prepare(
    `INSERT INTO test_bindings(
       binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
       execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256,
       policy_revision_id, resolved_sides_json, changed_paths_sha256,
       required_case_set_sha256, canonical_binding_json, state, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`
  ).run(
    bindingId,
    document.repoId,
    snapshotId,
    suitePlanId,
    document.taskInstanceId,
    document.executionProfileRevisionId,
    document.runnerImageId,
    document.runnerImageManifestSha256,
    document.policyRevisionId,
    JSON.stringify(document.resolvedSides),
    document.changedPathsSha256,
    document.requiredCaseSetSha256,
    JSON.stringify(document),
    now
  )
  return await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(bindingId)
}

export async function getBinding(db, bindingId) {
  if (!/^[a-f0-9]{64}$/.test(String(bindingId || ''))) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(bindingId)
  if (!row) throw new ApiError('INVALID_SCHEMA')
  return {
    bindingId: row.binding_id,
    state: row.state,
    document: JSON.parse(row.canonical_binding_json),
    snapshotId: row.snapshot_id,
    suitePlanId: row.suite_plan_id,
    taskInstanceId: row.task_instance_id,
  }
}

export async function casSetActiveBinding(db, { taskInstanceId, bindingId, expectedRevision, now = utcNow() }) {
  const info = await db.prepare(
    `UPDATE task_instances
     SET active_binding_id=?, revision=revision+1, updated_at=?
     WHERE task_instance_id=? AND revision=?`
  ).run(bindingId, now, taskInstanceId, expectedRevision)
  if (info.changes !== 1) throw new ApiError('TASK_REVISION_CONFLICT')
  return await db.prepare('SELECT revision, active_binding_id FROM task_instances WHERE task_instance_id=?').get(taskInstanceId)
}
