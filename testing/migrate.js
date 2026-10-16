import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { uuidv7, utcNow } from './ids.js'
import { seedRepoTestPolicies, seedRepoGateModesEnforce } from './repo-policies.js'
import { getRepoPlatformProfile } from './repo-platform.js'
import { createIdSequencesTable, backfillIdSequence } from '../db/id-sequence.js'
import { projectPhase, phaseToActivity } from '../harness/activity-plan.js'
import { ensureRuleArtifactsTable } from './rule-artifacts.js'
import { applyV31TestSpecsApiType, getV31MigrationChecksum } from './migrate-v31.js'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = readFileSync(path.join(dir, 'schema-v1.sql'), 'utf8')
const SCHEMA_V2_SQL = readFileSync(path.join(dir, 'schema-v2.sql'), 'utf8')
const SCHEMA_V3_SQL = readFileSync(path.join(dir, 'schema-v3.sql'), 'utf8')
const SCHEMA_V4_SQL = readFileSync(path.join(dir, 'schema-v4.sql'), 'utf8')
const SCHEMA_V5_SQL = readFileSync(path.join(dir, 'schema-v5.sql'), 'utf8')
const SCHEMA_V6_SQL = readFileSync(path.join(dir, 'schema-v6.sql'), 'utf8')
const SCHEMA_V7_SQL = readFileSync(path.join(dir, 'schema-v7.sql'), 'utf8')
const SCHEMA_V8_SQL = readFileSync(path.join(dir, 'schema-v8.sql'), 'utf8')
const SCHEMA_V9_SQL = readFileSync(path.join(dir, 'schema-v9.sql'), 'utf8')
const SCHEMA_V10_SQL = readFileSync(path.join(dir, 'schema-v10.sql'), 'utf8')
const SCHEMA_V11_SQL = readFileSync(path.join(dir, 'schema-v11.sql'), 'utf8')
const SCHEMA_V12_SQL = readFileSync(path.join(dir, 'schema-v12.sql'), 'utf8')
const SCHEMA_V13_SQL = readFileSync(path.join(dir, 'schema-v13.sql'), 'utf8')
const SCHEMA_V14_SQL = readFileSync(path.join(dir, 'schema-v14.sql'), 'utf8')
const SCHEMA_V15_SQL = readFileSync(path.join(dir, 'schema-v15.sql'), 'utf8')
const SCHEMA_V16_SQL = readFileSync(path.join(dir, 'schema-v16.sql'), 'utf8')
const SCHEMA_V17_SQL = readFileSync(path.join(dir, 'schema-v17.sql'), 'utf8')
const SCHEMA_V18_SQL = readFileSync(path.join(dir, 'schema-v18.sql'), 'utf8')
const SCHEMA_V19_SQL = readFileSync(path.join(dir, 'schema-v19.sql'), 'utf8')
const SCHEMA_V20_SQL = readFileSync(path.join(dir, 'schema-v20.sql'), 'utf8')
const SCHEMA_V21_SQL = readFileSync(path.join(dir, 'schema-v21.sql'), 'utf8')
const SCHEMA_V22_SQL = readFileSync(path.join(dir, 'schema-v22.sql'), 'utf8')
const SCHEMA_V23_SQL = readFileSync(path.join(dir, 'schema-v23.sql'), 'utf8')
const SCHEMA_V24_SQL = readFileSync(path.join(dir, 'schema-v24.sql'), 'utf8')
const SCHEMA_V25_SQL = readFileSync(path.join(dir, 'schema-v25.sql'), 'utf8')
const SCHEMA_V26_SQL = readFileSync(path.join(dir, 'schema-v26.sql'), 'utf8')
const SCHEMA_CHECKSUM = createHash('sha256').update(SCHEMA_SQL).digest('hex')
const SCHEMA_V2_CHECKSUM = createHash('sha256').update(SCHEMA_V2_SQL).digest('hex')
const SCHEMA_V3_CHECKSUM = createHash('sha256').update(SCHEMA_V3_SQL).digest('hex')
const SCHEMA_V4_CHECKSUM = createHash('sha256').update(SCHEMA_V4_SQL).digest('hex')
const SCHEMA_V5_CHECKSUM = createHash('sha256').update(SCHEMA_V5_SQL).digest('hex')
const SCHEMA_V6_CHECKSUM = createHash('sha256').update(SCHEMA_V6_SQL).digest('hex')
const SCHEMA_V7_CHECKSUM = createHash('sha256').update(SCHEMA_V7_SQL).digest('hex')
const SCHEMA_V8_CHECKSUM = createHash('sha256').update(SCHEMA_V8_SQL).digest('hex')
const SCHEMA_V9_CHECKSUM = createHash('sha256').update(SCHEMA_V9_SQL).digest('hex')
const SCHEMA_V10_CHECKSUM = createHash('sha256').update(SCHEMA_V10_SQL).digest('hex')
const SCHEMA_V11_CHECKSUM = createHash('sha256').update(SCHEMA_V11_SQL).digest('hex')
const SCHEMA_V12_CHECKSUM = createHash('sha256').update(SCHEMA_V12_SQL).digest('hex')
const SCHEMA_V13_CHECKSUM = createHash('sha256').update(SCHEMA_V13_SQL).digest('hex')
const SCHEMA_V14_CHECKSUM = createHash('sha256').update(SCHEMA_V14_SQL).digest('hex')
const SCHEMA_V15_CHECKSUM = createHash('sha256').update(SCHEMA_V15_SQL).digest('hex')
const SCHEMA_V16_CHECKSUM = createHash('sha256').update(SCHEMA_V16_SQL).digest('hex')
const SCHEMA_V17_CHECKSUM = createHash('sha256').update(SCHEMA_V17_SQL).digest('hex')
const SCHEMA_V18_CHECKSUM = createHash('sha256').update(SCHEMA_V18_SQL).digest('hex')
const SCHEMA_V19_CHECKSUM = createHash('sha256').update(SCHEMA_V19_SQL).digest('hex')
const SCHEMA_V20_CHECKSUM = createHash('sha256').update(SCHEMA_V20_SQL).digest('hex')
const SCHEMA_V21_CHECKSUM = createHash('sha256').update(SCHEMA_V21_SQL).digest('hex')
const SCHEMA_V22_CHECKSUM = createHash('sha256').update(SCHEMA_V22_SQL).digest('hex')
const SCHEMA_V23_CHECKSUM = createHash('sha256').update(SCHEMA_V23_SQL).digest('hex')
const SCHEMA_V24_CHECKSUM = createHash('sha256').update(SCHEMA_V24_SQL).digest('hex')
const SCHEMA_V25_CHECKSUM = createHash('sha256').update(SCHEMA_V25_SQL).digest('hex')
const SCHEMA_V26_CHECKSUM = createHash('sha256').update(SCHEMA_V26_SQL).digest('hex')
// v27 意图文件（实际 ALTER 由 applyV27ExperiencesConvergence 按列存在性门控）
const SCHEMA_V27_SQL = readFileSync(path.join(dir, 'schema-v27.sql'), 'utf8')
const SCHEMA_V27_CHECKSUM = createHash('sha256').update(SCHEMA_V27_SQL).digest('hex')
const SCHEMA_V29_SQL = readFileSync(path.join(dir, 'schema-v29.sql'), 'utf8')
const SCHEMA_V41_SQL = readFileSync(path.join(dir, 'schema-v41.sql'), 'utf8')
const SCHEMA_V42_SQL = readFileSync(path.join(dir, 'schema-v42.sql'), 'utf8')
const SCHEMA_V43_SQL = readFileSync(path.join(dir, 'schema-v43.sql'), 'utf8')
const SYSTEM_SUBJECT = 'system:test-platform'

const SQLITE_MIGRATION_NAMES = [
  'identity_snapshot_binding', 'submissions_runs', 'harness_gate_observe',
  'suite_registry_leases', 'secret_grants', 'image_manifest_signing_key',
  'm4_overlays_waivers_promotion', 'm5_failure_experience', 'test_spec_assets',
  'test_spec_side', 'snapshot_changed_files', 'gate_loop_clrp', 'repo_test_policies',
  'gate_mode_disabled', 'gate_mode_enforce_ml', 'repo_env_accounts',
  'repo_default_test_env', 'ac_coverage_category', 'test_spec_review_plugin',
  'f2p_results', 'platform_settings', 'attempt_steps_timeline',
  'test_runs_purpose_mutation', 'test_specs_scope', 'accepted_results_multi_attempt',
  'observability_trace', 'experience_schema_convergence', 'id_sequences',
  'verify_evidence_fields', 'rule_artifacts', 'test_specs_api_type_rebuild',
  'task_attachments', 'collaboration_tenant_id', 'phase_activity_names',
  'repo_runtime_settings', 'tenant_extensions', 'mutation_verdict',
  'deferred_submissions', 'deferred_retry_cols', 'generic_run_sides',
  'promotion_provider_fields_removed', 'experience_feedback',
]

