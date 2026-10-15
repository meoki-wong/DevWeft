-- v13：按仓测试策略（隔离仓库测试契约，避免干扰后续接入项目）
-- enforce_spec_contract=1：submit 校验 Playwright baseURL/side 契约
-- enable_sides=1 enables repository-configured smoke lanes and declared sides.
-- 新仓默认 0/0：不启用 仓库级规则

CREATE TABLE IF NOT EXISTS repo_test_policies (
  repo_id              TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  enforce_spec_contract INTEGER NOT NULL DEFAULT 0,
  enable_sides          INTEGER NOT NULL DEFAULT 0,
  runner_hint           TEXT,
  updated_at            TEXT NOT NULL
);
