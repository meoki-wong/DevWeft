/**
 * gate-verdicts.test.mjs — 门禁终审错误码矩阵（阶段 1 / T1.1）
 *
 * 目标：state-machine / testing-gate / loop / leases / artifacts 的终审与闸门错误码
 * 此前 18 个零覆盖。本文件逐码驱动真实入口（harnessAdvance / harnessStart /
 * checkReadyToResubmit / reconcileRuns / issueArtifactDownloadUrl），
 * 断言 blockedBy[].code / 返回 code / 抛错码——补齐"判定函数有测试、终审无测试"的最后一公里。
 *
 * 门禁链 fixture 说明：
 *  - 走前门：bootstrapTestingPlatform（repo/remote/runner/profile/policy）+ submitTestSpec（考卷）；
 *  - 门禁链最小化：formal 组 required_units_json='[]' → evaluateNewGate 的单元证据核对为空集
 *    （单元证据路径已由 gate-execution-evidence.test.mjs 覆盖），聚焦 AC/绑定/重提终审；
 *  - spec 是否在 binding 的 assetLock 内 → 决定 isSpecOnActiveBindingPath（offPath 判定）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { buildAssetLock } from '../testing/asset-lock.js'
import { harnessStart, harnessAdvance } from '../harness/state-machine.js'
import { setRepoGateMode } from '../harness/testing-gate.js'
import { recordSpecF2p } from '../testing/f2p.js'
import {
  checkReadyToResubmit,
  ensureGateLoop,
  updateGateLoop,
  acquireTaskSession,
  getActiveTaskSession,
} from '../harness/loop.js'
import { acquireLease, heartbeatLease, reconcileRuns } from '../testing/leases.js'
import { issueArtifactDownloadUrl } from '../testing/artifacts.js'
import { submitTestSpec } from '../testing/test-specs.js'

const SLUG = `gv-${Date.now().toString(36)}`
const SHA = 'a'.repeat(64)
const AUTHOR = 'gv-tester'
let boot = null
let gvWorker = null

async function realImageId() {
  return (await db.prepare(`SELECT image_id FROM runner_images WHERE state='active' LIMIT 1`).get())?.image_id
}
async function realProfileId() {
  return (await db.prepare(`SELECT profile_revision_id FROM execution_profile_revisions WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`).get(boot.repoId))?.profile_revision_id
}
async function realPolicyId() {
  return (await db.prepare(`SELECT policy_revision_id FROM policy_revisions WHERE state='active' LIMIT 1`).get())?.policy_revision_id
}

const SPEC_SRC = `export default async function run({ page, baseURL }) {
  await page.route('**/api/**/list*', async (route) => {
    await route.fulfill({ json: { code: 0, data: { list: [{ id: '1' }], total: 1 } } })
  })
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 200)
  await page.goto(\`\${baseURL}/app/gv-check\`)
  await respPromise
  await expect(page.getByTestId('list-item').first()).toBeVisible()
}`

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug: SLUG, remoteUrl: 'https://gitlab.example/gv/x.git' })
  await ensureRepository(db, SLUG, boot.principalId)
  gvWorker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'gv-worker' })
})

