/**
 * testing/mutation.js — 变异测试暗题生成（确定性）
 *
 * 原则：变异点由 (seed, 文件内容) 的 hash 决定——同一份内容同一张卷子永远同一个暗题；
 * AI 无法预知命中哪个算子、哪一处出现，因此无法写"永远通过的走过场考卷"。
 * guest 侧（smoke.mjs）内置同算法的极简副本，双方按同一规则独立推导。
 *
 * seed 构成（mutationSeedFor）：featureKey::v卷版本::相对路径——每张考卷每一版的暗改点独立且可重掷：
 * 加强卷重提（版本+1）即换新暗题落点——这是「重试验卷可收敛」的机制保证（R6）。
 */
import { createHash } from 'node:crypto'

/** 暗改 seed（与 guest smoke.mjs 内联副本严格一致）：featureKey 为空时退化为旧公式（仅路径） */
/** 暗改 seed（与 guest smoke.mjs 内联副本一致）：卷版本为空时退化为旧公式（向后兼容在飞 run） */
export function mutationSeedFor(featureKey, relPath, specVersion = null) {
  const fk = featureKey ? String(featureKey) : ''
  const v = specVersion != null ? `v${specVersion}::` : ''
  return fk ? `${fk}::${v}${relPath}` : `${v}${relPath}`
}

/** 变异算子表（保守：只翻比较/布尔/算术，不做结构性改写，避免把代码改到构建失败） */
const OPS = [
  ['===', '!=='],
  ['!==', '==='],
  ['&&', '||'],
  ['||', '&&'],
  ['? true : false', '? false : true'],
  ['true', 'false'],
  ['false', 'true'],
  ['+ 1', '- 1'],
  ['- 1', '+ 1'],
]

/** 零依赖：标记注释/字符串区间，避免把算子落在注释或字面量里 */
export function markForbiddenZones(content) {
  const zones = []
  let i = 0
  const n = content.length
  let state = 'code' // code | line | block | s_q | d_q | tmpl
  while (i < n) {
    const c = content[i]
    const c2 = content.slice(i, i + 2)
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; zones.push(i); i += 2; continue }
      if (c2 === '/*') { state = 'block'; zones.push(i); i += 2; continue }
      if (c === "'") { state = 's_q'; zones.push(i); i++; continue }
      if (c === '"') { state = 'd_q'; zones.push(i); i++; continue }
      if (c === '`') { state = 'tmpl'; zones.push(i); i++; continue }
      i++
      continue
    }
    zones.push(i)
    if (state === 'line' && (c === '\n')) { state = 'code'; i++; continue }
    if (state === 'block' && c2 === '*/') { zones.push(i + 1); state = 'code'; i += 2; continue }
    if ((state === 's_q' || state === 'd_q') && c === '\\') { zones.push(i + 1); i += 2; continue }
    if (state === 's_q' && c === "'") { state = 'code'; i++; continue }
    if (state === 'd_q' && c === '"') { state = 'code'; i++; continue }
    if (state === 'tmpl' && c === '\\') { zones.push(i + 1); i += 2; continue }
    if (state === 'tmpl' && c === '`') { state = 'code'; i++; continue }
    i++
  }
  return zones
}

function inZones(index, zones) {
  // zones 已是密集下标集合时用 set 更快；此处 zones 为数组
  for (let k = 0; k < zones.length; k++) {
    if (zones[k] === index) return true
  }
  return false
}

function isLegalMutationIndex(content, index, find) {
  const zones = markForbiddenZones(content)
  for (let k = 0; k < find.length; k++) {
    if (inZones(index + k, zones)) return false
  }
  return true
}

/**
 * 对文件内容生成确定性变异计划（含合法性过滤）。
 * @returns {{ find, replace, index, legal: true } | null}
 */
export function buildMutationPlan(content, seed) {
  if (typeof content !== 'string' || !content.length || content.length > 500_000) return null
  const hash = createHash('sha256').update(`${seed}::${content}`).digest('hex')
  const start = Number.parseInt(hash.slice(0, 8), 16)
  const zones = markForbiddenZones(content)
  const zoneSet = new Set(zones)
  for (let i = 0; i < OPS.length; i++) {
    const [find, replace] = OPS[(start + i) % OPS.length]
    const occurrences = []
    let pos = 0
    let idx = -1
    while ((idx = content.indexOf(find, pos)) !== -1) {
      let legal = true
      for (let k = 0; k < find.length; k++) {
        if (zoneSet.has(idx + k)) { legal = false; break }
      }
      if (legal) occurrences.push(idx)
      pos = idx + find.length
    }
    if (!occurrences.length) continue
    const pick = occurrences[start % occurrences.length]
    return { find, replace, index: pick, legal: true }
  }
  return null
}

/** 应用变异计划；内容与计划不符（文件已被改）时原样返回 */
export function applyMutation(content, plan) {
  if (!plan || typeof content !== 'string' || content.slice(plan.index, plan.index + plan.find.length) !== plan.find) {
    return content
  }
  return content.slice(0, plan.index) + plan.replace + content.slice(plan.index + plan.find.length)
}

/**
 * 四态：killed | survived | invalid | not_covered
 * @param {object} opts
 * @param {boolean} opts.built 是否通过语法/构建
 * @param {boolean} opts.covered 是否被考卷覆盖
 * @param {boolean} opts.killed 考卷是否失败（杀死）
 */
export function classifyMutationOutcome({ built, covered, killed }) {
  if (!built) return 'invalid'
  if (!covered) return 'not_covered'
  return killed ? 'killed' : 'survived'
}

/** 轻量语法门：括号配对 + 关键字完整（非完整 parser） */
export function looksSyntacticallyValid(content) {
  const text = String(content || '')
  let paren = 0
  let brace = 0
  let bracket = 0
  const zones = new Set(markForbiddenZones(text))
  for (let i = 0; i < text.length; i++) {
    if (zones.has(i)) continue
    const c = text[i]
    if (c === '(') paren++
    else if (c === ')') paren--
    else if (c === '{') brace++
    else if (c === '}') brace--
    else if (c === '[') bracket++
    else if (c === ']') bracket--
    if (paren < 0 || brace < 0 || bracket < 0) return false
  }
  return paren === 0 && brace === 0 && bracket === 0
}
