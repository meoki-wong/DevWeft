/**
 * migrate.js — 增量 schema 迁移（幂等，服务启动时自动执行）
 */
import db from '../db.js'

function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  return cols.some((c) => c.name === column)
}

export function runHarnessMigrations() {
  // 方案 §13.1：postgres 方言下第一行 return（基线已含最终结构）
  if (process.env.AWP_DB_DIALECT === 'postgres') return
  if (!columnExists('verify_reports', 'task_id')) {
    db.exec('ALTER TABLE verify_reports ADD COLUMN task_id TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_verify_task ON verify_reports(task_id)')
    console.log('[harness] 迁移: verify_reports.task_id')
  }

  if (!columnExists('tasks', 'size')) {
    db.exec('ALTER TABLE tasks ADD COLUMN size TEXT')
    console.log('[harness] 迁移: tasks.size')
  }

  if (!columnExists('tasks', 'meta')) {
    db.exec("ALTER TABLE tasks ADD COLUMN meta TEXT DEFAULT '{}'")
    console.log('[harness] 迁移: tasks.meta')
  }
}
