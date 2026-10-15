/**
 * 看板时间格式化（2026-09-26 修复）：
 * - 空/非法时间 → '—'（此前渲染 1970/NaN）
 * - 无时区后缀的历史串按 UTC 处理（服务端 utcNow 统一 UTC 落库）
 * 提取 dashboard.js 源码中的纯函数做行为断言（沿用 submission-flow.test 的源码切片模式）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/assets/dashboard.js', import.meta.url), 'utf8')
const start = src.indexOf('function parseTs')
const end = src.indexOf('function fmtBytes')
if (start < 0 || end < 0 || end <= start) throw new Error('dashboard.js 时间函数切片失败：确认 parseTs/fmtBytes 仍存在')

const factory = new Function(`${src.slice(start, end)}\n;return { relTime, fmtDateTime };`)
const { relTime, fmtDateTime } = factory()

describe('看板时间格式化守卫', () => {
  it('空值/非法值渲染 —，不再出现 1970/NaN', () => {
    for (const bad of [null, undefined, '', 'not-a-date', '2026-13-99T99:99:99Z']) {
      expect(relTime(bad)).toBe('—')
      expect(fmtDateTime(bad)).toBe('—')
    }
  })

  it('无时区后缀按 UTC 解析（与带 Z 的结果一致）', () => {
    expect(fmtDateTime('2026-09-26T02:00:00')).toBe(fmtDateTime('2026-09-26T02:00:00Z'))
    expect(fmtDateTime('2026-09-26 02:00:00')).toBe(fmtDateTime('2026-09-26T02:00:00Z'))
  })

  it('相对时间：当前时间为「刚刚」', () => {
    expect(relTime(new Date().toISOString())).toBe('刚刚')
  })

  it('跨年日期显示完整年份', () => {
    const lastYear = new Date()
    lastYear.setFullYear(lastYear.getFullYear() - 1)
    lastYear.setMonth(0, 15)
    lastYear.setHours(10, 30, 0, 0)
    expect(relTime(lastYear.toISOString())).toMatch(new RegExp(`^${lastYear.getFullYear()}-`))
  })
})
