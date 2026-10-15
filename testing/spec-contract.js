/**
 * testing/spec-contract.js — E2E 平台运行时契约（AI 写 spec 前必须遵守）
 * 单一真源：工具 description / submit 校验 / 失败 packet 共用。
 */
import { createRequire, isBuiltin } from 'node:module'
import { validateE2eAgainstContract } from './contract-engine.js'

const require = createRequire(import.meta.url)

/** 仅解析源码，不 import/link/evaluate 考卷；失败时封闭拒绝，不静默跳过预检。 */
export function preflightE2eSpec(content) {
  const text = String(content || '')
  const diagnostics = []
  const warnings = []
  const add = (code, errorKind, message, node = null) => diagnostics.push({
    code, errorKind, message,
    ...(node?.loc ? { line: node.loc.start.line, column: node.loc.start.column + 1 } : {}),
  })
  const result = () => ({
    ok: diagnostics.length === 0,
    errors: diagnostics.map((d) => `${d.code}: ${d.message}`),
    warnings, diagnostics,
  })
  if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
    add('SPEC_TOO_LARGE', 'script_syntax', '考卷超过预检上限 1 MiB')
    return result()
  }
  // 仅用 acorn 静态解析（sourceType:module 等价 ESM 语法校验），绝不 spawn 子进程、绝不执行顶层代码。
  // 早期实现另跑 `node --input-type=module --check` 子进程做语法校验：满负载并行时 5s 超时会被 signal
  // 打断，误报 SPEC_PREFLIGHT_UNAVAILABLE(infra) 进而拒绝一切合法考卷；acorn 的 parse 抛错已覆盖同样场景。
  let parse
  try { ({ parse } = require('acorn')) } catch {
    add('SPEC_PREFLIGHT_UNAVAILABLE', 'infra', '平台缺少 acorn 解析器，请恢复锁文件依赖；未执行考卷')
    return result()
  }
  let ast
  try {
    ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true })
  } catch (err) {
    add('SPEC_SYNTAX_ERROR', 'script_syntax', String(err?.message || 'ESM 语法错误').slice(0, 1600),
      err?.loc ? { loc: { start: err.loc } } : null)
    return result()
  }
  const refs = []
  const scope = (parent, kind = 'block') => ({ parent, kind, names: new Set() })
  const root = scope(null, 'function')
  const dependency = (value, node) => {
    if (isBuiltin(value) || value === 'playwright/test') return
    add('SPEC_UNSUPPORTED_DEPENDENCY', 'script_import',
      `Guest 未分发依赖 ${JSON.stringify(value)}；仅支持 Node 内置模块及 playwright/test。优先从 run 参数解构 expect，禁止导入 @playwright/test/vitest 或宿主路径`, node)
  }
  const literal = (node) => node?.type === 'Literal' && typeof node.value === 'string' ? node.value
    : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null
  const bind = (node, s, expressionScope = s) => {
    if (!node) return
    if (node.type === 'Identifier') { s.names.add(node.name); return }
    if (node.type === 'RestElement') { bind(node.argument, s, expressionScope); return }
    if (node.type === 'AssignmentPattern') { bind(node.left, s, expressionScope); visit(node.right, expressionScope); return }
    if (node.type === 'ArrayPattern') { for (const e of node.elements) bind(e, s, expressionScope); return }
    if (node.type === 'ObjectPattern') {
      for (const p of node.properties) {
        if (p.computed) visit(p.key, expressionScope)
        bind(p.type === 'RestElement' ? p.argument : p.value, s, expressionScope)
      }
    }
  }
  const visit = (node, s) => {
    if (!node) return
    if (node.type === 'Identifier') {
      if (node.name === 'expect') refs.push({ node, scope: s })
      return
    }
    if (/^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) {
      if (node.type === 'FunctionDeclaration' && node.id) bind(node.id, s)
      const inner = scope(s, 'function')
      if (node.id) bind(node.id, inner)
      for (const p of node.params) bind(p, inner)
      visit(node.body, inner)
      return
    }
    // typeof 未绑定标识符是合法探测；typeof expect() 仍须检查调用中的引用。
    if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier') return
    if (node.type === 'VariableDeclaration') {
      let target = s
      if (node.kind === 'var') while (target.parent && target.kind !== 'function') target = target.parent
      // var 绑定提升，但解构默认值/计算键仍在声明处的词法作用域求值。
      for (const d of node.declarations) { bind(d.id, target, s); visit(d.init, s) }
      return
    }
    if (node.type === 'ImportDeclaration') {
      dependency(node.source.value, node)
      for (const p of node.specifiers) {
        bind(p.local, s)
        if (node.source.value === 'playwright/test' && (p.type !== 'ImportSpecifier' || p.imported.name !== 'expect')) {
          add('SPEC_UNSUPPORTED_IMPORT', 'script_import', 'playwright/test 仅支持命名导入 expect；Guest 不运行 test()/describe() 测试注册器', p)
        }
      }
      return
    }
    if (node.type === 'ImportExpression') {
      const value = literal(node.source)
      if (value !== null) dependency(value, node)
      else warnings.push('动态 import 路径无法静态确定；仅 Guest 执行期可验证，平台不会导入预跑')
      visit(node.source, s)
      return
    }
    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source) {
      dependency(node.source.value, node)
      return
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      if (node.type === 'ClassDeclaration' && node.id) bind(node.id, s)
      const inner = scope(s)
      if (node.id) bind(node.id, inner)
      visit(node.superClass, inner)
      visit(node.body, inner)
      return
    }
    if (node.type === 'CatchClause') {
      const inner = scope(s)
      bind(node.param, inner)
      visit(node.body, inner)
      return
    }
    if (['BlockStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'SwitchStatement', 'StaticBlock'].includes(node.type)) s = scope(s)
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type)) {
      if (node.computed) visit(node.key, s)
      visit(node.value, s)
      return
    }
    if (node.type === 'MemberExpression') {
      visit(node.object, s)
      if (node.computed) visit(node.property, s)
      return
    }
    if (node.type === 'MetaProperty' || node.type === 'Literal') return
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'label', 'exported'].includes(key)) continue
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, s)
      } else if (value?.type) visit(value, s)
    }
  }
  visit(ast, root)
  for (const ref of refs) {
    let s = ref.scope
    while (s && !s.names.has('expect')) s = s.parent
    if (!s) add('SPEC_UNDEFINED_EXPECT', 'script_runtime',
      'expect 没有词法绑定；请从 run({ page, baseURL, expect }) 解构官方断言，或导入 playwright/test 的 expect；已有自定义断言/Node assert 可保留', ref.node)
  }
  return result()
}

