-- sql/postgres/baseline.sql
-- 方案第 7 节：SQLite 全部迁移（v1–v43）跑完后的最终结构基线（含第 1–5 节列）。
-- 由 scripts/gen-postgres-baseline.mjs 生成；不要手工编辑 schema，变更后重新生成。
-- 布尔语义列落地为 SMALLINT 0/1（与 sqlite/应用层同构；导入不做类型转换）。
-- 时间列保持 TEXT ISO，不改 timestamptz（§13.1）。
-- tenant_id 为真正的 NOT NULL 列（SQLite 侧由触发器强制，此处落地列约束）。
-- postgres_baseline 登记由 db/postgres-baseline.js 写入（版本 = MAX(非基线 version)+1，不在此硬编码）。

BEGIN;

CREATE TABLE principals (
  principal_id  TEXT PRIMARY KEY,
  subject       TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('active','disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE repositories (
  repo_id             TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  default_target_ref  TEXT NOT NULL,
  enabled             SMALLINT NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE task_instances (
  task_instance_id       TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  external_task_id       TEXT NOT NULL,
  epoch                  BIGINT NOT NULL DEFAULT 1 CHECK(epoch > 0),
  revision               BIGINT NOT NULL DEFAULT 1 CHECK(revision > 0),
  phase                  TEXT NOT NULL CHECK(phase IN (
    'RECEIVE','CLASSIFY','LOCATE','PLAN','EXECUTE','VERIFY','DISTILL','DONE','ABORTED'
  )),
  size                   TEXT CHECK(size IN ('S','M','L')),
  type                   TEXT CHECK(type IN ('FEATURE','UI_DEV','FIX','INTEGRATION','RELEASE')),
  active_binding_id      TEXT,
  status                 TEXT NOT NULL CHECK(status IN ('open','done','aborted')),
  author_principal_id    TEXT NOT NULL REFERENCES principals(principal_id),
  legacy_snapshot_json   TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  closed_at              TEXT,
  UNIQUE(repo_id, external_task_id, epoch),
  UNIQUE(repo_id, task_instance_id)
);

CREATE TABLE execution_profile_revisions (
  profile_revision_id  TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  name                 TEXT NOT NULL,
  revision             BIGINT NOT NULL CHECK(revision > 0),
  content_sha256       TEXT NOT NULL,
  profile_json         TEXT NOT NULL,
  state                TEXT NOT NULL CHECK(state IN ('canary','active','deprecated','revoked')),
  created_by           TEXT NOT NULL REFERENCES principals(principal_id),
  created_at           TEXT NOT NULL,
  UNIQUE(repo_id, name, revision),
  UNIQUE(repo_id, content_sha256),
  UNIQUE(repo_id, profile_revision_id)
);

CREATE TABLE git_remotes (
  remote_id              TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  provider               TEXT NOT NULL CHECK(provider IN ('gitlab','github','generic')),
  provider_instance      TEXT NOT NULL,
  provider_project_id    TEXT,
  canonical_url          TEXT NOT NULL,
  url_fingerprint        TEXT NOT NULL UNIQUE,
  relationship           TEXT NOT NULL CHECK(relationship IN ('canonical','fork','mirror')),
  upstream_remote_id     TEXT REFERENCES git_remotes(remote_id),
  enabled                SMALLINT NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at             TEXT NOT NULL
);

CREATE TABLE branch_incarnations (
  branch_incarnation_id  TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  remote_id              TEXT NOT NULL REFERENCES git_remotes(remote_id),
  full_ref               TEXT NOT NULL,
  generation             BIGINT NOT NULL CHECK(generation > 0),
  anchor_commit_oid      TEXT NOT NULL,
  last_observed_tip_oid  TEXT NOT NULL,
  provider_ref_version   TEXT,
  state                  TEXT NOT NULL CHECK(state IN ('active','rebased','deleted','superseded')),
  created_at             TEXT NOT NULL,
  superseded_at          TEXT,
  UNIQUE(remote_id, full_ref, generation),
  UNIQUE(repo_id, branch_incarnation_id)
);

CREATE TABLE suite_plans (
  suite_plan_id               TEXT PRIMARY KEY,
  repo_id                     TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id            TEXT NOT NULL,
  branch_incarnation_id       TEXT,
  policy_revision_id          TEXT NOT NULL,
  resolved_sides_json         TEXT NOT NULL,
  changed_paths_sha256        TEXT NOT NULL,
  effective_suite_tree_oid    TEXT NOT NULL,
  lock_sha256                 TEXT NOT NULL UNIQUE,
  canonical_lock_json         TEXT NOT NULL,
  required_case_set_sha256    TEXT NOT NULL,
  advisory_case_set_sha256    TEXT NOT NULL,
  created_at                  TEXT NOT NULL,
  UNIQUE(repo_id, suite_plan_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id),
  FOREIGN KEY(repo_id, branch_incarnation_id)
    REFERENCES branch_incarnations(repo_id, branch_incarnation_id)
);

CREATE TABLE business_snapshots (
  snapshot_id                TEXT PRIMARY KEY,
  repo_id                    TEXT NOT NULL REFERENCES repositories(repo_id),
  source_remote_id           TEXT NOT NULL REFERENCES git_remotes(remote_id),
  branch_incarnation_id      TEXT,
  snapshot_kind              TEXT NOT NULL CHECK(snapshot_kind IN ('clean_commit','dirty_workspace','mr_merge')),
  object_format              TEXT NOT NULL CHECK(object_format IN ('sha1','sha256')),
  source_ref                 TEXT,
  head_commit_oid            TEXT NOT NULL,
  snapshot_commit_oid        TEXT NOT NULL,
  snapshot_tree_oid          TEXT NOT NULL,
  changed_paths_sha256       TEXT NOT NULL,
  target_remote_id           TEXT NOT NULL REFERENCES git_remotes(remote_id),
  target_ref                 TEXT NOT NULL,
  target_commit_oid          TEXT NOT NULL,
  bundle_sha256              TEXT NOT NULL,
  bundle_size                BIGINT NOT NULL CHECK(bundle_size > 0),
  mr_provider_project_id     TEXT,
  mr_iid                     TEXT,
  mr_source_commit_oid       TEXT,
  mr_target_commit_oid       TEXT,
  merge_result_commit_oid    TEXT,
  merge_result_tree_oid      TEXT,
  created_by                 TEXT NOT NULL REFERENCES principals(principal_id),
  created_at                 TEXT NOT NULL, changed_files_json TEXT,
  UNIQUE(repo_id, snapshot_id),
  FOREIGN KEY(repo_id, branch_incarnation_id)
    REFERENCES branch_incarnations(repo_id, branch_incarnation_id)
);

CREATE TABLE policy_revisions (
  policy_revision_id  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  revision            BIGINT NOT NULL CHECK(revision > 0),
  content_sha256      TEXT NOT NULL UNIQUE,
  policy_json         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK(state IN ('canary','active','deprecated','revoked')),
  created_by          TEXT NOT NULL REFERENCES principals(principal_id),
  created_at          TEXT NOT NULL,
  UNIQUE(name, revision)
);

CREATE TABLE runner_images (
  image_id          TEXT PRIMARY KEY,
  manifest_sha256   TEXT NOT NULL UNIQUE,
  vhdx_sha256       TEXT NOT NULL UNIQUE,
  manifest_json     TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('canary','active','retired','revoked')),
  created_at        TEXT NOT NULL,
  retired_at        TEXT
);

CREATE TABLE test_bindings (
  binding_id                    TEXT PRIMARY KEY,
  repo_id                       TEXT NOT NULL REFERENCES repositories(repo_id),
  snapshot_id                   TEXT NOT NULL,
  suite_plan_id                 TEXT NOT NULL,
  task_instance_id              TEXT NOT NULL,
  execution_profile_revision_id TEXT NOT NULL REFERENCES execution_profile_revisions(profile_revision_id),
  runner_image_id               TEXT NOT NULL REFERENCES runner_images(image_id),
  runner_image_manifest_sha256  TEXT NOT NULL,
  policy_revision_id            TEXT NOT NULL REFERENCES policy_revisions(policy_revision_id),
  resolved_sides_json           TEXT NOT NULL,
  changed_paths_sha256          TEXT NOT NULL,
  required_case_set_sha256      TEXT NOT NULL,
  canonical_binding_json        TEXT NOT NULL,
  state                         TEXT NOT NULL CHECK(state IN ('active','superseded','stale','revoked')),
  stale_reason                  TEXT,
  created_at                    TEXT NOT NULL,
  UNIQUE(repo_id, binding_id),
  FOREIGN KEY(repo_id, snapshot_id)
    REFERENCES business_snapshots(repo_id, snapshot_id),
  FOREIGN KEY(repo_id, suite_plan_id)
    REFERENCES suite_plans(repo_id, suite_plan_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id),
  FOREIGN KEY(repo_id, execution_profile_revision_id)
    REFERENCES execution_profile_revisions(repo_id, profile_revision_id)
);

CREATE TABLE test_submissions (
  submission_id          TEXT PRIMARY KEY,
  client_request_id      TEXT NOT NULL,
  principal_id           TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id       TEXT NOT NULL REFERENCES task_instances(task_instance_id),
  binding_id             TEXT NOT NULL REFERENCES test_bindings(binding_id),
  expected_task_revision BIGINT NOT NULL,
  status                 TEXT NOT NULL CHECK(status IN (
    'planned','queued','running','passed','failed','error',
    'canceled','timed_out','superseded'
  )),
  created_at             TEXT NOT NULL,
  started_at             TEXT,
  finished_at            TEXT,
  UNIQUE(principal_id, client_request_id),
  UNIQUE(repo_id, submission_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id)
);

CREATE TABLE run_groups (
  run_group_id        TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  submission_id       TEXT NOT NULL REFERENCES test_submissions(submission_id),
  binding_id          TEXT NOT NULL REFERENCES test_bindings(binding_id),
  kind                TEXT NOT NULL CHECK(kind IN ('formal','candidate')),
  gate_eligible       BIGINT NOT NULL CHECK(gate_eligible IN (0,1)),
  required_units_json TEXT NOT NULL,
  status              TEXT NOT NULL CHECK(status IN (
    'queued','running','passed','failed','error','canceled','timed_out','superseded'
  )),
  created_at          TEXT NOT NULL,
  UNIQUE(repo_id, run_group_id),
  FOREIGN KEY(repo_id, submission_id)
    REFERENCES test_submissions(repo_id, submission_id),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id)
);

