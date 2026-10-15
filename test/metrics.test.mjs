import { describe, it, expect } from 'vitest'
import { scoreDistillHitMiss } from '../harness/metrics.js'

describe('scoreDistillHitMiss', () => {
  it('未命中计 miss', () => {
    expect(scoreDistillHitMiss('经验库未命中：verify.sh')).toBe('miss')
    expect(scoreDistillHitMiss('未命中：Harness')).toBe('miss')
  })

  it('命中 N 条计 hit', () => {
    expect(scoreDistillHitMiss('命中 3 条')).toBe('hit')
  })

  it('工具中文摘要不计（避免 100% 假命中率）', () => {
    expect(scoreDistillHitMiss('【检索经验】搜索团队经验库：manualChunks')).toBe('skip')
    expect(scoreDistillHitMiss('')).toBe('skip')
  })
})
