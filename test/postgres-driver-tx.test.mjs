/**
 * postgres-driver-tx.test.mjs — db.tx 的 savepoint 隔离 + FIFO 串行队列回归
 *
 * 事故回归点（2026-10-13）：
 *   dashboard 看板刷新 500 "current transaction is aborted" —— 三个坑叠加：
 *     ① SQLite 习气的 try/catch 吞错 + 继续用同一事务，PG 主事务被污染；
 *     ② 同事务里 Promise.all(map(async r => conn.query)) 并发发 SQL，
 *        pg 客户端在"正有查询未回"时再 query 会打 DeprecationWarning，
 *        一个失败让同批其他 SQL 都看到 aborted；
 *     ③ 给同事务包 savepoint 后并发压栈，PG 语义 RELEASE sp_10 会级联销毁
 *        其后创建的 sp_11，"savepoint does not exist" → 主事务再次进入 aborted。
 *   修复：runOn(client) 里所有 client.query 走同事务 FIFO q()；
 *         txHandle 暴露 savepoint(fn)；
 *         dashboard 端 optionalRead/isolate 优先走 conn.savepoint。
 *   这里把三条契约钉死。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { createPostgresHandle } from '../db/postgres-driver.mjs'

const DDL = `
CREATE TABLE t (id BIGINT PRIMARY KEY, name TEXT);
INSERT INTO t VALUES (1, 'a'), (2, 'b');
`

let pglite
let handle
beforeAll(async () => {
  pglite = await PGlite.create()
  await pglite.exec(DDL)
  handle = await createPostgresHandle({ poolLike: pglite })
})
afterAll(async () => { await pglite.close() })

describe('db.tx savepoint 隔离（回归"吞错污染主事务"）', () => {
  it('savepoint 里 SELECT 不存在的表被 catch：主事务后续 SELECT 仍可执行', async () => {
    const out = await handle.tx(async (tx) => {
      // 第一次读：走 savepoint 隔离，SQL 失败但被 catch 吞掉
      let firstFailed = null
      try {
        await tx.savepoint(async () => {
          await tx.prepare('SELECT * FROM does_not_exist').get()
        })
      } catch (e) { firstFailed = e }
      expect(firstFailed).toBeTruthy()
      // 关键：savepoint 失败只回滚到 savepoint，主事务仍可用
      const row = await tx.prepare('SELECT name FROM t WHERE id=?').get(1)
      return { firstFailed: firstFailed?.message, row }
    })
    expect(out.row).toEqual({ name: 'a' })
    expect(out.firstFailed).toMatch(/does_not_exist|relation|no such/i)
  })

  it('savepoint 内 UPDATE 失败：主事务未受影响，前置写入照常 COMMIT', async () => {
    await handle.tx(async (tx) => {
      await tx.prepare('INSERT INTO t VALUES (?, ?)').run(100, 'committed')
      try {
        await tx.savepoint(async () => {
          // 违反 PK：savepoint 内失败，回滚到 savepoint
          await tx.prepare('INSERT INTO t VALUES (?, ?)').run(1, 'dup')
        })
      } catch { /* ignore */ }
      // 主事务继续
      await tx.prepare('INSERT INTO t VALUES (?, ?)').run(101, 'after')
    })
    const rows = await handle.prepare('SELECT id FROM t WHERE id IN (100,101) ORDER BY id').all()
    expect(rows.map((r) => Number(r.id))).toEqual([100, 101])
  })

  it('嵌套 savepoint：内层失败仅回滚内层，外层数据保留', async () => {
    await handle.tx(async (tx) => {
      await tx.savepoint(async (sp1) => {
        await sp1.prepare('INSERT INTO t VALUES (?, ?)').run(200, 'outer-ok')
        try {
          await sp1.savepoint(async (sp2) => {
            await sp2.prepare('INSERT INTO t VALUES (?, ?)').run(201, 'inner-will-rollback')
            // 触发失败：NOT NULL 违反不了，那就用 PK 冲突
            await sp2.prepare('INSERT INTO t VALUES (?, ?)').run(200, 'conflict')
          })
        } catch { /* ignore */ }
      })
    })
    const outer = await handle.prepare('SELECT name FROM t WHERE id=200').get()
    const inner = await handle.prepare('SELECT name FROM t WHERE id=201').get()
    expect(outer).toEqual({ name: 'outer-ok' })
    // 内层 savepoint 回滚：201 那条也随内层一起消失
    expect(inner).toBeFalsy()
  })
})

describe('db.tx FIFO 串行（回归"同连接并发 query"）', () => {
  it('savepoint 交错压栈不再触发 savepoint-does-not-exist：模拟 dashboard 并发场景', async () => {
    // 事故复现：Promise.all 里多个 savepoint 并发压栈，
    // 老代码 RELEASE sp_10 会级联销毁 sp_11 → "savepoint does not exist" → 主事务 aborted。
    // 修复后：savepoint 语句都走同事务 FIFO q()，SAVEPOINT/RELEASE 严格按调用顺序排布，
    // 且 q 链让 fn 内的 SQL 与 savepoint 边界串行化，不再交错。
    // 修复前会抛 "savepoint awp_sp_2 does not exist"；
    // 修复后顶级并发 savepoint 走 mutex 串行化：两个 savepoint 都能成功，fn 返回聚合结果。
    const result = await handle.tx(async (tx) => {
      return await Promise.all([
        tx.savepoint(() => tx.prepare('SELECT name FROM t WHERE id=?').get(1)),
        tx.savepoint(() => tx.prepare('SELECT name FROM t WHERE id=?').get(2)),
      ])
    })
    expect(result.map((r) => r.name)).toEqual(['a', 'b'])
  })

  it('同事务 100 条并发 .get 不再产生 aborted 级联（FIFO 保证串行）', async () => {
    const arr = Array.from({ length: 100 }, (_, i) => (i % 2) + 1)
    const rows = await handle.tx(async (tx) => {
      return Promise.all(arr.map((id) => tx.prepare('SELECT name FROM t WHERE id=?').get(id)))
    })
    expect(rows.length).toBe(100)
    expect(rows.every((r) => r && (r.name === 'a' || r.name === 'b'))).toBe(true)
  })
})

describe('db.tx COMMIT/ROLLBACK 边界', () => {
  it('fn 抛错：主事务回滚，前置写入不落地', async () => {
    await expect(
      handle.tx(async (tx) => {
        await tx.prepare('INSERT INTO t VALUES (?, ?)').run(300, 'will-rollback')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    const row = await handle.prepare('SELECT name FROM t WHERE id=300').get()
    expect(row).toBeFalsy()
  })

  it('savepoint 吞错后 fn 抛错：savepoint 内的写入被回滚，主事务整体也回滚', async () => {
    await expect(
      handle.tx(async (tx) => {
        try {
          await tx.savepoint(async (sp) => {
            await sp.prepare('INSERT INTO t VALUES (?, ?)').run(400, 'sp-will-rollback')
          })
        } catch { /* ignore */ }
        throw new Error('outer-boom')
      })
    ).rejects.toThrow('outer-boom')
    const row = await handle.prepare('SELECT name FROM t WHERE id=400').get()
    expect(row).toBeFalsy()
  })
})