export const SPEC_PLATFORM_RULES = Object.freeze([
  'Use ESM: export default async function run({ page, baseURL, expect }).',
  'The runner injects Playwright expect; tests may also use supported Node assertions.',
  'Submission performs static checks only and does not import or execute the submitted test.',
  'Build absolute navigation URLs from the injected baseURL.',
  'Prefer stable data-test attributes or accessible roles over styling classes and visible copy.',
  'Keep environment setup in the runner profile and write only application assertions in the test.',
  'Avoid fixed sleeps; wait for a visible state or response that represents the expected behavior.',
  'Use artifacts and failure details to diagnose selector and runtime errors before changing assertions.',
])

export const GOLDEN_E2E_SPEC = `// Generic browser test template
export default async function run({ page, baseURL, expect }) {
  await page.goto(baseURL)
  await expect(page.locator('body')).toBeVisible()
}
`

export const GOLDEN_UNIT_SPEC = `import { describe, it, expect } from 'vitest'
// 纯逻辑断言，禁止 import 浏览器/page API
describe('your-utils', () => {
  it('example', () => {
    expect(1 + 1).toBe(2)
  })
})
`

/**
 * 校验 E2E/smoke 内容是否符合平台契约。
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateE2eSpecContent(content, { side = null, specType = 'e2e', enforceContract = false } = {}) {
  const errors = []
  const warnings = []
  const text = String(content || '')
  if (!text.trim()) {
    return { ok: false, errors: ['content 为空'], warnings }
  }
  if (specType === 'unit') {
    if (/page\.goto|playwright/i.test(text)) {
      errors.push('unit 资产禁止使用 page/Playwright API')
    }
    return { ok: errors.length === 0, errors, warnings }
  }

  const preflight = preflightE2eSpec(text)
  // 平台自身解析器不可用（infra 类）不应 brick 提交路径：降级为告警，regex 契约校验照常；
  // 脚本级问题（语法/依赖/未定义 expect）仍硬拒。避免「平台故障 → 全部考卷无法提交」的自锁死结。
  for (const d of preflight.diagnostics) {
    if (d.errorKind === 'infra') warnings.push(`${d.code}: ${d.message}`)
    else errors.push(`${d.code}: ${d.message}`)
  }
  warnings.push(...preflight.warnings)

  const hasDefaultRun = /export\s+default\s+async\s+function\s+run\s*\(/.test(text)
    || /export\s+default\s+run/.test(text)
  if (!hasDefaultRun) {
    errors.push('必须 export default async function run({ page, baseURL })')
  }
  const destructureRun = /function\s+run\s*\(\s*\{\s*([^}]*)\s*\}/.exec(text)
  const runParams = destructureRun ? destructureRun[1] : ''
  if (hasDefaultRun && runParams && !/\bpage\b/.test(runParams)) {
    errors.push('run 必须解构 page')
  }
  if (/\bpage\.goto\s*\(/.test(text)) {
    if (!/\bbaseURL\b/.test(runParams) && !/\bbaseURL\b/.test(text)) {
      errors.push('page.goto 必须使用注入的 baseURL 拼完整 URL（禁止裸相对路径）')
    }
    if (/page\.goto\s*\(\s*['"`]\//.test(text) && !/page\.goto\s*\(\s*[`'"].*\$\{baseURL\}/.test(text)) {
      if (!/page\.goto\s*\(\s*`[^`]*\$\{baseURL\}/.test(text) && !/page\.goto\s*\([^)]*baseURL/.test(text)) {
        errors.push('检测到裸相对路径 page.goto("/...")，必须改为 page.goto(`${baseURL}/...`)')
      }
    }
  }

  if (/getByText\s*\(\s*['"][一-龥]/.test(text) && !/data-test/.test(text)) {
    warnings.push('仅用中文 getByText 且无 data-test，选择器易碎，建议 [data-test] 或 getByRole')
  }
  if (/\bsleep\s*\(|waitForTimeout\s*\(/.test(text)) {
    warnings.push('检测到硬等待，建议用 waitForSelector/waitForURL')
  }

  // 断言三件套（完整引擎：enforce 时硬拒，否则告警）
  try {
    const contract = validateE2eAgainstContract({ content: text, fixture: null, enforce: enforceContract })
    for (const e of contract.errors) {
      if (!errors.includes(e)) errors.push(e)
    }
    for (const w of contract.warnings) {
      if (!warnings.includes(w)) warnings.push(w)
    }
  } catch {
    /* engine 异常不阻断旧校验 */
  }

  return { ok: errors.length === 0, errors, warnings, diagnostics: preflight.diagnostics }
}