const SQLITE_MIGRATION_CHECKSUMS = [
  SCHEMA_CHECKSUM, SCHEMA_V2_CHECKSUM, SCHEMA_V3_CHECKSUM, SCHEMA_V4_CHECKSUM,
  SCHEMA_V5_CHECKSUM, SCHEMA_V6_CHECKSUM, SCHEMA_V7_CHECKSUM, SCHEMA_V8_CHECKSUM,
  SCHEMA_V9_CHECKSUM, SCHEMA_V10_CHECKSUM, SCHEMA_V11_CHECKSUM, SCHEMA_V12_CHECKSUM,
  SCHEMA_V13_CHECKSUM, SCHEMA_V14_CHECKSUM, SCHEMA_V15_CHECKSUM, SCHEMA_V16_CHECKSUM,
  SCHEMA_V17_CHECKSUM, SCHEMA_V18_CHECKSUM, SCHEMA_V19_CHECKSUM, SCHEMA_V20_CHECKSUM,
  SCHEMA_V21_CHECKSUM, SCHEMA_V22_CHECKSUM, SCHEMA_V23_CHECKSUM, SCHEMA_V24_CHECKSUM,
  SCHEMA_V25_CHECKSUM, SCHEMA_V26_CHECKSUM, SCHEMA_V27_CHECKSUM, 'id-sequences-v28',
  createHash('sha256').update(SCHEMA_V29_SQL).digest('hex'), 'rule-artifacts-v30',
  getV31MigrationChecksum(), 'task-attachments-v32', 'collaboration-tenant-id-v33',
  'phase-activity-names-v34', 'repo-runtime-settings-v35', 'tenant-extensions-v36',
  'mutation-verdict-v37', 'deferred-submissions-v39', 'deferred-retry-cols-v40',
  createHash('sha256').update(SCHEMA_V41_SQL).digest('hex'),
  createHash('sha256').update(SCHEMA_V42_SQL).digest('hex'),
  createHash('sha256').update(SCHEMA_V43_SQL).digest('hex'),
]

const PG_PATCHUP_MANIFEST = [
  { version: 38, name: 'mutation_verdict_pg', checksum: 'mutation-verdict-pg-v38' },
  { version: 39, name: 'deferred_submissions_pg', checksum: 'deferred-submissions-pg-v39' },
  { version: 40, name: 'deferred_retry_cols_pg', checksum: 'deferred-retry-cols-pg-v40' },
  { version: 41, name: 'generic_run_sides_pg', checksum: 'generic-run-sides-pg-v41' },
  { version: 42, name: 'promotion_provider_fields_removed_pg', checksum: 'promotion-provider-fields-removed-pg-v42' },
  { version: 43, name: 'experience_feedback_pg', checksum: 'experience-feedback-pg-v43' },
]

/** Return the immutable migration ledger contract used by readiness checks and diagnostics. */
export function getTestingMigrationManifest(dialect = 'sqlite') {
  if (dialect === 'postgres') {
    return [
      { version: null, name: 'postgres_baseline', checksum: 'baseline-v1' },
      ...PG_PATCHUP_MANIFEST,
    ]
  }
  return SQLITE_MIGRATION_NAMES.map((name, index) => ({
    version: index < 37 ? index + 1 : index + 2,
    name,
    checksum: SQLITE_MIGRATION_CHECKSUMS[index],
  }))
}

function migrationChecksumError({ version, name, expected, actual }) {
  return new Error(
    `[migrate] schema_migrations v${version} name/checksum mismatch: ` +
    `expected name ${name}, checksum ${expected || '<missing>'}; found checksum ${actual || '<missing>'}. ` +
    'Restore the matching migration file or create a forward migration; the ledger was not changed.'
  )
}

function validateAppliedMigrationLedger(db, dialect = 'sqlite') {
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
  if (!hasLedger) return
  const expected = new Map(getTestingMigrationManifest(dialect).filter((m) => m.version !== null).map((m) => [m.version, m]))
  for (const row of db.prepare('SELECT version, name, checksum FROM schema_migrations').all()) {
    const manifest = expected.get(Number(row.version))
    if (!manifest) {
      if (dialect === 'postgres' && row.name === 'postgres_baseline') continue
      throw migrationChecksumError({ version: row.version, name: row.name, expected: '<known migration>', actual: row.checksum })
    }
    if (row.name !== manifest.name || row.checksum !== manifest.checksum) {
      throw migrationChecksumError({ version: row.version, name: row.name, expected: manifest.checksum, actual: row.checksum })
    }
  }
}

