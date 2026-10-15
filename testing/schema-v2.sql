-- testing schema v2: submissions and queued runs (no worker/attempt yet)

CREATE TABLE IF NOT EXISTS test_submissions (
  submission_id          TEXT PRIMARY KEY,
  client_request_id      TEXT NOT NULL,
  principal_id           TEXT NOT NULL REFERENCES principals(principal_id),
  repo_id                TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id       TEXT NOT NULL REFERENCES task_instances(task_instance_id),
  binding_id             TEXT NOT NULL REFERENCES test_bindings(binding_id),
  expected_task_revision INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS run_groups (
  run_group_id        TEXT PRIMARY KEY,
  repo_id             TEXT NOT NULL REFERENCES repositories(repo_id),
  submission_id       TEXT NOT NULL REFERENCES test_submissions(submission_id),
  binding_id          TEXT NOT NULL REFERENCES test_bindings(binding_id),
  kind                TEXT NOT NULL CHECK(kind IN ('formal','candidate')),
  gate_eligible       INTEGER NOT NULL CHECK(gate_eligible IN (0,1)),
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

CREATE TABLE IF NOT EXISTS test_runs (
  run_id               TEXT PRIMARY KEY,
  run_group_id         TEXT NOT NULL REFERENCES run_groups(run_group_id),
  binding_id           TEXT NOT NULL REFERENCES test_bindings(binding_id),
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id     TEXT NOT NULL REFERENCES task_instances(task_instance_id),
  unit                 TEXT NOT NULL CHECK(unit IN ('static','smoke')),
  side                 TEXT NOT NULL CHECK(length(trim(side)) > 0),
  purpose              TEXT NOT NULL DEFAULT 'gate' CHECK(purpose IN ('gate','diagnostic')),
  diagnostic_of_run_id TEXT REFERENCES test_runs(run_id),
  priority             INTEGER NOT NULL DEFAULT 5,
  status               TEXT NOT NULL CHECK(status IN (
    'queued','active','passed','failed','error','canceled',
    'timed_out','lost','superseded'
  )),
  desired_state        TEXT NOT NULL DEFAULT 'running'
                         CHECK(desired_state IN ('running','canceled')),
  max_attempts         INTEGER NOT NULL DEFAULT 2 CHECK(max_attempts BETWEEN 1 AND 3),
  next_attempt         INTEGER NOT NULL DEFAULT 0 CHECK(next_attempt >= 0),
  lease_epoch          INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  queue_wait_ms        INTEGER,
  total_ms             INTEGER,
  result_sha256        TEXT,
  report_json          TEXT,
  terminal_reason      TEXT CHECK(terminal_reason IN (
    'assertion_failed','dependency_input','product_hang','lost','timed_out',
    'infra_error','canceled','superseded'
  )),
  created_at           TEXT NOT NULL,
  started_at           TEXT,
  finished_at          TEXT,
  UNIQUE(repo_id, run_id),
  FOREIGN KEY(repo_id, run_group_id)
    REFERENCES run_groups(repo_id, run_group_id),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_queue
  ON test_runs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_binding
  ON test_runs(binding_id, unit, side, purpose, status);
CREATE INDEX IF NOT EXISTS idx_runs_task
  ON test_runs(repo_id, task_instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_task
  ON test_submissions(repo_id, task_instance_id, created_at DESC);
