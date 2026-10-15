/**
 * cas-worker.mjs — 真并发 CAS 子进程
 * 由 platform-integrity.test.mjs fork；收到 IPC 'go' 屏障后同时抢推同一 task。
 * 单独进程打开同一 db 文件，构成真实跨进程写竞争。
 */
import { openSync, closeSync } from 'node:fs'
import { installSqliteTx } from '../../db/sqlite-tx.js'
process.on('message', async (m) => {
  if (m !== 'go') return
  try {
    const dbPathIdx = process.argv.indexOf('--db')
    const dbPath = process.argv[dbPathIdx + 1]
    const { default: Database } = await import('better-sqlite3')
    installSqliteTx(Database)
    const { transitionTask } = await import('../../harness/task-store.js')
    const db = new Database(dbPath)
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    try {
      const r = await transitionTask(db, {
        repo: 'cas-repo',
        taskId: 'T-CAS',
        fromPhase: 'EXECUTE',
        to: 'VERIFY',
        merged: { size: 'M', completed: [], pending: [], decisions: [], meta: {} },
        author: `worker-${process.pid}`,
      })
      process.send({ ok: true, to: r.to })
    } catch (e) {
      process.send({ ok: false, code: e.code || null, message: e.message })
    } finally {
      try { db.close() } catch { /* ignore */ }
    }
  } catch (e) {
    process.send({ ok: false, error: e.message })
  }
})
