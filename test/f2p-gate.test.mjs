/**
 * f2p-gate.test.mjs — F2P 终审接入门禁（三重验卷）
 *
 * 1. evaluateAcCoverage f2pStatus 聚合（无记录=pending / bad=有废卷 / ok=全部有效）
 * 2. 三重终审联动：mutation + F2P
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { recordSpecF2p, countDistinctSurvivedPoints } from '../testing/f2p.js'
import { evaluateAcCoverage } from '../harness/testing-gate.js'

const AC = [{ id: 'AC-701', text: '计算函数比较逻辑正确', type: 'data' }]
const FK = 'f2p-gate-test'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'f2p-gate-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  await db.exec(`
    CREATE TABLE tasks (
      repo TEXT, task_id TEXT, requirement TEXT, type TEXT, size TEXT, phase TEXT,
      completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
      meta TEXT DEFAULT '{}', author TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT,
      PRIMARY KEY (repo, task_id)
    );
  `)
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO tasks(repo, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES ('demo-app', 'T-F2P-1', 'x', 'UI_DEV', 'M', 'EXECUTE', '["p"]', ?, 'alice', 't', 't')`
  ).run(JSON.stringify({ acceptance: AC }))
  const fakeSha = 'a'.repeat(64)
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
       created_at, updated_at)
     VALUES ('sp1', 'r1', ?, 'f2p-gate-test', 'test', 'e2e', 'f2p-gate-test.spec.mjs',
       ?, 1, 'active', 1, '["AC-701"]', NULL, 't', 't')`
  ).run(FK, fakeSha)
  return db
}

describe('evaluateAcCoverage F2P 聚合（三重验卷）', () => {
  it('无 F2P 记录 → pending', async () => {
    const db = await memdb()
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.applicable).toBe(true)
    expect(r.f2pStatus).toBe('pending')
    expect(r.mutationPending).toBe(false)
  })

  it('F2P ok → 聚合 ok（三重全过）', async () => {
    const db = await memdb()
    await recordSpecF2p(db, {
      runId: 'r1', repoId: 'r1', featureKey: FK, version: 1,
      baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'failed', snapshotResult: 'passed',
    })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pStatus).toBe('ok')
    expect(r.f2pDetail.ok).toBe(1)
  })

  it('F2P always_pass → 聚合 ok + warn（弱卷告警，不阻断闭环）', async () => {
    const db = await memdb()
    await recordSpecF2p(db, {
      runId: 'r1', repoId: 'r1', featureKey: FK, version: 1,
      baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'passed', snapshotResult: 'passed',
    })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pStatus).toBe('ok')
    expect(r.f2pDetail.warn).toBe(1)
  })

  it('F2P skipped → 聚合 pending（不可达不假阻塞）', async () => {
    const db = await memdb()
    await recordSpecF2p(db, {
      runId: 'r1', repoId: 'r1', featureKey: FK, version: 1,
      baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'skipped', snapshotResult: 'passed',
    })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pStatus).toBe('pending')
  })

  it('mutation 未通过 → mutationPending=true（三重之一未过）', async () => {
    const db = await memdb()
    await db.prepare(`UPDATE test_specs SET mutation_verified = 0 WHERE feature_key=?`).run(FK)
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.mutationPending).toBe(true)
  })

  it('D：survived-cap-exempt 豁免 → mutationExempt 盖章 + exemptSurvivedCap（非真杀中）', async () => {
    const db = await memdb()
    await recordSpecF2p(db, { runId: 'r1', repoId: 'r1', featureKey: FK, version: 1, baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'skipped', snapshotResult: 'passed', detail: 'mutation survived-cap-exempt @src/x.vue:9 &&->|| — 疑似等价变异，豁免留痕' })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pStatus).toBe('ok')
    expect(r.f2pDetail.exemptSurvivedCap).toBe(1)
    expect(r.mutationExempt).toEqual([{ featureKey: FK, kind: 'survived-cap' }])
  })

  it('D：not-covered 豁免 → mutationExempt kind=not-covered', async () => {
    const db = await memdb()
    await recordSpecF2p(db, { runId: 'r1', repoId: 'r1', featureKey: FK, version: 1, baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'skipped', snapshotResult: 'passed', detail: 'mutation not-covered (no-operator) — 改动行无可翻算子，豁免' })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pDetail.exemptNotCovered).toBe(1)
    expect(r.mutationExempt).toEqual([{ featureKey: FK, kind: 'not-covered' }])
  })

  it('D：真杀中(ok) 不进 mutationExempt（只有豁免才盖章）', async () => {
    const db = await memdb()
    await recordSpecF2p(db, { runId: 'r1', repoId: 'r1', featureKey: FK, version: 1, baselineOid: 'aaa', snapshotOid: 'bbb',
      baselineResult: 'failed', snapshotResult: 'passed' })
    const r = await evaluateAcCoverage(db, { repoSlug: 'demo-app', taskId: 'T-F2P-1' })
    expect(r.f2pDetail.ok).toBe(1)
    expect(r.mutationExempt).toEqual([])
  })
})

describe('countDistinctSurvivedPoints（B：cap 只认不同变异点，防原地空转熬豁免）', () => {
  const since = () => new Date(Date.now() - 86400000).toISOString()
  const survived = async (db, runId, detail, version = 1) => await recordSpecF2p(db, {
    runId, repoId: 'r1', featureKey: FK, version, baselineOid: 'a', snapshotOid: 'b',
    baselineResult: 'passed', snapshotResult: 'passed', detail,
  })

  it('同一变异点重复 survived 只算 1（空转不累计）', async () => {
    const db = await memdb()
    await survived(db, 'r1', 'mutation survived @src/x.js:6 !==->===')
    await survived(db, 'r2', 'mutation survived @src/x.js:6 !==->===')
    await survived(db, 'r3', 'mutation survived @src/x.js:6 !==->===')
    expect(await countDistinctSurvivedPoints(db, { repoId: 'r1', featureKey: FK, sinceIso: since() })).toBe(1)
  })

  it('换了变异点才 +1（有效重试）', async () => {
    const db = await memdb()
    await survived(db, 'r1', 'mutation survived @src/x.js:6 !==->===')
    await survived(db, 'r2', 'mutation survived @src/x.js:9 &&->||', 2)
    expect(await countDistinctSurvivedPoints(db, { repoId: 'r1', featureKey: FK, sinceIso: since() })).toBe(2)
  })

  it('只数 always_pass（killed 不计）；cutoff 之外不计', async () => {
    const db = await memdb()
    await recordSpecF2p(db, { runId: 'k1', repoId: 'r1', featureKey: FK, version: 1, baselineOid: 'a', snapshotOid: 'b',
      baselineResult: 'failed', snapshotResult: 'passed' }) // killed → f2p ok，不计
    expect(await countDistinctSurvivedPoints(db, { repoId: 'r1', featureKey: FK, sinceIso: since() })).toBe(0)
    await survived(db, 'r2', 'mutation survived @src/x.js:6 !==->===')
    await db.prepare('UPDATE spec_f2p_results SET created_at=? WHERE run_id=?')
      .run(new Date(Date.now() - 2 * 86400000).toISOString(), 'r2') // 挪到 2 天前
    expect(await countDistinctSurvivedPoints(db, { repoId: 'r1', featureKey: FK, sinceIso: since() })).toBe(0)
  })
})
