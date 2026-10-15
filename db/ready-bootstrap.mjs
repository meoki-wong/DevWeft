/**
 * db/ready-bootstrap.mjs — P1-C：控制面启动的"先就绪端口、后连库"脚手架
 *
 * 症状：server.js 旧 start() 里 `await openDb()` 前置于 listen；若 PG 恰在启动窗口抖动，
 * pg-pool 无限重试使 openDb 永不 resolve，进程 pm2 显示 online 却从未 bind 端口（静默假在线），
 * 网关探活只能得到"连接被拒"，无从区分"进程活着但库没起来" vs "进程没起"。
 *
 * 修复：
 *  1) startReadinessBootstrap：先把一个最小健康服务绑到目标端口——/api/health/live=200，
 *     其余（含 /api/health/ready）=503（DB_STARTING），让网关得到明确"未就绪"而非"连不上"；
 *  2) openDbWithRetry：openDb 带**单次超时**（防静默卡死）+ 指数退避重试；总时限仍失败则抛出，
 *     调用方据此 process.exit(1) 交 pm2 重启（restart 计数可见，杜绝永久静默）。
 */
import http from 'node:http'

/** 起最小健康服务；绑定失败 reject（调用方 exit）。 */
export function startReadinessBootstrap({ port, host = '0.0.0.0' } = {}) {
  let ready = false
  const server = http.createServer((req, res) => {
    const p = String(req.url || '').split('?')[0]
    if (p === '/api/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ok: true, state: ready ? 'ready' : 'starting' }))
    }
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ok: ready, code: ready ? 'READY' : 'DB_STARTING',
      detail: ready ? 'ok' : '数据库尚未就绪，控制面预热中',
    }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve({
      server,
      port: server.address().port,
      markReady: () => { ready = true },
      close: () => new Promise((r) => server.close(r)),
    }))
  })
}

/**
 * openDb 超时 + 退避重试。返回成功所用尝试次数。
 * 单次 attemptTimeoutMs 防"连接永不回"的静默卡死；总 maxWaitMs 后抛出（交调用方 exit）。
 */
export async function openDbWithRetry(openDbFn, {
  attemptTimeoutMs = 20000, maxWaitMs = 300000, baseDelayMs = 2000, maxDelayMs = 30000, log = () => {},
} = {}) {
  const deadline = Date.now() + maxWaitMs
  let n = 0
  for (;;) {
    n += 1
    try {
      await withTimeout(Promise.resolve().then(() => openDbFn()), attemptTimeoutMs, `openDb 单次超时(>${attemptTimeoutMs}ms，库/网络疑似不可用)`)
      return n
    } catch (e) {
      if (Date.now() >= deadline) {
        log(`[agent-workflow-platform] openDb 连续失败且超总时限(${maxWaitMs}ms)：${e && e.message}`)
        throw e
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(n, 4)))
      log(`[agent-workflow-platform] openDb 第 ${n} 次失败：${e && e.message}；${delay}ms 后重试`)
      await sleep(delay)
    }
  }
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms)
    if (typeof t.unref === 'function') t.unref()
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); if (typeof t.unref === 'function') t.unref() })
}
