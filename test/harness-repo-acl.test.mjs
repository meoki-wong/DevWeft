/**
 * harness-repo-acl.test.mjs — 方案第 4 节：入口权限开关 harness_repo_acl
 *
 * §8.4 四条：
 *   1. 开关 off：没有 principal 也能按今天的方式推进
 *   2. 开关 on、无 submit：harness_advance 得到 CROSS_REPO_REFERENCE
 *   3. 授予 submit 后成功
 *   4. 参数里显式传入另一个没有权限的 slug 时拒绝
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../server.js'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { createPrincipal, grantRepoPermissions } from '../testing/auth.js'
import { HARNESS_ACL_WRITE_TOOLS, HARNESS_ACL_READ_TOOLS } from '../harness/repo-acl.js'
import { harnessStart } from '../harness/state-machine.js'

const SLUG = `acl-a-${randomUUID().slice(0, 8)}`
const SLUG_OTHER = `acl-b-${randomUUID().slice(0, 8)}`
const WRITER = `acl-writer-${randomUUID().slice(0, 8)}`
const NOBODY = `acl-nobody-${randomUUID().slice(0, 8)}`

let app = null
let server = null
let base = null
let repoId = null

const setAclSwitch = async (mode) => {
  await db.prepare(
    `INSERT INTO platform_settings(key, value, value_json, updated_at) VALUES ('harness_repo_acl', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, value_json=excluded.value_json, updated_at=excluded.updated_at`
  ).run(mode, JSON.stringify(mode), new Date().toISOString())
}

const startTask = async (author) => {
  const taskId = `T-acl-${randomUUID().slice(0, 8)}`
  // 任务先经 harness_start 创建（advance 不建任务）；REST advance 走入口 ACL
  const started = await harnessStart({ taskId, requirement: 'ACL 测试任务', type: 'FEATURE', author, repo: SLUG })
  if (!started.ok) return { taskId, status: 200, body: started }
  const r = await fetch(`${base}/api/harness/advance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-awp-username': author },
    body: JSON.stringify({ taskId, to: 'retrieve', data: {}, author, repo: SLUG }),
  })
  return { taskId, status: r.status, body: await r.json().catch(() => ({})) }
}

beforeAll(async () => {
  repoId = await ensureRepository(db, SLUG, null)
  await ensureRepository(db, SLUG_OTHER, null)
  app = buildApp()
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  // 开关回归 off（方案 §8.2：回滚只有一步——把键写回 off）
  try { await db.prepare(`DELETE FROM platform_settings WHERE key='harness_repo_acl'`).run() } catch { /* ignore */ }
  try { server?.close() } catch { /* ignore */ }
  for (const slug of [SLUG, SLUG_OTHER]) {
    try {
      const tasks = await db.prepare('SELECT task_id FROM tasks WHERE repo=?').all(slug)
      for (const t of tasks) {
        await db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(slug, t.task_id)
        await db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(slug, t.task_id)
        await db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(slug, t.task_id)
      }
      await db.prepare('DELETE FROM tasks WHERE repo=?').run(slug)
      await db.prepare('DELETE FROM principal_repo_acl WHERE repo_id=?').run(repoId)
    } catch { /* ignore */ }
  }
})

describe('harness_repo_acl（方案 §8）', () => {
  it('清单：写工具要 submit，读工具要 read_result', async () => {
    for (const t of ['harness_start', 'harness_advance']) expect(HARNESS_ACL_WRITE_TOOLS.has(t)).toBe(true)
    for (const t of ['harness_status', 'get_doc', 'query_docs', 'list_docs']) expect(HARNESS_ACL_READ_TOOLS.has(t)).toBe(true)
  })

  it('开关 off（缺省）：没有 principal 也能按今天的方式推进', async () => {
    await setAclSwitch('off')
    const r = await startTask(NOBODY)
    expect(r.status).toBe(200)
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true)
  })

  it('开关 on、无 submit：harness_advance 得到 CROSS_REPO_REFERENCE', async () => {
    await setAclSwitch('on')
    const r = await startTask(`${NOBODY}-2`)
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('CROSS_REPO_REFERENCE')
  })

  it('授予 submit 后成功', async () => {
    await setAclSwitch('on')
    const principalId = await createPrincipal(db, { subject: WRITER, displayName: WRITER })
    await grantRepoPermissions(db, { principalId, repoId, permissions: ['submit'] })
    const r = await startTask(WRITER)
    expect(r.status).toBe(200)
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true)
  })

  it('参数显式传入另一个没有权限的 slug 时拒绝', async () => {
    await setAclSwitch('on')
    const taskId = `T-acl-x-${randomUUID().slice(0, 8)}`
    const r = await fetch(`${base}/api/harness/advance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, to: 'retrieve', data: {}, author: WRITER, repo: SLUG_OTHER }),
    })
    expect(r.status).toBe(403)
    const body = await r.json()
    expect(body.error).toBe('CROSS_REPO_REFERENCE')
  })

  it('开关 on：未授权主体读 harness_status 得到 CROSS_REPO_REFERENCE', async () => {
    await setAclSwitch('on')
    const r = await fetch(`${base}/api/harness/status?taskId=whatever`, {
      headers: { 'x-awp-username': NOBODY },
    })
    expect(r.status).toBe(403)
    const body = await r.json()
    expect(body.error).toBe('CROSS_REPO_REFERENCE')
  })

  it('开关写回 off：行为恢复与打开前相同（§8.2 回滚）', async () => {
    await setAclSwitch('off')
    const r = await startTask(`${NOBODY}-3`)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
  })
})
