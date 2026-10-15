-- v41: repository-defined smoke lane names; the profile owns the side vocabulary.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE test_runs_v41 (
  run_id               TEXT PRIMARY KEY,
  run_group_id         TEXT NOT NULL REFERENCES run_groups(run_group_id),
  binding_id           TEXT NOT NULL REFERENCES test_bindings(binding_id),
  repo_id              TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id     TEXT NOT NULL REFERENCES task_instances(task_instance_id),
  unit                 TEXT NOT NULL CHECK(unit IN ('static','smoke')),
  side                 TEXT NOT NULL CHECK(length(trim(side)) > 0),
  purpose              TEXT NOT NULL DEFAULT 'gate' CHECK(purpose IN ('gate','diagnostic','mutation')),
  diagnostic_of_run_id TEXT REFERENCES test_runs_v41(run_id),
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
  payload_json         TEXT,
  steps_json           TEXT,
  coverage_complete    INTEGER,
  UNIQUE(repo_id, run_id),
  FOREIGN KEY(repo_id, run_group_id)
    REFERENCES run_groups(repo_id, run_group_id),
  FOREIGN KEY(repo_id, binding_id)
    REFERENCES test_bindings(repo_id, binding_id),
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);

INSERT INTO test_runs_v41 (
  run_id, run_group_id, binding_id, repo_id, task_instance_id,
  unit, side, purpose, diagnostic_of_run_id, priority, status, desired_state,
  max_attempts, next_attempt, lease_epoch, queue_wait_ms, total_ms,
  result_sha256, report_json, terminal_reason, created_at, started_at, finished_at,
  payload_json, steps_json, coverage_complete
)
SELECT
  run_id, run_group_id, binding_id, repo_id, task_instance_id,
  unit, side, purpose, diagnostic_of_run_id, priority, status, desired_state,
  max_attempts, next_attempt, lease_epoch, queue_wait_ms, total_ms,
  result_sha256, report_json, terminal_reason, created_at, started_at, finished_at,
  payload_json, steps_json, coverage_complete
FROM test_runs;

DROP TABLE test_runs;
ALTER TABLE test_runs_v41 RENAME TO test_runs;

CREATE INDEX idx_runs_queue ON test_runs(status, priority, created_at);
CREATE INDEX idx_runs_binding ON test_runs(binding_id, unit, side, purpose, status);
CREATE INDEX idx_runs_task ON test_runs(repo_id, task_instance_id, created_at DESC);
