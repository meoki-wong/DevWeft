/**
 * gateway/store.js — 链路网关方案 §7.1：路由快照。只通过 HTTP 拉控制面 /api/links/runtime，
 * 写入本地 data/gateway-routes.json。禁止连接数据库、禁止 import 业务模块。
 *
 * fetchImpl / now / readFile / writeFile 可注入，便于单测与离线运行。
 */
import fs from 'node:fs'

const DEFAULT_PRIMARY = { linkId: 'primary', baseUrl: 'http://127.0.0.1:8791', isPrimary: 1 }

export function createRouteStore(opts = {}) {
  const {
    routesFile = null,
    fetchImpl = globalThis.fetch,
    runtimeTimeoutMs = 2000,
    readFile = (p) => fs.readFileSync(p, 'utf8'),
    writeFile = (p, data) => fs.writeFileSync(p, data),
  } = opts

  // links：启用中的链路，按 sort_order 升序；projects：{ repo, linkId }
  let links = [{ ...DEFAULT_PRIMARY, sortOrder: 0, enabled: 1 }]
  let projects = [] // [{ repo, linkId }]
  let lastError = null

  // 若已有快照文件，用它覆盖初始值
  if (routesFile && fs.existsSync(routesFile)) {
    try {
      const parsed = JSON.parse(readFile(routesFile))
      if (Array.isArray(parsed.links) && parsed.links.length) {
        links = parsed.links.map((l) => ({ sortOrder: 0, enabled: 1, ...l }))
        projects = Array.isArray(parsed.projects) ? parsed.projects : []
      }
    } catch { /* 快照损坏：保留默认 */ }
  }

  function normalizeRuntime(j) {
    const ls = Array.isArray(j?.links) ? j.links : []
    const norm = ls
      .map((l, idx) => ({
        linkId: String(l.linkId ?? l.link_id ?? ''),
        baseUrl: String(l.baseUrl ?? l.base_url ?? '').replace(/\/+$/, ''),
        isPrimary: Number(l.isPrimary ?? l.is_primary ?? 0),
        sortOrder: Number(l.sortOrder ?? l.sort_order ?? idx),
        enabled: 1,
      }))
      .filter((l) => l.linkId && l.baseUrl)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.linkId.localeCompare(b.linkId))
    const ps = Array.isArray(j?.projects) ? j.projects.map((p) => ({ repo: String(p.repo), linkId: p.linkId ?? p.link_id ?? null })) : []
    return { links: norm, projects: ps }
  }

  /** 拉取一条链路的 runtime；超时返回 null。 */
  async function fetchRuntimeFrom(baseUrl) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), runtimeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      const res = await fetchImpl(`${baseUrl}/api/links/runtime`, { signal: ctrl.signal })
      if (!res || res.status !== 200) return null
      const json = await res.json()
      if (!json || !Array.isArray(json.links)) return null
      return normalizeRuntime(json)
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 每 5s 调用：按当前顺序请求，首个 200 成为新路由并落盘；全失败保留上一份。 */
  async function refresh() {
    for (const link of links) {
      const next = await fetchRuntimeFrom(link.baseUrl)
      if (next && next.links.length) {
        links = next.links
        projects = next.projects
        lastError = null
        if (routesFile) {
          try { writeFile(routesFile, JSON.stringify({ links, projects, savedAt: new Date().toISOString() })) } catch { /* 落盘失败不致命 */ }
        }
        return { ok: true, source: link.linkId }
      }
    }
    lastError = 'all links runtime fetch failed'
    return { ok: false }
  }

  function listLinks() {
    return links
  }

  function primaryLink() {
    return links.find((l) => Number(l.isPrimary) === 1) || links[0] || null
  }

  function getLink(linkId) {
    return links.find((l) => l.linkId === linkId) || null
  }

  /** 项目首选：project_links 命中且该链路启用（在表里即启用）→ 返回 linkId；否则 null（=主链路）。 */
  function getProjectLink(repo) {
    if (!repo) return null
    const row = projects.find((p) => p.repo === String(repo).toLowerCase())
    if (!row || !row.linkId) return null
    return links.some((l) => l.linkId === row.linkId) ? row.linkId : null
  }

  return { refresh, listLinks, primaryLink, getLink, getProjectLink, fetchRuntimeFrom, getState: () => ({ links, projects, lastError }) }
}
