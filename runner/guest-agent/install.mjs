import { existsSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import https from 'node:https'
import { writeNpmrc, deleteNpmrc } from './unbundle.mjs'

const INSTALL_TIMEOUT_MS = 900000
// vitest 补装超时（依赖树小，走同一代理，正常 30~60s）
const VITEST_INSTALL_TIMEOUT_MS = 300000
// Keep the bundled Vitest version compatible with the supported Vite toolchain.
const VITEST_VERSION = '0.34.6'

function findNamedPackage(dir, pkgName, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    if (name === pkgName && existsSync(join(p, 'package.json'))) {
      try {
        const n = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).name
        if (n === pkgName) acc.push(p)
      } catch { /* skip */ }
    }
    findNamedPackage(p, pkgName, acc)
  }
  return acc
}

export function assertPackageLockPresent(workspaceDir) {
  const pkg = join(workspaceDir, 'package.json')
  const lock = join(workspaceDir, 'package-lock.json')
  if (!existsSync(pkg) || !existsSync(lock)) throw new Error('dependency_input')
  JSON.parse(readFileSync(pkg, 'utf8'))
  JSON.parse(readFileSync(lock, 'utf8'))
  if (existsSync(join(workspaceDir, 'pnpm-lock.yaml')) && !existsSync(lock)) {
    throw new Error('dependency_input')
  }
}

export function probeRegistry(registryUrl, caPem) {
  return new Promise((resolve, reject) => {
    const url = new URL(registryUrl)
    // 探测健康端点（/-/ping 不触发上游拉取）；registry 根路径受 url_prefix/上游影响不适合探活
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: '/-/ping',
      method: 'GET',
      ca: caPem,
      servername: url.hostname,
      timeout: 8000,
    }, (res) => {
      res.resume()
      if (res.statusCode && res.statusCode >= 500) {
        reject(new Error(`PRIVATE_REGISTRY_UNAVAILABLE: HTTP ${res.statusCode}`))
        return
      }
      resolve()
    })
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('PRIVATE_REGISTRY_UNAVAILABLE: timeout'))
    })
    req.on('error', (err) => reject(new Error(`PRIVATE_REGISTRY_UNAVAILABLE: ${err.message}`)))
    req.end()
  })
}

// guest 首启时 hosts/DNS 偶发未及时生效，探活会撞 getaddrinfo ENOENT 这类一次性竞态；
// 直接判失败会反复制造 infra_error（历史 static run 高频栽在此）。重试前先 flushdns，
// 仅对“连不上/解析失败”类瞬时错误重试；HTTP 5xx 等确定性错误不重试，保留快速失败。
export async function probeRegistryUntilReady(registryUrl, caPem, { attempts = 8, delayMs = 1500 } = {}) {
  let lastErr = null
  for (let i = 1; i <= attempts; i++) {
    try {
      await probeRegistry(registryUrl, caPem)
      return
    } catch (err) {
      lastErr = err
      const transient = /ENOENT|getaddrinfo|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|timeout|socket hang up|Temporary failure/i.test(String(err && err.message || err))
      if (!transient || i === attempts) break
      try { spawnSync('ipconfig.exe', ['/flushdns'], { windowsHide: true }) } catch { /* flush 失败不阻断重试 */ }
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

function runEsbuildVersion(dir) {
  const exe = join(dir, 'bin', 'esbuild.exe')
  if (existsSync(exe)) return spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000 })
  const js = join(dir, 'bin', 'esbuild')
  if (existsSync(js)) return spawnSync(process.execPath, [js, '--version'], { encoding: 'utf8', timeout: 30000 })
  return { status: 1, stdout: '', stderr: 'missing esbuild bin' }
}

export function restoreEsbuild(workspaceDir) {
  const lockPath = join(workspaceDir, 'package-lock.json')
  if (!existsSync(lockPath)) return
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const wants = Object.keys(lock.packages || {}).some((p) => /(^|\/)node_modules\/esbuild$/.test(p))
  if (!wants) return
  const dirs = findNamedPackage(join(workspaceDir, 'node_modules'), 'esbuild')
  if (!dirs.length) throw new Error('dependency_input')
  for (const dir of dirs) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const native = join(dir, '..', '@esbuild', 'win32-x64')
    const nested = join(workspaceDir, 'node_modules', '@esbuild', 'win32-x64')
    if (!existsSync(join(native, 'package.json')) && !existsSync(join(nested, 'package.json'))) {
      throw new Error('dependency_input')
    }
    const r = runEsbuildVersion(dir)
    const out = String(r.stdout || '').trim()
    if (r.status !== 0 || (pkg.version && out && out !== pkg.version)) throw new Error('dependency_input')
  }
}

