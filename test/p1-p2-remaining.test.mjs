/**
 * 剩余项回归：evaluator / module-identity / rule-artifacts / docs batch / contract report
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'
import { evaluateTransition } from '../harness/transition-evaluator.js'
import {
  normalizeModuleId,
  moduleDocKey,
  inferRegionHeuristic,
  detectDocKeyConflicts,
  parseRegionFromManifest,
} from '../modules/module-identity.js'
import {
  ensureRuleArtifactsTable,
  createRuleArtifactFromExperience,
  activateRuleArtifact,
  revokeRuleArtifact,
  measureRuleEffect,
} from '../testing/rule-artifacts.js'
import { buildContractReport, validateE2eSpecContent } from '../testing/spec-contract.js'

async function memdb() {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  await db.exec(`
    CREATE TABLE tasks (
      task_id TEXT NOT NULL, repo TEXT NOT NULL, requirement TEXT, type TEXT, phase TEXT,
      completed TEXT DEFAULT '[]', pending TEXT DEFAULT '[]', decisions TEXT DEFAULT '[]',
      author TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
      size TEXT, meta TEXT DEFAULT '{}', PRIMARY KEY (repo, task_id)
    );
    CREATE TABLE task_sessions (
      session_id TEXT PRIMARY KEY, repo TEXT, task_id TEXT, owner_subject TEXT, state TEXT,
      heartbeat_at TEXT, created_at TEXT, expires_at TEXT, released_at TEXT
    );
    CREATE TABLE verify_reports (
      id TEXT PRIMARY KEY, repo TEXT, level TEXT, side TEXT, file TEXT, pass INTEGER,
      errors INTEGER, detail TEXT, author TEXT, created_at TEXT, task_id TEXT
    );
    CREATE TABLE gate_loops (
      repo TEXT, task_id TEXT, state TEXT, iteration INTEGER, max_iterations INTEGER,
      phase TEXT, size TEXT, history_json TEXT, updated_at TEXT,
      PRIMARY KEY (repo, task_id)
    );
  `)
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

const task = (over = {}) => ({
  task_id: 'T1',
  repo: 'r1',
  phase: 'CLASSIFY',
  size: 'M',
  type: 'UI_DEV',
  meta: '{}',
  completed: '[]',
  pending: '[]',
  decisions: '[]',
  author: 'a',
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('transition-evaluator', () => {
  it('旧阶段名 CLASSIFY 不再直接改阶段', async () => {
    const db = await memdb()
    const ev = await evaluateTransition(db, {
      task: task({ phase: 'RECEIVE', size: null }),
      to: 'CLASSIFY',
      repo: 'r1',
    })
    expect(ev.code).toBe('LEGACY_TARGET')
    db.close()
  })

  it('RECEIVE→DONE illegal → blocked by guard', async () => {
    const db = await memdb()
    const ev = await evaluateTransition(db, {
      task: task({ phase: 'RECEIVE', size: 'S' }),
      to: 'DONE',
      repo: 'r1',
    })
    expect(ev.ok).toBe(false)
    db.close()
  })

  it('plan→execute 无 pending/decisions 被拦', async () => {
    const db = await memdb()
    const ev = await evaluateTransition(db, {
      task: task({ phase: 'plan', size: 'L', pending: '[]', decisions: '[]', type: 'FIX' }),
      to: 'execute',
      repo: 'r1',
    })
    expect(ev.ok).toBe(false)
    db.close()
  })
})

describe('module-identity', () => {
  it('marketSearch is NOT sea', () => {
    expect(inferRegionHeuristic('marketSearch').region).toBe('default')
  })
  it('marketAuditSea is sea', () => {
    expect(inferRegionHeuristic('marketAuditSea').region).toBe('sea')
  })
  it('a/b and a-b do not collide', () => {
    const k1 = moduleDocKey({ side: 'web', modulePath: 'src/views/a/b' })
    const k2 = moduleDocKey({ side: 'web', modulePath: 'src/views/a-b' })
    expect(k1).not.toBe(k2)
    expect(k1).toContain('a__b')
    expect(k2).toContain('a-b')
  })
  it('normalize path', () => {
    expect(normalizeModuleId('src//views\\\\foo/')).toBe('src/views/foo')
  })
  it('manifest manual wins', () => {
    const m = parseRegionFromManifest(
      { modules: { 'src/views/foo': { region: 'sea', variant: 'hr' } } },
      'src/views/foo'
    )
    expect(m.source).toBe('manual')
    expect(m.region).toBe('sea')
  })
  it('detect conflicts', () => {
    const c = detectDocKeyConflicts([
      { side: 'web', modulePath: 'src/views/a/b' },
      { side: 'web', modulePath: 'src/views/a-b' },
    ])
    // 不同 path 不同 key，应无冲突
    expect(c).toHaveLength(0)
  })
})

describe('rule-artifacts', () => {
  it('create → activate → revoke → measure', async () => {
    const db = await memdb()
    await ensureRuleArtifactsTable(db)
    await db.prepare(
      `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
       VALUES ('r1', 'r1', 'r1', 'refs/heads/stage', 't', 't')`
    ).run()
    await db.prepare(
      `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
       VALUES ('p1', 'alice', 'alice', 'active', 't', 't')`
    ).run()
    // in-memory testing 迁移把 experiences 建成 v8 结构
    await db.prepare(
      `INSERT INTO experiences (
         experience_id, repo_id, title, content, source_type, source_id,
         origin_type, failure_fingerprint, promotion_type,
         reviewed_by, reviewed_at, confidence, tags_json, created_at, updated_at
       ) VALUES ('exp-1','r1','t','drift A','manual','m1','coding',null,null,'p1','t',0.5,'["ai-drift"]','2026-09-01T00:00:00.000Z','t')`
    ).run()

    const r = await createRuleArtifactFromExperience(db, {
      repo: 'r1', experienceId: 'exp-1', title: 'No sleep', owner: 'alice',
    })
    expect(r.status).toBe('draft')
    const act = await activateRuleArtifact(db, { ruleId: r.ruleId, owner: 'alice' })
    expect(act.ok).toBe(true)
    const eff = await measureRuleEffect(db, { repo: 'r1', ruleId: r.ruleId, weeks: 4 })
    expect(eff.ok).toBe(true)
    expect(eff.improved).toBeDefined()
    const rev = await revokeRuleArtifact(db, { ruleId: r.ruleId })
    expect(rev.status).toBe('revoked')
    db.close()
  })

  it('v30 registered', async () => {
    const db = await memdb()
    const ver = await db.prepare('SELECT name FROM schema_migrations WHERE version=30').get()
    expect(ver?.name).toBe('rule_artifacts')
    db.close()
  })
})

describe('contract report', () => {
  it('buildContractReport checks flags', () => {
    const src = `export default async function run({ page, baseURL }) {
      await page.route('**/api/**', (r) => r.fulfill({ json: { code: 0 } }))
      await page.goto(\`\${baseURL}/app/x\`)
      await expect(page.getByTestId('list-item')).toBeVisible()
    }`
    const r = buildContractReport(src, { side: 'web' })
    expect(r.checks.hasDefaultRun).toBe(true)
    expect(r.checks.usesBaseURL).toBe(true)
    expect(r.checks.hasNetworkAssert).toBe(true)
  })
  it('missing run fails validate', () => {
    const r = validateE2eSpecContent('const x = 1', { side: 'web' })
    expect(r.ok).toBe(false)
  })
})
