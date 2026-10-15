/**
 * workspace-diff-apply.test.mjs — 跨机器 diff 送测的门禁侧原语
 *
 * 覆盖 2026-09-24 新增能力：AI 在无插件、异机开发时，通过 awp_test_run 上传 `git diff` + base SHA，
 * 门禁侧 fetch → 对齐 base → 应用 diff → 脏区快照。本文件用真实临时 git 仓验证四个原语：
 *   applyWorkspaceDiff / ensurePristineWorkspace / alignWorkspaceBase / prefetchOrigin
 * 关键安全边界：不静默测错 base、不删 gitignore 依赖、不泄漏 secret、复位防污染。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, afterEach } from 'vitest'
import {
  applyWorkspaceDiff, ensurePristineWorkspace, alignWorkspaceBase, prefetchOrigin,
  buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp,
} from '../testing/snapshots.js'

const cleanups = []
afterEach(() => { while (cleanups.length) cleanups.pop()() })

// 原始输出（不 trim，保留补丁精确字节）；大 diff 提高 maxBuffer
function git(dir, ...args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], {
    cwd: dir, encoding: 'utf8', maxBuffer: 1e8,
  })
}
function gitT(dir, ...args) { return git(dir, ...args).trim() }

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'awp-diff-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  gitT(dir, 'init')
  gitT(dir, 'config', 'user.email', 't@t')
  gitT(dir, 'config', 'user.name', 't')
  gitT(dir, 'config', 'commit.gpgsign', 'false')
  gitT(dir, 'config', 'core.autocrlf', 'false')
  const branch = gitT(dir, 'symbolic-ref', '--short', 'HEAD')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\ndist/\n')
  writeFileSync(join(dir, 'app.txt'), 'base-v1\n')
  gitT(dir, 'add', '-A')
  gitT(dir, 'commit', '-m', 'c1')
  const base = gitT(dir, 'rev-parse', 'HEAD')
  return { dir, base, branch }
}

describe('applyWorkspaceDiff', () => {
  it('应用已跟踪文件的修改，工作树反映改动，返回指纹与文件清单', () => {
    const { dir } = initRepo()
    writeFileSync(join(dir, 'app.txt'), 'base-v1\nadded-line\n')
    const diff = git(dir, 'diff')
    ensurePristineWorkspace(dir) // 模拟门禁收到 diff 前工作树纯净
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\n')

    const r = applyWorkspaceDiff(dir, diff)
    expect(r.applied).toBe(true)
    expect(r.fileCount).toBe(1)
    expect(r.appliedPaths).toContain('app.txt')
    expect(r.diffSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toContain('added-line')
    // 应用后工作树变脏 → 交由 buildDirtyWorkspaceSnapshot 冻结
    expect(gitT(dir, 'status', '--porcelain')).toMatch(/app\.txt/)
  })

  it('应用新文件（git add -N 生成的 diff 含新增文件）', () => {
    const { dir } = initRepo()
    writeFileSync(join(dir, 'new.vue'), '<template>new</template>\n')
    gitT(dir, 'add', '-N', 'new.vue')
    const diff = git(dir, 'diff')
    ensurePristineWorkspace(dir)
    expect(existsSync(join(dir, 'new.vue'))).toBe(false) // clean -fd 删除未跟踪(非 ignore)文件

    const r = applyWorkspaceDiff(dir, diff)
    expect(r.appliedPaths).toContain('new.vue')
    expect(readFileSync(join(dir, 'new.vue'), 'utf8')).toContain('new')
  })

  it('拒绝空 / 畸形 / secret 路径 / base 不匹配的 diff（显式错误码）', () => {
    const { dir } = initRepo()
    expect(() => applyWorkspaceDiff(dir, '')).toThrow(/SOURCE_DIFF_EMPTY/)
    expect(() => applyWorkspaceDiff(dir, '   \n  ')).toThrow(/SOURCE_DIFF_EMPTY/)
    expect(() => applyWorkspaceDiff(dir, 'this is not a patch')).toThrow(/SOURCE_DIFF_MALFORMED/)

    const secretDiff = [
      'diff --git a/.env b/.env', 'new file mode 100644', '--- /dev/null', '+++ b/.env',
      '@@ -0,0 +1 @@', '+SECRET=1', '',
    ].join('\n')
    expect(() => applyWorkspaceDiff(dir, secretDiff)).toThrow(/SECRET_FILES_DETECTED/)

    // 上下文与 base 不符 → --check 阶段原子失败，不落半截改动
    const badDiff = [
      'diff --git a/app.txt b/app.txt', '--- a/app.txt', '+++ b/app.txt',
      '@@ -1 +1 @@', '-completely-different-content', '+x', '',
    ].join('\n')
    expect(() => applyWorkspaceDiff(dir, badDiff)).toThrow(/SOURCE_DIFF_APPLY_FAILED/)
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\n') // 未被污染
  })

  it('超过大小上限拒绝（SOURCE_DIFF_TOO_LARGE）', () => {
    const { dir } = initRepo()
    const diff = git(dir, 'diff') // 空改动也接受形状校验前先撞大小
    const big = `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+${'y'.repeat(200)}\n`
    expect(() => applyWorkspaceDiff(dir, big, { maxBytes: 32 })).toThrow(/SOURCE_DIFF_TOO_LARGE/)
    expect(typeof diff).toBe('string')
  })
})

describe('ensurePristineWorkspace', () => {
  it('复位已跟踪改动、删除未跟踪文件、保留 gitignore 依赖', () => {
    const { dir } = initRepo()
    writeFileSync(join(dir, 'app.txt'), 'dirty\n')
    writeFileSync(join(dir, 'stray.txt'), 'stray\n')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'dep.js'), 'keep-me')

    ensurePristineWorkspace(dir)
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\n') // 已跟踪恢复
    expect(existsSync(join(dir, 'stray.txt'))).toBe(false)               // 未跟踪删除
    expect(existsSync(join(dir, 'node_modules', 'dep.js'))).toBe(true)   // ignore 保留
  })

  it('复位后二次应用同一 diff 幂等（不叠加、不残留）', () => {
    const { dir } = initRepo()
    writeFileSync(join(dir, 'app.txt'), 'base-v1\nadded-line\n')
    const diff = git(dir, 'diff')

    // 真实流程：apply 前必先 ensurePristine（门禁工作树不应有合法未提交改动，改动只经 diff 传入）
    ensurePristineWorkspace(dir)
    applyWorkspaceDiff(dir, diff)
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\nadded-line\n')

    ensurePristineWorkspace(dir) // 快照后复位
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\n')

    const r2 = applyWorkspaceDiff(dir, diff) // 再次干净应用
    expect(r2.fileCount).toBe(1)
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\nadded-line\n')
  })
})

describe('alignWorkspaceBase', () => {
  it('baseSha 命中 → baseVia=baseSha 并 checkout 到该 commit', () => {
    const { dir, base } = initRepo()
    writeFileSync(join(dir, 'app.txt'), 'v2\n')
    gitT(dir, 'add', '-A')
    gitT(dir, 'commit', '-m', 'c2')
    expect(gitT(dir, 'rev-parse', 'HEAD')).not.toBe(base)

    const r = alignWorkspaceBase(dir, { baseSha: base })
    expect(r.baseVia).toBe('baseSha')
    expect(gitT(dir, 'rev-parse', 'HEAD')).toBe(base)
  })

  it('未知 baseSha + fallbackToDefault → 回退默认分支（不静默测错、baseVia 标注来源）', () => {
    const { dir, branch } = initRepo()
    const r = alignWorkspaceBase(dir, {
      baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', fallbackToDefault: true,
    })
    expect(r.baseVia).toMatch(/^default:(master|main)$/)
    expect(gitT(dir, 'rev-parse', 'HEAD')).toBe(gitT(dir, 'rev-parse', branch))
  })

  it('无 diff 场景（fallbackToDefault=false）baseSha 不可达即抛错，禁止静默回落', () => {
    const { dir } = initRepo()
    expect(() => alignWorkspaceBase(dir, {
      baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', fallbackToDefault: false,
    })).toThrow(/SYNC_REF_NOT_FOUND/)
  })

  it('未声明任何目标 → baseVia=current，维持当前工作区不 checkout', () => {
    const { dir, base } = initRepo()
    const r = alignWorkspaceBase(dir, {})
    expect(r.baseVia).toBe('current')
    expect(r.synced).toBe(false)
    expect(r.head).toBe(base)
  })
})

describe('prefetchOrigin', () => {
  it('无 origin 时非致命（返回 ok:false + 诊断），不抛错阻断下单', () => {
    const { dir } = initRepo()
    const r = prefetchOrigin(dir)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/fetch/)
  })
})

describe('端到端：对齐 base → 应用 diff → 脏区快照', () => {
  it('快照树 = base + AI 改动（含新文件），head 仍为 base，产出 bundle；复位后回纯净', () => {
    const { dir, base } = initRepo()
    // —— AI 侧（异机）：改动 + 生成含新文件的 diff + 报 base HEAD ——
    writeFileSync(join(dir, 'app.txt'), 'base-v1\nfeature-line\n')
    writeFileSync(join(dir, 'extra.js'), 'export const x = 1\n')
    gitT(dir, 'add', '-N', 'extra.js')
    const diff = git(dir, 'diff')
    const baseSha = base

    // —— 门禁侧：复位 → 对齐 baseSha → 应用 diff → 脏区快照 ——
    ensurePristineWorkspace(dir)
    const ws = alignWorkspaceBase(dir, { baseSha })
    expect(ws.baseVia).toBe('baseSha')
    expect(gitT(dir, 'rev-parse', 'HEAD')).toBe(baseSha)
    const receipt = applyWorkspaceDiff(dir, diff)
    expect(receipt.appliedPaths.slice().sort()).toEqual(['app.txt', 'extra.js'])

    const snap = buildDirtyWorkspaceSnapshot(dir, { withBundle: true })
    try {
      expect(snap.headCommitOid).toBe(baseSha)                       // base 未变（diff 是脏改动）
      expect(snap.dirty).toBe(true)                                  // 工作树脏
      expect(snap.changedPaths.slice().sort()).toEqual(['app.txt', 'extra.js']) // 快照捕获改动
      expect(snap.snapshotTreeOid).toMatch(/^[a-f0-9]{40}$/)
      expect(snap.snapshotTreeOid).not.toBe(gitT(dir, 'rev-parse', 'HEAD^{tree}')) // 树 != base 树
      expect(snap.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(snap.bundleSize).toBeGreaterThan(0)
    } finally {
      cleanupSnapshotTmp(snap)
      ensurePristineWorkspace(dir) // 模拟 submit-run finally 复位
    }
    // 复位后工作树回到纯净 base（不污染下一次提交）
    expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('base-v1\n')
    expect(existsSync(join(dir, 'extra.js'))).toBe(false)
  })
})
