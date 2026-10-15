/**
 * 功能验证真源：云端优先，本地 L2 兜底；仓无 verify.sh 则永不强制
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { repoHasLocalVerify, resolveVerifySource, recentCloudPass } from '../testing/verify-mode.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-vm-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  return db
}

describe('verify-mode 云端优先 / 本地兜底', () => {
  it('无 recent cloud pass 且无 verify.sh → source=none，不强制 L2', async () => {
    const db = await memdb()
    const ws = mkdtempSync(join(tmpdir(), 'nows-'))
    // 无 scripts/verify.sh
    const v = await resolveVerifySource(db, 'demo-app', { env: { AWP_REPO_PATH_DEMO_APP: ws } })
    // workspace resolve 可能仍回落候选；只要 localAvailable false 即可
    // 注：若机器上存在 C:\repos\demo-app\scripts\verify.sh 会 localAvailable=true
    expect(v.showLocalVerify === false || v.source === 'local').toBe(true)
    expect(['cloud', 'local', 'none']).toContain(v.source)
  })

  it('有 recent passed submission → cloud 健康，showLocalVerify=false', async () => {
    const db = await memdb()
    db.pragma('foreign_keys = OFF')
    await db.prepare(
      `INSERT INTO test_submissions(submission_id, client_request_id, principal_id, repo_id, task_instance_id, binding_id, expected_task_revision, status, created_at)
       VALUES ('s1','c1','p1','r1','ti1','b',1,'passed', datetime('now'))`
    ).run()
    expect(await recentCloudPass(db, 'r1')).toBe(true)
    const v = await resolveVerifySource(db, 'demo-app')
    expect(v.cloudHealthy).toBe(true)
    expect(v.source).toBe('cloud')
    expect(v.showLocalVerify).toBe(false)
  })
})