CREATE TABLE "test_runs" (
  run_id               TEXT PRIMARY KEY,
  run_group_id         TEXT NOT NULL REFERENCES run_groups(run_group_id),
  binding_id           TEXT NOT NULL REFERENCES test_bindings(binding_id),
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id     TEXT NOT NULL REFERENCES task_instances(task_instance_id),
  unit                 TEXT NOT NULL CHECK(unit IN ('static','smoke')),
  side                 TEXT NOT NULL CHECK(length(trim(side)) > 0),
  purpose              TEXT NOT NULL DEFAULT 'gate' CHECK(purpose IN ('gate','diagnostic','mutation')),
  diagnostic_of_run_id TEXT REFERENCES "test_runs"(run_id),
  priority             BIGINT NOT NULL DEFAULT 5,
  status               TEXT NOT NULL CHECK(status IN (
    'queued','active','passed','failed','error','canceled',
    'timed_out','lost','superseded'
  )),
  desired_state        TEXT NOT NULL DEFAULT 'running'
                         CHECK(desired_state IN ('running','canceled')),
  max_attempts         BIGINT NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 3),
  next_attempt         BIGINT NOT NULL DEFAULT 0 CHECK(next_attempt >= 0),
  lease_epoch          BIGINT NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  queue_wait_ms        BIGINT,
  total_ms             BIGINT,
  result_sha256        TEXT,
  report_json          TEXT,
  terminal_reason      TEXT CHECK(terminal_reason IN (
    'assertion_failed','dependency_input','product_hang','lost','timed_out',
    'infra_error','canceled','superseded'
  )),
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  payload_json         TEXT,
  steps_json           TEXT,
  coverage_complete    BIGINT,
  UNIQUE(repo_id, run_id),
  FOREIGN KEY(repo_id, run_group_id)
    REFERENCES run_groups(repo_id, run_group_id),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE TABLE workers (
  worker_id          TEXT PRIMARY KEY,
  certificate_thumbprint TEXT NOT NULL UNIQUE,
  hostname           TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('active','draining','offline','revoked')),
  last_heartbeat_at  TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE run_attempts (
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt            BIGINT NOT NULL CHECK(attempt > 0),
  worker_id          TEXT NOT NULL REFERENCES workers(worker_id),
  lease_epoch        BIGINT NOT NULL CHECK(lease_epoch > 0),
  status             TEXT NOT NULL CHECK(status IN (
    'reserved','leased','provisioning','running','uploading','passed','failed',
    'error','canceled','timed_out','lost'
  )),
  image_id           TEXT NOT NULL REFERENCES runner_images(image_id),
  guest_public_key   TEXT,
  guest_key_sha256   TEXT,
  vm_id              TEXT,
  heartbeat_at       TEXT,
  started_at         TEXT,
  finished_at        TEXT,
  error_code         TEXT,
  error_detail       TEXT, steps_json TEXT,
  PRIMARY KEY(run_id, attempt),
  UNIQUE(run_id, attempt, lease_epoch),
  UNIQUE(repo_id, run_id, attempt),
  FOREIGN KEY(repo_id, run_id)
    REFERENCES test_runs(repo_id, run_id)
);

CREATE TABLE "accepted_run_results" (
  run_id             TEXT NOT NULL,
  attempt            BIGINT NOT NULL,
  lease_epoch        BIGINT NOT NULL,
  result_sha256      TEXT NOT NULL,
  accepted_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt, lease_epoch),
  FOREIGN KEY(run_id) REFERENCES test_runs(run_id),
  FOREIGN KEY(run_id, attempt, lease_epoch)
    REFERENCES run_attempts(run_id, attempt, lease_epoch)
);

