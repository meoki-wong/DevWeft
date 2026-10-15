/**
 * deferred-submission.test.mjs — testing/deferred.js 单元契约
 *
 * 主备切换方案 A 的关键组件：
 *   - standby 收到 test_run 时把 codeDiff 落这张表，主机 host-worker 认领并生成真 submission
 *   - 同 client_request_id 幂等（R1：客户端超时重试不双下单）
 *   - stale claimed 自动回 pending（R4：worker 崩溃后不永久占用）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it, beforeEach } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import {
  deriveClientRequestId,
  recordDeferredSubmission,
  claimPendingDeferred,
  completeDeferred,
  failDeferred,
  sweepStaleClaimed,
  getDeferredById,
  getDeferredByClientRequestId,
  findRecentDeferredForTask,
  DEFERRED_STATUS,
} from '../testing/deferred.js'

async function freshDb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-deferred-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  // 保证测试仓存在（recordDeferredSubmission 不强依赖 FK，但一致性检查用）
  await db.exec(`INSERT OR IGNORE INTO repositories(repo_id, slug, created_at) VALUES ('r1', 'demo-app', '2026-01-01T00:00:00Z')`)
  return db
}

const BASE_INPUT = () => ({
  repoId: 'r1',
  taskId: '2026-10-13-deferred-test',
  author: 'superhippo',
  side: 'web',
  sideReason: 'unit',
  sourceRef: null,
  codeCommitOid: 'abc123def456',
  codeDiff: 'diff --git a/x b/x\nindex aaa..bbb 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n',
  triggerReason: 'ut',
})

describe('deriveClientRequestId', () => {
  it('explicit id 优先返回自身', () => {
    expect(deriveClientRequestId({ explicitId: 'user-uuid', repoId: 'r1', taskId: 't', codeDiff: 'x' }))
      .toBe('user-uuid')
  })

  it('同内容 → 同 hash（幂等基石）', () => {
    const a = deriveClientRequestId({ repoId: 'r1', taskId: 't', codeCommitOid: 'sha1', codeDiff: 'same diff', side: 'web' })
    const b = deriveClientRequestId({ repoId: 'r1', taskId: 't', codeCommitOid: 'sha1', codeDiff: 'same diff', side: 'web' })
    expect(a).toBe(b)
    expect(a.startsWith('derived:')).toBe(true)
  })

  it('任一字段变 → 新 hash（不误去重）', () => {
    const base = { repoId: 'r1', taskId: 't', codeCommitOid: 'sha1', codeDiff: 'diff', side: 'web' }
    const variants = [
      { ...base, codeDiff: 'DIFFERENT' },
      { ...base, codeCommitOid: 'OTHER_SHA' },
      { ...base, side: 'admin' },
      { ...base, taskId: 'other-task' },
    ]
    const ids = variants.map((v) => deriveClientRequestId(v))
    expect(new Set(ids).size).toBe(variants.length)
  })
})

describe('recordDeferredSubmission', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('首次插入 → created:true status:pending', async () => {
    const out = await recordDeferredSubmission(db, BASE_INPUT())
    expect(out.created).toBe(true)
    expect(out.status).toBe(DEFERRED_STATUS.PENDING)
    expect(out.deferredId).toMatch(/^[0-9a-f-]{36}$/i)
    const row = await getDeferredById(db, { deferredId: out.deferredId })
    expect(row.author).toBe('superhippo')
    expect(row.code_diff.length).toBeGreaterThan(0)
  })

  it('R1 幂等：同 (repo,taskId,diff,base) 二次插入 → created:false 复用同一行', async () => {
    const first = await recordDeferredSubmission(db, BASE_INPUT())
    const second = await recordDeferredSubmission(db, BASE_INPUT())
    expect(second.created).toBe(false)
    expect(second.deferredId).toBe(first.deferredId)
    // DB 中只有一条
    const count = await db.prepare('SELECT COUNT(*) c FROM deferred_submissions').get()
    expect(Number(count.c)).toBe(1)
  })

  it('不同 codeDiff → 两条独立行', async () => {
    const a = await recordDeferredSubmission(db, BASE_INPUT())
    const b = await recordDeferredSubmission(db, { ...BASE_INPUT(), codeDiff: 'diff --git a/y b/y\n+++ b/y\n' })
    expect(a.deferredId).not.toBe(b.deferredId)
    const count = await db.prepare('SELECT COUNT(*) c FROM deferred_submissions').get()
    expect(Number(count.c)).toBe(2)
  })

  it('缺 codeDiff → 抛 DEFERRED_REQUIRES_DIFF', async () => {
    await expect(recordDeferredSubmission(db, { ...BASE_INPUT(), codeDiff: '' }))
      .rejects.toThrow(/DEFERRED_REQUIRES_DIFF/)
    await expect(recordDeferredSubmission(db, { ...BASE_INPUT(), codeDiff: null }))
      .rejects.toThrow(/DEFERRED_REQUIRES_DIFF/)
  })

  it('productFixed/suiteFixed 布尔落 0/1', async () => {
    const out = await recordDeferredSubmission(db, { ...BASE_INPUT(), productFixed: true })
    const row = await getDeferredById(db, { deferredId: out.deferredId })
    expect(Number(row.product_fixed)).toBe(1)
    expect(Number(row.suite_fixed)).toBe(0)
  })
})

describe('claimPendingDeferred', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('空表 → 返回 null', async () => {
    expect(await claimPendingDeferred(db, 'w1')).toBeNull()
  })

  it('一条 pending → 认领并标 claimed，同 worker 二次 → null', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    const claimed = await claimPendingDeferred(db, 'w1')
    expect(claimed.deferred_id).toBe(deferredId)
    const after = await getDeferredById(db, { deferredId })
    expect(after.status).toBe(DEFERRED_STATUS.CLAIMED)
    expect(after.claimed_by_worker).toBe('w1')
    // 二次无 pending
    expect(await claimPendingDeferred(db, 'w1')).toBeNull()
  })

  it('多条 pending → 按 created_at FIFO', async () => {
    const a = await recordDeferredSubmission(db, BASE_INPUT())
    // 稍等保证顺序（同一 tick 会撞 same created_at）
    await new Promise((r) => setTimeout(r, 15))
    const b = await recordDeferredSubmission(db, { ...BASE_INPUT(), taskId: 'second-task' })
    const first = await claimPendingDeferred(db, 'w1')
    expect(first.deferred_id).toBe(a.deferredId)
    const second = await claimPendingDeferred(db, 'w1')
    expect(second.deferred_id).toBe(b.deferredId)
  })
})

describe('completeDeferred / failDeferred', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('complete → status=processed 并关联 processed_submission_id', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    await claimPendingDeferred(db, 'w1')
    await completeDeferred(db, { deferredId, processedSubmissionId: 'real-sub-uuid' })
    const row = await getDeferredById(db, { deferredId })
    expect(row.status).toBe(DEFERRED_STATUS.PROCESSED)
    expect(row.processed_submission_id).toBe('real-sub-uuid')
  })

  it('fail → status=failed 带 error_message', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    await claimPendingDeferred(db, 'w1')
    await failDeferred(db, { deferredId, errorMessage: 'SOURCE_SYNC_FAILED: bad base' })
    const row = await getDeferredById(db, { deferredId })
    expect(row.status).toBe(DEFERRED_STATUS.FAILED)
    expect(row.error_message).toMatch(/bad base/)
  })

  it('error_message 超 2000 字符 → 截断（防炸 PG 单条）', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    await failDeferred(db, { deferredId, errorMessage: 'x'.repeat(3000) })
    const row = await getDeferredById(db, { deferredId })
    expect(row.error_message.length).toBeLessThanOrEqual(2000)
  })
})

describe('sweepStaleClaimed', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('claimed_at 超 TTL → 回退 pending（worker 崩溃兜底）', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    await claimPendingDeferred(db, 'w1')
    // 手动把 claimed_at 拨到 15 分钟前
    const old = new Date(Date.now() - 15 * 60 * 1000).toISOString()
    await db.prepare('UPDATE deferred_submissions SET claimed_at=? WHERE deferred_id=?').run(old, deferredId)
    await sweepStaleClaimed(db, { ttlMs: 10 * 60 * 1000 })
    const row = await getDeferredById(db, { deferredId })
    expect(row.status).toBe(DEFERRED_STATUS.PENDING)
    expect(row.claimed_by_worker).toBeNull()
  })

  it('未超 TTL 的 claimed 不回退', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    await claimPendingDeferred(db, 'w1')
    await sweepStaleClaimed(db, { ttlMs: 10 * 60 * 1000 })
    const row = await getDeferredById(db, { deferredId })
    expect(row.status).toBe(DEFERRED_STATUS.CLAIMED)
  })
})

describe('findRecentDeferredForTask', () => {
  let db
  beforeEach(async () => { db = await freshDb() })

  it('客户端超时重连可复用最近 pending/claimed', async () => {
    const input = BASE_INPUT()
    const a = await recordDeferredSubmission(db, input)
    const found = await findRecentDeferredForTask(db, { repoId: 'r1', taskId: input.taskId })
    expect(found.deferred_id).toBe(a.deferredId)
  })

  it('processed/failed 不参与复用（只 pending/claimed）', async () => {
    const input = BASE_INPUT()
    const a = await recordDeferredSubmission(db, input)
    await failDeferred(db, { deferredId: a.deferredId, errorMessage: 'x' })
    const found = await findRecentDeferredForTask(db, { repoId: 'r1', taskId: input.taskId })
    expect(found).toBeFalsy()
  })

  it('超出时间窗 → 不返回', async () => {
    const { deferredId } = await recordDeferredSubmission(db, BASE_INPUT())
    const old = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    await db.prepare('UPDATE deferred_submissions SET created_at=? WHERE deferred_id=?').run(old, deferredId)
    const found = await findRecentDeferredForTask(db, { repoId: 'r1', taskId: BASE_INPUT().taskId, withinMs: 15 * 60 * 1000 })
    expect(found).toBeFalsy()
  })
})

describe('getDeferredByClientRequestId', () => {
  it('派生 ID 可反查', async () => {
    const db = await freshDb()
    const input = BASE_INPUT()
    const out = await recordDeferredSubmission(db, input)
    const row = await getDeferredByClientRequestId(db, { repoId: 'r1', clientRequestId: out.clientRequestId })
    expect(row.deferred_id).toBe(out.deferredId)
  })
})
