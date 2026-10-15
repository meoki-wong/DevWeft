-- testing schema v26: 全链路埋点（trace / lifecycle / policy decisions / platform settings）

-- audit_events 扩列（幂等由 migrate.js 门控）
-- trace_id / submission_id / run_id / attempt / binding_id / payload_json / phase

CREATE TABLE IF NOT EXISTS run_lifecycle_events (
  event_id      TEXT PRIMARY KEY,
  run_id        TEXT,
  attempt       INTEGER,
  lease_epoch   INTEGER,
  event_type    TEXT NOT NULL,
  detail_json   TEXT,
  trace_id      TEXT,
  repo_id       TEXT,
  task_id       TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rle_run ON run_lifecycle_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rle_trace ON run_lifecycle_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_rle_type ON run_lifecycle_events(event_type, created_at);

CREATE TABLE IF NOT EXISTS gate_policy_decisions (
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

CREATE INDEX IF NOT EXISTS idx_gpd_task ON gate_policy_decisions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gpd_repo ON gate_policy_decisions(repo_id, created_at);

CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  value_json  TEXT,
  updated_at  TEXT NOT NULL
);
