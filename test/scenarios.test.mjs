/**
 * scenarios.test.mjs — 业务闭环场景测试（阶段 3 / T3.3，s1~s5；s6 真并发见 platform-integrity）
 *
 * 每条场景只调真实函数组合（状态机 × 提交链 × 门禁 × 闭环 × 租约），断言业务不变量：
 *   s1 绿门禁放行 / 无提交拦截；s2 失败重提闸；s3 考卷失败豁免迭代；
 *   s4 中断恢复 + 重试预算；s5 变异竞态回写冻结版本。
 * 报告 fixture：test/fixtures/real/report-*.json（生产同构形态）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID, randomBytes } from 'node:crypto'
import db from '../db.js'
import { ensureRepository } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { harnessStart, harnessAdvance } from '../harness/state-machine.js'
import { setRepoGateMode, evaluateNewGate, evaluateAcCoverage } from '../harness/testing-gate.js'
import {
  ensureGateLoop, updateGateLoop, getGateLoop, nextGateLoopIteration,
  checkReadyToResubmit, grantGateRetryBudget, syncGateLoopFromRunGroup,
} from '../harness/loop.js'
import { recordSpecF2p } from '../testing/f2p.js'
import { seedGateChain } from './helpers/submission-chain.mjs'
import { reconcileRuns, markMutationVerified } from '../testing/leases.js'

const SLUG = `sc-${Date.now().toString(36)}`
const AUTHOR = 'sc-tester'
let boot = null
let worker = null

async function mkTask({ size = 'M', ac } = {}) {
  const taskId = `T-SC-${randomUUID().slice(0, 8)}`
  const started = await harnessStart({ taskId, requirement: `场景 ${taskId}`, type: 'FEATURE', author: AUTHOR, repo: SLUG })
  if (!started.ok) throw new Error('start failed: ' + JSON.stringify(started).slice(0, 150))
  const located = await harnessAdvance({ taskId, to: 'retrieve', data: { size, decisions: ['已定位改动范围'] }, author: AUTHOR, repo: SLUG })
  if (!located.ok) throw new Error('retrieve failed: ' + JSON.stringify(located).slice(0, 240))
  const a1 = await harnessAdvance({ taskId, to: 'plan', data: { decisions: ['范围确认'] }, author: AUTHOR, repo: SLUG })
  if (!a1.ok) throw new Error('plan failed: ' + JSON.stringify(a1).slice(0, 240))
  const acceptance = ac || [{ id: 'AC-1', text: '列表首项可见且数据数量为 1', type: 'data' }]
  const a2 = await harnessAdvance({ taskId, to: 'execute', data: { acceptance }, author: AUTHOR, repo: SLUG })
  if (!a2.ok) throw new Error('EXECUTE failed: ' + JSON.stringify(a2).slice(0, 150))
  // 旧守卫:EXECUTE→VERIFY 须新鲜 L1
  await db.prepare(
    `INSERT INTO verify_reports(id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'L1', 'web', 'src/sc.vue', 1, 0, '', ?, ?, ?)`
  ).run('sc-l1-' + randomUUID().slice(0, 8), SLUG, SLUG, AUTHOR, taskId, new Date().toISOString())
  return taskId
}

async function seedSpec(taskId, { fk = `fk-sc-${randomUUID().slice(0, 8)}`, refs = ['AC-1'], mv = 0, version = 1, reviewStatus = 'active' } = {}) {
  const specId = randomUUID()
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
       demand_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ai', 'e2e', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
  ).run(specId, boot.repoId, fk, fk, `${fk}.spec.mjs`, 'b'.repeat(64), version, reviewStatus, mv, JSON.stringify(refs), taskId, now, now)
  return { fk, specId }
}

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug: SLUG, remoteUrl: 'https://gitlab.example/sc/x.git' })
  await ensureRepository(db, SLUG, boot.principalId)
  worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'sc-worker' })
  await setRepoGateMode(db, SLUG, 'enforce_ml')
})

afterAll(async () => {
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

// ═══ s1: 绿门禁放行 / 无提交拦截 ═══

describe('s1 全链闭环：门禁绿才放行 VERIFY', () => {
  it('无提交 → advance VERIFY 被 NOT_SUBMITTED 拦截', async () => {
    const taskId = await mkTask()
    const r = await harnessAdvance({ taskId, to: 'static', author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NOT_SUBMITTED')
  })

  it('完整绿链 → evaluateNewGate 放行 → advance VERIFY 成功', async () => {
    const taskId = await mkTask()
    const spec = await seedSpec(taskId, { refs: ['AC-1'], mv: 1 })
    // F2P ok 证明 + 绿证据链（checks 覆盖冻结卷）
    await recordSpecF2p(db, {
      runId: `sc-${randomUUID().slice(0, 8)}`, repoId: boot.repoId, featureKey: spec.fk, version: 1,
      baselineOid: 'b'.repeat(40), snapshotOid: 'c'.repeat(40),
      baselineResult: 'failed', snapshotResult: 'passed',
    })
    const checks = [
      { caseKey: 'test:static/eslint', status: 'passed', durationMs: 100 },
      { caseKey: `test:spec/${spec.fk}`, status: 'passed', durationMs: 520 },
    ]
    const chain = await seedGateChain(db, {
      repoId: boot.repoId, taskId,
      specs: [{ feature_key: spec.fk, spec_id: spec.specId, version: 1, spec_type: 'e2e', side: 'web', blob_sha256: 'b'.repeat(64) }],
      groupStatus: 'passed',
      runs: [
        { unit: 'static', side: 'na', status: 'passed', report: { checks: [checks[0]] } },
        { unit: 'smoke', side: 'web', status: 'passed', report: { checks } },
      ],
      withEvidence: true,
      workerId: worker.worker_id,
    })
    const gate = await evaluateNewGate(db, {
      repoSlug: SLUG, taskId, size: 'M', gateBindingId: chain.bindingId,
    })
    expect(gate.wouldBlock).toBe(false)
    const ac = await evaluateAcCoverage(db, { repoSlug: SLUG, taskId })
    expect(ac.missing).toEqual([])
    expect(ac.mutationPending).toBe(false)
    expect(ac.f2pStatus).toBe('ok')
    const r = await harnessAdvance({ taskId, to: 'static', data: { gateBindingId: chain.bindingId }, author: AUTHOR, repo: SLUG })
    expect(r.ok).toBe(true)
    expect(r.to).toBe('static')
    // 闭环同步：gateLoop → green_pending_advance
    await syncGateLoopFromRunGroup(db, { repoSlug: SLUG, taskId, size: 'M', phase: 'VERIFY' })
    expect((await getGateLoop(db, { repo: SLUG, taskId })).state).toBe('green_pending_advance')
  })
})

// ═══ s2: 失败重提闸 ═══

describe('s2 失败→修复→重提闸门', () => {
  it('product 失败未修 → PRODUCT_NOT_FIXED；同证据重提 → NO_NEW_EVIDENCE', async () => {
    const taskId = await mkTask()
    await seedSpec(taskId, { refs: ['AC-1'] })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    // product 类失败（eslint）——真实 failed 形态
    await seedGateChain(db, {
      repoId: boot.repoId, taskId, groupStatus: 'failed',
      runs: [{ unit: 'smoke', side: 'web', status: 'failed', report: { checks: [
        { caseKey: 'test:static/eslint', status: 'failed', detail: 'indent error' },
      ] } }],
    })
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { awaitDistill: false, lastClass: 'product' } })
    const blocked = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, productFixed: false })
    expect(blocked.ok).toBe(false)
    expect(blocked.code).toBe('PRODUCT_NOT_FIXED')
    expect(blocked.mustFix.requiresProductFix).toBe(true)
    // product 已修 → 允许（再无同证据拦截）
    const ok = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, productFixed: true })
    expect(ok.ok).toBe(true)
  })

  it('product 已修但证据与上次失败完全相同 → NO_NEW_EVIDENCE', async () => {
    const taskId = await mkTask()
    await seedSpec(taskId, { refs: ['AC-1'] })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    const evidence = { bundleSha256: 'f'.repeat(64), snapshotTreeOid: 'e'.repeat(40), changedPathsSha256: 'd'.repeat(64), headCommitOid: 'c'.repeat(40) }
    // 失败组：binding 指向与 evidence 相同 snapshot
    const chain = await seedGateChain(db, {
      repoId: boot.repoId, taskId, groupStatus: 'failed',
      runs: [{ unit: 'smoke', side: 'web', status: 'failed', report: { checks: [
        { caseKey: 'test:static/eslint', status: 'failed', detail: 'x' },
      ] } }],
    })
    // 对齐 snapshot oids 与 evidence
    await db.prepare(
      `UPDATE business_snapshots SET bundle_sha256=?, snapshot_tree_oid=?, changed_paths_sha256=?, head_commit_oid=?
       WHERE snapshot_id=(SELECT snapshot_id FROM test_bindings WHERE binding_id=?)`
    ).run(evidence.bundleSha256, evidence.snapshotTreeOid, evidence.changedPathsSha256, evidence.headCommitOid, chain.bindingId)
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { awaitDistill: false, lastClass: 'product' } })
    const r = await checkReadyToResubmit(db, { repoSlug: SLUG, taskId, productFixed: true, evidence })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NO_NEW_EVIDENCE')
  })
})

// ═══ s3: 考卷失败豁免迭代 ═══

describe('s3 考卷(suite)失败不烧迭代', () => {
  it('suite 分类失败 → nextGateLoopIteration 豁免；product 分类 → 正常递增', async () => {
    const taskIdSuite = await mkTask()
    await seedSpec(taskIdSuite, { refs: ['AC-1'] })
    await ensureGateLoop(db, { repo: SLUG, taskId: taskIdSuite, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId: taskIdSuite, patch: { iteration: 2 } })
    await seedGateChain(db, {
      repoId: boot.repoId, taskId: taskIdSuite, groupStatus: 'failed',
      runs: [{ unit: 'smoke', side: 'web', status: 'failed', report: { checks: [
        { caseKey: 'test:spec/fk-bad-url', status: 'failed', detail: 'page.goto: Cannot navigate to invalid URL' },
      ] } }],
    })
    const suiteNext = await nextGateLoopIteration(db, { repoSlug: SLUG, taskId: taskIdSuite })
    expect(suiteNext.exempted).toBe(true)
    expect(suiteNext.next).toBe(2) // 不烧

    const taskIdProduct = await mkTask()
    await seedSpec(taskIdProduct, { refs: ['AC-1'] })
    await ensureGateLoop(db, { repo: SLUG, taskId: taskIdProduct, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId: taskIdProduct, patch: { iteration: 2 } })
    await seedGateChain(db, {
      repoId: boot.repoId, taskId: taskIdProduct, groupStatus: 'failed',
      runs: [{ unit: 'smoke', side: 'web', status: 'failed', report: { checks: [
        { caseKey: 'test:static/eslint', status: 'failed', detail: 'x' },
      ] } }],
    })
    const productNext = await nextGateLoopIteration(db, { repoSlug: SLUG, taskId: taskIdProduct })
    expect(productNext.exempted).toBe(false)
    expect(productNext.next).toBe(3) // 正常烧
  })
})

// ═══ s4: 中断恢复 + 重试预算 ═══

describe('s4 中断恢复：reconcile 回队 + 重试预算只补一次', () => {
  it('租约丢失回队后 grantGateRetryBudget 补一次预算、二次不再补', async () => {
    const taskId = await mkTask()
    await seedSpec(taskId, { refs: ['AC-1'] })
    await ensureGateLoop(db, { repo: SLUG, taskId, size: 'M' })
    await updateGateLoop(db, { repo: SLUG, taskId, patch: { iteration: 5, maxIterations: 5, needsHuman: 1 } })
    // 丢失的 run（expired lease → lost）
    await seedGateChain(db, {
      repoId: boot.repoId, taskId, groupStatus: 'running',
      runs: [{ unit: 'smoke', side: 'web', status: 'queued', report: null }],
    })
    const before = await getGateLoop(db, { repo: SLUG, taskId })
    expect(before.needsHuman).toBeTruthy()
    // resume：补一次预算解锁
    const g1 = await grantGateRetryBudget(db, { repo: SLUG, taskId, actor: 'resume' })
    expect(g1.granted).toBe(true)
    const after1 = await getGateLoop(db, { repo: SLUG, taskId })
    expect(after1.needsHuman).toBeFalsy()
    expect(after1.maxIterations).toBe(6)
    expect(after1.iteration).toBe(5) // 不回退 iteration
    // 第二次：预算已够 → 不再补
    const g2 = await grantGateRetryBudget(db, { repo: SLUG, taskId, actor: 'resume' })
    expect(g2.granted).toBe(false)
    // run 因租约过期被回队（reconcile 幂等，无额外副作用）
    const report = await reconcileRuns(db, { now: new Date(Date.now() + 120 * 1000) })
    expect(Array.isArray(report.requeuedRuns)).toBe(true)
  })
})

// ═══ s5: 变异竞态 ═══

describe('s5 变异验卷竞态：回写冻结在执行版本', () => {
  it('v1 被变异执行且被 AI 改版归档 → mv 记在 v1，不误盖 v2（防假绿）', async () => {
    const taskId = await mkTask()
    const fk = `fk-sc-${randomUUID().slice(0, 8)}`
    const v1 = await seedSpec(taskId, { fk, refs: ['AC-1'], mv: 0, version: 1, reviewStatus: 'archived' })
    const v2 = await seedSpec(taskId, { fk, refs: ['AC-1'], mv: 0, version: 2, reviewStatus: 'active' })
    // 冻结清单指向 v1（本轮实际执行的卷）
    await seedGateChain(db, {
      repoId: boot.repoId, taskId, groupStatus: 'passed',
      runs: [{ unit: 'smoke', side: 'web', status: 'passed', report: { checks: [
        { caseKey: `test:spec/${v1.fk}`, status: 'passed', durationMs: 300 },
      ] } }],
      mutationPayload: JSON.stringify({ featureKey: v1.fk, specId: v1.specId, specVersion: 1 }),
    })
    // 模拟完成侧回写（completeLease 变异分支同参数语义）
    await markMutationVerified(db, {
      repoId: boot.repoId, featureKey: v1.fk, caught: false,
      specId: v1.specId, specVersion: 1,
    })
    const rows = await db.prepare(
      `SELECT spec_id, version, mutation_verified FROM test_specs WHERE feature_key=? ORDER BY version`
    ).all(v1.fk)
    const r1 = rows.find((r) => r.version === 1)
    const r2 = rows.find((r) => r.version === 2)
    expect(r1.mutation_verified).toBe(0) // 废卷记在 v1 自己行上（caught=false → 0）
    expect(r2.mutation_verified).toBe(0) // 绝不误盖 v2（防 v2 假绿）
    // 抓到暗改的对照：caught=true 只盖 v1
    await markMutationVerified(db, {
      repoId: boot.repoId, featureKey: v1.fk, caught: true,
      specId: v1.specId, specVersion: 1,
    })
    const r1b = await db.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get(v1.specId)
    expect(r1b.mutation_verified).toBe(1)
  })
})

