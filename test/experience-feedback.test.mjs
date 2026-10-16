import { readFileSync } from 'node:fs'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { createExperienceFeedback, listExperienceFeedback, reviewExperienceFeedback } from '../testing/experience-feedback.js'

let db
beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`CREATE TABLE repositories(repo_id TEXT PRIMARY KEY);
    CREATE TABLE test_runs(run_id TEXT PRIMARY KEY, repo_id TEXT);
    CREATE TABLE test_failures(failure_id TEXT PRIMARY KEY, repo_id TEXT);
    INSERT INTO repositories VALUES ('repo-a'),('repo-b');
    INSERT INTO test_runs VALUES ('run-a','repo-a'),('run-b','repo-b');
    INSERT INTO test_failures VALUES ('failure-a','repo-a'),('failure-b','repo-b');`)
  db.exec(readFileSync(new URL('../testing/schema-v43.sql', import.meta.url), 'utf8'))
})
afterEach(() => db.close())

describe('structured experience feedback', () => {
  it('stores feedback as unverified, lists by repository, then records human review time', async () => {
    const createdAt = new Date('2026-02-03T04:05:06.000Z')
    const created = await createExperienceFeedback(db, {
      repoId: 'repo-a', runId: 'run-a', failureId: 'failure-a', sourceType: 'run', author: 'contributor',
      failureSummary: 'checkout test returned a server error', resolutionSummary: 'validate the response status before rendering the confirmation',
      scope: { unit: 'smoke', side: 'web', caseKey: 'checkout', phase: 'smoke' },
      evidence: { runId: 'run-a', caseKey: 'checkout', source: 'stored_run_report' },
    }, { now: createdAt })
    expect(created).toMatchObject({ repoId: 'repo-a', runId: 'run-a', failureId: 'failure-a', verificationStatus: 'unverified', createdAt: createdAt.toISOString() })
    expect(await listExperienceFeedback(db, { repoId: 'repo-b' })).toEqual([])
    expect((await listExperienceFeedback(db, { repoId: 'repo-a', status: 'unverified' }))[0]).toMatchObject({ feedback_id: created.feedbackId, scope: { caseKey: 'checkout' } })

    const reviewed = await reviewExperienceFeedback(db, { feedbackId: created.feedbackId, action: 'confirm', reviewer: 'maintainer', note: 'reproduced on the same test fixture', now: new Date('2026-02-04T04:05:06.000Z') })
    expect(reviewed).toMatchObject({ verification_status: 'confirmed', reviewed_by: 'maintainer', review_note: 'reproduced on the same test fixture', evidence: { runId: 'run-a' } })
    expect(await listExperienceFeedback(db, { repoId: 'repo-a', status: 'confirmed' })).toHaveLength(1)
    await expect(reviewExperienceFeedback(db, { feedbackId: created.feedbackId, action: 'reject' })).rejects.toThrow('已审核')
  })

  it('rejects cross-repository evidence and secret-shaped data', async () => {
    const base = { repoId: 'repo-a', failureSummary: 'the test fails under the current fixture', resolutionSummary: 'rebuild the fixture before checking the response',
      scope: { unit: 'static' }, evidence: { source: 'manual' } }
    await expect(createExperienceFeedback(db, { ...base, runId: 'run-b' })).rejects.toThrow('同一仓库')
    await expect(createExperienceFeedback(db, { ...base, failureId: 'failure-b' })).rejects.toThrow('同一仓库')
    const token = `ghp_${'a'.repeat(36)}`
    await expect(createExperienceFeedback(db, { ...base, resolutionSummary: `use token=${token}` })).rejects.toThrow('疑似密钥')
    await expect(createExperienceFeedback(db, { ...base, evidence: { apiKey: 'secret' } })).rejects.toThrow('敏感字段')
    await expect(createExperienceFeedback(db, { ...base, scope: [] })).rejects.toThrow('JSON 对象')
  })
})
