/**
 * submission-chain.mjs — 门禁链测试夹具（阶段 3 / T3.2）
 *
 * 一站式构造「任务 → task_instance → binding(assetLock) → formal 组 → runs」真实链路，
 * 供场景测试组合使用。数据构造遵循平台真实身份机制：
 *   - binding.canonical_binding_json 含 buildAssetLock 冻结清单（camelCase 测试侧统一走行格式）；
 *   - runs 可选附带 run_attempts + accepted_run_results + run_attestations（单元证据核对可用）；
 *   - report checks 形状对齐真实生产数据（caseKey/durationMs/status）。
 */
import { randomUUID } from 'node:crypto'
import { buildAssetLock } from '../../testing/asset-lock.js'

const SHA = 'a'.repeat(64)

async function realIds(db, repoId) {
  return {
    profileId: (await db.prepare(`SELECT profile_revision_id FROM execution_profile_revisions WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`).get(repoId))?.profile_revision_id,
    imageId: (await db.prepare(`SELECT image_id FROM runner_images WHERE state='active' LIMIT 1`).get())?.image_id,
    policyId: (await db.prepare(`SELECT policy_revision_id FROM policy_revisions WHERE state='active' LIMIT 1`).get())?.policy_revision_id,
  }
}

/**
 * 构造门禁链。
 * @param {object} opts
 * @param {object[]} opts.specs 冻结考卷行（snake_case 行格式：feature_key/spec_id/version/spec_type/side/blob_sha256）
 * @param {string}  opts.taskId 外部任务 id（须已存在于 harness tasks 表）
 * @param {string}  opts.groupStatus 组状态（queued/running/passed/failed）
 * @param {Array}   opts.runs [{unit, side, status, report: {checks}}]
 * @param {boolean} opts.withEvidence 是否补 run_attempts/attestation/accepted（单元证据核对需要）
 * @param {string}  opts.mutationPayload mutation run 的 payload_json（s5 竞态用）
 */