export function runTestingMigrations(db, { skipLegacyMap = false } = {}) {
  // 方案 §13.1：postgres 生产句柄不重放 SQLite 迁移（结构由 baseline.sql 承担）；
  // 但 baseline 之后新增的列必须有 PG 分支补齐，否则冷启动 / 老库永远缺列，
  // 触发 harness/testing-gate.js 等 SELECT 报 "column ... does not exist" →
  // dashboard 事务被污染 → 用户看板刷新报 "current transaction is aborted"。
  if (process.env.AWP_DB_DIALECT === 'postgres' && (db?.dialect === 'postgres' || db?.pool)) {
    return runPostgresPatchups(db)
  }
  validateAppliedMigrationLedger(db, 'sqlite')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  db.exec(SCHEMA_V2_SQL)
  db.exec(SCHEMA_V3_SQL)
  db.exec(SCHEMA_V4_SQL)
  db.exec(SCHEMA_V5_SQL)
  // v6 为重建迁移：仅当旧 signing_keys CHECK 还不含 image_manifest 时执行一次
  const skSql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='signing_keys'`
  ).get()
  if (skSql && !String(skSql.sql).includes('image_manifest')) {
    db.exec(SCHEMA_V6_SQL)
  }
  db.exec(SCHEMA_V7_SQL)
  // v8 与旧协作层 experiences 同名但列不同。显式跳过仅依赖新表 repo_id 的索引，
  // 其余表/列/触发器仍在一个事务中执行；异常向上传播并阻止启动。
  db.exec('DROP TRIGGER IF EXISTS trg_experience_pending_infra_block')
  applySchemaV8Compatibly(db)
  // v9（test_specs 测试资产库）：CREATE TABLE IF NOT EXISTS 天然幂等，无条件执行
  db.exec(SCHEMA_V9_SQL)
  // v10（test_specs.side）：ALTER ADD COLUMN 非幂等，仿 v8 按列存在性门控
  const v10Side = db.prepare(
    `SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'side'`
  ).get()
  if (!v10Side) db.exec(SCHEMA_V10_SQL)
  // v11（business_snapshots.changed_files_json，eslint 基线 ratchet）：ALTER ADD COLUMN 非幂等，仿 v8 按列存在性门控
  const v11ChangedFiles = db.prepare(
    `SELECT 1 FROM pragma_table_info('business_snapshots') WHERE name = 'changed_files_json'`
  ).get()
  if (!v11ChangedFiles) db.exec(SCHEMA_V11_SQL)
  // v12（task_sessions + gate_loops，CLRP 闭环）：CREATE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V12_SQL)
  // v13（repo_test_policies，project 契约隔离）：CREATE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V13_SQL)
  // v14（repo_gate_modes +disabled 档）：CHECK 约束重建，按 sqlite_master.sql 门控幂等
  const v14Needed = !String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repo_gate_modes'").get()?.sql || ''
  ).includes("'disabled'")
  if (v14Needed) db.exec(SCHEMA_V14_SQL)
  // v15（repo_gate_modes +enforce_ml 档，仅 M/L 强制）：同上重建门控
  const v15Needed = !String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='repo_gate_modes'").get()?.sql || ''
  ).includes("'enforce_ml'")
  if (v15Needed) db.exec(SCHEMA_V15_SQL)
  // v16（repo_env_accounts，项目环境登录账号）：CREATE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V16_SQL)
  // v17（repo_env_settings，项目默认测试环境）：CREATE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V17_SQL)
  // v18（AC 覆盖 / 跨页面归因 / 经验分类）：ADD COLUMN 非幂等，按列存在性门控（v11 模式）
  const v18SpecCols = db.prepare(`SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'acceptance_refs_json'`).get()
  if (!v18SpecCols) db.exec('ALTER TABLE test_specs ADD COLUMN acceptance_refs_json TEXT;')
  const v18PagesCol = db.prepare(`SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'pages_json'`).get()
  if (!v18PagesCol) db.exec('ALTER TABLE test_specs ADD COLUMN pages_json TEXT;')
  const hasExperiences = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiences'`).get()
  if (hasExperiences) {
    const v18CatCol = db.prepare(`SELECT 1 FROM pragma_table_info('experiences') WHERE name = 'category'`).get()
    if (!v18CatCol) db.exec(`ALTER TABLE experiences ADD COLUMN category TEXT NOT NULL DEFAULT 'dev';`)
  }
  const v18MvCol = db.prepare(`SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'mutation_verified'`).get()
  if (!v18MvCol) db.exec('ALTER TABLE test_specs ADD COLUMN mutation_verified INTEGER NOT NULL DEFAULT 0;')
  const v18PayloadCol = db.prepare(`SELECT 1 FROM pragma_table_info('test_runs') WHERE name = 'payload_json'`).get()
  if (!v18PayloadCol) db.exec('ALTER TABLE test_runs ADD COLUMN payload_json TEXT;')
  // v19（测试资产审核插槽 + repo_test_policies.review_mode）：ADD COLUMN 非幂等，按列存在性门控
  const v19ReviewCol = db.prepare(`SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'reviewed_by'`).get()
  const v19ModeCol = db.prepare(`SELECT 1 FROM pragma_table_info('repo_test_policies') WHERE name = 'review_mode'`).get()
  if (!v19ReviewCol || !v19ModeCol) db.exec(SCHEMA_V19_SQL)
  // v20（FAIL_TO_PASS 验卷结果表）：CREATE TABLE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V20_SQL)
  // v21（platform_settings，平台级设置）：CREATE TABLE IF NOT EXISTS 幂等
  db.exec(SCHEMA_V21_SQL)
  // v22（run_attempts.steps_json，分步流程时间线）：ADD COLUMN 非幂等，按列存在性门控
  const v22Steps = db.prepare(
    `SELECT 1 FROM pragma_table_info('run_attempts') WHERE name = 'steps_json'`
  ).get()
  if (!v22Steps) db.exec(SCHEMA_V22_SQL)
  // v23（test_runs.purpose 放开 mutation）：CHECK 重建，按 sqlite_master.sql 门控
  const v23Needed = !String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='test_runs'").get()?.sql || ''
  ).includes("'mutation'")
  if (v23Needed) db.exec(SCHEMA_V23_SQL)
  // v24（test_specs.scope：task / regression）：ADD COLUMN 幂等
  const v24Scope = db.prepare(
    `SELECT 1 FROM pragma_table_info('test_specs') WHERE name = 'scope'`
  ).get()
  if (!v24Scope) db.exec(SCHEMA_V24_SQL)
  // v25（accepted_run_results 多 attempt，重推不再顶掉旧结果）：主键重建，按 sqlite_master.sql 门控
  const v25PkSql = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='accepted_run_results'").get()?.sql || ''
  )
  if (!v25PkSql.includes('PRIMARY KEY (run_id, attempt, lease_epoch)')) db.exec(SCHEMA_V25_SQL)
  // v26 全链路埋点：lifecycle / policy decisions / platform_settings + audit 扩列
  // audit_events 可能由 audit/migrate.js 稍后创建——此处若不存在则先建，避免 ALTER 失败
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type    TEXT NOT NULL,
      session_id    TEXT,
      tool_name     TEXT,
      method        TEXT,
      author        TEXT,
      repo          TEXT,
      task_id       TEXT,
      client_name   TEXT,
      args_preview  TEXT,
      status        TEXT DEFAULT 'ok',
      duration_ms   INTEGER,
      created_at    TEXT NOT NULL,
      detail        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
  `)
  if (SCHEMA_V26_SQL) db.exec(SCHEMA_V26_SQL)
  // platform_settings 双列兼容：v26 可能已只有 value_json；看板/注入/并发读写 value
  const psCols = db.prepare(`PRAGMA table_info(platform_settings)`).all().map((c) => c.name)
  if (!psCols.length) throw new Error('[migrate] platform_settings table missing after v21/v26')
  if (!psCols.includes('value')) db.exec(`ALTER TABLE platform_settings ADD COLUMN value TEXT`)
  if (!psCols.includes('value_json')) db.exec(`ALTER TABLE platform_settings ADD COLUMN value_json TEXT`)
  for (const col of ['trace_id', 'submission_id', 'run_id', 'attempt', 'binding_id', 'payload_json', 'phase']) {
    const has = db.prepare(`SELECT 1 FROM pragma_table_info('audit_events') WHERE name=?`).get(col)
    if (!has) {
      const type = col === 'attempt' ? 'INTEGER' : 'TEXT'
      db.exec(`ALTER TABLE audit_events ADD COLUMN ${col} ${type}`)
    }
  }
  // v26+：test_runs.coverage_complete——gate run 是否真跑了本轮冻结清单要求的用例集（纯数据标记，
  // 不改变 run 终态；NULL=未计算/不适用，1=证据完整，0=有应跑用例缺证据）。幂等 ADD COLUMN，不碰 CHECK 枚举。
  const covCol = db.prepare(`SELECT 1 FROM pragma_table_info('test_runs') WHERE name = 'coverage_complete'`).get()
  if (!covCol) db.exec('ALTER TABLE test_runs ADD COLUMN coverage_complete INTEGER;')
  const v26 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=26').get()
  if (SCHEMA_V26_SQL) {
    if (!v26) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (26, 'observability_trace', ?, ?)`
      ).run(SCHEMA_V26_CHECKSUM, utcNow())
    } else if (v26.checksum !== SCHEMA_V26_CHECKSUM) {
      throw migrationChecksumError({ version: 26, name: SQLITE_MIGRATION_NAMES[25], expected: SCHEMA_V26_CHECKSUM, actual: v26.checksum })
    }
  }
  const apply = db.transaction(() => {
    const applied = db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get()
    if (!applied) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (1, 'identity_snapshot_binding', ?, ?)`
      ).run(SCHEMA_CHECKSUM, utcNow())
    } else if (applied.checksum !== SCHEMA_CHECKSUM) {
      throw migrationChecksumError({ version: 1, name: SQLITE_MIGRATION_NAMES[0], expected: SCHEMA_CHECKSUM, actual: applied.checksum })
    }
    const v2 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=2').get()
    if (!v2) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (2, 'submissions_runs', ?, ?)`
      ).run(SCHEMA_V2_CHECKSUM, utcNow())
    } else if (v2.checksum !== SCHEMA_V2_CHECKSUM) {
      throw migrationChecksumError({ version: 2, name: SQLITE_MIGRATION_NAMES[1], expected: SCHEMA_V2_CHECKSUM, actual: v2.checksum })
    }
    const v3 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=3').get()
    if (!v3) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (3, 'harness_gate_observe', ?, ?)`
      ).run(SCHEMA_V3_CHECKSUM, utcNow())
    } else if (v3.checksum !== SCHEMA_V3_CHECKSUM) {
      throw migrationChecksumError({ version: 3, name: SQLITE_MIGRATION_NAMES[2], expected: SCHEMA_V3_CHECKSUM, actual: v3.checksum })
    }
    const v4 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=4').get()
    if (!v4) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (4, 'suite_registry_leases', ?, ?)`
      ).run(SCHEMA_V4_CHECKSUM, utcNow())
    } else if (v4.checksum !== SCHEMA_V4_CHECKSUM) {
      throw migrationChecksumError({ version: 4, name: SQLITE_MIGRATION_NAMES[3], expected: SCHEMA_V4_CHECKSUM, actual: v4.checksum })
    }
    const v5 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=5').get()
    if (!v5) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (5, 'secret_grants', ?, ?)`
      ).run(SCHEMA_V5_CHECKSUM, utcNow())
    } else if (v5.checksum !== SCHEMA_V5_CHECKSUM) {
      throw migrationChecksumError({ version: 5, name: SQLITE_MIGRATION_NAMES[4], expected: SCHEMA_V5_CHECKSUM, actual: v5.checksum })
    }
    const v6 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=6').get()
    if (!v6) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (6, 'image_manifest_signing_key', ?, ?)`
      ).run(SCHEMA_V6_CHECKSUM, utcNow())
    } else if (v6.checksum !== SCHEMA_V6_CHECKSUM) {
      throw migrationChecksumError({ version: 6, name: SQLITE_MIGRATION_NAMES[5], expected: SCHEMA_V6_CHECKSUM, actual: v6.checksum })
    }
    const v7 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=7').get()
    if (!v7) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (7, 'm4_overlays_waivers_promotion', ?, ?)`
      ).run(SCHEMA_V7_CHECKSUM, utcNow())
    } else if (v7.checksum !== SCHEMA_V7_CHECKSUM) {
      throw migrationChecksumError({ version: 7, name: SQLITE_MIGRATION_NAMES[6], expected: SCHEMA_V7_CHECKSUM, actual: v7.checksum })
    }
    const v8 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=8').get()
    if (!v8) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (8, 'm5_failure_experience', ?, ?)`
      ).run(SCHEMA_V8_CHECKSUM, utcNow())
    } else if (v8.checksum !== SCHEMA_V8_CHECKSUM) {
      throw migrationChecksumError({ version: 8, name: SQLITE_MIGRATION_NAMES[7], expected: SCHEMA_V8_CHECKSUM, actual: v8.checksum })
    }
    const v9 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=9').get()
    if (!v9) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (9, 'test_spec_assets', ?, ?)`
      ).run(SCHEMA_V9_CHECKSUM, utcNow())
    } else if (v9.checksum !== SCHEMA_V9_CHECKSUM) {
      throw migrationChecksumError({ version: 9, name: SQLITE_MIGRATION_NAMES[8], expected: SCHEMA_V9_CHECKSUM, actual: v9.checksum })
    }
    const v10 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=10').get()
    if (!v10) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (10, 'test_spec_side', ?, ?)`
      ).run(SCHEMA_V10_CHECKSUM, utcNow())
    } else if (v10.checksum !== SCHEMA_V10_CHECKSUM) {
      throw migrationChecksumError({ version: 10, name: SQLITE_MIGRATION_NAMES[9], expected: SCHEMA_V10_CHECKSUM, actual: v10.checksum })
    }
    const v11 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=11').get()
    if (!v11) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (11, 'snapshot_changed_files', ?, ?)`
      ).run(SCHEMA_V11_CHECKSUM, utcNow())
    } else if (v11.checksum !== SCHEMA_V11_CHECKSUM) {
      throw migrationChecksumError({ version: 11, name: SQLITE_MIGRATION_NAMES[10], expected: SCHEMA_V11_CHECKSUM, actual: v11.checksum })
    }
    const v12 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=12').get()
    if (!v12) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (12, 'gate_loop_clrp', ?, ?)`
      ).run(SCHEMA_V12_CHECKSUM, utcNow())
    } else if (v12.checksum !== SCHEMA_V12_CHECKSUM) {
      throw migrationChecksumError({ version: 12, name: SQLITE_MIGRATION_NAMES[11], expected: SCHEMA_V12_CHECKSUM, actual: v12.checksum })
    }
    const v13 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=13').get()
    if (!v13) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (13, 'repo_test_policies', ?, ?)`
      ).run(SCHEMA_V13_CHECKSUM, utcNow())
    } else if (v13.checksum !== SCHEMA_V13_CHECKSUM) {
      throw migrationChecksumError({ version: 13, name: SQLITE_MIGRATION_NAMES[12], expected: SCHEMA_V13_CHECKSUM, actual: v13.checksum })
    }
    const v14 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=14').get()
    if (!v14) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (14, 'gate_mode_disabled', ?, ?)`
      ).run(SCHEMA_V14_CHECKSUM, utcNow())
    } else if (v14.checksum !== SCHEMA_V14_CHECKSUM) {
      throw migrationChecksumError({ version: 14, name: SQLITE_MIGRATION_NAMES[13], expected: SCHEMA_V14_CHECKSUM, actual: v14.checksum })
    }
    const v15 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=15').get()
    if (!v15) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (15, 'gate_mode_enforce_ml', ?, ?)`
      ).run(SCHEMA_V15_CHECKSUM, utcNow())
    } else if (v15.checksum !== SCHEMA_V15_CHECKSUM) {
      throw migrationChecksumError({ version: 15, name: SQLITE_MIGRATION_NAMES[14], expected: SCHEMA_V15_CHECKSUM, actual: v15.checksum })
    }
    const v16 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=16').get()
    if (!v16) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (16, 'repo_env_accounts', ?, ?)`
      ).run(SCHEMA_V16_CHECKSUM, utcNow())
    } else if (v16.checksum !== SCHEMA_V16_CHECKSUM) {
      throw migrationChecksumError({ version: 16, name: SQLITE_MIGRATION_NAMES[15], expected: SCHEMA_V16_CHECKSUM, actual: v16.checksum })
    }
    const v17 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=17').get()
    if (!v17) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (17, 'repo_default_test_env', ?, ?)`
      ).run(SCHEMA_V17_CHECKSUM, utcNow())
    } else if (v17.checksum !== SCHEMA_V17_CHECKSUM) {
      throw migrationChecksumError({ version: 17, name: SQLITE_MIGRATION_NAMES[16], expected: SCHEMA_V17_CHECKSUM, actual: v17.checksum })
    }
    const v18 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=18').get()
    if (!v18) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (18, 'ac_coverage_category', ?, ?)`
      ).run(SCHEMA_V18_CHECKSUM, utcNow())
    } else if (v18.checksum !== SCHEMA_V18_CHECKSUM) {
      throw migrationChecksumError({ version: 18, name: SQLITE_MIGRATION_NAMES[17], expected: SCHEMA_V18_CHECKSUM, actual: v18.checksum })
    }
    const v19 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=19').get()
    if (!v19) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (19, 'test_spec_review_plugin', ?, ?)`
      ).run(SCHEMA_V19_CHECKSUM, utcNow())
    } else if (v19.checksum !== SCHEMA_V19_CHECKSUM) {
      throw migrationChecksumError({ version: 19, name: SQLITE_MIGRATION_NAMES[18], expected: SCHEMA_V19_CHECKSUM, actual: v19.checksum })
    }
    const v20 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=20').get()
    if (!v20) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (20, 'f2p_results', ?, ?)`
      ).run(SCHEMA_V20_CHECKSUM, utcNow())
    } else if (v20.checksum !== SCHEMA_V20_CHECKSUM) {
      throw migrationChecksumError({ version: 20, name: SQLITE_MIGRATION_NAMES[19], expected: SCHEMA_V20_CHECKSUM, actual: v20.checksum })
    }
    const v21 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=21').get()
    if (!v21) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (21, 'platform_settings', ?, ?)`
      ).run(SCHEMA_V21_CHECKSUM, utcNow())
    } else if (v21.checksum !== SCHEMA_V21_CHECKSUM) {
      throw migrationChecksumError({ version: 21, name: SQLITE_MIGRATION_NAMES[20], expected: SCHEMA_V21_CHECKSUM, actual: v21.checksum })
    }
    const v22 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=22').get()
    if (!v22) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (22, 'attempt_steps_timeline', ?, ?)`
      ).run(SCHEMA_V22_CHECKSUM, utcNow())
    } else if (v22.checksum !== SCHEMA_V22_CHECKSUM) {
      throw migrationChecksumError({ version: 22, name: SQLITE_MIGRATION_NAMES[21], expected: SCHEMA_V22_CHECKSUM, actual: v22.checksum })
    }
    const v23 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=23').get()
    if (!v23) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (23, 'test_runs_purpose_mutation', ?, ?)`
      ).run(SCHEMA_V23_CHECKSUM, utcNow())
    } else if (v23.checksum !== SCHEMA_V23_CHECKSUM) {
      throw migrationChecksumError({ version: 23, name: SQLITE_MIGRATION_NAMES[22], expected: SCHEMA_V23_CHECKSUM, actual: v23.checksum })
    }
    const v24 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=24').get()
    if (!v24) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (24, 'test_specs_scope', ?, ?)`
      ).run(SCHEMA_V24_CHECKSUM, utcNow())
    } else if (v24.checksum !== SCHEMA_V24_CHECKSUM) {
      throw migrationChecksumError({ version: 24, name: SQLITE_MIGRATION_NAMES[23], expected: SCHEMA_V24_CHECKSUM, actual: v24.checksum })
    }
    const v25 = db.prepare('SELECT checksum FROM schema_migrations WHERE version=25').get()
    if (!v25) {
      db.prepare(
        `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (25, 'accepted_results_multi_attempt', ?, ?)`
      ).run(SCHEMA_V25_CHECKSUM, utcNow())
    } else if (v25.checksum !== SCHEMA_V25_CHECKSUM) {
      throw migrationChecksumError({ version: 25, name: SQLITE_MIGRATION_NAMES[24], expected: SCHEMA_V25_CHECKSUM, actual: v25.checksum })
    }
    ensureSystemPrincipal(db)
    if (!skipLegacyMap) mapLegacyTasks(db)
    seedRepoGateModes(db)
    seedRepoTestPolicies(db)
    seedRepoGateModesEnforce(db)
    const fk = db.prepare('PRAGMA foreign_key_check').all()
    if (fk.length) throw new Error(`foreign_key_check failed: ${JSON.stringify(fk)}`)
  })
  apply.immediate()
  // v27+：DDL 与版本登记同事务（原子）。历史 v1–v26 保持原路径不动。
  runPostV26Migrations(db)
  // 空库/测试隔离：补齐 harness 兼容列。
  // 注意：默认租户种子（seedDefaultTenantRepos）已移至生产启动路径（db.js initDB）——
  // 迁移只管 schema，不种业务数据；单测自行 ensureRepository 建仓，避免与手插 repositories 冲突。
  ensureHarnessCompatColumns(db)
  validateAppliedMigrationLedger(db, 'sqlite')
}

