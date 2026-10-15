/**
 * links-api.test.mjs — 链路网关方案 §9 完成标准
 *
 * 覆盖：新增、禁止第二主链路、空首选等于没有 project_links 行、删除备用链路后项目首选变回空。
 * 另测 base_url 校验与 /api/links/runtime 形状。经 buildApp() 真实 HTTP，隔离库，不写 data/team.db。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { buildApp } from '../server.js'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { ensureLinkSchema } from '../db/link-schema.js'

const SLUG = `links-${Date.now().toString(36)}`
let app = null
let server = null
let base = null

const JH = { 'content-type': 'application/json' }

async function api(path, method = 'GET', body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: JH,
    body: body == null ? undefined : JSON.stringify(body),
  })
  let json = null
  try { json = await res.json() } catch { /* no body */ }
  return { status: res.status, json }
}

beforeAll(async () => {
  app = buildApp()
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  try { server?.close() } catch { /* ignore */ }
  try { await db.prepare('DELETE FROM project_links').run() } catch { /* ignore */ }
})

beforeEach(async () => {
  // 重置链路表：清空后 ensureLinkSchema 重新播种唯一主链路 primary
  await db.prepare('DELETE FROM project_links').run()
  await db.prepare('DELETE FROM links').run()
  await ensureLinkSchema(db)
})

describe('链路 CRUD（§9）', () => {
  it('新增备用链路：GET /api/links 含它，enabled=1、非主链路', async () => {
    const add = await api('/api/links', 'POST', { name: '备用', baseUrl: 'http://127.0.0.1:8799', isPrimary: 0 })
    expect(add.status).toBe(200)
    expect(add.json.ok).toBe(true)
    const list = await api('/api/links')
    const found = list.json.links.find((l) => l.link_id === add.json.linkId)
    expect(found).toBeTruthy()
    expect(found.base_url).toBe('http://127.0.0.1:8799')
    expect(Number(found.enabled)).toBe(1)
    expect(Number(found.is_primary)).toBe(0)
    // base_url 去掉末尾斜杠保存
    const add2 = await api('/api/links', 'POST', { name: '尾斜杠', baseUrl: 'http://127.0.0.1:8800/' })
    const f2 = (await api('/api/links')).json.links.find((l) => l.link_id === add2.json.linkId)
    expect(f2.base_url).toBe('http://127.0.0.1:8800')
  })

  it('禁止第二主链路：设 isPrimary=1 新链路后，全表仍只有一个主链路（同事务降级旧主）', async () => {
    const before = await api('/api/links')
    const oldPrimary = before.json.links.find((l) => Number(l.is_primary) === 1)
    expect(oldPrimary).toBeTruthy()
    const add = await api('/api/links', 'POST', { name: '新主', baseUrl: 'http://127.0.0.1:8801', isPrimary: 1 })
    expect(add.status).toBe(200)
    const after = await api('/api/links')
    const primaries = after.json.links.filter((l) => Number(l.is_primary) === 1)
    expect(primaries.length).toBe(1) // 绝不出现第二条主链路
    expect(primaries[0].link_id).toBe(add.json.linkId)
    // 旧主链路被降级为 0
    const oldNow = after.json.links.find((l) => l.link_id === oldPrimary.link_id)
    expect(Number(oldNow.is_primary)).toBe(0)
  })

  it('base_url 非法（带路径 / 非 http）→ 400', async () => {
    const bad1 = await api('/api/links', 'POST', { name: 'x', baseUrl: 'http://127.0.0.1:8791/some/path' })
    expect(bad1.status).toBe(400)
    const bad2 = await api('/api/links', 'POST', { name: 'x', baseUrl: '127.0.0.1:8791' })
    expect(bad2.status).toBe(400)
  })

  it('空首选 = 没有 project_links 行；设默认后出现行；清空后行删除', async () => {
    await ensureRepository(db, SLUG, null)
    // 初始：无 project_links 行 → default-link null → GET projects 该项目 defaultLinkId=null
    const p0 = await api('/api/testing/projects')
    const proj0 = p0.json.projects.find((p) => p.slug === SLUG)
    expect(proj0).toBeTruthy()
    expect(proj0.defaultLinkId).toBeNull()

    // 建备用链路并设为默认
    const add = await api('/api/links', 'POST', { name: '备用B', baseUrl: 'http://127.0.0.1:8802', isPrimary: 0 })
    const set = await api(`/api/testing/projects/${SLUG}/default-link`, 'POST', { linkId: add.json.linkId })
    expect(set.status).toBe(200)
    const row = await db.prepare('SELECT link_id FROM project_links WHERE repo=?').get(SLUG)
    expect(row.link_id).toBe(add.json.linkId)

    // 清空 → 行删除（空首选 = 没有行）
    const clear = await api(`/api/testing/projects/${SLUG}/default-link`, 'POST', { linkId: null })
    expect(clear.status).toBe(200)
    const gone = await db.prepare('SELECT COUNT(*) c FROM project_links WHERE repo=?').get(SLUG)
    expect(Number(gone.c)).toBe(0)
  })

  it('删除备用链路后项目首选变回空', async () => {
    await ensureRepository(db, SLUG, null)
    const add = await api('/api/links', 'POST', { name: '备用C', baseUrl: 'http://127.0.0.1:8803', isPrimary: 0 })
    await api(`/api/testing/projects/${SLUG}/default-link`, 'POST', { linkId: add.json.linkId })
    const del = await api(`/api/links/${add.json.linkId}`, 'DELETE')
    expect(del.status).toBe(200)
    // 指向它的 project_links 置空 → 项目 defaultLinkId 变 null
    const p = await api('/api/testing/projects')
    const proj = p.json.projects.find((x) => x.slug === SLUG)
    expect(proj.defaultLinkId).toBeNull()
    const runtime = await api('/api/links/runtime')
    expect(runtime.json.projects.find((x) => x.repo === SLUG)).toBeFalsy()
  })

  it('禁止删除 / 停用主链路', async () => {
    const primary = (await api('/api/links')).json.links.find((l) => Number(l.is_primary) === 1)
    const del = await api(`/api/links/${primary.link_id}`, 'DELETE')
    expect(del.status).toBe(400)
    const dis = await api(`/api/links/${primary.link_id}`, 'POST', { enabled: 0 })
    expect(dis.status).toBe(400)
  })

  it('GET /api/links/runtime 形状：启用链路 camelCase + 仅设了首选的项目', async () => {
    await ensureRepository(db, SLUG, null)
    const add = await api('/api/links', 'POST', { name: '备用D', baseUrl: 'http://127.0.0.1:8804', isPrimary: 0 })
    await api(`/api/testing/projects/${SLUG}/default-link`, 'POST', { linkId: add.json.linkId })
    const rt = await api('/api/links/runtime')
    expect(rt.status).toBe(200)
    expect(rt.json.links.some((l) => l.linkId === add.json.linkId && l.baseUrl === 'http://127.0.0.1:8804' && typeof l.isPrimary === 'number')).toBe(true)
    const proj = rt.json.projects.find((x) => x.repo === SLUG)
    expect(proj).toBeTruthy()
    expect(proj.linkId).toBe(add.json.linkId)
  })
})
