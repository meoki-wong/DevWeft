/**
 * 测试工程引擎：契约 / 变异四态 / flaky / 影响面 / 动态门禁 / 质量指标
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import {
  validateContractFixture,
  scoreAssertionTriad,
  validateE2eAgainstContract,
  buildGuestContractPlan,
} from '../testing/contract-engine.js'
import {
  buildMutationPlan,
  applyMutation,
  classifyMutationOutcome,
  looksSyntacticallyValid,
  markForbiddenZones,
} from '../testing/mutation.js'
import { selectImpactedSpecs } from '../testing/impact-select.js'
import {
  resolveGatePolicy,
  previewGatePolicy,
  setPlatformSetting,
  matchRiskPath,
  upsertGateRiskRule,
} from '../harness/gate-policy.js'
import { setRepoGateMode } from '../harness/testing-gate.js'
import { errorSignature, quarantineSpec, listQuarantined, countsTowardGate, computeQualityScore } from '../testing/flaky.js'
import { qualityDashboard, registerEscape } from '../testing/quality-metrics.js'
import { GOLDEN_E2E_SPEC } from '../testing/spec-contract.js'

const SLUG = 'demo-app'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-eng-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', ?, 'project', 'refs/heads/stage', 't', 't')`
  ).run(SLUG)
  return db
}

describe('contract-engine', () => {
  it('校验合法 fixture', () => {
    const fx = {
      featureKey: 'flight-list',
      side: 'web',
      scenarios: ['empty', 'boundary', 'no-permission'],
      routes: [
        {
          id: 'ok',
          match: { method: 'GET', pathIncludes: '/api/list' },
          response: { status: 200, bodyShape: { code: 'number' } },
        },
      ],
    }
    const r = validateContractFixture(fx)
    expect(r.ok).toBe(true)
    expect(buildGuestContractPlan(fx).routes[0].id).toBe('ok')
  })

  it('拒绝缺 match 的 route', () => {
    const r = validateContractFixture({
      featureKey: 'x',
      side: 'web',
      routes: [{ id: 'a' }],
    })
    expect(r.ok).toBe(false)
  })

  it('三件套打分：golden 模板应 ≥2 类', () => {
    const t = scoreAssertionTriad(GOLDEN_E2E_SPEC)
    expect(t.network).toBe(true)
    expect(t.data || t.boundary || t.kinds.length >= 2).toBe(true)
    expect(t.ok).toBe(true)
  })

  it('浅考卷被硬拒', () => {
    const shallow = `export default async function run({ page, baseURL }) {
      await page.goto(\`\${baseURL}/app/x\`)
      await page.waitForSelector('[data-test="a"]', { timeout: 15000 })
    }`
    const r = validateE2eAgainstContract({ content: shallow, enforce: true })
    expect(r.ok).toBe(false)
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('mutation legality + four-state', () => {
  it('不在注释/字符串内选点', () => {
    const code = `// === keep\nconst s = '=== no'\nif (a === b) { return true }\n`
    const plan = buildMutationPlan(code, 'fk::path')
    expect(plan).not.toBeNull()
    expect(plan.index).toBeGreaterThan(code.indexOf('if (a'))
    const mutated = applyMutation(code, plan)
    expect(mutated).not.toContain('// !== keep')
    expect(looksSyntacticallyValid(mutated)).toBe(true)
  })

  it('markForbiddenZones 覆盖行注释', () => {
    const zones = new Set(markForbiddenZones('// ===\ntrue'))
    expect(zones.has(0)).toBe(true)
  })

  it('四态分类', () => {
    expect(classifyMutationOutcome({ built: false, covered: true, killed: true })).toBe('invalid')
    expect(classifyMutationOutcome({ built: true, covered: false, killed: false })).toBe('not_covered')
    expect(classifyMutationOutcome({ built: true, covered: true, killed: true })).toBe('killed')
    expect(classifyMutationOutcome({ built: true, covered: true, killed: false })).toBe('survived')
  })
})

describe('impact-select', () => {
  it('主干路径 → full', () => {
    const r = selectImpactedSpecs({ workspaceDir: null, changedFiles: ['src/main.ts'], allSpecs: ['a.test.ts'] })
    expect(r.mode).toBe('full')
    expect(r.reason).toContain('trunk')
  })

  it('空集 → 回退 full', () => {
    const r = selectImpactedSpecs({
      workspaceDir: null,
      changedFiles: ['src/utils/zzz-unique-xyz.ts'],
      allSpecs: ['tests/foo.test.ts'],
    })
    expect(r.mode).toBe('full')
  })

  it('无改动 → full', () => {
    const r = selectImpactedSpecs({ workspaceDir: null, changedFiles: [], allSpecs: ['x.test.ts'] })
    expect(r.mode).toBe('full')
  })
})

describe('gate-policy escalate-only', () => {
  it('动态关闭时与仓档一致', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'observe')
    const p = await resolveGatePolicy(db, { repoSlug: SLUG, size: 'M' })
    expect(p.enabled).toBe(false)
    expect(p.effectiveMode).toBe('observe')
  })

  it('risk-path 抬升到 enforce', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'observe')
    await setPlatformSetting(db, 'dynamic_gate', { enabled: true })
    await upsertGateRiskRule(db, { repoId: 'r1', pattern: 'src/App.vue', effect: 'enforce' })
    const p = await resolveGatePolicy(db, {
      repoSlug: SLUG,
      size: 'M',
      changedFiles: ['src/App.vue'],
    })
    expect(p.decision).toBe('enforce')
    expect(p.factors.some((f) => f.key === 'risk-path')).toBe(true)
    expect(p.policyHash).toBeTruthy()
  })

  it('large-diff 抬升', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'observe')
    await setPlatformSetting(db, 'dynamic_gate', { enabled: true })
    await setPlatformSetting(db, 'large_diff_threshold', 3)
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts']
    const p = await resolveGatePolicy(db, { repoSlug: SLUG, size: 'M', changedFiles: files })
    expect(p.factors.some((f) => f.key === 'large-diff')).toBe(true)
    expect(p.decision).toBe('enforce')
  })

  it('preview 不落库', async () => {
    const db = await memdb()
    await setRepoGateMode(db, SLUG, 'observe')
    await setPlatformSetting(db, 'dynamic_gate', { enabled: true })
    await upsertGateRiskRule(db, { pattern: 'x/**', effect: 'enforce' })
    await previewGatePolicy(db, { repoSlug: SLUG, changedFiles: ['x/a.ts'] })
    const n = (await db.prepare('SELECT COUNT(*) c FROM gate_policy_decisions').get()).c
    expect(n).toBe(0)
  })

  it('matchRiskPath glob', () => {
    expect(matchRiskPath('src/httpApi/a.ts', 'src/httpApi/**')).toBe(true)
    expect(matchRiskPath('src/other/a.ts', 'src/httpApi/**')).toBe(false)
    expect(matchRiskPath('vite.config.ts', 'vite.config.*')).toBe(true)
  })
})

describe('flaky + quality', () => {
  it('错误签名归一化', () => {
    const a = errorSignature('c1', 'timeout 3000ms at deadbeef')
    const b = errorSignature('c1', 'timeout 5000ms at cafebabe')
    expect(a).toBe(b)
  })

  it('quarantine 后不计门禁', async () => {
    const db = await memdb()
    await db.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, author, entry, blob_sha256, review_status, created_at, updated_at)
       VALUES ('s1', 'r1', 'fk1', 'tester', 'fk1.spec.mjs', 'ab', 'active', 't', 't')`
    ).run()
    await quarantineSpec(db, { repoId: 'r1', featureKey: 'fk1', reason: 'test' })
    const row = await db.prepare('SELECT quarantined_at, review_status FROM test_specs WHERE feature_key=?').get('fk1')
    expect(row.quarantined_at).toBeTruthy()
    expect(countsTowardGate(row)).toBe(false)
    expect((await listQuarantined(db)).length).toBe(1)
  })

  it('quality score 与 escape 增强单', async () => {
    expect(computeQualityScore({ flakeSuspectCount: 0 })).toBe(100)
    expect(computeQualityScore({ flakeSuspectCount: 2, quarantined: true })).toBeLessThan(80)
    const db = await memdb()
    const out = await registerEscape(db, { repoId: 'r1', symptom: '线上白屏', gapType: 'missing_spec' })
    expect(out.escapeId).toBeTruthy()
    expect(out.enhancementId).toBeTruthy()
    const dash = await qualityDashboard(db, { repoSlug: SLUG, repoId: 'r1' })
    expect(dash.escapes.length).toBe(1)
    expect(dash.enhancements.length).toBe(1)
  })
})
