/**
 * ac-coverage.test.mjs — 批次二：AC 考点体系
 *
 * 1. validateAcceptance 结构校验（纯函数）
 * 2. checkAcDiscipline AC 纪律（纯函数）：AC_REQUIRED / AC_FROZEN / AC_INVALID / 豁免
 * 3. evaluateAcCoverage + submitTestSpec：绑定 db.js（真实库），独特 id + 用后即清
 */
import { describe, expect, it, afterAll } from 'vitest'
import db from '../db.js'
import { runHarnessMigrations } from '../harness/migrate.js'
import { ensureRepository } from '../testing/migrate.js'
import { submitTestSpec } from '../testing/test-specs.js'
import { checkAcDiscipline, evaluateAcCoverage, validateAcceptance } from '../harness/testing-gate.js'

runHarnessMigrations()
await ensureRepository(db, 'demo-app', 'system')

const REPO = 'demo-app'
const TASK_ID = 'T-AC-TEST-1'
const FK_COVER = 'ac-coverage-test-page'
const FK_ORPHAN = 'ac-coverage-orphan'
const AC_REAL = [
  { id: 'AC-901', text: '列表接口分页参数 page=1&limit=20 正确', type: 'contract' },
  { id: 'AC-902', text: '空数据显示空态组件', type: 'ui' },
]
const SPEC_CONTENT = [
  'export default async function run({ page, baseURL, expect }) {',
  "  await page.route('**/api/**/list*', async (route) => {",
  '    await route.fulfill({ json: { code: 0, data: { list: [{ id: "1", name: "样例" }], total: 1 } } })',
  '  })',
  '  const respPromise = page.waitForResponse((r) => r.url().includes("/api/") && r.status() === 200)',
  '  await page.goto(`${baseURL}/app/x`)',
  '  await respPromise',
  "  await expect(page.getByTestId('list-item').first()).toBeVisible()",
  '}',
].join('\n')

afterAll(async () => {
  await db.prepare('DELETE FROM test_specs WHERE feature_key IN (?, ?) AND author=?').run(FK_COVER, FK_ORPHAN, 'ai')
  await db.prepare('DELETE FROM tasks WHERE repo=? AND task_id=?').run(REPO, TASK_ID)
})

describe('validateAcceptance（结构校验，纯函数）', () => {
  it('合法清单 → null', () => {
    expect(validateAcceptance(AC_REAL)).toBeNull()
  })
  it('空/坏 id/重复/空话 text/坏 type 全部拦下', () => {
    expect(validateAcceptance([])).toMatch(/1~20/)
    expect(validateAcceptance([{ id: 'AC-901', text: 'xxxx', type: 'ui' }, { id: 'AC-901', text: 'yyyy', type: 'ui' }])).toMatch(/重复/)
    expect(validateAcceptance([{ id: 'ac-1', text: 'xxxx', type: 'ui' }])).toMatch(/AC-1/)
    expect(validateAcceptance([{ id: 'AC-901', text: 'ok', type: 'ui' }])).toMatch(/可验证断言/)
    expect(validateAcceptance([{ id: 'AC-901', text: 'xxxx', type: 'performance' }])).toMatch(/type/)
  })
})

describe('checkAcDiscipline（AC 纪律纯函数）', () => {
  it('M/L 离开 PLAN 无 AC → AC_REQUIRED', () => {
    const r = checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'M', mode: 'enforce_all' })
    expect(r.code).toBe('AC_REQUIRED')
  })
  it('带合法 AC → 放行；S 级豁免；legacy 仓豁免；enforce_ml 同样强制', () => {
    expect(checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'M', mode: 'enforce_all', acceptanceInput: AC_REAL })).toBeNull()
    expect(checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'S', mode: 'enforce_all' })).toBeNull()
    expect(checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'M', mode: 'legacy' })).toBeNull()
    expect(checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'L', mode: 'enforce_ml', acceptanceInput: AC_REAL })).toBeNull()
  })
  it('第一次产品快照之后改 AC → AC_FROZEN；提交相同 AC → 放行', () => {
    const changed = { phase: 'EXECUTE', to: 'VERIFY', size: 'M', mode: 'enforce_all', metaAcceptance: AC_REAL, acceptanceInput: [{ id: 'AC-901', text: '赛后改弱断言试试', type: 'ui' }], snapshotFrozen: true }
    const r = checkAcDiscipline(changed)
    expect(r.code).toBe('AC_FROZEN')
    expect(checkAcDiscipline({ phase: 'EXECUTE', to: 'VERIFY', size: 'M', mode: 'enforce_all', metaAcceptance: AC_REAL, acceptanceInput: AC_REAL, snapshotFrozen: true })).toBeNull()
    expect(checkAcDiscipline({ phase: 'EXECUTE', to: 'VERIFY', size: 'M', mode: 'enforce_all', metaAcceptance: AC_REAL, acceptanceInput: [{ id: 'AC-901', text: '赛后改弱断言试试', type: 'ui' }] })).toBeNull()
  })
  it('结构不合法 → AC_INVALID', () => {
    const r = checkAcDiscipline({ phase: 'PLAN', to: 'EXECUTE', size: 'M', mode: 'enforce_all', acceptanceInput: [{ id: 'bad', text: 'xxxx', type: 'ui' }] })
    expect(r.code).toBe('AC_INVALID')
  })
})

describe('evaluateAcCoverage + submitTestSpec（真实库，用后即清）', () => {
  it('无 AC 清单 → 不适用', async () => {
    await db.prepare(
      `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
       VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'UI_DEV', 'M', 'EXECUTE', '["p"]', '{}', 'alice', 't', 't')`
    ).run(REPO, REPO, TASK_ID)
    expect((await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK_ID })).applicable).toBe(false)
  })

  it('active 考卷 refs 覆盖判定：缺哪条指哪条', async () => {
    await db.prepare(
      `UPDATE tasks SET meta = ? WHERE repo=? AND task_id=?`
    ).run(JSON.stringify({ acceptance: AC_REAL }), REPO, TASK_ID)
    await submitTestSpec({
      repoId: REPO, featureKey: FK_COVER, author: 'ai', specType: 'e2e', side: 'web',
      content: SPEC_CONTENT, pages: ['views/catalog'], acceptanceRefs: ['AC-901'],
    })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK_ID })
    expect(r.applicable).toBe(true)
    expect(r.missing).toEqual(['AC-902'])
    expect(r.covered).toContain('AC-901')
  })

  it('pages 与 acceptanceRefs 落库', async () => {
    const row = await db.prepare('SELECT pages_json, acceptance_refs_json FROM test_specs WHERE feature_key=?').get(FK_COVER)
    expect(JSON.parse(row.pages_json)).toEqual(['views/catalog'])
    expect(JSON.parse(row.acceptance_refs_json)).toEqual(['AC-901'])
  })

  it('orphan-candidate 的 featureKey 拒绝提交（SPEC_ORPHANED）', async () => {
    await submitTestSpec({
      repoId: REPO, featureKey: FK_ORPHAN, author: 'ai', specType: 'e2e', side: 'web',
      content: SPEC_CONTENT,
    })
    await db.prepare(`UPDATE test_specs SET review_status='orphan-candidate' WHERE feature_key=?`).run(FK_ORPHAN)
    await expect(submitTestSpec({
        repoId: REPO, featureKey: FK_ORPHAN, author: 'ai', specType: 'e2e', side: 'web',
        content: SPEC_CONTENT,
      })).rejects.toThrow(/SPEC_ORPHANED/)
  })
})
