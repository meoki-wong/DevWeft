import { describe, it, expect } from 'vitest'
import { computeCoverageComplete } from '../testing/asset-lock.js'

const lockFunSpec = { specs: [
  { featureKey: 'flight-check-index-mount', specType: 'e2e', side: 'web' },
  { featureKey: 'flight-check-detail-fields', specType: 'e2e', side: 'web' },
] }

describe('computeCoverageComplete（证据完整性，仅 gate run）', () => {
  it('gate smoke：全部应跑考卷都产 check → 1', () => {
    const checks = [{ caseKey: 'test:spec/flight-check-index-mount' }, { caseKey: 'test:spec/flight-check-detail-fields' }]
    expect(computeCoverageComplete({ purpose: 'gate', lock: lockFunSpec, unit: 'smoke', side: 'web', checks })).toBe(1)
  })
  it('gate smoke：缺一条应跑考卷的 check → 0（不谎报绿）', () => {
    const checks = [{ caseKey: 'test:spec/flight-check-index-mount' }]
    expect(computeCoverageComplete({ purpose: 'gate', lock: lockFunSpec, unit: 'smoke', side: 'web', checks })).toBe(0)
  })
  it('含 skipped 的 check 也算已执行 → 1', () => {
    const checks = [{ caseKey: 'test:spec/flight-check-index-mount', status: 'skipped' }, { caseKey: 'test:spec/flight-check-detail-fields' }]
    expect(computeCoverageComplete({ purpose: 'gate', lock: lockFunSpec, unit: 'smoke', side: 'web', checks })).toBe(1)
  })
  it('mutation run 只跑子集 → null（不适用，绝不参与判定：防上一轮把 mutation 误判）', () => {
    expect(computeCoverageComplete({ purpose: 'mutation', lock: lockFunSpec, unit: 'smoke', side: 'web', checks: [] })).toBeNull()
  })
  it('本轮该跑集为空（regression_only 无匹配 / 无 assetLock）→ null', () => {
    expect(computeCoverageComplete({ purpose: 'gate', lock: { specs: [] }, unit: 'smoke', side: 'admin', checks: [] })).toBeNull()
    expect(computeCoverageComplete({ purpose: 'gate', lock: undefined, unit: 'smoke', side: 'web', checks: [] })).toBeNull()
  })

  // ── 容错分支（此前为变异存活点：':' 后缀匹配 / includes 包含匹配 / featureKey 缺失防护）──
  it('caseKey 为 <组>:<featureKey> 形态 → 经 ":" 后缀匹配计入（杀死删除 endsWith(":") 的变异）', () => {
    const checks = [
      { caseKey: 'suite-a:flight-check-index-mount' },
      { caseKey: 'suite-a:flight-check-detail-fields' },
    ]
    expect(computeCoverageComplete({ purpose: 'gate', lock: lockFunSpec, unit: 'smoke', side: 'web', checks })).toBe(1)
  })

  it('caseKey 含 featureKey 但前后有别的字符 → 经 includes 匹配计入（杀死删除 includes 的变异）', () => {
    const checks = [
      { caseKey: 'test:spec/prefix-flight-check-index-mount-suffix' },
      { caseKey: 'test:spec/prefix-flight-check-detail-fields-suffix' },
    ]
    expect(computeCoverageComplete({ purpose: 'gate', lock: lockFunSpec, unit: 'smoke', side: 'web', checks })).toBe(1)
  })

  it('无 featureKey 的冻结条目不参与判定（杀死删除 !featureKey 防护的变异）', () => {
    const lock = { specs: [{ specType: 'e2e', side: 'web', featureKey: null }] }
    expect(computeCoverageComplete({ purpose: 'gate', lock, unit: 'smoke', side: 'web', checks: [] })).toBe(1)
  })
})
