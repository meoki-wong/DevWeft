import { ApiError } from './errors.js'
import { filterCasesForUnit } from '../runner/guest-agent/units.mjs'

export const EXPLANATION_REASON_CODES = Object.freeze({
  RUN_VALUE: 'VALUE_FROZEN_ON_RUN',
  GROUP_UNITS: 'REQUIRED_BY_RUN_GROUP',
  SUITE_CASE: 'LOCKED_IN_SUITE_PLAN',
  PROFILE: 'PROFILE_FROZEN_BY_BINDING',
  IMAGE: 'IMAGE_FROZEN_BY_BINDING',
  POLICY: 'POLICY_FROZEN_BY_BINDING',
})

function parseJson(value, fallback = null) {
  try { return typeof value === 'string' ? JSON.parse(value) : fallback } catch { return fallback }
}

function safeProfile(profileJson) {
  const profile = parseJson(profileJson, {}) || {}
  const timeouts = profile.timeouts && typeof profile.timeouts === 'object' && !Array.isArray(profile.timeouts)
    ? Object.fromEntries(Object.entries(profile.timeouts).filter(([, value]) => Number.isFinite(Number(value))))
    : null
  return {
    timeouts,
    networkPolicyId: typeof profile.networkPolicyId === 'string' ? profile.networkPolicyId : null,
  }
}

