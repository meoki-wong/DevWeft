/**
 * E2E 平台契约：submit 校验 + golden
 */
import { describe, expect, it } from 'vitest'
import {
  validateE2eSpecContent,
  preflightE2eSpec,
  buildContractReport,
  GOLDEN_E2E_SPEC,
  SPEC_PLATFORM_RULES,
} from '../testing/spec-contract.js'

const GOOD = `
export default async function run({ page, baseURL, expect }) {
  await page.route('**/api/**/list*', async (route) => {
    await route.fulfill({ json: { code: 0, data: { list: [{ id: '1', name: '样例' }], total: 1 } } })
  })
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 200)
  await page.goto(\`\${baseURL}/app/catalog\`)
  await page.waitForSelector('[data-test="sample-item"]', { timeout: 15000 })
  const resp = await respPromise
  expect(resp.status()).toBe(200)
  await expect(page.getByTestId('sample-item').first()).toBeVisible()
}
`

const BARE_GOTO = `
export default async function run({ page }) {
  await page.goto('/app/catalog')
}
`

describe('validateE2eSpecContent', () => {
  it('golden / 合法 spec 通过', () => {
    const r = validateE2eSpecContent(GOOD, { side: 'web' })
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
  })
  it('golden 模板本身可校验（含占位路由时 side 约束仅告警）', () => {
    const r = validateE2eSpecContent(GOLDEN_E2E_SPEC, { side: 'web' })
    expect(r.ok).toBe(true)
  })
  it('裸相对 goto 且无 baseURL → 拒绝', () => {
    const r = validateE2eSpecContent(BARE_GOTO, { side: 'web' })
    expect(r.ok).toBe(false)
    expect(r.errors.join('')).toMatch(/baseURL|裸相对/)
  })
  it('does not impose a project-specific route convention when side is omitted', () => {
    const r = validateE2eSpecContent(GOOD, { side: null })
    expect(r.ok).toBe(true)
  })
  it('accepts repository-defined side names', () => {
    const r = validateE2eSpecContent(GOOD, { side: 'frontend' })
    expect(r.ok).toBe(true)
  })
  it('中文 getByText 无 data-test → 警告', () => {
    const c = `
export default async function run({ page, baseURL, expect }) {
  await page.route('**/api/**/list*', async (route) => {
    await route.fulfill({ json: { code: 0, data: { list: [{ id: '1', name: '虚假工单' }], total: 1 } } })
  })
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 200)
  await page.goto(\`\${baseURL}/app/a\`)
  await respPromise
  await page.getByText('虚假工单').first().waitFor()
  await expect(page.getByTestId('sample-item').first()).toBeVisible()
}
`
    const r = validateE2eSpecContent(c, { side: 'web' })
    expect(r.ok).toBe(true)
    expect(r.warnings.join('')).toMatch(/data-test/)
  })
  it('custom component markup does not assume a particular UI library', () => {
    const content = `
export default async function run({ page, baseURL, expect }) {
  await page.goto(baseURL + '/app/a')
  await expect(page.locator('custom-tab')).toBeVisible()
}
`
    const r = validateE2eSpecContent(content, { side: 'frontend' })
    expect(r.ok).toBe(true)
  })
  it('规则列表非空', () => {
    expect(SPEC_PLATFORM_RULES.length).toBeGreaterThan(3)
  })
})

