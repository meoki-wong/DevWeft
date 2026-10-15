/**
 * Independent secret broker store.
 * Plaintext never leaves this SQLite except via fetchGrant once.
 */
import Database from 'better-sqlite3'

export const GRANT_TTL_MAX_MS = 15 * 60 * 1000

const GRANT_HTTP = {
  GRANT_NOT_FOUND: 404,
  GRANT_ALREADY_FETCHED: 409,
  GRANT_REVOKED: 409,
  GRANT_EXPIRED: 409,
  GRANT_IDENTITY_MISMATCH: 403,
  SECRET_REF_UNKNOWN: 404,
  INVALID_SCHEMA: 400,
  UNKNOWN_FIELD: 400,
}

export class BrokerError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BrokerError'
    this.code = code
    this.httpStatus = GRANT_HTTP[code] || 400
  }
}

export function openBrokerDb(filePath) {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS secrets (
      secret_ref TEXT PRIMARY KEY,
      plaintext  TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grants (
      secret_grant_id TEXT PRIMARY KEY,
      secret_ref      TEXT NOT NULL REFERENCES secrets(secret_ref),
      worker_id       TEXT NOT NULL,
      lease_id        TEXT NOT NULL,
      capability      TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('issued','fetched','revoked','expired')),
      issued_at       TEXT NOT NULL,
      expires_at      TEXT NOT NULL,
      fetched_at      TEXT,
      revoked_at      TEXT
    );
  `)
  return db
}

export function putSecret(db, secretRef, plaintext, now = new Date()) {
  if (!secretRef || typeof secretRef !== 'string') throw new BrokerError('INVALID_SCHEMA')
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new BrokerError('INVALID_SCHEMA')
  db.prepare(
    `INSERT INTO secrets(secret_ref, plaintext, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(secret_ref) DO UPDATE SET plaintext=excluded.plaintext, created_at=excluded.created_at`
  ).run(secretRef, plaintext, now.toISOString())
}

const GRANT_FIELDS = ['secretGrantId', 'secretRef', 'workerId', 'leaseId', 'capability', 'expiresAt']

export function createGrant(db, body, now = new Date()) {
  rejectUnknown(body, GRANT_FIELDS)
  for (const key of GRANT_FIELDS) {
    if (typeof body[key] !== 'string' || !body[key]) throw new BrokerError('INVALID_SCHEMA')
  }
  const expiresAt = Date.parse(body.expiresAt)
  if (!Number.isFinite(expiresAt)) throw new BrokerError('INVALID_SCHEMA')
  if (expiresAt - now.getTime() > GRANT_TTL_MAX_MS) throw new BrokerError('INVALID_SCHEMA')
  if (expiresAt <= now.getTime()) throw new BrokerError('INVALID_SCHEMA')

  const secret = db.prepare('SELECT secret_ref FROM secrets WHERE secret_ref = ?').get(body.secretRef)
  if (!secret) throw new BrokerError('SECRET_REF_UNKNOWN')

  try {
    db.prepare(
      `INSERT INTO grants(
         secret_grant_id, secret_ref, worker_id, lease_id, capability,
         status, issued_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'issued', ?, ?)`
    ).run(
      body.secretGrantId,
      body.secretRef,
      body.workerId,
      body.leaseId,
      body.capability,
      now.toISOString(),
      new Date(expiresAt).toISOString()
    )
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new BrokerError('INVALID_SCHEMA')
    throw err
  }
  return { secretGrantId: body.secretGrantId, status: 'issued' }
}

export function fetchGrant(db, body, now = new Date()) {
  rejectUnknown(body, ['secretGrantId', 'workerId', 'leaseId', 'capability'])
  const grant = loadGrant(db, body.secretGrantId)
  assertIdentity(grant, body)
  assertUsable(grant, now)
  if (grant.status === 'fetched') throw new BrokerError('GRANT_ALREADY_FETCHED')
  const cas = db.prepare(
    `UPDATE grants SET status='fetched', fetched_at=? WHERE secret_grant_id=? AND status='issued'`
  ).run(now.toISOString(), grant.secret_grant_id)
  if (cas.changes !== 1) throw new BrokerError('GRANT_ALREADY_FETCHED')
  const secret = db.prepare('SELECT plaintext FROM secrets WHERE secret_ref = ?').get(grant.secret_ref)
  return {
    secretRef: grant.secret_ref,
    plaintext: secret.plaintext,
    expiresAt: grant.expires_at,
  }
}

export function revokeGrant(db, body, now = new Date()) {
  rejectUnknown(body, ['secretGrantId', 'workerId', 'leaseId'])
  const grant = loadGrant(db, body.secretGrantId)
  if (grant.worker_id !== body.workerId || grant.lease_id !== body.leaseId) {
    throw new BrokerError('GRANT_IDENTITY_MISMATCH')
  }
  if (grant.status === 'revoked') return { secretGrantId: grant.secret_grant_id, status: 'revoked' }
  db.prepare(
    `UPDATE grants SET status='revoked', revoked_at=? WHERE secret_grant_id=?`
  ).run(now.toISOString(), grant.secret_grant_id)
  return { secretGrantId: grant.secret_grant_id, status: 'revoked' }
}

function loadGrant(db, secretGrantId) {
  if (!secretGrantId) throw new BrokerError('INVALID_SCHEMA')
  const grant = db.prepare('SELECT * FROM grants WHERE secret_grant_id = ?').get(secretGrantId)
  if (!grant) throw new BrokerError('GRANT_NOT_FOUND')
  return grant
}

function assertIdentity(grant, body) {
  if (
    grant.worker_id !== body.workerId ||
    grant.lease_id !== body.leaseId ||
    grant.capability !== body.capability
  ) {
    throw new BrokerError('GRANT_IDENTITY_MISMATCH')
  }
}

function assertUsable(grant, now) {
  if (grant.status === 'revoked') throw new BrokerError('GRANT_REVOKED')
  if (grant.status === 'expired' || Date.parse(grant.expires_at) <= now.getTime()) {
    throw new BrokerError('GRANT_EXPIRED')
  }
}

function rejectUnknown(body, allowed) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BrokerError('INVALID_SCHEMA')
  }
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new BrokerError('UNKNOWN_FIELD')
  }
}