CREATE TABLE artifacts (
  artifact_id        TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt            BIGINT NOT NULL,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  binding_id         TEXT NOT NULL REFERENCES test_bindings(binding_id),
  storage_key        TEXT NOT NULL UNIQUE,
  manifest_sha256    TEXT NOT NULL,
  archive_sha256     TEXT NOT NULL,
  size               BIGINT NOT NULL CHECK(size >= 0),
  artifact_truncated BIGINT NOT NULL DEFAULT 0 CHECK(artifact_truncated IN (0,1)),
  scan_state         TEXT NOT NULL DEFAULT 'pending'
                     CHECK(scan_state IN ('pending','passed','rejected','error')),
  scanner_report_sha256 TEXT,
  created_at         TEXT NOT NULL,
  expire_at          TEXT NOT NULL,
  deleted_at         TEXT,
  FOREIGN KEY(run_id, attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY(repo_id, run_id, attempt)
    REFERENCES run_attempts(repo_id, run_id, attempt),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id)
);

CREATE TABLE audit_events (
      id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      event_type    TEXT NOT NULL,
      session_id    TEXT,
      tool_name     TEXT,
      method        TEXT,
      author        TEXT,
      repo          TEXT,
      task_id       TEXT,
      client_name   TEXT,
      args_preview  TEXT,
      status        TEXT DEFAULT 'ok',
      duration_ms   BIGINT,
      created_at    TEXT NOT NULL,
      detail        TEXT
    , trace_id TEXT, submission_id TEXT, run_id TEXT, attempt BIGINT, binding_id TEXT, payload_json TEXT, phase TEXT);

CREATE TABLE branch_ref_observations (
  observation_id        TEXT PRIMARY KEY,
  remote_id             TEXT NOT NULL REFERENCES git_remotes(remote_id),
  full_ref              TEXT NOT NULL,
  provider_ref_version  TEXT,
  old_tip_oid           TEXT,
  new_tip_oid           TEXT,
  observed_state        TEXT NOT NULL CHECK(observed_state IN ('present','deleted')),
  ancestry_result       TEXT NOT NULL CHECK(ancestry_result IN ('first','fast_forward','non_fast_forward','deleted','recreated')),
  resulting_generation  BIGINT NOT NULL,
  observed_at           TEXT NOT NULL,
  UNIQUE(remote_id, full_ref, provider_ref_version)
);