describe('确定性 ESM 预检（不执行考卷）', () => {
  it('模板明确声明注入 expect，旧裸 expect 在提交校验被拒绝', () => {
    const src = GOOD.replace('baseURL, expect', 'baseURL')
    const report = buildContractReport(src, { side: 'web' })
    expect(report.ok).toBe(false)
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SPEC_UNDEFINED_EXPECT', errorKind: 'script_runtime' }),
    ]))
  })
  it.each([
    'export default async function run({page,baseURL,expect}) { expect(1).toBe(1) }',
    'import { expect } from "playwright/test"; export default async function run() { expect(1).toBe(1) }',
    'import { expect as check } from "playwright/test"; export default async function run() { check(1).toBe(1) }',
    'function expect(x) { if (!x) throw new Error("bad") }; export default async function run() { expect(true) }',
    'export default async function run({ expect: check }) { check(1).toBe(1) }',
    'export default async function run(ctx) { const {expect} = ctx; expect(1).toBe(1) }',
    'export default async function run() { const expect = (x) => x; expect(1) }',
    'export default async function run() { { var expect = x => x }; expect(1) }',
    'const x = {expect: 1}; // expect(1)\nconst s = "expect(1)"; const r = /expect\\(/; export default async function run() { x.expect }',
    'try {} catch (expect) { expect(true) }; export default async function run() {}',
    'import assert from "node:assert/strict"; export default async function run() { assert.deepEqual([1],[1]) }',
    'import { strict as assert } from "assert"; export default async function run() { assert.ok(true) }',
  ])('合法作用域/自定义断言/内置模块兼容：%s', (src) => {
    expect(preflightE2eSpec(src)).toMatchObject({ ok: true, diagnostics: [] })
  })
  it.each([
    'function helper(expect) { expect(true) }; export default async function run() { expect(true) }',
    'export default async function run() { { const expect = x => x }; expect(true) }',
    'export default async function run({expect: check}) { expect(true) }',
    'export default async function run() { const x = {expect}; }',
    'export default async function run() { const x = `${expect(1)}`; }',
    'export default async function run() { for (let expect of []) {} expect(true) }',
    'class X { expect() {} }; export default async function run() { expect(true) }',
  ])('检测真正未绑定的 expect：%s', (src) => {
    expect(preflightE2eSpec(src).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SPEC_UNDEFINED_EXPECT' }),
    ]))
  })
  it.each([
    'import {expect} from "@playwright/test"',
    'import {expect} from "vitest"',
    'import "./helper.mjs"',
    'export {expect} from "missing-pkg"',
    'const p = import("missing-pkg")',
    'const p = import(`missing-pkg`)',
    'import "file:///C:/host/private.mjs"',
  ])('明确不支持的依赖提前拒绝：%s', (src) => {
    expect(preflightE2eSpec(src).diagnostics[0]).toMatchObject({
      code: 'SPEC_UNSUPPORTED_DEPENDENCY', errorKind: 'script_import',
    })
  })
  it('不允许误用 Playwright 测试注册器', () => {
    expect(preflightE2eSpec('import {test} from "playwright/test"').errors.join()).toMatch(/SPEC_UNSUPPORTED_IMPORT/)
  })
  it('非字面量动态依赖只提示静态分析边界', () => {
    const result = preflightE2eSpec('export default async function run({name}) { await import(name) }')
    expect(result.ok).toBe(true)
    expect(result.warnings.join()).toMatch(/动态 import/)
  })
  it('合法 Node assert 通过完整契约，不强制改写为 expect', () => {
    const src = 'import assert from "node:assert/strict"; export default async function run({page,baseURL}) { await page.goto(baseURL); await page.waitForSelector("#app"); assert.ok(await page.locator("#app").isVisible()) }'
    expect(validateE2eSpecContent(src).errors).toEqual([])
  })
  it('语法错误给出独立类型', () => {
    expect(preflightE2eSpec('export default async function run( {').diagnostics[0]).toMatchObject({
      code: 'SPEC_SYNTAX_ERROR', errorKind: 'script_syntax',
    })
  })
  it.each([
    'export default async function run() { return typeof expect }',
    'export default async function run() { { const expect = x => x; var {value = expect(1)} = {}; } }',
    'export default async function run() { { const expect = x => x; var {[expect("key")]: value} = {}; } }',
  ])('安全探测和 var 解构表达式保持声明处作用域：%s', (src) => {
    expect(preflightE2eSpec(src)).toMatchObject({ ok: true, diagnostics: [] })
  })
  it.each([
    'export default async function run() { return typeof expect(1) }',
    'export default async function run() { { const expect = x => x; } var {value = expect(1)} = {}; }',
  ])('typeof 调用和块外默认值不能掩盖未定义引用：%s', (src) => {
    expect(preflightE2eSpec(src).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SPEC_UNDEFINED_EXPECT' }),
    ]))
  })
  it('顶层代码、动态导入和默认参数都不会被执行', () => {
    const src = 'globalThis.__specPreflightExecuted = true; throw new Error("不要执行"); await import("node:fs"); export default async function run(x = process.exit(99)) {}'
    expect(preflightE2eSpec(src).ok).toBe(true)
    expect(globalThis.__specPreflightExecuted).toBeUndefined()
  })
})

