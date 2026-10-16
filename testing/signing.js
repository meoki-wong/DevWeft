import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalize, documentSha256, sha256Hex } from '../contracts/version.mjs'
import { uuidv7, utcNow } from './ids.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEY_DIR = process.env.AWP_SIGNING_KEY_DIR
  ? path.resolve(process.env.AWP_SIGNING_KEY_DIR)
  : path.join(root, 'data', 'signing-keys')

export function generateEd25519Pem() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

export function publicKeySha256(publicKeyPem) {
  return sha256Hex(String(publicKeyPem).trim())
}

export function signCanonical(privateKeyPem, value) {
  const payload = Buffer.from(canonicalize(value), 'utf8')
  const key = createPrivateKey(privateKeyPem)
  return sign(null, payload, key).toString('base64')
}

export function verifyCanonical(publicKeyPem, value, signatureB64) {
  const payload = Buffer.from(canonicalize(value), 'utf8')
  const key = createPublicKey(publicKeyPem)
  return verify(null, payload, key, Buffer.from(signatureB64, 'base64'))
}

export function loadOrCreateRunspecKeyFile() {
  return loadOrCreateKeyFile('runspec.ed25519')
}

/** 私钥文件与其公钥文件是否同源（不同源时签名永远验不过，且错误现场离根因很远） */
function keyPairMatches(privateKeyPem, publicKeyPem) {
  try {
    const derived = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: 'spki', format: 'pem' })
      .toString()
    return derived.trim() === String(publicKeyPem).trim()
  } catch {
    return false
  }
}

export function loadOrCreateKeyFile(stem) {
  mkdirSync(KEY_DIR, { recursive: true })
  const privPath = path.join(KEY_DIR, `${stem}.pem`)
  const pubPath = path.join(KEY_DIR, `${stem}.pub.pem`)
  if (existsSync(privPath) && existsSync(pubPath)) {
    const privateKeyPem = readFileSync(privPath, 'utf8')
    const publicKeyPem = readFileSync(pubPath, 'utf8')
    if (keyPairMatches(privateKeyPem, publicKeyPem)) {
      return { publicKeyPem, privateKeyPem, secretRef: `file:${stem}.pem` }
    }
    // 文件残留/半写导致私钥与公钥不同源：继续用会让所有签名校验静默失败（现场离根因很远），
    // 这里直接重新生成一对并告警；DB 中引用旧公钥的行需按轮换流程处理
    process.stderr.write(
      `[signing] ${stem}: 本地密钥对不一致（私钥与公钥文件不同源）→ 重新生成密钥对\n`
    )
  }
  const generated = generateEd25519Pem()
  writeFileSync(privPath, generated.privateKeyPem, { mode: 0o600 })
  writeFileSync(pubPath, generated.publicKeyPem, { mode: 0o644 })
  return { ...generated, secretRef: `file:${stem}.pem` }
}

