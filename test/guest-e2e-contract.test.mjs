import { beforeAll, describe, expect, it } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { GOLDEN_E2E_SPEC } from '../testing/spec-contract.js'
import { classifySmokeError } from '../runner/guest-agent/smoke.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const smokeUrl = new URL('../runner/guest-agent/smoke.mjs', import.meta.url).href
const bundle = process.env.AWP_TEST_PW_BUNDLE || 'C:\\awp-runner\\pw-bundle'
const chromium = process.env.AWP_TEST_CHROMIUM || join(bundle, 'browsers', 'chromium-1148', 'chrome-win', 'chrome.exe')
const hasBundle = existsSync(join(bundle, 'node_modules', 'playwright', 'test.js'))
let runDir
let specsDir
let seq = 0
beforeAll(() => {
  const scratch = join(root, 'data', '.testdb-tmp')
  mkdirSync(scratch, { recursive: true })
  runDir = mkdtempSync(join(scratch, 'guest-e2e-contract-'))
  specsDir = join(runDir, 'input', 'test-specs')
  mkdirSync(specsDir, { recursive: true })
  if (hasBundle) {
    // 只读外部离线包，运行和产物均放在工作区，模拟 Host 的两包分发。
    for (const name of ['playwright', 'playwright-core']) {
      cpSync(join(bundle, 'node_modules', name), join(runDir, 'input', 'node_modules', name), { recursive: true })
    }
  }
})
function spec(source) {
  const entry = join(specsDir, `case-${++seq}.mjs`)
  writeFileSync(entry, source)
  return entry
}
function native(body) {
  const source = `import { executeE2eSpec, loadGuestExpect, resolveGuestPlaywright, runSmokeChecks } from ${JSON.stringify(smokeUrl)};
    const runDir = ${JSON.stringify(runDir)};
    const emit = value => console.log('__RESULT__' + JSON.stringify(value));
    ${body}`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: runDir, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, AWP_DB_PATH: ':memory:', NODE_OPTIONS: '', TEMP: runDir, TMP: runDir, PLAYWRIGHT_BROWSERS_PATH: join(bundle, 'browsers') },
  })
  expect(child.error, child.stderr).toBeUndefined()
  expect(child.status, child.stderr || child.stdout).toBe(0)
  const line = child.stdout.split(/\r?\n/).find((l) => l.startsWith('__RESULT__'))
  expect(line, child.stdout).toBeTruthy()
  return JSON.parse(line.slice('__RESULT__'.length))
}
function execute(entry) {
  return native(`emit(await executeE2eSpec({ entry: ${JSON.stringify(entry)}, page: {}, baseURL: 'http://127.0.0.1',
    getExpect: () => { throw Object.assign(new Error('PLAYWRIGHT_EXPECT_UNAVAILABLE'), {code:'PLAYWRIGHT_EXPECT_UNAVAILABLE'}) } }));`)
}

describe('原生 Guest 模块执行与失败类型（没有 Vitest 全局 expect）', () => {
  it.each([
    ['export default async function run() { expect(1).toBe(1) }', 'script_runtime'],
    ['export default async function run() { null.foo() }', 'script_runtime'],
    ['export default async function run() { throw new Error("expect data failed") }', 'script_runtime'],
    ['import "not-a-real-dependency"; export default async function run() {}', 'script_import'],
    ['import { expect } from "@playwright/test"; export default async function run() {}', 'script_import'],
    ['throw new Error("top-level"); export default async function run() {}', 'script_import'],
    ['export default async function run( {', 'script_syntax'],
    ['export const run = async () => {}', 'script_runtime'],
    ['import assert from "node:assert/strict"; export default async function run() { assert.equal(1,2) }', 'assertion'],
  ])('%s → %s', (source, errorKind) => {
    expect(execute(spec(source))).toMatchObject({ status: 'failed', errorKind })
  })
  it('旧 Node assert 和自定义 expect 不加载平台断言、不污染全局', () => {
    for (const source of [
      'import assert from "node:assert/strict"; export default async function run({page,baseURL}) { assert.ok(page); assert.match(baseURL,/^http/); assert.equal(typeof globalThis.expect,"undefined") }',
      'function expect(x) { if (!x) throw new Error("bad") }; export default async function run({page}) { expect(page) }',
    ]) expect(execute(spec(source))).toEqual({ status: 'passed' })
  })
  it('官方断言模块不可用是 infra，不伪造通过或误判业务', () => {
    expect(execute(spec('export default async function run({expect}) { expect(1).toBe(1) }')))
      .toMatchObject({ status: 'error', errorKind: 'infra' })
  })
  it('选择器操作超时与断言重试超时可区分', () => {
    const timeout = Object.assign(new Error('locator.click: Timeout 20ms exceeded. waiting for locator("#missing")'), { name: 'TimeoutError' })
    expect(classifySmokeError(timeout).errorKind).toBe('selector_timeout')
    expect(classifySmokeError(Object.assign(timeout, { matcherResult: { pass: false } })).errorKind).toBe('assertion')
    expect(classifySmokeError(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })))
      .toEqual({ status: 'error', errorKind: 'infra' })
    for (const metadata of [{ code: 'ERR_ASSERTION' }, { matcherResult: { pass: false } }]) {
      expect(classifySmokeError(Object.assign(new Error('expected: out of memory; received: browser crashed'), metadata)))
        .toEqual({ status: 'failed', errorKind: 'assertion' })
    }
  })
})