function applySchemaV8Compatibly(db) {
  const hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
  const hasColumn = (table, column) => hasTable(table) && !!db.prepare(
    `SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`
  ).get(column)
  let sql = SCHEMA_V8_SQL
  for (const column of ['reviewed_by', 'reviewed_at']) {
    if (hasColumn('test_failures', column)) {
      sql = sql.replace(new RegExp(`ALTER TABLE test_failures ADD COLUMN ${column} TEXT;`, 'g'), '')
    }
  }
  if (hasTable('experiences') && !hasColumn('experiences', 'repo_id')) {
    sql = sql.replace(
      /CREATE INDEX IF NOT EXISTS idx_experiences_repo\s+ON experiences\(repo_id, created_at DESC\);/,
      '-- Legacy experiences table is converged by v27; this v8 index targets the incompatible shape.\n'
    )
  }
  const apply = db.transaction(() => db.exec(sql))
  apply.immediate()
}

/**
 * harness 侧列（tasks.size/meta、verify_reports.task_id）历史上由 harness/migrate.js 补。
 * 单测默认空库时部分文件不 import state-machine → 列缺失。迁移到 testing 统一补齐。
 */
function ensureHarnessCompatColumns(db) {
  const hasTable = (t) =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
  const colsOf = (t) =>
    new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name))
  const addIfMissing = (table, col, ddl) => {
    if (!hasTable(table)) return
    const cols = colsOf(table)
    if (!cols.has(col)) db.exec(ddl)
  }
  addIfMissing('tasks', 'size', `ALTER TABLE tasks ADD COLUMN size TEXT`)
  addIfMissing('tasks', 'meta', `ALTER TABLE tasks ADD COLUMN meta TEXT DEFAULT '{}'`)
  addIfMissing('verify_reports', 'task_id', `ALTER TABLE verify_reports ADD COLUMN task_id TEXT`)
}

