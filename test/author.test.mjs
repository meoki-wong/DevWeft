import { describe, it, expect } from 'vitest'
import {
  isPlaceholderAuthor,
  resolveToolAuthor,
  isRealAuthorMismatch,
  AUTHOR_TOOLS,
} from '../harness/author.js'

describe('resolveToolAuthor', () => {
  it('占位 author 替换为会话 username', () => {
    expect(resolveToolAuthor('cursor-agent', 'yangyan')).toBe('yangyan')
    expect(resolveToolAuthor('Cursor', 'yangyan')).toBe('yangyan')
    expect(resolveToolAuthor('', 'yangyan')).toBe('yangyan')
  })

  it('真人 author 不被 username 覆盖', () => {
    expect(resolveToolAuthor('zzzs024', 'yangyan')).toBe('zzzs024')
  })

  it('无 username 时保留占位，避免写成空串导致 NOT NULL 失败', () => {
    expect(resolveToolAuthor('cursor-agent', '')).toBe('cursor-agent')
  })
})

describe('isRealAuthorMismatch', () => {
  it('占位 vs 真人 不判偏差', () => {
    expect(isRealAuthorMismatch('yangyan', 'cursor-agent')).toBe(false)
    expect(isRealAuthorMismatch('cursor-agent', 'yangyan')).toBe(false)
  })

  it('两个真人不相同才判偏差', () => {
    expect(isRealAuthorMismatch('yangyan', 'yangyan')).toBe(false)
    expect(isRealAuthorMismatch('yangyan', 'zzzs024')).toBe(true)
  })
})

describe('isPlaceholderAuthor', () => {
  it('识别常见 IDE 占位', () => {
    expect(isPlaceholderAuthor('cursor-agent')).toBe(true)
    expect(isPlaceholderAuthor('assistant')).toBe(true)
    expect(isPlaceholderAuthor('yangyan')).toBe(false)
  })
})

describe('AUTHOR_TOOLS', () => {
  it('含 harness_start / distill_append，不含 harness_status', () => {
    expect(AUTHOR_TOOLS.has('harness_start')).toBe(true)
    expect(AUTHOR_TOOLS.has('distill_append')).toBe(true)
    expect(AUTHOR_TOOLS.has('harness_status')).toBe(false)
  })
})
