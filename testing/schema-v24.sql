-- v24: 考卷作用域 scope（task=任务相关才注入 / regression=常驻回归全量注入）
ALTER TABLE test_specs ADD COLUMN scope TEXT NOT NULL DEFAULT 'task';
