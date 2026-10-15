/**
 * mutation-experience.test.mjs — 批次三：变异验卷 + 经验自动化
 *
 * 1. buildMutationPlan/applyMutation：确定性 + 可抓取
 * 2. markMutationVerified + evaluateAcCoverage.mutationPending
 * 3. 纯考卷失败 → 错题笔记自动入库（test 类免审）
 * 4. requeueRun 后 mutation 编排不受影响（回归保护）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it, afterAll } from 'vitest'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { applyMutation, buildMutationPlan, mutationSeedFor } from '../testing/mutation.js'
import { markMutationVerified } from '../testing/leases.js'
import { lockedSpecByFeature } from '../testing/asset-lock.js'
import { submitTestSpec } from '../testing/test-specs.js'
import { ensureMutationRuns } from '../testing/leases.js'
import { evaluateAcCoverage } from '../harness/testing-gate.js'
import { syncGateLoopFromRunGroup } from '../harness/loop.js'
import { runHarnessMigrations } from '../harness/migrate.js'
import db from '../db.js'

const REPO = 'demo-app'
runHarnessMigrations()
await ensureRepository(db, REPO, 'system')
const FK = 'mutation-verify-test'
const TASK_ID = 'T-MUT-TEST-1'
const SPEC_SRC = `export default async function run({ page, baseURL, expect }) {
  await page.route('**/api/**/list*', async (route) => {
    await route.fulfill({ json: { code: 0, data: { list: [{ id: '1', name: '样例' }], total: 1 } } })
  })
  const respPromise = page.waitForResponse((r) => r.url().includes('/api/') && r.status() === 200)
  await page.goto(\`\${baseURL}/app/mutation-check\`)
  await respPromise
  await expect(page.getByTestId('list-item').first()).toBeVisible()
  const a = 1
  const b = 2
  if (a === b) throw new Error('impossible')
  return a + 1 > b
}`

afterAll(async () => {
  await db.prepare('DELETE FROM test_specs WHERE feature_key=? AND author=?').run(FK, 'ai')
  await db.prepare('DELETE FROM experiences WHERE repo=? AND author=?').run(REPO, 'test-platform')
  await db.prepare('DELETE FROM tasks WHERE repo=? AND task_id=?').run(REPO, TASK_ID)
})

describe('buildMutationPlan（确定性暗题）', () => {
  it('同内容同 seed → 同计划；applyMutation 生效', () => {
    const p1 = buildMutationPlan(SPEC_SRC, FK)
    const p2 = buildMutationPlan(SPEC_SRC, FK)
    expect(p1).toEqual(p2)
    expect(p1.find).toBeTruthy()
    const mutated = applyMutation(SPEC_SRC, p1)
    expect(mutated).not.toBe(SPEC_SRC)
    expect(mutated).toContain(p1.replace)
    // 应用回原内容可精确定位（可重复推导）
    expect(mutated.slice(p1.index, p1.index + p1.replace.length)).toBe(p1.replace)
  })

  it('内容变了 → 计划随内容自洽（新内容新计划，各自可应用）', () => {
    const next = SPEC_SRC + '\n// new line\n'
    const p2 = buildMutationPlan(next, FK)
    if (p2) expect(applyMutation(next, p2)).toContain(p2.replace)
    const p1 = buildMutationPlan(SPEC_SRC, FK)
    expect(applyMutation(SPEC_SRC, p1)).toContain(p1.replace)
  })

  it('空内容/超长内容 → null', () => {
    expect(buildMutationPlan('', FK)).toBeNull()
    expect(buildMutationPlan('x'.repeat(500_001), FK)).toBeNull()
  })
})

describe('mutationSeedFor（暗改 seed 与考卷绑定）', () => {
  it('seed = featureKey::相对路径；每张考卷独立', () => {
    expect(mutationSeedFor('fk-a', 'src/x.vue')).toBe('fk-a::src/x.vue')
    expect(mutationSeedFor('fk-b', 'src/x.vue')).not.toBe(mutationSeedFor('fk-a', 'src/x.vue'))
  })
  it('featureKey 为空 → 退化为旧公式（仅路径，向后兼容）', () => {
    expect(mutationSeedFor('', 'src/x.vue')).toBe('src/x.vue')
    expect(mutationSeedFor(null, 'src/x.vue')).toBe('src/x.vue')
  })
  it('与 guest 内联副本公式一致：hash(seed::content) = hash(fk::rel::content)', () => {
    // guest smoke.mjs: sha256(`${fk}::${rel}::${content}`)；平台侧: buildMutationPlan(content, mutationSeedFor(fk, rel))
    // → sha256(`${seed}::${content}`) = sha256(`${fk}::${rel}::${content}`) ✓
    const p = buildMutationPlan(SPEC_SRC, mutationSeedFor(FK, 'spec.mjs'))
    expect(p).toBeTruthy()
    // 同 seed 同内容确定性不变
    expect(buildMutationPlan(SPEC_SRC, mutationSeedFor(FK, 'spec.mjs'))).toEqual(p)
  })
})

describe('变异派发静态预筛（豁免在派发侧完成：pages∩改动为空 → 不派 VM）', () => {
  async function skipDb({ changedFiles, pagesJson, setting = undefined }) {
    const raw = new Database(':memory:')
    raw.exec(`
      CREATE TABLE repositories (repo_id TEXT PRIMARY KEY, slug TEXT);
      CREATE TABLE platform_settings (key TEXT PRIMARY KEY, value TEXT, value_json TEXT);
      CREATE TABLE run_groups (run_group_id TEXT PRIMARY KEY, repo_id TEXT, submission_id TEXT, binding_id TEXT, kind TEXT DEFAULT 'formal', gate_eligible INTEGER DEFAULT 0, required_units_json TEXT DEFAULT '["smoke:web"]', status TEXT DEFAULT 'passed', created_at TEXT DEFAULT 't');
      CREATE TABLE test_runs (
        run_id TEXT PRIMARY KEY, run_group_id TEXT, binding_id TEXT, repo_id TEXT, task_instance_id TEXT,
        unit TEXT DEFAULT 'smoke', side TEXT DEFAULT 'web', purpose TEXT DEFAULT 'gate', status TEXT DEFAULT 'passed',
        desired_state TEXT DEFAULT 'running', max_attempts INTEGER DEFAULT 2, next_attempt INTEGER DEFAULT 0,
        lease_epoch INTEGER DEFAULT 0, terminal_reason TEXT, report_json TEXT, payload_json TEXT, created_at TEXT DEFAULT 't'
      );
      CREATE TABLE test_specs (spec_id TEXT PRIMARY KEY, repo_id TEXT, feature_key TEXT, version INTEGER DEFAULT 1,
        review_status TEXT DEFAULT 'active', mutation_verified INTEGER DEFAULT 0, entry TEXT, pages_json TEXT, updated_at TEXT);
      CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, repo_id TEXT, snapshot_id TEXT, canonical_binding_json TEXT);
      CREATE TABLE business_snapshots (snapshot_id TEXT PRIMARY KEY, changed_files_json TEXT);
    `)
    await raw.prepare(`INSERT INTO repositories VALUES ('r1', 'r1')`).run()
    if (setting !== undefined && setting !== null) {
      await raw.prepare(`INSERT INTO platform_settings(key, value) VALUES ('mutation_static_skip', ?)`).run(setting)
    }
    await raw.prepare(`INSERT INTO run_groups VALUES ('g-skip','r1','s-skip','b-skip','formal',0,'["smoke:web"]','passed','t')`).run()
    await raw.prepare(`INSERT INTO test_bindings VALUES ('b-skip','r1','s-skip','{}')`).run()
    await raw.prepare(`INSERT INTO business_snapshots VALUES ('s-skip', ?)`).run(changedFiles == null ? null : JSON.stringify(changedFiles))
    await raw.prepare(
      `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, purpose, status, report_json)
       VALUES ('run-skip','g-skip','b-skip','r1','ti-skip','gate','passed',?)`
    ).run(JSON.stringify({ checks: [{ caseKey: 'test:spec/fk-skip', status: 'passed', detail: '' }] }))
    await raw.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry, pages_json)
       VALUES ('sp-skip','r1','fk-skip',1,'active',0,'x.spec.mjs',?)`
    ).run(pagesJson)
    return raw
  }

  it('pages 与 changed-files 无交集 → 不派 VM，直接判 verified（默认 on）', async () => {
    const raw = await skipDb({
      changedFiles: ['src/views/activityManage/AddActivity.vue'],
      pagesJson: JSON.stringify(['orderStatistics/list']),
    })
    expect(await ensureMutationRuns(raw, 'run-skip')).toHaveLength(0)
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp-skip')).mutation_verified).toBe(1)
    raw.close()
  })

  it('pages 与 changed-files 有交集 → 正常派 VM 真跑', async () => {
    const raw = await skipDb({
      changedFiles: ['src/views/orderStatistics/list.vue'],
      pagesJson: JSON.stringify(['orderStatistics/list']),
    })
    expect(await ensureMutationRuns(raw, 'run-skip')).toHaveLength(1)
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp-skip')).mutation_verified).toBe(0)
    raw.close()
  })

  it('显式 setting=off → 无交集也派 VM（回退真跑复核）', async () => {
    const raw = await skipDb({
      changedFiles: ['src/views/activityManage/AddActivity.vue'],
      pagesJson: JSON.stringify(['orderStatistics/list']),
      setting: 'off',
    })
    expect(await ensureMutationRuns(raw, 'run-skip')).toHaveLength(1)
    raw.close()
  })

  it('无 pages 声明 → 走真跑（宁可多跑不错判）', async () => {
    const raw = await skipDb({ changedFiles: ['src/a.vue'], pagesJson: null })
    expect(await ensureMutationRuns(raw, 'run-skip')).toHaveLength(1)
    raw.close()
  })
})

describe('markMutationVerified + mutationPending 终审', () => {
  it('暗题抓取后 verified=1 → mutationPending 解除；废卷保持 pending', async () => {
    await submitSpec()
    // 初次：refs 覆盖 AC-901 但未过变异 → pending
    let r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK_ID })
    expect(r.mutationPending).toBe(true)
    await markMutationVerified(db, { repoId: REPO, featureKey: FK, caught: true })
    r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK_ID })
    expect(r.mutationPending).toBe(false)
    // 废卷（变异版上仍 pass）→ 重新 pending
    await markMutationVerified(db, { repoId: REPO, featureKey: FK, caught: false })
    r = await evaluateAcCoverage(db, { repoSlug: REPO, taskId: TASK_ID })
    expect(r.mutationPending).toBe(true)
    await markMutationVerified(db, { repoId: REPO, featureKey: FK, caught: true })
  })

  it('ensureMutationRuns：formal passed 报告的 spec 考卷排暗题考试，已验证的不重排', async () => {
    const raw = await rawDb()
    await seedMutationChain(raw)
    const runs = await ensureMutationRuns(raw, 'run-g')
    expect(runs.length).toBe(1)
    const row = await raw.prepare('SELECT purpose, payload_json FROM test_runs WHERE run_id=?').get(runs[0])
    expect(row.purpose).toBe('mutation')
    expect(JSON.parse(row.payload_json).featureKey).toBe('mutation-verify-test')
    // 重复调用不重排
    expect(await ensureMutationRuns(raw, 'run-g')).toHaveLength(0)
    raw.close()
  })

  it('非 passed / 非 gate run 不编排', async () => {
    const raw = await rawDb()
    await seedMutationChain(raw, { status: 'failed' })
    expect(await ensureMutationRuns(raw, 'run-g')).toHaveLength(0)
    raw.close()
  })
})

async function submitSpec() {
  await db.prepare(
    `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, size, phase, pending, meta, author, created_at, updated_at)
     VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'x', 'UI_DEV', 'M', 'EXECUTE', '["p"]', ?, 'alice', 't', 't')`
  ).run(REPO, REPO, TASK_ID, JSON.stringify({ acceptance: [{ id: 'AC-901', text: '计算函数比较逻辑正确', type: 'data' }] }))
  await submitTestSpec({
    repoId: REPO, featureKey: FK, author: 'ai', specType: 'e2e', side: 'web',
    content: SPEC_SRC,
    acceptanceRefs: ['AC-901'],
  })
}

async function rawDb() {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE run_groups (run_group_id TEXT PRIMARY KEY, repo_id TEXT, submission_id TEXT, binding_id TEXT, kind TEXT DEFAULT 'formal', gate_eligible INTEGER DEFAULT 0, required_units_json TEXT DEFAULT '["smoke:web"]', status TEXT DEFAULT 'passed', created_at TEXT DEFAULT 't');
    CREATE TABLE test_runs (
      run_id TEXT PRIMARY KEY, run_group_id TEXT, binding_id TEXT, repo_id TEXT, task_instance_id TEXT,
      unit TEXT DEFAULT 'smoke', side TEXT DEFAULT 'web', purpose TEXT DEFAULT 'gate', status TEXT DEFAULT 'passed',
      desired_state TEXT DEFAULT 'running', max_attempts INTEGER DEFAULT 2, next_attempt INTEGER DEFAULT 0,
      lease_epoch INTEGER DEFAULT 0, terminal_reason TEXT, report_json TEXT, payload_json TEXT, created_at TEXT DEFAULT 't'
    );
    CREATE TABLE test_specs (spec_id TEXT, repo_id TEXT, feature_key TEXT, version INTEGER DEFAULT 1,
      review_status TEXT DEFAULT 'active', mutation_verified INTEGER DEFAULT 0, entry TEXT);
    CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, repo_id TEXT);
  `)
  await raw.prepare(`INSERT INTO test_bindings VALUES ('b-mut','r1')`).run()
  return raw
}