/**
 * 结构化 contract report（供 test_specs.contract_report_json / review 落库）。
 * @returns {{ok, side, errors, warnings, checks: object}}
 */
export function buildContractReport(content, { side = null, specType = 'e2e' } = {}) {
  const text = String(content || '')
  const v = validateE2eSpecContent(text, { side, specType })
  const checks = {
    hasDefaultRun: /export\s+default\s+async\s+function\s+run/.test(text),
    usesBaseURL: /\bbaseURL\b/.test(text),
    hasNetworkAssert: /waitForResponse|page\.route|route\.fulfill/.test(text),
    hasDataAssert: /toBeVisible|toContainText|toHaveText|getByTestId/.test(text),
    hasBoundaryHint: /empty-state|空态|total:\s*0/.test(text),
    hasForbiddenApi: /\bsleep\s*\(|waitForTimeout\s*\(/.test(text),
    sideDeclared: side != null,
    usesProjectDefinedSide: side != null,
  }
  return {
    ok: v.ok,
    side,
    specType,
    errors: v.errors,
    warnings: v.warnings,
    diagnostics: v.diagnostics || [],
    checks,
    generatedAt: new Date().toISOString(),
  }
}

export function formatSpecRulesForAgent() {
  return SPEC_PLATFORM_RULES.map((r, i) => `${i + 1}. ${r}`).join('\n')
}
