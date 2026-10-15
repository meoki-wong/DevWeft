/**
 * audit/migrate.js — 调用审计表（幂等迁移）
 */
import db from '../db.js'

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  return cols.some((c) => c.name === column)
}

export function runAuditMigrations() {
  // 方案 §13.1：postgres 方言下第一行 return（基线已含 audit_events 最终结构）
  if (process.env.AWP_DB_DIALECT === 'postgres') return
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type    TEXT NOT NULL,
      session_id    TEXT,
      tool_name     TEXT,
      method        TEXT,
      author        TEXT,
      repo          TEXT,
      task_id       TEXT,
      client_name   TEXT,
      args_preview  TEXT,
      status        TEXT DEFAULT 'ok',
      duration_ms   INTEGER,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_author ON audit_events(author);
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool_name);
  `)

  if (!columnExists('audit_events', 'detail')) {
    db.exec('ALTER TABLE audit_events ADD COLUMN detail TEXT')
  }
}