afterAll(async () => {
  // 清理本文件产生的 harness 任务（共享临时库，跨文件复用）
  try {
    const rows = await db.prepare('SELECT task_id FROM tasks WHERE repo=?').all(SLUG)
    for (const r of rows) {
      await db.prepare('DELETE FROM task_versions WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
      await db.prepare('DELETE FROM gate_loops WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
      await db.prepare('DELETE FROM task_sessions WHERE repo=? AND task_id=?').run(SLUG, r.task_id)
    }
    await db.prepare('DELETE FROM tasks WHERE repo=?').run(SLUG)
  } catch { /* ignore */ }
})

function nowIso() {
  return new Date().toISOString()
}

/**
 * 建一个带最小门禁链的任务：
 * harnessStart → CLASSIFY(size) → EXECUTE(acceptance) → enforce 档位
 * → spec（前门）+ mv/f2p 状态 → task_instance/binding/group（required_units='[]'）
 */
async function mkGateTask(opts = {}) {
  const {
    ac = [{ id: 'AC-1', text: '列表首项可见且数据数量为 1', type: 'data' }],
    refs = ['AC-1'],
    mv = 0,
    f2p = null,
    lockSpecs = 'auto',
    size = 'M',
    mode = 'enforce_ml',
    fk = `fk-gv-${randomUUID().slice(0, 8)}`,
  } = opts
  const taskId = `T-GV-${randomUUID().slice(0, 8)}`
  const started = await harnessStart({ taskId, requirement: `终审矩阵 ${taskId}`, type: 'FEATURE', author: AUTHOR, repo: SLUG })
  if (!started.ok) throw new Error('harnessStart failed: ' + JSON.stringify(started).slice(0, 200))
  const located = await harnessAdvance({ taskId, to: 'retrieve', data: { size, decisions: ['已定位改动范围'] }, author: AUTHOR, repo: SLUG })
  if (!located.ok) throw new Error('retrieve failed: ' + JSON.stringify(located).slice(0, 200))
  const a1 = await harnessAdvance({ taskId, to: 'plan', data: { decisions: ['范围确认'] }, author: AUTHOR, repo: SLUG })
  if (!a1.ok) throw new Error('plan failed: ' + JSON.stringify(a1).slice(0, 200))
  const a2 = await harnessAdvance({ taskId, to: 'execute', data: { acceptance: ac }, author: AUTHOR, repo: SLUG })
  if (!a2.ok) throw new Error('EXECUTE failed: ' + JSON.stringify(a2).slice(0, 200))
  await setRepoGateMode(db, SLUG, mode)
  // EXECUTE→VERIFY 的旧守卫要求新鲜 L1（verify_report 且 task_id 关联）
  await db.prepare(
    `INSERT INTO verify_reports(id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'L1', 'web', 'src/gv.vue', 1, 0, '', ?, ?, ?)`
  ).run('gv-l1-' + randomUUID().slice(0, 8), SLUG, SLUG, AUTHOR, taskId, nowIso())

  // 考卷（前门）+ 三重验卷状态
  const spec = await (async () => {
    try {
      return await submitTestSpecSafe({ fk, refs, taskId })
    } catch (e) {
      throw new Error('submitTestSpec failed: ' + e.message)
    }
  })()
  if (mv) await db.prepare('UPDATE test_specs SET mutation_verified=1 WHERE spec_id=?').run(spec.spec_id)
  if (f2p) {
    await recordSpecF2p(db, {
      runId: `gv-${randomUUID().slice(0, 8)}`,
      repoId: boot.repoId,
      featureKey: fk,
      version: 1,
      baselineOid: 'b'.repeat(40),
      snapshotOid: 'c'.repeat(40),
      baselineResult: f2p.baseline,
      snapshotResult: f2p.snapshot,
    })
  }

  // 最小门禁链（FK 完整：snapshots/suite_plans/profile/image/policy 由 bootstrap 提供）
  const ti = randomUUID()
  const bindingId = randomUUID()
  const snapshotId = randomUUID()
  const planId = randomUUID()
  const now = nowIso()
  const lockDoc = buildAssetLock(
    lockSpecs === 'auto' ? [{ feature_key: fk, spec_id: 'sp-' + fk, spec_type: 'e2e', side: 'web', version: 1, blob_sha256: SHA, entry: fk + '.spec.mjs' }] : (lockSpecs || [])
  )
  await db.prepare(
    `INSERT INTO business_snapshots(snapshot_id, repo_id, source_remote_id, snapshot_kind, object_format,
       head_commit_oid, snapshot_commit_oid, snapshot_tree_oid, changed_paths_sha256,
       target_remote_id, target_ref, target_commit_oid, bundle_sha256, bundle_size, created_by, created_at)
     VALUES (?, ?, ?, 'dirty_workspace', 'sha1', ?, ?, ?, ?, ?, 'refs/heads/stage', ?, ?, 128, ?, ?)`
  ).run(snapshotId, boot.repoId, boot.remoteId, 'h'.repeat(40), 's'.repeat(40), 't'.repeat(40), 'c'.repeat(64), boot.remoteId, 'g'.repeat(40), SHA, boot.principalId, now)
  await db.prepare(
    `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
       active_binding_id, status, author_principal_id, created_at, updated_at)
     VALUES (?, ?, ?, 1, 1, 'EXECUTE', ?, 'FEATURE', ?, 'open', ?, ?, ?)`
  ).run(ti, boot.repoId, taskId, size, bindingId, boot.principalId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)`
  ).run(boot.repoId, taskId, ti, now)
  await db.prepare(
    `INSERT INTO suite_plans(suite_plan_id, repo_id, task_instance_id, policy_revision_id, resolved_sides_json,
       changed_paths_sha256, effective_suite_tree_oid, lock_sha256, canonical_lock_json,
       required_case_set_sha256, advisory_case_set_sha256, created_at)
     VALUES (?, ?, ?, 'pr-seed', '["web"]', ?, ?, ?, '{}', ?, ?, ?)`
  ).run(planId, boot.repoId, ti, 'c'.repeat(64), 'e'.repeat(64), `lock-${planId}`, 'r'.repeat(64), 'a'.repeat(64), now)
  await db.prepare(
    `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
       execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
       resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
       state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["web"]', ?, ?, ?, 'active', ?)`
  ).run(
    bindingId, boot.repoId, snapshotId, planId, ti,
    (await db.prepare(`SELECT profile_revision_id FROM execution_profile_revisions WHERE repo_id=? AND state='active' ORDER BY revision DESC LIMIT 1`).get(boot.repoId))?.profile_revision_id,
    (await db.prepare(`SELECT image_id FROM runner_images WHERE state='active' LIMIT 1`).get())?.image_id,
    SHA,
    (await db.prepare(`SELECT policy_revision_id FROM policy_revisions WHERE state='active' LIMIT 1`).get())?.policy_revision_id,
    'c'.repeat(64), 'r'.repeat(64), JSON.stringify({ assetLock: lockDoc }), now
  )
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
       required_units_json, status, created_at)
     VALUES (?, ?, ?, ?, 'formal', 1, '["static:na","smoke:web"]', 'passed', ?)`
  ).run(randomUUID(), boot.repoId, await seedSubmission(ti, bindingId, now), bindingId, now)
  await seedGreenRuns(bindingId, ti, fk, lockSpecs === 'auto')
  return { taskId, fk, specId: spec.spec_id, bindingId }
}

/** 绿证据：static:na 与 smoke:web 两条 passed run + attestation + accepted result（单元证据核对通过） */
async function seedGreenRuns(bindingId, ti, fk, includeSpecCheck) {
  const now = nowIso()
  const units = [
    { unit: 'static', side: 'na', checks: [] },
    { unit: 'smoke', side: 'web', checks: includeSpecCheck ? [{ caseKey: `test:spec/${fk}`, status: 'passed', detail: '' }] : [] },
  ]
  for (const u of units) {
    const runId = randomUUID()
    await db.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
         unit, side, purpose, status, desired_state, max_attempts, next_attempt, lease_epoch,
         report_json, created_at)
       SELECT ?, g.run_group_id, ?, ?, ?, ?, ?, 'gate', 'passed', 'running', 2, 0, 1, ?, ?
       FROM run_groups g WHERE g.binding_id=? AND g.kind='formal' LIMIT 1`
    ).run(runId, bindingId, boot.repoId, ti, u.unit, u.side, JSON.stringify({ checks: u.checks }), now, bindingId)
    await db.prepare(
      `INSERT INTO run_attempts(repo_id, run_id, attempt, worker_id, lease_epoch, status, image_id, started_at, finished_at)
       VALUES (?, ?, 1, ?, 1, 'passed', ?, ?, ?)`
    ).run(boot.repoId, runId, gvWorker.worker_id, await realImageId(), now, now)
    await db.prepare(
      `INSERT INTO accepted_run_results(run_id, attempt, lease_epoch, result_sha256, accepted_at)
       VALUES (?, 1, 1, ?, ?)`
    ).run(runId, SHA, now)
    await db.prepare(
      `INSERT INTO run_attestations(run_attestation_id, repo_id, run_id, attempt, lease_epoch, binding_id,
         worker_id, worker_cert_thumbprint, image_id, image_manifest_sha256, result_sha256, artifact_sha256,
         canonical_sha256, signature, completed_at)
       VALUES (?, ?, ?, 1, 1, ?, ?, 'thumb', ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), boot.repoId, runId, bindingId, gvWorker.worker_id, await realImageId(), SHA, SHA, SHA, SHA, SHA, now)
  }
}

const submissionSeq = { n: 0 }
async function seedSubmission(taskInstanceId, bindingId, now) {
  const id = `sub-gv-${++submissionSeq.n}-${randomUUID().slice(0, 8)}`
  await db.prepare(
    `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
       binding_id, expected_task_revision, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'queued', ?)`
  ).run(id, `cr-${id}`, boot.principalId, boot.repoId, taskInstanceId, bindingId, now)
  return id
}

/** 走前门提交考卷（非 project 仓无契约强制；失败时回退手插 active 行，保持 specId 返回形状） */
async function submitTestSpecSafe({ fk, refs, taskId }) {
  try {
    return await submitTestSpec({
      repoId: SLUG, featureKey: fk, author: 'ai', specType: 'e2e', side: 'web',
      content: SPEC_SRC, acceptanceRefs: refs, taskId,
    })
  } catch (e) {
    const specId = randomUUID()
    const now = nowIso()
    await db.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
         blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ai', 'e2e', ?, ?, 1, 'active', 0, ?, NULL, ?, ?)`
    ).run(specId, boot.repoId, fk, fk, `${fk}.spec.mjs`, SHA, JSON.stringify(refs), now, now)
    return { spec_id: specId }
  }
}

