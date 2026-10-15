/**
 * Guest smoke lane for repository-configured test sides.
 * build:development:<side> -> serve:<side>（仅监听 Guest 127.0.0.1）-> Playwright 打开首页断言挂载。
 * Playwright runtime 来自 runner image（golden 打入）；不可用时给出确定性 error，不伪造通过。
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, createReadStream, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { describeStep, inferExpected } from '../report-steps.js'

/** 同一离线包解析浏览器和官方断言，ESM 不依赖 NODE_PATH 或业务仓依赖。 */
export function resolveGuestPlaywright({ runDir = null, playwrightModule = 'playwright' } = {}) {
  if (playwrightModule.startsWith('file:')) return playwrightModule
  const from = runDir && playwrightModule === 'playwright'
    ? pathToFileURL(join(runDir, 'input', 'guest-runtime.cjs')) : import.meta.url
  return pathToFileURL(createRequire(from).resolve(playwrightModule)).href
}

export function loadGuestExpect(playwrightUrl) {
  try {
    const { expect, selectors } = createRequire(playwrightUrl)('playwright/test')
    if (typeof expect !== 'function' || typeof expect.configure !== 'function') throw new Error('官方 expect 导出不可用')
    selectors.setTestIdAttribute('data-test')
    return expect
  } catch (cause) {
    const error = new Error(`PLAYWRIGHT_EXPECT_UNAVAILABLE: ${cause.message}`)
    error.code = 'PLAYWRIGHT_EXPECT_UNAVAILABLE'
    throw error
  }
}

/** 分类使用运行阶段及错误结构，不把普通 throw/Error 或模块缺失伪装成业务断言。 */
export function classifySmokeError(error, { phase = 'runtime' } = {}) {
  const message = String(error?.message || error)
  const code = String(error?.code || '')
  const infra = phase === 'infra' || code === 'PLAYWRIGHT_EXPECT_UNAVAILABLE'
    || /^(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EADDRINUSE|ENOMEM)$/.test(code)
  if (infra) return { status: 'error', errorKind: 'infra' }
  // 真实断言的 expected/received 可能含基础设施关键词，不能按正文误判。
  if (error?.code === 'ERR_ASSERTION' || error?.name === 'AssertionError' || error?.matcherResult) {
    return { status: 'failed', errorKind: 'assertion' }
  }
  if (/browserType\.launch:|executable doesn't exist|browser has been closed|target page, context or browser has been closed|browser crashed|out of memory/i.test(message)) {
    return { status: 'error', errorKind: 'infra' }
  }
  if (error?.name === 'SyntaxError') return { status: 'failed', errorKind: 'script_syntax' }
  if (/^(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_ESM_URL_SCHEME|ERR_UNKNOWN_FILE_EXTENSION|ERR_INVALID_MODULE_SPECIFIER)$/.test(code)
    || phase === 'import') return { status: 'failed', errorKind: 'script_import' }
  if ((error?.name === 'TimeoutError' || /timeout.*exceeded|timed out/i.test(message))
    && /waitForSelector|locator\.|waiting for (?:locator|selector)|selector|(?:page\.)?(?:click|fill|hover|check):/i.test(message)) {
    return { status: 'failed', errorKind: 'selector_timeout' }
  }
  return { status: 'failed', errorKind: phase === 'page' ? 'page_runtime' : 'script_runtime' }
}

/** 仅由 Guest 执行期调用；额外参数不影响旧 run({page,baseURL}) / Node assert 考卷。 */
export async function executeE2eSpec({ entry, page, baseURL, getExpect }) {
  let phase = 'import'
  try {
    const mod = await import(pathToFileURL(entry).href)
    phase = 'runtime'
    if (typeof mod.default !== 'function') throw new TypeError('spec 缺少 default run({ page, baseURL, expect }) 导出')
    await mod.default({ page, baseURL, get expect() { return getExpect() } })
    return { status: 'passed' }
  } catch (error) {
    return { ...classifySmokeError(error, { phase }), detail: String(error?.message || error) }
  }
}

/**
 * 解析本 run 的 smoke 脚本（多仓可插拔）。
 * Smoke commands are supplied by the repository profile and frozen into the run.
 */
