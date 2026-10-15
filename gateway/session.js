/**
 * gateway/session.js — 链路网关方案 §7.4 / §15：对外会话号 ↔ 内部会话号映射。
 *
 * 对外会话由网关签发（客户端看到的 mcp-session-id）；控制面自己的会话号只存网关内存。
 * 保存客户端原始 initialize 正文，供换链路时向新控制面原样重握手。禁止改写 initialize。
 */
import crypto from 'node:crypto'

export function createSessionStore(opts = {}) {
  const { ttlMs = 30 * 60 * 1000, now = () => Date.now(), uuid = () => crypto.randomUUID() } = opts

  // externalId → { linkId, internalId, initializeBody, lastSeen }
  const sessions = new Map()

  function create({ linkId, internalId, initializeBody = null }) {
    const externalId = uuid()
    sessions.set(externalId, { linkId, internalId, initializeBody, lastSeen: now(), boundAt: now() })
    return externalId
  }

  function get(externalId) {
    const s = externalId ? sessions.get(externalId) : null
    if (s) s.lastSeen = now()
    return s
  }

  function bind(externalId, { linkId, internalId }) {
    const s = sessions.get(externalId)
    if (s) { s.linkId = linkId; s.internalId = internalId; s.lastSeen = now(); s.boundAt = now() }
    return s
  }

  function setInitializeBody(externalId, body) {
    const s = sessions.get(externalId)
    if (s) { s.initializeBody = body; s.lastSeen = now() }
    return s
  }

  function remove(externalId) {
    sessions.delete(externalId)
  }

  /** 30 分钟无请求删除；返回删除数。 */
  function prune() {
    const cutoff = now() - ttlMs
    let removed = 0
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) { sessions.delete(id); removed++ }
    }
    return removed
  }

  return { create, get, bind, setInitializeBody, remove, prune, size: () => sessions.size }
}