// ═══════════ 状态机硬闸 ═══════════

describe('状态机硬闸（SIZE/TYPE 冻结、会话、任务存在性）', () => {
  it('EXECUTE 后允许改 size（不再 SIZE_FROZEN）', async () => {
    const { taskId } = await mkGateTask()
    const r = await harnessAdvance({ taskId, to: 'static', data: { size: 'L' }, author: AUTHOR, repo: SLUG })
    expect(r.code).not.toBe('SIZE_FROZEN')
  })

  it('EXECUTE 后允许改 type（不再 TYPE_FROZEN）', async () => {
    const { taskId } = await mkGateTask()
    const r = await harnessAdvance({ taskId, to: 'static', data: { type: 'FIX' }, author: AUTHOR, repo: SLUG })
    expect(r.code).not.toBe('TYPE_FROZEN')
  })

  it('TASK_SESSION_HELD：严格会话下他人 advance 被拦', async () => {
    const { taskId } = await mkGateTask()
    await db.prepare(
      `INSERT INTO platform_settings(key, value, updated_at) VALUES ('harness_strict_session', 'on', ?)
       ON CONFLICT(key) DO UPDATE SET value='on', updated_at=excluded.updated_at`
    ).run(nowIso())
    try {
      // harnessStart 已由 AUTHOR 领会话；他人 bob advance 应被拦
      const held = await getActiveTaskSession(db, { repo: SLUG, taskId })
      expect(held).toBeTruthy()
      const r = await harnessAdvance({ taskId, to: 'static', author: 'bob', repo: SLUG })
      expect(r.ok).toBe(false)
      expect(r.code).toBe('TASK_SESSION_HELD')
    } finally {
      await db.prepare(`DELETE FROM platform_settings WHERE key='harness_strict_session'`).run()
    }
  })

  it('TASK_EXISTS / TASK_TERMINAL：显式 taskId 重复开启', async () => {
    const t = `T-EX-${randomUUID().slice(0, 8)}`
    const first = await harnessStart({ taskId: t, requirement: '首个', type: 'FIX', author: AUTHOR, repo: SLUG })
    expect(first.ok).toBe(true)
    const dup = await harnessStart({ taskId: t, requirement: '重复', type: 'FIX', author: AUTHOR, repo: SLUG })
    expect(dup.ok).toBe(false)
    expect(dup.code).toBe('TASK_EXISTS')
    // 置终态后再开 → TASK_TERMINAL
    await db.prepare(`UPDATE tasks SET phase='DONE', closed_at=? WHERE repo=? AND task_id=?`).run(nowIso(), SLUG, t)
    const again = await harnessStart({ taskId: t, requirement: '再开', type: 'FIX', author: AUTHOR, repo: SLUG })
    expect(again.ok).toBe(false)
    expect(again.code).toBe('TASK_TERMINAL')
  })
})

