import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

export function tokenHashesEqual(aHex, bHex) {
  const a = Buffer.from(String(aHex), 'hex')
  const b = Buffer.from(String(bHex), 'hex')
  if (a.length !== 32 || b.length !== 32) return false
  return timingSafeEqual(a, b)
}

export async function issueToken(db, { principalId, now = new Date() }) {
  const token = randomBytes(32).toString('base64url')
  const tokenId = uuidv7(now.getTime())
  await db.prepare(
    `INSERT INTO principal_tokens(token_id, principal_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(tokenId, principalId, hashToken(token), new Date(now.getTime() + TOKEN_TTL_MS).toISOString(), now.toISOString())
  return { tokenId, token }
}

export async function authenticateBearer(db, authorizationHeader, now = new Date()) {
  const raw = String(authorizationHeader || '')
  const m = raw.match(/^Bearer\s+(\S+)$/i)
  if (!m) throw new ApiError('INVALID_SCHEMA')
  const tokenHash = hashToken(m[1])
  const row = await db.prepare(
    `SELECT t.token_id, t.token_hash, t.principal_id, t.expires_at, t.revoked_at,
            p.status AS principal_status, p.subject, p.display_name
     FROM principal_tokens t JOIN principals p ON p.principal_id = t.principal_id
     WHERE t.token_hash = ?`
  ).get(tokenHash)
  const dummy = '0'.repeat(64)
  const equal = tokenHashesEqual(row ? row.token_hash : dummy, tokenHash)
  if (!row || !equal) throw new ApiError('INVALID_SCHEMA')
  if (row.revoked_at) throw new ApiError('INVALID_SCHEMA')
  if (Date.parse(row.expires_at) <= now.getTime()) throw new ApiError('INVALID_SCHEMA')
  if (row.principal_status !== 'active') throw new ApiError('INVALID_SCHEMA')
  await db.prepare('UPDATE principal_tokens SET last_used_at=? WHERE token_id=?').run(now.toISOString(), row.token_id)
  const roles = await db.prepare(
    `SELECT role, scope, repo_id FROM principal_roles
     WHERE principal_id=? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`
  ).all(row.principal_id, now.toISOString())
  const acl = await db.prepare(
    `SELECT repo_id, permission FROM principal_repo_acl WHERE principal_id=?`
  ).all(row.principal_id)
  return {
    principalId: row.principal_id,
    subject: row.subject,
    displayName: row.display_name,
    roles,
    acl,
  }
}

export function requireRepoPermission(principal, repoId, permission) {
  const ok = principal.acl.some((a) => a.repo_id === repoId && a.permission === permission)
  if (!ok) throw new ApiError('CROSS_REPO_REFERENCE')
}

export async function findPrincipalBySubject(db, subject) {
  return await db.prepare('SELECT * FROM principals WHERE subject=?').get(subject)
}

export async function createPrincipal(db, { subject, displayName, now = utcNow() }) {
  const existing = await findPrincipalBySubject(db, subject)
  if (existing) return existing.principal_id
  const principalId = uuidv7()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).run(principalId, subject, displayName, now, now)
  return principalId
}

export async function grantRepoPermissions(db, { principalId, repoId, permissions, now = utcNow() }) {
  const ins = db.prepare(
    `INSERT INTO principal_repo_acl(principal_id, repo_id, permission, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING`
  )
  for (const permission of permissions) await ins.run(principalId, repoId, permission, now)
}

export async function grantGlobalRole(db, { principalId, role, grantedBy, now = utcNow() }) {
  const existing = await db.prepare(
    `SELECT role_grant_id FROM principal_roles
     WHERE principal_id=? AND role=? AND scope='global' AND revoked_at IS NULL`
  ).get(principalId, role)
  if (existing) return existing.role_grant_id
  const id = uuidv7()
  await db.prepare(
    `INSERT INTO principal_roles(role_grant_id, principal_id, role, scope, repo_id, granted_by, granted_at)
     VALUES (?, ?, ?, 'global', NULL, ?, ?)`
  ).run(id, principalId, role, grantedBy, now)
  return id
}
