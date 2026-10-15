-- v12：门禁闭环（CLRP）——任务租约 + 环状态
-- 用途：enforce_all 下 AI 会话所有权、断点续作、失败返工环计数

CREATE TABLE IF NOT EXISTS task_sessions (
  session_id        TEXT PRIMARY KEY,
  repo              TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  owner_subject     TEXT NOT NULL,
  client_name       TEXT,
  state             TEXT NOT NULL DEFAULT 'coding',
  gate_iteration    INTEGER NOT NULL DEFAULT 0,
  last_binding_id   TEXT,
  last_packet_json  TEXT,
  heartbeat_at      TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  released_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_sessions_repo_task
  ON task_sessions(repo, task_id);
CREATE INDEX IF NOT EXISTS idx_task_sessions_owner
  ON task_sessions(owner_subject, released_at);

CREATE TABLE IF NOT EXISTS gate_loops (
  repo                  TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'coding',
  iteration             INTEGER NOT NULL DEFAULT 0,
  max_iterations        INTEGER NOT NULL DEFAULT 5,
  phase                 TEXT,
  size                  TEXT,
  required_units_json   TEXT NOT NULL DEFAULT '[]',
  pending_actions_json  TEXT NOT NULL DEFAULT '[]',
  last_binding_id       TEXT,
  last_expected_revision INTEGER,
  last_submission_id    TEXT,
  last_run_group_id     TEXT,
  last_terminal         TEXT,
  last_class            TEXT,
  await_distill         INTEGER NOT NULL DEFAULT 0,
  needs_human           INTEGER NOT NULL DEFAULT 0,
  waiver_id             TEXT,
  history_json          TEXT NOT NULL DEFAULT '[]',
  updated_at            TEXT NOT NULL,
  PRIMARY KEY (repo, task_id)
);
