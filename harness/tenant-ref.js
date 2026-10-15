/**
 * tenant-ref.js — 跨租户任务查找的唯一入口（方案第 1 节）
 *
 * 替代 server.js 里两处「不带租户的 task_id 查找」
 * （SELECT ... FROM tasks WHERE task_id = ? ORDER BY updated_at DESC LIMIT 1）。
 * 只做读取与归属解析，不含写入逻辑（写入在 task-store.js / state-machine.js）。
 */

/**
 * 解析 taskId 的归属 repo。
 * - 传入 repo：必须 (repo, taskId) 精确存在
 * - 未传 repo：task_id 命中 1 行 → 该行 repo；0 行 → TASK_NOT_FOUND；多行 → AMBIGUOUS_TASK_REPO
 *
 * SQL 取出全部行、在 JavaScript 里数长度；禁止 ORDER BY updated_at LIMIT 1（方案 §5.1）。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ taskId: string, repo?: string|null }} input
 * @returns {{ ok: true, repo: string } | { ok: false, code: 'TASK_NOT_FOUND' | 'AMBIGUOUS_TASK_REPO' }}
 */
export async function resolveTaskRepo(db, { taskId, repo = null }) {
  const id = taskId == null ? '' : String(taskId)
  if (repo != null && String(repo) !== '') {
    const hit = await db
      .prepare('SELECT 1 FROM tasks WHERE repo = ? AND task_id = ?')
      .get(String(repo), id)
    return hit ? { ok: true, repo: String(repo) } : { ok: false, code: 'TASK_NOT_FOUND' }
  }
  const rows = await db.prepare('SELECT repo FROM tasks WHERE task_id = ?').all(id)
  if (rows.length === 0) return { ok: false, code: 'TASK_NOT_FOUND' }
  if (rows.length > 1) return { ok: false, code: 'AMBIGUOUS_TASK_REPO' }
  return { ok: true, repo: rows[0].repo }
}
