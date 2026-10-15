-- testing schema v27: experiences schema convergence
--
-- 目标：在真库（db.js 协作层 experiences：id/repo/content/status/author/...）上
-- 增补 testing/failures promote 所需字段，形成单一主结构。
--
-- 说明：
--   ALTER ADD COLUMN 非幂等，实际 apply 由 migrate.js 按列存在性门控执行
--   （对齐 v18/v24 模式），本文件作为意图与 review 文档。
--   NOT NULL 列必须带 DEFAULT，老数据 source_type 统一回填为 'manual'。

-- 标题（failures promote / 人工经验均可空）
-- ALTER TABLE experiences ADD COLUMN title TEXT;

-- 来源类型：manual | test_failure | ai_drift | verify_report
-- ALTER TABLE experiences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual';

-- 来源 id（test_failure → failure_id；manual 可空）
-- ALTER TABLE experiences ADD COLUMN source_id TEXT;

-- 评审人（与 reviewed_by 语义对齐，保留双名兼容）
-- ALTER TABLE experiences ADD COLUMN reviewer TEXT;

-- 置信度
-- ALTER TABLE experiences ADD COLUMN confidence REAL;

-- 失败指纹 / 晋升类型
-- ALTER TABLE experiences ADD COLUMN fingerprint TEXT;
-- ALTER TABLE experiences ADD COLUMN promotion_type TEXT;

-- 索引（task_id 仅在真库列存在时创建，由 migrate.js 门控）
-- CREATE INDEX IF NOT EXISTS idx_exp_task ON experiences(task_id);
-- CREATE INDEX IF NOT EXISTS idx_exp_fingerprint ON experiences(fingerprint);
-- CREATE INDEX IF NOT EXISTS idx_exp_created ON experiences(created_at);
