/**
 * postgres-driver.mjs — 方案第 7/8 节：PostgreSQL 方言驱动。
 *
 * - better-sqlite3 形状的异步句柄（prepare→get/all/run、exec、tx、pragma），
 *   使 await 化后的调用点在两种方言下同构（§7）。
 * - get/all/run 返回 Promise；pg 的 rowCount 以 changes 同名暴露（§2.8）。
 * - tx(fn, opts?)：BEGIN → [SET LOCAL app.tenant_id / SET LOCAL ROLE] → await fn(tx) → COMMIT
 *   （§13.1/§14.1）；txTenant/txWorker 便捷封装。
 * - 租户上下文（db/tenant-context.js 的 runWithTenant）存在时，事务外的单条语句
 *   自动套「BEGIN → SET LOCAL app.tenant_id → 语句 → COMMIT」（§14.1，禁止会话级 SET）。
 * - 本模块禁止在 import 时连接（§13.1）。
 */
import pg from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getTenantId } from './tenant-context.js'

// int8(BIGINT) 默认回字符串，Number.isInteger("1") 为假会打爆校验；计数/序号/epoch 均远小于 2^53
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)))

// 嵌套事务识别：同一异步链内的 db.tx 复用外层事务（与 sqlite db.tx 语义一致）
const txAls = new AsyncLocalStorage()
// savepoint 嵌套识别：ALS 里有 store 说明当前 fn 已在某个 savepoint 内，嵌套走栈语义即可，
// 不需要顶级 mutex 排队（否则外层 fn 里调用内层会死锁）
const spAls = new AsyncLocalStorage()

/** SQLite 的 ? 占位符 → pg 的 $1..$n（跳过字符串字面量内的问号） */
function translatePlaceholders(sql) {
  let out = ''
  let inStr = false
  let n = 0
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      inStr = !inStr
      out += ch
      continue
    }
    if (ch === '?' && !inStr) {
      n += 1
      out += `$${n}`
      continue
    }
    out += ch
  }
  return out
}

/**
 * better-sqlite3 形状的 @name 命名占位符 → pg $n + 名称顺序表。
 * 与 ? 互斥（同一语句只会用一种）；字符串字面量内的 @ 不转换。
 * 返回 { sql, names }；names 为 null 表示该语句走 ? 位置参数。
 */
function translateNamedPlaceholders(sql) {
  if (!/@[a-zA-Z_]/.test(sql)) return { sql: translatePlaceholders(sql), names: null }
  const order = []
  const seen = new Map()
  let out = ''
  let inStr = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      inStr = !inStr
      out += ch
      continue
    }
    if (!inStr && ch === '@' && /[a-zA-Z_]/.test(sql[i + 1] || '')) {
      let j = i + 1
      while (j < sql.length && /[a-zA-Z0-9_]/.test(sql[j])) j++
      const name = sql.slice(i + 1, j)
      if (!seen.has(name)) {
        seen.set(name, order.length + 1)
        order.push(name)
      }
      out += `$${seen.get(name)}`
      i = j - 1
      continue
    }
    out += ch
  }
  return { sql: out, names: order }
}

/** 建连/取连接超时（毫秒）。pg 默认 0 = 永不超时，PG 计划任务重启窗口里会让调用方永久挂起。 */
const DEFAULT_CONNECT_TIMEOUT_MS = 15000

