-- testing schema v20: FAIL_TO_PASS 验卷结果 + 断言强度
--
-- F2P 语义：同一份 spec 在 baseline（改动前）与 snapshot（改动后）两轮的结果。
--   f2p_status = 'ok'          → baseline 失败 + snapshot 通过（有效考卷）
--   f2p_status = 'always_pass' → 两轮都通过（恒过测试，走过场）
--   f2p_status = 'always_fail' → 两轮都失败（考卷本身有问题）
--   f2p_status = 'regressed'   → baseline 通过 + snapshot 失败（把功能测坏了）
--   f2p_status = 'skipped'     → 未跑两遍（baseline 不可达 / 档位未启用）

CREATE TABLE IF NOT EXISTS spec_f2p_results (
  result_id        TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repositories(repo_id),
  feature_key      TEXT NOT NULL,
  version          INTEGER NOT NULL,
  baseline_oid     TEXT NOT NULL,
  snapshot_oid     TEXT NOT NULL,
  baseline_result  TEXT CHECK(baseline_result IN ('passed','failed','error','skipped')),
  snapshot_result  TEXT CHECK(snapshot_result IN ('passed','failed','error','skipped')),
  f2p_status       TEXT NOT NULL CHECK(f2p_status IN ('ok','always_pass','always_fail','regressed','skipped')),
  detail           TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spec_f2p_run ON spec_f2p_results(run_id, feature_key);
CREATE INDEX IF NOT EXISTS idx_spec_f2p_status ON spec_f2p_results(repo_id, f2p_status, created_at);