/** 空库种子：默认租户仓，供 FK / gate mode / 集成用例使用 */
/**
 * 生产启动路径的默认租户种子（db.js initDB 调用）。迁移函数不再自动 seed。
 * 空库种子：默认租户仓，供 FK / gate mode / 集成用例使用。
 */
export function seedDefaultTenantRepos(db) {
  try {
    const sys = ensureSystemPrincipal(db)
    ensureRepository(db, 'demo-app', sys, utcNow())
    ensureRepository(db, 'test-plain-repo', sys, utcNow())
  } catch { /* ignore */ }
  try { seedRepoGateModes(db) } catch { /* ignore */ }
  try { seedRepoTestPolicies(db) } catch { /* ignore */ }
  try { seedRepoGateModesEnforce(db) } catch { /* ignore */ }
}

/** Apply DDL and ledger insertion atomically; applied migrations are immutable. */
export function applyVersionedMigration(db, { version, name, checksum, apply }) {
  const tx = db.transaction(() => {
    const applied = db.prepare('SELECT name, checksum FROM schema_migrations WHERE version=?').get(version)
    if (applied) {
      if (applied.name !== name || applied.checksum !== checksum) {
        throw migrationChecksumError({ version, name, expected: checksum, actual: applied.checksum })
      }
      return
    }
    if (apply) apply(db)
    db.prepare(
      `INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`
    ).run(version, name, checksum, utcNow())
  })
  tx.immediate()
}

/** v27+ 迁移清单：新增版本在此登记，勿回改 v1–v26 历史路径 */
function runPostV26Migrations(db) {
  const steps = [
    ['v27', () => applyV27ExperiencesConvergence(db)],
    ['v28', () => applyV28IdSequences(db)],
    ['v29', () => applyV29VerifyEvidenceFields(db)],
    ['v30', () => applyV30RuleArtifacts(db)],
    ['v31', () => applyV31TestSpecsApiType(db, { applyVersionedMigration })],
    ['v32', () => applyV32TaskAttachments(db)],
    ['v33', () => applyV33CollaborationTenantId(db)],
    ['v34', () => applyV34PhaseActivityNames(db)],
    ['v35', () => applyV35RepoRuntimeSettings(db)],
    ['v36', () => applyV36TenantExtensions(db)],
    ['v37', () => applyV37MutationVerdict(db)],
    ['v39', () => applyV39DeferredSubmissions(db)],
    ['v40', () => applyV40DeferredRetryColumns(db)],
    ['v41', () => applyV41GenericRunSides(db)],
    ['v42', () => applyV42PromotionProviderFieldsRemoved(db)],
    ['v43', () => applyV43ExperienceFeedback(db)],
  ]
  for (const [, fn] of steps) fn()
}

function applyV41GenericRunSides(db) {
  applyVersionedMigration(db, {
    version: 41,
    name: 'generic_run_sides',
    checksum: createHash('sha256').update(SCHEMA_V41_SQL).digest('hex'),
    apply: (db) => db.exec(SCHEMA_V41_SQL),
  })
}

function applyV42PromotionProviderFieldsRemoved(db) {
  applyVersionedMigration(db, {
    version: 42,
    name: 'promotion_provider_fields_removed',
    checksum: createHash('sha256').update(SCHEMA_V42_SQL).digest('hex'),
    apply: (db) => {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='promotion_proposals'").get()
      if (!exists) throw new Error('[migrate v42] promotion_proposals table is missing')
      const columns = new Set(db.prepare('PRAGMA table_info(promotion_proposals)').all().map((column) => column.name))
      for (const column of ['mr_provider', 'mr_project_id', 'mr_iid', 'mr_url', 'mr_state']) {
        if (columns.has(column)) db.exec(`ALTER TABLE promotion_proposals DROP COLUMN ${column}`)
      }
    },
  })
}

function applyV43ExperienceFeedback(db) {
  applyVersionedMigration(db, {
    version: 43,
    name: 'experience_feedback',
    checksum: createHash('sha256').update(SCHEMA_V43_SQL).digest('hex'),
    apply: (db) => db.exec(SCHEMA_V43_SQL),
  })
}

/**
 * v27 experiences schema convergence
 * 在真库协作层 experiences（db.js：id/repo/content/status/...）上增补
 * testing/failures promote 所需列；按列存在性门控，幂等可重入。
 */
function applyV27ExperiencesConvergence(db) {
  applyVersionedMigration(db, {
    version: 27,
    name: 'experience_schema_convergence',
    checksum: SCHEMA_V27_CHECKSUM,
    apply: (db) => {
      const hasTable = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='experiences'`
      ).get()
      if (!hasTable) return
      const cols = db.prepare(`PRAGMA table_info(experiences)`).all().map((c) => c.name)
      const colSet = new Set(cols)
      const addIfMissing = (name, ddl) => {
        if (!colSet.has(name)) {
          db.exec(ddl)
          colSet.add(name)
        }
      }
      addIfMissing('title', `ALTER TABLE experiences ADD COLUMN title TEXT`)
      addIfMissing('source_type', `ALTER TABLE experiences ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'`)
      addIfMissing('source_id', `ALTER TABLE experiences ADD COLUMN source_id TEXT`)
      addIfMissing('reviewer', `ALTER TABLE experiences ADD COLUMN reviewer TEXT`)
      addIfMissing('confidence', `ALTER TABLE experiences ADD COLUMN confidence REAL`)
      addIfMissing('fingerprint', `ALTER TABLE experiences ADD COLUMN fingerprint TEXT`)
      addIfMissing('promotion_type', `ALTER TABLE experiences ADD COLUMN promotion_type TEXT`)
      if (colSet.has('task_id')) {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_task ON experiences(task_id)`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_fingerprint ON experiences(fingerprint)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_exp_created ON experiences(created_at)`)
    },
  })
}

/**
 * v28 id_sequences：替换 COUNT(*)+1 的日序列分配。
 * 建表 + 从 experiences/verify_reports 当日 ID 回填水位，避免碰撞。
 */
function applyV28IdSequences(db) {
  const checksum = 'id-sequences-v28'
  applyVersionedMigration(db, {
    version: 28,
    name: 'id_sequences',
    checksum,
    apply: (db) => {
      createIdSequencesTable(db)
      // 回填水位：真库 experiences / verify_reports 可能已有当日 ID
      const hasTable = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      const hasColumn = (table, column) => hasTable(table) && !!db.prepare(
        `SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`
      ).get(column)
      if (hasTable('experiences')) {
        const idColumn = hasColumn('experiences', 'id')
          ? 'id'
          : hasColumn('experiences', 'experience_id')
            ? 'experience_id'
            : null
        if (!idColumn) throw new Error('[migrate v28] experiences table has neither id nor experience_id column')
        backfillIdSequence(db, 'exp', 'experiences', idColumn)
      }
      if (hasTable('verify_reports')) {
        if (!hasColumn('verify_reports', 'id')) throw new Error('[migrate v28] verify_reports table has no id column')
        backfillIdSequence(db, 'rep', 'verify_reports', 'id')
      }
    },
  })
}

/**
 * v29 verify_reports 证据字段：workspace_head / code_snapshot_sha / output_sha256 /
 * command_exit_code / started_at / finished_at / source
 */
