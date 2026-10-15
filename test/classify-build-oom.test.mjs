import { describe, expect, it } from 'vitest'
import { classifyCheck, classifyRunChecks } from '../harness/loop.js'

describe('BUILD OOM / 构建资源失败 → infra', () => {
  it('smoke BUILD_FAILED exit 134 判为 infra，不烧产品迭代', () => {
    const cls = classifyCheck({
      caseKey: 'test:smoke/fun',
      status: 'failed',
      detail: 'BUILD_FAILED exit=134 signal=null script=build:web | ReportExternalAllocationLimitReached',
    })
    expect(cls).toBe('infra')
  })

  it('OutOfMemory / Hyper-V 错误码 → infra', () => {
    expect(
      classifyCheck({
        caseKey: 'test:smoke/fun',
        status: 'failed',
        detail: 'Start-VM OutOfMemory 0x8007000E',
      })
    ).toBe('infra')
  })

  it('eslint prettier 仍是 product', () => {
    expect(
      classifyCheck({
        caseKey: 'test:static/eslint',
        status: 'failed',
        detail: 'prettier/prettier Replace `·v-if`',
      })
    ).toBe('product')
  })

  it('整体分类：仅 infra → overall infra', () => {
    const r = classifyRunChecks([
      {
        caseKey: 'test:smoke/fun',
        status: 'failed',
        detail: 'BUILD_FAILED exit=134 OutOfMemory',
      },
    ])
    expect(r.overall).toBe('infra')
  })
})
