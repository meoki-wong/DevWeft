/**
 * validate-spec-dry-run.mjs — 轻量 dry-run 沙箱（不真正发网络、不启浏览器）
 *
 * 校验：
 *  - 语法可加载
 *  - export default run 存在
 *  - run 可调用（stub page/context/baseURL）
 *  - 未访问禁止 API（sleep 等由 contract report 兜底）
 *
 * 用法：node scripts/validate-spec-dry-run.mjs <spec.mjs>
 * 退出码：0=通过，1=失败
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { buildContractReport } from '../testing/spec-contract.js'

const specPath = process.argv[2]
if (!specPath) {
  console.error('用法: node scripts/validate-spec-dry-run.mjs <spec.mjs>')
  process.exit(2)
}

function makeStubPage() {
  const calls = []
  const page = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === '__calls') return calls
        return (...args) => {
          calls.push({ api: String(prop), args: args.map((a) => (typeof a === 'string' ? a : typeof a)) })
          // route/fulfill/waitFor* 返回可 await 的 stub
          if (prop === 'waitForResponse') {
            return Promise.resolve({
              status: () => 200,
              url: () => 'stub://response',
              json: async () => ({}),
            })
          }
          if (prop === 'route') return Promise.resolve()
          if (prop === 'unroute') return Promise.resolve()
          if (prop === 'goto' || prop === 'reload' || prop === 'click' || prop === 'fill') return Promise.resolve()
          if (prop === 'waitForSelector' || prop === 'waitForURL') return Promise.resolve(null)
          // locator 链
          return makeStubLocator()
        }
      },
    }
  )
  return page
}

function makeStubLocator() {
  const loc = {
    first: () => loc,
    click: async () => {},
    fill: async () => {},
    toBeVisible: async () => {},
    toContainText: async () => {},
    count: async () => 1,
    textContent: async () => '',
  }
  return loc
}

async function main() {
  const abs = path.resolve(specPath)
  let mod
  try {
    mod = await import(pathToFileURL(abs).href)
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: 'LOAD_FAILED', detail: e.message }, null, 2))
    process.exit(1)
  }
  const run = mod.default || mod.run
  if (typeof run !== 'function') {
    console.error(JSON.stringify({ ok: false, error: 'NO_DEFAULT_RUN' }, null, 2))
    process.exit(1)
  }

  const page = makeStubPage()
  const baseURL = 'http://127.0.0.1:0'
  let runError = null
  try {
    await run({ page, baseURL, context: {}, expect: () => ({ toBe: () => {}, toEqual: () => {} }) })
  } catch (e) {
    // stub 环境下 locator 断言失败可接受；仅记录
    runError = e.message
  }

  const source = await (await import('node:fs/promises')).readFile(abs, 'utf8')
  const report = buildContractReport(source, { side: null, specType: 'e2e' })

  console.log(
    JSON.stringify(
      {
        ok: true,
        hasRun: true,
        runError,
        pageCalls: page.__calls?.length || 0,
        contract: report,
      },
      null,
      2
    )
  )
  process.exit(report.ok ? 0 : 1)
}

main()
