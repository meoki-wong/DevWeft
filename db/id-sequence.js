/**
 * id-sequence — 替代 COUNT(*)+1 的日序列分配
 *
 * 表：id_sequences(scope TEXT PRIMARY KEY, next INTEGER NOT NULL)
 * scope 格式：`${kind}:${YYYYMMDD}`，如 exp:20260917
 * 返回：exp-20260917-001 / rep-20260917-001（格式与旧 nextExpId/nextRepId 兼容）
 *
 * 并发：UPDATE + RETURNING 位于 IMMEDIATE 事务内，多进程无重复、删史不回退。
 */
import Database from 'better-sqlite3'

function todayStamp(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '')
}

/**
 * 分配下一个 ID（0 起，补零 3 位）
 * @param {import('better-sqlite3').Database} db
 * @param {'exp'|'rep'} kind
 */
export async function nextId(db, kind, { now = new Date() } = {}) {
  if (kind !== 'exp' && kind !== 'rep') {
    throw new Error(`nextId: unknown kind ${kind}`)
  }
  const day = todayStamp(now)
  const scope = `${kind}:${day}`
  const tx = async (tx) => {
    await tx.prepare(`
      INSERT INTO id_sequences(scope, next)
      VALUES (?, 1)
      ON CONFLICT(scope) DO NOTHING
    `).run(scope)
    // RETURNING 需 SQLite >= 3.35（better-sqlite3 11.x 自带满足）
    const row = await tx.prepare(`
      UPDATE id_sequences
      SET next = next + 1
      WHERE scope = ?
      RETURNING next - 1 AS n
    `).get(scope)
    if (!row) throw new Error(`nextId: sequence row missing for ${scope}`)
    return row.n
  }
  const n = await db.tx(tx)
  return `${kind}-${day}-${String(n).padStart(3, '0')}`
}

/**
 * 从现有表回填 next 水位，避免与历史 ID 碰撞。
 * 取 `prefix-YYYYMMDD-%` 的最大数字后缀 + 1。
 */
export function backfillIdSequence(db, kind, table, idColumn = 'id', { now = new Date() } = {}) {
  const day = todayStamp(now)
  const like = `${kind}-${day}-%`
  const rows = db.prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} LIKE ?`).all(like)
  let max = 0
  for (const r of rows) {
    const m = String(r.id).match(/-(\d+)$/)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  if (max <= 0) return 0
  const scope = `${kind}:${day}`
  db.prepare(`
    INSERT INTO id_sequences(scope, next) VALUES (?, ?)
    ON CONFLICT(scope) DO UPDATE SET next = MAX(next, excluded.next)
  `).run(scope, max + 1)
  return max + 1
}

export function createIdSequencesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS id_sequences (
      scope TEXT PRIMARY KEY,
      next  INTEGER NOT NULL
    );
  `)
}

// 自检：node -e 风格入口
if (process.argv[1] && process.argv[1].endsWith('id-sequence.js')) {
  const db = new Database(':memory:')
  createIdSequencesTable(db)
  const a = await nextId(db, 'exp')
  const b = await nextId(db, 'exp')
  const c = await nextId(db, 'rep')
  console.log({ a, b, c })
  db.close()
}
