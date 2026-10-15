-- testing schema v9: 测试资产库（feature-key 索引的服务端集中存储）
-- 设计：AI coding 生成的测试脚本不入业务仓库，集中存测试平台服务端
-- feature_key（业务功能键，如 store-audit-flow）是查询/组织的核心索引
-- version 语义：同一 feature_key 的修订历史（功能变更时递增），不是"每个版本重生成"
-- code_commit_oid：spec 最近同步时的业务仓库 HEAD，用于执行时漂移检测（防线二）
-- 三道防线：①开发时 MCP 工具先查后改（主）②code_commit_oid 漂移检测（兜底）
--          ③fail_streak>=3 自动标 orphan-candidate 进待评审（防线三）

CREATE TABLE IF NOT EXISTS test_specs (
  spec_id         TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repositories(repo_id),
  feature_key     TEXT NOT NULL,              -- 业务功能键（store-audit-flow）
  feature_title   TEXT,                       -- 人读标题
  demand_ref      TEXT,                       -- 来源需求标识
  author          TEXT NOT NULL,              -- 创建/维护人
  spec_type       TEXT NOT NULL DEFAULT 'e2e' CHECK(spec_type IN ('smoke','e2e','unit')),
  entry           TEXT NOT NULL,              -- 入口文件名（如 store-audit-flow.spec.mjs）
  blob_sha256     TEXT NOT NULL,              -- 内容寻址（data/blobs）
  code_commit_oid TEXT,                       -- 同步时的业务仓库 HEAD（漂移锚点）
  version         INTEGER NOT NULL DEFAULT 1, -- 同 feature_key 修订递增
  review_status   TEXT NOT NULL DEFAULT 'draft'
                  CHECK(review_status IN ('draft','reviewed','active','archived','orphan-candidate')),
  last_result     TEXT,                       -- 最近执行：passed/failed/null
  fail_streak     INTEGER NOT NULL DEFAULT 0, -- 连续失败计数
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_test_specs_feature_version
  ON test_specs(repo_id, feature_key, version);
CREATE INDEX IF NOT EXISTS idx_test_specs_repo_feature
  ON test_specs(repo_id, feature_key, review_status);
CREATE INDEX IF NOT EXISTS idx_test_specs_demand
  ON test_specs(repo_id, demand_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_specs_author
  ON test_specs(repo_id, author, updated_at DESC);
