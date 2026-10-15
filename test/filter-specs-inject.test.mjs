import { describe, expect, it } from 'vitest'
import { filterSpecsForSpecInject } from '../testing/test-specs.js'

describe('filterSpecsForSpecInject 考卷隔离', () => {
  const specs = [
    { feature_key: 'reg-a', scope: 'regression', pages_json: null },
    { feature_key: 'act-a', scope: 'task', pages_json: '["views/activity"]' },
    { feature_key: 'earn-b', scope: 'task', pages_json: '["views/storeEarningsReport"]' },
    { feature_key: 'no-pages', scope: 'task', pages_json: null },
  ]

  it('无 pages 的 task 卷在 scoped 下不再注入（防串任务）', () => {
    const out = filterSpecsForSpecInject(specs, {
      changedFiles: ['src/views/activity/index.vue'],
    })
    const keys = out.map((s) => s.feature_key)
    expect(keys).toContain('reg-a')
    expect(keys).toContain('act-a')
    expect(keys).not.toContain('earn-b')
    expect(keys).not.toContain('no-pages')
  })

  it('无 pages 的 regression 卷仍注入', () => {
    const out = filterSpecsForSpecInject(
      [{ feature_key: 'reg-b', scope: 'regression', pages_json: null }],
      { changedFiles: ['src/views/other/x.vue'] }
    )
    expect(out.map((s) => s.feature_key)).toEqual(['reg-b'])
  })

  it('injectAllE2e=on 关闭过滤', () => {
    const out = filterSpecsForSpecInject(specs, {
      changedFiles: ['src/views/activity/index.vue'],
      injectAllE2e: true,
    })
    expect(out).toHaveLength(4)
  })

  it('mode=all 全量', () => {
    const out = filterSpecsForSpecInject(specs, {
      changedFiles: ['src/views/activity/index.vue'],
      mode: 'all',
    })
    expect(out).toHaveLength(4)
  })

  it('mode=regression_only 只跑回归', () => {
    const out = filterSpecsForSpecInject(specs, {
      changedFiles: ['src/views/activity/index.vue'],
      mode: 'regression_only',
    })
    expect(out.map((s) => s.feature_key)).toEqual(['reg-a'])
  })

  it('无改动清单：有 pages 与 regression 注入；无 pages task 卷仍跳过', () => {
    const out = filterSpecsForSpecInject(specs, { changedFiles: null })
    const keys = out.map((s) => s.feature_key)
    expect(keys).toContain('reg-a')
    expect(keys).toContain('act-a')
    expect(keys).toContain('earn-b')
    expect(keys).not.toContain('no-pages')
  })
})
