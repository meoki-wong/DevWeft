/**
 * 变异验卷重派修复（2026-09-27，historical production 死锁根因）：
 *  - survived（run passed 但 f2p_status='always_pass' 且未豁免）不得阻止重新派卷——
 *    否则 R6 收敛路径（增强断言→升版本→换暗题落点重跑）被永久堵死；
 *  - 在飞变异卷仍阻止重复排队；killed / not-covered / cap-exempt（验证完成）仍阻止重跑；
 *  - MUTATION_UNVERIFIED 指引细分：有 survived 历史 → 引导增强断言升版本（不说"提升 size"）。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { seedGateChain } from './helpers/submission-chain.mjs'
import { ensureMutationRuns } from '../testing/leases.js'
import { mutationUnverifiedGuidance } from '../harness/state-machine.js'

const slug = `mr-${randomUUID().slice(0, 8)}`
const slug2 = `mr2-${randomUUID().slice(0, 8)}`
let repoId = null
let repoId2 = null

beforeAll(async () => {
  const boot = await bootstrapTestingPlatform(db, { slug, remoteUrl: `https://git.test/${slug}.git` })
  repoId = boot.repoId
  const boot2 = await bootstrapTestingPlatform(db, { slug: slug2, remoteUrl: `https://git.test/${slug2}.git` })
  repoId2 = boot2.principalId ? boot2.repoId : boot.repoId
})

async function seedSpec(featureKey) {
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, demand_ref, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, last_result, created_at, updated_at, scope)
     VALUES (?, ?, ?, ?, ?, 'test', 'e2e', ?, ?, 1, 'active', 0, 'passed', ?, ?, 'task')`
  ).run(randomUUID(), repoId, featureKey, featureKey, `T-mr-${featureKey}`, `${featureKey}.spec.mjs`, 'a'.repeat(64),
    new Date().toISOString(), new Date().toISOString())
}

/** 建一条「formal 全绿 + 报告含 test:spec/<fk>」的链路，返回 source run。
 *  taskId 与 seedSpec.demand_ref 对齐为 `T-mr-<fk>`，assetLock 冻结该卷，
 *  供 mutationUnverifiedGuidance 的 isSpecOnActiveBindingPath 求交。 */
async function seedGreenChain(featureKey) {
  const taskId = `T-mr-${featureKey}`
  const chain = await seedGateChain(db, {
    repoId, taskId,
    specs: [{ featureKey }],
    groupStatus: 'passed',
    runs: [{ unit: 'smoke', side: 'web', status: 'passed', report: { checks: [{ caseKey: `test:spec/${featureKey}`, status: 'passed' }] } }],
  })
  await seedSpec(featureKey)
  return chain
}

