/**
 * deferred-health.test.mjs — P0-2b 队列健康 + P0-2a 活跃 worker 计数
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, it, expect, beforeEach } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { recordDeferredSubmission, getDeferredHealth } from '../testing/deferred.js'
import { countOtherActiveWorkers } from '../testing/workers.js'

async function freshDb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-dhealth-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  await db.exec(`INSERT OR IGNORE INTO repositories(repo_id, slug, created_at) VALUES ('r1','demo-app','2026-01-01T00:00:00Z')`)
  return db
}

describe('getDeferredHealth', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('空表 → 全 0，无红灯', async () => {
    const h = await getDeferredHealth(db)
    expect(h.counts).toMatchObject({ pending: 0, processed: 0, failed: 0 })
    expect(h.redFlag).toBe(false)
    expect(h.oldestPendingAgeMs).toBe(0)
  })

  it('有 pending → 计数 + 年龄；超阈值红灯', async () => {
    await recordDeferredSubmission(db, { repoId: 'r1', taskId: 't', author: 'a', side: 'web', codeDiff: 'diff --git a/x b/x\n@@ -1 +1 @@\n-o\n+n\n' })
    const h = await getDeferredHealth(db)
    expect(h.counts.pending).toBe(1)
    expect(h.oldestPendingAgeMs).toBeGreaterThanOrEqual(0)
    expect(h.redFlag).toBe(false) // 刚建，未超 120s 阈值
    // 造陈旧 created_at 触发红灯
    await db.prepare('UPDATE deferred_submissions SET created_at=?').run(new Date(Date.now() - 300000).toISOString())
    const h2 = await getDeferredHealth(db)
    expect(h2.redFlag).toBe(true)
    expect(h2.oldestPendingAgeMs).toBeGreaterThan(120000)
  })
})

describe('countOtherActiveWorkers', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('只数他机活跃且心跳未过期的 worker', async () => {
    const now = new Date()
    const fresh = now.toISOString()
    const stale = new Date(now.getTime() - 5 * 60000).toISOString()
    await db.prepare('INSERT INTO workers(worker_id, hostname, status, last_heartbeat_at, created_at, certificate_thumbprint, capabilities_json) VALUES (?,?,?,?,?,?,?)')
      .run('w-self', 'h', 'active', fresh, fresh, 'tp-self', '[]')
    await db.prepare('INSERT INTO workers(worker_id, hostname, status, last_heartbeat_at, created_at, certificate_thumbprint, capabilities_json) VALUES (?,?,?,?,?,?,?)')
      .run('w-other', 'h2', 'active', fresh, fresh, 'tp-other', '[]')
    await db.prepare('INSERT INTO workers(worker_id, hostname, status, last_heartbeat_at, created_at, certificate_thumbprint, capabilities_json) VALUES (?,?,?,?,?,?,?)')
      .run('w-dead', 'h3', 'active', stale, stale, 'tp-dead', '[]')
    const n = await countOtherActiveWorkers(db, 'w-self', { now, ttlMs: 60000 })
    expect(n).toBe(1) // 只有 w-other 活跃且非 self（w-dead 心跳过期）
  })
})
