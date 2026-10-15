/**
 * npm 隔离代理：verdaccio(HTTP, 127.0.0.1:4873) + 自研 TLS 前置(192.168.250.1:443)。
 * verdaccio 5 已移除内置 HTTPS，guest 视角只看到 packages.example.invalid:443。
 */
import { existsSync, mkdirSync, writeFileSync, openSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execSync } from 'node:child_process'
import https from 'node:https'
import { issuePackagesProxyCert } from '../../scripts/gen-dev-pki.mjs'
import {
  PROXY_HOST, PROXY_IP, PROXY_PORT, DEFAULT_UPLINKS, REGISTRY_URL,
} from '../network/policy.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

export const VERDACCIO_INTERNAL_PORT = 4873
export const VERDACCIO_INTERNAL_LISTEN = `127.0.0.1:${VERDACCIO_INTERNAL_PORT}`

/** TLS+行为健康探测：验证 443 上的监听者是我们的 HTTPS 代理且具备 /npm/ 前缀剥离行为 */
function tlsHealthy(host, port, caPath, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const req = https.request({
      host, port, path: '/npm/-/ping', method: 'GET',
      ca: readFileSync(caPath),
      servername: PROXY_HOST,
      timeout: timeoutMs,
    }, (res) => {
      res.resume()
      finish(res.statusCode === 200)
      req.destroy()
    })
    req.on('error', () => finish(false))
    req.on('timeout', () => { req.destroy(); finish(false) })
    req.end()
  })
}

async function waitForTls(host, port, caPath, timeoutMs = 15000) {
  const started = Date.now()
  for (;;) {
    if (await tlsHealthy(host, port, caPath, 3000)) return
    if (Date.now() - started > timeoutMs) throw new Error(`npm proxy TLS 未就绪 ${host}:${port}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 结束占用隔离网卡代理端口的进程（lane 以管理员运行；只动 listenHost:listenPort 的监听者） */
function killPortOwner(host, port) {
  try {
    const script = `$c = Get-NetTCPConnection -LocalAddress '${host}' -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue; ` +
      `foreach ($p in ($c | Select-Object -ExpandProperty OwningProcess -Unique)) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Output ("killed " + $p) }`
    execSync(`powershell.exe -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { stdio: 'pipe' })
  } catch (err) {
    process.stderr.write(`killPortOwner: ${err.message}\n`)
  }
}

function waitPort(host, port, timeoutMs = 20000) {
  const started = Date.now()
  return new Promise((resolveWait, reject) => {
    const tryOnce = () => {
      const sock = createConnection({ host, port })
      sock.setTimeout(2000)
      sock.once('connect', () => {
        sock.destroy()
        resolveWait()
      })
      sock.once('timeout', () => {
        sock.destroy()
        retry()
      })
      sock.once('error', () => {
        sock.destroy()
        retry()
      })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`npm proxy 未在 ${host}:${port} 监听`))
        return
      }
      setTimeout(tryOnce, 300)
    }
    tryOnce()
  })
}

export function verdaccioYaml({ storage, listen, uplinks, htpasswd, packageRules = {} }) {
  return [
    `storage: ${storage.replace(/\\/g, '/')}`,
    `listen: ${listen}`,
    // 注意：verdaccio 5 的 url_prefix 不参与路由剥离，/npm/ 前缀由 tls-front 统一剥离
    'max_body_size: 100mb',
    'auth:',
    '  htpasswd:',
    `    file: ${htpasswd.replace(/\\/g, '/')}`,
    '    max_users: -1',
    'uplinks:',
    ...Object.entries(uplinks).flatMap(([name, url]) => [
      `  ${name}:`,
      `    url: ${url}`,
      '    timeout: 30s',
    ]),
    'packages:',
    ...Object.entries(packageRules).flatMap(([pattern, uplink]) => [
      `  '${pattern}':`,
      '    access: $all',
      '    publish: $authenticated',
      `    proxy: ${uplink}`,
    ]),
    "  '**':",
    '    access: $all',
    '    publish: $authenticated',
    `    proxy: ${Object.hasOwn(uplinks, 'npmjs') ? 'npmjs' : Object.keys(uplinks)[0] || 'npmjs'}`,
    'logs: { type: stdout, format: pretty, level: warn }',
    'web:',
    '  enable: false',
    '',
  ].join('\n')
}

