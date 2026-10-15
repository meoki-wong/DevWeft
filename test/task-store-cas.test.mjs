/**
 * task-store：phase CAS + 同事务写入
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'
import { transitionTask, saveTaskVersion } from '../harness/task-store.js'

async function memdb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  // 协作层 tasks 表（与 db.js 同构 + harness/migrate 补列）
  await db.exec(`
    CREATE TABLE tasks (
      task_id TEXT NOT NULL, repo TEXT NOT NULL, tenant_id TEXT NOT NULL, requirement TEXT, type TEXT, phase TEXT,
      completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
      author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
      size TEXT, meta TEXT DEFAULT '{}',
      PRIMARY KEY (repo, task_id)
    );
    CREATE TABLE task_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, repo TEXT NOT NULL, tenant_id TEXT NOT NULL,
      phase TEXT, snapshot TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE task_sessions (
      session_id TEXT PRIMARY KEY, repo TEXT NOT NULL, tenant_id TEXT NOT NULL, task_id TEXT NOT NULL,
      owner_subject TEXT, state TEXT, heartbeat_at TEXT, expires_at TEXT, released_at TEXT
    );
    CREATE TABLE gate_loops (
      repo TEXT NOT NULL, task_id TEXT NOT NULL, tenant_id TEXT NOT NULL, state TEXT, iteration INTEGER DEFAULT 0,
      max_iterations INTEGER DEFAULT 5, phase TEXT, size TEXT,
      required_units_json TEXT, pending_actions_json TEXT,
      last_binding_id TEXT, last_expected_revision TEXT, last_submission_id TEXT,
      last_run_group_id TEXT, last_terminal TEXT, last_class TEXT,
      await_distill INTEGER DEFAULT 0, needs_human INTEGER DEFAULT 0, waiver_id TEXT,
      history_json TEXT, updated_at TEXT,
      PRIMARY KEY (repo, task_id)
    );
  `)
  await db.exec(`CREATE TABLE repositories (repo_id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE)`)
  await db.prepare(`INSERT INTO repositories (repo_id, slug) VALUES ('repo-r1', 'r1')`).run()
  await db.prepare(
    `INSERT INTO tasks (task_id, repo, tenant_id, phase, author, created_at, updated_at)
     VALUES ('T1', 'r1', 'repo-r1', 'CLASSIFY', 'a', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO gate_loops (repo, task_id, tenant_id, state, phase, history_json, updated_at)
     VALUES ('r1', 'T1', 'repo-r1', 'coding', 'CLASSIFY', '[]', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO task_sessions (session_id, repo, tenant_id, task_id, owner_subject, state, expires_at)
     VALUES ('s1', 'r1', 'repo-r1', 'T1', 'a', 'coding', '2099-01-01T00:00:00.000Z')`
  ).run()
  return db
}

describe('task-store transitionTask', () => {
  it('advances phase with CAS and writes version + loop in same transaction', async () => {
    const db = await memdb()
    const r = await transitionTask(db, {
      repo: 'r1',
      taskId: 'T1',
      fromPhase: 'CLASSIFY',
      to: 'EXECUTE',
      merged: { size: 'M', completed: [], pending: ['code'], decisions: [], meta: { a: 1 } },
      author: 'a',
      loopPatch: { phase: 'EXECUTE', size: 'M', state: 'coding' },
    })
    expect(r.ok).toBe(true)
    const task = await db.prepare(`SELECT phase, size FROM tasks WHERE task_id='T1'`).get()
    expect(task.phase).toBe('execute')
    expect(task.size).toBe('M')
    const ver = await db.prepare(`SELECT phase FROM task_versions WHERE task_id='T1'`).get()
    expect(ver.phase).toBe('execute')
    const loop = await db.prepare(`SELECT phase, size FROM gate_loops WHERE task_id='T1'`).get()
    expect(loop.phase).toBe('execute')
    db.close()
  })

  it('PHASE_CONFLICT when fromPhase does not match; no version snapshot', async () => {
    const db = await memdb()
    await expect(
      transitionTask(db, {
        repo: 'r1',
        taskId: 'T1',
        fromPhase: 'PLAN', // actual is CLASSIFY
        to: 'EXECUTE',
        merged: { size: 'M' },
        author: 'a',
      })
    ).rejects.toThrow(/PHASE_CONFLICT/)
    expect((await db.prepare(`SELECT phase FROM tasks WHERE task_id='T1'`).get()).phase).toBe('CLASSIFY')
    expect((await db.prepare(`SELECT COUNT(*) c FROM task_versions`).get()).c).toBe(0)
    db.close()
  })

  it('second concurrent-style advance from stale phase fails', async () => {
    const db = await memdb()
    await transitionTask(db, {
      repo: 'r1', taskId: 'T1', fromPhase: 'CLASSIFY', to: 'EXECUTE',
      merged: { size: 'S' }, author: 'a',
    })
    // 仍按旧 phase 再推 → CAS 失败
    await expect(
      transitionTask(db, {
        repo: 'r1', taskId: 'T1', fromPhase: 'CLASSIFY', to: 'VERIFY',
        merged: { size: 'S' }, author: 'b',
      })
    ).rejects.toThrow(/PHASE_CONFLICT/)
    expect((await db.prepare(`SELECT phase FROM tasks WHERE task_id='T1'`).get()).phase).toBe('execute')
    // 只有一条成功版本
    expect((await db.prepare(`SELECT COUNT(*) c FROM task_versions`).get()).c).toBe(1)
    db.close()
  })

  it('DONE releases session and sets closed_at', async () => {
    const db = await memdb()
    await transitionTask(db, {
      repo: 'r1', taskId: 'T1', fromPhase: 'CLASSIFY', to: 'DONE',
      merged: { size: 'S', meta: {} }, author: 'a',
      loopPatch: { state: 'coding', phase: 'DONE', needsHuman: false, pendingActions: [], awaitDistill: 0 },
      releaseSession: true,
    })
    const task = await db.prepare(`SELECT phase, closed_at FROM tasks WHERE task_id='T1'`).get()
    expect(task.phase).toBe('done')
    expect(task.closed_at).toBeTruthy()
    db.close()
  })
})
