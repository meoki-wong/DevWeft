-- testing schema v3: per-repo harness gate mode + observe diffs

CREATE TABLE IF NOT EXISTS repo_gate_modes (
  repo_id    TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  mode       TEXT NOT NULL CHECK(mode IN ('legacy','observe','enforce_s','enforce_all')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_observe_events (
  event_id           TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(repo_id),
  task_instance_id   TEXT,
  legacy_task_id     TEXT NOT NULL,
  transition         TEXT NOT NULL,
  mode               TEXT NOT NULL,
  legacy_would_block INTEGER NOT NULL CHECK(legacy_would_block IN (0,1)),
  new_would_block    INTEGER NOT NULL CHECK(new_would_block IN (0,1)),
  differ             INTEGER NOT NULL CHECK(differ IN (0,1)),
  gate_binding_id    TEXT,
  payload_json       TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  FOREIGN KEY(repo_id, task_instance_id)
    REFERENCES task_instances(repo_id, task_instance_id)
);