function applyV29VerifyEvidenceFields(db) {
  applyVersionedMigration(db, {
    version: 29,
    name: 'verify_evidence_fields',
    checksum: createHash('sha256').update(SCHEMA_V29_SQL).digest('hex'),
    apply: (db) => {
      const hasTable = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='verify_reports'`
      ).get()
      if (!hasTable) return
      const cols = new Set(
        db.prepare(`PRAGMA table_info(verify_reports)`).all().map((c) => c.name)
      )
      const addIfMissing = (name, ddl) => {
        if (!cols.has(name)) {
          db.exec(ddl)
          cols.add(name)
        }
      }
      addIfMissing('workspace_head', `ALTER TABLE verify_reports ADD COLUMN workspace_head TEXT`)
      addIfMissing('code_snapshot_sha', `ALTER TABLE verify_reports ADD COLUMN code_snapshot_sha TEXT`)
      addIfMissing('output_sha256', `ALTER TABLE verify_reports ADD COLUMN output_sha256 TEXT`)
      addIfMissing('command_exit_code', `ALTER TABLE verify_reports ADD COLUMN command_exit_code INTEGER`)
      addIfMissing('started_at', `ALTER TABLE verify_reports ADD COLUMN started_at TEXT`)
      addIfMissing('finished_at', `ALTER TABLE verify_reports ADD COLUMN finished_at TEXT`)
      addIfMissing('source', `ALTER TABLE verify_reports ADD COLUMN source TEXT DEFAULT 'manual'`)
    },
  })
}

/** v30 rule_artifacts：规则资产表 */
function applyV30RuleArtifacts(db) {
  applyVersionedMigration(db, {
    version: 30,
    name: 'rule_artifacts',
    checksum: 'rule-artifacts-v30',
    apply: (db) => {
      ensureRuleArtifactsTable(db)
    },
  })
}

/** v32 task_attachments：任务上下文资产（需求文档/接口文档/设计引用）——任务简报一等公民化 */
function applyV32TaskAttachments(db) {
  applyVersionedMigration(db, {
    version: 32,
    name: 'task_attachments',
    checksum: 'task-attachments-v32',
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_attachments (
          attachment_id  TEXT PRIMARY KEY,
          repo_id        TEXT NOT NULL REFERENCES repositories(repo_id),
          task_id        TEXT NOT NULL,
          kind           TEXT NOT NULL CHECK(kind IN ('requirement','api','design','other')),
          title          TEXT,
          content        TEXT,
          url            TEXT,
          author         TEXT,
          created_at     TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_attachments_task
          ON task_attachments(repo_id, task_id, created_at);
      `)
    },
  })
}

/**
 * v33 collaboration_tenant_id（方案第 1 节）：
 * 协作表新增 tenant_id（= repositories.repo_id），slug 列保留到 PostgreSQL 基线（方案决定 1）。
 * - 先保证 repo='shared' 有 repositories 行（方案决定 2）
 * - 回填 tenant_id = (SELECT repo_id FROM repositories WHERE slug = <table>.repo)
 * - 未知 slug → 迁移失败并列出 slug（不得写 NULL，不得落到 demo-app）
 * - SQLite 不能 ALTER SET NOT NULL：以 BEFORE INSERT/UPDATE 触发器 RAISE(ABORT) 强制
 *   「新 INSERT 不写 tenant_id 即失败」（§5.4 预期行为）；真正的 NOT NULL 列约束在
 *   第 7 节 PostgreSQL 基线落地
 * - tasks 增加 (tenant_id, task_id) 唯一索引；原主键 (repo, task_id) 保留
 */
const COLLAB_TENANT_TABLES = ['tasks', 'task_versions', 'docs', 'docs_versions', 'experiences', 'verify_reports', 'gate_loops', 'task_sessions']

function applyV33CollaborationTenantId(db) {
  applyVersionedMigration(db, {
    version: 33,
    name: 'collaboration_tenant_id',
    checksum: 'collaboration-tenant-id-v33',
    apply: (db) => {
      const hasTable = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
      const colsOf = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name))
      // 协作表以「表存在且含 repo slug 列」为准（§5.1「以实际表存在为准」）：
      // 裸测试库上 v8 会先建同名异构 experiences（repo_id 键、无 repo 列），不属于协作表，跳过
      const tables = COLLAB_TENANT_TABLES.filter(hasTable).filter((t) => colsOf(t).has('repo'))
      for (const t of tables) {
        if (!colsOf(t).has('tenant_id')) {
          db.exec(`ALTER TABLE ${t} ADD COLUMN tenant_id TEXT`)
        }
      }
      // 方案决定 2：存在 repo='shared' 的业务行时，先保证 shared 有 repositories 行
      const hasSharedRow = tables.some((t) =>
        db.prepare(`SELECT 1 FROM ${t} WHERE repo = 'shared' LIMIT 1`).get()
      )
      if (hasSharedRow) {
        ensureRepository(db, 'shared', ensureSystemPrincipal(db))
      }
      // 回填（方案 §5.1）
      for (const t of tables) {
        db.exec(
          `UPDATE ${t} SET tenant_id = (
             SELECT repo_id FROM repositories WHERE slug = ${t}.repo
           ) WHERE tenant_id IS NULL`
        )
      }
      // 未知 slug：迁移失败并列出，禁止写成 NULL / 禁止落到 demo-app
      const unknown = []
      for (const t of tables) {
        for (const r of db.prepare(`SELECT DISTINCT repo FROM ${t} WHERE tenant_id IS NULL`).all()) {
          unknown.push(`${t}.repo=${r.repo}`)
        }
      }
      if (unknown.length) {
        throw new Error(
          `[collaboration_tenant_id] 回填失败：以下 slug 在 repositories 无对应行，` +
          `请先补 repositories 行或修数后再启动：${unknown.join(', ')}`
        )
      }
      // NOT NULL 行为强制（SQLite 无 ALTER SET NOT NULL）：新写入缺 tenant_id 即失败
      for (const t of tables) {
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS trg_${t}_tenant_not_null_ins
           BEFORE INSERT ON ${t}
           WHEN NEW.tenant_id IS NULL
           BEGIN SELECT RAISE(ABORT, '${t}.tenant_id NOT NULL (collaboration_tenant_id)'); END`
        )
        db.exec(
          `CREATE TRIGGER IF NOT EXISTS trg_${t}_tenant_not_null_upd
           BEFORE UPDATE ON ${t}
           WHEN NEW.tenant_id IS NULL
           BEGIN SELECT RAISE(ABORT, '${t}.tenant_id NOT NULL (collaboration_tenant_id)'); END`
        )
      }
      // tasks (tenant_id, task_id) 唯一（方案 §5.1）；slug 列删除前保留原主键 (repo, task_id)
      if (tables.includes('tasks')) {
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_tenant_task ON tasks(tenant_id, task_id)`)
      }
    },
  })
}

/**
 * v34 phase_activity_names（方案第 2 节）：
 * 把 tasks.phase / task_versions.phase / gate_loops.phase 的旧阶段名回填为活动名。
 * 映射只使用 phaseToActivity 已有的表；VERIFY 一律写成 static（smoke）。
 * 注意：历史行无法分辨 static 与 smoke——旧名 VERIFY 统一回填为 static；
 * 新写入经 transitionTask 校验后不会再把 smoke 存成 VERIFY（方案决定 3）。
 */
const V34_LEGACY_TO_ACTIVITY = {
  RECEIVE: 'receive',
  CLASSIFY: 'classify',
  LOCATE: 'retrieve',
  PLAN: 'plan',
  EXECUTE: 'execute',
  VERIFY: 'static',
  DISTILL: 'distill',
  DONE: 'done',
  ABORTED: 'aborted',
}

function applyV34PhaseActivityNames(db) {
  applyVersionedMigration(db, {
    version: 34,
    name: 'phase_activity_names',
    checksum: 'phase-activity-names-v34',
    apply: (db) => {
      const hasTable = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)
      for (const t of ['tasks', 'task_versions', 'gate_loops']) {
        if (!hasTable(t)) continue
        const hasPhase = db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name='phase'`).get()
        if (!hasPhase) continue
        for (const [legacy, activity] of Object.entries(V34_LEGACY_TO_ACTIVITY)) {
          db.prepare(`UPDATE ${t} SET phase = ? WHERE phase = ?`).run(activity, legacy)
        }
      }
    },
  })
}

/**
 * v35 repo_runtime_settings（方案第 5 节）：
 * 按项目变化的配置离开 platform_settings 的键名编码（e2e_inject_mode:<slug>），
 * 改为 (repo_id, key) 行。不并入 repo_gate_modes / repo_test_policies（§9.2）。
 */
function applyV35RepoRuntimeSettings(db) {
  applyVersionedMigration(db, {
    version: 35,
    name: 'repo_runtime_settings',
    checksum: 'repo-runtime-settings-v35',
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_runtime_settings (
          repo_id     TEXT NOT NULL REFERENCES repositories(repo_id),
          key         TEXT NOT NULL,
          value_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (repo_id, key)
        );
      `)
    },
  })
}

/**
 * v36 tenant_extensions（方案第 9 节）：租户扩展点登记表。
 * 生效行 = (repo_id, feature) 上 state='active' 的最大 revision；
 * 回滚 = 插入更大 revision（错误版标 deprecated、恢复版标 active），禁止 UPDATE 改写历史 params_json。
 */
