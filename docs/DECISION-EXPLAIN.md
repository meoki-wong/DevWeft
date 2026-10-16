# Test-run decision explanation

DevWeft exposes the explanation through `GET /v1/test-runs/{runId}/explain` and the MCP tool `awp_test_explain({ runId, repo })`. The REST endpoint requires `read_result` permission for the run's repository. The MCP call needs a repository slug or a connection already bound to one.

The response reads the immutable run, run group, binding, suite lock, suite revision, execution profile, runner image, and policy revision records. It does not re-resolve the suite, schedule a run, write an audit event, or return secret references or profile secret values.

## Stable reason codes

| Code | Meaning | Evidence source |
|---|---|---|
| `VALUE_FROZEN_ON_RUN` | Unit, side, and purpose are values recorded for this run. | `test_runs.unit`, `test_runs.side`, `test_runs.purpose` |
| `REQUIRED_BY_RUN_GROUP` | The required lane list was stored on the run group. | `run_groups.required_units_json` |
| `LOCKED_IN_SUITE_PLAN` | The listed case is in the immutable suite lock; `selectedCases` applies the same unit/side filter used by the Guest Agent. | `suite_plans.canonical_lock_json` and referenced suite revision |
| `MATCHED_RUN_UNIT_AND_SIDE` | A locked case matches the run's unit and side filter. | Guest Agent `filterCasesForUnit` |
| `FILTERED_BY_RUN_UNIT_AND_SIDE` | A case belongs to the suite lock but is outside this run's unit/side selection. | Guest Agent `filterCasesForUnit` |
| `PROFILE_FROZEN_BY_BINDING` | The execution profile revision was fixed by the run binding. | `test_bindings.execution_profile_revision_id` |
| `IMAGE_FROZEN_BY_BINDING` | The runner image and expected manifest digest were fixed by the run binding. The response also shows the current image-row digest to reveal drift. | `test_bindings.runner_image_id`, `test_bindings.runner_image_manifest_sha256`, `runner_images` |
| `POLICY_FROZEN_BY_BINDING` | The policy revision was fixed by the run binding. | `test_bindings.policy_revision_id` |

`lockedCases` shows all cases in the suite plan, including `selectedForRun` and `runSelectionReasonCode`. `selectedCases` shows only cases selected for this run's unit and side. Each case includes its suite layer, overlay, revision, and content digest. The explanation reports recorded provenance; it does not invent why an earlier planner preferred a profile or policy if that rationale was not persisted.

The explanation is diagnostic. It does not change the gate result or substitute for checking the signed run report and artifact.
