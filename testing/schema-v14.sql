-- testing schema v14: repo_gate_modes 增加 disabled 档（云端测试按仓独立可插拔）
-- SQLite 无法修改 CHECK 约束，采用重建表方式，数据全量保留。
-- 幂等性由 migrate.js 按 sqlite_master.sql 是否已含 'disabled' 门控。

CREATE TABLE IF NOT EXISTS repo_gate_modes_new (
  repo_id    TEXT PRIMARY KEY REFERENCES repositories(repo_id),
  mode       TEXT NOT NULL CHECK(mode IN ('legacy','observe','enforce_s','enforce_all','disabled')),
  updated_at TEXT NOT NULL
);

INSERT INTO repo_gate_modes_new(repo_id, mode, updated_at)
  SELECT repo_id, mode, updated_at FROM repo_gate_modes;

DROP TABLE repo_gate_modes;
ALTER TABLE repo_gate_modes_new RENAME TO repo_gate_modes;