function envJson(name, fallback) {
  if (!process.env[name]) return fallback
  try {
    const value = JSON.parse(process.env[name])
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`)
  }
}

export function verdaccioPresent(proxyRoot = here) {
  return existsSync(join(proxyRoot, 'node_modules', 'verdaccio', 'package.json'))
    || existsSync(join(proxyRoot, 'node_modules', 'verdaccio', 'bin', 'verdaccio'))
}

function findVerdaccioCli(proxyRoot = here) {
  const candidates = [
    join(proxyRoot, 'node_modules', 'verdaccio', 'bin', 'verdaccio'),
    join(proxyRoot, 'node_modules', 'verdaccio', 'build', 'lib', 'cli.js'),
    join(proxyRoot, 'node_modules', 'verdaccio', 'build', 'lib', 'cli', 'cli.js'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('未安装 verdaccio。请在 runner/npm-proxy 执行 npm ci')
}

export function npmInstallErrorMessage(r, output) {
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || /TIMEDOUT/i.test(String(r.error)))
  const useful = String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/npm warn deprecated/i.test(line))
    .join('\n')
    .trim()
  if (timedOut) {
    return `runner/npm-proxy npm 安装超时。${useful ? `\n${useful}` : '请再跑一次 Static Lane（deprecated 警告可忽略）。'}`
  }
  const code = r.status == null ? 'null' : String(r.status)
  return `runner/npm-proxy npm 安装失败 exit=${code}${r.signal ? ` signal=${r.signal}` : ''}${useful ? `:\n${useful}` : ''}`
}

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function ensureNpmProxyInstalled(proxyRoot = here) {
  if (verdaccioPresent(proxyRoot)) return
  const lock = existsSync(join(proxyRoot, 'package-lock.json'))
  const args = lock
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund']
  process.stdout.write(`安装宿主 npm 代理（${args[0]}，可能需要几分钟；npm deprecated 警告可忽略）\n`)
  const r = spawnSync(npmBin(), args, {
    cwd: proxyRoot,
    encoding: 'utf8',
    timeout: 600000,
    windowsHide: true,
    shell: process.platform === 'win32',
  })
  if (verdaccioPresent(proxyRoot)) return
  throw new Error(npmInstallErrorMessage(r, `${r.stdout || ''}\n${r.stderr || ''}`))
}

export async function ensureNpmProxyListening({
  runnerRoot = 'C:\\awp-runner',
  caDir = join(repoRoot, 'secret-broker', 'dev-certs'),
  listenHost = PROXY_IP,
  listenPort = PROXY_PORT,
  uplinks = envJson('AWP_NPM_UPLINKS', DEFAULT_UPLINKS),
  packageRules = envJson('AWP_NPM_PACKAGE_RULES', {}),
} = {}) {
  if (!existsSync(join(caDir, 'ca.key'))) {
    throw new Error(`缺少 CA 私钥 ${join(caDir, 'ca.key')}，请先一键部署生成 PKI`)
  }
  ensureNpmProxyInstalled(here)
  const dataRoot = join(runnerRoot, 'npm-proxy')
  const certDir = join(dataRoot, 'certs')
  const storage = join(dataRoot, 'storage')
  mkdirSync(storage, { recursive: true })
  mkdirSync(certDir, { recursive: true })
  const issued = issuePackagesProxyCert(caDir, certDir, {
    dnsNames: [PROXY_HOST],
    ips: [listenHost],
  })
  const htpasswd = join(dataRoot, 'htpasswd')
  if (!existsSync(htpasswd)) writeFileSync(htpasswd, '')
  const configPath = join(dataRoot, 'config.yaml')
  // verdaccio 5 已移除内置 HTTPS：verdaccio 只在回环 HTTP 上服务，443 由我们的 TLS 前置代理对外
  writeFileSync(configPath, verdaccioYaml({
    storage,
    listen: VERDACCIO_INTERNAL_LISTEN,
    uplinks,
    htpasswd,
    packageRules,
  }))

  try {
    await waitPort(listenHost, listenPort, 1500)
    // 复用前必须验证 TLS：隔离网 443 上可能是陈旧的明文/证书不符进程，直接复用会让 Guest 探测失败
    if (await tlsHealthy(listenHost, listenPort, issued.caPath)) {
      return { reused: true, listen: `${listenHost}:${listenPort}`, registry: REGISTRY_URL, caPath: issued.caPath, configPath }
    }
    process.stdout.write(`npm proxy: 端口 ${listenHost}:${listenPort} 被非 TLS/证书不符进程占用，自愈重启\n`)
    killPortOwner(listenHost, listenPort)
    killPortOwner('127.0.0.1', VERDACCIO_INTERNAL_PORT)
    await new Promise((r) => setTimeout(r, 2000))
  } catch {
    // not up yet
  }

  const logPath = join(dataRoot, 'verdaccio.log')
  const logFd = openSync(logPath, 'a')
  const cli = findVerdaccioCli(here)
  const child = spawn(process.execPath, [cli, '--config', configPath], {
    cwd: dataRoot,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env, VERDACCIO_HANDLE_KILL_SIGNALS: 'false' },
  })
  child.unref()
  writeFileSync(join(dataRoot, 'verdaccio.pid'), String(child.pid))
  await waitPort('127.0.0.1', VERDACCIO_INTERNAL_PORT, 25000)

  // TLS 前置代理：guest 视角的 packages.example.invalid:443（§10.1 受控出口）
  const frontLog = openSync(join(dataRoot, 'tls-front.log'), 'a')
  const front = spawn(process.execPath, [
    join(here, 'tls-front.mjs'),
    '--host', listenHost, '--port', String(listenPort),
    '--target-host', '127.0.0.1', '--target-port', String(VERDACCIO_INTERNAL_PORT),
    '--cert', issued.certPath, '--key', issued.keyPath,
  ], {
    cwd: dataRoot,
    detached: true,
    stdio: ['ignore', frontLog, frontLog],
    windowsHide: true,
  })
  front.unref()
  await waitPort(listenHost, listenPort, 15000)
  await waitForTls(listenHost, listenPort, issued.caPath, 15000)
  return {
    reused: false,
    pid: front.pid,
    verdaccioPid: child.pid,
    listen: `${listenHost}:${listenPort}`,
    registry: REGISTRY_URL,
    caPath: issued.caPath,
    configPath,
    logPath,
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  ensureNpmProxyListening().then((out) => {
    process.stdout.write(`NPM_PROXY_OK reused=${out.reused} ${out.listen}\n`)
  }).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`)
    process.exit(1)
  })
}