// ═══════════ AC 覆盖与三重验卷终审（经 harnessAdvance 真实门禁路径） ═══════════

describe('AC/三重验卷终审（enforce_ml + M 全链）', () => {
  it('AC_UNCOVERED：考卷未覆盖冻结 AC', async () => {
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-OTHER'] })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AC_UNCOVERED')
  })

  it('MUTATION_UNVERIFIED：考卷覆盖 AC 但变异未验证', async () => {
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-1'], mv: 0 })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
        expect(r.code).toBe('MUTATION_UNVERIFIED')
  })

  it('F2P_PENDING：mv 已过但 F2P 无记录', async () => {
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-1'], mv: 1 })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('F2P_PENDING')
  })

  it('F2P_BAD：always_fail 判废（新语义：always_pass 走 warn 不在此列）', async () => {
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'failed' } })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('F2P_BAD')
  })

  it('AC_ALL_OFFPATH：覆盖卷全部不在观测路径 → 禁止零观测通过', async () => {
    // spec 不在 binding assetLock 内 → isSpecOnActiveBindingPath=false → offPath
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'skipped', snapshot: 'passed' }, lockSpecs: [] })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AC_ALL_OFFPATH')
  })

  it('三重全过 → 门禁放行（对照路径：advance 成功进入 VERIFY）', async () => {
    const { taskId, bindingId } = await mkGateTask({
      refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'passed' },
    })
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(true)
    expect(r.to).toBe('static')
  })
})

