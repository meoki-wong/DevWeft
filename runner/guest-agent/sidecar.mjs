import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalize, documentSha256 } from './canonical.mjs'
import { signCanonical } from '../../testing/signing.js'

export function buildResultSidecar({ runSpec, status, checks }) {
  return {
    schemaVersion: 1,
    runId: runSpec.runId,
    attempt: runSpec.attempt,
    leaseEpoch: runSpec.leaseEpoch,
    bindingId: runSpec.bindingId,
    status,
    checks,
  }
}

export function buildArtifactManifest({ runSpec, resultSha256, archiveSha256, files, totalSize, artifactTruncated }) {
  return {
    schemaVersion: 1,
    runId: runSpec.runId,
    attempt: runSpec.attempt,
    leaseEpoch: runSpec.leaseEpoch,
    bindingId: runSpec.bindingId,
    sourceSha256: runSpec.sourceBlobSha256,
    suiteLockSha256: runSpec.suiteLockSha256,
    imageId: runSpec.runnerImageId,
    imageManifestSha256: runSpec.runnerImageManifestSha256,
    resultSha256,
    archiveSha256,
    files,
    totalSize,
    artifactTruncated,
  }
}

export function writeSidecarDir(outputDir, {
  runSpec, status, checks, archiveSha256, files, totalSize, artifactTruncated, guestPrivateKeyPem,
}) {
  mkdirSync(outputDir, { recursive: true })
  const result = buildResultSidecar({ runSpec, status, checks })
  const resultSha256 = documentSha256(result)
  const manifest = buildArtifactManifest({
    runSpec,
    resultSha256,
    archiveSha256,
    files,
    totalSize,
    artifactTruncated,
  })
  writeFileSync(join(outputDir, 'result.json'), canonicalize(result))
  writeFileSync(join(outputDir, 'manifest.json'), canonicalize(manifest))
  let signatures = { resultSig: null, manifestSig: null }
  if (guestPrivateKeyPem) {
    const resultSig = signCanonical(guestPrivateKeyPem, result)
    const manifestSig = signCanonical(guestPrivateKeyPem, manifest)
    writeFileSync(join(outputDir, 'result.sig'), resultSig)
    writeFileSync(join(outputDir, 'manifest.sig'), manifestSig)
    signatures = { resultSig, manifestSig }
  }
  return { result, resultSha256, manifest, manifestSha256: documentSha256(manifest), ...signatures }
}