/** 在链路的 binding 上种一条历史变异卷（可选 f2p 判卷行） */
async function seedPriorMutationRun(chain, featureKey, { status = 'passed', f2p = null } = {}) {
  const runId = randomUUID()
  await db.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
       unit, side, purpose, status, desired_state, max_attempts, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, 'smoke', 'web', 'mutation', ?, 'running', 2, ?, ?)`
  ).run(runId, chain.groupId, chain.bindingId, repoId, chain.ti, status,
    JSON.stringify({ featureKey, specVersion: 1 }), new Date().toISOString())
  if (f2p) {
    await db.prepare(
      `INSERT INTO spec_f2p_results(result_id, run_id, repo_id, feature_key, version,
         baseline_oid, snapshot_oid, baseline_result, snapshot_result, f2p_status, detail, created_at)
       VALUES (?, ?, ?, ?, 1, 'h1', 's1', ?, 'passed', ?, ?, ?)`
    ).run(randomUUID(), runId, repoId, featureKey, f2p.baseline, f2p.status, f2p.detail, new Date().toISOString())
  }
  return runId
}

const SURVIVED = { baseline: 'passed', status: 'always_pass', detail: 'mutation survived @src/httpApi/catalogMock.js:88 &&->||' }
const CAP_EXEMPT = { baseline: 'skipped', status: 'skipped', detail: 'mutation survived-cap-exempt @src/x.js:1 a->b — 疑似等价变异，豁免留痕' }
const NOT_COVERED = { baseline: 'skipped', status: 'skipped', detail: 'mutation not-covered (no-operator) — 豁免' }
const KILLED = { baseline: 'failed', status: 'ok', detail: 'mutation killed @src/x.js:3 a->b' }

function createdKeys(out) {
  return Promise.all(out.map(async (runId) => {
    const row = await db.prepare('SELECT payload_json FROM test_runs WHERE run_id=?').get(runId)
    return JSON.parse(row.payload_json || '{}').featureKey
  }))
}

describe('ensureMutationRuns 去重语义修复（survived 不挡重派）', () => {
  it('历史 survived 的卷：同一 binding 再次全绿 → 重新派卷（修复点）', async () => {
    const chain = await seedGreenChain('fk-survived')
    await seedPriorMutationRun(chain, 'fk-survived', { status: 'passed', f2p: SURVIVED })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).toContain('fk-survived')
  })

  it('无历史变异卷的卷：正常派卷（基线不回归）', async () => {
    const chain = await seedGreenChain('fk-fresh')
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).toContain('fk-fresh')
  })

  it('在飞变异卷（active）仍阻止重复排队', async () => {
    const chain = await seedGreenChain('fk-inflight')
    await seedPriorMutationRun(chain, 'fk-inflight', { status: 'active' })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).not.toContain('fk-inflight')
  })

  it('killed（验证完成）仍阻止重跑', async () => {
    const chain = await seedGreenChain('fk-killed')
    await seedPriorMutationRun(chain, 'fk-killed', { status: 'passed', f2p: KILLED })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).not.toContain('fk-killed')
  })

  it('not-covered 豁免（验证完成）仍阻止重跑', async () => {
    const chain = await seedGreenChain('fk-notcovered')
    await seedPriorMutationRun(chain, 'fk-notcovered', { status: 'passed', f2p: NOT_COVERED })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).not.toContain('fk-notcovered')
  })

  it('survived-cap 豁免（验证完成）仍阻止重跑', async () => {
    const chain = await seedGreenChain('fk-capexempt')
    await seedPriorMutationRun(chain, 'fk-capexempt', { status: 'passed', f2p: CAP_EXEMPT })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).not.toContain('fk-capexempt')
  })

  it('不同 featureKey 的历史变异卷不影响本卷派卷', async () => {
    const chain = await seedGreenChain('fk-target')
    await seedPriorMutationRun(chain, 'fk-unrelated', { status: 'passed', f2p: SURVIVED })
    const out = await ensureMutationRuns(db, chain.runIds[0])
    expect(await createdKeys(out)).toContain('fk-target')
  })
})

describe('MUTATION_UNVERIFIED 指引细分', () => {
  it('有 survived 历史 → 引导增强断言升版本，绝不提"提升 size"', async () => {
    const g = await mutationUnverifiedGuidance(db, { repo: slug, taskId: 'T-mr-fk-survived', size: 'M' })
    const text = g.join('\n')
    expect(text).toContain('survived')
    expect(text).toContain('增强断言')
    expect(text).toContain('新版本')
    expect(text).not.toContain('提升 size')
  })

  it('不在 assetLock 的 active 卷不进指引（B2：防别人的卷串进本任务）', async () => {
    // 本任务 assetLock 只冻结 fk-in-lock；fk-out-of-lock 虽 active 且有 always_pass，本轮没跑
    const chain = await seedGreenChain('fk-in-lock')
    await seedPriorMutationRun(chain, 'fk-in-lock', { status: 'passed', f2p: SURVIVED })
    await seedSpec('fk-out-of-lock')
    const runId = randomUUID()
    const now = new Date().toISOString()
    // 直接挂一条历史 always_pass（模拟别的任务/旧轮的弱卷）
    await db.prepare(
      `INSERT INTO spec_f2p_results(result_id, run_id, repo_id, feature_key, version,
         baseline_oid, snapshot_oid, baseline_result, snapshot_result, f2p_status, detail, created_at)
       VALUES (?, ?, ?, ?, 1, 'h1', 's1', 'passed', 'passed', 'always_pass', ?, ?)`
    ).run(randomUUID(), runId, repoId, 'fk-out-of-lock', 'mutation survived @src/other/x.js:1 &&->||', now)
    const g = await mutationUnverifiedGuidance(db, { repo: slug, taskId: 'T-mr-fk-in-lock', size: 'M' })
    const text = g.join('\n')
    expect(text).toContain('fk-in-lock')
    expect(text).not.toContain('fk-out-of-lock')
    expect(text).not.toContain('提升 size')
  })

  it('无调度历史 + size=S → 维持"提升 size"指引', async () => {
    const g = await mutationUnverifiedGuidance(db, { repo: slug2, taskId: 'T-none', size: 'S' })
    expect(g.join('\n')).toContain('把任务 size 提升为 M/L')
  })

  it('无调度历史 + size=M → 引导核查 requiredUnits/side，不说"提升 size"', async () => {
    const g = await mutationUnverifiedGuidance(db, { repo: slug2, taskId: 'T-none', size: 'M' })
    const text = g.join('\n')
    expect(text).toContain('requiredUnits')
    expect(text).not.toContain('提升 size')
  })
})
