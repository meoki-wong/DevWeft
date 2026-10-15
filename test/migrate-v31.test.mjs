/**
 * migrate-v31.test.mjs — test_specs 基线后结构验证（方案 §13.3）
 *
 * 原测试验证 v31 历史迁移（表重建）。§13.3 要求改为针对基线后的结构，
 * 不再执行 SQLite 历史脚本。基线已含最终 test_specs 形状：
 *   - spec_type CHECK 含 'api'
 *   - execution_config_json 列存在
 *   - v18/v19 追加列（side/acceptance_refs_json/pages_json/mutation_verified/reviewed_by 等）齐全
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 基线后 test_specs 形状（与 sql/postgres/baseline.sql 对齐，仅 sqlite 语法） */
const BASELINE_TEST_SPECS_DDL = `
  CREATE TABLE IF NOT EXISTS repositories (
    repo_id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT,
    default_target_ref TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS test_specs (
    spec_id         TEXT PRIMARY KEY,
    repo_id         TEXT NOT NULL REFERENCES repositories(repo_id),
    feature_key     TEXT NOT NULL,
    feature_title   TEXT,
    demand_ref      TEXT,
    author          TEXT NOT NULL,
    spec_type       TEXT NOT NULL DEFAULT 'e2e' CHECK(spec_type IN ('smoke','e2e','unit','api')),
    entry           TEXT NOT NULL,
    blob_sha256     TEXT NOT NULL,
    code_commit_oid TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    review_status   TEXT NOT NULL DEFAULT 'draft'
      CHECK(review_status IN ('draft','reviewed','active','archived','orphan-candidate')),
    last_result     TEXT,
    fail_streak     INTEGER NOT NULL DEFAULT 0,
    side            TEXT,
    acceptance_refs_json TEXT,
    pages_json      TEXT,
    mutation_verified INTEGER NOT NULL DEFAULT 0,
    reviewed_by     TEXT,
    reviewed_at     TEXT,
    review_decision TEXT,
    review_notes    TEXT,
    scope           TEXT DEFAULT 'task',
    execution_config_json TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
`

function baselineDb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-v31-')), 't.db'))
  db.pragma('foreign_keys = ON')
  db.exec(BASELINE_TEST_SPECS_DDL)
  db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, enabled, created_at, updated_at)
     VALUES ('repo-1', 'v31-repo', 'v31-repo', 'refs/heads/stage', 1, 't', 't')`
  ).run()
  return db
}

async function countSpecs(db) {
  return (await db.prepare('SELECT count(*) AS n FROM test_specs').get()).n
}

describe('test_specs 基线后结构（§13.3，不执行历史迁移）', () => {
  it('api 类型可用、execution_config_json 存在', async () => {
    const db = baselineDb()
    const ddl = (await db.prepare(`SELECT sql FROM sqlite_master WHERE name='test_specs'`).get()).sql
    expect(ddl).toContain("'api'")
    expect(ddl).toContain('execution_config_json')
    // api 类型可插入
    await db.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, author, spec_type, entry, blob_sha256, created_at, updated_at)
       VALUES ('sp-api', 'repo-1', 'fk-api', 't', 'api', 'fk-api.api.spec.mjs', ?, 't', 't')`
    ).run('a'.repeat(64))
    expect((await db.prepare(`SELECT spec_type FROM test_specs WHERE spec_id='sp-api'`).get()).spec_type).toBe('api')
    db.close()
  })

  it('v18/v19 追加列齐全，插入后可读回', async () => {
    const db = baselineDb()
    await db.prepare(
      `INSERT INTO test_specs(spec_id, repo_id, feature_key, author, spec_type, entry, blob_sha256, version,
         review_status, mutation_verified, acceptance_refs_json, side, scope, created_at, updated_at, pages_json, reviewed_by)
       VALUES ('sp-1', 'repo-1', 'fk-a', 'ai', 'e2e', 'fk-a.spec.mjs', ?, 1, 'active', 1, '["AC-1"]', 'web', 'task', 't', 't', '["views/x"]', 'auto')`
    ).run('b'.repeat(64))
    const row = await db.prepare(`SELECT * FROM test_specs WHERE spec_id='sp-1'`).get()
    expect(row.feature_key).toBe('fk-a')
    expect(row.version).toBe(1)
    expect(row.mutation_verified).toBe(1)
    expect(row.acceptance_refs_json).toBe('["AC-1"]')
    expect(row.side).toBe('web')
    expect(row.scope).toBe('task')
    expect(row.reviewed_by).toBe('auto')
    expect(row.pages_json).toBe('["views/x"]')
    db.close()
  })

  it('spec_type CHECK 含 api，拒绝非法值', async () => {
    const db = baselineDb()
    expect(() =>
      db.prepare(
        `INSERT INTO test_specs(spec_id, repo_id, feature_key, author, spec_type, entry, blob_sha256, created_at, updated_at)
         VALUES ('sp-bad', 'repo-1', 'fk-bad', 't', 'invalid-type', 'x.spec.mjs', ?, 't', 't')`
      ).run('c'.repeat(64))
    ).toThrow()
    db.close()
  })
})