function applyV36TenantExtensions(db) {
  applyVersionedMigration(db, {
    version: 36,
    name: 'tenant_extensions',
    checksum: 'tenant-extensions-v36',
    apply: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tenant_extensions (
          repo_id     TEXT NOT NULL REFERENCES repositories(repo_id),
          feature     TEXT NOT NULL,
          handler_id  TEXT NOT NULL,
          params_json TEXT NOT NULL DEFAULT '{}',
          revision    INTEGER NOT NULL,
          state       TEXT NOT NULL CHECK (state IN ('active','deprecated')),
          updated_at  TEXT NOT NULL,
          PRIMARY KEY (repo_id, feature, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_tenant_extensions_active
          ON tenant_extensions(repo_id, feature, state, revision);
      `)
    },
  })
}

/**
 * v37 mutation_verdict：把「变异有效性」从二值 mutation_verified 拆出三态结论列。
 *
 * 背景：mutation_verified=1 同时被两种互斥语义写入——
 *   ① spec 真跑且抓住了暗题（caught：有效证明）
 *   ② 压根没造出变异 / 疑似等价变异而豁免放行（not_applicable / exempt_equiv：没有证明）
 * 二者都写 1，导致「变异有效性通过率」被大量"没考"抬到接近 100%——比不测更有害。
 *
 * 本迁移只加列、不改既有列与既有门禁行为（防 2026-09-27 生产死锁复发）：
 *   mutation_verified 保持 1/0 原语义（派卷去重、门禁判定继续读它）；
 *   mutation_verdict 记录真实结论，供统计与看板区分「有效通过」与「豁免通过」。
 */
/**
 * PG 生产库结构补丁：baseline.sql 落定之后代码新增的列，全部走这里幂等补齐。
 * 与 SQLite 侧 v37+ 迁移一一对应；登记 schema_migrations（v38+，避开 PG baseline 已占的 v37），
 * 冷启动 / 老库自动收敛，运维不需要手工 ALTER。
 * 只在 dialect=postgres 时调用（runTestingMigrations 顶部 PG 分支）。
 */
export async function runPostgresPatchups(db) {
  // v38 · mutation_verdict（PG 补齐，对齐 SQLite v37）
  // ALTER ADD COLUMN IF NOT EXISTS 天然幂等；applyVersionedMigration 记账避免重复执行
  await applyVersionedMigrationAsync(db, {
    version: 38,
    name: 'mutation_verdict_pg',
    checksum: 'mutation-verdict-pg-v38',
    apply: async (tx) => {
      await tx.exec('ALTER TABLE test_specs ADD COLUMN IF NOT EXISTS mutation_verdict TEXT')
    },
  })
  // v39 · deferred_submissions（PG 主库补齐，冷启动自动建表；baseline.sql 已含，此处保护旧库）
  await applyVersionedMigrationAsync(db, {
    version: 39,
    name: 'deferred_submissions_pg',
    checksum: 'deferred-submissions-pg-v39',
    apply: async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS deferred_submissions (
        deferred_id              TEXT PRIMARY KEY,
        client_request_id        TEXT NOT NULL,
        repo_id                  TEXT NOT NULL,
        task_id                  TEXT NOT NULL,
        author                   TEXT NOT NULL,
        side                     TEXT NOT NULL,
        side_reason              TEXT,
        source_ref               TEXT,
        code_commit_oid          TEXT,
        code_diff                TEXT NOT NULL,
        trigger_reason           TEXT,
        product_fixed            BIGINT NOT NULL DEFAULT 0,
        suite_fixed              BIGINT NOT NULL DEFAULT 0,
        status                   TEXT NOT NULL DEFAULT 'pending'
                                   CHECK(status IN ('pending','claimed','processed','failed')),
        claimed_by_worker        TEXT,
        claimed_at               TEXT,
        processed_submission_id  TEXT,
        error_message            TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        UNIQUE(repo_id, client_request_id)
      )`)
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_submissions(status, created_at)`)
    },
  })
  // v40 · deferred_submissions 重试列（P1-A 失败分类/退避重试；PG 旧库补齐，新库 baseline 已含）
  await applyVersionedMigrationAsync(db, {
    version: 40,
    name: 'deferred_retry_cols_pg',
    checksum: 'deferred-retry-cols-pg-v40',
    apply: async (tx) => {
      await tx.exec('ALTER TABLE deferred_submissions ADD COLUMN IF NOT EXISTS attempts BIGINT NOT NULL DEFAULT 0')
      await tx.exec('ALTER TABLE deferred_submissions ADD COLUMN IF NOT EXISTS max_attempts BIGINT NOT NULL DEFAULT 3')
      await tx.exec('ALTER TABLE deferred_submissions ADD COLUMN IF NOT EXISTS next_retry_at TEXT')
      await tx.exec('ALTER TABLE deferred_submissions ADD COLUMN IF NOT EXISTS last_error_class TEXT')
    },
  })
  await applyVersionedMigrationAsync(db, {
    version: 41,
    name: 'generic_run_sides_pg',
    checksum: 'generic-run-sides-pg-v41',
    apply: async (tx) => {
      await tx.exec('ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_side_check')
    },
  })
  await applyVersionedMigrationAsync(db, {
    version: 42,
    name: 'promotion_provider_fields_removed_pg',
    checksum: 'promotion-provider-fields-removed-pg-v42',
    apply: async (tx) => {
      for (const column of ['mr_provider', 'mr_project_id', 'mr_iid', 'mr_url', 'mr_state']) {
        await tx.exec(`ALTER TABLE promotion_proposals DROP COLUMN IF EXISTS ${column}`)
      }
    },
  })
  await applyVersionedMigrationAsync(db, {
    version: 43,
    name: 'experience_feedback_pg',
    checksum: 'experience-feedback-pg-v43',
    apply: async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS experience_feedback (
        feedback_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repositories(repo_id),
        run_id TEXT,
        failure_id TEXT,
        experience_ref TEXT,
        author TEXT,
        source_type TEXT NOT NULL CHECK(source_type IN ('run','manual','external')),
        failure_summary TEXT NOT NULL,
        resolution_summary TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'unverified'
          CHECK(verification_status IN ('unverified','confirmed','rejected')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT,
        review_note TEXT,
        CHECK(length(trim(failure_summary)) > 0),
        CHECK(length(trim(resolution_summary)) > 0)
      )`)
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_experience_feedback_repo_status
        ON experience_feedback(repo_id, verification_status, created_at DESC)`)
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_experience_feedback_run
        ON experience_feedback(run_id, created_at DESC)`)
      await tx.exec(`CREATE INDEX IF NOT EXISTS idx_experience_feedback_failure
        ON experience_feedback(failure_id, created_at DESC)`)
    },
  })
}

// 异步版 applyVersionedMigration：pg 句柄 prepare().run() 返回 Promise，同步 API 兜不住。
// 语义与 applyVersionedMigration 一致：checksum 相同则跳过；否则跑 apply 并登记。
async function applyVersionedMigrationAsync(db, { version, name, checksum, apply }) {
  await db.tx(async (tx) => {
    const applied = await tx.prepare('SELECT name, checksum FROM schema_migrations WHERE version=?').get(version)
    if (applied) {
      if (applied.name !== name || applied.checksum !== checksum) {
        throw migrationChecksumError({ version, name, expected: checksum, actual: applied.checksum })
      }
      return
    }
    await apply(tx)
    await tx.prepare(
      'INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)'
    ).run(String(version), name, checksum, new Date().toISOString())
  })
}

