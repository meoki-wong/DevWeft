/**
 * deferred-retry.test.mjs — P1-A：deferred 失败分类/退避重试 + diff 结构预校验
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import {
  recordDeferredSubmission, claimPendingDeferred, failDeferred,
  retryDeferredSubmission, classifyDeferredError, getDeferredById, DEFERRED_STATUS,
} from '../testing/deferred.js'
import { assertDiffParseable } from '../testing/workspace-pool.mjs'

const wtRoot = mkdtempSync(join(tmpdir(), 'awp-defer-retry-wt-'))
process.env.AWP_WT_ROOT = wtRoot
afterAll(() => { try { rmSync(wtRoot, { recursive: true, force: true }) } catch { /* 尽力 */ } })

async function freshDb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-defer-retry-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  await db.exec(`INSERT OR IGNORE INTO repositories(repo_id, slug, created_at) VALUES ('r1', 'demo-app', '2026-01-01T00:00:00Z')`)
  return db
}
const INPUT = () => ({
  repoId: 'r1', taskId: 'task-retry', author: 'superhippo', side: 'web',
  codeCommitOid: 'abc123', codeDiff: 'diff --git a/x b/x\nindex a..b 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
})
async function newPending(db) {
  const rec = await recordDeferredSubmission(db, INPUT())
  return rec.deferredId
}

describe('classifyDeferredError', () => {
  it('corrupt/未知仓/base 不匹配 → permanent', () => {
    for (const c of ['SOURCE_DIFF_CORRUPT', 'DEFERRED_REPO_UNKNOWN', 'SOURCE_DIFF_APPLY_FAILED', 'WORKSPACE_NOT_FOUND']) {
      expect(classifyDeferredError(new Error(c))).toBe('permanent')
    }
    const e = new Error('boom'); e.permanent = true
    expect(classifyDeferredError(e)).toBe('permanent')
  })
  it('锁超时/网络/PG 抖动/未知 → transient', () => {
    for (const c of ['WORKSPACE_LOCK_TIMEOUT', 'ECONNREFUSED', 'current transaction is aborted', '随机异常']) {
      expect(classifyDeferredError(new Error(c))).toBe('transient')
    }
  })
})

describe('failDeferred 退避重试', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('transient 且未超上限 → 退回 pending + attempts+1 + next_retry_at，下轮到期前不认领', async () => {
    const id = await newPending(db)
    const r = await failDeferred(db, { deferredId: id, errorMessage: 'ECONNRESET', errorClass: 'transient' })
    expect(r).toMatchObject({ status: DEFERRED_STATUS.PENDING, willRetry: true, attempts: 1 })
    const row = await getDeferredById(db, { deferredId: id })
    expect(row.next_retry_at).toBeTruthy()
    expect(row.last_error_class).toBe('transient')
    // 未到期：认领应拿不到（next_retry_at 在未来）
    const claimed = await claimPendingDeferred(db, 'w1')
    expect(claimed).toBe(null)
  })

  it('transient 达到 max_attempts → 终态 failed', async () => {
    const id = await newPending(db)
    await failDeferred(db, { deferredId: id, errorMessage: 'ECONNRESET', errorClass: 'transient' }) // a1
    await failDeferred(db, { deferredId: id, errorMessage: 'ECONNRESET', errorClass: 'transient' }) // a2 (<3 仍 pending)
    let row = await getDeferredById(db, { deferredId: id })
    row.next_retry_at = null // 模拟到期，便于第三次认领失败
    await db.prepare('UPDATE deferred_submissions SET next_retry_at=NULL, updated_at=? WHERE deferred_id=?').run(new Date().toISOString(), id)
    const c = await claimPendingDeferred(db, 'w1'); expect(c && c.deferred_id).toBe(id)
    const r = await failDeferred(db, { deferredId: id, errorMessage: 'ECONNRESET', errorClass: 'transient' }) // a3 → 3<3 假 → failed
    expect(r).toMatchObject({ status: DEFERRED_STATUS.FAILED, willRetry: false, attempts: 3 })
  })

  it('permanent → 立即终态 failed', async () => {
    const id = await newPending(db)
    const r = await failDeferred(db, { deferredId: id, errorMessage: 'SOURCE_DIFF_APPLY_FAILED', errorClass: 'permanent' })
    expect(r).toMatchObject({ status: DEFERRED_STATUS.FAILED, willRetry: false })
  })

  it('retryDeferredSubmission 把 failed 复位 pending、attempts 归零', async () => {
    const id = await newPending(db)
    await failDeferred(db, { deferredId: id, errorMessage: 'permanent', errorClass: 'permanent' })
    const rr = await retryDeferredSubmission(db, { deferredId: id })
    expect(rr.changed).toBe(true)
    const row = await getDeferredById(db, { deferredId: id })
    expect(row.status).toBe(DEFERRED_STATUS.PENDING)
    expect(Number(row.attempts)).toBe(0)
    expect(row.next_retry_at).toBe(null)
  })
})

describe('assertDiffParseable 结构预校验', () => {
  const valid = 'diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
  const corrupt = 'diff --git a/y b/y\nindex 1111111..2222222 100644\n--- a/y\n+++ b/y\n@@ -1,2 +1,2 @@\n-a\n+b\n' // 声明 2 行只 1 行
  it('合法补丁通过', () => { expect(assertDiffParseable(valid)).toBe(true) })
  it('空补丁 → SOURCE_DIFF_EMPTY(permanent)', () => {
    try { assertDiffParseable('   \n'); throw new Error('SHOULD_NOT_REACH') }
    catch (e) { expect(String(e.code || e.message)).toMatch(/SOURCE_DIFF_EMPTY/); expect(e.permanent).toBe(true) }
  })
  it('截断 corrupt → SOURCE_DIFF_CORRUPT(permanent)，不伪装成功', () => {
    try { assertDiffParseable(corrupt); throw new Error('SHOULD_NOT_REACH') }
    catch (e) { expect(String(e.code || e.message)).toMatch(/SOURCE_DIFF_CORRUPT/); expect(e.permanent).toBe(true) }
  })
})
