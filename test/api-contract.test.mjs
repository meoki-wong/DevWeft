/**
 * api-contract.test.mjs — 契约对账 + /v1 补齐端点（阶段 2 / T2.4）
 *
 * 1. OpenAPI 双向对账：contracts/testing-openapi.yaml 的每条 path 必须有实现路由；
 *    实现的 /v1 路由必须被文档化（broker 进程的 /grants* 单独豁免，另行测试）。
 *    此前 35 条契约 17 条无实现、且没有任何机制拦截漂移——本测试使其成为不变量。
 * 2. 新实现的 5 条端点功能验证：单 run / report / run-group / cancel / gates:evaluate。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID, randomBytes } from 'node:crypto'
import { buildApp } from '../server.js'
import db from '../db.js'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer, issueToken } from '../testing/auth.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SLUG = `ct-${Date.now().toString(36)}`
const SHA = 'a'.repeat(64)
let boot = null
let app = null
let server = null
let base = null
let bearer = null

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug: SLUG, remoteUrl: 'https://gitlab.example/ct/x.git' })
  await ensureRepository(db, SLUG, boot.principalId)
  const principal = await authenticateBearer(db, `Bearer ${boot.token}`)
  bearer = { Authorization: `Bearer ${boot.token}`, 'content-type': 'application/json' }
  void principal
  app = buildApp()
  server = app.listen(0)
  await new Promise((r) => server.on('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  try { server?.close() } catch { /* ignore */ }
})

// ═══════════ 契约实现：5 条端点功能验证 ═══════════

