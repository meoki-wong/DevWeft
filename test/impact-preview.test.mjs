/**
 * 改动影响面预检（2026-09-26）：与 scoped 注入同款 pages∩改动 匹配，反向提示受波及的 active 卷
 */
import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { memdb } from './helpers/memdb.mjs'
import { previewImpactedSpecs } from '../testing/test-specs.js'

async function seedActiveSpec(db, repoId, featureKey, { pages = null, scope = 'task', lastResult = 'passed', failStreak = 0 } = {}) {
  await db.prepare(
    `INSERT INTO test_specs(spec_id, repo_id, feature_key, feature_title, author, spec_type, entry,
       blob_sha256, version, review_status, mutation_verified, pages_json, scope, last_result, fail_streak,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, 'test', 'e2e', ?, ?, 1, 'active', 0, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), repoId, featureKey, featureKey, `${featureKey}.spec.mjs`, 'a'.repeat(64),
    pages ? JSON.stringify(pages) : null, scope, lastResult, failStreak,
    new Date().toISOString(), new Date().toISOString())
}

describe('previewImpactedSpecs', () => {
  it('pages 与改动文件相交的卷被命中，未声明 pages 的卷不参与', async () => {
    const { db, repoId, close } = await memdb()
    await seedActiveSpec(db, repoId, 'fk-store-page', { pages: ['admin'] })
    await seedActiveSpec(db, repoId, 'fk-other-page', { pages: ['sign'] })
    await seedActiveSpec(db, repoId, 'fk-no-pages', { pages: null })
    const rows = await previewImpactedSpecs({ repoId, changedFiles: ['src/pages/admin/index.vue'], conn: db })
    const keys = rows.map((r) => r.featureKey)
    expect(keys).toContain('fk-store-page')
    expect(keys).not.toContain('fk-other-page')
    expect(keys).not.toContain('fk-no-pages')
    close()
  })

  it('regression 范围卷全量常跑 → 一并列出并标注', async () => {
    const { db, repoId, close } = await memdb()
    await seedActiveSpec(db, repoId, 'fk-regression', { scope: 'regression', lastResult: 'failed', failStreak: 2 })
    const rows = await previewImpactedSpecs({ repoId, changedFiles: ['src/anything.js'], conn: db })
    const reg = rows.find((r) => r.featureKey === 'fk-regression')
    expect(reg.scope).toBe('regression')
    expect(reg.failStreak).toBe(2)
    close()
  })

  it('无文件/未知仓 → 空数组', async () => {
    const { db, repoId, close } = await memdb()
    expect(await previewImpactedSpecs({ repoId, changedFiles: [], conn: db })).toEqual([])
    expect(await previewImpactedSpecs({ repoId: 'nope', changedFiles: ['a.js'] })).toEqual([])
    close()
  })
})