// Rewrite package-lock resolved URLs to the configured package proxy so isolated guests do not
// depend on registry origins that are unreachable from the worker network.
function rewriteLockResolvedToRegistry(workspaceDir, registry) {
  const lockPath = join(workspaceDir, 'package-lock.json')
  if (!existsSync(lockPath)) return 0
  const reg = new URL(registry)
  const base = reg.origin + reg.pathname.replace(/\/$/, '')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  let n = 0
  const fix = (obj) => {
    for (const key of Object.keys(obj)) {
      const v = obj[key]
      if (!v || typeof v !== 'object') continue
      if (typeof v.resolved === 'string' && v.resolved.startsWith('http')) {
        try {
          const u = new URL(v.resolved)
          if (u.origin !== reg.origin) {
            // npm 老式 tarball 的 pathname 自带 /npm/ 前缀（如 /npm/zrender/-/...），
            // 与 registry 的 /npm 前缀叠加会产生 /npm/npm/... 404，必须剥除重复段
            const prefix = reg.pathname.replace(/\/$/, '')
            let p = u.pathname
            if (prefix && p.startsWith(prefix + '/')) p = '/' + p.slice(prefix.length + 1)
            v.resolved = base + p + u.search
            n++
          }
        } catch { /* 保留原值 */ }
      }
      fix(v)
    }
  }
  fix(lock)
  if (n > 0) writeFileSync(lockPath, JSON.stringify(lock, null, 2))
  return n
}

export async function runNpmCiHardened({ workspaceDir, proxy, timeoutMs = INSTALL_TIMEOUT_MS }) {
  assertPackageLockPresent(workspaceDir)
  rewriteLockResolvedToRegistry(workspaceDir, proxy.registry)
  const caPem = proxy.cafile && existsSync(proxy.cafile) ? readFileSync(proxy.cafile, 'utf8') : undefined
  await probeRegistryUntilReady(proxy.registry, caPem)
  writeNpmrc(workspaceDir, { registry: proxy.registry, cafile: proxy.cafile })
  try {
    // 不用 spawnSync+shell+timeout：Windows 上超时只杀 cmd 外壳，孙进程 npm 存活并持有
    // 管道导致 spawnSync 永久挂起；改为异步 spawn + taskkill /T /F 整树击杀
    const r = await new Promise((resolve) => {
      const child = spawn('npm', [
        'ci', '--ignore-scripts', '--no-audit', '--fund=false',
      ], {
        cwd: workspaceDir,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: {
          ...process.env,
          npm_config_registry: proxy.registry,
          npm_config_fund: 'false',
          NODE_EXTRA_CA_CERTS: proxy.cafile || process.env.NODE_EXTRA_CA_CERTS,
        },
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            child.kill('SIGKILL')
          }
        } catch { /* 已退出 */ }
      }, timeoutMs)
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ status: code, signal, stdout, stderr, timedOut })
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ status: null, signal: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut })
      })
    })
    if (r.status !== 0 || r.timedOut) {
      const msg = `${r.stderr || ''}\n${r.stdout || ''}`
      const tail = msg.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n')
      if (/ECONNREFUSED|ENOTFOUND|UNABLE_TO_VERIFY|certificate|registry/i.test(msg)) {
        throw new Error(`PRIVATE_REGISTRY_UNAVAILABLE: npm ci exit=${r.status}${r.timedOut ? ' (timeout)' : ''}\n${tail}`)
      }
      throw new Error(`dependency_input: npm ci exit=${r.status}${r.timedOut ? ' (timeout)' : ''}\n${tail}`)
    }
    restoreEsbuild(workspaceDir)
  } finally {
    deleteNpmrc(workspaceDir)
    const cacache = join(workspaceDir, '.npm')
    if (existsSync(cacache)) rmSync(cacache, { recursive: true, force: true })
  }
}

