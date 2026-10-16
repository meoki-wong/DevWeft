import { createHash } from 'node:crypto'
import { createZip } from '../runner/guest-agent/zip.mjs'
import { CONTRACT_VERSION, DOCUMENT_VERSION } from '../contracts/version.mjs'
import { explainTestRun } from './explain.js'
import { readZipCentralEntries } from '../scanner/zipscan.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')

function safeText(value, limit = 300) {
  return String(value || '')
    .replace(/(token|password|secret|authorization|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/ig, '$1$2[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|npm_[A-Za-z0-9]{20,})\b/g, '[redacted]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|workspace)\/)[^\s"']+/g, '[local-path]')
    .slice(0, limit)
}

function jsonObject(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

/** Build deterministic ZIP evidence containing metadata and hashes, never source files or secrets. */
export async function buildRunEvidencePack(db, runId, { explain = explainTestRun } = {}) {
  const run = await db.prepare(
    `SELECT tr.run_id, tr.repo_id, tr.binding_id, tr.unit, tr.side, tr.purpose, tr.status,
            tr.terminal_reason, tr.total_ms, tr.result_sha256, tr.created_at, tr.started_at,
            tr.finished_at, tr.report_json, repo.slug AS repo
     FROM test_runs tr JOIN repositories repo ON repo.repo_id=tr.repo_id
     WHERE tr.run_id=?`
  ).get(runId)
  if (!run) return null
  const explanation = await explain(db, runId, { repoSlug: run.repo })
  const [attempts, artifacts] = await Promise.all([
    db.prepare(`SELECT attempt, status, started_at, finished_at, error_code, error_detail, steps_json
                FROM run_attempts WHERE run_id=? ORDER BY attempt`).all(runId),
    db.prepare(`SELECT artifact_id, attempt, manifest_sha256, archive_sha256, size,
                       artifact_truncated, scan_state, scanner_report_sha256
                FROM artifacts WHERE run_id=? ORDER BY attempt, artifact_id`).all(runId),
  ])
  const report = jsonObject(run.report_json)
  const checks = (Array.isArray(report.checks) ? report.checks : []).map((check) => ({
    caseKey: safeText(check.caseKey || check.name || 'unknown', 200),
    status: ['passed', 'failed', 'error', 'skipped'].includes(check.status) ? check.status : 'unknown',
    durationMs: Number.isFinite(check.durationMs) ? check.durationMs : null,
  }))
  const suite = explanation.selection.suite
  const entries = [
    ['evidence.json', {
      schemaVersion: 1,
      product: { name: 'DevWeft', version: DOCUMENT_VERSION, contractVersion: CONTRACT_VERSION },
      run: {
        runId: run.run_id, repository: run.repo, unit: run.unit, side: run.side,
        purpose: run.purpose, status: run.status, terminalReason: run.terminal_reason,
        totalMs: run.total_ms, createdAt: run.created_at, startedAt: run.started_at,
        finishedAt: run.finished_at, resultSha256: run.result_sha256,
      },
      snapshot: { commit: explanation.environment.snapshot.headCommitOid, changedPathsSha256: explanation.environment.snapshot.changedPathsSha256 },
      configuration: explanation.environment,
    }],
    ['suite-lock.json', {
      schemaVersion: 1,
      suitePlanId: suite.suitePlanId,
      lockSha256: suite.lockSha256,
      requiredCaseSetSha256: suite.requiredCaseSetSha256,
      advisoryCaseSetSha256: suite.advisoryCaseSetSha256,
      lockedCases: suite.lockedCases.map((item) => ({
        caseKey: safeText(item.caseKey, 200), selectedForRun: item.selectedForRun,
        selectionReasonCode: item.runSelectionReasonCode,
        protected: item.protected,
        source: { layer: item.source.layer, suiteRevisionId: item.source.suiteRevisionId, revisionContentSha256: item.source.revisionContentSha256 },
      })),
    }],
    ['checks.json', { schemaVersion: 1, reportAttempt: Number.isInteger(report.attempt) ? report.attempt : null, checks }],
    ['logs-summary.json', {
      schemaVersion: 1,
      attempts: attempts.map((attempt) => {
        let steps = []
        try { steps = Array.isArray(JSON.parse(attempt.steps_json || '[]')) ? JSON.parse(attempt.steps_json || '[]') : [] } catch { /* malformed legacy evidence stays unavailable */ }
        return {
          attempt: attempt.attempt, status: attempt.status, startedAt: attempt.started_at, finishedAt: attempt.finished_at,
          errorCode: safeText(attempt.error_code, 120) || null,
          stepCount: steps.length,
          phases: [...new Set(steps.map((step) => safeText(step.phase, 80)).filter(Boolean))].sort(),
          failedSteps: steps.filter((step) => ['failed', 'error'].includes(step.status)).slice(0, 20).map((step) => ({
            phase: safeText(step.phase, 80), status: step.status, caseKey: safeText(step.caseKey, 200),
            summary: safeText(step.name || step.detail || '', 300),
          })),
        }
      }),
    }],
    ['artifacts.json', {
      schemaVersion: 1,
      artifacts: artifacts.map((item) => ({
        artifactId: item.artifact_id, attempt: item.attempt, manifestSha256: item.manifest_sha256,
        archiveSha256: item.archive_sha256, size: item.size, truncated: !!item.artifact_truncated,
        scanState: item.scan_state, scannerReportSha256: item.scanner_report_sha256 || null,
      })),
    }],
  ].map(([name, value]) => [name, json(value)])

  const fileManifest = entries.map(([name, data]) => ({ path: name, size: data.length, sha256: sha256(data) }))
  const manifest = {
    schemaVersion: 1,
    format: 'devweft-evidence-pack',
    runId: run.run_id,
    repository: run.repo,
    generatedFromFinishedAt: run.finished_at || null,
    files: fileManifest,
    exclusions: ['source files', 'environment variables', 'secret references', 'raw artifact archives', 'unredacted log bodies'],
  }
  entries.push(['manifest.json', json(manifest)])
  const archive = createZip(entries.map(([name, data]) => ({ name, data })))
  verifyEvidencePack(archive)
  return { archive, manifest, sha256: sha256(archive), fileName: `devweft-evidence-${safeText(run.run_id, 80).replace(/[^a-zA-Z0-9._-]/g, '_')}.zip` }
}

/** Check the ZIP directory, exact manifest file list, each payload size and SHA-256. */
export function verifyEvidencePack(archive) {
  if (!Buffer.isBuffer(archive)) throw new Error('EVIDENCE_PACK_INVALID: archive must be a Buffer')
  const entries = readZipCentralEntries(archive)
  if (entries.length < 2 || entries.length > 100) throw new Error('EVIDENCE_PACK_INVALID: entry count outside limits')
  const byName = new Map(entries.map((entry) => [entry.name, entry]))
  if (byName.size !== entries.length || !byName.has('manifest.json')) throw new Error('EVIDENCE_PACK_INVALID: duplicate entry or manifest missing')
  let manifest
  try { manifest = JSON.parse(byName.get('manifest.json').inflate().toString('utf8')) } catch { throw new Error('EVIDENCE_PACK_INVALID: manifest is not valid JSON') }
  if (manifest?.format !== 'devweft-evidence-pack' || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('EVIDENCE_PACK_INVALID: unsupported manifest')
  }
  const expected = new Set(['manifest.json'])
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || file.path === 'manifest.json' || file.path.includes('\\')
      || file.path.startsWith('/') || file.path.split('/').some((part) => !part || part === '.' || part === '..')
      || expected.has(file.path)) throw new Error('EVIDENCE_PACK_INVALID: invalid manifest file entry')
    expected.add(file.path)
    const entry = byName.get(file.path)
    if (!entry) throw new Error(`EVIDENCE_PACK_INVALID: missing ${file.path}`)
    const data = entry.inflate()
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`EVIDENCE_PACK_INVALID: hash or size mismatch for ${file.path}`)
  }
  if (expected.size !== byName.size || [...byName.keys()].some((name) => !expected.has(name))) throw new Error('EVIDENCE_PACK_INVALID: unlisted ZIP entry')
  return { valid: true, runId: manifest.runId, files: manifest.files.length }
}
