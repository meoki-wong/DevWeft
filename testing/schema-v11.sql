-- v11：business_snapshots.changed_files_json —— 提交时刻算好的本任务改动文件清单（JSON 数组，posix 相对路径，规范化排序）
-- 用途：eslint 基线 ratchet（test:static/eslint-ratchet）——改动命中 .eslintignore 基线条目即 failed，
-- 要求修净该文件存量违规并把条目移出基线（基线只减不增）。worker 拾取 run 时读出注入 guest。
ALTER TABLE business_snapshots ADD COLUMN changed_files_json TEXT;
