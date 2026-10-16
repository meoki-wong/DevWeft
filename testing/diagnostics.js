/** Read-only, evidence-backed diagnostics for one completed test run. */
import { createHash } from 'node:crypto'
import { buildFailureAnalysis, buildTimeline } from './report-timeline.js'

const FAILING = new Set(['failed', 'error'])

function parseReport(value) {
  try { return JSON.parse(value || '{}') } catch { return {} }
}

function stableId(runId, category, caseKey) {
  return createHash('sha256').update(`${runId}\0${category}\0${caseKey || ''}`).digest('hex').slice(0, 20)
}

function suggestionsFor(run, analysis) {
  if (!analysis?.hasFailure) return []
  const category = analysis.category || 'unknown'
  const action = category === 'suite' ? 'review-suite'
    : category === 'infra' ? 'inspect-runner'
      : category === 'product' ? 'inspect-product'
        : 'inspect-evidence'
  const title = category === 'suite' ? '复核测试套件'
    : category === 'infra' ? '检查执行环境'
      : category === 'product' ? '定位产品失败'
        : '补充失败证据'
  return [{
    suggestionId: stableId(run.run_id, action, analysis.firstCaseKey),
    action,
    title,
    category,
    reason: analysis.categoryZh || '失败原因未分类',
    evidence: {
      runId: run.run_id,
      caseKey: analysis.firstCaseKey || null,
      terminalReason: run.terminal_reason || null,
      failedChecks: analysis.failedChecks || [],
      source: 'stored_run_report',
    },
    nextStep: analysis.text?.split('\n').find((line) => line.startsWith('建议：'))?.slice(3) || '查看运行时间线和失败日志。',
  }]
}

function parseFeedback(rows) {
  const latest = new Map()
  for (const row of rows) {
    let payload
    try { payload = JSON.parse(row.payload_json || '{}') } catch { continue }
    if (!payload.suggestionId || !['confirm', 'ignore'].includes(payload.action)) continue
    latest.set(payload.suggestionId, {
      action: payload.action,
      author: row.author || null,
      createdAt: row.created_at,
      note: payload.note || null,
      auditId: row.id,
    })
  }
  return latest
}

/**
 * Build diagnostics exclusively from immutable run output and same-repository history.
 * No model-generated text is accepted or persisted by this service.
 */
export async function getRunDiagnostics(db, runId) {
  const run = await db.prepare(
    `SELECT run_id, repo_id, task_instance_id, unit, side, status, terminal_reason,
            report_json, created_at, started_at, finished_at, total_ms
     FROM test_runs WHERE run_id = ?`
  ).get(runId)
  if (!run) return null
  const repo = await db.prepare('SELECT slug FROM repositories WHERE repo_id = ?').get(run.repo_id)
  const report = parseReport(run.report_json)
  const checks = Array.isArray(report.checks) ? report.checks : []
  const attempts = await db.prepare(
    `SELECT a.attempt, a.status, a.started_at, a.finished_at, a.heartbeat_at,
            a.error_code, a.error_detail, a.image_id, a.steps_json, w.hostname AS worker
     FROM run_attempts a LEFT JOIN workers w ON w.worker_id = a.worker_id
     WHERE a.run_id = ? ORDER BY a.attempt`
  ).all(runId)
  const timeline = buildTimeline({ run, attempts, checks, reportAttempt: report.attempt })
  const failureAnalysis = buildFailureAnalysis({ run, checks, attempts })
  const suggestions = suggestionsFor(run, failureAnalysis)
  const failedCheck = checks.find((check) => FAILING.has(check.status))

  let similarFailures = []
  let similarExperiences = []
  if (failedCheck && run.repo_id) {
    const category = failureAnalysis.category || 'unknown'
    similarFailures = await db.prepare(
      `SELECT failure_id, failure_phase, failure_class, case_key, error_signature,
              occurrence_count, status, first_seen_at, last_seen_at
       FROM test_failures
       WHERE repo_id = ? AND case_key = ? AND failure_class = ?
       ORDER BY last_seen_at DESC LIMIT 8`
    ).all(run.repo_id, failedCheck.caseKey || '', category === 'suite' ? 'suite' : category === 'infra' ? 'infra' : 'product')

    const experiences = await db.prepare(
      `SELECT experience_id, title, content, source_type, source_id, failure_fingerprint,
              confidence, tags_json, reviewed_at, created_at
       FROM experiences WHERE repo_id = ? ORDER BY created_at DESC LIMIT 50`
    ).all(run.repo_id)
    const failureIds = new Set(similarFailures.map((item) => item.failure_id))
    similarExperiences = experiences.filter((item) => {
      if (item.source_type === 'test_failure' && failureIds.has(item.source_id)) return true
      let tags = []
      try { tags = JSON.parse(item.tags_json || '[]') } catch { /* ignore malformed legacy tags */ }
      return Array.isArray(tags) && tags.some((tag) => tag === category || tag === failedCheck.caseKey)
    }).slice(0, 5).map(({ experience_id, title, content, source_type, source_id, confidence, reviewed_at, created_at }) => ({
      experienceId: experience_id, title, content, sourceType: source_type, sourceId: source_id,
      confidence, reviewedAt: reviewed_at, createdAt: created_at,
    }))
  }

  const feedbackRows = await db.prepare(
    `SELECT id, author, created_at, payload_json FROM audit_events
     WHERE event_type = 'testing_diagnostic_feedback' AND run_id = ? ORDER BY id`
  ).all(runId)
  const feedback = parseFeedback(feedbackRows)
  return {
    ok: true,
    runId: run.run_id,
    repo: repo?.slug || null,
    unit: run.unit,
    side: run.side,
    status: run.status,
    terminalReason: run.terminal_reason,
    phase: timeline.find((step) => step.status === 'failed' || step.status === 'error')?.phase || null,
    failureAnalysis,
    timeline,
    similarFailures,
    similarExperiences,
    suggestions: suggestions.map((suggestion) => ({ ...suggestion, feedback: feedback.get(suggestion.suggestionId) || null })),
  }
}

export function validateDiagnosticFeedback(action, note = '') {
  if (!['confirm', 'ignore'].includes(action)) return { ok: false, error: 'action 必须是 confirm 或 ignore' }
  if (typeof note !== 'string' || note.length > 1000) return { ok: false, error: 'note 必须是 1000 字以内的文本' }
  return { ok: true, note: note.trim() || null }
}
