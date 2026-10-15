/**
 * ac-nosmoke-exempt.test.mjs — 注入盲区豁免（判定侧对齐「门禁实际会不会执行该卷」）
 *
 * 背景（2026-09-24 V267-4 确定性死锁）：size=S 门禁 requiredUnits 恒为 ['static:na']，
 * 永不跑 smoke；但 assetLock 仍冻结了 side=web 的 e2e/smoke 考卷（覆盖 AC）。这类考卷被注入
 * 却永不被 smoke lane 执行 → ensureMutationRuns 永不触发 → mutation_verified 恒 0 →
 * evaluateAcCoverage.mutationPending=true → advance 被 MUTATION_UNVERIFIED 拦死，重跑/空等无解。
 *
 * isSpecOnActiveBindingPath 只豁免「不在 assetLock 内」的卷；本盲区是「在 assetLock 内但不会执行」。
 * isSpecSmokeLaneScheduled 补此维度：e2e/smoke 卷 + 明确 side + 该 side 的 smoke 不在实际 requiredUnits → 豁免。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { evaluateAcCoverage, isSpecSmokeLaneScheduled, describeMutationVerification } from '../harness/testing-gate.js'

const REPO = 'demo-app'
const TASK = 'T-NOSMOKE-1'
const AC5 = [
  { id: 'AC-1', text: 'tab', type: 'ui' },
  { id: 'AC-2', text: 'queryScope', type: 'contract' },
  { id: 'AC-3', text: 'dedup', type: 'ui' },
  { id: 'AC-4', text: 'badge', type: 'ui' },
  { id: 'AC-5', text: 'nav', type: 'ui' },
]

/**
 * 构造最小只读库。specs: [{featureKey, specType, side, mv, acRefs, inLock}]
 * size/type/resolvedSides 决定 requiredUnitsForTask 重算结果（无 run_groups 时回退）。
 */
async function memdb({ size = 'S', taskType = 'FEATURE', resolvedSides = ['web'], acs = AC5, specs = [], withActiveBinding = true } = {}) {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'ac-nosmoke-')), 't.db'))
  await runTestingMigrations(db, { skipLegacyMap: true })
  db.pragma('foreign_keys = OFF')
  await db.prepare('DROP TRIGGER IF EXISTS trg_binding_same_repo').run()
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
     VALUES ('r1', ?, 'project', 'refs/heads/stage', 't', 't')`
  ).run(REPO)
  await db.prepare(
    `INSERT INTO tasks(repo, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES (?, ?, 'x', ?, ?, 'EXECUTE', '["p"]', ?, 'alice', 't', 't')`
  ).run(REPO, TASK, taskType, size, JSON.stringify({ acceptance: acs }))

  const insSpec = db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, demand_ref, author, spec_type, side,
       entry, blob_sha256, version, review_status, mutation_verified, acceptance_refs_json, pages_json,
       created_at, updated_at)
     VALUES (?, 'r1', ?, ?, ?, 'test', ?, ?, ?, ?, 1, 'active', ?, ?, '["views/x"]', 't', 't')`
  )
  specs.forEach(async (s, i) => {
    await insSpec.run(
      'sp' + i, s.featureKey, s.featureKey, TASK,
      s.specType || 'e2e', s.side ?? null,
      s.featureKey + '.spec.mjs', ('b'.repeat(60) + String(i).padStart(4, '0')),
      s.mv ? 1 : 0, JSON.stringify(s.acRefs || [])
    )
  })

  if (withActiveBinding) {
    const lockSpecs = specs
      .filter((s) => s.inLock !== false)
      .map((s) => ({ featureKey: s.featureKey, specType: s.specType || 'e2e', side: s.side ?? null }))
    const canonical = { schemaVersion: 1, resolvedSides, assetLock: { schemaVersion: 1, specs: lockSpecs, sha256: 'c'.repeat(64) } }
    await db.prepare(
      `INSERT INTO test_bindings(binding_id, repo_id, snapshot_id, suite_plan_id, task_instance_id,
         execution_profile_revision_id, runner_image_id, runner_image_manifest_sha256, policy_revision_id,
         resolved_sides_json, changed_paths_sha256, required_case_set_sha256, canonical_binding_json, state, created_at)
       VALUES ('b1', 'r1', 'snap-b1', 'plan-b1', 'i1', 'epr-1', 'img-1', ?, 'pol-1', ?, ?, ?, ?, 'active', 't')`
    ).run('a'.repeat(64), JSON.stringify(resolvedSides), 'e'.repeat(64), 'f'.repeat(64), JSON.stringify(canonical))
    await db.prepare(
      `INSERT INTO task_instances(task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
         active_binding_id, status, author_principal_id, created_at, updated_at)
       VALUES ('i1', 'r1', ?, 1, 1, 'EXECUTE', ?, ?, 'b1', 'open', 'tester', 't', 't')`
    ).run(TASK, size, taskType)
  }
  return db
}

// V267-4 真实形态：2 张 e2e/fun(mv=0) + 1 张 smoke/fun(mv=1)，覆盖 AC-1~5，全在 assetLock
const V267_SPECS = [
  { featureKey: 'fake-entry-scope', specType: 'e2e', side: 'web', mv: 0, acRefs: ['AC-2', 'AC-5'] },
  { featureKey: 'fake-tab-display', specType: 'e2e', side: 'web', mv: 0, acRefs: ['AC-1', 'AC-3', 'AC-4'] },
  { featureKey: 'stats-mount', specType: 'smoke', side: 'web', mv: 1, acRefs: ['AC-4'] },
]

