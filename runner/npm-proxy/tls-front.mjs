/**
 * npm 代理 TLS 前置（verdaccio 5 无内置 HTTPS）：
 *   guest -> packages.example.invalid:443 (TLS, 本进程) -> 127.0.0.1:4873 (verdaccio HTTP)
 * 双向流式转发，无新增依赖。
 */
import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const host = arg('--host', '192.168.250.1')
const port = Number(arg('--port', '443'))
const targetHost = arg('--target-host', '127.0.0.1')
const targetPort = Number(arg('--target-port', '4873'))
const certPath = arg('--cert')
const keyPath = arg('--key')

const server = https.createServer({
  cert: readFileSync(certPath),
  key: readFileSync(keyPath),
}, (req, res) => {
  // 公司 lockfile 的 resolved URL 带 /npm/ 前缀（packages.example.invalid/npm/...），
  // verdaccio 5 不剥离 url_prefix → 在前置代理统一剥离，兼容两种地址形式
  let upstreamPath = req.url
  if (upstreamPath === '/npm') upstreamPath = '/'
  else if (upstreamPath.startsWith('/npm/')) upstreamPath = upstreamPath.slice(4)
  const upstream = http.request({
    host: targetHost,
    port: targetPort,
    path: upstreamPath,
    method: req.method,
    headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`npm proxy upstream error: ${err.message}`)
  })
  req.pipe(upstream)
})
server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') } catch { }
})
server.listen(port, host, () => {
  process.stdout.write(`tls-front listening https://${host}:${port} -> http://${targetHost}:${targetPort}\n`)
})
