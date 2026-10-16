import os from 'node:os'
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import db, { initDB } from '../../db.js'
import { acquireLease, acceptLease } from '../../testing/leases.js'
import { generateEd25519Pem, publicKeySha256 } from '../../testing/signing.js'
import { createBlobStore } from '../../testing/blobs.js'
import { loadOrCreateWorkerIdentity } from '../host-worker/identity.mjs'
import { executeAcceptedRunLocally, rejectLocalRun } from './index.mjs'

function safeRunId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(value)
}

/** Pull one static run and execute it as a host process through the shared lease protocol. */
export async function runLocalLane({
  runnerRoot = process.env.AWP_RUNNER_ROOT || join(process.cwd(), 'data', 'runner'),
  blobRoot = process.env.AWP_BLOB_ROOT || join(process.cwd(), 'data', 'blobs'),
  signal,
} = {}) {
  initDB()
  const worker = await loadOrCreateWorkerIdentity(db, {
    runnerRoot,
    hostname: os.hostname(),
    certSearchPaths: [],
  })
  const reservation = await acquireLease(db, worker, { unit: 'static' })
  if (!reservation) return null
  try {
    const guest = generateEd25519Pem()
    const accepted = await acceptLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      guestPublicKey: guest.publicKeyPem,
      guestKeySha256: publicKeySha256(guest.publicKeyPem),
    })
    if (accepted.runSpec.secretRefs?.length) {
      throw new Error('LOCAL_RUNNER_SECRETS_UNSUPPORTED: local-process backend does not inject run secrets')
    }
    if (!safeRunId(reservation.runId) || !Number.isInteger(reservation.attempt) || reservation.attempt < 1) {
      throw new Error('LOCAL_RUNNER_INVALID_RUN_ID')
    }
    const attemptDir = join(runnerRoot, 'attempts', reservation.runId, `a${reservation.attempt}`)
    rmSync(attemptDir, { recursive: true, force: true })
    mkdirSync(join(attemptDir, 'input'), { recursive: true })
    mkdirSync(join(attemptDir, 'output'), { recursive: true })
    writeFileSync(join(attemptDir, 'input', 'guest.ed25519.pem'), guest.privateKeyPem, { mode: 0o600 })

    const blobs = createBlobStore(blobRoot)
    const bundlePath = blobs.contentPath(accepted.runSpec.sourceBlobSha256)
    if (!existsSync(bundlePath)) throw new Error('SNAPSHOT_HASH_MISMATCH')
    cpSync(bundlePath, join(attemptDir, 'input', 'snapshot.bundle'))
    const plan = await db.prepare(
      `SELECT p.canonical_lock_json FROM test_runs r
       JOIN test_bindings b ON b.binding_id=r.binding_id
       JOIN suite_plans p ON p.suite_plan_id=b.suite_plan_id
       WHERE r.run_id=?`
    ).get(reservation.runId)
    if (!plan?.canonical_lock_json) throw new Error('SUITE_PLAN_MISSING')
    const cases = JSON.parse(plan.canonical_lock_json).cases || []
    const sidecar = await executeAcceptedRunLocally({
      db, worker, reservation, accepted, cases, runDir: attemptDir,
      guestPrivateKeyPem: guest.privateKeyPem, blobRoot, signal,
    })
    return { reservation, result: sidecar.result, execution: sidecar.execution }
  } catch (error) {
    try { await rejectLocalRun(db, worker, reservation, error) } catch (rejectError) {
      process.stderr.write(`[local-runner] lease rejection failed: ${rejectError.message}\n`)
    }
    throw error
  }
}
