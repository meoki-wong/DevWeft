-- testing schema v1: identity, remotes, tasks, snapshot, binding
-- checksum source for schema_migrations

CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  checksum      TEXT NOT NULL,
  applied_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principals (
  principal_id  TEXT PRIMARY KEY,
  subject       TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('active','disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principal_tokens (
  token_id      TEXT PRIMARY KEY,
  principal_id  TEXT NOT NULL REFERENCES principals(principal_id),
  token_hash    TEXT NOT NULL UNIQUE,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  repo_id             TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  default_target_ref  TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS principal_repo_acl (
  principal_id  TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id       TEXT NOT NULL REFERENCES repositories(repo_id),
  permission    TEXT NOT NULL CHECK(permission IN (
    'submit','read_result','create_candidate','review_candidate',
    'promote_suite','triage_failure','administer'
  )),
  created_at    TEXT NOT NULL,
  PRIMARY KEY(principal_id, repo_id, permission)
);

CREATE TABLE IF NOT EXISTS principal_roles (
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_global_principal_role
  ON principal_roles(principal_id, role)
  WHERE scope='global' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_principal_role
  ON principal_roles(principal_id, role, repo_id)
  WHERE scope='repo' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS git_remotes (
  remote_id              TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  provider               TEXT NOT NULL CHECK(provider IN ('gitlab','github','generic')),
  provider_instance      TEXT NOT NULL,
  provider_project_id    TEXT,
  canonical_url          TEXT NOT NULL,
  url_fingerprint        TEXT NOT NULL UNIQUE,
  relationship           TEXT NOT NULL CHECK(relationship IN ('canonical','fork','mirror')),
  upstream_remote_id     TEXT REFERENCES git_remotes(remote_id),
  enabled                INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_git_remotes_repo ON git_remotes(repo_id, enabled);

CREATE TABLE IF NOT EXISTS branch_incarnations (
  branch_incarnation_id  TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  remote_id              TEXT NOT NULL REFERENCES git_remotes(remote_id),
  full_ref               TEXT NOT NULL,
  generation             INTEGER NOT NULL CHECK(generation > 0),
  anchor_commit_oid      TEXT NOT NULL,
  last_observed_tip_oid  TEXT NOT NULL,
  provider_ref_version   TEXT,
  state                  TEXT NOT NULL CHECK(state IN ('active','rebased','deleted','superseded')),
  created_at             TEXT NOT NULL,
  superseded_at          TEXT,
  UNIQUE(remote_id, full_ref, generation),
  UNIQUE(repo_id, branch_incarnation_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_active
  ON branch_incarnations(remote_id, full_ref, state);

CREATE UNIQUE INDEX IF NOT EXISTS uq_branch_one_active
  ON branch_incarnations(remote_id, full_ref)
  WHERE state='active';

CREATE TABLE IF NOT EXISTS branch_ref_observations (
  observation_id        TEXT PRIMARY KEY,
  remote_id             TEXT NOT NULL REFERENCES git_remotes(remote_id),
  full_ref              TEXT NOT NULL,
  provider_ref_version  TEXT,
  old_tip_oid           TEXT,
  new_tip_oid           TEXT,
  observed_state        TEXT NOT NULL CHECK(observed_state IN ('present','deleted')),
  ancestry_result       TEXT NOT NULL CHECK(ancestry_result IN ('first','fast_forward','non_fast_forward','deleted','recreated')),
  resulting_generation  INTEGER NOT NULL,
  observed_at           TEXT NOT NULL,
  UNIQUE(remote_id, full_ref, provider_ref_version)
);

CREATE TABLE IF NOT EXISTS task_instances (
  task_instance_id       TEXT PRIMARY KEY,
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  external_task_id       TEXT NOT NULL,
  epoch                  INTEGER NOT NULL DEFAULT 1 CHECK(epoch > 0),
  revision               INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
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

CREATE INDEX IF NOT EXISTS idx_task_instances_lookup
  ON task_instances(repo_id, external_task_id, status);

CREATE TABLE IF NOT EXISTS legacy_task_mappings (
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  legacy_task_id      TEXT NOT NULL,
  task_instance_id    TEXT NOT NULL,
  migrated_at         TEXT NOT NULL,
  PRIMARY KEY(repo_id, legacy_task_id),
  UNIQUE(repo_id, task_instance_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE TABLE IF NOT EXISTS execution_profile_revisions (
  profile_revision_id  TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  name                 TEXT NOT NULL,
  revision             INTEGER NOT NULL CHECK(revision > 0),
  content_sha256       TEXT NOT NULL,
  profile_json         TEXT NOT NULL,
  state                TEXT NOT NULL CHECK(state IN ('canary','active','deprecated','revoked')),
  created_by           TEXT NOT NULL REFERENCES principals(principal_id),
  created_at           TEXT NOT NULL,
  UNIQUE(repo_id, name, revision),
  UNIQUE(repo_id, content_sha256),
  UNIQUE(repo_id, profile_revision_id)
);

CREATE TABLE IF NOT EXISTS policy_revisions (
  policy_revision_id  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  revision            INTEGER NOT NULL CHECK(revision > 0),
  content_sha256      TEXT NOT NULL UNIQUE,
  policy_json         TEXT NOT NULL,
  state               TEXT NOT NULL CHECK(state IN ('canary','active','deprecated','revoked')),
  created_by          TEXT NOT NULL REFERENCES principals(principal_id),
  created_at          TEXT NOT NULL,
  UNIQUE(name, revision)
);

CREATE TABLE IF NOT EXISTS runner_images (
  image_id          TEXT PRIMARY KEY,
  manifest_sha256   TEXT NOT NULL UNIQUE,
  vhdx_sha256       TEXT NOT NULL UNIQUE,
  manifest_json     TEXT NOT NULL,
  state             TEXT NOT NULL CHECK(state IN ('canary','active','retired','revoked')),
  created_at        TEXT NOT NULL,
  retired_at        TEXT
);

CREATE TABLE IF NOT EXISTS business_snapshots (
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
  bundle_size                INTEGER NOT NULL CHECK(bundle_size > 0),
  mr_provider_project_id     TEXT,
  mr_iid                     TEXT,
  mr_source_commit_oid       TEXT,
  mr_target_commit_oid       TEXT,
  merge_result_commit_oid    TEXT,
  merge_result_tree_oid      TEXT,
  created_by                 TEXT NOT NULL REFERENCES principals(principal_id),
  created_at                 TEXT NOT NULL,
  UNIQUE(repo_id, snapshot_id),
  FOREIGN KEY(repo_id, branch_incarnation_id)
    REFERENCES branch_incarnations(repo_id, branch_incarnation_id)
);

CREATE TABLE IF NOT EXISTS suite_plans (
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

CREATE TABLE IF NOT EXISTS test_bindings (
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

CREATE INDEX IF NOT EXISTS idx_bindings_task
  ON test_bindings(task_instance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  principal_id        TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id             TEXT REFERENCES repositories(repo_id),
  route               TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  request_sha256      TEXT NOT NULL,
  response_status     INTEGER NOT NULL,
  response_json       TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  expire_at           TEXT NOT NULL,
  PRIMARY KEY(principal_id, route, idempotency_key)
);
