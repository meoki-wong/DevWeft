import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash, randomBytes, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { uuidv7 } from '../../testing/ids.js'
import { registerWorker } from '../../testing/bootstrap.js'

/** worker.crt 的 SHA-256 指纹（与 HTTPS peerCertificate().fingerprint256 同一算法/格式） */
export function certificateFingerprint256(certPem) {
  const cert = new X509Certificate(certPem)
  return createHash('sha256').update(cert.raw).digest('hex')
}

export async function loadOrCreateWorkerIdentity(db, {
  runnerRoot,
  hostname = 'localhost',
  certificatePem = null,
  certSearchPaths = [],
} = {}) {
  mkdirSync(runnerRoot, { recursive: true })
  const path = join(runnerRoot, 'worker-identity.json')
  let pem = certificatePem
  if (!pem) {
    for (const candidate of certSearchPaths) {
      if (existsSync(candidate)) {
        pem = readFileSync(candidate, 'utf8')
        break
      }
    }
  }
  const thumbprint = pem ? certificateFingerprint256(pem) : null
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const effectiveThumb = thumbprint || saved.certificateThumbprint
    const row = await registerWorker(db, {
      workerId: saved.workerId,
      certificateThumbprint: effectiveThumb,
      hostname: saved.hostname || hostname,
    })
    return await rebindIfRotated(db, saved.workerId, effectiveThumb, row)
  }
  const workerId = uuidv7()
  // 有 mTLS 证书用证书指纹；纯 dev 模式（无证书）才允许随机身份
  const certificateThumbprint = thumbprint
    || createHash('sha256').update(randomBytes(32)).digest('hex')
  const row = await registerWorker(db, { workerId, certificateThumbprint, hostname })
  writeFileSync(path, `${JSON.stringify({
    workerId: row.worker_id,
    certificateThumbprint: row.certificate_thumbprint,
    hostname: row.hostname,
  }, null, 2)}\n`)
  return row
}

/** worker_id 已存在但指纹不同（证书轮换/升级到证书身份）→ 重绑指纹，禁止 PK 冲突崩溃 */
async function rebindIfRotated(db, workerId, thumbprint, row) {
  if (row && row.certificate_thumbprint !== thumbprint) {
    await db.prepare(`UPDATE workers SET certificate_thumbprint=? WHERE worker_id=?`)
      .run(thumbprint, workerId)
    return await db.prepare('SELECT * FROM workers WHERE worker_id=?').get(workerId)
  }
  return row
}