export async function createPostgresHandle({
  connectionString = null,
  max = 5,
  poolLike = null,
  connectionTimeoutMillis = Number(process.env.AWP_PG_CONNECT_TIMEOUT_MS) || DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  // poolLike：注入既有 PG 兼容 client（如 PGlite），供测试/离线工具复用同一句柄形状；
  // 生产路径不传 → 建 pg.Pool（禁止在 import 阶段调用本函数，§13.1）
  let pool
  let execFn
  if (poolLike) {
    pool = { query: (sql, params) => poolLike.query(sql, params), end: () => poolLike.close() }
    // PGlite 的 query() 走扩展协议只允许单语句；多语句 DDL 必须走 exec()
    execFn = (sql) => poolLike.exec(sql)
  } else {
    // connectionTimeoutMillis 同时兜住「新建连接」与「从池中取连接」两条路径：
    // 两者超时都会 reject，不会留下永不 settle 的 pending connect（那会让 PM2 看到
    // 「进程 online 但端口不监听、CPU 0%、无数据库连接」的假活进程）。
    pool = new pg.Pool(
      connectionString
        ? { connectionString, max, connectionTimeoutMillis }
        : { max, connectionTimeoutMillis }
    )
    const probe = await pool.connect()
    probe.release()
    execFn = (sql) => pool.query(sql)
  }

  const acquire = async () => (poolLike ? poolLike : pool.connect())
  const release = (client) => { if (!poolLike && client.release) client.release() }

  // 单条语句的租户事务（§14.1：BEGIN → SET LOCAL app.tenant_id + ROLE awp_tenant → 语句 → COMMIT；
  // RLS 只对非 owner 生效，必须换角色）
  const runWithTenantTx = async (execOn) => {
    const client = await acquire()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', getTenantId()])
      await client.query('SELECT set_config($1, $2, true)', ['role', 'awp_tenant'])
      const r = await execOn(client)
      await client.query('COMMIT')
      return r
    } catch (e) {
      try { await client.query('ROLLBACK') } catch { /* 连接已断开 */ }
      throw e
    } finally {
      release(client)
    }
  }

  const execOne = async (client, sql, params) => {
    const tenantId = getTenantId()
    if (tenantId) return runWithTenantTx((c) => c.query(sql, params))
    return client.query(sql, params)
  }

  function makeStatement(client, sql, { autoTenant = false } = {}) {
    const { sql: pgSql, names } = translateNamedPlaceholders(sql)
    const runQ = async (...params) => {
      // @name 命名参数：better-sqlite3 形状 .run({ name: value })
      let values = params
      if (names && params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
        const obj = params[0]
        values = names.map((name) => (obj[name] !== undefined ? obj[name] : null))
      }
      if (autoTenant && getTenantId()) return execOne(client, pgSql, values)
      return client.query(pgSql, values)
    }
    return {
      sql,
      async get(...params) {
        const r = await runQ(...params)
        return r.rows[0]
      },
      async all(...params) {
        const r = await runQ(...params)
        return r.rows
      },
      async run(...params) {
        const r = await runQ(...params)
        const rowCount = r.rowCount ?? r.affectedRows ?? 0
        return { changes: rowCount, rowCount, lastInsertRowid: null }
      },
    }
  }

  return {
    dialect: 'postgres',
    pool,
    async exec(sql) {
      await execFn(sql)
    },
    prepare(sql) {
      // 池级语句：允许租户上下文自动事务
      return makeStatement({ query: (s, p) => pool.query(s, p), __autoTenant: true }, sql, { autoTenant: true })
    },
    pragma(_spec) {
      // PG 无 PRAGMA：journal_mode/foreign_keys/busy_timeout 均为 SQLite 概念，静默忽略
      return []
    },
    async tx(fn, opts = {}) {
      const outer = txAls.getStore()
      if (outer) return fn(outer.txHandle)
      // 请求级租户上下文(§14.1):未显式传 opts 时自动携带 app.tenant_id；
      // 写事务同样切 awp_tenant——RLS WITH CHECK 拦跨租户写（T6 观察结论：授权就绪、行为正确）
      const tenantAuto = opts.tenantId ?? getTenantId()
      if (tenantAuto && !opts.tenantId) opts = { ...opts, tenantId: tenantAuto }
      // 有租户上下文且未显式指定角色 → 默认 awp_tenant（worker/admin 路径显式传 role）
      if (opts.tenantId && !opts.role) opts = { ...opts, role: 'awp_tenant' }
      // savepoint 序号在本事务内递增；名字带序号避免同事务重名。
      // PG 里 tx 内一条语句失败会把事务推到 aborted 态，同事务后续语句一律报
      // "current transaction is aborted"；调用方（如 optionalRead）若直接 try/catch 吞错，主事务就废了，
      // 导致看板刷新等接口 500。savepoint 回滚到进入前，外层事务仍可继续。
      const spState = { seq: 0, mutex: Promise.resolve() }
      const makeTx = (rawClient, q) => {
        // makeStatement 内部会 client.query；这里传一个转发到 q 的 shim，让 tx 里
        // 所有 prepare/exec/savepoint 语句都走同一条 FIFO 链，杜绝并发跑在同一 socket 上。
        const client = { query: (sql, params) => q(sql, params) }
        const handle = {
          // 保留 rawClient 引用给需要绕过队列的少数场景；日常语句一律走 q。
          client: rawClient,
          dialect: 'postgres',
          prepare: (sql) => makeStatement(client, sql),
          async exec(sql) {
            await q(sql)
          },
          async savepoint(fn) {
            // runOne：SAVEPOINT / fn / RELEASE 三段式；失败回滚到 savepoint，
            // PG 栈语义要求成对出现，调用方 await 拿结果或捕获异常。
            const runOne = async () => {
              const name = `awp_sp_${++spState.seq}`
              await q(`SAVEPOINT ${name}`)
              try {
                const r = await fn(handle)
                await q(`RELEASE SAVEPOINT ${name}`)
                return r
              } catch (e) {
                try { await q(`ROLLBACK TO SAVEPOINT ${name}`) } catch { /* 连接已断开 */ }
                throw e
              }
            }
            // 嵌套：ALS 里有 store 说明当前 fn 已在某个外层 savepoint 里，
            // PG 栈 LIFO 天然正确，直通不排队避免死锁。
            if (spAls.getStore()) return runOne()
            // 顶级并发：mutex 串行化，防止两个 SAVEPOINT 交错压栈后
            // 外层 RELEASE 级联销毁内层 → "does not exist" → 主事务 aborted 级联。
            const prev = spState.mutex
            let release
            spState.mutex = new Promise((r) => { release = r })
            await prev
            try {
              return await spAls.run({ depth: 1 }, runOne)
            } finally {
              release()
            }
          },
        }
        return handle
      }
      const runOn = async (client) => {
        // ── tx-scoped FIFO 串行队列 ─────────────────────────────────────────
        // pg 客户端在“正有查询未回”时再次 .query() 会并发写同一 socket：
        //   ① pg@8 会打 DeprecationWarning；
        //   ② 一旦其中任一 SQL 失败，同事务里其余并发 SQL 会立刻拿到
        //      "current transaction is aborted, commands ignored until end of transaction block"
        //      而不是它们各自的真实错误 —— 看板刷新 500 就是这么产生的
        //      （dashboard/readSubmission 与 readTaskTestingView 都在 tx 里用 Promise.all）。
        // 把 client.query 全部塞进 promise 链，同事务串行执行；不同事务仍用不同连接并行。
        // 不改调用点即根治，且对现有 await/try-catch 语义完全透明。
        let chain = Promise.resolve()
        const q = (sql, params) => {
          const run = chain.then(() => client.query(sql, params))
          chain = run.then(() => {}, () => {})
          return run
        }
        try {
          await q('BEGIN')
          if (opts.tenantId) await q('SELECT set_config($1, $2, true)', ['app.tenant_id', String(opts.tenantId)])
          if (opts.role) await q('SELECT set_config($1, $2, true)', ['role', String(opts.role)])
          const txHandle = makeTx(client, q)
          const result = await txAls.run({ txHandle }, () => fn(txHandle))
          await q('COMMIT')
          return result
        } catch (e) {
          try { await q('ROLLBACK') } catch { /* 连接已断开 */ }
          throw e
        } finally {
          release(client)
        }
      }
      if (poolLike) return runOn(poolLike)
      const client = await pool.connect()
      return runOn(client)
    },
    /** txTenant —— §8:租户角色事务(BEGIN → SET LOCAL app.tenant_id + ROLE awp_tenant → fn) */
    txTenant(tenantId, fn) {
      return this.tx(fn, { tenantId, role: 'awp_tenant' })
    },
    /** txWorker —— §8:工人角色事务(无租户上下文,SET LOCAL ROLE awp_worker) */
    txWorker(fn) {
      return this.tx(fn, { role: 'awp_worker' })
    },
    /**
     * acquireSessionClient —— 链路网关方案 §5：取一条连接并长期持有（不归还池），供会话级咨询锁使用。
     * pg_try_advisory_lock 绑定在连接（会话）上；连接一旦还回池锁就丢，故持锁期间不能 release。
     * 返回 { query, release }：release 仅在进程退出时调用（postgres 也会在断连时自动释放会话锁）。
     * poolLike（PGlite/测试注入）为单会话，直接转发。
     */
    async acquireSessionClient() {
      if (poolLike) {
        return { query: (sql, params) => poolLike.query(sql, params), release: () => {} }
      }
      const client = await pool.connect()
      return {
        query: (sql, params) => client.query(sql, params),
        release: () => { try { client.release() } catch { /* ignore */ } },
      }
    },
    async close() {
      await pool.end()
    },
  }
}
