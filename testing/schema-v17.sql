-- testing schema v17: 项目默认测试环境（dev/qa，默认 qa）
-- 独立小表：不挂在 repo_test_policies 上，避免为其造行触发 seedRepoGateModesEnforce 副作用。

CREATE TABLE IF NOT EXISTS repo_env_settings (
  repo_id         TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  default_test_env TEXT NOT NULL CHECK(default_test_env IN ('dev','qa')),
  updated_at      TEXT NOT NULL
);
