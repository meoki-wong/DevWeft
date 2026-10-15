/**
 * collectTaskChangedFiles / resolveTaskChangedFiles — 任务改动集归因边界
 *
 * 核心回归：分支 HEAD 恰为无关历史提交 + 纯脏交付时，禁止把 HEAD~1..HEAD 算进本任务。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  collectTaskChangedFiles,
  resolveTaskChangedFiles,
  resolveWorkspaceHeadOid,
} from '../testing/snapshots.js'

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], { cwd, encoding: 'utf8' }).trim()
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-chg-'))
  git(dir, 'init')
  git(dir, 'config', 'user.email', 't@t.local')
  git(dir, 'config', 'user.name', 'tester')
  git(dir, 'checkout', '-q', '-b', 'master')
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'c0-base')
  return dir
}

/** 无关历史提交：改 flight 样式债文件（模拟 V2.6.7 catalog） */
function addUnrelatedCommit(dir) {
  mkdirSync(join(dir, 'src', 'catalog'), { recursive: true })
  writeFileSync(join(dir, 'src', 'catalog', 'itemList.vue'), '<style>.status_0{color:#00b42a}</style>\n')
  writeFileSync(join(dir, 'src', 'catalog', 'workOrderTotal.vue'), '<style>.fake-tag{color:red}</style>\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'feat(catalog): V2.6.7 无关提交')
  return git(dir, 'rev-parse', 'HEAD')
}

/** 本任务纯脏改动 */
function addTaskDirty(dir, n = 3) {
  const paths = []
  mkdirSync(join(dir, 'src', 'pointsManagement'), { recursive: true })
  for (let i = 0; i < n; i += 1) {
    const rel = `src/pointsManagement/task-${i}.js`
    writeFileSync(join(dir, 'src', 'pointsManagement', `task-${i}.js`), `export const t${i} = ${i}\n`)
    paths.push(rel)
  }
  writeFileSync(join(dir, 'src', 'pointsManagement', 'pointsManagementIndex.vue'), '<style>.rankingName{color:blue}</style>\n')
  paths.push('src/pointsManagement/pointsManagementIndex.vue')
  return paths.map((p) => p.replace(/\//g, '\\') === p ? p : p) // keep posix; canonicalize normalizes
}

describe('resolveTaskChangedFiles 任务边界归因', () => {
  let dir
  let unrelatedHead
  let dirtyPaths

  beforeAll(() => {
    dir = initRepo()
    unrelatedHead = addUnrelatedCommit(dir)
    dirtyPaths = addTaskDirty(dir, 3)
  })

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('T1 纯脏 + startHeadOid==HEAD → 只认脏改动，不含无关提交文件', () => {
    const head = resolveWorkspaceHeadOid(dir)
    expect(head).toBe(unrelatedHead)
    const r = resolveTaskChangedFiles(dir, dirtyPaths, { startHeadOid: head })
    expect(r.provenance.mode).toBe('dirty-only')
    expect(r.paths).toHaveLength(dirtyPaths.length)
    expect(r.paths.some((p) => p.includes('catalog'))).toBe(false)
    expect(r.paths.some((p) => p.includes('itemList'))).toBe(false)
  })

  it('T2 纯脏 + 无 startHeadOid → dirty fallback，同样不含无关提交', () => {
    const r = resolveTaskChangedFiles(dir, dirtyPaths, {})
    expect(r.provenance.mode).toBe('dirty-only')
    expect(r.provenance.note).toMatch(/dirty fallback/)
    expect(r.paths).toHaveLength(dirtyPaths.length)
    expect(r.paths.some((p) => p.includes('catalog'))).toBe(false)
  })

  it('T3 任务内 commit + 脏改动 + startHeadOid → 只含任务文件', () => {
    // 任务起点 = 无关提交
    const start = unrelatedHead
    // 任务内只提交一个新文件（避免把其它脏文件误 commit）
    writeFileSync(join(dir, 'src', 'pointsManagement', 'committed-during-task.js'), 'export const c = 1\n')
    git(dir, 'add', 'src/pointsManagement/committed-during-task.js')
    git(dir, 'commit', '-m', 'feat(task): 任务内提交')
    // 再补一个脏文件
    writeFileSync(join(dir, 'src', 'pointsManagement', 'dirty-after-commit.js'), 'export const d = 1\n')

    const dirty = [
      ...dirtyPaths,
      'src/pointsManagement/dirty-after-commit.js',
    ]
    const r = resolveTaskChangedFiles(dir, dirty, { startHeadOid: start })
    expect(r.provenance.mode).toBe('task-range')
    expect(r.paths).toContain('src/pointsManagement/committed-during-task.js')
    expect(r.paths).toContain('src/pointsManagement/dirty-after-commit.js')
    expect(r.paths).toContain('src/pointsManagement/task-0.js')
    expect(r.paths.some((p) => p.includes('catalog'))).toBe(false)
  })

  it('T4 startHeadOid 不存在 → dirty fallback', () => {
    const r = resolveTaskChangedFiles(dir, ['src/a.js'], { startHeadOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    expect(r.provenance.mode).toBe('dirty-only')
    expect(r.paths).toEqual(['src/a.js'])
  })

  it('T4b startHeadOid 存在但非 HEAD 祖先（串仓/分叉）→ 禁止 tree-diff，只认脏', () => {
    // 造一个与当前 HEAD 分叉的 commit
    const orphan = mkdtempSync(join(tmpdir(), 'awp-chg-orphan-'))
    try {
      // 在同一仓开分叉：从无关基线提交后不合并回来
      git(dir, 'checkout', '-q', '-b', 'diverged-tip')
      writeFileSync(join(dir, 'src', 'diverged-only.js'), 'export const x = 1\n')
      git(dir, 'add', 'src/diverged-only.js')
      git(dir, 'commit', '-m', 'diverged')
      const divergedHead = git(dir, 'rev-parse', 'HEAD')
      git(dir, 'checkout', '-q', 'master')
      // 当前 HEAD 在 master（含任务内提交），start 指向分叉 tip
      const r = resolveTaskChangedFiles(dir, ['src/dirty-only.js'], { startHeadOid: divergedHead })
      expect(r.provenance.note).toMatch(/start-not-ancestor/)
      expect(r.paths).toEqual(['src/dirty-only.js'])
      expect(r.paths.some((p) => p.includes('diverged'))).toBe(false)
      expect(r.paths.some((p) => p.includes('catalog'))).toBe(false)
    } finally {
      rmSync(orphan, { recursive: true, force: true })
    }
  })

  it('T5 无 start、无 dirty → 兼容旧口径（任务 tip 提交）', () => {
    // 当前 HEAD 是任务内提交 committed-during-task.js 相对其父的 diff
    const r = resolveTaskChangedFiles(dir, [], {})
    expect(r.provenance.mode).toBe('legacy-head1')
    expect(r.paths).toContain('src/pointsManagement/committed-during-task.js')
  })

  it('collectTaskChangedFiles 兼容签名返回 string[]', () => {
    const paths = collectTaskChangedFiles(dir, ['src/x.js'], { startHeadOid: resolveWorkspaceHeadOid(dir) })
    expect(Array.isArray(paths)).toBe(true)
    expect(paths).toEqual(['src/x.js'])
  })

  it('AWP_CHANGED_FILES_LEGACY=1 可回退旧口径', () => {
    const prev = process.env.AWP_CHANGED_FILES_LEGACY
    process.env.AWP_CHANGED_FILES_LEGACY = '1'
    try {
      const r = resolveTaskChangedFiles(dir, ['src/x.js'], { startHeadOid: resolveWorkspaceHeadOid(dir) })
      expect(r.provenance.note).toBe('AWP_CHANGED_FILES_LEGACY')
      // 旧口径会并入 HEAD~1..HEAD
      expect(r.paths.length).toBeGreaterThan(1)
    } finally {
      if (prev === undefined) delete process.env.AWP_CHANGED_FILES_LEGACY
      else process.env.AWP_CHANGED_FILES_LEGACY = prev
    }
  })
})

describe('merge 口径不回归', () => {
  it('T6 无 start + merge HEAD + dirty → 只认脏（无可信上游时不整段 merge）', () => {
    const dir = initRepo()
    try {
      // feature 分支改 a
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'a.js'), 'export const a = 2\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'feature-a')
      // master 前进改 b
      git(dir, 'checkout', '-q', 'master')
      writeFileSync(join(dir, 'b.js'), 'export const b = 1\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'master-b')
      git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge')
      writeFileSync(join(dir, 'dirty.js'), 'export const d = 1\n')

      const r = resolveTaskChangedFiles(dir, ['dirty.js'], {})
      expect(r.paths).toEqual(['dirty.js'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('T7 有 startHeadOid 时 merge 仍按任务边界', () => {
    const dir = initRepo()
    try {
      const start = resolveWorkspaceHeadOid(dir)
      git(dir, 'checkout', '-q', '-b', 'feature')
      writeFileSync(join(dir, 'a.js'), 'export const a = 2\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'feature-a')
      git(dir, 'checkout', '-q', 'master')
      writeFileSync(join(dir, 'b.js'), 'export const b = 1\n')
      git(dir, 'add', '-A')
      git(dir, 'commit', '-m', 'master-b')
      git(dir, 'merge', '--no-ff', 'feature', '-m', 'merge')

      const r = resolveTaskChangedFiles(dir, [], { startHeadOid: start })
      expect(r.provenance.mode).toBe('task-range')
      expect(r.paths).toContain('a.js')
      expect(r.paths).toContain('b.js')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
