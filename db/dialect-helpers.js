/**
 * dialect-helpers.js — 方案 §2.8：SQLite 方言语句的方言感知封装
 *
 * isPostgres(db)：postgres 驱动返回 dialect:'postgres'；sqlite 实例由 installSqliteTx 挂 dialect:'sqlite'。
 * tableExists(db, name)：sqlite 用 sqlite_master，postgres 用 information_schema.tables。
 * columnExists(db, table, column)：sqlite 用 PRAGMA table_info，postgres 用 information_schema.columns。
 * 历史迁移路径（testing/migrate.js 等）不使用本模块——它们在 postgres 方言下第一行 return。
 */

export function isPostgres(db) {
  return db?.dialect === 'postgres'
}

export async function tableExists(db, name) {
  if (isPostgres(db)) {
    const row = await db
      .prepare('SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?')
      .get(name)
    return !!row
  }
  const row = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  return !!row
}

export async function columnExists(db, table, column) {
  if (isPostgres(db)) {
    const row = await db
      .prepare('SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?')
      .get(table, column)
    return !!row
  }
  const cols = (await db.prepare(`PRAGMA table_info(${table})`).all()).map((c) => c.name)
  return cols.includes(column)
}
