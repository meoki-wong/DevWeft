/**
 * workspace-isolation.test.mjs — P0-1 隔离 worktree 契约
 *
 * 锁定三条不变量：
 *  1) createIsolatedWorktree 在指定 base commit 上开 detached worktree，**主工作树 HEAD/脏改动零改动**；
 *  2) codeDiff 只落到隔离 worktree，不污染主树；
 *  3) 两个不同 base 并发创建各得其所（验证跨进程锁 + 隔离，不再互相抢改 base）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createIsolatedWorktree, releaseIsolatedWorktree, worktreeIsolationEnabled,
} from '../testing/workspace-pool.mjs'

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', '-c', 'user.name=t', '-c', 'user.email=t@t.local', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

// Windows git worktree checkout 会按 autocrlf 生成 CRLF，比对内容时统一归一化行尾。
function readNf(p) { return readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }

const dirs = []
let repo
let sha1
let sha2

beforeAll(() => {
  const wtRoot = mkdtempSync(join(tmpdir(), 'awp-iso-wt-'))
  dirs.push(wtRoot)
  process.env.AWP_WT_ROOT = wtRoot
  process.env.AWP_WORKTREE_ISOLATION = '1'

  repo = mkdtempSync(join(tmpdir(), 'awp-iso-repo-'))
  dirs.push(repo)
  git(repo, ['init', '-q', '-b', 'master'])
  writeFileSync(join(repo, 'a.txt'), '1\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'c1'])
  sha1 = git(repo, ['rev-parse', 'HEAD'])
  writeFileSync(join(repo, 'a.txt'), '2\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'c2'])
  sha2 = git(repo, ['rev-parse', 'HEAD'])
  // 主工作树留一个脏改动，验证隔离不动它
  writeFileSync(join(repo, 'a.txt'), 'DIRTY-MAIN\n')
})

afterAll(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 尽力 */ } }
})

describe('worktree isolation', () => {
  it('enabled by default; opt-out via AWP_WORKTREE_ISOLATION=0', () => {
    expect(worktreeIsolationEnabled()).toBe(true)
    process.env.AWP_WORKTREE_ISOLATION = '0'
    expect(worktreeIsolationEnabled()).toBe(false)
    process.env.AWP_WORKTREE_ISOLATION = '1'
  })

  it('isolates base checkout and diff to the worktree; main tree untouched', () => {
    const diff = [
      'diff --git a/a.txt b/a.txt',
      'index 0d01d1b..0000000 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-1',
      '+ISO-APPLIED',
      '',
    ].join('\n')
    const prep = createIsolatedWorktree({ repoMainPath: repo, baseSha: sha1, fallbackToDefault: true, codeDiff: diff })
    try {
      expect(prep.workspaceSync.head).toBe(sha1)
      expect(String(prep.workspaceSync.baseVia)).toMatch(/^worktree:baseSha$/)
      // 隔离 worktree：base=sha1 且 diff 已应用
      expect(readNf(join(prep.isoPath, 'a.txt'))).toBe('ISO-APPLIED\n')
      // 主工作树 HEAD 仍是 sha2，脏内容仍是 DIRTY-MAIN（完全没被动过）
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(sha2)
      expect(readNf(join(repo, 'a.txt'))).toBe('DIRTY-MAIN\n')
    } finally {
      releaseIsolatedWorktree({ repoMainPath: repo, isoPath: prep.isoPath })
    }
    // 释放后 worktree 目录与元数据消失
    expect(() => readFileSync(join(prep.isoPath, 'a.txt'), 'utf8')).toThrow()
  })

  it('two concurrent isolated submissions on different bases do not clobber each other', () => {
    const a = createIsolatedWorktree({ repoMainPath: repo, baseSha: sha1, fallbackToDefault: true })
    let b = null
    try {
      b = createIsolatedWorktree({ repoMainPath: repo, baseSha: sha2, fallbackToDefault: true })
      expect(readNf(join(a.isoPath, 'a.txt'))).toBe('1\n')
      expect(readNf(join(b.isoPath, 'a.txt'))).toBe('2\n')
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(sha2)
      expect(readNf(join(repo, 'a.txt'))).toBe('DIRTY-MAIN\n')
    } finally {
      releaseIsolatedWorktree({ repoMainPath: repo, isoPath: a.isoPath })
      if (b) releaseIsolatedWorktree({ repoMainPath: repo, isoPath: b.isoPath })
    }
  })
})
