-- v22: attempt 分步流程时间线（看板结束后可点开逐步追踪）
-- steps_json: [{at, phase, name, status, detail, durationMs}]
ALTER TABLE run_attempts ADD COLUMN steps_json TEXT;
