/**
 * review-plugin.test.mjs — 审核插槽（可插拔审核者）
 *
 * 1. reviewSpec 档位行为：off/record/auto/human + 异常降级 + 非法档位回落（纯函数，无 db）
 * 2. v19 迁移：审核四列 + review_mode 存在（跑在真实 db.js 上，import 即触发）
 * 3. submitTestSpec 集成：record 档归因落库、审核人 transition 落库（真库 + 用后即清）
 * 4. 门禁不变量：activeSpecsForRepo 只认 active
 */
import { describe, expect, it, afterAll } from 'vitest'
import { reviewSpec, getReviewMode, REVIEWERS } from '../testing/reviewers.js'
import { submitTestSpec, transitionTestSpec, activeSpecsForRepo } from '../testing/test-specs.js'
import { ensureRepository } from '../testing/migrate.js'
import db from '../db.js'

const REPO = 'demo-app'
await ensureRepository(db, REPO, 'system')
const FK = 'review-plugin-test'
const GOOD_SPEC = `export default async function run({ page, baseURL, expect }) {
  await page.route('**/api/**/list*', async (route) => {
    await route.fulfill({ json: { code: 0, data: { list: [{ id: '1', name: '样例' }], total: 1 } } })
  })
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 200)
  await page.goto(\`\${baseURL}/app/review-plugin\`)
  await respPromise
  await expect(page.getByTestId('review-item').first()).toBeVisible()
  await expect(page.getByTestId('review-item').first()).toContainText('样例')
}`
const BAD_SPEC = `export default async function run({ page }) {
  await page.goto('/app/review-plugin')
}`

afterAll(async () => {
  await db.prepare('DELETE FROM test_specs WHERE feature_key=?').run(FK)
})

describe('审核插槽（档位与链，纯函数）', () => {
  it('档位 off：不审核，直接 active', () => {
    const v = reviewSpec({ spec: { content: BAD_SPEC, specType: 'e2e', side: null }, policy: {}, mode: 'off' })
    expect(v.reviewStatus).toBe('active')
    expect(v.by).toBe('auto:pass')
  })

  it('档位 record：契约不通过仍放行，但留下 rejected 记录', () => {
    const v = reviewSpec({
      spec: { content: BAD_SPEC, specType: 'e2e', side: null },
      policy: { enforceSpecContract: true },
      mode: 'record',
    })
    expect(v.reviewStatus).toBe('active')
    expect(v.decision).toBe('rejected')
    expect(v.notes.length).toBeGreaterThan(0)
  })

  it('档位 auto：契约不通过进 draft', () => {
    const v = reviewSpec({
      spec: { content: BAD_SPEC, specType: 'e2e', side: null },
      policy: { enforceSpecContract: true },
      mode: 'auto',
    })
    expect(v.reviewStatus).toBe('draft')
    expect(v.decision).toBe('rejected')
  })

  it('档位 human：挂起等人工（abstain → draft）', () => {
    const v = reviewSpec({
      spec: { content: GOOD_SPEC, specType: 'e2e', side: null },
      policy: { enforceSpecContract: true },
      mode: 'human',
    })
    expect(v.reviewStatus).toBe('draft')
    expect(v.decision).toBe('abstain')
  })

  it('审核者抛异常必须降级为放行（不阻塞提交）', () => {
    const orig = REVIEWERS['auto:contract'].review
    REVIEWERS['auto:contract'].review = () => { throw new Error('boom') }
    try {
      const v = reviewSpec({
        spec: { content: GOOD_SPEC, specType: 'e2e', side: null },
        policy: { enforceSpecContract: true },
        mode: 'auto',
      })
      expect(v.reviewStatus).toBe('active')
      expect(v.notes).toContain('boom')
    } finally {
      REVIEWERS['auto:contract'].review = orig
    }
  })

  it('非法档位回落 record（安全默认）', () => {
    expect(getReviewMode({ reviewMode: 'nonsense' })).toBe('record')
    expect(getReviewMode({})).toBe('record')
  })
})

describe('submitTestSpec 集成（record 档归因落库，真库 + 用后即清）', () => {
  it('提交后 review_* 四列落库，行为与改动前一致（active）', async () => {
    const spec = await submitTestSpec({
      repoId: REPO, featureKey: FK, author: 'ai-coding-agent', specType: 'e2e', side: 'web',
      content: GOOD_SPEC,
    })
    expect(spec.review_status).toBe('active')
    expect(spec.reviewed_by).toBe('auto:contract')
    expect(spec.review_decision).toBe('approved')
  })

  it('transition 落审核人（human:tester）', async () => {
    const t = await transitionTestSpec({
      repoId: REPO, featureKey: FK, version: 1,
      reviewStatus: 'reviewed', reviewer: 'human:tester', notes: 'LGTM',
    })
    expect(t.reviewed_by).toBe('human:tester')
    expect(t.review_notes).toBe('LGTM')
  })

  it('门禁不变量：reviewed 不注入 gate（activeSpecsForRepo 只认 active）', async () => {
    const rows = await activeSpecsForRepo(REPO)
    expect(rows.some((r) => r.feature_key === FK)).toBe(false)
  })
})
