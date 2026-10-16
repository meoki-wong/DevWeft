import { buildFailureAnalysis } from './report-timeline.js'

const TERMINAL = new Set(['passed', 'failed', 'error', 'timed_out', 'lost'])
const CHECK_EVIDENCE = new Set(['passed', 'failed', 'error'])

function parseDate(value, name) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} 日期无效`)
  return date
}

function bucketStart(date, bucket) {
  const out = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  if (bucket === 'week') out.setUTCDate(out.getUTCDate() - ((out.getUTCDay() + 6) % 7))
  return out.toISOString().slice(0, 10)
}

function blankBucket(start) {
  return {
    start, completedRuns: 0, gateRunsWithCompleteCoverage: 0, incompleteGateRuns: 0, noCheckEvidenceRuns: 0,
    gatePassed: 0, gateFailed: 0, checksPassed: 0, checksFailed: 0, checksErrored: 0,
    checksSkipped: 0, durationTotalMs: 0, durationSamples: 0, failureCategories: {},
  }
}

function finishBucket(row) {
  const checkDenominator = row.checksPassed + row.checksFailed + row.checksErrored
  const gateDenominator = row.gatePassed + row.gateFailed
  return {
    ...row,
    checkDenominator,
    checkPassRate: checkDenominator ? row.checksPassed / checkDenominator : null,
    gateDenominator,
    gatePassRate: gateDenominator ? row.gatePassed / gateDenominator : null,
    averageDurationMs: row.durationSamples ? Math.round(row.durationTotalMs / row.durationSamples) : null,
    durationSampleCount: row.durationSamples,
    durationTotalMs: undefined,
    durationSamples: undefined,
  }
}

export async function buildTestingTrends(db, { repoId, from, to, bucket = 'day', unit = null, side = null, now = new Date() } = {}) {
  if (!repoId) throw new Error('repoId 必填')
  if (!['day', 'week'].includes(bucket)) throw new Error('bucket 必须是 day 或 week')
  const end = to ? parseDate(to, 'to') : now
  const start = from ? parseDate(from, 'from') : new Date(end.getTime() - 30 * 86400000)
  if (end <= start) throw new Error('to 必须晚于 from')
  if (end.getTime() - start.getTime() > 366 * 86400000) throw new Error('趋势时间范围最多 366 天')
  const clauses = ['repo_id = ?', "status IN ('passed','failed','error','timed_out','lost')", 'created_at >= ?', 'created_at < ?']
  const args = [repoId, start.toISOString(), end.toISOString()]
  if (unit) { clauses.push('unit = ?'); args.push(unit) }
  if (side) { clauses.push('side = ?'); args.push(side) }
  const runs = await db.prepare(
    `SELECT run_id, unit, side, purpose, status, terminal_reason, coverage_complete,
            created_at, total_ms, report_json FROM test_runs WHERE ${clauses.join(' AND ')} ORDER BY created_at, run_id`
  ).all(...args)
  const buckets = new Map()
  const advance = new Date(start)
  advance.setUTCHours(0, 0, 0, 0)
  const stride = bucket === 'week' ? 7 : 1
  while (advance < end) {
    const key = bucketStart(advance, bucket)
    if (!buckets.has(key)) buckets.set(key, blankBucket(key))
    advance.setUTCDate(advance.getUTCDate() + stride)
  }
  for (const run of runs) {
    const date = parseDate(run.created_at, 'created_at')
    const key = bucketStart(date, bucket)
    if (!buckets.has(key)) buckets.set(key, blankBucket(key))
    const row = buckets.get(key)
    row.completedRuns += 1
    let report = {}
    try { report = JSON.parse(run.report_json || '{}') } catch { /* invalid historical report is missing evidence */ }
    const checks = Array.isArray(report.checks) ? report.checks : []
    const eligible = checks.filter((check) => check && CHECK_EVIDENCE.has(check.status))
    if (!eligible.length) row.noCheckEvidenceRuns += 1
    for (const check of checks) {
      if (check?.status === 'passed') row.checksPassed += 1
      else if (check?.status === 'failed') row.checksFailed += 1
      else if (check?.status === 'error') row.checksErrored += 1
      else if (check?.status === 'skipped') row.checksSkipped += 1
    }
    const coverageComplete = run.coverage_complete === 1 || run.coverage_complete === true || run.coverage_complete === '1'
    if (run.purpose === 'gate') {
      if (!coverageComplete) row.incompleteGateRuns += 1
      else {
        row.gateRunsWithCompleteCoverage += 1
        if (eligible.length && ['passed', 'failed', 'error'].includes(run.status)) {
          if (run.status === 'passed') row.gatePassed += 1
          else row.gateFailed += 1
          if (Number.isFinite(run.total_ms) && run.total_ms >= 0) {
            row.durationTotalMs += run.total_ms
            row.durationSamples += 1
          }
        }
      }
    }
    const analysis = buildFailureAnalysis({ run, checks, attempts: [] })
    if (analysis.hasFailure && analysis.category) row.failureCategories[analysis.category] = (row.failureCategories[analysis.category] || 0) + 1
  }
  const series = [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start)).map(finishBucket)
  const overall = finishBucket(series.reduce((sum, item) => {
    for (const key of ['completedRuns', 'gateRunsWithCompleteCoverage', 'incompleteGateRuns', 'noCheckEvidenceRuns', 'gatePassed', 'gateFailed', 'checksPassed', 'checksFailed', 'checksErrored', 'checksSkipped']) sum[key] += item[key]
    sum.durationTotalMs += item.averageDurationMs == null ? 0 : item.averageDurationMs * item.durationSampleCount
    sum.durationSamples += item.durationSampleCount
    for (const [category, count] of Object.entries(item.failureCategories)) sum.failureCategories[category] = (sum.failureCategories[category] || 0) + count
    return sum
  }, blankBucket('overall')))
  return {
    ok: true,
    repoId,
    period: { from: start.toISOString(), to: end.toISOString(), bucket, unit, side },
    methodology: {
      checkPassRate: 'passed / (passed + failed + error); skipped and unknown statuses excluded',
      gatePassRate: 'passed / (passed + failed/error) among gate runs with complete coverage and at least one reported result check',
      duration: 'mean recorded total_ms among gate runs in the gate pass-rate denominator',
      missingEvidence: 'reported separately and excluded; an empty denominator yields null, never 100%',
    },
    overall,
    series,
  }
}
