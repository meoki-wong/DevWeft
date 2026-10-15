/**
 * gateway/route.js — 链路网关方案 §7.4 / §7.3：选路、重放时限、按字节转发。
 *
 * 尝试顺序：项目首选（启用且存在）→ 其余启用按 sort_order；跳过熔断链路。
 * 只在「还没收到响应头」时换下一条：连接被拒 / 连接超时 / 响应头超时。
 * 收到响应头之后原样转发字节，禁止再换链路（含 HTTP 502/503/504 与 isError:true）。
 * 全部失败且一个响应头都没收到 → 502。fetchImpl / 超时注入。
 */
import { Readable } from 'node:stream'

export class FailoverError extends Error {
  constructor(reason, cause) {
    super(`FAILOVER:${reason}`)
    this.reason = reason
    this.cause = cause
  }
}

/** 头到达前不算数（可换链路）；头已到达后由调用方停止换链路。返回 { response } 或抛 FailoverError。 */
export async function attemptOnce(link, reqInfo, opts = {}) {
  const { fetchImpl = globalThis.fetch, connectTimeoutMs = 2000, headerTimeoutMs = 15000 } = opts
  const ctrl = new AbortController()
  let abortReason = null
  // P1-B：不再用"连接计时器"充当首字节杀手。旧实现 connectTimer 在请求发起后固定倒计时、
  // 只有拿到响应头才 clear，于是"连接已建立、仅服务端慢回首字节"的健康重请求（大 diff 快照下单等）
  // 会在 connectTimeoutMs（原 2s）被误 abort → 误判失联换链路。连接阶段死主机由 fetch 立即
  // reject（ECONNREFUSED/EHOSTUNREACH…）兜住；"有去无回 / 慢回首字节"统一交 headerTimer 判定。
  void connectTimeoutMs // 保留入参兼容（真连接超时交由拒绝连接 + 探活熔断处理）
  // 响应头超时
  const headerTimer = setTimeout(() => { abortReason = 'header-timeout'; ctrl.abort() }, headerTimeoutMs)
  if (typeof headerTimer.unref === 'function') headerTimer.unref()

  try {
    const response = await fetchImpl(link.baseUrl + reqInfo.pathWithQuery, {
      method: reqInfo.method,
      headers: reqInfo.headers,
      body: reqInfo.body == null ? undefined : reqInfo.body,
      signal: ctrl.signal,
      duplex: 'half',
    })
    clearTimeout(headerTimer)
    return { response }
  } catch (err) {
    clearTimeout(headerTimer)
    if (abortReason) throw new FailoverError(abortReason, err)
    const code = err?.code || ''
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|UND_ERR_SOCKET|fetch failed/i.test(`${code} ${err?.message || ''}`)) {
      throw new FailoverError('connect-refused', err)
    }
    throw new FailoverError('network', err)
  }
}

/** 把上游响应（状态 + 头 + 字节流）转发给客户端；此后不再换链路。 */
export function pipeResponseToClient(res, response) {
  res.status(response.status)
  response.headers.forEach((value, key) => {
    const k = key.toLowerCase()
    // 跳过逐跳/长度头；并禁止把控制面内部 mcp-session-id 外泄给客户端（§15：客户端只见网关对外会话号）
    if (k === 'connection' || k === 'transfer-encoding' || k === 'content-length' || k === 'content-encoding' || k === 'mcp-session-id') return
    try { res.setHeader(key, value) } catch { /* ignore */ }
  })
  if (!response.body) { res.end(); return }
  const nodeStream = Readable.fromWeb(response.body)
  nodeStream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
  res.on('close', () => { try { nodeStream.destroy() } catch { /* ignore */ } })
  nodeStream.pipe(res)
}

/**
 * 按候选顺序转发。返回 { ok, linkId, status }。
 * onLinkResponse(linkId, response) 可在收到响应头后、转发前回调（供会话绑定等）。
 */
export async function forwardWithFailover({ candidates, reqInfo, res, opts = {}, tried = [], onLinkResponse }) {
  for (const link of candidates) {
    tried.push(link.linkId)
    try {
      const { response } = await attemptOnce(link, reqInfo, opts)
      if (typeof onLinkResponse === 'function') onLinkResponse(link, response)
      pipeResponseToClient(res, response)
      return { ok: true, linkId: link.linkId, status: response.status }
    } catch (err) {
      if (err instanceof FailoverError) continue // 头到达前失败 → 下一条
      continue
    }
  }
  if (!res.headersSent) res.status(502).json({ error: 'BAD_GATEWAY', detail: '所有链路在响应头到达前均不可用' })
  return { ok: false, status: 502 }
}

/** 选路：项目首选（启用且存在）优先，否则主链路；再其余启用按 sort_order；去掉熔断项（但候选至少保留首选链）。 */
export function chooseCandidates({ store, health, repo }) {
  const links = store.listLinks() // 已按 sort_order 升序，仅启用
  const openSet = new Set(links.filter((l) => health && health.isCircuitOpen(l.linkId)).map((l) => l.linkId))

  const preferredId = store.getProjectLink(repo) || (store.primaryLink()?.linkId ?? null)
  // 有序：首选（若在启用列表且存在）→ 其余按序
  const ordered = []
  const preferredLink = links.find((l) => l.linkId === preferredId)
  if (preferredLink) ordered.push(preferredLink)
  for (const l of links) if (!ordered.includes(l)) ordered.push(l)

  // 会话仍绑定的链路（外部会话 → linkId）若仍启用则在最前
  return { ordered, openSet, candidates: ordered.filter((l) => !openSet.has(l.linkId)) }
}

/** 已有对外会话绑定链路且仍启用/未熔断 → 放最前（§7.4 第3步）。 */
export function prioritizeBoundLink(candidates, boundLinkId) {
  if (!boundLinkId) return candidates
  const idx = candidates.findIndex((l) => l.linkId === boundLinkId)
  if (idx <= 0) return candidates
  const copy = candidates.slice()
  const [bound] = copy.splice(idx, 1)
  copy.unshift(bound)
  return copy
}
