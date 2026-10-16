import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { heartbeatLease, completeLease, rejectLease } from '../../testing/leases.js'
import { documentSha256 } from '../../contracts/version.mjs'
import { verifyCanonical } from '../guest-agent/verify.mjs'
import { buildArtifact } from '../guest-agent/artifact.mjs'
import { writeSidecarDir } from '../guest-agent/sidecar.mjs'
import { runProcess } from './process-runner.mjs'
import { uploadAttemptArtifact } from '../host-worker/index.mjs'
import { createBlobStore } from '../../testing/blobs.js'
import { existsSync } from 'node:fs'

const guestAgentPath = fileURLToPath(new URL('../guest-agent/index.mjs', import.meta.url))

function heartbeatBody(worker, reservation, operationSeq) {
  return {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    operationSeq,
  }
}

function executionMetadata() {
  return {
    backend: 'local-process',
    isolation: 'host-process',
    warning: 'Project code runs with the host user permissions; this backend is not VM isolation.',
  }
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Execute an already accepted static run on the host and complete it through the normal
 * signed sidecar, artifact upload, and lease completion protocol. `runDir/workspace` must
 * contain the immutable snapshot selected for the accepted run.
 */
export async function executeAcceptedRunLocally({
  db,
  worker,
  reservation,
  accepted,
  cases,
  runDir,
  guestPrivateKeyPem,
  blobRoot,
  signal,
  timeoutMs,
}) {
  if (accepted.runSpec.unit !== 'static') {
    throw new Error('LOCAL_RUNNER_UNSUPPORTED_UNIT: local-process backend currently supports static runs only')
  }
  if (accepted.secretGrants?.length || accepted.runSpec.secretRefs?.length) {
    throw new Error('LOCAL_RUNNER_SECRETS_UNSUPPORTED: local-process backend does not inject run secrets')
  }
  if (!guestPrivateKeyPem) throw new Error('LOCAL_RUNNER_SIGNING_KEY_REQUIRED')

  const signingKey = await db.prepare('SELECT public_key_pem FROM signing_keys WHERE key_id=?').get(accepted.signingKeyId)
  if (!signingKey?.public_key_pem || accepted.runSpec.audience !== 'awp-guest-agent'
    || !verifyCanonical(signingKey.public_key_pem, accepted.runSpec, accepted.runSpecSignature)) {
    throw new Error('RUNSPEC_SIGNATURE_INVALID')
  }
  const inputDir = join(runDir, 'input')
  const outputDir = join(runDir, 'output')
  mkdirSync(inputDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(inputDir, 'runspec.json'), JSON.stringify(accepted.runSpec))
  writeFileSync(join(inputDir, 'runspec.sig'), accepted.runSpecSignature)
  writeFileSync(join(inputDir, 'runspec.pub.pem'), signingKey.public_key_pem)
  writeFileSync(join(inputDir, 'cases.json'), JSON.stringify(cases))
  writeFileSync(join(inputDir, 'guest.ed25519.pem'), guestPrivateKeyPem, { mode: 0o600 })
  mkdirSync(join(outputDir, 'logs'), { recursive: true })
  writeFileSync(join(outputDir, 'logs', 'execution-mode.json'), JSON.stringify(executionMetadata(), null, 2))

  let heartbeatSeq = 1
  const initialHeartbeat = await heartbeatLease(db, worker, reservation.leaseId, heartbeatBody(worker, reservation, heartbeatSeq++))
  const heartbeatAbort = new AbortController()
  if (initialHeartbeat.desiredState === 'canceled') heartbeatAbort.abort(new Error('RUN_CANCELED'))
  const forwardAbort = () => heartbeatAbort.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  if (signal?.aborted) forwardAbort()
  const timer = setInterval(async () => {
    try {
      const heartbeat = await heartbeatLease(db, worker, reservation.leaseId, heartbeatBody(worker, reservation, heartbeatSeq++))
      if (heartbeat.desiredState === 'canceled') heartbeatAbort.abort(new Error('RUN_CANCELED'))
    } catch (error) {
      process.stderr.write(`[local-runner] heartbeat failed: ${error.message}\n`)
      heartbeatAbort.abort(error)
    }
  }, 10_000)
  timer.unref?.()

  try {
    const boundedTimeout = timeoutMs ?? Math.min(
      Math.max(1, Number(accepted.runSpec.timeouts?.totalSeconds) || 2400) * 1000,
      2 * 60 * 60 * 1000,
    )
    const processResult = await runProcess([process.execPath, guestAgentPath], {
      cwd: process.cwd(),
      env: { ...process.env, AWP_RUN_DIR: runDir, AWP_EXECUTION_BACKEND: 'local-process' },
      timeoutMs: boundedTimeout,
      signal: heartbeatAbort.signal,
      checkId: 'guest-agent',
      logDir: join(outputDir, 'logs'),
    })
    if (processResult.status !== 'passed') {
      const error = new Error(processResult.error || `LOCAL_RUNNER_EXIT_${processResult.exitCode ?? processResult.signal ?? 'UNKNOWN'}`)
      error.execution = processResult
      throw error
    }
    if (heartbeatAbort.signal.aborted) throw heartbeatAbort.signal.reason || new Error('LOCAL_RUNNER_CANCELED')
    const sidecar = JSON.parse(readFileSync(join(outputDir, 'result.json'), 'utf8'))
    const resultSignature = readFileSync(join(outputDir, 'result.sig'), 'utf8').trim()
    if (!resultSignature || !existsSync(join(outputDir, 'artifact.zip'))) {
      throw new Error('LOCAL_RUNNER_RESULT_MISSING')
    }
    const result = sidecar
    // The parent process logs are flushed when runProcess resolves. Rebuild the archive now
    // so these bounded logs and the local execution marker are covered by the signed manifest.
    const artifact = buildArtifact({ runDir, checks: result.checks })
    writeFileSync(join(outputDir, 'artifact.zip'), artifact.archive)
    const signedSidecar = writeSidecarDir(outputDir, {
      runSpec: accepted.runSpec,
      status: result.status,
      checks: result.checks,
      archiveSha256: sha256Buffer(artifact.archive),
      files: artifact.files,
      totalSize: artifact.totalSize,
      artifactTruncated: artifact.artifactTruncated,
      guestPrivateKeyPem,
    })
    const sidecarManifestSha256 = signedSidecar.manifestSha256
    const execInfo = executionMetadata()
    const blobs = createBlobStore(blobRoot)
    const wrapped = { result, resultSha256: signedSidecar.resultSha256, manifestSha256: sidecarManifestSha256 }
    await uploadAttemptArtifact(db, blobs, worker, reservation, accepted, runDir, wrapped)
    await completeLease(db, worker, reservation.leaseId, {
      runId: reservation.runId,
      workerId: worker.worker_id,
      attempt: reservation.attempt,
      leaseEpoch: reservation.leaseEpoch,
      leaseToken: reservation.leaseToken,
      bindingId: accepted.runSpec.bindingId,
      status: result.status,
      resultSha256: signedSidecar.resultSha256,
      runnerImageId: accepted.runSpec.runnerImageId,
      runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
      checks: result.checks,
      artifactManifestSha256: sidecarManifestSha256,
    })
    return { ...wrapped, execution: execInfo }
  } finally {
    clearInterval(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

export async function rejectLocalRun(db, worker, reservation, error) {
  const errorCode = String(error?.message || 'LOCAL_RUNNER_ERROR').slice(0, 80)
  const permanent = errorCode.startsWith('LOCAL_RUNNER_UNSUPPORTED_')
    || errorCode.startsWith('LOCAL_RUNNER_SECRETS_UNSUPPORTED')
    || errorCode === 'LOCAL_RUNNER_INVALID_RUN_ID'
    || errorCode === 'SUITE_PLAN_MISSING'
    || errorCode === 'RUNSPEC_SIGNATURE_INVALID'
  await rejectLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    errorCode,
    ...(errorCode === 'SNAPSHOT_HASH_MISMATCH' ? { terminalReason: 'SNAPSHOT_HASH_MISMATCH' } : {}),
    ...(permanent ? { terminalReason: errorCode, noRetry: true } : {}),
  })
}

