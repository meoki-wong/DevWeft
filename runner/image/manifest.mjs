import { createHash } from 'node:crypto'
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { canonicalize, documentSha256 } from '../../contracts/version.mjs'
import { DEFAULT_IMAGE_ID } from '../../testing/execution-profiles.js'
import { signImageManifest } from '../../testing/signing.js'

export const IMAGE_ID = DEFAULT_IMAGE_ID

export function imageManifestDocument({ imageId = IMAGE_ID, vhdxSha256, sbomSha256 }) {
  return {
    schemaVersion: 1,
    imageId,
    vhdxSha256,
    sbomSha256,
  }
}

/**
 * 签名 envelope（§9.2）：manifest_json = {document, signature, signingKeyId}。
 * manifest_sha256 对 envelope 计算，与 binding.runner_image_manifest_sha256 一致。
 */
export async function buildSignedImageManifest(db, document) {
  const signed = await signImageManifest(db, document)
  const envelope = {
    schemaVersion: 1,
    document,
    signature: signed.signature,
    signingKeyId: signed.signingKeyId,
  }
  return { envelope, manifestSha256: documentSha256(envelope) }
}

export function isImageManifestEnvelope(manifestJson) {
  try {
    const parsed = JSON.parse(manifestJson)
    return parsed && parsed.document && parsed.signingKeyId !== undefined
  } catch {
    return false
  }
}

export function hashVhdxFile(filePath) {
  const hash = createHash('sha256')
  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let n
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

export function placeholderVhdxSha256(imageId = IMAGE_ID) {
  return documentSha256({ imageId, placeholder: true })
}

export function emptySbomSha256(imageId) {
  return documentSha256({ schemaVersion: 1, imageId, components: [] })
}

export function buildImageManifest({ imageId = IMAGE_ID, vhdxPath = null, vhdxSha256 = null } = {}) {
  let digest = vhdxSha256
  if (!digest && vhdxPath && existsSync(vhdxPath)) digest = hashVhdxFile(vhdxPath)
  if (!digest) digest = placeholderVhdxSha256(imageId)
  const doc = imageManifestDocument({
    imageId,
    vhdxSha256: digest,
    sbomSha256: emptySbomSha256(imageId),
  })
  return { document: doc, manifestSha256: documentSha256(doc), vhdxSha256: digest }
}

export function verifyVhdxSha256(filePath, expectedSha256) {
  if (!existsSync(filePath)) return false
  return hashVhdxFile(filePath) === expectedSha256
}

export async function refreshPlaceholderImage(db, vhdxPath, { now = new Date().toISOString() } = {}) {
  if (!vhdxPath || !existsSync(vhdxPath)) return { skipped: true, reason: 'no-vhdx' }
  const actual = hashVhdxFile(vhdxPath)
  const built = buildImageManifest({ imageId: IMAGE_ID, vhdxSha256: actual })
  const row = await db.prepare('SELECT * FROM runner_images WHERE image_id=?').get(IMAGE_ID)
  const placeholder = placeholderVhdxSha256(IMAGE_ID)
  if (!row) {
    await db.prepare(
      `INSERT INTO runner_images(image_id, manifest_sha256, vhdx_sha256, manifest_json, state, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    ).run(IMAGE_ID, built.manifestSha256, built.vhdxSha256, canonicalize(built.document), now)
    return { updated: true, skipped: false, ...built }
  }
  if (row.vhdx_sha256 === actual && row.manifest_sha256 === built.manifestSha256) {
    return { updated: false, skipped: false, ...built }
  }
  if (row.vhdx_sha256 === placeholder || row.manifest_json === '{}') {
    await db.prepare(
      `UPDATE runner_images SET manifest_sha256=?, vhdx_sha256=?, manifest_json=? WHERE image_id=?`
    ).run(built.manifestSha256, built.vhdxSha256, canonicalize(built.document), IMAGE_ID)
    return { updated: true, skipped: false, ...built }
  }
  throw new Error('IMAGE_CHANGED')
}