export async function ensureRunspecSigningKey(db, { now = utcNow() } = {}) {
  const existing = await db.prepare(
    `SELECT * FROM signing_keys WHERE purpose='runspec' AND status='active' ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (existing) return existing
  const file = loadOrCreateRunspecKeyFile()
  const keyId = uuidv7()
  const notAfter = new Date(Date.parse(now) + 365 * 24 * 3600 * 1000).toISOString()
  await db.prepare(
    `INSERT INTO signing_keys(
       key_id, purpose, algorithm, public_key_pem, secret_ref, status, not_before, not_after, created_at
     ) VALUES (?, 'runspec', 'Ed25519', ?, ?, 'active', ?, ?, ?)`
  ).run(keyId, file.publicKeyPem, file.secretRef, now, notAfter, now)
  return await db.prepare('SELECT * FROM signing_keys WHERE key_id=?').get(keyId)
}

export function loadPrivateKeyForSecretRef(secretRef) {
  if (!secretRef || !String(secretRef).startsWith('file:')) return null
  const name = String(secretRef).slice('file:'.length)
  const p = path.join(KEY_DIR, name)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf8')
}

export async function signRunSpec(db, runSpec) {
  const row = await db.prepare(
    `SELECT * FROM signing_keys WHERE purpose='runspec' AND status='active' ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (!row) throw new Error('no active runspec signing key')
  const pem = loadPrivateKeyForSecretRef(row.secret_ref)
  if (!pem) throw new Error('runspec secret_ref unavailable')
  return {
    keyId: row.key_id,
    publicKeyPem: row.public_key_pem,
    signature: signCanonical(pem, runSpec),
    sha256: documentSha256(runSpec),
  }
}

export async function verifyRunSpecSignature(db, runSpec, signatureB64, keyId) {
  const row = await db.prepare('SELECT * FROM signing_keys WHERE key_id=?').get(keyId)
  if (!row || row.status === 'revoked') return false
  if (row.algorithm !== 'Ed25519' || row.purpose !== 'runspec') return false
  return verifyCanonical(row.public_key_pem, runSpec, signatureB64)
}

// ─── image_manifest 签名（§9.2 / §23 M3.1）：轮换时旧 key 只能 verify_only ───

export async function ensureImageSigningKey(db, { now = utcNow() } = {}) {
  const existing = await db.prepare(
    `SELECT * FROM signing_keys WHERE purpose='image_manifest' AND status='active' ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (existing) return existing
  const file = loadOrCreateKeyFile('image-manifest.ed25519')
  const keyId = uuidv7()
  const notAfter = new Date(Date.parse(now) + 365 * 24 * 3600 * 1000).toISOString()
  await db.prepare(
    `INSERT INTO signing_keys(
       key_id, purpose, algorithm, public_key_pem, secret_ref, status, not_before, not_after, created_at
     ) VALUES (?, 'image_manifest', 'Ed25519', ?, ?, 'active', ?, ?, ?)`
  ).run(keyId, file.publicKeyPem, file.secretRef, now, notAfter, now)
  return await db.prepare('SELECT * FROM signing_keys WHERE key_id=?').get(keyId)
}

export async function rotateImageSigningKey(db, { now = utcNow() } = {}) {
  const old = await ensureImageSigningKey(db, { now })
  await db.prepare(`UPDATE signing_keys SET status='verify_only' WHERE key_id=? AND status='active'`).run(old.key_id)
  const fresh = loadOrCreateKeyFile(`image-manifest-${Date.parse(now)}.ed25519`)
  const keyId = uuidv7()
  const notAfter = new Date(Date.parse(now) + 365 * 24 * 3600 * 1000).toISOString()
  await db.prepare(
    `INSERT INTO signing_keys(
       key_id, purpose, algorithm, public_key_pem, secret_ref, status, not_before, not_after, created_at
     ) VALUES (?, 'image_manifest', 'Ed25519', ?, ?, 'active', ?, ?, ?)`
  ).run(keyId, fresh.publicKeyPem, fresh.secretRef, now, notAfter, now)
  return { oldKeyId: old.key_id, newKeyId: keyId }
}

export async function signImageManifest(db, document) {
  const row = await db.prepare(
    `SELECT * FROM signing_keys WHERE purpose='image_manifest' AND status='active' ORDER BY created_at DESC LIMIT 1`
  ).get()
  if (!row) throw new Error('no active image_manifest signing key')
  const pem = loadPrivateKeyForSecretRef(row.secret_ref)
  if (!pem) throw new Error('image_manifest secret_ref unavailable')
  return { signature: signCanonical(pem, document), signingKeyId: row.key_id }
}

export async function verifyImageManifestSignature(db, envelope) {
  if (!envelope || !envelope.document || !envelope.signature || !envelope.signingKeyId) return false
  const row = await db.prepare('SELECT * FROM signing_keys WHERE key_id=?').get(envelope.signingKeyId)
  if (!row || row.status === 'revoked') return false
  if (row.algorithm !== 'Ed25519' || row.purpose !== 'image_manifest') return false
  return verifyCanonical(row.public_key_pem, envelope.document, envelope.signature)
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}