export async function seedGateChain(db, {
  repoId,
  taskId,
  specs = [],
  groupStatus = 'running',
  runs = [],
  withEvidence = false,
  mutationPayload = null,
  workerId = null,
}) {
  const now = new Date().toISOString()
  const ti = randomUUID()
  const bindingId = randomUUID()
  const snapshotId = randomUUID()
  const planId = randomUUID()
  const groupId = randomUUID()
  const subId = `sub-${randomUUID().slice(0, 8)}`
  const { profileId, imageId, policyId } = await realIds(db, repoId)

  await db.prepare(
    `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
       active_binding_id, status, author_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'M', 'FEATURE', ?, 'open',
       (SELECT principal_id FROM principals LIMIT 1), ?, ?)`
  ).run(ti, repoId, taskId, bindingId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, legacy_task_id) DO UPDATE SET task_instance_id=excluded.task_instance_id`
  ).run(repoId, taskId, ti, now)
  await db.prepare(
    `INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format,
       head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
       target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
     VALUES (?, ?, ?, 'dirty_workspace', 'sha1', ?, ?, ?, ?, ?, 'refs/heads/stage', ?, ?, 128, ?, ?)
     ON CONFLICT(snapshot_id) DO NOTHING`
  ).run(snapshotId, repoId, ((await db.prepare('SELECT remote_id FROM git_remotes WHERE repo_id=? LIMIT 1').get(repoId))?.remote_id) || 'r0', 'h'.repeat(40), 's'.repeat(40), 't'.repeat(40), 'c'.repeat(64), ((await db.prepare('SELECT remote_id FROM git_remotes WHERE repo_id=? LIMIT 1').get(repoId))?.remote_id) || 'r0', 'g'.repeat(40), SHA, ((await db.prepare('SELECT principal_id FROM principals LIMIT 1').get())?.principal_id) || 'p0', now)
  await db.prepare(
    `INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json,
       changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
       required_case_set_sha256, advisory_case_set_sha256, created_at)
     VALUES (?, ?, ?, ?, '["web"]', ?, ?, ?, '{}', ?, ?, ?) ON CONFLICT(suite_plan_id) DO NOTHING`
  ).run(planId, repoId, ti, policyId, 'c'.repeat(64), 'e'.repeat(64), `lock-${planId}`, 'r'.repeat(64), 'a'.repeat(64), now)
  await db.prepare(
    `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
       execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
       resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
       state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["web"]', ?, ?, ?, 'active', ?)
     ON CONFLICT(binding_id) DO NOTHING`
  ).run(bindingId, repoId, snapshotId, planId, ti, profileId, imageId, SHA, policyId, 'c'.repeat(64), 'r'.repeat(64), JSON.stringify({ assetLock: lockDocFrom(specs) }), now)
  await db.prepare(
    `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
       binding_id, expected_task_revision, status, created_at)
     VALUES (?, ?, (SELECT principal_id FROM principals LIMIT 1), ?, ?, ?, 1, ?, ?)`
  ).run(subId, `cr-${subId}`, repoId, ti, bindingId, groupStatus === 'failed' ? 'failed' : 'running', now)
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
       required_units_json, status, created_at)
     VALUES (?, ?, ?, ?, 'formal', 1, ?, ?, ?)`
  ).run(groupId, repoId, subId, bindingId, JSON.stringify(unitsFrom(runs)), groupStatus, now)

  const runIds = []
  for (const r of runs) {
    const id = randomUUID()
    runIds.push(id)
    await db.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
         unit, side, purpose, status, desired_state, max_attempts, next_attempt, lease_epoch,
         report_json, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'gate', ?, 'running', 2, 0, 0, ?, ?, ?)`
    ).run(id, groupId, bindingId, repoId, ti, r.unit, r.side, r.status, r.report ? JSON.stringify(r.report) : null, mutationPayload, now)
    if (withEvidence && r.status === 'passed') {
      await db.prepare(
        `INSERT INTO run_attempts(repo_id, run_id, attempt, worker_id, lease_epoch, status, image_id, started_at, finished_at)
         VALUES (?, ?, 1, ?, 1, 'passed', ?, ?, ?)`
      ).run(repoId, id, workerId, imageId, now, now)
      await db.prepare(
        `INSERT INTO accepted_run_results(run_id, attempt, lease_epoch, result_sha256, accepted_at)
         VALUES (?, 1, 1, ?, ?)`
      ).run(id, SHA, now)
      await db.prepare(
        `INSERT INTO run_attestations(run_attestation_id, repo_id, run_id, attempt, lease_epoch, binding_id,
           worker_id, worker_cert_thumbprint, image_id, image_manifest_sha256, result_sha256, artifact_sha256,
           canonical_sha256, signature, completed_at)
         VALUES (?, ?, ?, 1, 1, ?, ?, 'thumb', ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), repoId, id, bindingId, workerId, imageId, SHA, SHA, SHA, SHA, SHA, now)
    }
  }
  return { ti, bindingId, groupId, submissionId: subId, runIds }
}

/** 测试侧冻结清单行 → buildAssetLock 入参（snake_case 行格式） */
function lockDocFrom(specs) {
  return buildAssetLock(specs.map((s) => ({
    feature_key: s.featureKey ?? s.feature_key,
    spec_id: s.specId ?? s.spec_id ?? `sp-${s.featureKey ?? s.feature_key}`,
    version: s.version ?? 1,
    spec_type: s.specType ?? s.spec_type ?? 'e2e',
    side: s.side ?? 'web',
    scope: s.scope ?? 'task',
    entry: s.entry ?? `${s.featureKey ?? s.feature_key}.spec.mjs`,
    blob_sha256: s.blobSha256 ?? s.blob_sha256 ?? SHA,
  })))
}

function unitsFrom(runs) {
  const units = [...new Set(runs.map((r) => `${r.unit}:${r.side}`))]
  return units.length ? units : ['smoke:web']
}
