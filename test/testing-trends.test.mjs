import { describe, expect, it } from 'vitest'
import { buildTestingTrends } from '../testing/trends.js'

const rows = [
  { run_id: 'pass', purpose: 'gate', status: 'passed', coverage_complete: 1, created_at: '2026-03-02T10:00:00Z', total_ms: 1000,
    report_json: JSON.stringify({ checks: [{ caseKey: 'a', status: 'passed' }, { caseKey: 'waived', status: 'skipped' }] }) },
  { run_id: 'partial', purpose: 'gate', status: 'failed', coverage_complete: 0, created_at: '2026-03-02T11:00:00Z', total_ms: 2000,
    report_json: JSON.stringify({ checks: [{ caseKey: 'b', status: 'failed' }, { caseKey: 'skip', status: 'skipped' }] }) },
  { run_id: 'error', purpose: 'gate', status: 'error', coverage_complete: true, created_at: '2026-03-03T10:00:00Z', total_ms: 3000,
    report_json: JSON.stringify({ checks: [{ caseKey: 'c', status: 'error' }] }) },
  { run_id: 'no-evidence', purpose: 'gate', status: 'passed', coverage_complete: 1, created_at: '2026-03-03T11:00:00Z', total_ms: 4000,
    report_json: JSON.stringify({ checks: [{ caseKey: 'not-run', status: 'skipped' }] }) },
]
const db = { prepare: () => ({ all: async () => rows }) }

describe('testing trends denominators', () => {
  it('excludes skipped and incomplete/no-evidence runs and returns unknown for empty buckets', async () => {
    const result = await buildTestingTrends(db, { repoId: 'repo-1', from: '2026-03-01T00:00:00Z', to: '2026-03-05T00:00:00Z', now: new Date('2026-03-05T00:00:00Z') })
    expect(result.overall).toMatchObject({
      checkDenominator: 3, checksPassed: 1, checksFailed: 1, checksErrored: 1, checksSkipped: 3,
      checkPassRate: 1 / 3, gateDenominator: 2, gatePassed: 1, gateFailed: 1, gatePassRate: 0.5,
      incompleteGateRuns: 1, noCheckEvidenceRuns: 1, averageDurationMs: 2000,
    })
    expect(result.series).toHaveLength(4)
    expect(result.series[0].checkPassRate).toBeNull()
    expect(result.series[1].checkDenominator).toBe(2)
    expect(result.series[2].gatePassRate).toBe(0)
    expect(result.methodology.checkPassRate).toContain('skipped')
  })

  it('validates bounded periods and bucket types', async () => {
    await expect(buildTestingTrends(db, { repoId: 'r', from: '2026-03-05', to: '2026-03-01' })).rejects.toThrow('to 必须晚于 from')
    await expect(buildTestingTrends(db, { repoId: 'r', from: '2024-01-01', to: '2026-01-01' })).rejects.toThrow('最多 366 天')
    await expect(buildTestingTrends(db, { repoId: 'r', bucket: 'month' })).rejects.toThrow('bucket 必须是 day 或 week')
  })
})
