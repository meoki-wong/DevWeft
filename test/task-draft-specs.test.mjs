import { describe, expect, it } from 'vitest'
import { filterSpecsForSpecInject } from '../testing/test-specs.js'

describe('任务草稿卷 filter', () => {
  it('本任务 draft 始终注入；他任务 draft 不注入；公共回归始终注入', () => {
    const specs = [
      { feature_key: 'my-draft', demand_ref: 'T-1', review_status: 'draft', scope: 'task', pages_json: null },
      { feature_key: 'other-draft', demand_ref: 'T-2', review_status: 'draft', scope: 'task', pages_json: null },
      { feature_key: 'reg', demand_ref: null, review_status: 'active', scope: 'regression', pages_json: null },
      { feature_key: 'act-page', demand_ref: null, review_status: 'active', scope: 'task', pages_json: '["views/a"]' },
    ]
    const out = filterSpecsForSpecInject(specs, {
      changedFiles: ['src/views/b/x.vue'],
      mode: 'scoped',
      taskId: 'T-1',
    })
    const keys = out.map((s) => s.feature_key)
    expect(keys).toContain('my-draft')
    expect(keys).toContain('reg')
    expect(keys).not.toContain('other-draft')
    expect(keys).not.toContain('act-page')
  })
})