async function seedMutationChain(raw, { status = 'passed' } = {}) {
  await raw.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry)
     VALUES ('sp-mut', 'r1', ?, 1, 'active', 0, 'mutation-verify-test.spec.mjs')`
  ).run(FK)
  await raw.prepare(
    `INSERT INTO run_groups VALUES ('g-mut','r1','s-mut','b-mut','formal',0,'["smoke:web"]',?,NULL)`
  ).run(status)
  await raw.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, purpose, status, report_json) VALUES
     ('run-g','g-mut','b-mut','r1','ti-x','gate',?,?)`
  ).run(
    status,
    JSON.stringify({ checks: [{ caseKey: `test:spec/${FK}`, status: 'passed', detail: '' }] })
  )
}

// ── 变异验卷版本化（根治 draft 死结 + TOCTOU 竞态）────────────────
async function lockDb({ lockSpecs = [] } = {}) {
  const raw = new Database(':memory:')
  raw.exec(`
    CREATE TABLE repositories (repo_id TEXT PRIMARY KEY, slug TEXT);
    CREATE TABLE run_groups (run_group_id TEXT PRIMARY KEY, repo_id TEXT, submission_id TEXT, binding_id TEXT, kind TEXT DEFAULT 'formal', gate_eligible INTEGER DEFAULT 0, required_units_json TEXT DEFAULT '["smoke:web"]', status TEXT DEFAULT 'passed', created_at TEXT DEFAULT 't');
    CREATE TABLE test_runs (
      run_id TEXT PRIMARY KEY, run_group_id TEXT, binding_id TEXT, repo_id TEXT, task_instance_id TEXT,
      unit TEXT DEFAULT 'smoke', side TEXT DEFAULT 'web', purpose TEXT DEFAULT 'gate', status TEXT DEFAULT 'passed',
      desired_state TEXT DEFAULT 'running', max_attempts INTEGER DEFAULT 2, next_attempt INTEGER DEFAULT 0,
      lease_epoch INTEGER DEFAULT 0, terminal_reason TEXT, report_json TEXT, payload_json TEXT, created_at TEXT DEFAULT 't'
    );
    CREATE TABLE test_specs (spec_id TEXT PRIMARY KEY, repo_id TEXT, feature_key TEXT, version INTEGER,
      review_status TEXT, mutation_verified INTEGER DEFAULT 0, entry TEXT, updated_at TEXT DEFAULT 't');
    CREATE TABLE test_bindings (binding_id TEXT PRIMARY KEY, repo_id TEXT, canonical_binding_json TEXT);
  `)
  await raw.prepare(`INSERT INTO repositories VALUES ('r1', '${REPO}')`).run()
  await raw.prepare(`INSERT INTO test_bindings VALUES ('b-lock','r1',?)`).run(JSON.stringify({ assetLock: { specs: lockSpecs } }))
  await raw.prepare(`INSERT INTO run_groups VALUES ('g-lock','r1','s-lock','b-lock','formal',0,'["smoke:web"]','passed','t')`).run()
  await raw.prepare(
    `INSERT INTO test_runs(run_id, run_group_id, binding_id, repo_id, task_instance_id, purpose, status, report_json) VALUES
     ('run-g','g-lock','b-lock','r1','ti-lock','gate','passed',?)`
  ).run(JSON.stringify({ checks: [{ caseKey: `test:spec/${FK}`, status: 'passed', detail: '' }] }))
  return raw
}

