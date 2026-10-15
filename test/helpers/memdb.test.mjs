/**
 * memdb.test.mjs — 共享测试工厂自验（阶段 0 地基）
 * 保证后续所有新测试依赖的工厂本身可用：独立库、随机 slug 不撞、前门 seed 可用。
 */
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../../db/sqlite-tx.js'
installSqliteTx(Database)
import { memdb, seedPrincipal, seedTaskWithAc } from './memdb.mjs'
import { evaluateAcCoverage } from '../../harness/testing-gate.js'

describe('memdb 工厂', () => {
  it('每次调用独立库 + 随机 slug（跨用例不撞唯一约束）', async () => {
    const a = await memdb()
    const b = await memdb()
    expect(a.slug).not.toBe(b.slug)
    expect(a.slug).toMatch(/^t-[0-9a-f-]{8}$/)
    // 两个库各自有 repositories 行，互不可见
    const count = (d) => d.db.prepare('SELECT count(*) n FROM repositories').get().n
    expect(count(a)).toBe(1)
    expect(count(b)).toBe(1)
    a.close()
    b.close()
  })

  it('显式 slug 生效（供需要固定 slug 的用例）', async () => {
    const m = await memdb({ slug: 'fixed-slug-repo' })
    expect(m.slug).toBe('fixed-slug-repo')
    expect(m.db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get('fixed-slug-repo').repo_id).toBe(m.repoId)
    m.close()
  })

  it('seedPrincipal 幂等：同 subject 返回同 id', async () => {
    const m = await memdb()
    const id1 = await seedPrincipal(m.db, 'alice')
    const id2 = await seedPrincipal(m.db, 'alice')
    expect(id1).toBe(id2)
    m.close()
  })

  it('seedTaskWithAc：AC + active 考卷可直接驱动门禁评估', async () => {
    const m = await memdb()
    const t = await seedTaskWithAc(m.db, { repoId: m.repoId, slug: m.slug, taskId: 'T-FACTORY-1' })
    const r = await evaluateAcCoverage(m.db, { repoSlug: m.slug, taskId: 'T-FACTORY-1' })
    expect(r.applicable).toBe(true)
    expect(r.mutationPending).toBe(true) // mv=0 → pending
    expect(r.total).toBe(1)
    expect(t.specId).toBeTruthy()
    m.close()
  })

  it('close 后库文件随目录清理', async () => {
    const m = await memdb()
    const db = m.db
    m.close()
    expect(db.open).toBe(false)
  })

  it('纯内存库用法不受影响（兼容旧用例模式）', async () => {
    const raw = new Database(':memory:')
    raw.exec('CREATE TABLE t (x TEXT)')
    expect((await raw.prepare('SELECT count(*) n FROM t').get()).n).toBe(0)
    raw.close()
  })
})
