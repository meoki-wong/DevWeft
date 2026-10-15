/**
 * Host Worker 校验 Guest sidecar（§12）：Guest 签名只证明结果由指定 image 的 Guest Agent 产生。
 * 校验失败一律 ARTIFACT_HASH_MISMATCH / RUNSPEC_SIGNATURE_INVALID，禁止带病 complete。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyCanonical } from '../guest-agent/verify.mjs'
import { documentSha256 } from '../../contracts/version.mjs'

function sha256buf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export function verifyGuestSidecar({
  runSpec, result, manifest, resultSig, manifestSig, guestPublicKeyPem, archiveBuffer,
}) {
  if (!resultSig || !manifestSig) throw new Error('RUNSPEC_SIGNATURE_INVALID')
  if (!verifyCanonical(guestPublicKeyPem, result, resultSig)) throw new Error('RUNSPEC_SIGNATURE_INVALID')
  if (!verifyCanonical(guestPublicKeyPem, manifest, manifestSig)) throw new Error('RUNSPEC_SIGNATURE_INVALID')
  if (manifest.runId !== runSpec.runId
    || manifest.attempt !== runSpec.attempt
    || manifest.leaseEpoch !== runSpec.leaseEpoch
    || manifest.bindingId !== runSpec.bindingId) {
    throw new Error('ARTIFACT_HASH_MISMATCH')
  }
  if (documentSha256(result) !== manifest.resultSha256) throw new Error('ARTIFACT_HASH_MISMATCH')
  if (manifest.imageId !== runSpec.runnerImageId
    || manifest.imageManifestSha256 !== runSpec.runnerImageManifestSha256) {
    throw new Error('IMAGE_CHANGED')
  }
  if (!archiveBuffer || sha256buf(archiveBuffer) !== manifest.archiveSha256) {
    throw new Error('ARTIFACT_HASH_MISMATCH')
  }
  const listedTotal = (manifest.files || []).reduce((acc, f) => acc + (Number(f.size) || 0), 0)
  if (listedTotal !== manifest.totalSize) throw new Error('ARTIFACT_HASH_MISMATCH')
  return true
}

export function loadGuestSidecar(outputDir) {
  const result = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf8'))
  const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8'))
  const resultSig = readFileSync(join(outputDir, 'result.sig'), 'utf8').trim()
  const manifestSig = readFileSync(join(outputDir, 'manifest.sig'), 'utf8').trim()
  const archivePath = join(outputDir, 'artifact.zip')
  if (!existsSync(archivePath)) throw new Error('ARTIFACT_HASH_MISMATCH')
  return { result, manifest, resultSig, manifestSig, archivePath }
}
