import { describe, expect, it } from 'vitest'
import { createZip } from '../runner/guest-agent/zip.mjs'
import { readZipCentralEntries } from '../scanner/zipscan.mjs'
import { buildRunEvidencePack, verifyEvidencePack } from '../testing/evidence-pack.js'

const explanation = {
  environment: {
    snapshot: { headCommitOid: 'abc123', changedPathsSha256: 'paths-hash' },
    executionProfile: { profileRevisionId: 'profile-1', contentSha256: 'profile-hash', timeouts: { runMs: 1000 }, networkPolicyId: 'network-local' },
    runnerImage: { imageId: 'image-1', manifestSha256: 'image-hash' },
    policyRevision: { policyRevisionId: 'policy-1', contentSha256: 'policy-hash' },
  },
  selection: { suite: {
    suitePlanId: 'suite-plan', lockSha256: 'lock-hash', requiredCaseSetSha256: 'required-hash', advisoryCaseSetSha256: 'advisory-hash',
    lockedCases: [{ caseKey: 'smoke:checkout', selectedForRun: true, runSelectionReasonCode: 'MATCHED_RUN_UNIT_AND_SIDE', protected: true,
      source: { layer: 'base', suiteRevisionId: 'revision-1', revisionContentSha256: 'revision-hash' } }],
  } },
}
const run = { run_id: 'run-1', repo_id: 'repo-1', repo: 'example-app', binding_id: 'binding-1', unit: 'smoke', side: 'web', purpose: 'gate',
  status: 'failed', terminal_reason: 'assertion_failed', total_ms: 420, result_sha256: 'result-hash', created_at: '2026-01-01',
  started_at: '2026-01-01T00:00:01Z', finished_at: '2026-01-01T00:00:02Z',
  report_json: JSON.stringify({ attempt: 1, checks: [{ caseKey: 'smoke:checkout', status: 'failed', durationMs: 120, detail: 'password=do-not-export' }], source: 'private source body' }) }
const attempts = [{ attempt: 1, status: 'failed', started_at: '2026-01-01T00:00:01Z', finished_at: '2026-01-01T00:00:02Z',
  error_code: 'ASSERTION_FAILED', error_detail: 'token=secret', steps_json: JSON.stringify([{ phase: 'smoke', status: 'failed', name: '/Users/alice/private/project token=secret' }]) }]
const artifacts = [{ artifact_id: 'artifact-1', attempt: 1, manifest_sha256: 'manifest-hash', archive_sha256: 'archive-hash', size: 123, artifact_truncated: 0, scan_state: 'passed', scanner_report_sha256: null }]

function fakeDb() {
  return { prepare(sql) { return {
    get: async () => sql.includes('FROM test_runs') ? run : null,
    all: async () => sql.includes('FROM run_attempts') ? attempts : sql.includes('FROM artifacts') ? artifacts : [],
  } } }
}

describe('reproducible evidence pack', () => {
  it('exports only allowlisted metadata and verifies deterministic file hashes', async () => {
    const first = await buildRunEvidencePack(fakeDb(), 'run-1', { explain: async () => explanation })
    const second = await buildRunEvidencePack(fakeDb(), 'run-1', { explain: async () => explanation })
    expect(first.sha256).toBe(second.sha256)
    expect(verifyEvidencePack(first.archive)).toEqual({ valid: true, runId: 'run-1', files: 5 })
    const entries = readZipCentralEntries(first.archive)
    const files = new Map(entries.map((entry) => [entry.name, entry.inflate().toString('utf8')]))
    expect(files.get('artifacts.json')).toContain('archive-hash')
    expect(files.get('suite-lock.json')).toContain('smoke:checkout')
    expect(files.get('logs-summary.json')).toContain('[local-path]')
    const all = [...files.values()].join('\n')
    expect(all).not.toContain('private source body')
    expect(all).not.toContain('do-not-export')
    expect(all).not.toContain('token=secret')
    expect(all).not.toContain('/Users/alice')
  })

  it('rejects tampered entry hashes, extra files, and packs with no run', async () => {
    const pack = await buildRunEvidencePack(fakeDb(), 'run-1', { explain: async () => explanation })
    const entries = readZipCentralEntries(pack.archive).map((entry) => ({ name: entry.name, data: entry.inflate() }))
    const corrupted = entries.map((entry) => entry.name === 'checks.json' ? { ...entry, data: Buffer.from('{}') } : entry)
    expect(() => verifyEvidencePack(createZip(corrupted))).toThrow(/hash or size mismatch/)
    expect(() => verifyEvidencePack(createZip([...entries, { name: 'unlisted.txt', data: Buffer.from('x') }]))).toThrow(/unlisted ZIP entry/)
    expect(await buildRunEvidencePack({ prepare: () => ({ get: async () => null }) }, 'missing', { explain: async () => explanation })).toBeNull()
  })
})
