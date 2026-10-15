-- testing schema v4: suite registry, worker lease, attempt, runspec nonce, attestation

CREATE TABLE IF NOT EXISTS suite_overlays (
  overlay_id              TEXT PRIMARY KEY,
  logical_name            TEXT NOT NULL,
  layer                   TEXT NOT NULL CHECK(layer IN ('stable','repo','branch','task')),
  repo_id                 TEXT REFERENCES repositories(repo_id),
  branch_incarnation_id   TEXT,
  task_instance_id        TEXT,
  ordinal                 INTEGER NOT NULL DEFAULT 0,
  protected               INTEGER NOT NULL DEFAULT 0 CHECK(protected IN (0,1)),
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_suite_overlay_scope
  ON suite_overlays(
    layer,
    COALESCE(repo_id,''),
    COALESCE(branch_incarnation_id,''),
    COALESCE(task_instance_id,''),
    ordinal
  );

CREATE TABLE IF NOT EXISTS suite_overlay_repo_compat (
  overlay_id             TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  min_profile_revision   INTEGER,
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  PRIMARY KEY(overlay_id, repo_id)
);

CREATE TABLE IF NOT EXISTS suite_revisions (
  suite_revision_id          TEXT PRIMARY KEY,
  overlay_id                 TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  revision                   INTEGER NOT NULL CHECK(revision > 0),
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

CREATE TABLE IF NOT EXISTS suite_revision_events (
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

CREATE TABLE IF NOT EXISTS suite_channels (
  channel_id          TEXT PRIMARY KEY,
  overlay_id          TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  channel             TEXT NOT NULL CHECK(channel IN ('active','candidate')),
  active_revision_id  TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  revision            INTEGER NOT NULL DEFAULT 1,
  updated_by          TEXT NOT NULL REFERENCES principals(principal_id),
  updated_at          TEXT NOT NULL,
  UNIQUE(overlay_id, channel)
);

CREATE TABLE IF NOT EXISTS suite_waivers (
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

CREATE TABLE IF NOT EXISTS suite_plan_layers (
  suite_plan_id      TEXT NOT NULL REFERENCES suite_plans(suite_plan_id),
  position           INTEGER NOT NULL,
  layer              TEXT NOT NULL CHECK(layer IN ('stable','repo','branch','task')),
  overlay_id         TEXT NOT NULL REFERENCES suite_overlays(overlay_id),
  suite_revision_id  TEXT NOT NULL REFERENCES suite_revisions(suite_revision_id),
  effective_approval TEXT NOT NULL CHECK(effective_approval IN ('approved_for_binding','reviewed')),
  content_sha256     TEXT NOT NULL,
  PRIMARY KEY(suite_plan_id, position)
);

CREATE TABLE IF NOT EXISTS suite_plan_waivers (
  suite_plan_id      TEXT NOT NULL REFERENCES suite_plans(suite_plan_id),
  waiver_id          TEXT NOT NULL REFERENCES suite_waivers(waiver_id),
  case_key           TEXT NOT NULL,
  action             TEXT NOT NULL CHECK(action IN ('skip','replace')),
  PRIMARY KEY(suite_plan_id, waiver_id, case_key)
);

CREATE TABLE IF NOT EXISTS workers (
  worker_id          TEXT PRIMARY KEY,
  certificate_thumbprint TEXT NOT NULL UNIQUE,
  hostname           TEXT NOT NULL,
  capabilities_json  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK(status IN ('active','draining','offline','revoked')),
  last_heartbeat_at  TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_attempts (
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt            INTEGER NOT NULL CHECK(attempt > 0),
  worker_id          TEXT NOT NULL REFERENCES workers(worker_id),
  lease_epoch        INTEGER NOT NULL CHECK(lease_epoch > 0),
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
  error_detail       TEXT,
  PRIMARY KEY(run_id, attempt),
  UNIQUE(run_id, attempt, lease_epoch),
  UNIQUE(repo_id, run_id, attempt),
  FOREIGN KEY(repo_id, run_id)
    REFERENCES test_runs(repo_id, run_id)
);

CREATE TABLE IF NOT EXISTS runner_leases (
  lease_id           TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id             TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  worker_id          TEXT NOT NULL REFERENCES workers(worker_id),
  lease_epoch        INTEGER NOT NULL,
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_lease_per_run
  ON runner_leases(run_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS accepted_run_results (
  run_id             TEXT PRIMARY KEY REFERENCES test_runs(run_id),
  attempt            INTEGER NOT NULL,
  lease_epoch        INTEGER NOT NULL,
  result_sha256      TEXT NOT NULL,
  accepted_at        TEXT NOT NULL,
  FOREIGN KEY(run_id, attempt, lease_epoch)
    REFERENCES run_attempts(run_id, attempt, lease_epoch)
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id        TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt            INTEGER NOT NULL,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  binding_id         TEXT NOT NULL REFERENCES test_bindings(binding_id),
  storage_key        TEXT NOT NULL UNIQUE,
  manifest_sha256    TEXT NOT NULL,
  archive_sha256     TEXT NOT NULL,
  size               INTEGER NOT NULL CHECK(size >= 0),
  artifact_truncated INTEGER NOT NULL DEFAULT 0 CHECK(artifact_truncated IN (0,1)),
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

CREATE TABLE IF NOT EXISTS worker_idempotency_records (
  worker_id           TEXT NOT NULL REFERENCES workers(worker_id),
  lease_id            TEXT NOT NULL REFERENCES runner_leases(lease_id),
  operation           TEXT NOT NULL CHECK(operation IN ('accept','heartbeat','progress','artifact_prepare','complete','reject')),
  operation_seq       INTEGER NOT NULL DEFAULT 0 CHECK(operation_seq >= 0),
  payload_sha256      TEXT NOT NULL,
  response_status     INTEGER NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  PRIMARY KEY(worker_id, lease_id, operation, operation_seq)
);

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id              TEXT PRIMARY KEY,
  purpose             TEXT NOT NULL CHECK(purpose IN ('runspec','workspace_attestation')),
  algorithm           TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem      TEXT NOT NULL,
  secret_ref          TEXT,
  status              TEXT NOT NULL CHECK(status IN ('active','verify_only','revoked')),
  not_before          TEXT NOT NULL,
  not_after           TEXT NOT NULL,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runspec_nonces (
  nonce_id            TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id              TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt             INTEGER NOT NULL,
  nonce_hash          TEXT NOT NULL UNIQUE,
  issued_at           TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  consumed_at         TEXT,
  FOREIGN KEY(run_id, attempt) REFERENCES run_attempts(run_id, attempt),
  FOREIGN KEY(repo_id, run_id, attempt)
    REFERENCES run_attempts(repo_id, run_id, attempt)
);

CREATE TABLE IF NOT EXISTS run_attestations (
  run_attestation_id  TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  run_id              TEXT NOT NULL REFERENCES test_runs(run_id),
  attempt             INTEGER NOT NULL,
  lease_epoch         INTEGER NOT NULL,
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

CREATE TRIGGER IF NOT EXISTS trg_suite_revisions_immutable
BEFORE UPDATE ON suite_revisions
FOR EACH ROW
WHEN NEW.tree_oid IS NOT OLD.tree_oid
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.manifest_sha256 IS NOT OLD.manifest_sha256
  OR NEW.manifest_json IS NOT OLD.manifest_json
  OR NEW.source_kind IS NOT OLD.source_kind
  OR NEW.source_commit_oid IS NOT OLD.source_commit_oid
  OR NEW.source_tree_path IS NOT OLD.source_tree_path
  OR NEW.registry_commit_oid IS NOT OLD.registry_commit_oid
BEGIN
  SELECT RAISE(ABORT, 'SUITE_REVOKED');
END;

CREATE TRIGGER IF NOT EXISTS trg_snapshot_same_repo
BEFORE INSERT ON business_snapshots
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN (SELECT repo_id FROM git_remotes WHERE remote_id=NEW.source_remote_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT repo_id FROM git_remotes WHERE remote_id=NEW.target_remote_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_plan_same_repo
BEFORE INSERT ON suite_plans
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN (SELECT repo_id FROM task_instances WHERE task_instance_id=NEW.task_instance_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_binding_same_repo
BEFORE INSERT ON test_bindings
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN (SELECT repo_id FROM business_snapshots WHERE snapshot_id=NEW.snapshot_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT repo_id FROM suite_plans WHERE suite_plan_id=NEW.suite_plan_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT repo_id FROM task_instances WHERE task_instance_id=NEW.task_instance_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_run_same_repo
BEFORE INSERT ON test_runs
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN (SELECT repo_id FROM run_groups WHERE run_group_id=NEW.run_group_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT repo_id FROM test_bindings WHERE binding_id=NEW.binding_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT repo_id FROM task_instances WHERE task_instance_id=NEW.task_instance_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_waiver_same_repo
BEFORE INSERT ON suite_waivers
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.task_instance_id IS NOT NULL
     AND (SELECT repo_id FROM task_instances WHERE task_instance_id=NEW.task_instance_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
    WHEN (SELECT o.layer FROM suite_revisions r JOIN suite_overlays o ON o.overlay_id=r.overlay_id
          WHERE r.suite_revision_id=NEW.base_suite_revision_id) = 'repo'
     AND (SELECT o.repo_id FROM suite_revisions r JOIN suite_overlays o ON o.overlay_id=r.overlay_id
          WHERE r.suite_revision_id=NEW.base_suite_revision_id) IS NOT NEW.repo_id
      THEN RAISE(ABORT, 'CROSS_REPO_REFERENCE')
  END;
END;