export function resolveSmokeScripts(side, { scripts = null, runDir = null } = {}) {
  // 显式传入 scripts：视为权威映射，无该 side 不回落内置
  if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
    if (Object.prototype.hasOwnProperty.call(scripts, side)) return scripts[side] || null
    if (scripts.smoke && Object.prototype.hasOwnProperty.call(scripts.smoke, side)) {
      return scripts.smoke[side] || null
    }
    // 传了 scripts 但无 side 键 → null
    if (Object.keys(scripts).length && !scripts.build) return null
  }
  const file = runDir ? join(runDir, 'input', 'smoke-scripts.json') : null
  if (file && existsSync(file)) {
    try {
      const json = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
      if (json && Object.prototype.hasOwnProperty.call(json, side)) {
        return json[side] || null
      }
      if (json?.smoke && Object.prototype.hasOwnProperty.call(json.smoke, side)) {
        return json.smoke[side] || null
      }
      return null
    } catch { /* fallthrough to builtin */ }
  }
  return null
}

export const SMOKE_SCRIPTS = Object.freeze({})

export function parseViteLocalUrl(text) {
  // vite 输出带 ANSI 颜色码（如 \x1b[39m 会紧跟在 "Local:" 之后），
  // 不剥除则 Local:\s+http 正则永远失配 → 误判 VITE_NOT_READY
  const clean = String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const m = clean.match(/Local:\s+https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/)
  return m ? Number(m[1]) : null
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve()
  return new Promise((resolve) => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer.on('exit', resolve)
        killer.on('error', resolve)
      } else {
        child.kill('SIGTERM')
        resolve()
      }
    } catch {
      resolve()
    }
  })
}

function runNpmScript(script, { workspaceDir, timeoutMs }) {
  return new Promise((resolve) => {
    // Windows 上 .cmd 必须走 shell（Node ≥18.20 对 .cmd 直接 spawn 抛 EINVAL）
    // 限制 V8 老生代，避免 Guest 里 vite/node 默认堆过大导致 exit=134 OOM
    const child = spawn(npmCommand(), ['run', script], {
      cwd: workspaceDir,
      env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=3072' },
      windowsHide: true,
      shell: process.platform === 'win32',
    })
    let output = ''
    const timer = setTimeout(() => killTree(child), timeoutMs)
    child.stdout.on('data', (c) => { output += c })
    child.stderr.on('data', (c) => { output += c })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, output })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: null, signal: null, output: `${output}\n${err.message}` })
    })
  })
}

function startPreview({ workspaceDir, outDir, previewCommand }) {
  // vite preview 伺服 dist/<outDir>；--strictPort 固定端口 4173（parseViteLocalUrl 兜底解析）
  // previewCommand: 完整命令数组 [exe, ...args]，测试可注入；
  // Windows 上 npx/exec 无法直接 spawn（需 .cmd + shell），直连本地 bin vite.cmd 最稳；
  // 9/7 实测 spawn('exec') ENOENT 未捕获 error 事件 → node 崩溃（不走 finally、不写 result、VM 不关机）
  const cmdArgs = previewCommand || (process.platform === 'win32'
    ? [join(workspaceDir, 'node_modules', '.bin', 'vite.cmd'), 'preview', '--outDir', `dist/${outDir}`, '--strictPort', '--port', '4173']
    : ['npx', '--yes', '--', 'vite', 'preview', '--outDir', `dist/${outDir}`, '--strictPort', '--port', '4173'])
  const exe = cmdArgs[0]
  const rest = cmdArgs.slice(1)
  const child = spawn(exe, rest, {
    cwd: workspaceDir,
    env: process.env,
    windowsHide: true,
    shell: process.platform === 'win32' && exe.endsWith('.cmd'),
  })
  let output = ''
  let spawnError = null
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  child.on('error', (err) => {
    spawnError = err
    output += `\n[spawn error] ${err.message}`
  })
  return { child, getOutput: () => output, getSpawnError: () => spawnError }
}

// 自写静态服务器替代 vite preview：实测 vite preview（MPA 插件中间件）对 text/html 导航请求
// 会 hang/404（与 Accept/Sec-Fetch 头相关），行为不可控；纯静态伺服 dist 根完全可控
const MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', gif: 'image/gif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', map: 'application/json',
}

