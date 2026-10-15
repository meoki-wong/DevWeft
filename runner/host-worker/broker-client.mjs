/**
 * Broker mTLS 客户端（§14.10）：
 *   controlPlane —— POST /v1/grants（control-plane 机器身份）
 *   worker       —— :fetch / :revoke（worker 机器身份，明文只在 worker 内存）
 */
import https from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

function loadPki(pkiDir) {
  const ca = readFileSync(join(pkiDir, 'ca.crt'))
  return {
    ca,
    controlPlane: {
      cert: readFileSync(join(pkiDir, 'control-plane.crt')),
      key: readFileSync(join(pkiDir, 'control-plane.key')),
    },
    worker: {
      cert: readFileSync(join(pkiDir, 'worker.crt')),
      key: readFileSync(join(pkiDir, 'worker.key')),
    },
  }
}

function requestJson({ url, path, method = 'POST', body, pki, role }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = https.request(url + path, {
      method,
      ca: pki.ca,
      cert: pki[role].cert,
      key: pki[role].key,
      // dev PKI 手写 X.509 无法通过 Node 严格链校验；broker 端按 thumbprint 白名单钉扎身份
      rejectUnauthorized: false,
      // 禁止 keep-alive 复用：一次连接一种 mTLS 身份，杜绝跨身份复用同一条 TLS 连接
      agent: false,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(data || '{}')
        } catch {
          reject(new Error(`BROKER_BAD_RESPONSE ${res.statusCode}`))
          return
        }
        if (res.statusCode >= 400) {
          reject(new Error(parsed?.error?.code || `BROKER_HTTP_${res.statusCode}`))
          return
        }
        resolve(parsed.data ?? parsed)
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 返回 { controlPlane: { createGrant }, worker: { fetchGrant, revokeGrant } }。
 * brokerUrl 缺省 https://127.0.0.1:8788；pkiDir 缺省仓库 dev-certs。
 */
export function createBrokerTransports({ pkiDir, brokerUrl } = {}) {
  const defaultDir = join(fileURLToPath(new URL('../../secret-broker/dev-certs/', import.meta.url)))
  const dir = pkiDir && existsSync(join(pkiDir, 'ca.crt')) ? pkiDir : defaultDir
  const pki = loadPki(dir)
  const base = brokerUrl || process.env.AWP_BROKER_URL || 'https://127.0.0.1:8788'
  return {
    controlPlane: {
      createGrant: (grant) => requestJson({
        url: base, path: '/v1/grants', body: grant, pki, role: 'controlPlane',
      }),
    },
    worker: {
      fetchGrant: (q) => requestJson({
        url: base,
        path: `/v1/grants/${encodeURIComponent(q.secretGrantId)}:fetch`,
        body: {
          workerId: q.workerId, leaseId: q.leaseId, capability: q.capability,
        },
        pki, role: 'worker',
      }),
      revokeGrant: (q) => requestJson({
        url: base,
        path: `/v1/grants/${encodeURIComponent(q.secretGrantId)}:revoke`,
        body: { workerId: q.workerId, leaseId: q.leaseId },
        pki, role: 'worker',
      }),
    },
  }
}
