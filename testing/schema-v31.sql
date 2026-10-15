-- schema-v31.sql — test_specs 受控表重建：spec_type 扩展 api 类型 + execution_config_json 列
-- （业务能力线 T5.1。SQLite CHECK 无法 ALTER，须建新表→复制→换名。）
-- 列清单对齐生产实表全部 25 列（v1 基础 + v10 side + v18 acceptance_refs_json/pages_json/mutation_verified
-- + v19 reviewed_by/reviewed_at/review_decision/review_notes + scope）+ 新增 execution_config_json。
-- 迁移由 testing/migrate-v31.js 执行：同事务、幂等（按 CHECK 内容门控）、动态列交集复制保数据。

CREATE TABLE IF NOT EXISTS test_specs_v31_new (
  spec_id         TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repositories(repo_id),
  feature_key     TEXT NOT NULL,
  feature_title   TEXT,
  demand_ref      TEXT,
  author          TEXT NOT NULL,
  spec_type       TEXT NOT NULL DEFAULT 'e2e' CHECK(spec_type IN ('smoke','e2e','unit','api')),
  entry           TEXT NOT NULL,
  blob_sha256     TEXT NOT NULL,
  code_commit_oid TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  review_status   TEXT NOT NULL DEFAULT 'draft'
                  CHECK(review_status IN ('draft','reviewed','active','archived','orphan-candidate')),
  last_result     TEXT,
  fail_streak     INTEGER NOT NULL DEFAULT 0,
  side            TEXT,
  acceptance_refs_json TEXT,
  pages_json      TEXT,
  mutation_verified INTEGER NOT NULL DEFAULT 0,
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  review_decision TEXT,
  review_notes    TEXT,
  scope           TEXT DEFAULT 'task',
  execution_config_json TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_test_specs_feature_version
  ON test_specs_v31_new(repo_id, feature_key, version);
CREATE INDEX IF NOT EXISTS idx_test_specs_repo_feature
  ON test_specs_v31_new(repo_id, feature_key, review_status);
CREATE INDEX IF NOT EXISTS idx_test_specs_demand
  ON test_specs_v31_new(repo_id, demand_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_specs_author
  ON test_specs_v31_new(repo_id, author, updated_at DESC);
