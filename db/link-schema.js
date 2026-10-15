/**
 * db/link-schema.js — 链路网关方案 §3/§14：读取 contracts/links.sql 幂等建三表 + 主链路种子。
 *
 * - 控制面调用（db.js 的 openDb/initDB）；网关不连接数据库，不执行本文件。
 * - sqlite：better-sqlite3 为同步 API，当场跑完，避免 initDB() 同步上下文里留悬空 Promise。
 * - postgres：句柄的 exec/prepare 返回 Promise，逐句 await。
 * - 种子只插一行主链路；重复执行「不报错、不插第二条主链路」（COUNT=0 且无 is_primary=1 才插 + ON CONFLICT DO NOTHING）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LINKS_SQL_PATH = path.join(__dirname, '..', 'contracts', 'links.sql')

const SEED = {
  linkId: 'primary',
  name: '主链路',
  baseUrl: 'http://127.0.0.1:8791',
  sortOrder: 0,
}

const COUNT_SQL = 'SELECT COUNT(*) AS c FROM links'
const PRIMARY_SQL = 'SELECT link_id AS id FROM links WHERE is_primary = 1 LIMIT 1'
const INSERT_SQL = `INSERT INTO links (link_id, name, base_url, sort_order, is_primary, enabled, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`

/** 去掉 -- 行注释后按分号切分为独立语句（本文件 DDL 字符串内无分号） */
function readStatements() {
  const raw = fs.readFileSync(LINKS_SQL_PATH, 'utf8')
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

function seedParams(nowIso) {
  return [SEED.linkId, SEED.name, SEED.baseUrl, SEED.sortOrder, 1, 1, nowIso, nowIso]
}

// tool_calls 链路归因列（UI 链路分叉数据源）：新库由 contracts/links.sql 建出；存量库在此幂等补列。
const TC_ATTR_COLUMNS = [
  ['served_by_link', 'ALTER TABLE tool_calls ADD COLUMN served_by_link TEXT'],
  ['failover_from', 'ALTER TABLE tool_calls ADD COLUMN failover_from TEXT'],
]

async function ensureToolCallAttrColumns(db) {
  if (db.dialect === 'postgres') {
    for (const [col, ddl] of TC_ATTR_COLUMNS) {
      const row = await db
        .prepare(
          `SELECT count(*) AS n FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'tool_calls' AND column_name = ?`
        )
        .get(col)
      if (!Number(row?.n)) await db.exec(ddl)
    }
    return
  }
  for (const [col, ddl] of TC_ATTR_COLUMNS) {
    const cols = db.prepare('PRAGMA table_info(tool_calls)').all()
    if (!cols.some((c) => c.name === col)) db.exec(ddl)
  }
}

/**
 * ensureLinkSchema(db) — 建三表 + 幂等主链路种子。
 * sqlite 分支同步执行完毕并返回已 resolve 的 Promise；postgres 分支返回异步 Promise。
 * 两分支都可在调用点安全 await；sqlite 调用点（initDB）不 await 也能当场完成建表/种子。
 */
export function ensureLinkSchema(db) {
  const statements = readStatements()
  const now = new Date().toISOString()

  if (db.dialect === 'postgres') {
    return (async () => {
      for (const stmt of statements) await db.exec(stmt)
      const cnt = Number((await db.prepare(COUNT_SQL).get())?.c ?? 0)
      if (cnt === 0 && !(await db.prepare(PRIMARY_SQL).get())) {
        await db.prepare(INSERT_SQL).run(...seedParams(now))
      }
      await ensureToolCallAttrColumns(db)
      return db
    })()
  }

  // sqlite：better-sqlite3 全同步（ensureToolCallAttrColumns 在 sqlite 分支内无 await，当场跑完）
  for (const stmt of statements) db.exec(stmt)
  const cnt = Number(db.prepare(COUNT_SQL).get()?.c ?? 0)
  if (cnt === 0 && !db.prepare(PRIMARY_SQL).get()) {
    db.prepare(INSERT_SQL).run(...seedParams(now))
  }
  ensureToolCallAttrColumns(db)
  return Promise.resolve(db)
}

export { LINKS_SQL_PATH }
