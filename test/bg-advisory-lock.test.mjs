/**
 * bg-advisory-lock.test.mjs — 链路网关方案 §5 完成标准
 *
 * 两个 postgres 连接里只有一个 pg_try_advisory_lock(878701) 返回真（会话级锁，持连不还池）。
 * 用独立 PG（维护库 postgres，非业务库）临时断言，不连生产业务库；PG 不可达则跳过。
 * 走 createPostgresHandle().acquireSessionClient()，镜像 server.js start() 的真实取锁路径。
 */
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { createPostgresHandle } from '../db/postgres-driver.mjs'
import { createBackgroundOwner } from '../db/background-owner.js'

const ADMIN_URL = process.env.AWP_PG_URL || 'postgresql://awp@127.0.0.1:5433/awp'
const MAINT_URL = ADMIN_URL.replace(/\/[^/]+$/, '/postgres') // 连维护库，绝不碰 awp 业务数据
const LOCK_KEY = 878701

// 顶层 await 探测：在 describe 注册用例前确定 PG 是否可达（供 maybe 选择 it / it.skip）
let pgAvailable = false
{
  const probe = new pg.Pool({ connectionString: MAINT_URL, max: 1 })
  try {
    const c = await probe.connect()
    c.release()
    pgAvailable = true
  } catch {
    pgAvailable = false
  } finally {
    try { await probe.end() } catch { /* ignore */ }
  }
}

const maybe = pgAvailable ? it : it.skip

