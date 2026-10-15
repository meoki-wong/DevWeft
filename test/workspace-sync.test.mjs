import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { syncWorkspaceToRef } from '../testing/snapshots.js'

function git(dir, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], { cwd: dir, encoding: 'utf8' }).trim()
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-sync-'))
  git(dir, 'init')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  const base = git(dir, 'symbolic-ref', '--short', 'HEAD')
  writeFileSync(join(dir, 'a.txt'), 'v1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'c1')
  git(dir, 'checkout', '-q', '-b', 'feature-fix')
  writeFileSync(join(dir, 'a.txt'), 'v2-feature\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'c2-feature')
  git(dir, 'checkout', '-q', base)
  writeFileSync(join(dir, 'a.txt'), 'v1-base-dirty\n')
  return { dir, base }
}

describe('syncWorkspaceToRef', () => {
  it('未声明 ref 时跳过', () => {
    const { dir } = initRepo()
    const r = syncWorkspaceToRef(dir, {})
    expect(r.synced).toBe(false)
    expect(r.detail).toMatch(/跳过/)
  })

  it('对齐到本地 feature 分支（脏改动 stash）', () => {
    const { dir } = initRepo()
    const r = syncWorkspaceToRef(dir, { ref: 'feature-fix' })
    expect(r.synced).toBe(true)
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-fix')
    expect(git(dir, 'show', 'HEAD:a.txt')).toContain('v2-feature')
    expect(r.stashRef).toBeTruthy()
  })

  it('对齐到本地 commit', () => {
    const { dir } = initRepo()
    const sha = git(dir, 'rev-parse', 'feature-fix')
    const r = syncWorkspaceToRef(dir, { commitOid: sha })
    expect(r.synced).toBe(true)
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha)
  })

  it('已是目标时 synced=false', () => {
    const { dir } = initRepo()
    git(dir, 'checkout', '-q', '-f', 'feature-fix')
    const r = syncWorkspaceToRef(dir, { ref: 'feature-fix' })
    expect(r.synced).toBe(false)
  })
})
