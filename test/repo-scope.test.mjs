/**
 * repo-scope.test.mjs — 连接级 repo 归一（静默接入防串仓）
 *
 * ?repo= / x-awp-repo 是新项目静默接入的核心：绑定后所有工具调用免传 repo。
 * 归一规则错一处 = 任务静默串到默认仓 demo-app，所以这里锁死行为。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRepoSlug } from '../harness/author.js'

describe('normalizeRepoSlug（连接级 repo）', () => {
  it('未提供：不绑定也不报错', () => {
    expect(normalizeRepoSlug(null)).toEqual({ provided: false, ok: true, slug: null })
    expect(normalizeRepoSlug(undefined)).toEqual({ provided: false, ok: true, slug: null })
    expect(normalizeRepoSlug('')).toEqual({ provided: false, ok: true, slug: null })
  })

  it('合法 slug：统一小写返回', () => {
    expect(normalizeRepoSlug('demo-app')).toEqual({ provided: true, ok: true, slug: 'demo-app' })
    // 大小写漂移自动归一，不产生第二个命名空间
    expect(normalizeRepoSlug(' Example-Admin ').slug).toBe('example-admin')
    expect(normalizeRepoSlug('shared').ok).toBe(true)
    expect(normalizeRepoSlug('repo.v2_beta').ok).toBe(true)
  })

  it('非法输入：明确报错而非静默落到默认仓', () => {
    const bad = ['bad slug', 'bad/slug', '项目x', '-abc', 'a'.repeat(64)]
    for (const b of bad) {
      const r = normalizeRepoSlug(b)
      expect(r.ok, `应为非法：${b}`).toBe(false)
      expect(r.reason, `应有原因：${b}`).toBeTruthy()
    }
  })

  it('重复参数（express 给数组）也会被拦下', () => {
    const r = normalizeRepoSlug(['a', 'b'])
    expect(r.ok).toBe(false)
  })
})
