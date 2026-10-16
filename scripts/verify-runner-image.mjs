import { existsSync } from 'node:fs'
import path from 'node:path'
import db, { DB_DIALECT, openDb } from '../db.js'
import { isImageManifestEnvelope } from '../runner/image/manifest.mjs'
import { getActiveImage } from '../runner/image/lifecycle.mjs'
import { verifyImageOrThrow } from '../runner/host-worker/index.mjs'

let dbOpened = DB_DIALECT === 'sqlite'

function option(name) {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function main() {
  if (DB_DIALECT === 'postgres') {
    await openDb()
    dbOpened = true
  }
  const runnerRoot = path.resolve(process.env.AWP_RUNNER_ROOT || 'data/runner')
  const vhdxPath = path.resolve(option('--vhdx') || process.env.AWP_GOLDEN_VHDX || path.join(runnerRoot, 'images', 'golden.vhdx'))
  if (!existsSync(vhdxPath)) {
    throw new Error(`RUNNER_IMAGE_MISSING: ${vhdxPath} does not exist. Supply a licensed Windows runner image, build its SBOM, publish the signed manifest, then rerun deployment.`)
  }

  let image
  try {
    image = await getActiveImage(db)
  } catch {
    throw new Error('RUNNER_IMAGE_UNREGISTERED: no active runner image exists. Run npm run image:publish -- publish with a new image ID, VHDX, and SBOM.')
  }
  if (!isImageManifestEnvelope(image.manifest_json)) {
    throw new Error(`RUNNER_IMAGE_UNSIGNED: active image ${image.image_id} has no signed manifest. Publish the VHDX and SBOM with npm run image:publish.`)
  }
  try {
    await verifyImageOrThrow(db, image, vhdxPath)
  } catch {
    throw new Error(`RUNNER_IMAGE_MISMATCH: ${vhdxPath} does not match the signed active image ${image.image_id}. Publish a new immutable image ID or restore the matching VHDX.`)
  }
  const result = { ok: true, imageId: image.image_id, manifestSha256: image.manifest_sha256, vhdxSha256: image.vhdx_sha256, vhdxPath }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`[runner image preflight] ${error.message}\n`)
  process.exitCode = 1
} finally {
  if (dbOpened) {
    const closed = db.close?.()
    if (closed && typeof closed.then === 'function') await closed
  }
}