describe.skipIf(!hasBundle)('离线 Playwright 官方 expect（真实包，无简化替身）', () => {
  it('从 input/node_modules 解析同源包，支持官方扩展/异步匹配器', () => {
    const entry = spec(`export default async function run({expect}) {
      expect({a: [1,2]}).toEqual({a: expect.arrayContaining([2])});
      await expect(Promise.resolve(3)).resolves.toBe(3);
      await expect.poll(() => 7).toBe(7);
      const custom = expect.extend({toBeSeven(actual) { return {pass: actual === 7, message: () => '不是 7'} }});
      custom(7).toBeSeven();
    }`)
    const result = native(`const url = resolveGuestPlaywright({runDir});
      const official = loadGuestExpect(url);
      const good = await executeE2eSpec({entry:${JSON.stringify(entry)}, getExpect: () => official});
      emit({url, good, hasGlobal: typeof globalThis.expect !== 'undefined'});`)
    expect(result.url).toContain('/input/node_modules/playwright/')
    expect(result.good).toEqual({ status: 'passed' })
    expect(result.hasGlobal).toBe(false)
  })
  it.skipIf(!existsSync(chromium))('真实 Chromium 执行 Golden 模板，locator 自动等待且 data-test 生效', () => {
    const entry = spec(GOLDEN_E2E_SPEC)
    const html = `<html><body><div id="app"></div><script>fetch('/api/item/list').then(()=>setTimeout(()=>document.getElementById('app').innerHTML='<div data-test="list-item">样例</div>',100))</script></body></html>`
    const result = native(`const url = resolveGuestPlaywright({runDir});
      const imported = await import(url); const pw = imported.default || imported; const official = loadGuestExpect(url);
      const browser = await pw.chromium.launch({executablePath:${JSON.stringify(chromium)}});
      try {
        const page = await browser.newPage();
        await page.route('http://127.0.0.1:43199/**', route => route.fulfill({contentType:'text/html; charset=utf-8', body:${JSON.stringify(html)}}));
        emit(await executeE2eSpec({entry:${JSON.stringify(entry)}, page, baseURL:'http://127.0.0.1:43199', getExpect: () => official}));
      } finally { await browser.close() }`)
    expect(result).toEqual({ status: 'passed' })
  }, 45000)
  it.skipIf(!existsSync(chromium))('完整 smoke 路径保留每张考卷 errorKind 和行动日志', () => {
    const ws = join(runDir, 'workspace')
    const html = join(ws, 'dist', 'web-assets', 'webSide.html')
    mkdirSync(dirname(html), { recursive: true })
    writeFileSync(html, '<html><body><div id="app">ready</div><div data-test="item">实际</div></body></html>')
    const cases = [
      ['passed', 'export default async function run({expect}) { expect(1).toBe(1) }'],
      ['imported', 'import {expect} from "playwright/test"; export default async function run({page}) { await expect(page.getByTestId("item")).toHaveText("实际") }'],
      ['assertion', 'export default async function run({page,expect}) { await expect(page.getByTestId("item")).toHaveText("错误",{timeout:100}) }'],
      ['selector_timeout', 'export default async function run({page}) { await page.locator("#missing").click({timeout:100}) }'],
      ['script_runtime', 'export default async function run() { expect(true).toBe(true) }'],
      ['script_import', 'import "not-a-real-dependency"; export default async function run() {}'],
      ['infra', 'export default async function run({page}) { await page.context().browser().close(); await page.title() }'],
    ]
    const manifest = cases.map(([featureKey, source]) => ({ featureKey, entry: spec(source).split(/[\\/]/).pop() }))
    writeFileSync(join(specsDir, 'manifest.json'), JSON.stringify({ specs: manifest }))
    const checks = native(`const imported = await import(resolveGuestPlaywright({runDir}));
      const pw = imported.default || imported; const launch = pw.chromium.launch.bind(pw.chromium);
      pw.chromium.launch = () => launch({executablePath:${JSON.stringify(chromium)}});
      emit(await runSmokeChecks({workspaceDir:${JSON.stringify(ws)}, runDir, side:'web',
      cases:[{caseKey:'test:smoke/fun'}], smokeScripts:{fun:{build:[],entry:'webSide',outDir:'web-assets'}}}));`)
    expect(checks[0]).toMatchObject({ status: 'passed' })
    expect(checks.slice(1, 3).map((c) => c.status)).toEqual(['passed', 'passed'])
    for (const [errorKind] of cases.slice(2)) {
      expect(checks.find((c) => c.caseKey === `test:spec/${errorKind}`)).toMatchObject({
        errorKind, status: errorKind === 'infra' ? 'error' : 'failed',
      })
      const log = JSON.parse(readFileSync(join(runDir, 'output', 'logs', `e2e-actions-${errorKind}.json`), 'utf8'))
      expect(log.steps.find((s) => s.action === 'spec-fail')).toMatchObject({ errorKind, status: 'failed' })
      const schema = JSON.parse(readFileSync(join(root, 'contracts', 'test-report.schema.json'), 'utf8'))
      for (const step of log.steps) expect(schema.$defs.step.properties.status.enum).toContain(step.status)
    }
  }, 45000)
})

describe('Host PowerShell 分发契约', () => {
  it('保持 UTF-8 BOM，并由 PS5.1 仅解析、不执行 Hyper-V 脚本', () => {
    const file = resolve(root, 'runner/host-worker/hyperv-static-lane.ps1')
    const bytes = readFileSync(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    if (process.platform !== 'win32') return
    const command = `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile('${file.replace(/'/g, "''")}',[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Output; exit 1 }`
    const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000 })
    expect(child.status, child.stdout || child.stderr).toBe(0)
    expect(bytes.toString('utf8')).toContain("$pwPackage.exports.'./test'")
  })
})
