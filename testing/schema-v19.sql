-- testing schema v19: 测试资产审核插槽（可插拔审核者）
--
-- 设计要点：
--   review_status  语义保持不变 —— 这条资产「参不参与门禁」（active = 参与）
--   review_*       新增四列     —— 审核记录（谁审的 / 何时 / 结论 / 意见）
--   两者分开是为了让门禁侧零改动：门禁只读 review_status，不关心是谁批的。
--   repo_test_policies.review_mode：审核档位（off/record/auto/ai/human），默认 record。
--
-- 幂等：ALTER TABLE ADD COLUMN 非幂等，由 migrate.js 按 pragma_table_info 门控。

ALTER TABLE test_specs ADD COLUMN reviewed_by     TEXT;  -- 'auto:pass'|'auto:contract'|'ai:<model>'|'human:<user>'
ALTER TABLE test_specs ADD COLUMN reviewed_at     TEXT;
ALTER TABLE test_specs ADD COLUMN review_decision TEXT;  -- 'pending'|'approved'|'rejected'|'abstain'
ALTER TABLE test_specs ADD COLUMN review_notes    TEXT;  -- 审核意见原文

ALTER TABLE repo_test_policies ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'record';

CREATE INDEX IF NOT EXISTS idx_test_specs_review
  ON test_specs(repo_id, review_status, reviewed_at);
