/**
 * db/background-owner.js — 链路网关方案 §5（增强）：后台职责【自动接管】所有权控制器。
 *
 * 目标：多控制面共享同一 PG 时，后台管家活（对账/清扫/每日回收/夜间回归/run-SSE 桥）
 * 同一时刻只跑一份，且持有者进程崩溃/发版重启后，存活的另一台【自动】接管，无需重启。
 *
 * 机制（postgres）：会话级咨询锁 pg_try_advisory_lock(key) 绑在一条【长持不还池】的专用连接上。
 *  - 非 owner：每 intervalMs 用一条专用连接 try_lock；抢到 → 保留该连接（锁在其上）、owns=true、onAcquire()。
 *  - owner：每 intervalMs 对持锁连接做 SELECT 1 保活复验；若连接失效（PG 重启/网络断）→ 锁已随连接消失，
 *    立刻 owns=false、onRelease()（调用方须停掉全部后台定时器），下一轮重新竞争。
 *  ⇒ 因 pg_try_advisory_lock 的原子互斥 + 交接串行（旧 owner 断连释放后新 owner 才抢得到），
 *    正常运行期【至多一个 owner】；唯一的重叠风险是"锁连接静默死亡"，由保活复验把窗口压到 ≤1 个 tick。
 *
 * sqlite：单进程默认独占，首次 tick 直接 owns=true 并 onAcquire()，不建连接、不轮询。
 *
 * 纯逻辑 + 依赖注入（acquireClient/onAcquire/onRelease/setTimer/... 可注入），便于单测。
 * 禁止在此 import db.js/server.js——由调用方注入 db.acquireSessionClient。
 */

export const BG_LOCK_KEY = 878701

/**
 * @param {object} o
 * @param {boolean} o.isPostgres                方言：仅 postgres 走咨询锁竞争；sqlite 直接独占
 * @param {() => Promise<{query:Function, release:Function}>} o.acquireClient  取一条长持专用连接（pg 路径）
 * @param {number} [o.lockKey=BG_LOCK_KEY]      咨询锁 key（整型字面量，内联进 SQL）
 * @param {number} [o.intervalMs=20000]         重抢/复验间隔
 * @param {() => (void|Promise)} [o.onAcquire]  获得所有权回调（启动后台任务）
 * @param {() => (void|Promise)} [o.onRelease]  失去所有权回调（停止后台任务）
 * @param {(msg:string)=>void} [o.log]
 * @param {(fn:Function, ms:number)=>any} [o.setTimer]
 * @param {(h:any)=>void} [o.clearTimer]
 */
export function createBackgroundOwner({
  isPostgres,
  acquireClient,
  lockKey = BG_LOCK_KEY,
  intervalMs = 20000,
  onAcquire,
  onRelease,
  log = () => {},
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  let owns = false          // 两种方言初始均非 owner；首次 tick 决定（sqlite 直接独占，pg 竞争 try_lock）
  let held = null          // owner 持有的专用连接（锁在其上）；非 owner 为 null
  let timer = null
  let ticking = false

  async function tick() {
    // 防重入：一轮里 acquire/probe 尚未结束（可能是慢网络）时跳过本次，避免叠加
    if (ticking) return
    ticking = true
    try {
      if (!isPostgres) {
        if (!owns) {
          owns = true
          log('sqlite 单进程 → 独占后台任务')
          await onAcquire?.()
        }
        return
      }

      if (owns) {
        // owner：对持锁连接做保活复验。连接死 → 会话锁随之消失 → 放弃所有权并停止后台。
        let alive = false
        try {
          const r = await held?.query('SELECT 1')
          alive = Boolean(r)
        } catch {
          alive = false
        }
        if (!alive) {
          log('后台咨询锁连接失效 → 放弃所有权、停止后台任务（等待重抢）')
          owns = false
          try { held?.release?.() } catch { /* ignore */ }
          held = null
          await onRelease?.()
        }
        return
      }

      // 非 owner：用一条专用连接尝试抢锁；抢到则【保留该连接】（锁绑其上，不能 release）
      let c = null
      try {
        c = await acquireClient()
        const r = await c.query(`SELECT pg_try_advisory_lock(${lockKey}) AS locked`)
        if (r?.rows?.[0]?.locked) {
          held = c
          owns = true
          log('抢到后台咨询锁 → 启动后台任务（接管）')
          await onAcquire?.()
        } else {
          // 没抢到：这条连接从未持锁，立即还池，避免占用
          try { c.release?.() } catch { /* ignore */ }
        }
      } catch (e) {
        log(`后台咨询锁尝试失败: ${e?.message || e}`)
        try { c?.release?.() } catch { /* ignore */ }
      }
    } finally {
      ticking = false
    }
  }

  return {
    /** 立即跑一轮，然后进入周期。返回的 owner.start() 不阻塞调用方。 */
    start() {
      tick().catch(() => { /* tick 内部已兜异常 */ })
      if (isPostgres) {
        timer = setTimer(() => { tick().catch(() => {}) }, intervalMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    },
    /**
     * 进程退出/主动下线：停止轮询并释放所持锁连接。
     * 注意：pg 的 client.release() 只把连接还池、后端 session 不断开→会话锁仍被占；
     * 故必须 await pg_advisory_unlock 后再接管，否则另一台 try_lock 仍会失败。返回 Promise。
     * 硬崩退出时走不到这里，但进程退出会关闭 socket → PG 后端断连自动释放会话锁。
     */
    async stop() {
      if (timer) { try { clearTimer(timer) } catch { /* ignore */ } timer = null }
      if (owns && held) {
        try { await held.query(`SELECT pg_advisory_unlock(${lockKey})`) } catch { /* ignore */ }
        try { held.release?.() } catch { /* ignore */ }
        held = null
      }
      owns = false
    },
    get owns() { return owns },
    tick, // 供单测手动驱动
  }
}
