import { describe, expect, it } from 'vitest'
import { buildActivityPlan, deriveSize, phaseToActivity, requirementHash, nextActivity, toolsForActivity } from '../harness/activity-plan.js'

describe('activity plan', () => {
  it('单行修复：receive → execute → static', () => {
    const plan = buildActivityPlan({ type: 'FIX', changedFiles: ['src/a.js'] })
    expect(plan).toEqual(['receive', 'execute', 'static'])
  })

  it('功能类任务包含定位上下文和制定计划', () => {
    const plan = buildActivityPlan({ type: 'FEATURE' })
    expect(plan.slice(0, 3)).toEqual(['receive', 'retrieve', 'plan'])
  })

  it('跨模块或契约才出现 retrieve / plan / smoke', () => {
    const plan = buildActivityPlan({
      type: 'FEATURE',
      changedFiles: ['src/httpApi/a.js', 'src/pages/webSide/x.vue'],
      contractTouch: true,
      riskPath: true,
      touchesUi: true,
      sides: ['web'],
    })
    expect(plan).toContain('retrieve')
    expect(plan).toContain('plan')
    expect(plan).toContain('smoke')
  })

  it('执行中 diff 扩大会插入 plan', () => {
    const small = buildActivityPlan({ type: 'FIX', changedFiles: ['a.js'] })
    const large = buildActivityPlan({
      type: 'FIX',
      changedFiles: Array.from({ length: 16 }, (_, i) => `f${i}.js`),
    })
    expect(small).not.toContain('plan')
    expect(large).toContain('plan')
    expect(large).toContain('retrieve')
  })

  it('deriveSize 只是标签', () => {
    expect(deriveSize({ type: 'FIX', changedFiles: ['a.js'] })).toBe('S')
    expect(deriveSize({ type: 'FEATURE', touchesUi: true })).toBe('M')
    expect(deriveSize({ contractTouch: true })).toBe('L')
  })

  it('沉淀是旁路：写完回到进入前的活动，不退回 plan', () => {
    const plan = buildActivityPlan({ type: 'FEATURE', changedFiles: ['src/a.vue'], touchesUi: true, sides: ['web'] })
    expect(plan).not.toContain('distill')
    expect(nextActivity('distill', plan)).toBe('execute')
    expect(nextActivity('distill', plan, { resumeActivity: 'static' })).toBe('static')
    expect(toolsForActivity('execute')).toContain('distill_append')
    expect(toolsForActivity('static')).toContain('distill_append')
  })

  it('旧阶段名映射', () => {
    expect(phaseToActivity('LOCATE')).toBe('retrieve')
    expect(phaseToActivity('VERIFY')).toBe('static')
    expect(requirementHash('同 文')).toBe(requirementHash('同 文'))
    expect(requirementHash('同 文')).not.toBe(requirementHash('另一段'))
  })
})