/**
 * 零接入单测运行时判定：测试资产存服务端、业务仓不为此加 devDependency。
 * 仅 static unit 且本 run 选中了 test:static/vitest case、存在待跑 unit 资产、
 * 且业务仓自己没装 vitest 时才需要平台补装；业务仓自行声明后以业务仓版本为准（平滑让位）。
 * 体量不参与判定：S 级同样要跑（"体量小" 不等于 "允许单测空跑"）。
 */
export function needsVitestRuntime({ workspaceDir, runDir, unit, cases }) {
  if (unit !== 'static') return false
  if (!(cases || []).some((c) => c.caseKey === 'test:static/vitest')) return false
  if (existsSync(join(workspaceDir, 'node_modules', 'vitest', 'vitest.mjs'))) return false
  const manifestPath = join(runDir, 'input', 'test-specs', 'unit', 'manifest.json')
  if (!existsSync(manifestPath)) return false
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
  if (!Array.isArray(manifest.specs) || !manifest.specs.length) return false
  return true
}

/**
 * 平台补装 vitest 运行时（复用 npm ci 同款代理/.npmrc 通道）。
 * --no-save 不动业务 package.json/lock；--legacy-peer-deps 防止老项目历史 peer 冲突干扰。
 * 失败不抛错：由 static.mjs 的 vitestBin 检查报 VITEST_UNAVAILABLE check 级 error（醒目但不判 infra）。
 */
export async function ensureVitestRuntime({ workspaceDir, proxy, timeoutMs = VITEST_INSTALL_TIMEOUT_MS }) {
  if (existsSync(join(workspaceDir, 'node_modules', 'vitest', 'vitest.mjs'))) return { installed: false, reason: 'already-present' }
  writeNpmrc(workspaceDir, { registry: proxy.registry, cafile: proxy.cafile })
  try {
    const r = await new Promise((resolve) => {
      const child = spawn('npm', [
        'i', '--no-save', '--ignore-scripts', '--no-audit', '--fund=false', '--legacy-peer-deps',
        `vitest@${VITEST_VERSION}`,
      ], {
        cwd: workspaceDir,
        shell: process.platform === 'win32',
        windowsHide: true,
        env: {
          ...process.env,
          npm_config_registry: proxy.registry,
          npm_config_fund: 'false',
          NODE_EXTRA_CA_CERTS: proxy.cafile || process.env.NODE_EXTRA_CA_CERTS,
        },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            child.kill('SIGKILL')
          }
        } catch { /* 已退出 */ }
      }, timeoutMs)
      child.stdout.on('data', (c) => { stdout += c })
      child.stderr.on('data', (c) => { stderr += c })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }) })
      child.on('error', (err) => { clearTimeout(timer); resolve({ status: null, stdout, stderr: `${stderr}\n${err.message}` }) })
    })
    const ok = r.status === 0 && existsSync(join(workspaceDir, 'node_modules', 'vitest', 'vitest.mjs'))
    return { installed: ok, version: VITEST_VERSION, log: `${r.stderr || ''}\n${r.stdout || ''}`.split(/\r?\n/).filter((l) => l.trim()).slice(-8).join('\n') }
  } finally {
    deleteNpmrc(workspaceDir)
  }
}

