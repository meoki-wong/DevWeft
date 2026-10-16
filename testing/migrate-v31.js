/**
 * testing/migrate-v31.js — v31：test_specs 受控表重建
 * （spec_type 扩展 api 类型 + execution_config_json 列。SQLite CHECK 无法 ALTER。）
 *
 * 步骤：旧表改名 → 建 v31 新表 → 动态列交集复制 → 删旧表 → 补索引 → 换名。
 * 动态列交集是关键：不能只按 v9 旧列重建而丢失 v10/v18/v19 追加的
 * side / acceptance_refs_json / pages_json / mutation_verified / reviewed_by 等列。
 * 同事务（applyVersionedMigration）+ 幂等门控（CHECK 已含 'api' 则跳过）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_V31_SQL = readFileSync(path.join(dir, 'schema-v31.sql'), 'utf8')

export function getV31MigrationChecksum() {
  return createHash('sha256').update(SCHEMA_V31_SQL).digest('hex')
}

export function applyV31TestSpecsApiType(db, { applyVersionedMigration }) {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='test_specs'`).get()?.sql || ''
  if (ddl.includes("'api'")) return
  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='test_specs'`).get()
  if (!hasTable) {
    // 空库：直接建最终形状
    db.exec(SCHEMA_V31_SQL.replace(/test_specs_v31_new/g, 'test_specs'))
    return
  }
  applyVersionedMigration(db, {
    version: 31,
    name: 'test_specs_api_type_rebuild',
    checksum: getV31MigrationChecksum(),
    apply: (db) => {
      db.exec(`ALTER TABLE test_specs RENAME TO test_specs_v31_old`)
      db.exec(SCHEMA_V31_SQL)
      const oldCols = db.prepare('PRAGMA table_info(test_specs_v31_old)').all().map((c) => c.name)
      const newCols = db
        .prepare('PRAGMA table_info(test_specs_v31_new)').all()
        .map((c) => c.name)
        .filter((c) => c !== 'execution_config_json')
      const shared = newCols.filter((c) => oldCols.includes(c))
      db.exec(
        `INSERT INTO test_specs_v31_new(${shared.join(', ')}, execution_config_json)
         SELECT ${shared.join(', ')}, NULL FROM test_specs_v31_old`
      )
      db.exec('DROP TABLE test_specs_v31_old')
      // 旧表占用同名索引时 v31 的 IF NOT EXISTS 建索引被跳过；旧表已删，此刻补建
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_test_specs_feature_version ON test_specs_v31_new(repo_id, feature_key, version);
CREATE INDEX IF NOT EXISTS idx_test_specs_repo_feature ON test_specs_v31_new(repo_id, feature_key, review_status);
CREATE INDEX IF NOT EXISTS idx_test_specs_demand ON test_specs_v31_new(repo_id, demand_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_specs_author ON test_specs_v31_new(repo_id, author, updated_at DESC);`)
      db.exec('ALTER TABLE test_specs_v31_new RENAME TO test_specs')
    },
  })
}