describe('isSpecSmokeLaneScheduled 纯函数', () => {
  it('e2e + side=web + size=S（requiredUnits 只 static:na）→ false（永不执行，豁免）', async () => {
    const db = await memdb({ size: 'S', specs: V267_SPECS })
    expect(await isSpecSmokeLaneScheduled(db, { repoSlug: REPO, taskId: TASK, specType: 'e2e', side: 'web', bindingId: 'b1' })).toBe(false)
  })

  it('e2e + side=web + size=L → true（smoke:web 会被调度，维持严格）', async () => {
    const db = await memdb({ size: 'L', specs: V267_SPECS })
    expect(await isSpecSmokeLaneScheduled(db, { repoSlug: REPO, taskId: TASK, specType: 'e2e', side: 'web', bindingId: 'b1' })).toBe(true)
  })

  it('unit 卷 + size=S → true（unit 在 static lane 执行，不豁免）', async () => {
    const db = await memdb({ size: 'S', specs: V267_SPECS })
    expect(await isSpecSmokeLaneScheduled(db, { repoSlug: REPO, taskId: TASK, specType: 'unit', side: 'web', bindingId: 'b1' })).toBe(true)
  })

  it('e2e + side 未知(null) + size=S → true（无法定位 smoke 单元，保守不豁免）', async () => {
    const db = await memdb({ size: 'S', specs: V267_SPECS })
    expect(await isSpecSmokeLaneScheduled(db, { repoSlug: REPO, taskId: TASK, specType: 'e2e', side: null, bindingId: 'b1' })).toBe(true)
  })

  it('e2e + side=admin + size=M(type=UI_DEV, resolvedSides=[web]) → false when its lane is not scheduled', async () => {
    const db = await memdb({ size: 'M', taskType: 'UI_DEV', resolvedSides: ['web'], specs: V267_SPECS })
    expect(await isSpecSmokeLaneScheduled(db, { repoSlug: REPO, taskId: TASK, specType: 'e2e', side: 'admin', bindingId: 'b1' })).toBe(false)
  })
})

describe('evaluateAcCoverage 注入盲区豁免（端到端）', () => {
  it('V267-4 死锁复现：size=S + fun e2e 卷在 assetLock → 全豁免，mutationPending=false，放行', async () => {
    const db = await memdb({ size: 'S', specs: V267_SPECS })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK })
    expect(r.applicable).toBe(true)
    expect(r.missing).toEqual([])          // AC 覆盖仍算（豁免只免验卷不免覆盖）
    expect(r.mutationPending).toBe(false)  // 死锁解除的关键
    expect(r.f2pStatus).toBe('none')       // 全豁免 → none → state-machine 放行
    expect(r.offPathNoSmoke.sort()).toEqual(['fake-entry-scope', 'fake-tab-display', 'stats-mount'])
    expect(r.mutation.total).toBe(0)       // 无卷进入验卷聚合
  })

  it('对照 size=L：同样考卷维持严格（mutationPending=true，不豁免）', async () => {
    const db = await memdb({ size: 'L', specs: V267_SPECS })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK })
    expect(r.mutationPending).toBe(true)   // 2 张 e2e mv=0 → pending
    expect(r.offPathNoSmoke).toEqual([])   // L 级会跑 smoke，不豁免
    expect(r.mutation.total).toBe(3)
  })

  it('size=S 但 unit 卷（在 static 执行）→ 不豁免，仍要求验卷', async () => {
    const db = await memdb({ size: 'S', specs: [{ featureKey: 'u1', specType: 'unit', side: 'web', mv: 0, acRefs: ['AC-1'] }] })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK })
    expect(r.mutationPending).toBe(true)   // unit 卷在 static lane 执行，不豁免
    expect(r.offPathNoSmoke).toEqual([])
  })

  it('size=S + e2e 但 side 未知 → 不豁免（保守，维持严格）', async () => {
    const db = await memdb({ size: 'S', specs: [{ featureKey: 'e1', specType: 'e2e', side: null, mv: 0, acRefs: ['AC-1'] }] })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK })
    expect(r.mutationPending).toBe(true)
    expect(r.offPathNoSmoke).toEqual([])
  })

  it('S 级全豁免边界：单 e2e 卷覆盖单 AC → offPath 全部来自 noSmoke（AC_ALL_OFFPATH 不会误触发）', async () => {
    const db = await memdb({
      size: 'S',
      acs: [{ id: 'AC-1', text: 'x', type: 'ui' }],
      specs: [{ featureKey: 'only-e2e', specType: 'e2e', side: 'web', mv: 0, acRefs: ['AC-1'] }],
    })
    const r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK })
    expect(r.missing).toEqual([])
    expect(r.mutationPending).toBe(false)
    expect(r.f2pStatus).toBe('none')
    expect(r.offPath).toEqual(['only-e2e'])
    expect(r.offPathNoSmoke).toEqual(['only-e2e'])
    // state-machine AC_ALL_OFFPATH 用 offPathNotInjected = offPath − offPathNoSmoke；此处为空 → 不会把 S 级正常豁免误判成「零观测」拦 DONE
    const offPathNotInjected = r.offPath.filter((k) => !r.offPathNoSmoke.includes(k))
    expect(offPathNotInjected).toEqual([])
  })
})

describe('describeMutationVerification 与判定侧一致', () => {
  it('size=S：不执行的 e2e 卷不进验卷明细（看板与判定同源）', async () => {
    const db = await memdb({ size: 'S', specs: V267_SPECS })
    const d = await describeMutationVerification(db, { repoSlug: REPO, taskId: TASK })
    expect(d.total).toBe(0)
    expect(d.specs).toEqual([])
  })

  it('size=L：e2e 卷进明细（维持严格展示）', async () => {
    const db = await memdb({ size: 'L', specs: V267_SPECS })
    const d = await describeMutationVerification(db, { repoSlug: REPO, taskId: TASK })
    expect(d.total).toBe(3)
  })
})
