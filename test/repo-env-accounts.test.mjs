/**
 * repo-env-accounts.test.mjs — 项目环境登录账号（dev/qa）
 *
 * 安全模型锁定：密码明文只落 secret-broker 独立库；team.db 行内永不出现明文。
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
  clearRepoEnvAccount,
  getRepoEnvAccountSecret,
  listRepoEnvAccounts,
  setRepoEnvAccount,
} from '../testing/accounts.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-acct-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('project', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  return { db, broker: join(mkdtempSync(join(tmpdir(), 'awp-acct-broker-')), 'broker.db') }
}

describe('repo_env_accounts（项目环境账号，密码只进 secret-broker）', () => {
  it('设置后：list 有 username 无密码；team.db 行内不含明文；secret 可取回', async () => {
    const { db, broker } = await memdb()
    await setRepoEnvAccount(db, {
      repoIdOrSlug: 'demo-app', env: 'qa', username: 'tester01', password: 'P@ssw0rd-秘密', brokerDbPath: broker,
    })
    const listed = await listRepoEnvAccounts(db, 'demo-app')
    expect(listed.qa).toEqual({ configured: true, username: 'tester01', updated_at: expect.any(String) })
    expect(listed.dev.configured).toBe(false)
    // team.db 行内不落明文
    const raw = JSON.stringify(await db.prepare('SELECT * FROM repo_env_accounts').all())
    expect(raw).not.toContain('P@ssw0rd')
    // lane 侧可取回明文
    const sec = await getRepoEnvAccountSecret(db, 'demo-app', 'qa', broker)
    expect(sec).toEqual({ username: 'tester01', password: 'P@ssw0rd-秘密' })
  })

  it('覆盖更新与清除；清除后 secret 不再可取', async () => {
    const { db, broker } = await memdb()
    const args = { repoIdOrSlug: 'demo-app', env: 'qa', brokerDbPath: broker }
    await setRepoEnvAccount(db, { ...args, username: 'u1', password: 'old' })
    await setRepoEnvAccount(db, { ...args, username: 'u2', password: 'new' })
    expect(await getRepoEnvAccountSecret(db, 'demo-app', 'qa', broker)).toEqual({ username: 'u2', password: 'new' })
    const out = await clearRepoEnvAccount(db, { repoIdOrSlug: 'demo-app', env: 'qa' })
    expect(out.configured).toBe(false)
    expect((await listRepoEnvAccounts(db, 'demo-app')).qa.configured).toBe(false)
    expect(await getRepoEnvAccountSecret(db, 'demo-app', 'qa', broker)).toBeNull()
  })

  it('slug 与 repo_id 两种寻址等价', async () => {
    const { db, broker } = await memdb()
    await setRepoEnvAccount(db, { repoIdOrSlug: 'project', env: 'dev', username: 'byId', password: 'x', brokerDbPath: broker })
    expect((await listRepoEnvAccounts(db, 'demo-app')).dev.username).toBe('byId')
  })

  it('非法 env / 未知仓 / 缺密码 明确报错', async () => {
    const { db, broker } = await memdb()
    await expect(setRepoEnvAccount(db, { repoIdOrSlug: 'project', env: 'prod', username: 'u', password: 'p', brokerDbPath: broker })).rejects.toThrow(/INVALID_ENV/)
    await expect(setRepoEnvAccount(db, { repoIdOrSlug: 'no-such', env: 'qa', username: 'u', password: 'p', brokerDbPath: broker })).rejects.toThrow(/UNRESOLVED_REPO/)
    await expect(setRepoEnvAccount(db, { repoIdOrSlug: 'project', env: 'qa', username: 'u', password: '', brokerDbPath: broker })).rejects.toThrow(/INVALID_SCHEMA/)
  })
})
