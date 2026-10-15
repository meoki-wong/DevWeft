/**
 * build-link-fork.test.mjs — UI 链路分叉读模型（db/tool-calls.js buildLinkFork）
 *
 * 隔离 sqlite 库，纯库级断言，不经 HTTP。覆盖：
 *  1. 无切换（单链路）→ fork null, events []；
 *  2. 显式 failover_from → 检出 fork 事件，标签经 links.name 解析；
 *  3. 无 failover_from 的 session 级迁移（served_by_link 相邻变化）→ 检出 fork 事件；
 *  4. 多次切换 → 返回所有事件（fork/recover 时间序列）；
 *  5. 存量库缺归因列 → 静默 fork null, events []，不抛错；
 *  6. repo 过滤：仅匹配 repo 或 repo IS NULL 的行参与判定；
 *  7. 无数据 / 无 taskId → fork null, events []；
 *  8. fork + recover 场景 → 检出两个事件，类型正确；
 *  9. 多次 fork/recover 交替 → 检出所有事件。
 */
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync } from 'node:fs'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
import { ensureLinkSchema } from '../db/link-schema.js'
import { buildLinkFork } from '../db/tool-calls.js'

installSqliteTx(Database)

const cleanups = []
afterAll(async () => {
  for (const fn of cleanups) {
    try { await fn() } catch { /* 尽力而为 */ }
  }
})

function memdb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'awp-linkfork-'))
  const db = new Database(path.join(dir, 't.db'))
  db.pragma('foreign_keys = ON')
  cleanups.push(() => db.close())
  ensureLinkSchema(db)
  return db
}

const T0 = '2026-10-07T10:00:00.000Z'
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60000).toISOString()

/** 落一条 tool_calls；attribution 可为 { servedBy, failoverFrom }。 */
function call(db, { callId, taskId = 'T-1', repo = 'demo', phase = null, minutes, tool = 'harness_advance', state = 'finished', servedBy = null, failoverFrom = null }) {
  db.prepare(
    `INSERT INTO tool_calls (call_id, repo, task_id, tool_name, phase, state, status, response_text, started_at, finished_at, served_by_link, failover_from)
     VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?)`
  ).run(callId, repo, taskId, tool, phase, state, at(minutes), state === 'finished' ? at(minutes + 1) : null, servedBy, failoverFrom)
}

function seedLinks(db) {
  // primary 已由 ensureLinkSchema 种子插入（name=主链路），这里只补备用链路
  db.prepare(`INSERT INTO links (link_id, name, base_url, sort_order, is_primary, enabled, created_at, updated_at)
              VALUES ('backup', '备用链路', 'http://127.0.0.1:8792', 1, 0, 1, ?, ?)`).run(T0, T0)
}

