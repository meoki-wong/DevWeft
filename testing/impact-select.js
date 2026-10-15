/**
 * testing/impact-select.js — 影响面选择（保守：宁多勿漏）
 *
 * 第一版：路径启发式 + 主干全量触发 + 空集禁止。
 * import 闭包为增强项；解析失败一律回退全量。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'

const TRUNK_PATTERNS = [
  /(^|\/)src\/main\.(ts|js|tsx|jsx)$/,
  /(^|\/)src\/App\.vue$/,
  /(^|\/)vite\.config\./,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)tsconfig.*\.json$/,
]

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage'])

function walk(dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(p, out, depth + 1)
    else out.push(p)
  }
  return out
}

function isSpecFile(p) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)(tests?|__tests__)\/.+\.[cm]?[jt]sx?$/.test(p)
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceDir 业务仓根
 * @param {string[]} opts.changedFiles 相对路径
 * @param {string[]} opts.allSpecs 可选：预扫描的 spec 列表
 * @returns {{ mode: 'full'|'selected'|'empty-forbidden', selected: string[], reason: string, metrics: object }}
 */
export function selectImpactedSpecs({ workspaceDir, changedFiles = [], allSpecs = null }) {
  const files = (changedFiles || []).map((f) => String(f).replace(/\\/g, '/').replace(/^\.\//, ''))
  const metrics = { changed: files.length, trunk: false, specOnly: false }

  if (!files.length) {
    return { mode: 'full', selected: allSpecs || scanSpecs(workspaceDir), reason: 'no-changed-files', metrics }
  }

  if (files.some((f) => TRUNK_PATTERNS.some((rx) => rx.test(f)))) {
    metrics.trunk = true
    return {
      mode: 'full',
      selected: allSpecs || scanSpecs(workspaceDir),
      reason: 'trunk-path-changed',
      metrics,
    }
  }

  const onlySpecs = files.every((f) => isSpecFile(f) || /(^|\/)tests?\//.test(f))
  if (onlySpecs) {
    metrics.specOnly = true
    const selected = (allSpecs || scanSpecs(workspaceDir)).filter((s) =>
      files.some((f) => s.replace(/\\/g, '/').includes(f) || f.includes(s.replace(/\\/g, '/').split('/').pop()))
    )
    if (!selected.length) {
      return { mode: 'full', selected: allSpecs || scanSpecs(workspaceDir), reason: 'spec-only-match-empty→full', metrics }
    }
    return { mode: 'selected', selected, reason: 'spec-only-change', metrics }
  }

  // 启发式：同目录 / 名称包含 / 路径段重叠
  const specs = allSpecs || scanSpecs(workspaceDir)
  const selected = new Set()
  for (const s of specs) {
    const rel = s.replace(/\\/g, '/')
    for (const f of files) {
      const fdir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''
      const fname = f.split('/').pop().replace(/\.[^.]+$/, '')
      if (fdir && rel.includes(fdir)) selected.add(s)
      else if (fname && fname.length > 3 && rel.toLowerCase().includes(fname.toLowerCase())) selected.add(s)
      else if (rel.includes('/' + f.split('/').slice(-2).join('/').replace(/\.[^.]+$/, ''))) selected.add(s)
    }
  }

  if (!selected.size) {
    // 空集禁止：回退全量
    return {
      mode: 'full',
      selected: specs,
      reason: 'heuristic-empty→full',
      metrics: { ...metrics, missGuard: true },
    }
  }

  return {
    mode: 'selected',
    selected: [...selected],
    reason: 'path-heuristic',
    metrics: { ...metrics, selectedCount: selected.size, fullCount: specs.length },
  }
}

export function scanSpecs(workspaceDir) {
  if (!workspaceDir || !existsSync(workspaceDir)) return []
  const roots = ['tests', 'test', 'src']
  const out = []
  for (const r of roots) {
    const p = join(workspaceDir, r)
    if (!existsSync(p)) continue
    for (const f of walk(p)) {
      if (isSpecFile(f)) out.push(relative(workspaceDir, f).split(sep).join('/'))
    }
  }
  return [...new Set(out)]
}

/** 记录 impact_miss（全量夜跑发现 selected 漏了） */
export async function recordImpactMiss(db, { repoId, taskId, missedSpec, note = null, now = new Date().toISOString() }) {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS impact_misses (
        id TEXT PRIMARY KEY,
        repo_id TEXT,
        task_id TEXT,
        missed_spec TEXT,
        note TEXT,
        created_at TEXT NOT NULL
      )
    `)
    await db.prepare(
      `INSERT INTO impact_misses(id, repo_id, task_id, missed_spec, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(`im-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, repoId, taskId, missedSpec, note, now)
  } catch {
    /* ignore */
  }
}

export function loadWorkspacePackageScripts(workspaceDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(workspaceDir, 'package.json'), 'utf8'))
    return pkg.scripts || {}
  } catch {
    return {}
  }
}

export { dirname }