describe('真实提交入口（隔离数据库，仅验证拒绝路径）', () => {
  it('坏卷在内容写入前拒绝，并保留预检诊断码', async () => {
    const { relative, isAbsolute } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const scratch = fileURLToPath(new URL('../data/.testdb-tmp/', import.meta.url))
    // 在导入 db.js 之前硬性验证隔离，避免任何生产库初始化。
    expect(process.env.AWP_DB_PATH).toBeTruthy()
    const rel = relative(scratch, process.env.AWP_DB_PATH)
    expect(isAbsolute(rel) || rel.startsWith('..') || !rel).toBe(false)
    const { default: db } = await import('../db.js')
    const { ensureRepository } = await import('../testing/migrate.js')
    const { upsertRepoTestPolicy } = await import('../testing/repo-policies.js')
    const { submitTestSpec } = await import('../testing/test-specs.js')
    const { default: fs } = await import('node:fs')
    const { vi } = await import('vitest')
    const repoId = await ensureRepository(db, 'preflight-contract-test', 'system')
    await upsertRepoTestPolicy(db, { repoId, enforceSpecContract: true })
    // 资产目录不随 DB 隔离：即使回归失守，也禁止本测试写入真实资产目录。
    const forbidWrite = () => { throw new Error('预检拒绝前不应写入考卷') }
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(forbidWrite)
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(forbidWrite)
    try {
      const count = (await db.prepare('SELECT COUNT(*) n FROM test_specs WHERE repo_id=?').get(repoId)).n
      const inputs = [
        [GOOD.replace('baseURL, expect', 'baseURL'), 'SPEC_UNDEFINED_EXPECT'],
        ['export default async function run( {', 'SPEC_SYNTAX_ERROR'],
        ['import {expect} from "@playwright/test";\n' + GOOD, 'SPEC_UNSUPPORTED_DEPENDENCY'],
      ]
      for (const [content, diagnostic] of inputs) {
        let failure
        try {
          await submitTestSpec({ repoId, featureKey: 'preflight-reject', author: 'preflight-test', specType: 'e2e', side: 'web', content })
        } catch (error) { failure = error }
        expect(failure).toMatchObject({ code: 'INVALID_SPEC_CONTRACT' })
        expect(failure.detail).toContain(diagnostic)
      }
      expect((await db.prepare('SELECT COUNT(*) n FROM test_specs WHERE repo_id=?').get(repoId)).n).toBe(count)
      expect(mkdir).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
    } finally {
      mkdir.mockRestore()
      write.mockRestore()
    }
  })
})

describe('repository-specific URL routing', () => {
  it('allows hash URLs for projects that use hash routing', () => {
    const source = [
      'export default async function run({ page, baseURL, expect }) {',
      "  await page.goto(`${baseURL}/app/#/catalog`)",
      "  await expect(page.getByTestId('sample-item')).toBeVisible()",
      '}',
    ].join('\n')
    expect(validateE2eSpecContent(source, { side: 'web' }).ok).toBe(true)
  })
})