describe('buildLinkFork', () => {
  it('1) 无切换（全程同一链路）→ fork null, events []', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 5, servedBy: 'primary' })
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.ok).toBe(true)
    expect(r.fork).toBeNull()
    expect(r.events).toEqual([])
  })

  it('2) 显式 failover_from → 检出 fork 事件，标签经 links.name 解析', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 10, phase: 'execute', servedBy: 'backup', failoverFrom: 'primary' })
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.fork).not.toBeNull()
    expect(r.fork.forkPhase).toBe('execute')
    expect(r.fork.primaryLabel).toBe('主链路')
    expect(r.fork.backupLabel).toBe('备用链路')
    expect(r.fork.forkCallId).toBe('c2')
    expect(r.fork.forkAt).toBe(at(10))
    // 新字段：events 数组
    expect(r.events).toHaveLength(1)
    expect(r.events[0].type).toBe('fork')
    expect(r.events[0].phase).toBe('execute')
    expect(r.events[0].fromLink).toBe('primary')
    expect(r.events[0].toLink).toBe('backup')
    expect(r.events[0].fromLabel).toBe('主链路')
    expect(r.events[0].toLabel).toBe('备用链路')
  })

  it('3) session 级迁移（无 failover_from，served_by_link 相邻变化）→ 检出 fork 事件', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 10, phase: 'execute', servedBy: 'backup' })
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.fork).not.toBeNull()
    expect(r.fork.forkCallId).toBe('c2')
    expect(r.fork.primaryLabel).toBe('主链路')
    expect(r.fork.backupLabel).toBe('备用链路')
    expect(r.events).toHaveLength(1)
    expect(r.events[0].type).toBe('fork')
  })

  it('4) 多次切换 → 返回所有事件（fork/recover 时间序列）', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 5, phase: 'execute', servedBy: 'backup' }) // 第一次切换：fork
    call(db, { callId: 'c3', minutes: 10, phase: 'static', servedBy: 'primary' }) // 切回：recover
    call(db, { callId: 'c4', minutes: 15, phase: 'smoke', servedBy: 'backup' }) // 再次切换：fork
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    // 向后兼容：fork 字段返回最近一次 fork 事件
    expect(r.fork.forkCallId).toBe('c4')
    expect(r.fork.forkPhase).toBe('smoke')
    // 新字段：events 数组包含所有事件
    expect(r.events).toHaveLength(3)
    expect(r.events[0].type).toBe('fork')
    expect(r.events[0].callId).toBe('c2')
    expect(r.events[1].type).toBe('recover')
    expect(r.events[1].callId).toBe('c3')
    expect(r.events[2].type).toBe('fork')
    expect(r.events[2].callId).toBe('c4')
  })

  it('5) 存量库缺归因列 → 静默 fork null, events []，不抛错', async () => {
    const db = memdb()
    db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
      call_id TEXT PRIMARY KEY, repo TEXT, task_id TEXT, tool_name TEXT, phase TEXT,
      state TEXT NOT NULL, status TEXT, response_text TEXT, started_at TEXT NOT NULL, finished_at TEXT
    )`)
    call(db, { callId: 'c1', minutes: 0 })
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.ok).toBe(true)
    expect(r.fork).toBeNull()
    expect(r.events).toEqual([])
  })

  it('6) repo 过滤：只统计匹配 repo 或 repo IS NULL 的行；links 查不到的链路退回原文', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, repo: 'other', servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 5, repo: null, servedBy: 'unknown-link' })
    call(db, { callId: 'c3', minutes: 10, repo: 'demo', servedBy: 'backup' }) // 变化点（相对 c2）
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.fork).not.toBeNull()
    expect(r.fork.forkCallId).toBe('c3')
    expect(r.fork.primaryLabel).toBe('unknown-link') // 不在 links 表 → 退回 link_id 原文
    expect(r.fork.backupLabel).toBe('备用链路')
    expect(r.events).toHaveLength(1)
    expect(r.events[0].fromLabel).toBe('unknown-link')
  })

  it('7) 无数据 / 无 taskId → fork null, events []', async () => {
    const db = memdb()
    const r1 = await buildLinkFork(db, { taskId: 'T-404', repo: 'demo' })
    expect(r1.fork).toBeNull()
    expect(r1.events).toEqual([])
    const r2 = await buildLinkFork(db, { taskId: '' })
    expect(r2.fork).toBeNull()
    expect(r2.events).toEqual([])
  })

  it('8) fork + recover 场景 → 检出两个事件，类型正确', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, phase: 'execute', servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 5, phase: 'execute', servedBy: 'backup', failoverFrom: 'primary' }) // fork
    call(db, { callId: 'c3', minutes: 10, phase: 'static', servedBy: 'backup' }) // 备用链路继续
    call(db, { callId: 'c4', minutes: 15, phase: 'static', servedBy: 'primary' }) // recover（主链路恢复）
    call(db, { callId: 'c5', minutes: 20, phase: 'smoke', servedBy: 'primary' }) // 主链路继续
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.events).toHaveLength(2)
    expect(r.events[0].type).toBe('fork')
    expect(r.events[0].phase).toBe('execute')
    expect(r.events[0].fromLink).toBe('primary')
    expect(r.events[0].toLink).toBe('backup')
    expect(r.events[1].type).toBe('recover')
    expect(r.events[1].phase).toBe('static')
    expect(r.events[1].fromLink).toBe('backup')
    expect(r.events[1].toLink).toBe('primary')
    // 向后兼容：fork 字段返回最近一次 fork 事件
    expect(r.fork.forkCallId).toBe('c2')
  })

  it('9) 多次 fork/recover 交替 → 检出所有事件', async () => {
    const db = memdb()
    seedLinks(db)
    call(db, { callId: 'c1', minutes: 0, servedBy: 'primary' })
    call(db, { callId: 'c2', minutes: 5, phase: 'execute', servedBy: 'backup' }) // fork 1
    call(db, { callId: 'c3', minutes: 10, phase: 'static', servedBy: 'primary' }) // recover 1
    call(db, { callId: 'c4', minutes: 15, phase: 'smoke', servedBy: 'backup' }) // fork 2
    call(db, { callId: 'c5', minutes: 20, phase: 'distill', servedBy: 'primary' }) // recover 2
    const r = await buildLinkFork(db, { taskId: 'T-1', repo: 'demo' })
    expect(r.events).toHaveLength(4)
    expect(r.events.map((e) => e.type)).toEqual(['fork', 'recover', 'fork', 'recover'])
    expect(r.events.map((e) => e.phase)).toEqual(['execute', 'static', 'smoke', 'distill'])
  })
})
