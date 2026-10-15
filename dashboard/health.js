/**
 * dashboard/health.js — 轻量健康检查（阶段 4 / T4.3）
 *
 * 与 /api/health（全量表计数）互补：
 *  - GET /api/health/live  进程存活探针（无依赖，恒 200）
 *  - GET /api/health/ready 就绪探针：SQLite 可查询 + 关键结构存在 + 迁移账本一致
 *    失败 → 503 + 明确原因（不把 worker/broker/外部后端作为控制面就绪的强依赖）
 */
import { SCHEMA_VERSION, CONTRACT_VERSION } from '../contracts/version.mjs'

export function mountHealthRoutes(app, { database = null, expectedSchemaVersion = SCHEMA_VERSION } = {}) {
  app.get('/api/health/live', (req, res) => {
    res.json({ ok: true, live: true, at: new Date().toISOString() })
  })

  app.get('/api/health/ready', async (req, res) => {
    const checks = []
    let ready = true
    let dbOk = false
    try {
      if (!database) throw new Error('no database handle')
      const one = await database.prepare('SELECT 1 AS one').get()
      dbOk = one?.one === 1
      checks.push({ name: 'sqlite_query', ok: dbOk })
    } catch (err) {
      checks.push({ name: 'sqlite_query', ok: false, reason: err.message })
      ready = false
    }

    if (dbOk) {
      try {
        const tables = ['repositories', 'test_runs', 'test_bindings', 'schema_migrations']
        // 方言感知(§2.8):sqlite 探测 sqlite_master,postgres 探测 information_schema
        const probe = database.dialect === 'postgres'
          ? (t) => database.prepare(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?`).get(t)
          : (t) => database.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`).get(t)
        for (const t of tables) {
          const row = await probe(t)
          checks.push({ name: `table:${t}`, ok: row.n > 0 })
          if (!row.n) ready = false
        }
      } catch (err) {
        checks.push({ name: 'tables', ok: false, reason: err.message })
        ready = false
      }

      try {
        const applied = (await database.prepare(
          `SELECT count(*) AS n FROM schema_migrations`
        ).get()).n
        checks.push({ name: 'migrations_applied', ok: applied > 0, applied })
        if (!applied) ready = false
      } catch (err) {
        checks.push({ name: 'migrations_applied', ok: false, reason: err.message })
        ready = false
      }
    }

    if (ready) {
      res.json({ ok: true, ready: true, schemaVersion: expectedSchemaVersion, contractVersion: CONTRACT_VERSION, checks })
    } else {
      res.status(503).json({ ok: false, ready: false, schemaVersion: expectedSchemaVersion, checks })
    }
  })
}