function applyV39DeferredSubmissions(db) {
  applyVersionedMigration(db, {
    version: 39,
    name: 'deferred_submissions',
    checksum: 'deferred-submissions-v39',
    apply: (db) => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS deferred_submissions (
          deferred_id              TEXT PRIMARY KEY,
          client_request_id        TEXT NOT NULL,
          repo_id                  TEXT NOT NULL,
          task_id                  TEXT NOT NULL,
          author                   TEXT NOT NULL,
          side                     TEXT NOT NULL,
          side_reason              TEXT,
          source_ref               TEXT,
          code_commit_oid          TEXT,
          code_diff                TEXT NOT NULL,
          trigger_reason           TEXT,
          product_fixed            INTEGER NOT NULL DEFAULT 0,
          suite_fixed              INTEGER NOT NULL DEFAULT 0,
          status                   TEXT NOT NULL DEFAULT 'pending'
                                     CHECK(status IN ('pending','claimed','processed','failed')),
          claimed_by_worker        TEXT,
          claimed_at               TEXT,
          processed_submission_id  TEXT,
          error_message            TEXT,
          created_at               TEXT NOT NULL,
          updated_at               TEXT NOT NULL,
          UNIQUE(repo_id, client_request_id)
        );`
      )
      db.exec(`CREATE INDEX IF NOT EXISTS idx_deferred_status ON deferred_submissions(status, created_at)`)
    },
  })
}

function applyV40DeferredRetryColumns(db) {
  applyVersionedMigration(db, {
    version: 40,
    name: 'deferred_retry_cols',
    checksum: 'deferred-retry-cols-v40',
    apply: () => {
      // SQLite ALTER ADD COLUMN 非幂等：逐列按 pragma_table_info 门控
      const has = (col) => db
        .prepare("SELECT 1 FROM pragma_table_info('deferred_submissions') WHERE name=?").get(col)
      if (!has('attempts')) db.exec('ALTER TABLE deferred_submissions ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0')
      if (!has('max_attempts')) db.exec('ALTER TABLE deferred_submissions ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3')
      if (!has('next_retry_at')) db.exec('ALTER TABLE deferred_submissions ADD COLUMN next_retry_at TEXT')
      if (!has('last_error_class')) db.exec('ALTER TABLE deferred_submissions ADD COLUMN last_error_class TEXT')
    },
  })
}

function applyV37MutationVerdict(db) {
  applyVersionedMigration(db, {
    version: 37,
    name: 'mutation_verdict',
    checksum: 'mutation-verdict-v37',
    apply: (db) => {
      // ALTER ADD COLUMN 非幂等：按列存在性门控（仿 v11 / v18 模式）
      const col = db
        .prepare("SELECT 1 FROM pragma_table_info('test_specs') WHERE name='mutation_verdict'")
        .get()
      if (!col) {
        db.exec('ALTER TABLE test_specs ADD COLUMN mutation_verdict TEXT')
      }
    },
  })
}

function ensureSystemPrincipal(db) {
  const row = db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(SYSTEM_SUBJECT)
  if (row) return row.principal_id
  const id = uuidv7()
  const now = utcNow()
  try {
    db.prepare(
      `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
       VALUES (?, ?, 'Test Platform', 'active', ?, ?)`
    ).run(id, SYSTEM_SUBJECT, now, now)
    return id
  } catch {
    return db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(SYSTEM_SUBJECT).principal_id
  }
}

function mapLegacyTasks(db) {
  let tasks
  try {
    tasks = db.prepare('SELECT task_id, repo, requirement, type, phase, size, meta, author, created_at, updated_at, closed_at, completed, pending, decisions FROM tasks').all()
  } catch {
    try {
      tasks = db.prepare('SELECT task_id, repo, requirement, type, phase, author, created_at, updated_at, closed_at, completed, pending, decisions FROM tasks').all()
    } catch {
      return
    }
  }
  const systemId = ensureSystemPrincipal(db)
  const now = utcNow()
  for (const t of tasks) {
    const repoId = ensureRepository(db, t.repo || 'demo-app', systemId, now)
    const existing = db.prepare(
      'SELECT task_instance_id FROM legacy_task_mappings WHERE repo_id=? AND legacy_task_id=?'
    ).get(repoId, t.task_id)
    if (existing) continue
    const dup = db.prepare(
      'SELECT task_instance_id FROM task_instances WHERE repo_id=? AND external_task_id=? AND epoch=1'
    ).get(repoId, t.task_id)
    if (dup) {
      db.prepare(
        `INSERT OR IGNORE INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
         VALUES (?, ?, ?, ?)`
      ).run(repoId, t.task_id, dup.task_instance_id, now)
      continue
    }
    const authorId = ensureAuthorPrincipal(db, t.author || 'unknown', now)
    const instanceId = uuidv7()
    // v34 后 tasks.phase 存活动名；task_instances.phase 仍只存旧名 → projectPhase 投影
    const legacyPhase = projectPhase(phaseToActivity(t.phase))
    const allowedPhase = new Set(['RECEIVE','CLASSIFY','LOCATE','PLAN','EXECUTE','VERIFY','DISTILL','DONE','ABORTED'])
    const phase = allowedPhase.has(t.phase) ? t.phase : allowedPhase.has(legacyPhase) ? legacyPhase : 'RECEIVE'
    const status = phase === 'DONE' ? 'done' : phase === 'ABORTED' ? 'aborted' : 'open'
    const size = t.size === 'S' || t.size === 'M' || t.size === 'L' ? t.size : null
    const type = ['FEATURE', 'UI_DEV', 'FIX', 'INTEGRATION', 'RELEASE'].includes(t.type) ? t.type : null
    db.prepare(
      `INSERT INTO task_instances(
         task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, type,
         status, author_principal_id, legacy_snapshot_json, created_at, updated_at, closed_at
       ) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      instanceId,
      repoId,
      t.task_id,
      phase,
      size,
      type,
      status,
      authorId,
      JSON.stringify(t),
      t.created_at || now,
      t.updated_at || now,
      t.closed_at || null
    )
    db.prepare(
      `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
       VALUES (?, ?, ?, ?)`
    ).run(repoId, t.task_id, instanceId, now)
  }
}

/** Seed each repository from its local profile, falling back to legacy for existing repositories. */
export function seedRepoGateModes(db) {
  const now = utcNow()
  const repos = db.prepare('SELECT repo_id, slug FROM repositories').all()
  for (const r of repos) {
    if (db.prepare('SELECT 1 FROM repo_gate_modes WHERE repo_id=?').get(r.repo_id)) continue
    const mode = getRepoPlatformProfile(r.slug)?.gateMode || 'observe'
    db.prepare('INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)').run(r.repo_id, mode, now)
  }
}

export function ensureRepository(db, slug, createdByPrincipalId, now = utcNow()) {
  // sqlite：prepare().get() 同步；postgres：返回 Promise（§7 await 化）。
  // 迁移路径（initDB）保持同步语义，运行时调用方（bootstrap 等）await 即可。
  const result = db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug)
  const finish = async (row) => {
    if (row) return row.repo_id
    const repoId = uuidv7()
    await db.prepare(
      `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'refs/heads/stage', 1, ?, ?)`
    ).run(repoId, slug, slug, now, now)
    return repoId
  }
  if (result && typeof result.then === 'function') return result.then(finish)
  // sqlite 同步结果也走同一段逻辑，但不引入微任务（迁移路径依赖同步返回）
  if (result) return result.repo_id
  const repoId = uuidv7()
  db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'refs/heads/stage', 1, ?, ?)`
  ).run(repoId, slug, slug, now, now)
  return repoId
}

/**
 * 接入新仓即开独立租户：repositories + gate_mode。
 * harness_start / 运维脚本共用；已存在则幂等返回 repo_id。
 * 新仓默认 gate=observe（可云端测但不强制拦 advance），接入后可在项目管理改档。
 */
export async function ensureTenantRepo(db, slug, { now = utcNow() } = {}) {
  // 方案 §7：postgres 方言下本函数在 MCP 运行路径（harness_start/task_state open）被 await。
  // 本文件其余部分是历史迁移路径（保持同步、postgres 方言第一行 return），绝不参与 await 化。
  if (!slug || typeof slug !== 'string') throw new Error('INVALID_REPO_SLUG')
  const clean = String(slug).trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(clean) || clean.length > 63) {
    throw new Error(`INVALID_REPO_SLUG: ${slug}`)
  }
  let systemId
  try {
    const sys = await db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(SYSTEM_SUBJECT)
    if (sys) systemId = sys.principal_id
  } catch { /* principals 未建 */ }
  if (!systemId) {
    systemId = uuidv7()
    try {
      await db.prepare(
        `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`
      ).run(systemId, SYSTEM_SUBJECT, SYSTEM_SUBJECT, now, now)
    } catch { /* 并发插入时再查一次 */
      const again = await db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(SYSTEM_SUBJECT)
      systemId = again?.principal_id
    }
  }
  const existed = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(clean)
  let repoId
  if (existed) {
    repoId = existed.repo_id
  } else {
    repoId = uuidv7()
    await db.prepare(
      `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'refs/heads/stage', 1, ?, ?)`
    ).run(repoId, clean, clean, now, now)
  }
  const hasMode = await db.prepare('SELECT 1 FROM repo_gate_modes WHERE repo_id=?').get(repoId)
  if (!hasMode) {
    // 新租户默认 observe：允许云端测试、不强制拦 advance；档位可在项目管理调整
    await db.prepare(
      'INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)'
    ).run(repoId, 'observe', now)
  }
  return { repoId, slug: clean, created: !existed }
}

function ensureAuthorPrincipal(db, subject, now) {
  const row = db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(subject)
  if (row) return row.principal_id
  const id = uuidv7()
  try {
    db.prepare(
      `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`
    ).run(id, subject, subject, now, now)
    return id
  } catch {
    return db.prepare('SELECT principal_id FROM principals WHERE subject=?').get(subject).principal_id
  }
}

export { SCHEMA_CHECKSUM, SCHEMA_V2_CHECKSUM, SCHEMA_V3_CHECKSUM, SCHEMA_V4_CHECKSUM, SCHEMA_V5_CHECKSUM, SCHEMA_V6_CHECKSUM, SCHEMA_V7_CHECKSUM, SCHEMA_V8_CHECKSUM, SCHEMA_V12_CHECKSUM, SYSTEM_SUBJECT }
