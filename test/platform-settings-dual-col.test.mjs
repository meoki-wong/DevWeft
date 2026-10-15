/**
 * platform_settings 双列兼容：value / value_json 互不阻断
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
  ensurePlatformSettingsTable,
  getPlatformSetting,
  setPlatformSetting,
} from '../harness/gate-policy.js'
import { setE2eInjectMode, getE2eInjectMode } from '../testing/test-specs.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-ps-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

describe('platform_settings 双列', () => {
  it('迁移后两列都存在；value-only 行可被 SELECT value 读', async () => {
    const db = await memdb()
    const cols = (await db.prepare(`PRAGMA table_info(platform_settings)`).all()).map((c) => c.name)
    expect(cols).toContain('value')
    expect(cols).toContain('value_json')
    await db.prepare(
      `INSERT INTO platform_settings(key, value, updated_at) VALUES ('legacy_only', 'on', 't')`
    ).run()
    await ensurePlatformSettingsTable(db)
    const row = await db.prepare(`SELECT value, value_json FROM platform_settings WHERE key='legacy_only'`).get()
    expect(row.value).toBe('on')
    expect(row.value_json).toBeTruthy()
    expect(await getPlatformSetting(db, 'legacy_only')).toBe('on')
  })

  it('setPlatformSetting 双写；看板式 SELECT value 可读', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'dep_cache', 'on')
    const row = await db.prepare(`SELECT value, value_json FROM platform_settings WHERE key='dep_cache'`).get()
    expect(row.value).toBe('on')
    expect(JSON.parse(row.value_json)).toBe('on')
    const simple = (await db.prepare(`SELECT value FROM platform_settings WHERE key='dep_cache'`).get())?.value
    expect(simple).toBe('on')
  })

  it('e2e inject mode 写入后可读回（方案第 5 节：新写只落 repo_runtime_settings）', async () => {
    const db = await memdb()
    await db.prepare(
      `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
       VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
    ).run()
    const out = await setE2eInjectMode(db, 'demo-app', 'all')
    expect(out.mode).toBe('all')
    expect(await getE2eInjectMode(db, 'demo-app')).toBe('all')
    // 旧键不再写入 platform_settings
    const raw = await db
      .prepare(`SELECT value FROM platform_settings WHERE key='e2e_inject_mode:demo-app'`)
      .get()
    expect(raw).toBeFalsy()
    const row = await db
      .prepare(`SELECT value_json FROM repo_runtime_settings WHERE repo_id='r1' AND key='e2e_inject_mode'`)
      .get()
    expect(JSON.parse(row.value_json)).toBe('all')
  })

  it('结构化对象仍走 value_json', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'dynamic_gate', { enabled: true })
    expect(await getPlatformSetting(db, 'dynamic_gate')).toEqual({ enabled: true })
  })
})