describe('§5 后台咨询锁（pg_try_advisory_lock）', () => {
  it('acquireSessionClient 取到的连接能跑查询（持连不归还）', async () => {
    if (!pgAvailable) return
    const handle = await createPostgresHandle({ connectionString: MAINT_URL, max: 1 })
    const client = await handle.acquireSessionClient()
    const r = await client.query('SELECT 1 AS one')
    expect(Number(r.rows[0].one)).toBe(1)
    client.release()
    await handle.close()
  })

  maybe('两条连接中仅一条拿到 878701；另一条返回假', async () => {
    const h1 = await createPostgresHandle({ connectionString: MAINT_URL, max: 1 })
    const h2 = await createPostgresHandle({ connectionString: MAINT_URL, max: 1 })
    const c1 = await h1.acquireSessionClient()
    const c2 = await h2.acquireSessionClient()
    try {
      const l1 = await c1.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`)
      const l2 = await c2.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`)
      expect(l1.rows[0].locked).toBe(true) // 第一个持锁
      expect(l2.rows[0].locked).toBe(false) // 第二个拿不到
      // 释放后第二个可拿到
      await c1.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
      const l2b = await c2.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`)
      expect(l2b.rows[0].locked).toBe(true)
      await c2.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
    } finally {
      c1.release(); c2.release()
      await h1.close(); await h2.close()
    }
  })

  maybe('会话锁随连接关闭自动解除（模拟进程退出）', async () => {
    // 用裸 Client 直接 end() 断开 TCP → 会话锁释放；不用 pool.end()（若有 checkout 未还会挂起）
    const c1 = new pg.Client({ connectionString: MAINT_URL })
    await c1.connect()
    const l1 = await c1.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`)
    expect(l1.rows[0].locked).toBe(true)
    await c1.end() // 断连：不显式 unlock，会话锁应随之释放
    const c2 = new pg.Client({ connectionString: MAINT_URL })
    await c2.connect()
    const l2 = await c2.query(`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`)
    expect(l2.rows[0].locked).toBe(true)
    await c2.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`)
    await c2.end()
  })
})

// ─── 控制器（db/background-owner.js）单元测：用共享假锁存储 + 手动 tick，不依赖真 PG ───
function makeLockEnv() {
  const store = { holderId: null, seq: 0, clients: [] }
  const acquireClient = () => {
    const client = {
      id: ++store.seq,
      alive: true,
      released: false,
      async query(sql) {
        if (!client.alive) throw new Error('conn closed') // 模拟持锁连接死亡
        if (/pg_try_advisory_lock/.test(sql)) {
          if (store.holderId == null) { store.holderId = client.id; return { rows: [{ locked: true }] } }
          return { rows: [{ locked: false }] }
        }
        if (/pg_advisory_unlock/.test(sql)) { if (store.holderId === client.id) store.holderId = null; return { rows: [] } }
        if (/SELECT 1/.test(sql)) return { rows: [{}] }
        return { rows: [] }
      },
      release() { client.released = true; if (store.holderId === client.id) store.holderId = null },
    }
    store.clients.push(client)
    return Promise.resolve(client)
  }
  // 模拟 owner 的连接断开（PG 随之释放会话锁）
  const killHolder = () => { const c = store.clients.find((x) => x.id === store.holderId); if (c) { c.alive = false; store.holderId = null } }
  return { store, acquireClient, killHolder }
}

describe('§5 后台所有权控制器（自动接管）', () => {
  it('sqlite：首次 tick 即独占，onAcquire 只调一次', async () => {
    let acquires = 0
    const o = createBackgroundOwner({ isPostgres: false, acquireClient: () => { throw new Error('sqlite 不应取连接') }, onAcquire: () => { acquires++ } })
    await o.tick(); await o.tick(); await o.tick()
    expect(acquires).toBe(1)
    expect(o.owns).toBe(true)
  })

  it('pg 互斥 + 接管：A 拿到→B 拿不到；A 连接失效→停后台；B 重抢成功', async () => {
    const { store, acquireClient, killHolder } = makeLockEnv()
    let acqA = 0, relA = 0, acqB = 0, relB = 0
    const A = createBackgroundOwner({ isPostgres: true, acquireClient, onAcquire: () => { acqA++ }, onRelease: () => { relA++ } })
    const B = createBackgroundOwner({ isPostgres: true, acquireClient, onAcquire: () => { acqB++ }, onRelease: () => { relB++ } })

    await A.tick()
    expect(A.owns).toBe(true); expect(acqA).toBe(1)
    expect(store.holderId).not.toBeNull() // A 的连接持锁

    await B.tick()
    expect(B.owns).toBe(false); expect(acqB).toBe(0) // 互斥：B 拿不到

    // A 的连接静默死亡（PG 释放会话锁）
    killHolder()
    await A.tick() // owner 保活复验失败 → 放弃所有权、停后台
    expect(A.owns).toBe(false); expect(relA).toBe(1)

    await B.tick() // B 下一轮重抢成功 → 自动接管
    expect(B.owns).toBe(true); expect(acqB).toBe(1)

    // 启动幂等：已 owns 时再 tick 不重复 onAcquire
    await B.tick()
    expect(acqB).toBe(1)
  })

  it('pg：owner 主动 stop 显式解锁，另一台可立即接管', async () => {
    const { store, acquireClient } = makeLockEnv()
    let acqB = 0
    const A = createBackgroundOwner({ isPostgres: true, acquireClient })
    const B = createBackgroundOwner({ isPostgres: true, acquireClient, onAcquire: () => { acqB++ } })
    await A.tick()
    expect(A.owns).toBe(true); expect(store.holderId).not.toBeNull()
    await A.stop() // 下线：pg_advisory_unlock + 归还连接
    expect(store.holderId).toBeNull()
    await B.tick()
    expect(B.owns).toBe(true); expect(acqB).toBe(1)
  })
})

describe('§5 控制器 × 真实 pg_try_advisory_lock', () => {
  maybe('两个真 handle：A 抢到→B 抢不到；A.stop 解锁后 B 重抢接管', async () => {
    const hA = await createPostgresHandle({ connectionString: MAINT_URL, max: 2 })
    const hB = await createPostgresHandle({ connectionString: MAINT_URL, max: 2 })
    let acqA = 0, acqB = 0, relA = 0
    // 先清残留（同锁 key 可能被他测试占）：新连一个客户端显式 unlock
    const cleaner = await hA.acquireSessionClient()
    try { await cleaner.query(`SELECT pg_advisory_unlock_all()`) } catch { /* ignore */ }
    cleaner.release()
    const A = createBackgroundOwner({ isPostgres: true, acquireClient: () => hA.acquireSessionClient(), onAcquire: () => { acqA++ }, onRelease: () => { relA++ } })
    const B = createBackgroundOwner({ isPostgres: true, acquireClient: () => hB.acquireSessionClient(), onAcquire: () => { acqB++ } })
    try {
      await A.tick()
      expect(A.owns).toBe(true); expect(acqA).toBe(1)
      await B.tick()
      expect(B.owns).toBe(false); expect(acqB).toBe(0) // 真锁互斥
      await A.stop() // pg_advisory_unlock + 归还
      expect(A.owns).toBe(false); expect(relA).toBe(0) // stop 不走 onRelease（主动下线）
      await B.tick()
      expect(B.owns).toBe(true); expect(acqB).toBe(1) // 真接管
      await B.stop()
    } finally {
      // 确保锁释放（防脏）
      const c = await hB.acquireSessionClient()
      try { await c.query(`SELECT pg_advisory_unlock_all()`) } catch { /* ignore */ }
      c.release()
      await hA.close(); await hB.close()
    }
  })
})
