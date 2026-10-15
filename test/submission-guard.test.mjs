import { describe, it, expect, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { seedBaselineRunner } from '../testing/bootstrap.js'
import { createPrincipal } from '../testing/auth.js'
import { registerRemote } from '../testing/remotes.js'
import { createBlobStore } from '../testing/blobs.js'
import { ensureGateTaskInstance, submitGateRun } from '../testing/submit-run.js'
import { createTestSubmission, getTestSubmission } from '../testing/submissions.js'
import { rememberIdempotency } from '../testing/idempotency.js'
import { documentSha256 } from '../contracts/version.mjs'
import * as snapshots from '../testing/snapshots.js'
import * as audit from '../audit/index.js'
import { detectChangeKind } from '../harness/testing-gate.js'
import { join, dirname } from 'node:path'
import {
  assertSourceReady, beginSourceAttempt, failSourceAttempt, completeSourceAttempt,
  safeContextText,
} from '../testing/submission-guard.js'
import { preflightSubmissionAc } from '../harness/testing-gate.js'

const cleanups = []
afterEach(() => {
  vi.restoreAllMocks()
  while (cleanups.length) cleanups.pop()()
})
const AC = [{ id: 'AC-1', text: '返回正确数据', type: 'data' }]

function tempRoot() {
  const root = mkdtempSync(join(dirname(process.env.AWP_DB_PATH), 'submission-guard-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function sourceRequest(overrides = {}) {
  return { repoId: 'repo-a', taskId: 'task-a', requestedRef: 'feature-a', ...overrides }
}

describe('持久来源锁', () => {
  it('失败在关库重开后仍阻止省略目标，显式成功才能解除且仓库任务隔离', async () => {
    const path = join(tempRoot(), 'guard.db')
    let db = new Database(path)
    const attemptId = await beginSourceAttempt(db, sourceRequest())
    await failSourceAttempt(db, { ...sourceRequest(), attemptId, code: 'SYNC_REF_NOT_FOUND' })
    db.close()
    db = new Database(path)
    cleanups.push(() => db.close())
    await expect(beginSourceAttempt(db, sourceRequest({ requestedRef: null }))).rejects.toThrow('SOURCE_TARGET_REQUIRED')
    await assertSourceReady(db, 'repo-b', 'task-a') // 成功即不抛（返回 undefined）
    await assertSourceReady(db, 'repo-a', 'task-b')
    const retry = await beginSourceAttempt(db, sourceRequest({ requestedRef: 'feature-fixed' }))
    await expect(completeSourceAttempt(db, { ...sourceRequest(), attemptId: retry,
      headCommitOid: 'new', expectedHead: 'old' })).rejects.toThrow('SOURCE_SNAPSHOT_MISMATCH')
    await expect(assertSourceReady(db, 'repo-a', 'task-a')).rejects.toThrow('SOURCE_TARGET_REQUIRED')
    await completeSourceAttempt(db, { ...sourceRequest(), attemptId: retry, headCommitOid: 'new', expectedHead: 'new' })
    await assertSourceReady(db, 'repo-a', 'task-a') // 成功即不抛；原 not.toThrow 语义
  })

  it('同步中断即保持锁，旧请求成功不能解除后来请求的锁', async () => {
    const db = new Database(':memory:')
    cleanups.push(() => db.close())
    const old = await beginSourceAttempt(db, sourceRequest())
    await beginSourceAttempt(db, sourceRequest({ requestedRef: 'new-target' }))
    await expect(completeSourceAttempt(db, { ...sourceRequest(), attemptId: old,
      headCommitOid: 'same', expectedHead: 'same' })).rejects.toThrow('SOURCE_ATTEMPT_SUPERSEDED')
    await expect(assertSourceReady(db, 'repo-a', 'task-a')).rejects.toThrow('SOURCE_TARGET_REQUIRED')
  })

  it('诊断文本不泄漏 URL 凭据或 token', () => {
    const out = safeContextText('token=private-value https://u:pw@example.test/a Bearer secret-value')
    expect(out).not.toMatch(/private-value|u:pw|secret-value/)
  })
})

describe('纯 AC 提交预检', () => {
  it('首次无卷拒绝，使用本轮冻结 acceptanceRefs，不需要旧 binding/变异/F2P', () => {
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'M', acceptance: AC, specs: [] }))
      .toMatchObject({ applicable: true, ok: false, missing: ['AC-1'] })
    expect(preflightSubmissionAc({ mode: 'enforce_ml', size: 'L', acceptance: AC,
      taskId: 'T', specs: [{ acceptanceRefs: ['AC-1'], demandRef: 'T' }] })).toMatchObject({ ok: true })
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'M', acceptance: AC,
      taskId: 'T', specs: [{ acceptanceRefs: ['AC-1'], demandRef: 'OTHER' }] })).toMatchObject({ ok: false })
  })

  it('nightly 合成任务豁免：合成 AC 不可能被真实卷 acceptanceRefs 引用，覆盖由提交本身天然满足', () => {
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'M', acceptance: AC, specs: [], nightly: true }))
      .toMatchObject({ applicable: false, ok: true })
    // 正常任务不受豁免影响：同参不带 nightly 仍拦截
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'M', acceptance: AC, specs: [], nightly: false }))
      .toMatchObject({ applicable: true, ok: false, missing: ['AC-1'] })
  })

  it.each(['observe', 'disabled', 'legacy'])('%s 不阻断', (mode) => {
    expect(preflightSubmissionAc({ mode, size: 'M', acceptance: AC })).toMatchObject({ applicable: false, ok: true })
  })

  it('S 和无 AC 不阻断', () => {
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'S', acceptance: AC })).toMatchObject({ ok: true })
    expect(preflightSubmissionAc({ mode: 'enforce_all', size: 'L' })).toMatchObject({ ok: true })
  })
})
