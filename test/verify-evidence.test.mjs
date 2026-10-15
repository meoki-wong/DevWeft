/**
 * verify-evidence：时效 / 跨任务 / 跨仓
 */
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import {
  validateVerifyEvidence,
  acceptAsGateEvidence,
  isStrictFreshness,
} from '../testing/verify-evidence.js'
import { setPlatformSetting } from '../harness/gate-policy.js'

async function memdb() {
  const db = new Database(':memory:')
  await db.exec(`
    CREATE TABLE platform_settings (
      key TEXT PRIMARY KEY, value TEXT, value_json TEXT, updated_at TEXT NOT NULL
    );
  `)
  return db
}

const baseRow = {
  repo: 'r1',
  task_id: 'T1',
  pass: 1,
  created_at: '2026-09-17T10:00:00.000Z',
  workspace_head: 'abc',
}

describe('verify-evidence', () => {
  it('valid pass for same task after anchor → ok', () => {
    const v = validateVerifyEvidence(baseRow, {
      repo: 'r1', taskId: 'T1', anchorAt: '2026-09-17T09:00:00.000Z', workspaceHead: 'abc',
    })
    expect(v.ok).toBe(true)
  })

  it('stale before anchor → stale_before_anchor', () => {
    const v = validateVerifyEvidence(baseRow, {
      repo: 'r1', taskId: 'T1', anchorAt: '2026-09-17T11:00:00.000Z',
    })
    expect(v.ok).toBe(false)
    expect(v.reasons).toContain('stale_before_anchor')
  })

  it('other task borrow → cross_task_borrow', () => {
    const v = validateVerifyEvidence({ ...baseRow, task_id: 'T-OTHER' }, {
      repo: 'r1', taskId: 'T1',
    })
    expect(v.reasons).toContain('cross_task_borrow')
  })

  it('cross repo → cross_repo_borrow', () => {
    const v = validateVerifyEvidence({ ...baseRow, repo: 'other' }, {
      repo: 'r1', taskId: 'T1',
    })
    expect(v.reasons).toContain('cross_repo_borrow')
  })

  it('workspace head mismatch', () => {
    const v = validateVerifyEvidence(baseRow, {
      repo: 'r1', taskId: 'T1', workspaceHead: 'def',
    })
    expect(v.reasons).toContain('workspace_head_mismatch')
  })

  it('default warn: acceptAsGateEvidence ok even if stale', async () => {
    const db = await memdb()
    expect(await isStrictFreshness(db)).toBe(false)
    const r = await acceptAsGateEvidence(db, { ...baseRow, created_at: '2020-01-01T00:00:00.000Z' }, {
      repo: 'r1', taskId: 'T1', anchorAt: '2026-09-17T00:00:00.000Z',
    })
    expect(r.ok).toBe(true)
    expect(r.reasons.length).toBeGreaterThan(0)
    db.close()
  })

  it('strict freshness blocks stale', async () => {
    const db = await memdb()
    await setPlatformSetting(db, 'verify_strict_freshness', { enabled: true })
    expect(await isStrictFreshness(db)).toBe(true)
    const r = await acceptAsGateEvidence(db, { ...baseRow, created_at: '2020-01-01T00:00:00.000Z' }, {
      repo: 'r1', taskId: 'T1', anchorAt: '2026-09-17T00:00:00.000Z',
    })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('stale_before_anchor')
    db.close()
  })
})
