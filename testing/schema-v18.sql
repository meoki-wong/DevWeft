-- testing schema v18: AC 覆盖 + 跨页面归因 + 经验分类
-- test_specs 两列按列存在性门控（v11 模式）；experiences 属协作层表，仅当表存在时门控加列。

ALTER TABLE test_specs ADD COLUMN acceptance_refs_json TEXT;
ALTER TABLE test_specs ADD COLUMN pages_json TEXT;
ALTER TABLE test_specs ADD COLUMN mutation_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE test_runs ADD COLUMN payload_json TEXT;
