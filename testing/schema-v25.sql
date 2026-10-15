-- v25: accepted_run_results 支持多 attempt（run 重推后旧 attempt 的结果不再被新 attempt 顶掉）
-- 原表 run_id 单列主键：run 走完 infra_error/lost → 人工重推 → 新 attempt complete 时
-- INSERT 撞主键，只能靠删旧结果绕开（丢审计）。改为 (run_id, attempt, lease_epoch) 复合主键。
PRAGMA foreign_keys=off;

CREATE TABLE accepted_run_results_v25 (
  run_id             TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  lease_epoch        INTEGER NOT NULL,
  result_sha256      TEXT NOT NULL,
  accepted_at        TEXT NOT NULL,
  PRIMARY KEY (run_id, attempt, lease_epoch),
  FOREIGN KEY(run_id) REFERENCES test_runs(run_id),
  FOREIGN KEY(run_id, attempt, lease_epoch)
    REFERENCES run_attempts(run_id, attempt, lease_epoch)
);

INSERT OR IGNORE INTO accepted_run_results_v25(run_id, attempt, lease_epoch, result_sha256, accepted_at)
SELECT run_id, attempt, lease_epoch, result_sha256, accepted_at FROM accepted_run_results;

DROP TABLE accepted_run_results;
ALTER TABLE accepted_run_results_v25 RENAME TO accepted_run_results;

PRAGMA foreign_keys=on;