describe('lockedSpecByFeature（冻结清单身份索引）', () => {
  it('同一 featureKey 同时有 unit 与 e2e → 优先 e2e', () => {
    const m = lockedSpecByFeature({ specs: [
      { featureKey: 'fk', specId: 's-unit', version: 2, specType: 'unit' },
      { featureKey: 'fk', specId: 's-e2e', version: 1, specType: 'e2e' },
    ] })
    expect(m.get('fk').specType).toBe('e2e')
    expect(m.get('fk').specId).toBe('s-e2e')
  })
  it('空/坏 lock → 空 map', () => {
    expect(lockedSpecByFeature(null).size).toBe(0)
    expect(lockedSpecByFeature({ specs: 'oops' }).size).toBe(0)
  })
})

describe('ensureMutationRuns：按 assetLock 冻结版本派发（含 draft）', () => {
  it('覆盖卷在 lock 里但当前是 draft（无 active）→ 仍被派发，payload 冻结 version/specId', async () => {
    const raw = await lockDb({ lockSpecs: [{ featureKey: FK, specId: 'sp-d', version: 7, specType: 'e2e', side: 'web' }] })
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp-d','r1',?,7,'draft',0,'x.spec.mjs')`).run(FK)
    const runs = await ensureMutationRuns(raw, 'run-g')
    expect(runs).toHaveLength(1)
    const p = JSON.parse((await raw.prepare('SELECT payload_json FROM test_runs WHERE run_id=?').get(runs[0])).payload_json)
    expect(p.featureKey).toBe(FK)
    expect(p.specVersion).toBe(7)
    expect(p.specId).toBe('sp-d')
    raw.close()
  })
  it('lock 版本 mv 已=1 → 不重排（防重复 VM）', async () => {
    const raw = await lockDb({ lockSpecs: [{ featureKey: FK, specId: 'sp-d', version: 7, specType: 'e2e', side: 'web' }] })
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp-d','r1',?,7,'draft',1,'x.spec.mjs')`).run(FK)
    expect(await ensureMutationRuns(raw, 'run-g')).toHaveLength(0)
    raw.close()
  })
})

