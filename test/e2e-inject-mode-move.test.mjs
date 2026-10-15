/**
 * e2e-inject-mode-move.test.mjs — 方案第 5 节：e2e_inject_mode 迁入 repo_runtime_settings
 *
 * §9.3：
 *   - 只存在旧键时第一次读取会写入新表
 *   - 之后删除旧键，结果不变
 *   - 非法 mode 仍抛 INVALID_E2E_INJECT_MODE
 *   - 新写不再落 platform_settings 的 e2e_inject_mode:*
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it, beforeEach } from 'vitest'
import { runTestingMigrations, ensureRepository } from '../testing/migrate.js'
import { getE2eInjectMode, setE2eInjectMode } from '../testing/test-specs.js'

const SLUG = 'e2e-move-repo'

let db
let repoId

beforeEach(async () => {
  db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-e2e-move-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  repoId = await ensureRepository(db, SLUG, null)
})

const seedLegacyKey = async (slug, mode) => {
  await db.prepare(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(`e2e_inject_mode:${slug}`, mode, new Date().toISOString())
}

describe('e2e_inject_mode 迁移（方案 §9）', () => {
  it('只存在旧键时：第一次读取返回旧值并写入新表', async () => {
    await seedLegacyKey(SLUG, 'regression_only')
    expect(await getE2eInjectMode(db, SLUG)).toBe('regression_only')
    const row = await db.prepare(
      `SELECT s.value_json FROM repo_runtime_settings s WHERE s.repo_id = ? AND s.key = 'e2e_inject_mode'`
    ).get(repoId)
    expect(row).toBeTruthy()
    expect(JSON.parse(row.value_json)).toBe('regression_only')
  })

  it('删除旧键后结果不变（读取走新表）', async () => {
    await seedLegacyKey(SLUG, 'all')
    expect(await getE2eInjectMode(db, SLUG)).toBe('all')
    await db.prepare(`DELETE FROM platform_settings WHERE key = ?`).run(`e2e_inject_mode:${SLUG}`)
    expect(await getE2eInjectMode(db, SLUG)).toBe('all')
  })

  it('setE2eInjectMode 写新表，不再写 platform_settings 的 e2e_inject_mode:*', async () => {
    await setE2eInjectMode(db, SLUG, 'scoped')
    const legacy = await db.prepare(`SELECT value FROM platform_settings WHERE key = ?`).get(`e2e_inject_mode:${SLUG}`)
    expect(legacy).toBeFalsy()
    const row = await db.prepare(
      `SELECT value_json FROM repo_runtime_settings WHERE repo_id = ? AND key = 'e2e_inject_mode'`
    ).get(repoId)
    expect(JSON.parse(row.value_json)).toBe('scoped')
    expect(await getE2eInjectMode(db, SLUG)).toBe('scoped')
  })

  it('非法 mode 仍抛 INVALID_E2E_INJECT_MODE', async () => {
    await expect(setE2eInjectMode(db, SLUG, 'everything')).rejects.toThrow(/INVALID_E2E_INJECT_MODE/)
  })

  it('未登记 slug 拒绝写入（新表以 repo_id 为键）', async () => {
    await expect(setE2eInjectMode(db, 'never-registered', 'all')).rejects.toThrow(/REPO_NOT_FOUND/)
  })

  it('都没有时返回 scoped；平台键 inject_all_e2e=on 仍强制 all', async () => {
    expect(await getE2eInjectMode(db, SLUG)).toBe('scoped')
    await db.prepare(
      `INSERT INTO platform_settings(key, value, updated_at) VALUES ('inject_all_e2e', 'on', ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(new Date().toISOString())
    expect(await getE2eInjectMode(db, SLUG)).toBe('all')
  })
})
