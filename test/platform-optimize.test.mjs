/**
 * platform-optimize 批次1/3 服务端单测（2026-09-26）：
 * 1. mutationFourStateStats 四态文本归类（修复 detail_json 死指标）
 * 2. AI 审卷员信号与判定（reviewers-ai）
 * 3. reviewSpec ai 档位端到端（链上首版放行）
 * 4. contextPack 经验注入 + buildPacketWithDb product 失败经验推送（经验复用闭环 v1）
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { memdb } from './helpers/memdb.mjs'
import { mutationFourStateStats } from '../testing/quality-metrics.js'
import { aiReviewSignals, aiReviewDecide, aiShadowVerdict } from '../testing/reviewers-ai.js'
import { REVIEWERS, reviewSpec } from '../testing/reviewers.js'
import '../testing/reviewers-ai.js'
import { buildContextPack } from '../harness/context.js'
import { buildPacketWithDb } from '../harness/loop.js'

async function seedSpecRow(db, repoId, featureKey, { lastResult = null, failStreak = 0 } = {}) {
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, last_result, fail_streak,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', 'e2e', ?, ?, 1, 'active', 0, ?, ?, ?, ?)`
  ).run(randomUUID(), repoId, featureKey, featureKey, `${featureKey}.spec.mjs`, 'a'.repeat(64),
    lastResult, failStreak, new Date().toISOString(), new Date().toISOString())
}

async function seedF2pRows(db, repoId, featureKey) {
  const rows = [
    ['mutation killed @src/a.js:3 x->y', 'failed', 'passed', 'ok', 'killed'],
    ['mutation survived @src/b.js:5 p->q', 'passed', 'passed', 'always_pass', 'survived'],
    ['mutation not-covered (no-operator) — 改动行无可翻算子，豁免', 'skipped', 'passed', 'skipped', 'not_covered'],
    ['mutation survived-cap-exempt @src/c.js:1 f->r — 疑似等价变异，豁免留痕', 'skipped', 'passed', 'skipped', 'not_covered'],
    ['mutation run error without spec verdict (build/infra) — not a paper verdict', 'skipped', 'passed', 'skipped', 'invalid'],
  ]
  for (const [detail, baselineResult, snapshotResult, f2pStatus, expectState] of rows) {
    await db.prepare(
      `INSERT INTO spec_f2p_results(result_id, run_id, repo_id, feature_key, version,
         baseline_oid, snapshot_oid, baseline_result, snapshot_result, f2p_status, detail, created_at)
       VALUES (?, ?, ?, ?, 1, 'h1', 's1', ?, ?, ?, ?, ?)`
    ).run(randomUUID(), `run-${randomUUID()}`, repoId, featureKey, baselineResult, snapshotResult, f2pStatus, detail, new Date().toISOString())
  }
  return rows.map((r) => r[4])
}

describe('mutationFourStateStats 文本归类（修复 detail_json 死指标）', () => {
  it('四态按 detail 文本归类且 mutationScore=killed/(killed+survived)', async () => {
    const { db, repoId, close } = await memdb()
    await seedSpecRow(db, repoId, 'fk-stat')
    const expectStates = await seedF2pRows(db, repoId, 'fk-stat')
    const stats = await mutationFourStateStats(db, { repoId })
    expect(stats.killed).toBe(1)
    expect(stats.survived).toBe(1)
    expect(stats.not_covered).toBe(2)
    expect(stats.invalid).toBe(1)
    expect(stats.unknown).toBe(0)
    expect(stats.mutationScore).toBe(50)
    expect(stats.legalMutants).toBe(2)
    expect(expectStates).toHaveLength(5)
    close()
  })

  it('无记录时返回空账本而非报错（旧行为是恒 0 的死指标）', async () => {
    const { db, close } = await memdb()
    const stats = await mutationFourStateStats(db, {})
    expect(stats.killed).toBe(0)
    expect(stats.mutationScore).toBeNull()
    close()
  })
})

describe('AI 审卷员 v1（规则打分）', () => {
  it('信号读取：fail_streak/last_result 显式注入', async () => {
    const { db, repoId, close } = await memdb()
    await seedSpecRow(db, repoId, 'fk-ai1', { lastResult: 'passed', failStreak: 0 })
    const s = await aiReviewSignals(db, { repoId, featureKey: 'fk-ai1' })
    expect(s.exists).toBe(true)
    expect(s.failStreak).toBe(0)
    expect(s.lastResult).toBe('passed')
    close()
  })

  it('判定矩阵：首版放行 / 干净放行 / 上轮失败转人工 / 连败转人工', () => {
    expect(aiReviewDecide({ exists: false }).decision).toBe('approved')
    expect(aiReviewDecide({ exists: true, lastResult: 'passed', failStreak: 0 }).decision).toBe('approved')
    expect(aiReviewDecide({ exists: true, lastResult: 'failed', failStreak: 1 }).decision).toBe('abstain')
    expect(aiReviewDecide({ exists: true, lastResult: 'passed', failStreak: 3 }).decision).toBe('abstain')
  })

  it('ai 档位审核链端到端：契约弃权 → ai 放行 → active', () => {
    expect(REVIEWERS.ai).toBeTruthy()
    const verdict = reviewSpec({
      spec: { repoId: 'r', featureKey: 'fk-chain', specType: 'e2e', side: 'web', content: 'run({page,baseURL})' },
      policy: { enforceSpecContract: false },
      mode: 'ai',
    })
    expect(verdict.decision).toBe('approved')
    expect(verdict.by).toBe('ai')
    expect(verdict.reviewStatus).toBe('active')
  })

  it('影子模式：任何异常降级 abstain，不阻塞提交', async () => {
    const shadow = await aiShadowVerdict({ spec: { repoId: null, featureKey: null } })
    expect(['approved', 'abstain']).toContain(shadow.decision)
  })
})

describe('经验复用闭环 v1', () => {
  it('contextPack 注入历史经验（推送优于拉取）', () => {
    const pack = buildContextPack('execute', {
      relatedExperiences: [{ id: 'exp-1', category: 'dev', excerpt: '签到弹窗 z-index 问题曾踩坑' }],
    })
    expect(pack.relatedExperiences).toHaveLength(1)
    expect(pack.instructions).toContain('历史相关经验')
    expect(pack.instructions).toContain('签到弹窗')

    const empty = buildContextPack('execute', {})
    expect(empty.relatedExperiences).toEqual([])
    expect(empty.instructions).not.toContain('历史相关经验')
  })

  it('product/mixed 失败按改动文件推送历史修复经验', async () => {
    const { db, close } = await memdb()
    // memdb 的 experiences 是 v8 控制面形态（无 id 列）；生产库是 db.js 协作层形态——
    // buildPacketWithDb 查询的是协作层口径，测试按生产形态重建
    await db.exec('DROP TABLE IF EXISTS experiences')
    await db.exec(`CREATE TABLE experiences (
      id TEXT PRIMARY KEY, repo TEXT, content TEXT NOT NULL, source TEXT, status TEXT,
      category TEXT, author TEXT, module TEXT, task_id TEXT, rule_ref TEXT, tags TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    await db.prepare(
      `INSERT INTO experiences(id, repo, content, source, status, category, author, created_at, updated_at)
       VALUES ('exp-sign', 'r', 'sign/index.vue 的 v-if 曾因 native bridge 未 ready 永假：先判 native bridge 再渲染', 'manual', 'reviewed', 'dev', 'alice', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString())

    const packet = await buildPacketWithDb(db, {
      repo: 'r', taskId: 'T-1', status: 'BLOCKED',
      loop: { state: 'remediation_product', iteration: 1, maxIterations: 5 },
      classification: {
        overall: 'product',
        byCheck: [{ caseKey: 'test:static/eslint', class: 'product', files: ['src/pages/sign/index.vue'], detail: 'eslint fail' }],
      },
      message: 'product 失败',
    })
    expect(Array.isArray(packet.relatedExperiences)).toBe(true)
    expect(packet.relatedExperiences[0]?.id).toBe('exp-sign')
    expect(packet.relatedExperiences[0]?.matchedFile).toBe('src/pages/sign/index.vue')
    close()
  })

  it('suite 失败沿用 featureKey 推送路径（行为不回归）', async () => {
    const { db, close } = await memdb()
    await db.exec('DROP TABLE IF EXISTS experiences')
    await db.exec(`CREATE TABLE experiences (
      id TEXT PRIMARY KEY, repo TEXT, content TEXT NOT NULL, source TEXT, status TEXT,
      category TEXT, author TEXT, module TEXT, task_id TEXT, rule_ref TEXT, tags TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    await db.prepare(
      `INSERT INTO experiences(id, repo, content, source, status, category, author, created_at, updated_at)
       VALUES ('exp-suite', 'r', 'test:spec/coupon-flow 选择器曾因改版失效：优先 data-test', 'auto', 'reviewed', 'test', 'test-platform', ?, ?)`
    ).run(new Date().toISOString(), new Date().toISOString())

    const packet = await buildPacketWithDb(db, {
      repo: 'r', taskId: 'T-2', status: 'BLOCKED',
      loop: { state: 'remediation_suite', iteration: 1, maxIterations: 5 },
      classification: { overall: 'suite', byCheck: [{ caseKey: 'test:spec/coupon-flow', featureKey: 'coupon-flow', class: 'suite' }] },
      message: 'suite 失败',
    })
    expect(packet.relatedExperiences?.[0]?.id).toBe('exp-suite')
    close()
  })
})
