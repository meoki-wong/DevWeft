/**
 * CLRP/1 门禁闭环：分类器 / packet / gateLoop / 租约
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import {
  acquireTaskSession,
  buildRemediationPacket,
  classifyCheck,
  classifyRunChecks,
  ensureGateLoop,
  getActiveTaskSession,
  getGateLoop,
  listResumableTasks,
  releaseTaskSession,
  updateGateLoop,
} from '../harness/loop.js'
import { evaluateNewGate, shouldEnforceNewGate } from '../harness/testing-gate.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-loop-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'alice', 'alice', 'active', 't', 't')`
  ).run()
  return db
}

describe('CLRP classify', () => {
  it('spec invalid URL → suite', () => {
    expect(
      classifyCheck({
        caseKey: 'test:spec/flight-check-fake-order',
        status: 'failed',
        detail: 'page.goto: Cannot navigate to invalid URL',
      })
    ).toBe('suite')
  })
  it('eslint → product', () => {
    expect(classifyCheck({ caseKey: 'test:static/eslint', status: 'failed', detail: 'prettier' })).toBe('product')
  })
  it('aggregate suite wins over product as mixed', () => {
    const r = classifyRunChecks([
      { caseKey: 'test:static/eslint', status: 'failed', detail: 'err' },
      { caseKey: 'test:spec/foo', status: 'failed', detail: 'Cannot navigate to invalid URL' },
    ])
    expect(r.overall).toBe('mixed')
  })
  it('infra terminal_reason 保留明细但整体仍为 infra', () => {
    const r = classifyRunChecks([{ caseKey: 'test:static/eslint', status: 'failed' }], 'infra_error')
    expect(r.overall).toBe('infra')
    expect(r.byCheck).toHaveLength(1)
  })
  it.each([
    ['script_syntax', 'suite'], ['script_import', 'suite'], ['script_runtime', 'suite'],
    ['selector_timeout', 'suite'], ['assertion', 'product'], ['infra', 'infra'],
    ['page_runtime', 'product'], ['build', 'product'],
  ])('errorKind=%s → %s，不受错误正文和路径交集覆盖', (errorKind, classification) => {
    const check = { caseKey: 'test:spec/foo', status: 'failed', errorKind, detail: 'expect timeout registry', class: 'product' }
    expect(classifyCheck(check)).toBe(classification)
    const r = classifyRunChecks([check], 'assertion_failed')
    expect(r.overall).toBe(classification)
    expect(r.byCheck[0]).toMatchObject({ class: classification, errorKind })
  })
  it('已归因的历史真回归仍保留，不因 caseKey 回落 suite', () => {
    expect(classifyRunChecks([{ caseKey: 'test:spec/foo', status: 'failed', class: 'product' }]).overall).toBe('product')
  })
  it('旧裸 expect 错误即使被按改动路径标成 product，也应纠正为脚本问题', () => {
    const result = classifyRunChecks([{ caseKey: 'test:spec/foo', status: 'failed', class: 'product', detail: 'expect is not defined' }])
    expect(result.byCheck[0]).toMatchObject({ class: 'suite', errorKind: 'script_runtime', attributed: false })
    expect(result.byCheck[0].hints.join()).toContain('不是全局变量')
  })
  it('旧缺包错误和结构化 detail 前缀都能正确归类', () => {
    expect(classifyCheck({ caseKey: 'test:smoke/fun', status: 'failed', detail: "Cannot find package '@playwright/test'" })).toBe('suite')
    expect(classifyRunChecks([{ caseKey: 'test:spec/foo', status: 'failed', detail: '[script_import] failed', class: 'product' }]).overall).toBe('suite')
    expect(classifyCheck({ caseKey: 'test:spec/foo', status: 'error', detail: 'PLAYWRIGHT_EXPECT_UNAVAILABLE: TypeError' })).toBe('infra')
  })
  it('忽略 passed/skipped，不能计作失败', () => {
    expect(classifyRunChecks([
      { caseKey: 'test:spec/a', status: 'passed', errorKind: 'assertion' },
      { caseKey: 'test:spec/b', status: 'skipped', errorKind: 'script_runtime' },
    ])).toEqual({ overall: 'none', byCheck: [] })
  })
  it('selector 超时提示待核实，不武断宣称业务回归；真实断言不提示 lint', () => {
    const selector = classifyRunChecks([{ caseKey: 'test:spec/foo', status: 'failed', errorKind: 'selector_timeout' }])
    expect(selector.byCheck[0].hints.join()).toContain('尚不能认定业务回归')
    const assertion = classifyRunChecks([{ caseKey: 'test:spec/foo', status: 'failed', errorKind: 'assertion' }])
    expect(assertion.byCheck[0].hints.join()).toContain('真实断言未满足')
    expect(assertion.byCheck[0].hints.join()).not.toContain('eslint')
  })
})

describe('CLRP packet', () => {
  it('passed → advance only', () => {
    const p = buildRemediationPacket({
      repo: 'demo-app',
      taskId: 'T1',
      status: 'passed',
      loop: {
        state: 'green_pending_advance',
        iteration: 1,
        maxIterations: 5,
        needsHuman: false,
      },
      classification: { overall: 'none', byCheck: [] },
      bindingId: 'a'.repeat(64),
      expectedTaskRevision: 2,
    })
    expect(p.protocol).toBe('CLRP/1')
    expect(p.completionBlocked).toBe(false)
    expect(p.loop.nextAllowed).toContain('advance')
    expect(p.actions[0].tool).toBe('harness_advance')
  })
  it('suite failed → fix_spec + distill + resubmit, completion blocked', () => {
    const p = buildRemediationPacket({
      repo: 'demo-app',
      taskId: 'T1',
      status: 'failed',
      loop: { state: 'remediation_suite', iteration: 1, maxIterations: 5, needsHuman: false },
      classification: {
        overall: 'suite',
        byCheck: [
          {
            caseKey: 'test:spec/flight-check',
            class: 'suite',
            featureKey: 'flight-check',
            hints: ['baseURL'],
          },
        ],
      },
    })
    expect(p.completionBlocked).toBe(true)
    expect(p.loop.nextAllowed).toEqual(expect.arrayContaining(['fix_spec', 'distill', 'resubmit']))
    expect(p.forbidden).toContain('宣称任务完成')
    const tools = p.actions.map((a) => a.tool)
    expect(tools).toContain('awp_test_spec_get')
    expect(tools).toContain('distill_append')
    expect(tools).toContain('awp_test_run')
  })
  it('IN_PROGRESS → wait_terminal only', () => {
    const p = buildRemediationPacket({
      repo: 'x',
      taskId: 'T',
      status: 'IN_PROGRESS',
      loop: { state: 'waiting_gate', iteration: 1, maxIterations: 5, needsHuman: false },
      classification: { overall: 'none', byCheck: [] },
    })
    expect(p.loop.nextAllowed).toEqual(['wait_terminal'])
    expect(p.actions[0].tool).toBe('awp_loop_wait')
  })
})

describe('gateLoop + session', () => {
  it('ensure/update/persist loop', async () => {
    const db = await memdb()
    const loop = await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1', size: 'M' })
    expect(loop.state).toBe('coding')
    const u = await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { state: 'waiting_gate', iteration: 1, lastBindingId: 'b'.repeat(64) },
    })
    expect(u.state).toBe('waiting_gate')
    expect(u.iteration).toBe(1)
    expect((await getGateLoop(db, { repo: 'demo-app', taskId: 'T1' })).lastBindingId).toBe('b'.repeat(64))
  })
  it('session exclusive by owner', async () => {
    const db = await memdb()
    const a = await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'alice' })
    expect(a.ok).toBe(true)
    const b = await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'bob' })
    expect(b.ok).toBe(false)
    expect(b.error).toBe('TASK_SESSION_HELD')
    await releaseTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'alice' })
    const c = await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'bob' })
    expect(c.ok).toBe(true)
  })
  it('same owner can re-acquire (resume)', async () => {
    const db = await memdb()
    await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'alice' })
    const again = await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T1', ownerSubject: 'alice' })
    expect(again.ok).toBe(true)
    expect(again.resumed).toBe(true)
    expect((await getActiveTaskSession(db, { repo: 'demo-app', taskId: 'T1' })).owner_subject).toBe('alice')
  })
  it('listResumableTasks by owner', async () => {
    const db = await memdb()
    await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T-A', ownerSubject: 'alice' })
    await acquireTaskSession(db, { repo: 'demo-app', taskId: 'T-B', ownerSubject: 'bob' })
    const rows = await listResumableTasks(db, { ownerSubject: 'alice', repo: 'demo-app' })
    expect(rows).toHaveLength(1)
    expect(rows[0].task_id).toBe('T-A')
  })
})

describe('evaluateNewGate error codes', () => {
  it('missing instance → NOT_SUBMITTED', async () => {
    const db = await memdb()
    const ev = await evaluateNewGate(db, { repoSlug: 'demo-app', taskId: 'nope', size: 'M' })
    expect(ev.wouldBlock).toBe(true)
    expect(ev.blockedBy[0].code).toBe('NOT_SUBMITTED')
  })
  it('enforce_all blocks all sizes', () => {
    expect(shouldEnforceNewGate('enforce_all', 'S')).toBe(true)
    expect(shouldEnforceNewGate('enforce_all', 'M')).toBe(true)
    expect(shouldEnforceNewGate('observe', 'S')).toBe(false)
  })
})
