/**
 * metrics.js — 周报健康度口径（经验命中率）
 *
 * distill_query 的 tools/call 审计 detail 默认是「【检索经验】搜索…」，
 * 不含「未命中」，会把全部查询计成命中。只认带 命中/未命中 字样的 detail。
 */

export function scoreDistillHitMiss(detail) {
  const d = String(detail || '')
  if (d.includes('未命中')) return 'miss'
  if (/命中\s*\d+/.test(d)) return 'hit'
  return 'skip'
}
