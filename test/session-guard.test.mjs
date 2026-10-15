/**
 * session-guard：owner 校验 + 灰度
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { assertTaskDriver, isStrictSessionEnabled, acquireOrHeartbeatSession } from '../harness/session-guard.js'
import { setPlatformSetting } from '../harness/gate-policy.js'

async function memdb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  await db.exec(`
    CREATE TABLE task_sessions (
      session_id TEXT PRIMARY KEY, repo TEXT NOT NULL, task_id TEXT NOT NULL,
      owner_subject TEXT, client_name TEXT, state TEXT,
      heartbeat_at TEXT, created_at TEXT NOT NULL, expires_at TEXT, released_at TEXT
    );
  `)
  return db
}

async function seedSession(db, owner = 'alice') {
  await db.prepare(
    `INSERT INTO task_sessions (session_id, repo, task_id, owner_subject, state, heartbeat_at, created_at, expires_at)
     VALUES ('s1', 'r1', 'T1', ?, 'coding', 't', 't', '2099-01-01T00:00:00.000Z')`
  ).run(owner)
}

describe('session-guard', () => {
  it('default is warn: non-owner passes with wouldBlock', async () => {
    const db = await memdb()
    expect(await isStrictSessionEnabled(db)).toBe(false)
    await seedSession(db, 'alice')
    const r = await assertTaskDriver(db, { repo: 'r1', taskId: 'T1', author: 'bob' })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('warn')
    expect(r.wouldBlock).toMatch(/alice/)
    db.close()
  })

  it('enforce: non-owner blocked TASK_SESSION_HELD', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'harness_strict_session', { enabled: true })
    expect(await isStrictSessionEnabled(db)).toBe(true)
    await seedSession(db, 'alice')
    const r = await assertTaskDriver(db, { repo: 'r1', taskId: 'T1', author: 'bob' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TASK_SESSION_HELD')
    expect(r.owner).toBe('alice')
    db.close()
  })

  it('owner passes and heartbeats', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'harness_strict_session', { enabled: true })
    await seedSession(db, 'alice')
    const r = await assertTaskDriver(db, { repo: 'r1', taskId: 'T1', author: 'alice' })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('owner')
    db.close()
  })

  it('no session: free pass', async () => {
    const db = await memdb()
    const r = await assertTaskDriver(db, { repo: 'r1', taskId: 'T1', author: 'bob' })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('free')
    db.close()
  })

  it('resume acquire failure returns ok=false under enforce', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'harness_strict_session', { enabled: true })
    await seedSession(db, 'alice')
    const r = await acquireOrHeartbeatSession(db, { repo: 'r1', taskId: 'T1', author: 'bob' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('TASK_SESSION_HELD')
    db.close()
  })

  it('resume acquire failure is warn under default', async () => {
    const db = await memdb()
    await seedSession(db, 'alice')
    const r = await acquireOrHeartbeatSession(db, { repo: 'r1', taskId: 'T1', author: 'bob' })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('warn')
    db.close()
  })
})