CREATE TABLE suite_overlays (
  overlay_id              TEXT PRIMARY KEY,
  logical_name            TEXT NOT NULL,
  layer                   TEXT NOT NULL CHECK(layer IN ('stable','repo','branch','task')),
  repo_id                 TEXT REFERENCES repositories(repo_id),
  branch_incarnation_id   TEXT,
  task_instance_id        TEXT,
  ordinal                 BIGINT NOT NULL DEFAULT 0,
  protected               BIGINT NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  state                   TEXT NOT NULL CHECK(state IN ('active','deprecated','revoked')),
  created_by              TEXT NOT NULL REFERENCES principals(principal_id),
  created_at              TEXT NOT NULL,
  CHECK(
    (layer='stable' AND repo_id IS NULL AND branch_incarnation_id IS NULL AND task_instance_id IS NULL)
    OR (layer='repo' AND repo_id IS NOT NULL AND branch_incarnation_id IS NULL AND task_instance_id IS NULL)
    OR (layer='branch' AND repo_id IS NOT NULL AND branch_incarnation_id IS NOT NULL AND task_instance_id IS NULL)
    OR (layer='task' AND repo_id IS NOT NULL AND branch_incarnation_id IS NULL AND task_instance_id IS NOT NULL)
  ),
  FOREIGN KEY(repo_id, branch_incarnation_id)
    REFERENCES branch_incarnations(repo_id, branch_incarnation_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE TABLE suite_revisions (
  suite_revision_id          TEXT PRIMARY KEY,
  overlay_id                 TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  revision                   BIGINT NOT NULL CHECK(revision > 0),
  source_kind                TEXT NOT NULL CHECK(source_kind IN ('reviewed_git','generated','imported')),
  source_commit_oid          TEXT,
  source_tree_path           TEXT,
  registry_commit_oid        TEXT,
  tree_oid                   TEXT NOT NULL,
  content_sha256             TEXT NOT NULL,
  manifest_sha256            TEXT NOT NULL,
  manifest_json              TEXT NOT NULL,
  approval_state             TEXT NOT NULL CHECK(approval_state IN (
    'unreviewed','executable','reviewed','rejected'
  )),
  publication_state          TEXT NOT NULL CHECK(publication_state IN (
    'draft','active','deprecated','revoked'
  )),
  previous_revision_id       TEXT REFERENCES suite_revisions(suite_revision_id),
  generated_by_model         TEXT,
  generated_from_binding_id  TEXT,
  expires_at                 TEXT,
  created_by                 TEXT NOT NULL REFERENCES principals(principal_id),
  created_at                 TEXT NOT NULL,
  UNIQUE(overlay_id, revision),
  UNIQUE(overlay_id, content_sha256, manifest_sha256)
);

CREATE TABLE candidate_binding_approvals (
  approval_id                       TEXT PRIMARY KEY,
  repo_id                           TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id                  TEXT NOT NULL,
  branch_incarnation_id             TEXT REFERENCES branch_incarnations(branch_incarnation_id),
  candidate_suite_revision_id       TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  effective_approval                TEXT NOT NULL DEFAULT 'pending'
    CHECK(effective_approval IN ('pending','approved','rejected','expired')),
  candidate_author_principal_id     TEXT NOT NULL REFERENCES principals(principal_id),
  reviewer_principal_id             TEXT NOT NULL REFERENCES principals(principal_id),
  reviewed_at                       TEXT,
  review_note                       TEXT,
  expires_at                        TEXT NOT NULL,
  created_at                        TEXT NOT NULL,
  CHECK(reviewer_principal_id <> candidate_author_principal_id),
  FOREIGN KEY(task_instance_id) REFERENCES task_instances(task_instance_id)
);

CREATE TABLE promotion_proposals (
  proposal_id              TEXT PRIMARY KEY,
  repo_id                  TEXT NOT NULL REFERENCES repositories(repo_id),
  target_suite_revision_id TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  base_suite_revision_id   TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  author_principal_id      TEXT NOT NULL REFERENCES principals(principal_id),
  state                    TEXT NOT NULL DEFAULT 'proposed'
    CHECK(state IN ('proposed','diffing','replaying','reviewing','merging','published','rejected')),
  structured_diff_json     TEXT,
  replay_summary_json      TEXT,
  published_revision_id    TEXT REFERENCES suite_revisions(suite_revision_id),
  published_at             TEXT,
  proposed_at              TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  CHECK(published_at IS NULL OR state='published'),
  CHECK(author_principal_id IS NOT NULL)
);

CREATE TABLE candidate_replay_runs (
  replay_run_id         TEXT PRIMARY KEY,
  proposal_id           TEXT NOT NULL REFERENCES promotion_proposals(proposal_id),
  business_snapshot_id  TEXT NOT NULL,
  status                TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed','error','canceled')),
  checks_passed_json    TEXT,
  started_at            TEXT NOT NULL,
  finished_at           TEXT
);

CREATE TABLE deferred_submissions (
          deferred_id              TEXT PRIMARY KEY,
          client_request_id        TEXT NOT NULL,
          repo_id                  TEXT NOT NULL,
          task_id                  TEXT NOT NULL,
          author                   TEXT NOT NULL,
          side                     TEXT NOT NULL,
          side_reason              TEXT,
          source_ref               TEXT,
          code_commit_oid          TEXT,
          code_diff                TEXT NOT NULL,
          trigger_reason           TEXT,
          product_fixed            BIGINT NOT NULL DEFAULT 0,
          suite_fixed              BIGINT NOT NULL DEFAULT 0,
          status                   TEXT NOT NULL DEFAULT 'pending'
                                     CHECK(status IN ('pending','claimed','processed','failed')),
          claimed_by_worker        TEXT,
          claimed_at               TEXT,
          processed_submission_id  TEXT,
          error_message            TEXT,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL, attempts BIGINT NOT NULL DEFAULT 0, max_attempts BIGINT NOT NULL DEFAULT 3, next_retry_at TEXT, last_error_class TEXT,
          UNIQUE(repo_id, client_request_id)
        );

CREATE TABLE docs (
      id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      repo        TEXT NOT NULL,
      name        TEXT NOT NULL,
      category    TEXT,
      content     TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      updated_by  TEXT, tenant_id TEXT NOT NULL,
      UNIQUE(repo, name)
    );

CREATE TABLE docs_versions (
      id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      repo           TEXT NOT NULL,
      name           TEXT NOT NULL,
      version        BIGINT NOT NULL DEFAULT 1,
      content_before TEXT,
      content_after  TEXT,
      category_before TEXT,
      category_after  TEXT,
      author         TEXT,
      created_at     TEXT NOT NULL, tenant_id TEXT NOT NULL,
      UNIQUE(repo, name, version)
    );

CREATE TABLE experience_feedback (
  feedback_id        TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT,
  failure_id         TEXT,
  experience_ref     TEXT,
  author             TEXT,
  source_type        TEXT NOT NULL CHECK(source_type IN ('run','manual','external')),
  failure_summary    TEXT NOT NULL,
  resolution_summary TEXT NOT NULL,
  scope_json         TEXT NOT NULL,
  evidence_json      TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
                     CHECK(verification_status IN ('unverified','confirmed','rejected')),
  created_at         TEXT NOT NULL,
  reviewed_at        TEXT,
  reviewed_by        TEXT,
  review_note        TEXT,
  CHECK(length(trim(failure_summary)) > 0),
  CHECK(length(trim(resolution_summary)) > 0)
);

CREATE TABLE test_failures (
  failure_id           TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  binding_id           TEXT,  -- 跨表引用在应用层校验（trigger 太严，绕开）
  task_instance_id     TEXT,
  failure_phase        TEXT NOT NULL CHECK(failure_phase IN (
    'snapshot','install','static','build','vite_start','smoke','artifact','unknown'
  )),
  failure_class        TEXT NOT NULL CHECK(failure_class IN (
    'unclassified','product','regression','dependency_input','product_hang',
    'flaky','infra','registry_infra','vm_infra','suite','environment'
  )),
  fingerprint_version  BIGINT NOT NULL,
  fingerprint          TEXT NOT NULL,
  case_key             TEXT,
  spec_file            TEXT,
  test_title           TEXT,
  error_signature      TEXT NOT NULL,
  occurrence_count     BIGINT NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'open' CHECK(status IN (
    'open','triaged','linked','dismissed','promoted'
  )),
  linked_experience_id TEXT,
  linked_suite_revision_id TEXT,  -- audit only, no FK
  review_note          TEXT,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL
, reviewed_by TEXT, reviewed_at TEXT);

CREATE TABLE experience_pending (
  pending_id     TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repositories(repo_id),
  source_id      TEXT NOT NULL,
  failure_class  TEXT NOT NULL,
  content        TEXT NOT NULL,
  title          TEXT,
  tags_json      TEXT,
  status         TEXT NOT NULL CHECK(status IN (
    'pending_review','linked_to_failure','promoted_to_experience','rejected'
  )),
  created_at     TEXT NOT NULL,
  reviewed_at    TEXT,
  reviewed_by    TEXT REFERENCES principals(principal_id),
  review_note    TEXT,
  linked_failure_id TEXT REFERENCES test_failures(failure_id),
  linked_experience_id TEXT
);

CREATE TABLE experience_sources (
  repo_id       TEXT NOT NULL REFERENCES repositories(repo_id),
  experience_id TEXT NOT NULL,
  source_type   TEXT NOT NULL CHECK(source_type IN ('test_failure','manual','ai_drift','verify_report')),
  source_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY(repo_id, experience_id, source_type, source_id)
);

CREATE TABLE experiences (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      content     TEXT NOT NULL,
      source      TEXT DEFAULT 'auto',
      status      TEXT DEFAULT 'pending',
      author      TEXT NOT NULL,
      module      TEXT,
      task_id     TEXT,
      rule_ref    TEXT,
      tags        TEXT DEFAULT '[]',
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    , category TEXT NOT NULL DEFAULT 'dev', title TEXT, source_type TEXT NOT NULL DEFAULT 'manual', source_id TEXT, reviewer TEXT, confidence DOUBLE PRECISION, fingerprint TEXT, promotion_type TEXT, tenant_id TEXT NOT NULL);

CREATE TABLE failure_occurrences (
  occurrence_id   TEXT PRIMARY KEY,
  failure_id      TEXT NOT NULL REFERENCES test_failures(failure_id),
  run_id          TEXT NOT NULL,
  attempt         BIGINT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('failed','passed_on_diagnostic','dismissed')),
  created_at      TEXT NOT NULL,
  FOREIGN KEY(failure_id) REFERENCES test_failures(failure_id)
);

CREATE TABLE gate_loops (
  repo                  TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'coding',
  iteration             BIGINT NOT NULL DEFAULT 0,
  max_iterations        BIGINT NOT NULL DEFAULT 5,
  phase                 TEXT,
  size                  TEXT,
  required_units_json   TEXT NOT NULL DEFAULT '[]',
  pending_actions_json  TEXT NOT NULL DEFAULT '[]',
  last_binding_id       TEXT,
  last_expected_revision BIGINT,
  last_submission_id    TEXT,
  last_run_group_id     TEXT,
  last_terminal         TEXT,
  last_class            TEXT,
  await_distill         SMALLINT NOT NULL DEFAULT 0,
  needs_human           SMALLINT NOT NULL DEFAULT 0,
  waiver_id             TEXT,
  history_json          TEXT NOT NULL DEFAULT '[]',
  updated_at            TEXT NOT NULL, tenant_id TEXT NOT NULL,
  PRIMARY KEY (repo, task_id)
);

CREATE TABLE gate_observe_events (
  event_id           TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id   TEXT,
  legacy_task_id     TEXT NOT NULL,
  transition         TEXT NOT NULL,
  mode               TEXT NOT NULL,
  legacy_would_block BIGINT NOT NULL CHECK(legacy_would_block IN (0,1)),
  new_would_block    BIGINT NOT NULL CHECK(new_would_block IN (0,1)),
  differ             BIGINT NOT NULL CHECK(differ IN (0,1)),
  gate_binding_id    TEXT,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE TABLE gate_policy_decisions (
  decision_id   TEXT PRIMARY KEY,
  repo_id       TEXT,
  task_id       TEXT,
  binding_id    TEXT,
  repo_mode     TEXT,
  decision      TEXT NOT NULL,
  factors_json  TEXT,
  policy_hash   TEXT,
  trace_id      TEXT,
  payload_json  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE id_sequences (
      scope TEXT PRIMARY KEY,
      next  BIGINT NOT NULL
    );

CREATE TABLE idempotency_records (
  principal_id        TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id             TEXT REFERENCES repositories(repo_id),
  route               TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_sha256      TEXT NOT NULL,
  response_status     BIGINT NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expire_at           TEXT NOT NULL,
  PRIMARY KEY(principal_id, route, idempotency_key)
);

CREATE TABLE legacy_task_mappings (
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  legacy_task_id      TEXT NOT NULL,
  task_instance_id    TEXT NOT NULL,
  migrated_at         TEXT NOT NULL,
  PRIMARY KEY(repo_id, legacy_task_id),
  UNIQUE(repo_id, task_instance_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE TABLE links (
  link_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  sort_order  BIGINT NOT NULL DEFAULT 0,
  is_primary  BIGINT NOT NULL DEFAULT 0,
  enabled     SMALLINT NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
, value_json TEXT);

CREATE TABLE principal_repo_acl (
  principal_id  TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id       TEXT NOT NULL REFERENCES repositories(repo_id),
  permission    TEXT NOT NULL CHECK(permission IN (
    'submit','read_result','create_candidate','review_candidate',
    'promote_suite','triage_failure','administer'
  )),
  created_at    TEXT NOT NULL,
  PRIMARY KEY(principal_id, repo_id, permission)
);

CREATE TABLE principal_roles (
  role_grant_id   TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(principal_id),
  role          TEXT NOT NULL CHECK(role IN (
    'developer','reviewer','suite_maintainer','test_admin','auditor'
  )),
  scope         TEXT NOT NULL CHECK(scope IN ('global','repo')),
  repo_id       TEXT REFERENCES repositories(repo_id),
  granted_by    TEXT NOT NULL REFERENCES principals(principal_id),
  granted_at    TEXT NOT NULL,
  expires_at    TEXT,
  revoked_at    TEXT,
  CHECK(
    (scope='global' AND repo_id IS NULL)
    OR (scope='repo' AND repo_id IS NOT NULL)
  )
);

CREATE TABLE principal_tokens (
  token_id      TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(principal_id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE TABLE project_links (
  repo        TEXT PRIMARY KEY,
  link_id     TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE promotion_reviews (
  review_id            TEXT PRIMARY KEY,
  proposal_id          TEXT NOT NULL REFERENCES promotion_proposals(proposal_id),
  reviewer_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  verdict              TEXT NOT NULL CHECK(verdict IN ('approve','reject','request_changes')),
  note                 TEXT,
  reviewed_at          TEXT NOT NULL
);

CREATE TABLE repo_env_accounts (
  repo_id    TEXT NOT NULL REFERENCES repositories(repo_id),
  env        TEXT NOT NULL CHECK(env IN ('dev','qa')),
  username   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, env)
);

CREATE TABLE repo_env_settings (
  repo_id         TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  default_test_env TEXT NOT NULL CHECK(default_test_env IN ('dev','qa')),
  updated_at      TEXT NOT NULL
);

CREATE TABLE "repo_gate_modes" (
  repo_id    TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  mode       TEXT NOT NULL CHECK(mode IN ('legacy','observe','enforce_s','enforce_all','enforce_ml','disabled')),
  updated_at TEXT NOT NULL
);

CREATE TABLE repo_runtime_settings (
          repo_id     TEXT NOT NULL REFERENCES repositories(repo_id),
          key         TEXT NOT NULL,
          value_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (repo_id, key)
        );

CREATE TABLE repo_test_policies (
  repo_id              TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  enforce_spec_contract BIGINT NOT NULL DEFAULT 0,
  enable_sides          BIGINT NOT NULL DEFAULT 0,
  runner_hint           TEXT,
  updated_at            TEXT NOT NULL
, review_mode TEXT NOT NULL DEFAULT 'record');

CREATE TABLE rule_artifacts (
      rule_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      title TEXT NOT NULL,
      condition_json TEXT NOT NULL,
      detection_command TEXT,
      source_experience_id TEXT,
      version BIGINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK(status IN ('draft','active','deprecated','revoked')),
      owner TEXT,
      applies_to_json TEXT,
      activated_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

CREATE TABLE rules_manifest (
      id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      content    TEXT NOT NULL,
      rule_count BIGINT NOT NULL DEFAULT 0,
      author     TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE run_attestations (
  run_attestation_id  TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id              TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt             BIGINT NOT NULL,
  lease_epoch         BIGINT NOT NULL,
  binding_id          TEXT NOT NULL REFERENCES test_bindings(binding_id),
  worker_id           TEXT NOT NULL REFERENCES workers(worker_id),
  worker_cert_thumbprint TEXT NOT NULL,
  image_id            TEXT NOT NULL REFERENCES runner_images(image_id),
  image_manifest_sha256 TEXT NOT NULL,
  result_sha256       TEXT NOT NULL,
  artifact_sha256     TEXT NOT NULL,
  canonical_sha256    TEXT NOT NULL,
  signature           TEXT NOT NULL,
  completed_at        TEXT NOT NULL,
  FOREIGN KEY(run_id, attempt, lease_epoch)
    REFERENCES run_attempts(run_id, attempt, lease_epoch),
  FOREIGN KEY(repo_id, run_id, attempt)
    REFERENCES run_attempts(repo_id, run_id, attempt),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id),
  UNIQUE(run_id, attempt, lease_epoch)
);

CREATE TABLE run_lifecycle_events (
  event_id      TEXT PRIMARY KEY,
  run_id        TEXT,
  attempt       BIGINT,
  lease_epoch   BIGINT,
  event_type    TEXT NOT NULL,
  detail_json   TEXT,
  trace_id      TEXT,
  repo_id       TEXT,
  task_id       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE runner_leases (
  lease_id           TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT NOT NULL,
  attempt            BIGINT NOT NULL,
  worker_id          TEXT NOT NULL REFERENCES workers(worker_id),
  lease_epoch        BIGINT NOT NULL,
  lease_token_hash   TEXT NOT NULL UNIQUE,
  expires_at         TEXT NOT NULL,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL,
  FOREIGN KEY(run_id, attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY(repo_id, run_id, attempt)
    REFERENCES run_attempts(repo_id, run_id, attempt),
  UNIQUE(run_id, lease_epoch),
  UNIQUE(repo_id, lease_id)
);

CREATE TABLE runspec_nonces (
  nonce_id            TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id              TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt             BIGINT NOT NULL,
  nonce_hash          TEXT NOT NULL UNIQUE,
  issued_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  FOREIGN KEY(run_id, attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY(repo_id, run_id, attempt)
    REFERENCES run_attempts(repo_id, run_id, attempt)
);

CREATE TABLE schema_migrations (
  version       BIGINT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  checksum      TEXT NOT NULL,
  applied_at    TEXT NOT NULL
);

CREATE TABLE secret_grants (
  secret_grant_id     TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  lease_id            TEXT NOT NULL REFERENCES runner_leases(lease_id),
  worker_id           TEXT NOT NULL REFERENCES workers(worker_id),
  capability          TEXT NOT NULL,
  secret_ref          TEXT NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('issued','fetched','revoked','expired')),
  issued_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  fetched_at          TEXT,
  revoked_at          TEXT,
  FOREIGN KEY(repo_id, lease_id)
    REFERENCES runner_leases(repo_id, lease_id)
);

CREATE TABLE "signing_keys" (
  key_id              TEXT PRIMARY KEY,
  purpose             TEXT NOT NULL CHECK(purpose IN ('runspec','workspace_attestation','image_manifest')),
  algorithm           TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem      TEXT NOT NULL,
  secret_ref          TEXT,
  status              TEXT NOT NULL CHECK(status IN ('active','verify_only','revoked')),
  not_before          TEXT NOT NULL,
  not_after           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE spec_f2p_results (
  result_id        TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repositories(repo_id),
  feature_key      TEXT NOT NULL,
  version          BIGINT NOT NULL,
  baseline_oid     TEXT NOT NULL,
  snapshot_oid     TEXT NOT NULL,
  baseline_result  TEXT CHECK(baseline_result IN ('passed','failed','error','skipped')),
  snapshot_result  TEXT CHECK(snapshot_result IN ('passed','failed','error','skipped')),
  f2p_status       TEXT NOT NULL CHECK(f2p_status IN ('ok','always_pass','always_fail','regressed','skipped')),
  detail           TEXT,
  created_at       TEXT NOT NULL
);

CREATE TABLE suite_channels (
  channel_id          TEXT PRIMARY KEY,
  overlay_id          TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  channel             TEXT NOT NULL CHECK(channel IN ('active','candidate')),
  active_revision_id  TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  revision            BIGINT NOT NULL DEFAULT 1,
  updated_by          TEXT NOT NULL REFERENCES principals(principal_id),
  updated_at          TEXT NOT NULL,
  UNIQUE(overlay_id, channel)
);

CREATE TABLE suite_overlay_repo_compat (
  overlay_id             TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  min_profile_revision   BIGINT,
  enabled                SMALLINT NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  PRIMARY KEY(overlay_id, repo_id)
);

CREATE TABLE suite_plan_layers (
  suite_plan_id      TEXT NOT NULL REFERENCES suite_plans(suite_plan_id),
  position           BIGINT NOT NULL,
  layer              TEXT NOT NULL CHECK(layer IN ('stable','repo','branch','task')),
  overlay_id         TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  suite_revision_id  TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  effective_approval TEXT NOT NULL CHECK(effective_approval IN ('approved_for_binding','reviewed')),
  content_sha256     TEXT NOT NULL,
  PRIMARY KEY(suite_plan_id, position)
);

CREATE TABLE suite_waivers (
  waiver_id              TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id       TEXT REFERENCES task_instances(task_instance_id),
  case_key               TEXT NOT NULL,
  action                 TEXT NOT NULL CHECK(action IN ('skip','replace')),
  base_suite_revision_id TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  replacement_case_key   TEXT,
  scope_binding_id       TEXT,
  reason                 TEXT NOT NULL,
  approved_by            TEXT NOT NULL REFERENCES principals(principal_id),
  expires_at             TEXT NOT NULL,
  revoked_at             TEXT,
  created_at             TEXT NOT NULL
);

CREATE TABLE suite_plan_waivers (
  suite_plan_id      TEXT NOT NULL REFERENCES suite_plans(suite_plan_id),
  waiver_id          TEXT NOT NULL REFERENCES suite_waivers(waiver_id),
  case_key           TEXT NOT NULL,
  action             TEXT NOT NULL CHECK(action IN ('skip','replace')),
  PRIMARY KEY(suite_plan_id, waiver_id, case_key)
);

CREATE TABLE suite_revision_events (
  event_id          TEXT PRIMARY KEY,
  suite_revision_id TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  event_type        TEXT NOT NULL CHECK(event_type IN (
    'quarantined','runnable','approved','rejected','deprecated','revoked','promoted'
  )),
  state_axis        TEXT NOT NULL CHECK(state_axis IN ('approval','publication')),
  from_state        TEXT CHECK(from_state IN (
    'unreviewed','executable','reviewed','rejected',
    'draft','active','deprecated','revoked'
  )),
  to_state          TEXT NOT NULL CHECK(to_state IN (
    'unreviewed','executable','reviewed','rejected',
    'draft','active','deprecated','revoked'
  )),
  reason            TEXT,
  actor_principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  created_at        TEXT NOT NULL
);

CREATE TABLE task_attachments (
          attachment_id  TEXT PRIMARY KEY,
          repo_id        TEXT NOT NULL REFERENCES repositories(repo_id),
          task_id        TEXT NOT NULL,
          kind           TEXT NOT NULL CHECK(kind IN ('requirement','api','design','other')),
          title          TEXT,
          content        TEXT,
          url            TEXT,
          author         TEXT,
          created_at     TEXT NOT NULL
        );

CREATE TABLE task_overlays (
  overlay_id              TEXT PRIMARY KEY,
  logical_name            TEXT NOT NULL,
  layer                   TEXT NOT NULL CHECK(layer IN ('task','branch_task')),
  repo_id                 TEXT,
  branch_incarnation_id   TEXT,
  task_instance_id        TEXT,
  ordinal                 BIGINT NOT NULL DEFAULT 0,
  protected               BIGINT NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
  state                   TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deprecated','revoked')),
  created_by              TEXT NOT NULL REFERENCES principals(principal_id),
  created_at              TEXT NOT NULL,
  CHECK(
    (layer='task' AND task_instance_id IS NOT NULL AND repo_id IS NOT NULL)
    OR (layer='branch_task' AND branch_incarnation_id IS NOT NULL AND task_instance_id IS NULL AND repo_id IS NOT NULL)
  )
);

CREATE TABLE task_sessions (
  session_id        TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  owner_subject     TEXT NOT NULL,
  client_name       TEXT,
  state             TEXT NOT NULL DEFAULT 'coding',
  gate_iteration    BIGINT NOT NULL DEFAULT 0,
  last_binding_id   TEXT,
  last_packet_json  TEXT,
  heartbeat_at      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT
, tenant_id TEXT NOT NULL);

CREATE TABLE task_versions (
      id          BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      task_id     TEXT NOT NULL,
      repo        TEXT NOT NULL,
      phase       TEXT,
      snapshot    TEXT NOT NULL,
      author      TEXT,
      created_at  TEXT NOT NULL
    , tenant_id TEXT NOT NULL);

CREATE TABLE tasks (
      task_id     TEXT NOT NULL,
      repo        TEXT NOT NULL,
      requirement TEXT,
      type        TEXT,
      phase       TEXT,
      completed   TEXT DEFAULT '[]',
      pending     TEXT DEFAULT '[]',
      decisions   TEXT DEFAULT '[]',
      author      TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      closed_at   TEXT, tenant_id TEXT NOT NULL, size TEXT, meta TEXT DEFAULT '{}',
      PRIMARY KEY (repo, task_id)
    );

CREATE TABLE tenant_extensions (
          repo_id     TEXT NOT NULL REFERENCES repositories(repo_id),
          feature     TEXT NOT NULL,
          handler_id  TEXT NOT NULL,
          params_json TEXT NOT NULL DEFAULT '{}',
          revision    BIGINT NOT NULL,
          state       TEXT NOT NULL CHECK (state IN ('active','deprecated')),
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (repo_id, feature, revision)
        );

CREATE TABLE "test_specs" (
  spec_id         TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repositories(repo_id),
  feature_key     TEXT NOT NULL,
  feature_title   TEXT,
  demand_ref      TEXT,
  author          TEXT NOT NULL,
  spec_type       TEXT NOT NULL DEFAULT 'e2e' CHECK(spec_type IN ('smoke','e2e','unit','api')),
  entry           TEXT NOT NULL,
  blob_sha256     TEXT NOT NULL,
  code_commit_oid TEXT,
  version         BIGINT NOT NULL DEFAULT 1,
  review_status   TEXT NOT NULL DEFAULT 'draft'
                  CHECK(review_status IN ('draft','reviewed','active','archived','orphan-candidate')),
  last_result     TEXT,
  fail_streak     BIGINT NOT NULL DEFAULT 0,
  side            TEXT,
  acceptance_refs_json TEXT,
  pages_json      TEXT,
  mutation_verified SMALLINT NOT NULL DEFAULT 0,
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_decision TEXT,
  review_notes    TEXT,
  scope           TEXT DEFAULT 'task',
  execution_config_json TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
, mutation_verdict TEXT);

CREATE TABLE tool_calls (
  call_id        TEXT PRIMARY KEY,
  repo           TEXT,
  task_id        TEXT,
  tool_name      TEXT,
  phase          TEXT,
  state          TEXT NOT NULL,
  status         TEXT,
  response_text  TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  served_by_link TEXT,
  failover_from  TEXT
);

CREATE TABLE verify_reports (
      id          TEXT PRIMARY KEY,
      repo        TEXT NOT NULL,
      level       TEXT,
      side        TEXT,
      file        TEXT,
      pass        SMALLINT,
      errors      BIGINT,
      detail      TEXT,
      author      TEXT,
      created_at  TEXT NOT NULL
    , workspace_head TEXT, code_snapshot_sha TEXT, output_sha256 TEXT, command_exit_code BIGINT, started_at TEXT, finished_at TEXT, source TEXT DEFAULT 'manual', tenant_id TEXT NOT NULL, task_id TEXT);

CREATE TABLE worker_idempotency_records (
  worker_id           TEXT NOT NULL REFERENCES workers(worker_id),
  lease_id            TEXT NOT NULL REFERENCES runner_leases(lease_id),
  operation           TEXT NOT NULL CHECK(operation IN ('accept','heartbeat','progress','artifact_prepare','complete','reject')),
  operation_seq       BIGINT NOT NULL DEFAULT 0 CHECK(operation_seq >= 0),
  payload_sha256      TEXT NOT NULL,
  response_status     BIGINT NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY(worker_id, lease_id, operation, operation_seq)
);

CREATE INDEX idx_audit_created ON audit_events(created_at);
CREATE INDEX idx_bindings_task
  ON test_bindings(task_instance_id, created_at DESC);
CREATE INDEX idx_branch_active
  ON branch_incarnations(remote_id, full_ref, state);
CREATE INDEX idx_candidate_review_status
  ON candidate_binding_approvals(effective_approval, expires_at);
CREATE INDEX idx_candidate_review_task
  ON candidate_binding_approvals(task_instance_id);
CREATE INDEX idx_deferred_status ON deferred_submissions(status, created_at);
CREATE INDEX idx_docs_category ON docs(category);
CREATE INDEX idx_docs_repo ON docs(repo);
CREATE INDEX idx_dv ON docs_versions(repo, name);
CREATE INDEX idx_exp_created ON experiences(created_at);
CREATE INDEX idx_exp_fingerprint ON experiences(fingerprint);
CREATE INDEX idx_exp_module ON experiences(module);
CREATE INDEX idx_exp_repo ON experiences(repo);
CREATE INDEX idx_exp_status ON experiences(status);
CREATE INDEX idx_exp_task ON experiences(task_id);
CREATE INDEX idx_experience_feedback_failure
  ON experience_feedback(failure_id, created_at DESC);
CREATE INDEX idx_experience_feedback_repo_status
  ON experience_feedback(repo_id, verification_status, created_at DESC);
CREATE INDEX idx_experience_feedback_run
  ON experience_feedback(run_id, created_at DESC);
CREATE INDEX idx_experience_pending_repo
  ON experience_pending(repo_id, status, created_at DESC);
CREATE INDEX idx_failure_occurrences
  ON failure_occurrences(failure_id, created_at DESC);
CREATE INDEX idx_failures_fingerprint
  ON test_failures(repo_id, fingerprint_version, fingerprint, last_seen_at DESC);
CREATE INDEX idx_git_remotes_repo ON git_remotes(repo_id, enabled);
CREATE INDEX idx_gpd_repo ON gate_policy_decisions(repo_id, created_at);
CREATE INDEX idx_gpd_task ON gate_policy_decisions(task_id, created_at);
CREATE INDEX idx_links_sort ON links(sort_order, link_id);
CREATE INDEX idx_promotion_review_proposal
  ON promotion_reviews(proposal_id, reviewed_at);
CREATE INDEX idx_proposal_state
  ON promotion_proposals(state, proposed_at DESC);
CREATE INDEX idx_proposal_target
  ON promotion_proposals(target_suite_revision_id, state);
CREATE INDEX idx_ra_exp ON rule_artifacts(source_experience_id);
CREATE INDEX idx_ra_repo ON rule_artifacts(repo, status);
CREATE INDEX idx_rle_run ON run_lifecycle_events(run_id, created_at);
CREATE INDEX idx_rle_trace ON run_lifecycle_events(trace_id);
CREATE INDEX idx_rle_type ON run_lifecycle_events(event_type, created_at);
CREATE INDEX idx_runs_binding ON test_runs(binding_id, unit, side, purpose, status);
CREATE INDEX idx_runs_queue ON test_runs(status, priority, created_at);
CREATE INDEX idx_runs_task ON test_runs(repo_id, task_instance_id, created_at DESC);
CREATE INDEX idx_secret_grants_lease
  ON secret_grants(lease_id, status);
CREATE INDEX idx_spec_f2p_run ON spec_f2p_results(run_id, feature_key);
CREATE INDEX idx_spec_f2p_status ON spec_f2p_results(repo_id, f2p_status, created_at);
CREATE INDEX idx_submissions_task
  ON test_submissions(repo_id, task_instance_id, created_at DESC);
CREATE INDEX idx_task_attachments_task
          ON task_attachments(repo_id, task_id, created_at);
CREATE INDEX idx_task_instances_lookup
  ON task_instances(repo_id, external_task_id, status);
CREATE INDEX idx_task_overlay_branch
  ON task_overlays(branch_incarnation_id, state);
CREATE INDEX idx_task_overlay_task
  ON task_overlays(task_instance_id, state);
CREATE INDEX idx_task_sessions_owner
  ON task_sessions(owner_subject, released_at);
CREATE INDEX idx_task_sessions_repo_task
  ON task_sessions(repo, task_id);
CREATE INDEX idx_tasks_phase ON tasks(phase);
CREATE INDEX idx_tasks_repo ON tasks(repo);
CREATE UNIQUE INDEX idx_tasks_tenant_task ON tasks(tenant_id, task_id);
CREATE INDEX idx_tenant_extensions_active
          ON tenant_extensions(repo_id, feature, state, revision);
CREATE INDEX idx_test_specs_author ON "test_specs"(repo_id, author, updated_at DESC);
CREATE INDEX idx_test_specs_demand ON "test_specs"(repo_id, demand_ref, created_at DESC);
CREATE INDEX idx_test_specs_repo_feature ON "test_specs"(repo_id, feature_key, review_status);
CREATE INDEX idx_tool_calls_task ON tool_calls(task_id, started_at);
CREATE INDEX idx_tv ON task_versions(repo, task_id);
CREATE INDEX idx_verify_level ON verify_reports(level);
CREATE INDEX idx_verify_repo ON verify_reports(repo);
CREATE UNIQUE INDEX links_one_primary ON links(is_primary) WHERE is_primary = 1;
CREATE UNIQUE INDEX uq_active_failure_fingerprint
  ON test_failures(repo_id, fingerprint_version, fingerprint)
  WHERE status IN ('open','triaged');
CREATE UNIQUE INDEX uq_branch_one_active
  ON branch_incarnations(remote_id, full_ref)
  WHERE state='active';
CREATE UNIQUE INDEX uq_global_principal_role
  ON principal_roles(principal_id, role)
  WHERE scope='global' AND revoked_at IS NULL;
CREATE UNIQUE INDEX uq_one_active_lease_per_run
  ON runner_leases(run_id)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX uq_repo_principal_role
  ON principal_roles(principal_id, role, repo_id)
  WHERE scope='repo' AND revoked_at IS NULL;
CREATE UNIQUE INDEX uq_suite_overlay_scope
  ON suite_overlays(
    layer,
    COALESCE(repo_id,''),
    COALESCE(branch_incarnation_id,''),
    COALESCE(task_instance_id,''),
    ordinal
  );
CREATE UNIQUE INDEX uq_task_overlay_scope
  ON task_overlays(
    layer,
    COALESCE(repo_id,''),
    COALESCE(branch_incarnation_id,''),
    COALESCE(task_instance_id,''),
    ordinal
  );
CREATE UNIQUE INDEX uq_test_specs_feature_version ON "test_specs"(repo_id, feature_key, version);

-- ── 全文索引：pg_trgm GIN（替代 SQLite FTS5 虚拟表）──
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_docs_content_trgm ON docs USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_docs_name_trgm ON docs USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_experiences_content_trgm ON experiences USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_experiences_module_trgm ON experiences USING GIN (module gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_experiences_tags_trgm ON experiences USING GIN (tags gin_trgm_ops);

-- ── 域完整性触发器（SQLite 触发器的 PostgreSQL 等价物）──
CREATE OR REPLACE FUNCTION trg_suite_revisions_immutable_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.tree_oid IS DISTINCT FROM OLD.tree_oid
     OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256
     OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256
     OR NEW.manifest_json IS DISTINCT FROM OLD.manifest_json
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_commit_oid IS DISTINCT FROM OLD.source_commit_oid
     OR NEW.source_tree_path IS DISTINCT FROM OLD.source_tree_path
     OR NEW.registry_commit_oid IS DISTINCT FROM OLD.registry_commit_oid THEN
    RAISE EXCEPTION 'SUITE_REVOKED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_suite_revisions_immutable BEFORE UPDATE ON suite_revisions
  FOR EACH ROW EXECUTE FUNCTION trg_suite_revisions_immutable_fn();

CREATE OR REPLACE FUNCTION trg_snapshot_same_repo_fn() RETURNS trigger AS $$
BEGIN
  IF (SELECT repo_id FROM git_remotes WHERE remote_id = NEW.source_remote_id) IS DISTINCT FROM NEW.repo_id
     OR (SELECT repo_id FROM git_remotes WHERE remote_id = NEW.target_remote_id) IS DISTINCT FROM NEW.repo_id THEN
    RAISE EXCEPTION 'CROSS_REPO_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_snapshot_same_repo BEFORE INSERT ON business_snapshots
  FOR EACH ROW EXECUTE FUNCTION trg_snapshot_same_repo_fn();

CREATE OR REPLACE FUNCTION trg_plan_same_repo_fn() RETURNS trigger AS $$
BEGIN
  IF (SELECT repo_id FROM task_instances WHERE task_instance_id = NEW.task_instance_id) IS DISTINCT FROM NEW.repo_id THEN
    RAISE EXCEPTION 'CROSS_REPO_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_plan_same_repo BEFORE INSERT ON suite_plans
  FOR EACH ROW EXECUTE FUNCTION trg_plan_same_repo_fn();

CREATE OR REPLACE FUNCTION trg_binding_same_repo_fn() RETURNS trigger AS $$
BEGIN
  IF (SELECT repo_id FROM business_snapshots WHERE snapshot_id = NEW.snapshot_id) IS DISTINCT FROM NEW.repo_id
     OR (SELECT repo_id FROM suite_plans WHERE suite_plan_id = NEW.suite_plan_id) IS DISTINCT FROM NEW.repo_id
     OR (SELECT repo_id FROM task_instances WHERE task_instance_id = NEW.task_instance_id) IS DISTINCT FROM NEW.repo_id THEN
    RAISE EXCEPTION 'CROSS_REPO_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_binding_same_repo BEFORE INSERT ON test_bindings
  FOR EACH ROW EXECUTE FUNCTION trg_binding_same_repo_fn();

CREATE OR REPLACE FUNCTION trg_waiver_same_repo_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.task_instance_id IS NOT NULL
     AND (SELECT repo_id FROM task_instances WHERE task_instance_id = NEW.task_instance_id) IS DISTINCT FROM NEW.repo_id THEN
    RAISE EXCEPTION 'CROSS_REPO_REFERENCE';
  END IF;
  IF (SELECT o.layer FROM suite_revisions r JOIN suite_overlays o ON o.overlay_id = r.overlay_id
      WHERE r.suite_revision_id = NEW.base_suite_revision_id) = 'repo'
     AND (SELECT o.repo_id FROM suite_revisions r JOIN suite_overlays o ON o.overlay_id = r.overlay_id
      WHERE r.suite_revision_id = NEW.base_suite_revision_id) IS DISTINCT FROM NEW.repo_id THEN
    RAISE EXCEPTION 'CROSS_REPO_REFERENCE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_waiver_same_repo BEFORE INSERT ON suite_waivers
  FOR EACH ROW EXECUTE FUNCTION trg_waiver_same_repo_fn();

CREATE OR REPLACE FUNCTION trg_promotion_review_not_author_fn() RETURNS trigger AS $$
DECLARE proposal_author TEXT;
BEGIN
  SELECT author_principal_id INTO proposal_author FROM promotion_proposals WHERE proposal_id = NEW.proposal_id;
  IF proposal_author IS NOT DISTINCT FROM NEW.reviewer_principal_id THEN
    RAISE EXCEPTION 'PROMOTION_REVIEW_SELF_FORBIDDEN';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_promotion_review_not_author BEFORE INSERT ON promotion_reviews
  FOR EACH ROW EXECUTE FUNCTION trg_promotion_review_not_author_fn();
