/**
 * 批次1：v26 迁移 + 全链路 trace 查询
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'

// audit 模块绑定真实 db.js；这里直接测 schema 与查询 SQL 形状
describe('schema v26 observability', () => {
  it('创建 lifecycle / policy decisions / platform_settings + audit 扩列', async () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-v26-')), 't.db'))
    await runTestingMigrations(db, { skipLegacyMap: true })
    const tables = (await db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('run_lifecycle_events','gate_policy_decisions','platform_settings')`)
      .all())
      .map((r) => r.name)
    expect(tables).toContain('run_lifecycle_events')
    expect(tables).toContain('gate_policy_decisions')
    expect(tables).toContain('platform_settings')
    const cols = (await db.prepare(`PRAGMA table_info(audit_events)`).all()).map((c) => c.name)
    for (const c of ['trace_id', 'submission_id', 'run_id', 'attempt', 'binding_id', 'payload_json', 'phase']) {
      expect(cols).toContain(c)
    }
    const v26 = await db.prepare('SELECT version, name FROM schema_migrations WHERE version=26').get()
    expect(v26?.name).toBe('observability_trace')
  })

  it('lifecycle 与 audit 可按 trace 关联插入', async () => {
    const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-v26b-')), 't.db'))
    await runTestingMigrations(db, { skipLegacyMap: true })
    await db.prepare(
      `INSERT INTO audit_events(event_type, tool_name, status, created_at, trace_id, task_id, payload_json)
       VALUES ('mcp_tool', 'awp_test_run', 'ok', 't1', 'tr-1', 'T1', '{"a":1}')`
    ).run()
    await db.prepare(
      `INSERT INTO run_lifecycle_events(event_id, run_id, event_type, detail_json, trace_id, task_id, created_at)
       VALUES ('e1', 'run-1', 'acquire', '{}', 'tr-1', 'T1', 't2')`
    ).run()
    const joined = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM audit_events WHERE trace_id='tr-1') AS a,
                (SELECT COUNT(*) FROM run_lifecycle_events WHERE trace_id='tr-1') AS l`
      )
      .get()
    expect(joined.a).toBe(1)
    expect(joined.l).toBe(1)
  })
})
