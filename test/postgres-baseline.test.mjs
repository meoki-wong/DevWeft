/**
 * postgres-baseline.test.mjs — postgres_baseline 登记的幂等/并发/撞号回归（§13.1）
 *
 * 事故回归点：openDb() 曾按 version 判存在、以硬编码的新版本号插入同名行，
 * 撞上 schema_migrations_name_key（23505）导致进程启动即退、PM2 重启 38 万次。
 * 这里把三条约定钉死：
 *   1. 身份是 name，不是 version；重复调用只登记一次；
 *   2. 版本按 MAX(非基线)+1 推导 —— 账本已有任意高版本也不会撞号；
 *   3. 多进程并发登记只留一行。
 * 另含静态守卫：db.js / import 脚本不得再硬编码基线版本号。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { createPostgresHandle } from '../db/postgres-driver.mjs'
import {
  PG_BASELINE_NAME,
  SCHEMA_MIGRATIONS_DDL,
  ensurePostgresBaselineRegistered,
} from '../db/postgres-baseline.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function newHandle() {
  const pglite = await PGlite.create()
  const handle = await createPostgresHandle({ poolLike: pglite })
  return { handle, pglite }
}

async function baselineRows(handle) {
  return handle.prepare('SELECT version, name FROM schema_migrations WHERE name = ?').all(PG_BASELINE_NAME)
}

describe('postgres_baseline 登记（db/postgres-baseline.js）', () => {
  it('空账本：登记一行，版本从 1 起', async () => {
    const { handle, pglite } = await newHandle()
    const reg = await ensurePostgresBaselineRegistered(handle)
    expect(reg.action).toBe('inserted')
    expect(reg.version).toBe(1)
    expect((await baselineRows(handle)).length).toBe(1)
    await pglite.close()
  })

  it('幂等：重复调用不新增行、不改写版本', async () => {
    const { handle, pglite } = await newHandle()
    await handle.exec(SCHEMA_MIGRATIONS_DDL)
    await handle
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(1, 'identity_snapshot_binding', 'x', 't')

    const first = await ensurePostgresBaselineRegistered(handle)
    expect(first).toEqual({ action: 'inserted', version: 2 })

    for (let i = 0; i < 3; i++) {
      expect(await ensurePostgresBaselineRegistered(handle)).toEqual({ action: 'exists', version: 2 })
    }
    const rows = await baselineRows(handle)
    expect(rows.length).toBe(1)
    expect(Number(rows[0].version)).toBe(2)
    await pglite.close()
  })

  it('撞号防护：账本已有更高版本时基线落到 max+1（历史 v37/v38 硬编码事故的正解）', async () => {
    const { handle, pglite } = await newHandle()
    await handle.exec(SCHEMA_MIGRATIONS_DDL)
    for (const [v, n] of [[36, 'tenant_extensions'], [37, 'mutation_verdict'], [38, 'something_newer']]) {
      await handle
        .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(v, n, 'x', 't')
    }

    const reg = await ensurePostgresBaselineRegistered(handle)
    expect(reg).toEqual({ action: 'inserted', version: 39 })
    // 既有行一个都不能动
    expect(
      Number((await handle.prepare('SELECT COUNT(*) AS c FROM schema_migrations WHERE name <> ?').get(PG_BASELINE_NAME)).c)
    ).toBe(3)
    await pglite.close()
  })

  it('已登记在低版本号时不迁就、不报错（存量库 v37 场景）', async () => {
    const { handle, pglite } = await newHandle()
    await handle.exec(SCHEMA_MIGRATIONS_DDL)
    await handle
      .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
      .run(37, PG_BASELINE_NAME, 'baseline-v1', 't')

    const reg = await ensurePostgresBaselineRegistered(handle)
    expect(reg).toEqual({ action: 'exists', version: 37 })
    expect((await baselineRows(handle)).length).toBe(1)
    await pglite.close()
  })

  it('并发登记：并行调用只留一行', async () => {
    const { handle, pglite } = await newHandle()
    await handle.exec(SCHEMA_MIGRATIONS_DDL)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensurePostgresBaselineRegistered(handle))
    )
    expect(results.some((r) => r.action === 'inserted')).toBe(true)
    for (const r of results) expect(r.version).toBe(results[0].version)
    expect((await baselineRows(handle)).length).toBe(1)
    await pglite.close()
  })

  it('name 唯一约束是登记幂等性的前提，DDL 必须带 UNIQUE', () => {
    expect(SCHEMA_MIGRATIONS_DDL).toMatch(/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
    const baselineSql = fs.readFileSync(path.join(root, 'sql', 'postgres', 'baseline.sql'), 'utf8')
    expect(baselineSql).toMatch(/name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i)
  })

  it('静态守卫：db.js 与导入脚本须复用 db/postgres-baseline.js，不得自行写 SQL', () => {
    for (const rel of ['db.js', 'scripts/import-team-db.mjs']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8')
      expect(src, `${rel} 应引用 db/postgres-baseline.js`).toMatch(/postgres-baseline\.js/)
      expect(src, `${rel} 不得内联 INSERT INTO schema_migrations（版本号错配的源头）`).not.toMatch(
        /INSERT\s+INTO\s+schema_migrations/i
      )
      expect(src, `${rel} 不得内联基线表 DDL`).not.toMatch(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+schema_migrations/i)
    }
  })
})