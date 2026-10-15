import { describe, expect, it } from 'vitest'
import {
  inferSidesFromChangedFiles,
  requiredUnitsForTask,
} from '../harness/testing-gate.js'
import { allRunsTerminal } from '../harness/loop.js'

const impactRules = { both: ['^src/shared/'], sides: { client: ['^src/client/'], admin: ['^src/admin/'] } }

describe('改动路径按仓库 impact profile 映射到 smoke lane', () => {
  it('仅匹配一个 lane 时只选中该 lane', () => {
    expect(inferSidesFromChangedFiles(['src/client/home/index.js'], impactRules)).toEqual(['client'])
  })
  it('不同路径可映射到不同 lane', () => {
    expect(inferSidesFromChangedFiles(['src/admin/order/list.js'], impactRules)).toEqual(['admin'])
  })
  it('未配置的路径不猜测 lane', () => {
    expect(inferSidesFromChangedFiles(['src/shared-api/list.js'], impactRules)).toBeNull()
  })
  it('共享路径选择所有配置 lane', () => {
    expect(inferSidesFromChangedFiles(['src/shared/routes.js'], impactRules)).toEqual(['client', 'admin'])
  })
  it('没有 impact rules 时不做路径推断', () => {
    expect(inferSidesFromChangedFiles(['src/client/home.js'])).toBeNull()
  })
  it('空清单 → pending，不默认双侧', () => {
    expect(inferSidesFromChangedFiles([], impactRules)).toBeNull()
  })
})

describe('requiredUnitsForTask 带 sides（AI 声明）', () => {
  it('M + FEATURE + 单 lane 只排对应 smoke', () => {
    expect(requiredUnitsForTask({ size: 'M', type: 'FEATURE', sides: ['client'] }))
      .toEqual(['static:na', 'smoke:client'])
  })
  it('M + FEATURE + 多 lane 按 profile 全部排 smoke', () => {
    expect(requiredUnitsForTask({ size: 'M', type: 'FEATURE', sides: ['client', 'admin'] }))
      .toEqual(['static:na', 'smoke:client', 'smoke:admin'])
  })
  it('M + FIX → 无 smoke', () => {
    expect(requiredUnitsForTask({ size: 'M', type: 'FIX', sides: ['client'] })).toEqual(['static:na'])
  })
})

describe('wait：全部 run 终态即返回', () => {
  it('部分未终 → null', () => {
    expect(allRunsTerminal([{ status: 'passed' }, { status: 'queued' }])).toBe(null)
  })
  it('全过 → passed', () => {
    expect(allRunsTerminal([{ status: 'passed' }, { status: 'passed' }])).toBe('passed')
  })
  it('有 failed → failed', () => {
    expect(allRunsTerminal([{ status: 'passed' }, { status: 'failed' }])).toBe('failed')
  })
})
