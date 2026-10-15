/**
 * f2p-mutation.test.mjs — 批次三补充：F2P 状态推导 + 断言强度棘轮
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it, afterAll } from 'vitest'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { recordSpecF2p, computeF2pStatus } from '../testing/f2p.js'
import { scoreAssertionStrength } from '../harness/testing-gate.js'
import { submitTestSpec } from '../testing/test-specs.js'
import db from '../db.js'

const REPO = 'demo-app'
await ensureRepository(db, REPO, 'system')

describe('computeF2pStatus（五态判定）', () => {
  it('baseline红+snapshot绿 → ok（有效考卷）', () => {
    expect(computeF2pStatus('failed', 'passed')).toBe('ok')
  })
  it('两轮都绿 → always_pass（走过场）', () => {
    expect(computeF2pStatus('passed', 'passed')).toBe('always_pass')
  })
  it('两轮都红 → always_fail（考卷问题）', () => {
    expect(computeF2pStatus('failed', 'failed')).toBe('always_fail')
  })
  it('baseline绿+snapshot红 → regressed（测坏了）', () => {
    expect(computeF2pStatus('passed', 'failed')).toBe('regressed')
  })
  it('任一 skipped → skipped（不判定）', () => {
    expect(computeF2pStatus('skipped', 'passed')).toBe('skipped')
    expect(computeF2pStatus('failed', 'skipped')).toBe('skipped')
  })
})

describe('recordSpecF2p（落库）', () => {
  it('落库后可查', async () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'f2p-t-')), 't.db')
    const raw = new Database(tmp)
    await runTestingMigrations(raw, { skipLegacyMap: true })
    await raw.prepare(`INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
      VALUES ('r1', 'test', 't', 'refs/heads/stage', 't', 't')`).run()
    const r = await recordSpecF2p(raw, {
      runId: 'run-1', repoId: 'r1', featureKey: 'fk', version: 1,
      baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'failed', snapshotResult: 'passed',
    })
    expect(r.f2pStatus).toBe('ok')
    expect((await raw.prepare('SELECT COUNT(*) c FROM spec_f2p_results').get()).c).toBe(1)
    raw.close()
  })
})

describe('scoreAssertionStrength（断言强度评分）', () => {
  it('空内容 → 0', () => {
    expect(scoreAssertionStrength('')).toBe(0)
  })
  it('只查元素存在 → 1 分（弱）', () => {
    expect(scoreAssertionStrength('await page.waitForSelector(".foo")')).toBe(1)
  })
  it('data-test + 接口断言 + 数据比较 → 高分', () => {
    const strong = 'await page.waitForSelector("[data-test=list]"); page.route("**/api/**", f=>f.fulfill()); expect(x).toBe(1); Empty'
    expect(scoreAssertionStrength(strong)).toBeGreaterThanOrEqual(5)
  })
})

describe('submitTestSpec 断言棘轮（真库）', () => {
  const FK = 'assertion-ratchet-strong'
  const FK2 = 'assertion-ratchet-upgrade'
  afterAll(async () => {
    await db.prepare('DELETE FROM test_specs WHERE author=?').run('ratchet-test')
  })

  it('高版本 → 低版本被拒（SPEC_STRENGTH_REGRESSION）', async () => {
    const strong = `export default async function run({ page, baseURL, expect }) {
      await page.route('**/api/**/list*', r => r.fulfill({ json: { code: 0, data: { list: [{ id: '1', name: 'x' }] } } }))
      await page.goto(\`\${baseURL}/app/ratchet\`)
      await expect(page.getByTestId('list').first()).toBeVisible()
      await expect(page.getByTestId('list').first()).toContainText('x')
      await expect(page.getByTestId('empty').first()).toBeVisible()
      await expect(page.getByTestId('total')).toHaveText('1')
    }`
    const weak = `export default async function run({ page, baseURL, expect }) {
      await page.route('**/api/**/list*', r => r.fulfill({ json: { code: 0, data: { list: [] } } }))
      await page.goto(\`\${baseURL}/app/ratchet\`)
      await expect(page.getByTestId('list').first()).toBeVisible()
    }`
    await submitTestSpec({ repoId: REPO, featureKey: FK, author: 'ratchet-test', specType: 'e2e', side: 'web', content: strong })
    await expect(submitTestSpec({ repoId: REPO, featureKey: FK, author: 'ratchet-test', specType: 'e2e', side: 'web', content: weak }))
      .rejects.toThrow(/SPEC_STRENGTH_REGRESSION|INVALID_SPEC_CONTRACT/)
  })

  it('独立 key：等版本 → 放行；升级 → 放行', async () => {
    const base = `export default async function run({ page, baseURL, expect }) {
      await page.route('**/api/**/list*', r => r.fulfill({ json: { code: 0, data: { list: [] } } }))
      await page.goto(\`\${baseURL}/app/ratchet\`)
      await expect(page.getByTestId('list').first()).toBeVisible()
    }`
    const better = `export default async function run({ page, baseURL, expect }) {
      await page.route('**/api/**/list*', r => r.fulfill({ json: { code: 0, data: { list: [] } } }))
      await page.goto(\`\${baseURL}/app/ratchet\`)
      await expect(page.getByTestId('list').first()).toBeVisible()
      await expect(page.getByTestId('list').first()).toContainText('ok')
    }`
    const r1 = await submitTestSpec({ repoId: REPO, featureKey: FK2, author: 'ratchet-test', specType: 'e2e', side: 'web', content: base })
    expect(r1.review_status).toBe('active')
    const r2 = await submitTestSpec({ repoId: REPO, featureKey: FK2, author: 'ratchet-test', specType: 'e2e', side: 'web', content: better })
    expect(r2.review_status).toBe('active')
  })
})