describe('补齐的 /v1 契约端点', () => {
  let runId = null
  let groupId = null

  beforeAll(async () => {
    // 最小门禁链：一条带报告的 run（同 platform-integrity 模式）
    const taskId = `T-CT-${randomUUID().slice(0, 8)}`
    const now = new Date().toISOString()
    const ti = randomUUID()
    const bindingId = randomUUID()
    groupId = randomUUID()
    runId = randomUUID()
    const snapshotId = randomUUID()
    const planId = randomUUID()
    const subId = `sub-ct-${randomUUID().slice(0, 8)}`
    const profileId = (await db.prepare(`SELECT profile_revision_id FROM execution_profile_revisions WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`).get(boot.repoId))?.profile_revision_id
    const imageId = (await db.prepare(`SELECT image_id FROM runner_images WHERE state='active' LIMIT 1`).get())?.image_id
    const policyId = (await db.prepare(`SELECT policy_revision_id FROM policy_revisions WHERE state='active' LIMIT 1`).get())?.policy_revision_id
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
         active_binding_id, status, author_principal_id, created_at, updated_at)
       VALUES (?, ?, ?, 1, 1, 'EXECUTE', 'M', 'FEATURE', ?, 'open', ?, ?, ?)`
    ).run(ti, boot.repoId, taskId, bindingId, boot.principalId, now, now)
    await db.prepare(
      `INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format,
         head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
         target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
       VALUES (?, ?, ?, 'dirty_workspace', 'sha1', ?, ?, ?, ?, ?, 'refs/heads/stage', ?, ?, 128, ?, ?)`
    ).run(snapshotId, boot.repoId, boot.remoteId, 'h'.repeat(40), 's'.repeat(40), 't'.repeat(40), 'c'.repeat(64), boot.remoteId, 'g'.repeat(40), SHA, boot.principalId, now)
    await db.prepare(
      `INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json,
         changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
         required_case_set_sha256, advisory_case_set_sha256, created_at)
       VALUES (?, ?, ?, ?, '["web"]', ?, ?, ?, '{}', ?, ?, ?)`
    ).run(planId, boot.repoId, ti, policyId, 'c'.repeat(64), 'e'.repeat(64), `lock-${planId}`, 'r'.repeat(64), 'a'.repeat(64), now)
    await db.prepare(
      `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
         state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["web"]', ?, ?, '{}', 'active', ?)`
    ).run(bindingId, boot.repoId, snapshotId, planId, ti, profileId, imageId, SHA, policyId, 'c'.repeat(64), 'r'.repeat(64), now)
    await db.prepare(
      `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
         binding_id, expected_task_revision, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 'running', ?)`
    ).run(subId, `cr-${subId}`, boot.principalId, boot.repoId, ti, bindingId, now)
    await db.prepare(
      `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
         required_units_json, status, created_at)
       VALUES (?, ?, ?, ?, 'formal', 1, '["smoke:web"]', 'running', ?)`
    ).run(groupId, boot.repoId, subId, bindingId, now)
    await db.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
         unit, side, purpose, status, desired_state, max_attempts, next_attempt, lease_epoch,
         report_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'smoke', 'web', 'gate', 'passed', 'running', 2, 0, 0, ?, ?)`
    ).run(runId, groupId, bindingId, boot.repoId, ti, JSON.stringify({ checks: [{ caseKey: 'test:spec/ct-x', status: 'passed', detail: '' }] }), now)
  })

  it('GET /v1/test-runs/:runId 返回 run 详情（报告体不内联）', async () => {
    const res = await fetch(`${base}/v1/test-runs/${runId}`, { headers: bearer })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.run_id).toBe(runId)
    expect(body.data.status).toBe('passed')
    expect(body.data.has_report).toBe(true)
  })

  it('GET /v1/test-runs/:runId/report 返回解析后的 checks 报告', async () => {
    const res = await fetch(`${base}/v1/test-runs/${runId}/report`, { headers: bearer })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.checks).toHaveLength(1)
    expect(body.data.checks[0].caseKey).toBe('test:spec/ct-x')
  })

  it('GET /v1/run-groups/:runGroupId 返回组与其 runs', async () => {
    const res = await fetch(`${base}/v1/run-groups/${groupId}`, { headers: bearer })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.kind).toBe('formal')
    expect(body.data.runs).toHaveLength(1)
  })

  it('POST /v1/test-submissions/:id:cancel 将 queued/active run 置为待取消', async () => {
    const subId = (await db.prepare('SELECT submission_id FROM run_groups WHERE run_group_id=?').get(groupId)).submission_id
    await db.prepare(`UPDATE test_runs SET status='queued' WHERE run_id=?`).run(runId)
    const res = await fetch(`${base}/v1/test-submissions/${subId}:cancel`, {
      method: 'POST', headers: bearer, body: '{}',
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.canceled).toBeGreaterThanOrEqual(1)
    expect((await db.prepare('SELECT desired_state FROM test_runs WHERE run_id=?').get(runId)).desired_state).toBe('canceled')
  })

  it('POST /v1/gates:evaluate 返回门禁预评估（无提交 → NOT_SUBMITTED）', async () => {
    const res = await fetch(`${base}/v1/gates:evaluate`, {
      method: 'POST', headers: bearer,
      body: JSON.stringify({ repoSlug: SLUG, taskId: 'T-NOPE', size: 'M' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.wouldBlock).toBe(true)
    expect(body.data.blockedBy[0].code).toBe('NOT_SUBMITTED')
  })
})

// ═══════════ OpenAPI 双向对账 ═══════════

describe('OpenAPI 契约 ↔ 实现路由双向对账', () => {
  function openapiPaths() {
    const yaml = readFileSync(join(ROOT, 'contracts', 'testing-openapi.yaml'), 'utf8')
    const paths = new Set()
    let inPaths = false
    for (const line of yaml.split('\n')) {
      if (/^paths:/.test(line)) { inPaths = true; continue }
      if (inPaths && /^[A-Za-z#]/.test(line)) inPaths = false
      if (inPaths) {
        const m = line.match(/^ {2}(\/[^\s:]+(?:\:[a-z-]+)?):/)
        if (m) paths.add(m[1])
      }
    }
    return paths
  }

  function implementedV1Routes() {
    // buildApp 的路由直接注册在主 app 上；Express 5 用 app.router.stack
    const stack = (app.router && Array.isArray(app.router.stack)) ? app.router.stack : (app._router ? app._router.stack : [])
    const routes = new Set()
    const collect = (layers, prefix = '') => {
      for (const layer of layers) {
        if (layer.route) {
          let p = layer.route.path
          if (p instanceof RegExp) {
            p = p.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\:/g, ':').replace(/\\\//g, '/')
          }
          if (typeof p === 'string') routes.add(prefix + p)
        } else if (layer.name === 'router' && layer.handle?.stack) {
          collect(layer.handle.stack, prefix)
        }
      }
    }
    collect(stack)
    return routes
  }

  const norm = (p) => p.replace(/\\:/g, ':').replace(/\{(\w+)\}/g, ':$1')

  it('契约的每条 path 都有实现（/grants* 为 broker 进程职责，此处豁免）', () => {
    const oa = openapiPaths()
    const impl = implementedV1Routes()
    const missing = []
    for (const p of oa) {
      if (p.startsWith('/grants')) continue
      const target = norm('/v1' + p)
      const hit = [...impl].some((r) => {
        const nr = norm(r.replace(/^\/v1/, ''))
        const nt = norm(p)
        // :param 与 {param} 对齐 + :action 后缀一致
        if (nr === nt) return true
        const rs = nr.split('/'); const ts = nt.split('/')
        return rs.length === ts.length && rs.every((seg, i) => {
          if (seg === ts[i]) return true
          const pa = ts[i].startsWith(':'), pb = seg.startsWith(':')
          if (pa && pb) {
            // 段内允许 ':id:action' 组合——比较 action 后缀
            const actA = ts[i].split(':').slice(2).join(':')
            const actB = seg.split(':').slice(2).join(':')
            return actA === actB
          }
          return false
        })
      })
      if (!hit) missing.push(p)
    }
    expect(missing, `契约中有 ${missing.length} 条无实现: ${missing.join(', ')}`).toEqual([])
  })

  it('实现的 /v1 路由都被文档化（防实现漂移出契约）', () => {
    const oa = openapiPaths()
    const impl = implementedV1Routes()
    const undocumented = []
    for (const r of impl) {
      if (!r.startsWith('/v1')) continue
      if (r.startsWith('/v1/grants')) continue
      const rel = r.replace(/^\/v1/, '')
      const hit = [...oa].some((p) => {
        const nt = norm('/v1' + p)
        const nr = norm(r)
        if (nr === nt) return true
        const rs = nr.split('/'); const ts = nt.split('/')
        return rs.length === ts.length && rs.every((seg, i) => {
          if (seg === ts[i]) return true
          const pa = ts[i].startsWith(':'), pb = seg.startsWith(':')
          if (pa && pb) {
            const actA = ts[i].split(':').slice(2).join(':')
            const actB = seg.split(':').slice(2).join(':')
            return actA === actB
          }
          return false
        })
      })
      if (!hit) undocumented.push(r)
    }
    expect(undocumented, `实现中有 ${undocumented.length} 条未文档化: ${undocumented.join(', ')}`).toEqual([])
  })
})
