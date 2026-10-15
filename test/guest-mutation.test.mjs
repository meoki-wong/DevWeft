/**
 * guest-mutation.test.mjs — guest 变异精准化行为测试（阶段 3 / T3.4-T3.5）
 *
 * 覆盖 smoke.mjs 新增的变异精准化行为：
 *  1. changedLineRanges：真实 git 仓库上解析 diff hunk → 行区间；非 git 目录 → null；
 *  2. merge commit 口径对齐：与平台侧 collectTaskChangedFiles 一致——merge 回退整文件（null）；
 *  3. pages 过滤语义（runSideSmoke 内联逻辑的等价验证）：无 pages 全量、有 pages 取交集。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { changedLineRanges } from '../runner/guest-agent/smoke.mjs'

let repoDir = null

function git(cwd, args) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), 'awp-gmut-'))
  git(repoDir, 'init')
  git(repoDir, 'config user.email t@t.local')
  git(repoDir, 'config user.name tester')
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  const base = Array.from({ length: 30 }, (_, i) => `const line${i} = ${i}`).join('\n')
  writeFileSync(join(repoDir, 'src', 'calc.js'), base + '\n')
  writeFileSync(join(repoDir, 'src', 'readme.txt'), 'notes')
  git(repoDir, 'add -A')
  git(repoDir, 'commit -m base')
  // 本次改动:修改第 5 行(line4)与第 25 行(line24)
  const lines = base.split('\n')
  lines[4] = 'const line4 = 400'
  lines[24] = 'const line24 = 2400'
  writeFileSync(join(repoDir, 'src', 'calc.js'), lines.join('\n') + '\n')
  git(repoDir, 'add -A')
  git(repoDir, 'commit -m change')
})

afterAll(() => {
  try { rmSync(repoDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('changedLineRanges（改动行解析）', () => {
  it('解析 diff hunk → 改动行区间覆盖第 5/25 行', () => {
    const ranges = changedLineRanges(repoDir, 'src/calc.js')
    expect(Array.isArray(ranges)).toBe(true)
    const hit = (ln) => ranges.some(([a, b]) => ln >= a && ln <= b)
    expect(hit(5)).toBe(true)   // line4 在第 5 行(1-based)
    expect(hit(25)).toBe(true)  // line24 在第 25 行
    expect(hit(15)).toBe(false) // 未改动行不在区间
  })

  it('未改动文件 → null（无 hunk）', () => {
    // readme.txt 无第二次改动 → diff 为空 → null
    expect(changedLineRanges(repoDir, 'src/readme.txt')).toBeNull()
  })

  it('非 git 目录 → null（调用方 skip 不盲变异，R6 后不再回退整文件）', () => {
    const plain = mkdtempSync(join(tmpdir(), 'awp-gmut2-'))
    try {
      expect(changedLineRanges(plain, 'src/calc.js')).toBeNull()
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('boundary.startHeadOid → 按任务边界取行区间', () => {
    // 当前仓 HEAD 是 change 提交；用 HEAD~1（base）作起点，应覆盖 change 的行
    const base = execSync('git rev-parse HEAD~1', { cwd: repoDir, encoding: 'utf8' }).trim()
    const ranges = changedLineRanges(repoDir, 'src/calc.js', { startHeadOid: base })
    expect(Array.isArray(ranges)).toBe(true)
    const hit = (ln) => ranges.some(([a, b]) => ln >= a && ln <= b)
    expect(hit(5)).toBe(true)
    expect(hit(25)).toBe(true)
  })
})

describe('merge commit 口径对齐（与平台侧 collectTaskChangedFiles 一致）', () => {
  it('merge commit → 回退 null（调用方按 not_covered 豁免，不做盲变异）', () => {
    // 制造 merge commit:分支 A 改 line4,主干前进一步,合并 A
    git(repoDir, 'checkout -b feature-merge')
    writeFileSync(join(repoDir, 'src', 'calc.js'), Array.from({ length: 30 }, (_, i) => `const line${i} = ${i * 2}`).join('\n') + '\n')
    git(repoDir, 'add -A')
    git(repoDir, 'commit -m feature')
    git(repoDir, 'checkout master')
    writeFileSync(join(repoDir, 'src', 'other.js'), 'const other = 1\n')
    git(repoDir, 'add -A')
    git(repoDir, 'commit -m master-advance')
    git(repoDir, 'merge --no-ff feature-merge -m merge')
    // HEAD 现在是 merge commit(2 个父提交)
    const parents = git(repoDir, 'rev-list --no-walk --parents HEAD').trim().split(/\s+/)
    expect(parents.length).toBe(3) // merge commit 有 2 个父
    expect(changedLineRanges(repoDir, 'src/calc.js')).toBeNull()
  })
})

describe('pages 过滤语义（变异候选与考卷观测路径的交集）', () => {
  // runSideSmoke 内联逻辑等价:changedCandidates = (pages?.length) ? changed.filter(交集) : changed
  const filter = (changed, pages) => (pages && pages.length) ? changed.filter((rel) => pages.some((p) => String(rel).toLowerCase().includes(String(p).toLowerCase()))) : changed

  it('无 pages 声明 → 全部 changed 文件都是候选（仍限改动行内选点）', () => {
    const changed = ['src/views/a.vue', 'src/utils/b.js']
    expect(filter(changed, null)).toEqual(changed)
    expect(filter(changed, [])).toEqual(changed)
  })

  it('有 pages → 仅观测路径上的文件可被暗改', () => {
    const changed = ['src/views/order/list.vue', 'src/utils/b.js']
    const out = filter(changed, ['order/list'])
    expect(out).toEqual(['src/views/order/list.vue'])
  })

  it('改动完全不在观测路径 → 零候选（派发侧 static-skip 应已拦截,此处兜底不变异）', () => {
    const changed = ['src/utils/b.js']
    expect(filter(changed, ['order/list'])).toEqual([])
  })
})
