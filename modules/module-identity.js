/**
 * module-identity.js — 显式 module/region/variant 归一化
 *
 * 替代 import-modules 的 familyKey/inferRegion 启发式：
 *  - 人工 manifest 优先
 *  - 推断只作为建议，source=inferred，不当作事实
 *  - a/b 与 a-b 文档键不碰撞（路径保留 __ 分隔）
 */
export function normalizeModuleId(input) {
  return String(input || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/**
 * 文档键：module-{side}-{path with __}
 * 例：src/views/a/b → module-default-src__views__a__b
 *     src/views/a-b → module-default-src__views__a-b
 */
export function moduleDocKey({ side, modulePath }) {
  const p = normalizeModuleId(modulePath).replace(/\//g, '__')
  return `module-${side || 'default'}-${p}`
}

/**
 * 从人工 manifest 读 region/variant；无命中返回 unknown。
 * manifest 结构：{ modules: { "src/views/foo": { region, variant, family, side } } }
 */
export function parseRegionFromManifest(manifest, modulePath) {
  const key = normalizeModuleId(modulePath)
  const hit = manifest?.modules?.[key]
  if (hit) {
    return {
      region: hit.region || 'default',
      variant: hit.variant || 'default',
      family: hit.family || null,
      side: hit.side || null,
      source: 'manual',
    }
  }
  return { region: 'default', variant: 'default', family: null, side: null, source: 'unknown' }
}

/**
 * 旧启发式推断（仅作 import 建议，source=inferred）。
 * 修正 marketSearch 被 /Sea/ 误判：仅匹配显式地区后缀/中缀分隔。
 */
export function inferRegionHeuristic(id) {
  const s = String(id || '')
  const variant = /byHr/i.test(s) ? 'hr' : 'default'
  // 显式地区 token：词边界或路径段，避免 marketSearch 命中 Sea
  if (/Centralasia/i.test(s)) return { region: 'centralasia', variant, source: 'inferred' }
  if (/(^|[^a-zA-Z])Sea([^a-zA-Z]|$)/i.test(s) || /Sea$/i.test(s)) {
    // marketSearch：Sea 后还有字母且前面是 r（Search）→ 不算
    if (/Search/i.test(s) && !/Sea[A-Z]/.test(s.replace(/Search/g, ''))) {
      return { region: 'default', variant, source: 'inferred' }
    }
    if (/Sea/i.test(s) && !/^marketSearch$/i.test(s)) {
      return { region: 'sea', variant, source: 'inferred' }
    }
  }
  if (/^audit-/.test(s)) return { region: 'multi', variant, source: 'inferred' }
  return { region: 'default', variant, source: 'inferred' }
}

/** 旧 familyKey（仅兼容读，新代码用 manifest） */
export function familyKeyLegacy(id) {
  return String(id || '')
    .replace(/Sea$/i, '')
    .replace(/Centralasia$/i, '')
    .replace(/byHr$/i, '')
}

/**
 * 冲突检测：同一 docKey 被两个不同 implPath 声明 → 冲突
 */
export function detectDocKeyConflicts(entries) {
  const map = new Map()
  const conflicts = []
  for (const e of entries) {
    const key = moduleDocKey(e)
    const prev = map.get(key)
    if (prev && prev.modulePath !== e.modulePath) {
      conflicts.push({ key, a: prev.modulePath, b: e.modulePath })
    } else {
      map.set(key, e)
    }
  }
  return conflicts
}