async function startStaticServer({ rootDir, port, fallbackFile = null }) {
  const root = rootDir.replace(/\\/g, '/')
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      let filePath = join(root, urlPath)
      if (!filePath.replace(/\\/g, '/').startsWith(root)) {
        res.statusCode = 403
        return res.end('Forbidden')
      }
      if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html')
      if (!existsSync(filePath)) {
        // History-based routes without a file extension fall back to the configured entry page.
        if (fallbackFile && req.method === 'GET' && !/\.[a-z0-9]+$/i.test(urlPath)) {
          filePath = fallbackFile
        } else {
          res.statusCode = 404
          return res.end('Not Found')
        }
      }
      const ext = filePath.split('.').pop().toLowerCase()
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
      createReadStream(filePath).pipe(res)
    } catch {
      res.statusCode = 500
      res.end('Internal Error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function waitForVitePort(serve, timeoutMs) {
  const started = Date.now()
  return new Promise((resolve) => {
    const poll = () => {
      const port = parseViteLocalUrl(serve.getOutput())
      if (port) {
        resolve(port)
        return
      }
      if (serve.getSpawnError?.() || serve.child.exitCode !== null || Date.now() - started > timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(poll, 250)
    }
    poll()
  })
}

export async function runSmokeChecks({
  workspaceDir,
  runDir = null,
  cases,
  side,
  profile = null,
  smokeScripts = null,
  playwrightModule = 'playwright',
  previewCommand = null,
  serveReadyTimeoutMs = (profile?.timeouts?.viteReadySeconds || 300) * 1000,
  // 300s：VM（4 vCPU）上 vite preview 首次就绪实测 ~125s，120s 窗口差几秒就误判 VITE_NOT_READY
  buildTimeoutMs = (profile?.timeouts?.staticSeconds || 600) * 1000,
}) {
  const checks = []
  for (const c of cases) {
    const started = Date.now()
    let result
    try {
      result = await runSideSmoke(side, {
        workspaceDir, runDir, playwrightModule, previewCommand, serveReadyTimeoutMs, buildTimeoutMs, smokeScripts,
      })
    } catch (error) {
      result = { status: 'error', errorKind: 'infra', detail: `SMOKE_INFRA_ERROR: ${error.message}` }
    }
    const main = { caseKey: c.caseKey, status: result.status, durationMs: Math.max(0, Date.now() - started) }
    if (result.errorKind) main.errorKind = result.errorKind
    if (result.detail) main.detail = result.detail
    checks.push(main)
    // 项目自定义 E2E spec（feature-key 模式）的结果并入 checks
    for (const extra of result.extraChecks || []) checks.push(extra)
  }
  return checks
}

/**
 * P3：取本次任务改动在某文件的行区间；git 不可用/无历史 → null（调用方 skip 不盲变异）。
 * 与平台侧 resolveTaskChangedFiles 的任务边界语义对齐：
 *  - 有 boundary.startHeadOid：diff(start → 工作区)，覆盖任务内提交 + 脏改动
 *  - 无起点：优先脏改动（diff HEAD），避免 HEAD~1 无关提交行归因；再回退 HEAD~1..HEAD
 *  - merge 且无任务起点：回退 null（merge 的 HEAD~1..HEAD 会把合并带入历史行算成本次改动）
 */
export function changedLineRanges(workspaceDir, rel, boundary = null) {
  try {
    const parseHunks = (out) => {
      if (!out || out.status !== 0 || !out.stdout) return null
      const ranges = []
      for (const line of String(out.stdout).split(/\r?\n/)) {
        const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
        if (m) { const s = Number(m[1]); const len = m[2] == null ? 1 : Number(m[2]); if (len > 0) ranges.push([s, s + len - 1]) }
      }
      return ranges.length ? ranges : null
    }
    const runDiff = (...args) => spawnSync('git', ['-C', workspaceDir, 'diff', '--unified=0', ...args], { encoding: 'utf8', timeout: 8000 })

    const startHeadOid = boundary?.startHeadOid || null
    if (startHeadOid && /^[a-f0-9]{7,40}$/i.test(String(startHeadOid))) {
      const ok = spawnSync('git', ['-C', workspaceDir, 'cat-file', '-e', `${startHeadOid}^{commit}`], { encoding: 'utf8', timeout: 8000 })
      const isAnc = spawnSync('git', ['-C', workspaceDir, 'merge-base', '--is-ancestor', String(startHeadOid), 'HEAD'], { encoding: 'utf8', timeout: 8000 })
      // 仅当 start 是 HEAD 祖先（含相等）才用 start→工作区；串仓/分叉起点会反向带入无关行
      if (ok && ok.status === 0 && isAnc && isAnc.status === 0) {
        return parseHunks(runDiff(startHeadOid, '--', rel))
      }
    }
    const isMerge = spawnSync('git', ['-C', workspaceDir, 'rev-list', '--no-walk', '--parents', 'HEAD'], { encoding: 'utf8', timeout: 8000 })
    if (isMerge.status === 0 && String(isMerge.stdout || '').trim().split(/\s+/).filter(Boolean).length > 2) return null
    // 优先脏改动（工作区 vs HEAD）
    const dirtyRanges = parseHunks(runDiff('HEAD', '--', rel))
    if (dirtyRanges) return dirtyRanges
    // 兼容：已提交 tip（纯提交交付 / 旧夹具）
    return parseHunks(runDiff('HEAD~1', 'HEAD', '--', rel))
  } catch { return null }
}

async function runSideSmoke(side, { workspaceDir, runDir = null, playwrightModule, previewCommand, serveReadyTimeoutMs, buildTimeoutMs, smokeScripts = null }) {
  const scripts = resolveSmokeScripts(side, { scripts: smokeScripts, runDir })
  if (!scripts) return { status: 'error', errorKind: 'infra', detail: `SMOKE_SIDE_UNKNOWN: ${side} (no smoke profile is configured)` }

  // 变异验卷：manifest.mutation 时对「本次 diff 改动行上的算子」做确定性暗改（先于构建）。
  // 与 testing/mutation.js 同算法的 guest 内联副本（guest 零依赖自包含）。
  // R6 重构（修「每张卷必杀随机一题」的永久卡卷死锁）：
  //   1) 不再回退整文件——改动行无可翻算子/diff 上下文缺失 → 不注入，上报 skipped（host 判 not_covered 豁免）；
  //      旧行为把暗题落到无关老代码，考卷数学上不可能杀中，必被误判废卷（实测签到弹窗两处即死于此）。
  //   2) seed 加入考卷版本（manifest.specs[].version）——加强卷重提后暗题换新落点，「加强后重试」成为收敛路径；
  //   3) 上报暗题锚点 {file, line, find, replace}——host 写进 f2p detail/废卷提示，作者不再盲猜。
  let mutationApplied = null
  let mutationTargetFk = ''
  try {
    const manifestPath = runDir ? join(runDir, 'input', 'test-specs', 'manifest.json') : null
    const changedPath = runDir ? join(runDir, 'input', 'changed-files.json') : null
    if (manifestPath && changedPath && existsSync(manifestPath) && existsSync(changedPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
      if (manifest.mutation) {
        // 暗改 seed 含 featureKey（manifest.mutation.featureKey）：每张考卷面对不同暗改点，
        // 避免“同一处暗改考 N 张卷、未命中路径的卷全部被误判废卷”。
        const fk = typeof manifest.mutation === 'object' && manifest.mutation?.featureKey ? String(manifest.mutation.featureKey) : ''
        mutationTargetFk = fk
        const specVer = (manifest.specs || []).find((s) => s && s.featureKey === fk)?.version ?? null
        const changed = JSON.parse(readFileSync(changedPath, 'utf8'))
        const mutPages = Array.isArray(manifest.mutation?.pages) ? manifest.mutation.pages : null
        const changedCandidates = (mutPages && mutPages.length)
          ? changed.filter((rel) => mutPages.some((p) => String(rel).toLowerCase().includes(String(p).toLowerCase())))
          : changed
        const ops = [
          ['===', '!=='], ['!==', '==='], ['&&', '||'], ['||', '&&'],
          ['? true : false', '? false : true'], ['true', 'false'], ['false', 'true'],
          ['+ 1', '- 1'], ['- 1', '+ 1'],
        ]
        let skipReason = changedCandidates.length ? null : 'no-changed-candidates'
        let boundary = null
        try {
          const boundaryPath = runDir ? join(runDir, 'input', 'task-boundary.json') : null
          if (boundaryPath && existsSync(boundaryPath)) {
            boundary = JSON.parse(readFileSync(boundaryPath, 'utf8').replace(/^﻿/, ''))
          }
        } catch { boundary = null }
        for (const rel of changedCandidates) {
          const abs = join(workspaceDir, rel)
          if (!existsSync(abs) || !/\.(js|ts|mjs|cjs|jsx|vue)$/i.test(abs)) continue
          const content = readFileSync(abs, 'utf8')
          if (!content.length || content.length > 500_000) continue
          // seed = [featureKey, v卷版本, 相对路径, 源码内容]：卷改版 → 暗题换落点（重试验卷可收敛）
          const seedSrc = `${fk ? `${fk}::` : ''}${specVer != null ? `v${specVer}::` : ''}${rel}::${content}`
          const start = Number.parseInt(createHash('sha256').update(seedSrc).digest('hex').slice(0, 8), 16)
          // 变异只落在「本次任务改动行」：always_pass 自此只反映「没测到你改的这段」，不再翻老代码误伤。
          const ranges = changedLineRanges(workspaceDir, rel, boundary)
          const lineOf = (str, ix) => { let ln = 1; for (let k = 0; k < ix; k++) if (str.charCodeAt(k) === 10) ln++; return ln }
          const occurrencesFor = (find) => { const a = []; let pos = 0, idx = -1; while ((idx = content.indexOf(find, pos)) !== -1) { a.push(idx); pos = idx + find.length } return a }
          if (!ranges) { skipReason = skipReason || 'no-diff-context'; continue }
          let plan = null
          for (let i = 0; i < ops.length && !plan; i++) {
            const [find, replace] = ops[(start + i) % ops.length]
            const occ = occurrencesFor(find).filter(ix => ranges.some(([a, b]) => { const ln = lineOf(content, ix); return ln >= a && ln <= b }))
            if (occ.length) plan = { find, replace, index: occ[start % occ.length] }
          }
          if (!plan) { skipReason = skipReason || 'no-operator-on-diff-lines'; continue }
          writeFileSync(abs, content.slice(0, plan.index) + plan.replace + content.slice(plan.index + plan.find.length), 'utf8')
          mutationApplied = { file: rel, line: lineOf(content, plan.index), find: plan.find, replace: plan.replace, mode: 'diff-line' }
          break
        }
        if (!mutationApplied) mutationApplied = { mode: 'skipped', reason: skipReason || 'no-plan' }
        process.stdout.write(`mutation applied: ${JSON.stringify(mutationApplied)}\n`)
      }
    }
  } catch { /* 暗改异常按未变异跑：不注入 mutation 字段 → host 判 inconclusive 维持旧严格语义 */ }
  let buildOutput = ''
  for (const script of [].concat(scripts.build)) {
    const build = await runNpmScript(script, { workspaceDir, timeoutMs: buildTimeoutMs })
    buildOutput += `\n[${script}]\n${build.output || ''}`
    if (build.code !== 0) {
      const tail = buildOutput.split(/\r?\n/).filter((l) => l.trim()).slice(-8).join('\n')
      const infra = build.code == null || build.code === 134 || /out of memory|ENOMEM|ENOTFOUND|ECONNREFUSED/i.test(buildOutput)
      return { status: infra ? 'error' : 'failed', errorKind: infra ? 'infra' : 'build', detail: `BUILD_FAILED exit=${build.code} signal=${build.signal} script=${script}\n${tail}` }
    }
  }

  // 静态伺服 dist 根（含各 side 子目录），入口 /<outDir>/<entry>.html（MPA 多页）；
  // 替代 vite preview：其 MPA 中间件对导航请求行为不可控（hang/404）
  const server = await startStaticServer({
    rootDir: join(workspaceDir, 'dist'),
    port: 4173,
    fallbackFile: join(workspaceDir, 'dist', scripts.outDir, `${scripts.entry}.html`),
  })
  let browser
  let phase = 'infra'
  const pageErrors = []
  try {
    const port = 4173
    let pw
    let playwrightUrl
    try {
      playwrightUrl = resolveGuestPlaywright({ runDir, playwrightModule })
      const imported = await import(playwrightUrl)
      pw = imported.chromium ? imported : imported.default
      pw.selectors?.setTestIdAttribute('data-test')
    } catch (err) {
      return { status: 'error', errorKind: 'infra', detail: `PLAYWRIGHT_UNAVAILABLE: ${err.message}` }
    }
    let officialExpect
    const getExpect = () => officialExpect || (officialExpect = loadGuestExpect(playwrightUrl))
    browser = await pw.chromium.launch()
    const page = await browser.newPage()
    phase = 'page'
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    await page.goto(`http://127.0.0.1:${port}/${scripts.outDir}/${scripts.entry}.html`, { waitUntil: 'load', timeout: 60000 })
    await page.waitForSelector(scripts.readySelector || 'body', { timeout: 30000 })
    if (pageErrors.length) {
      return { status: 'failed', errorKind: 'page_runtime', detail: `PAGE_ERROR: ${pageErrors[0]}` }
    }
    // 项目自定义 E2E spec（feature-key 模式）：worker 离线注入 input/test-specs，逐个执行；
    // spec 格式：ESM 默认导出 async function run({ page, baseURL })，业务断言自行编写
    const extraChecks = []
    // runDir 为空（直接调 smoke 原语的单测场景）时跳过 E2E 资产注入
    const specsDir = runDir ? join(runDir, 'input', 'test-specs') : null
    const shotDir = runDir ? join(runDir, 'output', 'screenshots') : null
    if (shotDir) {
      try { mkdirSync(shotDir, { recursive: true }) } catch { /* ignore */ }
    }
    /** E2E 分步截图：证明页面真实走过（artifact 打包 screenshots/，看板可预览）。
     *  全页长图（截到页面底）；超 8MB 自动回落视口截图（artifact 单文件上限 10MB）。 */
    const shot = async (label) => {
      if (!shotDir) return null
      const safe = String(label).replace(/[^\w.-]+/g, '_').slice(0, 60)
      const fileName = `${Date.now()}-${safe}.png`
      const file = join(shotDir, fileName)
      try {
        await page.screenshot({ path: file, fullPage: true })
        try {
          if (statSync(file).size > 8 * 1024 * 1024) await page.screenshot({ path: file, fullPage: false })
        } catch { /* ignore */ }
        return `screenshots/${fileName}`
      } catch { return null }
    }
    const origGoto = page.goto.bind(page)
    page.goto = async (url, opts) => {
      const r = await origGoto(url, opts)
      const pathPart = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/[^\w.-]+/g, '_').slice(0, 40)
      await shot(`goto${pathPart || '_root'}`)
      return r
    }
    /** E2E 操作级流水：包装 page/locator 的 click/fill/scroll/goto…，逐步落盘供看板追踪 */
    const actionLog = []
    instrumentPageActions(page, actionLog, shot)
    await shot(`smoke-${side}-app-ready`)
    actionLog.push({
      at: new Date().toISOString(),
      seq: actionLog.length + 1,
      action: 'app-ready',
      target: '#app',
      status: 'ok',
      detail: `smoke lane=${side}`,
    })
    phase = 'infra'
    if (specsDir && existsSync(join(specsDir, 'manifest.json'))) {
      // 容忍 UTF-8 BOM（Windows 工具链可能添加）
      const manifestRaw = readFileSync(join(specsDir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')
      const manifest = JSON.parse(manifestRaw)
      for (const s of manifest.specs || []) {
        const t0 = Date.now()
        let specStatus = 'passed'
        let specDetail = ''
        let specErrorKind = null
        const specStartSeq = actionLog.length
        actionLog.push({
          at: new Date().toISOString(),
          seq: actionLog.length + 1,
          action: 'spec-start',
          target: s.featureKey,
          status: 'ok',
          detail: s.entry || null,
          name: `开始执行考卷《${s.featureKey}》`,
          expected: '考卷 default run 可调用且断言通过',
        })
        await shot(`spec-${s.featureKey}-start`)
        try {
          const outcome = await executeE2eSpec({
            entry: join(specsDir, s.entry), page, baseURL: `http://127.0.0.1:${port}`, getExpect,
          })
          specStatus = outcome.status
          specErrorKind = outcome.errorKind || null
          if (outcome.status !== 'passed') throw new Error(outcome.detail)
          await shot(`spec-${s.featureKey}-pass`)
          actionLog.push({
            at: new Date().toISOString(),
            seq: actionLog.length + 1,
            action: 'spec-pass',
            target: s.featureKey,
            status: 'ok',
            durationMs: Date.now() - t0,
            name: `考卷《${s.featureKey}》执行通过`,
            expected: '全部断言通过',
            actual: '通过',
          })
        } catch (err) {
          if (!specErrorKind) {
            const failure = classifySmokeError(err)
            specStatus = failure.status
            specErrorKind = failure.errorKind
          }
          const rawMsg = `[${specErrorKind}] ${String(err.message || err)}`
          // DOM 诊断：截图有字≠DOM 有属性；把选择器命中情况写进 detail，避免盲改
          let probe = ''
          try {
            probe = await collectDomProbe(page, rawMsg)
          } catch { /* ignore */ }
          const trail = formatActionTrail(actionLog.slice(specStartSeq))
          specDetail = (rawMsg + (probe ? `\n${probe}` : '') + (trail ? `\n${trail}` : '')).slice(0, 1200)
          actionLog.push({
            at: new Date().toISOString(),
            seq: actionLog.length + 1,
            action: 'spec-fail',
            target: s.featureKey,
            status: 'failed',
            errorKind: specErrorKind,
            detail: rawMsg.slice(0, 300),
            durationMs: Date.now() - t0,
            name: `考卷《${s.featureKey}》执行失败`,
            expected: '全部断言通过',
            actual: rawMsg.slice(0, 200),
          })
          await shot(`spec-${s.featureKey}-fail`)
        }
        writeE2eActionLog(runDir, s.featureKey, actionLog.slice(specStartSeq))
        extraChecks.push({
          caseKey: `test:spec/${s.featureKey}`,
          status: specStatus,
          durationMs: Math.max(0, Date.now() - t0),
          ...(specDetail ? { detail: specDetail } : {}),
          ...(specErrorKind ? { errorKind: specErrorKind } : {}),
          actionCount: Math.max(0, actionLog.length - specStartSeq),
          title: `E2E 考卷《${s.featureKey}》`,
          expected: '页面断言全部通过（网络/数据/元素）',
          actual: specStatus === 'passed' ? '通过' : (specDetail || null),
          // 执行资产身份：与 binding 冻结清单逐条对齐（版本 + 内容 sha256），
          // 让「报告里跑的这卷」可被门禁追认，而不是只看一个 featureKey
          asset: { entry: s.entry || null, version: s.version ?? null, blobSha256: s.blobSha256 || null },
          // 变异验卷 run：回传暗题锚点/跳过原因，host 据此细分 killed/survived/not_covered（见 testing/leases.js）
          ...(mutationApplied && s.featureKey === mutationTargetFk ? { mutation: mutationApplied } : {}),
        })
      }
    }
    writeE2eActionLog(runDir, `${side}-lane`, actionLog)
    return { status: 'passed', extraChecks }
  } catch (err) {
    const extra = pageErrors.length ? ` | pageerror: ${String(pageErrors[0]).slice(0, 200)}` : ''
    return { ...classifySmokeError(err, { phase }), detail: `SMOKE_FAILED: ${err.message}${extra}` }
  } finally {
    if (browser) {
      try { await browser.close() } catch { /* 已退出 */ }
    }
    try { server.close() } catch { /* 未启动 */ }
  }
}

export { instrumentPageActions, writeE2eActionLog, formatActionTrail }

/**
 * 包装 page / locator 的用户操作 API，记录「点了什么、填了什么、滚到哪」。
 * 不改变 spec 写法：业务仍直接 page.click / locator.fill。
 */
function instrumentPageActions(page, actionLog, shot = null) {
  const record = async (action, target, args, fn) => {
    const started = Date.now()
    const entry = {
      at: new Date().toISOString(),
      seq: actionLog.length + 1,
      action,
      target: target == null ? null : String(target).slice(0, 200),
      status: 'ok',
    }
    if (args && args.length) {
      entry.args = args.map((a) => {
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return String(a).slice(0, 120)
        if (a == null) return null
        try { return JSON.stringify(a).slice(0, 160) } catch { return '[obj]' }
      }).filter((x) => x != null)
    }
    // 中文操作描述 + 预期结果（业界 AI 报告分步字段）
    try {
      entry.name = describeStep(entry)
      entry.expected = inferExpected(entry)
    } catch { /* ignore */ }
    actionLog.push(entry)
    try {
      const r = await fn()
      entry.durationMs = Date.now() - started
      if (shot && /^(click|fill|type|press|tap|check|uncheck|selectOption|goto)$/.test(action)) {
        try {
          const shotName = await shot(`act-${entry.seq}-${action}`)
          if (shotName) entry.evidence = { screenshot: shotName }
        } catch { /* ignore */ }
      }
      return r
    } catch (err) {
      entry.status = 'failed'
      entry.durationMs = Date.now() - started
      entry.detail = String(err.message || err).slice(0, 240)
      entry.actual = entry.detail
      throw err
    }
  }

  const PAGE_ACTIONS = [
    'goto', 'click', 'fill', 'type', 'press', 'check', 'uncheck',
    'selectOption', 'hover', 'focus', 'tap', 'setInputFiles',
    'waitForSelector', 'waitForURL', 'waitForLoadState', 'waitForTimeout',
    'waitForFunction', 'scrollIntoViewIfNeeded', 'evaluate', 'dragTo',
  ]
  for (const name of PAGE_ACTIONS) {
    if (typeof page[name] !== 'function') continue
    const orig = page[name].bind(page)
    page[name] = (...args) => {
      const target = args[0] && (typeof args[0] === 'string' || typeof args[0] === 'number')
        ? args[0]
        : name === 'goto'
          ? String(args[0] || '')
          : name
      return record(name, target, name === 'goto' ? [] : args.slice(1), () => orig(...args))
    }
  }

  const origLocator = typeof page.locator === 'function' ? page.locator.bind(page) : null
  if (origLocator) {
    page.locator = (selector, options) => {
      const loc = origLocator(selector, options)
      return wrapLocator(loc, selector, record)
    }
  }

  function wrapLocator(loc, selector, rec) {
    if (!loc || typeof loc !== 'object') return loc
    for (const name of ['click', 'fill', 'type', 'press', 'check', 'uncheck', 'tap', 'hover', 'focus', 'selectOption', 'scrollIntoViewIfNeeded', 'clear', 'setInputFiles']) {
      if (typeof loc[name] !== 'function') continue
      const orig = loc[name].bind(loc)
      loc[name] = (...args) => rec(`locator.${name}`, selector, args, () => orig(...args))
    }
    for (const chain of ['first', 'last', 'nth']) {
      if (typeof loc[chain] !== 'function') continue
      const origChain = loc[chain].bind(loc)
      loc[chain] = (...a) => wrapLocator(origChain(...a), selector, rec)
    }
    return loc
  }

  // getByText / getByRole / getByTestId 等也走 locator
  for (const factory of ['getByText', 'getByRole', 'getByTestId', 'getByLabel', 'getByPlaceholder', 'getByTitle', 'getByAltText']) {
    if (typeof page[factory] !== 'function') continue
    const origFactory = page[factory].bind(page)
    page[factory] = (...args) => wrapLocator(origFactory(...args), `${factory}(${String(args[0] || '').slice(0, 80)})`, record)
  }
}

function writeE2eActionLog(runDir, featureKey, steps) {
  if (!runDir || !Array.isArray(steps) || !steps.length) return
  try {
    const dir = join(runDir, 'output', 'logs')
    mkdirSync(dir, { recursive: true })
    const safe = String(featureKey).replace(/[^\w.-]+/g, '_').slice(0, 80)
    writeFileSync(join(dir, `e2e-actions-${safe}.json`), JSON.stringify({
      featureKey,
      count: steps.length,
      steps,
    }, null, 1), 'utf8')
  } catch { /* 日志失败不影响判卷 */ }
}

/** 失败 detail 里的操作轨迹摘要（最近 8 步，中文） */
function formatActionTrail(steps) {
  if (!steps?.length) return ''
  const recent = steps.slice(-8)
  const lines = recent.map((s, i) => {
    const n = steps.length - recent.length + i + 1
    const mark = s.status === 'failed' ? '✗' : s.action === 'spec-start' || s.action === 'spec-pass' ? '·' : '→'
    const label = s.name || s.action
    const args = s.args?.length ? ` ${s.args.join(' ')}` : ''
    const exp = s.expected && s.status === 'failed' ? ` ｜期望：${s.expected}` : ''
    const act = s.actual && s.status === 'failed' ? ` ｜实际：${String(s.actual).slice(0, 80)}` : ''
    return `${n}. ${mark} ${label}${args}${exp}${act}`
  })
  return `E2E 分步轨迹 last ${recent.length}/${steps.length}:\n${lines.join('\n')}`
}

/**
 * spec 失败时采集 DOM 证据，写入 check.detail（DOM_PROBE）。
 * 解决「截图可见但选择器空」：明确 URL、data-test 清单、选择器是否命中、组件库 Tab 文案。
 */
async function collectDomProbe(page, errMsg) {
  const selMatch = /\[data-test=["']([^"']+)["']\]/.exec(String(errMsg || ''))
  const probeSel = selMatch ? selMatch[1] : null
  const info = await page.evaluate((sel) => {
    const dataTests = [...document.querySelectorAll('[data-test]')]
      .slice(0, 40)
      .map((el) => el.getAttribute('data-test'))
    const tabs = [...document.querySelectorAll('[role="tab"]')]
      .slice(0, 12)
      .map((el) => (el.textContent || '').trim().slice(0, 20))
    const hit = sel ? document.querySelector(`[data-test="${sel}"]`) : null
    return {
      url: location.href,
      title: document.title,
      ready: document.readyState !== 'loading' && Boolean(document.body),
      dataTests,
      tabs,
      selector: sel,
      selectorHit: Boolean(hit),
      selectorVisible: hit
        ? !!(hit.offsetParent || hit.getClientRects().length)
        : false,
    }
  }, probeSel)
  return (
    'DOM_PROBE ' +
    JSON.stringify({
      url: info.url,
      appReady: info.ready,
      dataTest: info.dataTests,
      tabs: info.tabs,
      selector: info.selector,
      selectorHit: info.selectorHit,
      selectorVisible: info.selectorVisible,
    })
  )
}
