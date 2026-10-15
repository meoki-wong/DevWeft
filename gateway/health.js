/**
 * gateway/health.js — 链路网关方案 §7.2：存活/就绪探针与熔断。
 *
 * 用就绪探针（/api/health/ready）而非存活探针：进程在但库不可用不应继续送流量。
 * 非 200 或超时记一次失败；连续 3 次失败熔断 30s，期间尝试顺序跳过；一次 200 清零。
 * 业务错误不计入熔断（只有传输层/就绪探针失败才计数）。fetchImpl/now 可注入。
 */
export function createHealthMonitor(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    probeTimeoutMs = 2000,
    failureThreshold = 3,
    openMs = 30000,
    now = () => Date.now(),
  } = opts

  // linkId → { failures, openUntil }
  const state = new Map()

  function ensure(linkId) {
    if (!state.has(linkId)) state.set(linkId, { failures: 0, openUntil: 0 })
    return state.get(linkId)
  }

  /** 探测单条链路就绪；true=200。失败累加，达阈值开熔断。 */
  async function probeLink(link) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), probeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    let ok = false
    try {
      const res = await fetchImpl(`${link.baseUrl}/api/health/ready`, { signal: ctrl.signal })
      ok = Boolean(res && res.status === 200)
    } catch {
      ok = false
    } finally {
      clearTimeout(timer)
    }
    const s = ensure(link.linkId)
    if (ok) {
      s.failures = 0
      s.openUntil = 0
    } else {
      s.failures += 1
      if (s.failures >= failureThreshold) s.openUntil = now() + openMs
    }
    return ok
  }

  /** 每 5s 调用：对全部链路各探一次。 */
  async function probeAll(links) {
    for (const link of links) await probeLink(link)
  }

  function isCircuitOpen(linkId) {
    const s = state.get(linkId)
    if (!s) return false
    return now() < s.openUntil
  }

  /** 手动开熔断（测试用）。 */
  function forceOpen(linkId) {
    const s = ensure(linkId)
    s.failures = failureThreshold
    s.openUntil = now() + openMs
  }

  function snapshot() {
    const out = []
    for (const [linkId, s] of state) out.push({ linkId, failures: s.failures, circuitOpen: now() < s.openUntil })
    return out
  }

  return { probeLink, probeAll, isCircuitOpen, forceOpen, snapshot }
}