/** Read the immutable run, suite, profile, image, and policy records that explain a run's choices. */
export async function explainTestRun(db, runId, { repoSlug = null } = {}) {
  if (typeof runId !== 'string' || runId.length < 1 || runId.length > 128) throw new ApiError('INVALID_SCHEMA')
  const row = await db.prepare(
    `SELECT tr.run_id, tr.repo_id, tr.run_group_id, tr.binding_id, tr.unit, tr.side, tr.purpose,
            tr.status, tr.terminal_reason, tr.diagnostic_of_run_id, tr.created_at,
            repo.slug AS repo_slug,
            rg.kind AS group_kind, rg.required_units_json,
            b.suite_plan_id, b.execution_profile_revision_id, b.runner_image_id,
            b.runner_image_manifest_sha256, b.policy_revision_id, b.resolved_sides_json,
            sp.lock_sha256 AS suite_lock_sha256, sp.required_case_set_sha256,
            sp.advisory_case_set_sha256, sp.canonical_lock_json, sp.resolved_sides_json AS plan_sides_json,
            snap.snapshot_kind, snap.head_commit_oid, snap.changed_paths_sha256,
            profile.name AS profile_name, profile.revision AS profile_revision,
            profile.content_sha256 AS profile_content_sha256, profile.profile_json,
            image.manifest_sha256 AS image_manifest_sha256, image.state AS image_state,
            policy.name AS policy_name, policy.revision AS policy_revision,
            policy.content_sha256 AS policy_content_sha256
     FROM test_runs tr
     JOIN repositories repo ON repo.repo_id=tr.repo_id
     JOIN run_groups rg ON rg.run_group_id=tr.run_group_id
     JOIN test_bindings b ON b.binding_id=tr.binding_id
     JOIN suite_plans sp ON sp.suite_plan_id=b.suite_plan_id
     JOIN business_snapshots snap ON snap.snapshot_id=b.snapshot_id
     JOIN execution_profile_revisions profile ON profile.profile_revision_id=b.execution_profile_revision_id
     JOIN runner_images image ON image.image_id=b.runner_image_id
     JOIN policy_revisions policy ON policy.policy_revision_id=b.policy_revision_id
     WHERE tr.run_id=?`
  ).get(runId)
  if (!row) throw new ApiError('RUN_NOT_FOUND')
  if (repoSlug && row.repo_slug !== repoSlug) throw new ApiError('CROSS_REPO_REFERENCE')

  const plan = parseJson(row.canonical_lock_json, {}) || {}
  const layers = await db.prepare(
    `SELECT l.position, l.layer, l.overlay_id, l.suite_revision_id, l.effective_approval, l.content_sha256,
            r.manifest_json
     FROM suite_plan_layers l
     JOIN suite_revisions r ON r.suite_revision_id=l.suite_revision_id
     WHERE l.suite_plan_id=? ORDER BY l.position`
  ).all(row.suite_plan_id)
  const layerByRevision = new Map()
  for (const layer of layers) {
    const manifest = parseJson(layer.manifest_json, {}) || {}
    layerByRevision.set(layer.suite_revision_id, {
      position: Number(layer.position),
      layer: layer.layer,
      overlayId: layer.overlay_id,
      suiteRevisionId: layer.suite_revision_id,
      approval: layer.effective_approval,
      contentSha256: layer.content_sha256,
      title: typeof manifest.title === 'string' ? manifest.title : null,
      cases: Array.isArray(manifest.cases) ? manifest.cases : [],
    })
  }
  const lockedCases = (Array.isArray(plan.cases) ? plan.cases : []).map((locked) => {
    const source = layerByRevision.get(locked.suiteRevisionId)
    const definition = source?.cases.find((item) => item.caseKey === locked.caseKey) || null
    return {
      caseKey: locked.caseKey,
      title: definition?.title || locked.caseKey,
      tags: Array.isArray(definition?.tags) ? definition.tags : [],
      protected: Boolean(locked.protected),
      requiredCapabilities: Array.isArray(definition?.requiredCapabilities) ? definition.requiredCapabilities : [],
      reasonCode: EXPLANATION_REASON_CODES.SUITE_CASE,
      source: {
        suitePlanId: row.suite_plan_id,
        lockSha256: row.suite_lock_sha256,
        layer: source?.layer || null,
        overlayId: locked.overlayId || source?.overlayId || null,
        suiteRevisionId: locked.suiteRevisionId || null,
        revisionContentSha256: source?.contentSha256 || null,
      },
    }
  })
  const selectedCaseKeys = new Set(filterCasesForUnit(plan.cases, { unit: row.unit, side: row.side }).map((item) => item.caseKey))
  const casesForRun = lockedCases.map((item) => ({
    ...item,
    selectedForRun: selectedCaseKeys.has(item.caseKey),
    runSelectionReasonCode: selectedCaseKeys.has(item.caseKey)
      ? 'MATCHED_RUN_UNIT_AND_SIDE'
      : 'FILTERED_BY_RUN_UNIT_AND_SIDE',
  }))
  const selectedCases = casesForRun.filter((item) => item.selectedForRun)
  const resolvedSides = parseJson(row.resolved_sides_json, parseJson(row.plan_sides_json, []))
  const requiredUnits = parseJson(row.required_units_json, [])

  return {
    schemaVersion: 1,
    runId: row.run_id,
    repo: row.repo_slug,
    status: row.status,
    explanationBasis: 'immutable run, binding, suite plan, and revision records',
    selection: {
      lane: {
        unit: row.unit,
        side: row.side,
        purpose: row.purpose,
        reasonCode: EXPLANATION_REASON_CODES.RUN_VALUE,
        source: ['test_runs.unit', 'test_runs.side', 'test_runs.purpose'],
      },
      group: {
        kind: row.group_kind,
        requiredUnits: Array.isArray(requiredUnits) ? requiredUnits : [],
        reasonCode: EXPLANATION_REASON_CODES.GROUP_UNITS,
        source: 'run_groups.required_units_json',
      },
      suite: {
        suitePlanId: row.suite_plan_id,
        lockSha256: row.suite_lock_sha256,
        requiredCaseSetSha256: row.required_case_set_sha256,
        advisoryCaseSetSha256: row.advisory_case_set_sha256,
        resolvedSides: Array.isArray(resolvedSides) ? resolvedSides : [],
        layers: [...layerByRevision.values()].map(({ cases: _cases, ...layer }) => layer),
        lockedCases: casesForRun,
        selectedCases,
        reasonCode: EXPLANATION_REASON_CODES.SUITE_CASE,
        source: 'suite_plans.canonical_lock_json',
      },
    },
    environment: {
      executionProfile: {
        profileRevisionId: row.execution_profile_revision_id,
        name: row.profile_name,
        revision: Number(row.profile_revision),
        contentSha256: row.profile_content_sha256,
        ...safeProfile(row.profile_json),
        reasonCode: EXPLANATION_REASON_CODES.PROFILE,
        source: 'test_bindings.execution_profile_revision_id',
      },
      runnerImage: {
        imageId: row.runner_image_id,
        manifestSha256: row.runner_image_manifest_sha256,
        currentManifestSha256: row.image_manifest_sha256,
        state: row.image_state,
        reasonCode: EXPLANATION_REASON_CODES.IMAGE,
        source: 'test_bindings.runner_image_id and runner_image_manifest_sha256',
      },
      policyRevision: {
        policyRevisionId: row.policy_revision_id,
        name: row.policy_name,
        revision: Number(row.policy_revision),
        contentSha256: row.policy_content_sha256,
        reasonCode: EXPLANATION_REASON_CODES.POLICY,
        source: 'test_bindings.policy_revision_id',
      },
      snapshot: {
        kind: row.snapshot_kind,
        headCommitOid: row.head_commit_oid,
        changedPathsSha256: row.changed_paths_sha256,
      },
    },
    run: {
      runGroupId: row.run_group_id,
      bindingId: row.binding_id,
      diagnosticOfRunId: row.diagnostic_of_run_id || null,
      terminalReason: row.terminal_reason || null,
      createdAt: row.created_at,
    },
  }
}
