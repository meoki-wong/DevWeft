-- testing schema v5: secret_grants（§13.6）。控制面只存 ref 与状态，明文只在 broker/Guest 临时文件。

CREATE TABLE IF NOT EXISTS secret_grants (
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

CREATE INDEX IF NOT EXISTS idx_secret_grants_lease
  ON secret_grants(lease_id, status);
