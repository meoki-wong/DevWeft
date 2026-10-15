/**
 * RunSpec.unit → 用例过滤（多仓）。
 *  - static: caseKey contains static/
 *  - smoke: caseKey contains smoke/<configured side>
 */
export function filterCasesForUnit(cases, runSpec) {
  const list = Array.isArray(cases) ? cases : []
  if (runSpec.unit === 'static') {
    return list.filter((c) => {
      const k = String(c.caseKey || '')
      return /(^|:)static\//.test(k) || k.includes('/static/')
    })
  }
  if (runSpec.unit === 'smoke') {
    const side = runSpec.side || ''
    return list.filter((c) => {
      const k = String(c.caseKey || '')
      return k.includes(`smoke/${side}`) || k.endsWith(`:smoke/${side}`) || k === `smoke:${side}`
    })
  }
  return []
}