describe('markMutationVerified：按冻结版本精确回写（竞态安全）', () => {
  async function twoVersionDb() {
    const raw = await lockDb({})
    // v8 本轮实际被变异执行、随后被 AI 改版归档；v9 是更晚的 draft（未验）
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp8','r1',?,8,'archived',0,'x')`).run(FK)
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp9','r1',?,9,'draft',0,'x')`).run(FK)
    return raw
  }
  it('按 specVersion=8 回写：只盖 v8，绝不误盖更新的 v9（避免假绿）', async () => {
    const raw = await twoVersionDb()
    await markMutationVerified(raw, { repoId: REPO, featureKey: FK, caught: true, specId: 'sp8', specVersion: 8 })
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp8')).mutation_verified).toBe(1)
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp9')).mutation_verified).toBe(0)
    raw.close()
  })
  it('无冻结版本（在飞旧 run）→ 回退只回写当前 active 行', async () => {
    const raw = await lockDb({})
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp-a','r1',?,3,'active',0,'x')`).run(FK)
    await raw.prepare(`INSERT INTO test_specs(spec_id, repo_id, feature_key, version, review_status, mutation_verified, entry) VALUES ('sp-d','r1',?,4,'draft',0,'x')`).run(FK)
    await markMutationVerified(raw, { repoId: REPO, featureKey: FK, caught: true })
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp-a')).mutation_verified).toBe(1)
    expect((await raw.prepare('SELECT mutation_verified FROM test_specs WHERE spec_id=?').get('sp-d')).mutation_verified).toBe(0)
    raw.close()
  })
})