// ═══════════ 绑定/重提/编排错误码 ═══════════

describe('TASK_BINDING_SUPERSEDED 与重提闸', () => {
  it('TASK_BINDING_SUPERSEDED：gateBindingId 非当前 active binding', async () => {
    const { taskId, bindingId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'passed' } })
    // 换绑：新 binding 行 + instance 指向它
    const b2 = randomUUID()
    const old = await db.prepare('SELECT * FROM test_bindings WHERE binding_id=?').get(bindingId)
    await db.prepare(
      `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
         state, created_at)
       SELECT ?, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
         'active', ? FROM test_bindings WHERE binding_id=?`
    ).run(b2, nowIso(), bindingId)
    await db.prepare('UPDATE task_instances SET active_binding_id=? WHERE task_instance_id=?').run(b2, old.task_instance_id)
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TASK_BINDING_SUPERSEDED')
  })

  it('PRODUCT_NOT_FIXED：product 失败未修禁止重提', async () => {
    const { taskId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'passed' } })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { awaitDistill: false, lastClass: 'product' } })
    // 最近 formal 组 failed + eslint（product）失败 check
    await seedFailedGroup(taskId, [{ caseKey: 'test:static/eslint', status: 'failed', detail: 'prettier err' }])
    const r = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, productFixed: false })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('PRODUCT_NOT_FIXED')
  })

  it('SUITE_NOT_FIXED：suite 失败（考卷自身）未修禁止重提', async () => {
    const { taskId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'passed' } })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { awaitDistill: false, lastClass: 'suite' } })
    await seedFailedGroup(taskId, [{ caseKey: 'test:spec/fk-x', status: 'failed', detail: 'page.goto: Cannot navigate to invalid URL' }])
    const r = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, suiteFixed: false })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('SUITE_NOT_FIXED')
  })

  it('AWAIT_DISTILL：失败后未沉淀经验禁止重提', async () => {
    const { taskId } = await mkGateTask({ refs: ['AC-1'], mv: 1, f2p: { baseline: 'failed', snapshot: 'passed' } })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { awaitDistill: true, lastClass: 'product' } })
    await seedFailedGroup(taskId, [{ caseKey: 'test:static/eslint', status: 'failed', detail: 'x' }])
    const r = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, productFixed: true })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AWAIT_DISTILL')
  })
})

