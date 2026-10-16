/**
 * Publish signed, immutable Hyper-V runner images through the configured database.
 * A new image_id is required for every VHDX revision; the active image can be rolled back.
 *
 *   npm run image:publish -- publish --image-id <id> --vhdx <golden.vhdx> --sbom <sbom.json> [--mode canary|active]
 *   npm run image:publish -- promote --image-id <id>
 *   npm run image:publish -- rollback --image-id <id>
 *   npm run image:publish -- revoke --image-id <id>
 *   npm run image:publish -- list
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import db, { DB_DIALECT, openDb } from '../db.js'
import { canonicalize } from '../contracts/version.mjs'
import { buildImageManifest, buildSignedImageManifest, imageManifestDocument } from '../runner/image/manifest.mjs'
import { sbomSha256Of } from '../runner/image/sbom.mjs'
import { publishImage, promoteImage, rollbackImage, revokeImage } from '../runner/image/lifecycle.mjs'
import { ensureImageSigningKey } from '../testing/signing.js'

function option(name, fallback = null) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function required(name) {
  const value = option(name)
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function buildSignedFromVhdx({ imageId, vhdxPath, sbomPath }) {
  if (!existsSync(vhdxPath)) throw new Error(`VHDX does not exist: ${vhdxPath}`)
  if (!existsSync(sbomPath)) throw new Error(`SBOM does not exist: ${sbomPath}`)
  const sbomDocument = JSON.parse(readFileSync(sbomPath, 'utf8'))
  if (sbomDocument.schemaVersion !== 1 || sbomDocument.imageId !== imageId ||
      !Number.isFinite(Date.parse(sbomDocument.generatedAt)) || !Array.isArray(sbomDocument.components) ||
      sbomDocument.components.length === 0 || sbomDocument.components.some((component) =>
        !component || typeof component.name !== 'string' || !component.name.trim() ||
        typeof component.version !== 'string' || !component.version.trim())) {
    throw new Error('SBOM must use schemaVersion 1, match imageId, include generatedAt, and list named/versioned components.')
  }

  await ensureImageSigningKey(db)
  const built = buildImageManifest({ imageId, vhdxPath })
  const document = imageManifestDocument({
    imageId,
    vhdxSha256: built.vhdxSha256,
    sbomSha256: sbomSha256Of(sbomDocument),
  })
  const signed = await buildSignedImageManifest(db, document)
  return {
    envelope: signed.envelope,
    manifestSha256: signed.manifestSha256,
    vhdxSha256: document.vhdxSha256,
  }
}

let dbOpened = DB_DIALECT === 'sqlite'

async function main() {
  if (DB_DIALECT === 'postgres') {
    await openDb()
    dbOpened = true
  }
  const command = process.argv[2]

  if (command === 'publish') {
    const imageId = required('--image-id')
    const vhdxPath = resolve(required('--vhdx'))
    const sbomPath = resolve(required('--sbom'))
    const mode = option('--mode', 'canary')
    if (!['canary', 'active'].includes(mode)) throw new Error('--mode must be canary or active')
    const built = await buildSignedFromVhdx({ imageId, vhdxPath, sbomPath })
    const row = await publishImage(db, {
      imageId,
      manifestSha256: built.manifestSha256,
      vhdxSha256: built.vhdxSha256,
      manifestJson: canonicalize(built.envelope),
      mode,
    })
    process.stdout.write(`published ${row.image_id} state=${row.state} vhdx=${row.vhdx_sha256.slice(0, 12)}… manifest=${row.manifest_sha256.slice(0, 12)}…\n`)
    return
  }
  if (command === 'promote') {
    const row = await promoteImage(db, required('--image-id'))
    process.stdout.write(`promoted ${row.image_id} state=${row.state}\n`)
    return
  }
  if (command === 'rollback') {
    const row = await rollbackImage(db, { toImageId: required('--image-id') })
    process.stdout.write(`rollback ok, active=${row.image_id}\n`)
    return
  }
  if (command === 'revoke') {
    const row = await revokeImage(db, required('--image-id'))
    process.stdout.write(`revoked ${row.image_id} state=${row.state}\n`)
    return
  }
  if (command === 'list') {
    const rows = await db.prepare('SELECT image_id, state, vhdx_sha256, created_at, retired_at FROM runner_images ORDER BY created_at').all()
    for (const row of rows) process.stdout.write(`${row.image_id}\t${row.state}\t${row.vhdx_sha256.slice(0, 12)}…\t${row.created_at}\n`)
    return
  }
  throw new Error('Usage: image-publish.mjs publish|promote|rollback|revoke|list')
}

try {
  await main()
} catch (error) {
  process.stderr.write(`[image:publish] ${error.message}\n`)
  process.exitCode = 1
} finally {
  if (dbOpened) {
    const closed = db.close?.()
    if (closed && typeof closed.then === 'function') await closed
  }
}
