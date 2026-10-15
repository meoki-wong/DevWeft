/**
 * testing/platform-settings.js — 平台设置严格校验与持久化（阶段 4 / T2.5 抽取）
 *
 * Worker 并发值本期明确契约：
 *   接受整数 1/2/3，或精确字符串 "1"/"2"/"3"；
 *   拒绝 0、4、越界、空串、"3x"、"2.9"、浮点、null、对象。
 *   不再以宽松 parseInt 作为合法性判断——"2.9" parseInt 后是 2，属于假通过。
 */
import { ApiError } from './errors.js'
import { utcNow } from './ids.js'

const ALLOWED = new Set([1, 2, 3])

/** 严格校验：仅 1/2/3 整数或单字符数字字符串；其余一律 false */
export function validateWorkerConcurrency(value) {
  if (typeof value === 'number') return ALLOWED.has(value)
  if (typeof value === 'string') return value.length === 1 && ALLOWED.has(Number(value))
  return false
}

export async function setWorkerConcurrency(db, value, { now = utcNow() } = {}) {
  if (!validateWorkerConcurrency(value)) {
    throw new ApiError('INVALID_SCHEMA', {
      detail: `worker_concurrency 仅接受整数 1/2/3 或 "1"/"2"/"3"（收到 ${JSON.stringify(value)}）`,
    })
  }
  const v = String(value)
  await db.prepare(
    `INSERT INTO platform_settings(key, value, updated_at) VALUES ('worker_concurrency', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(v, now)
  return { key: 'worker_concurrency', value: v }
}

export async function getWorkerConcurrency(db, { fallback = '2' } = {}) {
  const row = await db.prepare(`SELECT value FROM platform_settings WHERE key='worker_concurrency'`).get()
  return row?.value ?? fallback
}
