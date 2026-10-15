/**
 * MCP 布尔/数字宽松解析：包装层把 true 序列化成 "true" 时工具仍可用
 */
import { describe, expect, it } from 'vitest'
import { asBool, asInt, zBoolish, zBoolishOptional, zNumishOptional } from '../tools/boolish.js'

describe('boolish', () => {
  it('zBoolish 接受真布尔与字符串布尔', () => {
    expect(zBoolish.parse(true)).toBe(true)
    expect(zBoolish.parse(false)).toBe(false)
    expect(zBoolish.parse('true')).toBe(true)
    expect(zBoolish.parse('false')).toBe(false)
    expect(zBoolish.parse('1')).toBe(true)
    expect(zBoolish.parse('0')).toBe(false)
    expect(zBoolish.parse(1)).toBe(true)
    expect(zBoolish.parse(0)).toBe(false)
  })

  it('zBoolish 拒绝非法值', () => {
    expect(() => zBoolish.parse('maybe')).toThrow()
  })

  it('zBoolishOptional 允许缺省', () => {
    expect(zBoolishOptional.parse(undefined)).toBeUndefined()
    expect(zBoolishOptional.parse('false')).toBe(false)
  })

  it('asBool 双保险', () => {
    expect(asBool('false', true)).toBe(false)
    expect(asBool('true', false)).toBe(true)
    expect(asBool(undefined, true)).toBe(true)
    expect(asBool(null, false)).toBe(false)
  })

  it('数字字符串可解析', () => {
    expect(zNumishOptional.parse('3')).toBe(3)
    expect(zNumishOptional.parse(3)).toBe(3)
    expect(asInt('5', 0)).toBe(5)
    expect(asInt('', 7)).toBe(7)
  })
})
