/**
 * tools/boolish.js — MCP 客户端布尔/数字宽松解析
 *
 * 部分 AI Coding / JSON-RPC 包装层会把 boolean 序列化成 "true"/"false"，
 * 严格 z.boolean() 会校验失败导致工具不可用。
 * 注意：禁止用 z.coerce.boolean()——它对 "false" 会得到 true。
 */
import { z } from 'zod'

function toBool(v) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'n' || s === '') return false
  }
  return v
}

/** 兼容 boolean | 'true'/'false' | 1/0 | '1'/'0' */
export const zBoolish = z.preprocess(toBool, z.boolean())

/** 可选布尔 */
export const zBoolishOptional = z.preprocess((v) => (v === undefined || v === null ? v : toBool(v)), z.boolean().optional())

/** 兼容 number | '12' 等字符串数字 */
export const zNumish = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return v
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (!Number.isNaN(n)) return n
  }
  return v
}, z.number())

export const zNumishOptional = z.preprocess((v) => {
  if (v === undefined || v === null || v === '') return v
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = Number(v.trim())
    if (!Number.isNaN(n)) return n
  }
  return v
}, z.number().optional())

/** 运行时再归一（handler 内双保险） */
export function asBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback
  const r = toBool(v)
  return typeof r === 'boolean' ? r : fallback
}

export function asInt(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}
