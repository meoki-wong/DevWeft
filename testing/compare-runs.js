/** Evidence-aware comparison of two runs from one repository. */
function reportOf(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function checksOf(run) {
  const checks = Array.isArray(reportOf(run.report_json).checks) ? reportOf(run.report_json).checks : []
  return new Map(checks.filter((item) => item && (item.caseKey || item.name))
    .map((item) => [String(item.caseKey || item.name), item]))
}

async function frozenConfig(db, bindingId) {
  const row = await db.prepare(
    `SELECT b.suite_plan_id, sp.lock_sha256 AS suite_lock_sha256,
            b.required_case_set_sha256, b.execution_profile_revision_id,
            p.content_sha256 AS profile_sha256, b.runner_image_id,
            i.manifest_sha256 AS image_manifest_sha256, b.policy_revision_id,
            pr.content_sha256 AS policy_sha256
     FROM test_bindings b
     LEFT JOIN suite_plans sp ON sp.suite_plan_id = b.suite_plan_id
     LEFT JOIN execution_profile_revisions p ON p.profile_revision_id = b.execution_profile_revision_id
     LEFT JOIN runner_images i ON i.image_id = b.runner_image_id
     LEFT JOIN policy_revisions pr ON pr.policy_revision_id = b.policy_revision_id
     WHERE b.binding_id = ?`
  ).get(bindingId)
  if (!row) return null
  return {
    suitePlanId: row.suite_plan_id,
    suiteLockSha256: row.suite_lock_sha256 || null,
    requiredCaseSetSha256: row.required_case_set_sha256,
    profileRevisionId: row.execution_profile_revision_id,
    profileSha256: row.profile_sha256 || null,
    runnerImageId: row.runner_image_id,
    imageManifestSha256: row.image_manifest_sha256 || null,
    policyRevisionId: row.policy_revision_id,
    policySha256: row.policy_sha256 || null,
  }
}

export async function compareTestRuns(db, leftRunId, rightRunId) {
  if (!leftRunId || !rightRunId || leftRunId === rightRunId) return { error: '需要两个不同的 runId', status: 400 }
  const select = `SELECT run_id, repo_id, binding_id, run_group_id, unit, side, purpose,
                         status, terminal_reason, total_ms, created_at, started_at,
                         finished_at, report_json
                  FROM test_runs WHERE run_id = ?`
  const [left, right] = await Promise.all([
    db.prepare(select).get(leftRunId), db.prepare(select).get(rightRunId),
  ])
  if (!left || !right) return { error: '运行不存在', status: 404 }
  if (left.repo_id !== right.repo_id) return { error: '跨仓运行不能比较', status: 403 }

  const [leftConfig, rightConfig] = await Promise.all([
    frozenConfig(db, left.binding_id), frozenConfig(db, right.binding_id),
  ])
  const leftChecks = checksOf(left), rightChecks = checksOf(right)
  const leftKeys = [...leftChecks.keys()].sort(), rightKeys = [...rightChecks.keys()].sort()
  const leftSet = new Set(leftKeys), rightSet = new Set(rightKeys)
  const added = rightKeys.filter((key) => !leftSet.has(key))
  const removed = leftKeys.filter((key) => !rightSet.has(key))
  const common = leftKeys.filter((key) => rightSet.has(key))
  const statusChanges = common.filter((key) => leftChecks.get(key).status !== rightChecks.get(key).status)
    .map((caseKey) => ({ caseKey, before: leftChecks.get(caseKey).status || 'unknown', after: rightChecks.get(caseKey).status || 'unknown' }))
  const failedChecks = (run, checks) => [...checks].filter(([, check]) => ['failed', 'error'].includes(check.status))
    .map(([caseKey, check]) => ({ caseKey, status: check.status, detail: String(check.detail || '').slice(0, 500) }))
  const configKeys = ['suitePlanId', 'suiteLockSha256', 'requiredCaseSetSha256', 'profileRevisionId', 'profileSha256', 'runnerImageId', 'imageManifestSha256', 'policyRevisionId', 'policySha256']
  const configuration = Object.fromEntries(configKeys.map((key) => [key, {
    before: leftConfig?.[key] ?? null, after: rightConfig?.[key] ?? null,
    equal: leftConfig != null && rightConfig != null && leftConfig[key] === rightConfig[key],
  }]))
  const laneEqual = left.unit === right.unit && left.side === right.side && left.purpose === right.purpose
  const caseSetEqual = added.length === 0 && removed.length === 0
  const configurationEqual = leftConfig != null && rightConfig != null && configKeys.every((key) => configuration[key].equal)
  const reasons = []
  if (!laneEqual) reasons.push('执行单元、side 或运行用途不同')
  if (!caseSetEqual) reasons.push('检查项集合发生变化')
  if (!configurationEqual) reasons.push('冻结套件、配置、镜像或策略不同/缺失')
  return {
    ok: true,
    comparable: reasons.length === 0,
    comparabilityReasons: reasons,
    left: { runId: left.run_id, status: left.status, terminalReason: left.terminal_reason, unit: left.unit, side: left.side, purpose: left.purpose, durationMs: left.total_ms, createdAt: left.created_at, finishedAt: left.finished_at },
    right: { runId: right.run_id, status: right.status, terminalReason: right.terminal_reason, unit: right.unit, side: right.side, purpose: right.purpose, durationMs: right.total_ms, createdAt: right.created_at, finishedAt: right.finished_at },
    configuration,
    caseSet: { equal: caseSetEqual, added, removed, common: common.length },
    statusChanges,
    failedChecks: { before: failedChecks(left, leftChecks), after: failedChecks(right, rightChecks) },
    durationDeltaMs: Number.isFinite(left.total_ms) && Number.isFinite(right.total_ms) ? right.total_ms - left.total_ms : null,
    denominator: { before: leftChecks.size, after: rightChecks.size, common: common.length },
  }
}
