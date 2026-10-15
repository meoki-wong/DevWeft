-- contracts/links.sql — 链路网关方案 §3/§14：三张表建表语句（纯 SQL，无 import，无 PRAGMA）
-- 幂等：仅用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS；时间用 ISO 文本。
-- 网关不执行本文件；由控制面 db/link-schema.js 读取并执行。

CREATE TABLE IF NOT EXISTS links (
  link_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_links (
  repo        TEXT PRIMARY KEY,
  link_id     TEXT,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
  call_id        TEXT PRIMARY KEY,
  repo           TEXT,
  task_id        TEXT,
  tool_name      TEXT,
  phase          TEXT,
  state          TEXT NOT NULL,
  status         TEXT,
  response_text  TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  served_by_link TEXT,
  failover_from  TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_task ON tool_calls(task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_links_sort ON links(sort_order, link_id);
CREATE UNIQUE INDEX IF NOT EXISTS links_one_primary ON links(is_primary) WHERE is_primary = 1;
