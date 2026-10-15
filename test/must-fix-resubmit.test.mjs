/**
 * mustFix + 重提闸门：product 未修禁止 awp_test_run
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
  buildMustFixList,
  checkReadyToResubmit,
  extractFilesFromDetail,
  classifyRunChecks,
  buildRemediationPacket,
  ensureGateLoop,
  updateGateLoop,
} from '../harness/loop.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-mf-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  await db.prepare(
    `INSERT INTO repositories(repo_id, slug, display_name, default_target_ref, created_at, updated_at)
     VALUES ('r1', 'demo-app', 'project', 'refs/heads/stage', 't', 't')`
  ).run()
  await db.prepare(
    `INSERT INTO principals(principal_id, subject, display_name, status, created_at, updated_at)
     VALUES ('p1', 'alice', 'a', 'active', 't', 't')`
  ).run()
  return db
}

describe('extractFilesFromDetail', () => {
  it('从 eslint Windows 路径抽出 src/...', () => {
    const files = extractFilesFromDetail(
      'C:\\awp-run\\workspace\\src\\components\\selectStore\\ChooseStoreList.vue | 9:7 error self-closing'
    )
    expect(files).toContain('src/components/selectStore/ChooseStoreList.vue')
  })
})

describe('buildMustFixList', () => {
  it('mixed 时 product 与 suite 都在清单，product 优先', () => {
    const mf = buildMustFixList({
      overall: 'mixed',
      byCheck: [
        {
          caseKey: 'test:static/eslint',
          class: 'product',
          detail: 'src/a.vue error prettier',
        },
        {
          caseKey: 'test:spec/flight-x',
          class: 'suite',
          featureKey: 'flight-x',
          detail: 'timeout',
        },
      ],
    })
    expect(mf.requiresProductFix).toBe(true)
    expect(mf.requiresSuiteFix).toBe(true)
    expect(mf.all[0].class).toBe('product')
    expect(mf.summary).toMatch(/mixed/)
  })
})

describe('checkReadyToResubmit', () => {
  it('无失败历史时允许重提', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    const r = await checkReadyToResubmit(db, { repoSlug: 'demo-app', taskId: 'T1' })
    expect(r.ok).toBe(true)
  })

  it('await_distill 未清禁止重提', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { awaitDistill: 1, lastTerminal: 'failed', lastClass: 'product' },
    })
    // 无 formal group 时不会重建 classification，仅靠 awaitDistill 拦
    const r = await checkReadyToResubmit(db, { repoSlug: 'demo-app', taskId: 'T1', productFixed: true })
    // awaitDistill + 无 classification → 仍拦 await_distill
    expect(r.ok).toBe(false)
    expect(r.code).toBe('AWAIT_DISTILL')
  })

  it('needs_human 禁止', async () => {
    const db = await memdb()
    await ensureGateLoop(db, { repo: 'demo-app', taskId: 'T1' })
    await updateGateLoop(db, {
      repo: 'demo-app',
      taskId: 'T1',
      patch: { needsHuman: 1, iteration: 5 },
    })
    const r = await checkReadyToResubmit(db, { repoSlug: 'demo-app', taskId: 'T1' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NEEDS_HUMAN')
  })
})

describe('packet mustFix', () => {
  it('product 失败 packet 含 mustFix 且 actions 以 fix_product 优先', () => {
    const loop = {
      state: 'remediation_product',
      iteration: 1,
      maxIterations: 5,
      needsHuman: false,
      awaitDistill: true,
    }
    const p = buildRemediationPacket({
      repo: 'demo-app',
      taskId: 'T1',
      status: 'failed',
      loop,
      classification: {
        overall: 'product',
        byCheck: [
          {
            caseKey: 'test:static/eslint',
            class: 'product',
            detail: 'src/components/selectStore/ChooseStoreList.vue error',
            hints: [],
          },
        ],
      },
    })
    expect(p.mustFix.requiresProductFix).toBe(true)
    expect(p.actions[0].tool).toBe('fix_product')
    expect(p.message).toMatch(/product|mustFix/)
  })
})

describe('classify + mustFix eslint 为 product', () => {
  it('eslint failed → product', () => {
    const c = classifyRunChecks([
      { caseKey: 'test:static/eslint', status: 'failed', detail: 'src/x.vue prettier' },
      { caseKey: 'test:spec/y', status: 'failed', detail: 'timeout waitForSelector' },
    ])
    expect(c.overall).toBe('mixed')
    const mf = buildMustFixList(c)
    expect(mf.requiresProductFix).toBe(true)
    expect(mf.requiresSuiteFix).toBe(true)
  })
})
