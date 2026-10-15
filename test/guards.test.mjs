import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import db from '../db.js'
import { runHarnessMigrations } from '../harness/migrate.js'
import { ensureRepository } from '../testing/migrate.js'
import { checkGuard } from '../harness/guards.js'

runHarnessMigrations()

// 纯逻辑：状态流转守卫。synthetic task 对象，不落库（除 L1 验证上报，afterAll 清理）。
function task(phase, size = null, meta = '{}') {
  return { task_id: 't', repo: 'demo-app', phase, size, meta }
}

// "云端健康"测试依赖库内有近期 passed submission——显式插入（空库也要能过）
const FAKE_SUB_ID = 'guard-test-fake-sub'
beforeAll(async () => {
  const now = new Date().toISOString()
  db.pragma('foreign_keys = OFF')
  try {
    const system = await db.prepare(`SELECT principal_id FROM principals WHERE subject LIKE 'system%' LIMIT 1`).get()
    const repoId = await ensureRepository(db, 'demo-app', system?.principal_id || 'system', now)
    await db.prepare(
      `INSERT INTO test_submissions(submission_id, repo_id, task_instance_id, binding_id,
        client_request_id, principal_id, expected_task_revision, status, created_at)
       VALUES (?, ?, 'guard-test-ti', 'guard-test-bi', 'guard-test-cr', 'guard-test-p1', 1, 'passed', ?)`
    ).run(FAKE_SUB_ID, repoId, now)
    // recentWorkerActivity 兜底：空库无 test_runs 时也可能判云端不健康
    try {
      await db.prepare(
        `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id,
           purpose, status, created_at, started_at, finished_at)
         VALUES ('guard-test-run', 'guard-test-g', 'guard-test-bi', ?, 'guard-test-ti',
           'formal', 'passed', ?, ?, ?)`
      ).run(repoId, now, now, now)
    } catch { /* schema 差异时忽略 */ }
  } catch { /* 已存在：跳过 */ }
  db.pragma('foreign_keys = ON')
})

afterAll(async () => {
  await db.prepare("DELETE FROM verify_reports WHERE repo = ? AND task_id = ?").run('demo-app', 't')
  db.pragma('foreign_keys = OFF')
  await db.prepare("DELETE FROM test_submissions WHERE submission_id = ?").run(FAKE_SUB_ID)
  try { await db.prepare("DELETE FROM test_runs WHERE run_id = 'guard-test-run'").run() } catch { /* ignore */ }
  db.pragma('foreign_keys = ON')
})

describe('checkGuard 状态流转守卫', () => {
  it('RECEIVE → CLASSIFY 允许', async () => {
    const r = await checkGuard('CLASSIFY', task('RECEIVE'))
    expect(r.ok).toBe(true)
  })

  it('出口条件不按 S/M/L 决定能否检索', async () => {
    expect((await checkGuard('retrieve', task('receive', 'M'))).ok).toBe(true)
    expect((await checkGuard('execute', task('classify', 'L'))).ok).toBe(true)
  })

  it('CLASSIFY → EXECUTE：规模不再挡住编码', async () => {
    expect((await checkGuard('EXECUTE', task('CLASSIFY', 'S'))).ok).toBe(true)
    expect((await checkGuard('EXECUTE', { ...task('CLASSIFY', 'S'), type: 'FIX' })).ok).toBe(true)
    expect((await checkGuard('EXECUTE', task('CLASSIFY', 'L'))).ok).toBe(true)
  })

  it('CLASSIFY → EXECUTE：FEATURE 可以是小改动', async () => {
    expect((await checkGuard('EXECUTE', { ...task('CLASSIFY', 'S'), type: 'FEATURE' })).ok).toBe(true)
    expect((await checkGuard('EXECUTE', { ...task('CLASSIFY', 'M'), type: 'FEATURE' })).ok).toBe(true)
  })

  it('RECEIVE → CLASSIFY：不再因 size=S 拒绝 FEATURE', async () => {
    const r = await checkGuard('CLASSIFY', { ...task('RECEIVE', 'S'), type: 'FEATURE' })
    expect(r.ok).toBe(true)
  })

  it('EXECUTE(S) → VERIFY 拦截（S 级应直奔 DONE）', async () => {
    expect((await checkGuard('VERIFY', task('EXECUTE', 'S'))).ok).toBe(false)
  })

  it('EXECUTE(S) → DONE 需要至少一次 L1 验证通过', async () => {
    // 无 L1 上报 → 拦截
    expect((await checkGuard('DONE', task('EXECUTE', 'S'))).ok).toBe(false)
    // 写入一条 L1 通过上报后 → 放行
    await db.prepare(
      `INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
       VALUES (?, 'demo-app', (SELECT repo_id FROM repositories WHERE slug = 'demo-app'), 'L1', 'web', 'x.js', 1, 0, '', 'tester', 't', ?)`
    ).run('vitest-guard-l1', new Date().toISOString())
    expect((await checkGuard('DONE', task('EXECUTE', 'S'))).ok).toBe(true)
  })

  it('VERIFY → DONE：云端健康时不强制本地 L2（云端为真源）', async () => {
    // 本机 project 近 48h 有 passed submission → resolveVerifySource=cloud
    // 此时不应再因「无 L2」拦截；M 级仍可因 l3Confirmed 建议拦截
    const r = await checkGuard('DONE', task('VERIFY', 'M'))
    const joined = r.blockedBy.join('')
    expect(joined).not.toContain('须本地 L2')
    expect(joined).not.toContain('verify.sh L2')
  })

  it('VERIFY → DISTILL：任意规模都可沉淀，且不强制本地 L2', async () => {
    expect((await checkGuard('DISTILL', task('VERIFY', 'S'))).ok).toBe(true)
    const rL = await checkGuard('DISTILL', task('VERIFY', 'L'))
    expect(rL.blockedBy.join('')).not.toContain('本地 L2')
  })
})