async function seedFailedGroup(taskId, checks) {
  const now = nowIso()
  const ti = await db.prepare(
    `SELECT t.task_instance_id FROM task_instances t JOIN legacy_task_mappings m ON m.task_instance_id=t.task_instance_id
     WHERE t.repo_id=? AND m.legacy_task_id=? ORDER BY t.epoch DESC LIMIT 1`
  ).get(boot.repoId, taskId)
  if (!ti) throw new Error('no task instance for ' + taskId)
  const bindingId = randomUUID()
  const snapshotId = randomUUID()
  const planId = randomUUID()
  const groupId = randomUUID()
  const runId = randomUUID()
  const subId = `sub-fail-${randomUUID().slice(0, 8)}`
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
     VALUES (?, ?, ?, 'pr-seed', '["web"]', ?, ?, ?, '{}', ?, ?, ?)`
  ).run(planId, boot.repoId, ti.task_instance_id, 'c'.repeat(64), 'e'.repeat(64), `lock-${planId}`, 'r'.repeat(64), 'a'.repeat(64), now)
  await db.prepare(
    `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
       execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
       resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json,
       state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '["web"]', ?, ?, '{}', 'active', ?)`
  ).run(bindingId, boot.repoId, snapshotId, planId, ti.task_instance_id, await realProfileId(), await realImageId(), SHA, await realPolicyId(), 'c'.repeat(64), 'r'.repeat(64), now)
  // 外键顺序：binding 建好后再插引用它的 submission
  await db.prepare(
    `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id,
       binding_id, expected_task_revision, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 'failed', ?)`
  ).run(subId, `cr-${subId}`, boot.principalId, boot.repoId, ti.task_instance_id, bindingId, now)
  await db.prepare(
    `INSERT INTO run_groups(run_group_id, repo_id, submission_id, binding_id, kind, gate_eligible,
       required_units_json, status, created_at)
     VALUES (?, ?, ?, ?, 'formal', 1, '["smoke:web"]', 'failed', ?)`
  ).run(groupId, boot.repoId, subId, bindingId, now)
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
       unit, side, purpose, status, desired_state, max_attempts, next_attempt, lease_epoch,
       report_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'smoke', 'web', 'gate', 'failed', 'running', 2, 0, 0, ?, ?)`
  ).run(runId, groupId, bindingId, boot.repoId, ti.task_instance_id, JSON.stringify({ checks }), now)
  return { groupId, bindingId }
}

// ═══════════ 执行链错误码 ═══════════

describe('执行链错误码（HEARTBEAT_LOST / PRECONDITION_FAILED）', () => {
  it('HEARTBEAT_LOST：心跳后租约过期 → reconcile 标记 attempt lost 并回队', async () => {
    const { taskId } = await mkGateTask({ refs: ['AC-1'], mv: 1 })
    const chain = await seedFailedGroup(taskId, [])
    // run 改回排队，可被 worker 认领
    await db.prepare(`UPDATE test_runs SET status='queued', report_json=NULL WHERE run_group_id=?`).run(chain.groupId)
    const lease = await acquireLease(db, gvWorker)
    expect(lease).toBeTruthy()
    // 认领后 attempt=reserved；模拟 accept 完成 → leased，再心跳一次（→ provisioning）
    await db.prepare(`UPDATE run_attempts SET status='leased' WHERE run_id=? AND attempt=?`).run(lease.runId, lease.attempt)
    await heartbeatLease(db, gvWorker, lease.leaseId, {
      runId: lease.runId,
      workerId: gvWorker.worker_id,
      attempt: lease.attempt,
      leaseEpoch: lease.leaseEpoch,
      leaseToken: lease.leaseToken,
      operationSeq: 1,
    })
    const future = new Date(Date.now() + 90 * 1000)
    const report = await reconcileRuns(db, { now: future })
    expect(report.expiredLeases.length).toBeGreaterThanOrEqual(1)
    const attempt = await db.prepare(
      `SELECT error_code, status FROM run_attempts WHERE run_id=? ORDER BY attempt DESC LIMIT 1`
    ).get(lease.runId)
    expect(attempt.error_code).toBe('HEARTBEAT_LOST')
    expect(attempt.status).toBe('lost')
  })

  it('PRECONDITION_FAILED：产物未扫描通过禁止发下载 URL（先校验后查库，内存对象即可）', async () => {
    const principal = { principalId: boot.principalId, subject: AUTHOR }
    expect(() => issueArtifactDownloadUrl(db, {
      artifact: { artifact_id: 'x', scan_state: 'pending', repo_id: boot.repoId },
      principal,
    })).toThrow(/PRECONDITION_FAILED/)
  })
})
