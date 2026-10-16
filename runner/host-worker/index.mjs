/**
 * Host Worker：领取 lease、校验 ImageManifest / VHDX SHA-256。
 * 业务 static 只允许在 Guest 内执行（executeAcceptedRunInProcess 仅供单测调用 Guest Agent 模块）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runTestingMigrations } from '../../testing/migrate.js'
import { authenticateWorker, acquireLease, acceptLease, heartbeatLease, completeLease } from '../../testing/leases.js'
import { prepareRunArtifact, markArtifactUploaded } from '../../testing/artifacts.js'
import { createBlobStore } from '../../testing/blobs.js'
import { documentSha256 } from '../../contracts/version.mjs'
import { generateEd25519Pem, publicKeySha256, verifyImageManifestSignature } from '../../testing/signing.js'
import { isImageManifestEnvelope } from '../image/manifest.mjs'
import { verifyVhdxSha256 } from '../image/manifest.mjs'
import { executeGuestAttempt } from '../guest-agent/index.mjs'
import { verifyGuestSidecar, loadGuestSidecar } from './sidecar-verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

export async function loadWorkerIdentity(db, { workerId, certificateThumbprint }) {
  return await authenticateWorker(db, { workerId, certificateThumbprint })
}

export async function verifyImageOrThrow(db, imageRow, vhdxPath) {
  // 签名 envelope（§9.2）：验签通过且文档与列一致；遗留未签名行（PoC 兼容）只做文档-列一致性校验
  if (isImageManifestEnvelope(imageRow.manifest_json)) {
    const envelope = JSON.parse(imageRow.manifest_json)
    if (!await verifyImageManifestSignature(db, envelope)) throw new Error('IMAGE_CHANGED')
    if (documentSha256(envelope) !== imageRow.manifest_sha256) throw new Error('IMAGE_CHANGED')
    if (envelope.document.vhdxSha256 !== imageRow.vhdx_sha256) throw new Error('IMAGE_CHANGED')
    if (envelope.document.imageId !== imageRow.image_id) throw new Error('IMAGE_CHANGED')
  } else {
    const manifest = JSON.parse(imageRow.manifest_json)
    if (!manifest || manifest.vhdxSha256 !== imageRow.vhdx_sha256) throw new Error('IMAGE_CHANGED')
  }
  if (vhdxPath && (!existsSync(vhdxPath) || !verifyVhdxSha256(vhdxPath, imageRow.vhdx_sha256))) {
    throw new Error(existsSync(vhdxPath) ? 'IMAGE_CHANGED' : 'RUNNER_IMAGE_MISSING')
  }
}

export async function executeAcceptedRunInProcess({
  db,
  worker,
  reservation,
  accepted,
  cases,
  runDir,
  guestPrivateKeyPem = null,
  blobRoot = null,
  smokeExecutor = undefined,
}) {
  await heartbeatLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    operationSeq: 1,
  })
  const sidecar = await executeGuestAttempt({
    runDir,
    runSpec: accepted.runSpec,
    runSpecSignature: accepted.runSpecSignature,
    runspecPublicKeyPem: (await db.prepare(
      `SELECT public_key_pem FROM signing_keys WHERE key_id=?`
    ).get(accepted.signingKeyId)).public_key_pem,
    cases,
    guestPrivateKeyPem,
    ...(smokeExecutor ? { smokeExecutor } : {}),
  })
  if (blobRoot) {
    const blobs = createBlobStore(blobRoot)
    await uploadAttemptArtifact(db, blobs, worker, reservation, accepted, runDir, sidecar)
  }
  await completeLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    bindingId: accepted.runSpec.bindingId,
    status: sidecar.result.status,
    resultSha256: sidecar.resultSha256,
    runnerImageId: accepted.runSpec.runnerImageId,
    runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
    checks: sidecar.result.checks,
    artifactManifestSha256: sidecar.manifestSha256,
  })
  return sidecar
}

/**
 * Host 侧 sidecar 校验 + artifact:prepare + 上传（§12/§14.8）。
 * run-static-lane.mjs（Hyper-V 路径）与 in-process 路径共用。
 */
export async function uploadAttemptArtifact(db, blobs, worker, reservation, accepted, runDir, sidecar) {
  const outputDir = join(runDir, 'output')
  const loaded = loadGuestSidecar(outputDir)
  verifyGuestSidecar({
    runSpec: accepted.runSpec,
    result: loaded.result,
    manifest: loaded.manifest,
    resultSig: loaded.resultSig,
    manifestSig: loaded.manifestSig,
    guestPublicKeyPem: accepted.runSpec.guestPublicKey,
    archiveBuffer: readFileSync(loaded.archivePath),
  })
  if (loaded.manifest.resultSha256 !== sidecar.resultSha256
    || documentSha256(loaded.manifest) !== sidecar.manifestSha256) {
    throw new Error('ARTIFACT_HASH_MISMATCH')
  }
  const archive = readFileSync(loaded.archivePath)
  const prepared = await prepareRunArtifact(db, blobs, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    artifactSha256: loaded.manifest.archiveSha256,
    artifactManifestSha256: sidecar.manifestSha256,
    size: archive.length,
    artifactTruncated: loaded.manifest.artifactTruncated ? 1 : 0,
  })
  if (prepared.uploadId) blobs.writeUploadBuffer(prepared.uploadId, archive)
  await markArtifactUploaded(db, blobs, worker, {
    archiveSha256: loaded.manifest.archiveSha256,
    size: archive.length,
  })
  return prepared
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const workerId = process.env.AWP_WORKER_ID
  const thumb = process.env.AWP_WORKER_CERT_THUMBPRINT
  const runnerRoot = process.env.AWP_RUNNER_ROOT || join(repoRoot, 'data', 'runner')
  const vhdx = process.env.AWP_GOLDEN_VHDX || join(runnerRoot, 'images', 'golden.vhdx')
  if (!workerId || !thumb) {
    process.stderr.write('Host Worker 需要 AWP_WORKER_ID 与 AWP_WORKER_CERT_THUMBPRINT\n')
    process.exit(2)
  }
  const db = new Database(join(repoRoot, 'data', 'team.db'))
  db.pragma('foreign_keys = ON')
  runTestingMigrations(db)
  const worker = await loadWorkerIdentity(db, { workerId, certificateThumbprint: thumb })
  const reservation = await acquireLease(db, worker)
  if (!reservation) {
    process.stdout.write('idle\n')
    process.exit(0)
  }
  const image = await db.prepare(
    `SELECT i.* FROM test_runs r JOIN test_bindings b ON b.binding_id=r.binding_id
     JOIN runner_images i ON i.image_id=b.runner_image_id WHERE r.run_id=?`
  ).get(reservation.runId)
  await verifyImageOrThrow(db, image, vhdx)
  const guest = generateEd25519Pem()
  await acceptLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    guestPublicKey: guest.publicKeyPem,
    guestKeySha256: publicKeySha256(guest.publicKeyPem),
  })
  process.stdout.write(`leased ${reservation.runId} attempt=${reservation.attempt}\n`)
  process.stdout.write('在 Hyper-V 宿主用 runner/host-worker/hyperv-transfer.ps1 注入 Guest Agent；禁止在宿主机跑业务命令\n')
}
