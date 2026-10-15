/**
 * platform-settings.test.mjs — 平台设置严格校验 + 健康检查（阶段 4）
 *
 * Worker 并发值本期明确契约：接受整数 1/2/3 或精确字符串 "1"/"2"/"3"；
 * 拒绝 0、4、空串、"3x"、"2.9"、浮点、null、对象。不再以宽松 parseInt 作为合法性判断。
 * 健康检查：live 恒 200；ready 对健康库 200、坏句柄 503。
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import { validateWorkerConcurrency, setWorkerConcurrency, getWorkerConcurrency } from '../testing/platform-settings.js'
import { mountHealthRoutes } from '../dashboard/health.js'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('worker_concurrency 严格契约', () => {
  it('接受整数 1/2/3 与精确字符串 "1"/"2"/"3"', () => {
    for (const v of [1, 2, 3, '1', '2', '3']) {
      expect(validateWorkerConcurrency(v), String(v)).toBe(true)
    }
  })

  it('拒绝 0、4、越界、空串、垃圾尾缀、浮点、null、对象', () => {
    for (const v of [0, 4, -1, '0', '4', '', '3x', '2.9', 2.9, null, undefined, {}, ['2'], true]) {
      expect(validateWorkerConcurrency(v), JSON.stringify(v)).toBe(false)
    }
  })

  it('setWorkerConcurrency 非法值抛 INVALID_SCHEMA 且不改旧值', async () => {
    const raw = new Database(join(mkdtempSync(join(tmpdir(), 'awp-ps-')), 't.db'))
    await runTestingMigrations(raw, { skipLegacyMap: true })
    expect((await setWorkerConcurrency(raw, 3)).value).toBe('3')
    await expect(setWorkerConcurrency(raw, 4)).rejects.toThrow(/INVALID_SCHEMA/)
    await expect(setWorkerConcurrency(raw, 'x')).rejects.toThrow(/INVALID_SCHEMA/)
    expect(await getWorkerConcurrency(raw)).toBe('3')
    raw.close()
  })
})

describe('健康检查 live/ready', () => {
  function mkApp(database) {
    const app = express()
    mountHealthRoutes(app, { database })
    return app
  }

  it('live 恒 200；健康库 ready 200 且结构齐全', async () => {
    const raw = new Database(join(mkdtempSync(join(tmpdir(), 'awp-hl-')), 't.db')) // 顶层已 installSqliteTx,dialect 标记随原型
    await runTestingMigrations(raw, { skipLegacyMap: true })
    const app = mkApp(raw)
    const server = app.listen(0)
    await new Promise((r) => server.on('listening', r))
    const base = `http://127.0.0.1:${server.address().port}`

    const live = await fetch(`${base}/api/health/live`)
    expect(live.status).toBe(200)
    expect((await live.json()).live).toBe(true)

    const ready = await fetch(`${base}/api/health/ready`)
    expect(ready.status).toBe(200)
    const rb = await ready.json()
    expect(rb.ready).toBe(true)
    expect(rb.checks.every((c) => c.ok)).toBe(true)
    server.close()
    raw.close()
  })

  it('坏数据库句柄 → ready 503 + 明确原因（不谎报就绪）', async () => {
    const app = mkApp({
      prepare: () => { throw new Error('db locked') },
    })
    const server = app.listen(0)
    await new Promise((r) => server.on('listening', r))
    const base = `http://127.0.0.1:${server.address().port}`
    const ready = await fetch(`${base}/api/health/ready`)
    expect(ready.status).toBe(503)
    const rb = await ready.json()
    expect(rb.ready).toBe(false)
    expect(rb.checks.some((c) => c.ok === false)).toBe(true)
    server.close()
  })
})
