/**
 * Independent secret broker HTTP process.
 * Requires mTLS. Does not import control-plane db.js.
 *
 * Env:
 *   AWP_BROKER_PORT
 *   AWP_BROKER_DB
 *   AWP_BROKER_TLS_CERT / AWP_BROKER_TLS_KEY / AWP_BROKER_TLS_CA
 *   AWP_BROKER_TRUST_FILE  JSON { controlPlaneThumbprints[], workers:[{workerId,thumbprint}] }
 */
import fs from 'node:fs'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import express from 'express'
import {
  openBrokerDb,
  createGrant,
  fetchGrant,
  revokeGrant,
  BrokerError,
} from './store.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

export function loadTrust(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (!Array.isArray(raw.controlPlaneThumbprints) || !Array.isArray(raw.workers)) {
    throw new Error('invalid trust file')
  }
  return raw
}

export function certThumbprint(cert) {
  const der = cert.raw ? cert.raw : cert
  return createHash('sha256').update(der).digest('hex')
}

export function identityFromCert(trust, thumbprint) {
  const tp = String(thumbprint).toLowerCase()
  if (trust.controlPlaneThumbprints.map((x) => String(x).toLowerCase()).includes(tp)) {
    return { kind: 'control_plane' }
  }
  const worker = trust.workers.find((w) => String(w.thumbprint).toLowerCase() === tp)
  if (worker) return { kind: 'worker', workerId: worker.workerId }
  return null
}

function envelope(data, error, requestId) {
  return { data, error, meta: { requestId: requestId || null } }
}

export function createBrokerApp({ db, trust }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '32kb' }))
  app.use((req, res, next) => {
    req.brokerRequestId = cryptoRandomUuid()
    const cert = req.socket.getPeerCertificate?.(true)
    if (!cert || !cert.raw) {
      res.status(401).json(envelope(null, { code: 'GRANT_IDENTITY_MISMATCH' }, req.brokerRequestId))
      return
    }
    req.brokerIdentity = identityFromCert(trust, certThumbprint(cert))
    if (!req.brokerIdentity) {
      res.status(403).json(envelope(null, { code: 'GRANT_IDENTITY_MISMATCH' }, req.brokerRequestId))
      return
    }
    next()
  })

  app.post('/v1/grants', (req, res) => {
    if (req.brokerIdentity.kind !== 'control_plane') {
      fail(res, req, new BrokerError('GRANT_IDENTITY_MISMATCH'))
      return
    }
    try {
      const data = createGrant(db, req.body)
      res.json(envelope(data, null, req.brokerRequestId))
    } catch (err) {
      fail(res, req, err)
    }
  })

  app.use((req, res, next) => {
    const fetchM = req.path.match(/^\/v1\/grants\/([^/]+):fetch$/)
    const revokeM = req.path.match(/^\/v1\/grants\/([^/]+):revoke$/)
    if (req.method === 'POST' && fetchM) {
      handleFetch(req, res, db, fetchM[1])
      return
    }
    if (req.method === 'POST' && revokeM) {
      handleRevoke(req, res, db, revokeM[1])
      return
    }
    next()
  })

  app.use((_req, res) => {
    res.status(404).json(envelope(null, { code: 'GRANT_NOT_FOUND' }, _req.brokerRequestId))
  })
  return app
}

function handleFetch(req, res, db, secretGrantId) {
  if (req.brokerIdentity.kind !== 'worker') {
    fail(res, req, new BrokerError('GRANT_IDENTITY_MISMATCH'))
    return
  }
  try {
    if (req.body?.workerId && req.body.workerId !== req.brokerIdentity.workerId) {
      throw new BrokerError('GRANT_IDENTITY_MISMATCH')
    }
    const data = fetchGrant(db, { ...req.body, secretGrantId, workerId: req.brokerIdentity.workerId })
    res.json(envelope(data, null, req.brokerRequestId))
  } catch (err) {
    fail(res, req, err)
  }
}

function handleRevoke(req, res, db, secretGrantId) {
  if (req.brokerIdentity.kind !== 'worker') {
    fail(res, req, new BrokerError('GRANT_IDENTITY_MISMATCH'))
    return
  }
  try {
    if (req.body?.workerId && req.body.workerId !== req.brokerIdentity.workerId) {
      throw new BrokerError('GRANT_IDENTITY_MISMATCH')
    }
    const data = revokeGrant(db, { ...req.body, secretGrantId, workerId: req.brokerIdentity.workerId })
    res.json(envelope(data, null, req.brokerRequestId))
  } catch (err) {
    fail(res, req, err)
  }
}

function fail(res, req, err) {
  if (err instanceof BrokerError) {
    res.status(err.httpStatus).json(envelope(null, { code: err.code }, req.brokerRequestId))
    return
  }
  res.status(500).json(envelope(null, { code: 'INVALID_SCHEMA' }, req.brokerRequestId))
}

function cryptoRandomUuid() {
  return globalThis.crypto.randomUUID()
}

export function requiredTlsEnv(env = process.env) {
  const cert = env.AWP_BROKER_TLS_CERT
  const key = env.AWP_BROKER_TLS_KEY
  const ca = env.AWP_BROKER_TLS_CA
  const trust = env.AWP_BROKER_TRUST_FILE
  if (!cert || !key || !ca || !trust) {
    return null
  }
  return { cert, key, ca, trust }
}

export function startBroker(env = process.env) {
  const tls = requiredTlsEnv(env)
  if (!tls) {
    process.stderr.write(
      'secret-broker: AWP_BROKER_TLS_CERT/KEY/CA and AWP_BROKER_TRUST_FILE are required\n'
    )
    process.exit(2)
  }
  const dbPath = env.AWP_BROKER_DB || path.join(ROOT, 'data', 'secret-broker.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = openBrokerDb(dbPath)
  const trust = loadTrust(tls.trust)
  const app = createBrokerApp({ db, trust })
  const server = https.createServer(
    {
      cert: fs.readFileSync(tls.cert),
      key: fs.readFileSync(tls.key),
      ca: fs.readFileSync(tls.ca),
      requestCert: true,
      rejectUnauthorized: true,
    },
    app
  )
  const port = Number(env.AWP_BROKER_PORT || 8788)
  server.on('error', (err) => {
    process.stderr.write(`secret-broker listen error: ${err.message}\n`)
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`secret-broker listening https://127.0.0.1:${port}\n`)
  })
  return server
}

export function shouldAutostartBroker({
  env = process.env,
  argv1 = process.argv[1],
  self = fileURLToPath(import.meta.url),
} = {}) {
  if (env.AWP_BROKER_NO_LISTEN === '1') return false
  if (argv1) {
    try {
      const a = path.normalize(path.resolve(argv1)).toLowerCase()
      const b = path.normalize(self).toLowerCase()
      if (a === b) return true
    } catch {
      /* ignore invalid argv */
    }
  }
  if (env.AWP_BROKER_AUTOSTART === '1') return true
  if (env.pm_id != null && String(env.pm_id).length > 0) return true
  return false
}

if (shouldAutostartBroker()) startBroker()
