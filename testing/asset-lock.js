/**
 * testing/asset-lock.js — 提交时刻冻结的执行资产清单（binding 的一部分）
 *
 * 为什么需要：执行侧此前在 run 开始前临时读「当前 active 考卷」，
 * 提交后改卷/归档/换版本都会静默改变已下单 run 的执行内容——
 * 既无法追溯「这次跑的是哪版考卷」，也让门禁的通过结论失去锚点。
 *
 * 现在：提交（createTestSubmission）时按同一套过滤规则算出清单，
 * 连版本号与内容 sha256 一起写进 binding 文档（bindingId 因内容寻址随之变化），
 * 执行侧只按清单取内容并逐条校验 sha256，门禁按清单核对逐用例执行证据。
 */
import { tableExists } from '../db/dialect-helpers.js'
import { documentSha256 } from '../contracts/version.mjs'

const LOCK_SCHEMA_VERSION = 1

/**
 * 冻结清单条目：只保留执行与核对所需的身份信息（内容放在内容寻址库，不重复存）。
 * @param {object} spec activeSpecsForRepo 返回的行
 */
function lockEntry(spec) {
  let acceptanceRefs = []
  try {
    const refs = JSON.parse(spec.acceptance_refs_json || '[]')
    if (Array.isArray(refs)) acceptanceRefs = [...new Set(refs.filter((r) => typeof r === 'string'))].sort()
  } catch { /* 非法声明不能提供 AC 覆盖 */ }
  return {
    featureKey: spec.feature_key,
    specId: spec.spec_id,
    version: spec.version,
    specType: spec.spec_type,
    side: spec.side || null,
    scope: spec.scope || 'task',
    entry: spec.entry,
    blobSha256: spec.blob_sha256,
    acceptanceRefs,
    demandRef: spec.demand_ref || null,
  }
}

/** 与门禁注入候选条件一致，但使用提交事务的 db，不跨库读取，也不加载脚本内容。 */
export async function submissionSpecRows(db, repoId, taskId) {
  if (!(await tableExists(db, 'test_specs'))) return [] // 方言感知(§2.8)
  return await db.prepare(`SELECT * FROM test_specs WHERE repo_id=? AND (
    (review_status='active' AND (scope IS NULL OR scope IN ('task','regression')))
    OR (review_status='draft' AND demand_ref=?)) ORDER BY feature_key, version`)
    .all(repoId, taskId)
}

/**
 * 生成冻结清单（纯函数，便于单测）：输入已是本次要注入的 spec 行集合。
 * 排序固定，保证同一集合 → 同一 sha256。
 */
export function buildAssetLock(specs = []) {
  const entries = specs
    .map(lockEntry)
    .sort((a, b) => (a.featureKey < b.featureKey ? -1 : a.featureKey > b.featureKey ? 1 : 0)
      || (a.specType < b.specType ? -1 : a.specType > b.specType ? 1 : 0)
      || a.version - b.version)
  const doc = { schemaVersion: LOCK_SCHEMA_VERSION, specs: entries }
  return { ...doc, sha256: documentSha256(doc) }
}

/**
 * 清单中某次 run 该跑的用例（按 unit/side 选）。
 *  - static：全部 unit 资产（unit 资产不拆端）
 *  - smoke:<side>：e2e/smoke 资产中 side 为空（双侧）或与本 lane 一致者
 * 与 worker 注入侧同一口径，保证「清单里的都必须有执行证据」。
 */
export function lockedCasesForRun(lock, { unit, side = null } = {}) {
  const specs = Array.isArray(lock?.specs) ? lock.specs : []
  if (unit === 'static') return specs.filter((s) => s.specType === 'unit')
  if (unit === 'smoke') {
    return specs.filter((s) => s.specType !== 'unit' && (!s.side || s.side === side))
  }
  return []
}

/**
 * 冻结清单身份索引（单一真相）：featureKey → 该卷本轮被实际执行的 { specId, version, specType, side }。
 * 变异验卷的派发与回写都以此为准，杜绝「完成时刻实时查 active、却被 AI 中途改版打断」的 TOCTOU 竞态。
 * 同一 featureKey 若既有 unit 又有 e2e 条目，优先返回 e2e/smoke（变异针对可执行 e2e 卷）。
 */
export function lockedSpecByFeature(lock) {
  const map = new Map()
  for (const s of Array.isArray(lock?.specs) ? lock.specs : []) {
    if (!s?.featureKey) continue
    const cur = map.get(s.featureKey)
    if (!cur || (cur.specType === 'unit' && s.specType !== 'unit')) map.set(s.featureKey, s)
  }
  return map
}

/**
 * 证据完整性判定（纯函数，便于单测；仅用于写 test_runs.coverage_complete 数据列，不改 run 终态）。
 * - 非 gate run（mutation/candidate 等按设计只跑子集）→ null（不适用，绝不参与判定）
 * - 本轮该跑集为空 → null（无可校验收据，不谎报 1/0）
 * - 否则：每条应跑考卷都产出任意 check（含 skipped）→ 1；有缺 → 0
 */
export function computeCoverageComplete({ purpose, lock, unit, side = null, checks = [] } = {}) {
  if (purpose !== 'gate') return null
  const required = lockedCasesForRun(lock, { unit, side })
  if (!required.length) return null
  const keys = (Array.isArray(checks) ? checks : []).map((c) => String((c && c.caseKey) || ''))
  const present = (fk) => keys.some((k) => k === fk || k.endsWith('/' + fk) || k.endsWith(':' + fk) || k.includes(fk))
  return required.every((s) => !s.featureKey || present(String(s.featureKey))) ? 1 : 0
}
