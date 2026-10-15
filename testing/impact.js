/**
 * testing/impact.js — 公共组件影响面与失败归因（跨页面回归判定）
 *
 * 规则：suite 类失败的 spec，其 pages 声明的源码路径与本次改动文件有交集
 * → 这是真回归（重归类为 product，不适用考卷豁免）；
 * 无交集 → 才是考卷自身问题（suite，豁免迭代/沉淀）。
 * 匹配为目录级（子串/前缀），故意不引入 AST 解析器。
 * 归因是增强：任何查表失败都原样返回，不阻断判卷。
 */
import { utcNow } from './ids.js'

/** 读某 spec（最新版）声明的 pages；无声明返回 [] */
export async function getSpecPages(db, repoId, featureKey) {
  try {
    const row = await db
      .prepare(
        'SELECT pages_json FROM test_specs WHERE repo_id=? AND feature_key=? ORDER BY version DESC LIMIT 1'
      )
      .get(repoId, featureKey)
    if (!row?.pages_json) return []
    const pages = JSON.parse(row.pages_json)
    return Array.isArray(pages) ? pages.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.replace(/\\/g, '/')) : []
  } catch {
    return []
  }
}

/** binding → 本次提交的改动文件清单（business_snapshots.changed_files_json）；取不到返回 null（无法归因） */
export async function changedFilesForBinding(db, bindingId) {
  try {
    const row = await db
      .prepare(
        `SELECT s.changed_files_json AS changed FROM test_bindings b
         JOIN business_snapshots s ON s.snapshot_id = b.snapshot_id
         WHERE b.binding_id = ?`
      )
      .get(bindingId)
    if (!row || !row.changed) return null
    const files = JSON.parse(row.changed)
    return Array.isArray(files) ? files.map((f) => String(f).replace(/\\/g, '/')) : null
  } catch {
    return null
  }
}

function pageMatchesChanged(pages, changedFiles) {
  for (const f of changedFiles) {
    const lf = f.toLowerCase()
    for (const p of pages) {
      const lp = p.toLowerCase().replace(/^\.\//, '')
      if (!lp) continue
      if (lf.includes(lp)) return { file: f, page: p }
    }
  }
  return null
}

/**
 * 对 suite 类 check 做归因修正：
 *  - spec 声明的 pages 与本次改动有交集 → check 改判 product（跨页面真回归）
 *  - 无声明/无交集 → 保持 suite（考卷问题，走豁免）
 * 返回 { checks, attributed }：checks 为修正后的数组，attributed 汇总归因明细。
 */
export async function attributeSuiteChecks(db, { repoId, bindingId, checks }) {
  const attributed = []
  let out = checks
  try {
    const changedFiles = await changedFilesForBinding(db, bindingId)
    if (!changedFiles || !changedFiles.length) return { checks: out, attributed }
    // async 化后 .map(async) 会返回 Promise 数组（真值恒真且 dirty 判定失效），必须 Promise.all
    let dirty = false
    out = await Promise.all((checks || []).map(async (c) => {
      if (!c || c.class !== 'suite' || !c.featureKey) return c
      const pages = await getSpecPages(db, repoId, c.featureKey)
      if (!pages.length) return c
      const hit = pageMatchesChanged(pages, changedFiles)
      if (!hit) return c
      dirty = true
      attributed.push({ featureKey: c.featureKey, page: hit.page, changedFile: hit.file })
      return {
        ...c,
        class: 'product',
        attribution: 'cross-page-regression',
        hints: [
          `跨页面回归：本次改动命中了 ${c.featureKey} 考卷覆盖的页面（${hit.page} ← ${hit.file}）。`,
          '这是真业务回归，不是考卷问题：优先修复公共组件/公共逻辑的兼容性，禁止改 spec 应付。',
          '修复后 awp_test_run({productFixed:true}) 重提。',
        ],
      }
    }))
    if (!dirty) return { checks, attributed }
  } catch {
    return { checks: out, attributed }
  }
  return { checks: out, attributed }
}

/** 供看板/经验入库用的归因摘要落库格式 */
export function attributionSummary(attributed) {
  if (!attributed?.length) return null
  return JSON.stringify({ at: utcNow(), items: attributed })
}
