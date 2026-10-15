/**
 * testing/workspace-pool.mjs — 门禁下单的 base 工作区隔离（P0-1，主备切换方案 A 加固）
 *
 * 背景：submitGateRun 原先直接在多进程共享的 repository workspace上
 *   fetch → reset/clean(ensurePristineWorkspace) → checkout(alignWorkspaceBase) → apply(diff) → snapshot。
 * 主机 direct submit（agent-workflow-platform 进程）、drain（awp-host-worker 进程）与并发 lane 会同时改同一目录，
 * 互相把 base checkout 到不同 commit → apply 上下文错乱（SOURCE_DIFF_APPLY_FAILED）、快照基线漂移。
 *
 * 方案：每次下单在「显式 base commit」上开一个 detached git worktree，checkout/apply/snapshot 全部在该
 *   隔离工作树内完成，绝不触碰共享主工作树。仅对会改共享状态的临界区（fetch 与 worktree add/remove）
 *   用跨进程目录锁串行（毫秒级）；apply/snapshot 在各 worktree 内并行。base 由 codeCommitOid 钉死，
 *   从根本上消除「工作树到底停在哪个 commit」的歧义。
 *
 * 回退：AWP_WORKTREE_ISOLATION=0 时 submitGateRun 走原原地路径（灰度/排障）。
 *
 * 约束：同步实现（与 snapshots.js 一致，调用方已 execFileSync 阻塞），短临界区可接受忙等。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ApiError } from './errors.js'
import { prefetchOrigin, applyWorkspaceDiff } from './snapshots.js'

const LOCK_STALE_MS = Number(process.env.AWP_WT_LOCK_STALE_MS || 120000)
const LOCK_WAIT_MS = Number(process.env.AWP_WT_LOCK_WAIT_MS || 90000)

/** 默认开启；仅显式 AWP_WORKTREE_ISOLATION=0 关闭回退到原地路径。 */
export function worktreeIsolationEnabled() {
  return String(process.env.AWP_WORKTREE_ISOLATION || '').trim() !== '0'
}

function gitFor(repoPath, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitTry(repoPath, args) {
  try { return { ok: true, out: gitFor(repoPath, args) } }
  catch (e) { return { ok: false, err: String((e && (e.stderr || e.message)) || e) } }
}

function fail(code, detail, httpStatus) {
  const e = new ApiError(code, { detail })
  if (httpStatus) e.httpStatus = httpStatus
  return e
}

function waitMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 跨进程目录锁（mkdir 原子）：主仓解析后取稳定 key；owner.txt 供陈旧判定。 */
function lockDirFor(repoMainPath) {
  let real = repoMainPath
  try { real = fs.realpathSync(repoMainPath) } catch { /* 用原值 */ }
  const key = createHash('sha1').update(real).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `awp-wtlock-${key}.lock`)
}

function acquireLock(dir) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try { fs.mkdirSync(dir); break }
    catch (e) {
      if (e.code !== 'EEXIST') throw e
      let stale = true
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.txt'), 'utf8'))
        stale = Date.now() - Number(owner.t || 0) > LOCK_STALE_MS
      } catch {
        try { stale = Date.now() - fs.statSync(dir).mtimeMs > LOCK_STALE_MS } catch { stale = true }
      }
      if (stale) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 竞态再试 */ } ; continue }
      if (Date.now() > deadline) throw fail('WORKSPACE_LOCK_TIMEOUT', '等待门禁工作区锁超时（并发下单过多），请稍后重试。', 503)
      waitMs(60)
    }
  }
  try { fs.writeFileSync(path.join(dir, 'owner.txt'), JSON.stringify({ pid: process.pid, t: Date.now() })) } catch { /* 尽力 */ }
  return dir
}

function releaseLock(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 幂等 */ }
}

/** 在锁内执行 fn；无论成败都释放。用于 fetch / worktree add / worktree remove 三类临界区。 */
function withRepoLock(repoMainPath, fn) {
  const dir = lockDirFor(repoMainPath)
  acquireLock(dir)
  try { return fn() } finally { releaseLock(dir) }
}

/**
 * 按 baseSha → branch → 默认分支(master,main) → 当前 HEAD 优先级，把 base 解析成可达 commit oid。
 * 与 alignWorkspaceBase 同序，但**只解析、不 checkout**（隔离模式在 worktree 上 checkout，主树不动）。
 * @returns {{ oid: string, via: string, prefetch: {ok:boolean,detail:string}|null }}
 */
function resolveBaseCommitOid(repoMainPath, { baseSha, branch, fallbackToDefault }) {
  let prefetch = null
  const reachable = (rev) => {
    const r = gitTry(repoMainPath, ['rev-parse', '--verify', `${rev}^{commit}`])
    return r.ok ? r.out : null
  }
  if (baseSha && /^[a-f0-9]{7,40}$/i.test(String(baseSha))) {
    let oid = reachable(baseSha)
    if (!oid) {
      // 临界区：fetch 改共享 object DB / refs
      prefetch = withRepoLock(repoMainPath, () => {
        prefetchOrigin(repoMainPath)
        const f = gitTry(repoMainPath, ['fetch', '--no-tags', 'origin', String(baseSha)])
        return f.ok ? { ok: true, detail: `fetch origin ${String(baseSha).slice(0, 12)} 完成` }
          : { ok: false, detail: `fetch origin commit 跳过（不致命）：${f.err.slice(0, 200)}` }
      })
      oid = reachable(baseSha)
    }
    if (oid) return { oid, via: 'baseSha', prefetch }
    if (!fallbackToDefault) throw fail('SYNC_REF_NOT_FOUND', `base commit ${String(baseSha).slice(0, 12)} 本地/origin 均不可达。`, 409)
  }
  if (branch) {
    const r = String(branch).replace(/^refs\/heads\//, '')
    let oid = reachable(`refs/heads/${r}`) || reachable(`refs/remotes/origin/${r}`)
    if (!oid) {
      withRepoLock(repoMainPath, () => gitTry(repoMainPath, ['fetch', '--no-tags', 'origin', `${r}:refs/remotes/origin/${r}`]))
      oid = reachable(`refs/remotes/origin/${r}`) || reachable(`refs/heads/${r}`)
    }
    if (oid) return { oid, via: 'branch', prefetch }
    if (!fallbackToDefault) throw fail('SYNC_REF_NOT_FOUND', `分支 ${r} 本地/origin 均不可达。`, 409)
  }
  if (fallbackToDefault) {
    for (const d of ['master', 'main']) {
      const oid = reachable(`refs/heads/${d}`) || reachable(`refs/remotes/origin/${d}`)
      if (oid) return { oid, via: `default:${d}`, prefetch }
    }
  }
  const head = reachable('HEAD')
  if (head) return { oid: head, via: 'current', prefetch }
  throw fail('SYNC_REF_NOT_FOUND', 'base 不可达：baseSha/branch/默认分支/当前 HEAD 均无法解析。', 409)
}

function worktreeRoot() {
  const envRoot = String(process.env.AWP_WT_ROOT || '').trim()
  if (envRoot) return envRoot
  // 默认短路径，规避 Windows 长路径；可用 AWP_WT_ROOT 覆盖
  return process.platform === 'win32' ? 'C:\\awp-wt' : path.join(os.tmpdir(), 'awp-wt')
}

/**
 * 在隔离 detached worktree 上准备 base（可选再 apply diff）。主工作树全程不被 checkout/apply。
 * @returns {{ isoPath: string, workspaceSync: object, prefetch: object|null, diffReceipt: object|null, repoMainPath: string }}
 */
export function createIsolatedWorktree({ repoMainPath, baseSha = null, branch = null, fallbackToDefault = false, codeDiff = null }) {
  const { oid, via, prefetch } = resolveBaseCommitOid(repoMainPath, { baseSha, branch, fallbackToDefault })
  const root = worktreeRoot()
  fs.mkdirSync(root, { recursive: true })
  const isoPath = path.join(root, `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`)
  // 临界区：worktree add 写主仓 .git/worktrees 元数据 + checkout
  withRepoLock(repoMainPath, () => {
    try { gitFor(repoMainPath, ['worktree', 'add', '--detach', isoPath, oid]) }
    catch (e) { throw fail('WORKTREE_ADD_FAILED', `隔离工作树创建失败：${String((e && (e.stderr || e.message)) || e).slice(0, 240)}`, 503) }
  })
  const workspaceSync = {
    ok: true, synced: true, head: oid, target: oid, baseVia: `worktree:${via}`,
    detail: `隔离 worktree @${oid.slice(0, 12)} (via ${via})`, stashRef: null,
  }
  let diffReceipt = null
  // 非临界区：apply 与后续 snapshot 都在 isoPath 内并行，互不干扰
  if (typeof codeDiff === 'string' && codeDiff.trim()) {
    diffReceipt = applyWorkspaceDiff(isoPath, codeDiff)
  }
  return { isoPath, workspaceSync, prefetch, diffReceipt, repoMainPath }
}

/** 释放隔离 worktree：锁内 git worktree remove；失败退回 prune + 强删目录。 */
export function releaseIsolatedWorktree({ repoMainPath, isoPath }) {
  if (!isoPath) return
  try {
    withRepoLock(repoMainPath, () => {
      try { gitFor(repoMainPath, ['worktree', 'remove', '--force', isoPath]) }
      catch { gitTry(repoMainPath, ['worktree', 'prune', '-v']) }
    })
  } catch { /* 锁/删除失败兜底下面强删 */ }
  try { if (fs.existsSync(isoPath)) fs.rmSync(isoPath, { recursive: true, force: true }) } catch { /* 尽力 */ }
}

/** 崩溃残留回收：清理陈旧 worktree 目录 + git worktree prune。host-worker 每 tick 轻调一次。 */
export function gcIsolatedWorktrees(repoMainPath) {
  try {
    withRepoLock(repoMainPath, () => { gitTry(repoMainPath, ['worktree', 'prune', '-v']) })
  } catch { /* 锁占用时跳过本轮 */ }
  try {
    const root = worktreeRoot()
    if (!fs.existsSync(root)) return 0
    const now = Date.now()
    let removed = 0
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name)
      try {
        const st = fs.statSync(p)
        if (!st.isDirectory()) continue
        if (now - st.mtimeMs > LOCK_STALE_MS * 3) { fs.rmSync(p, { recursive: true, force: true }); removed += 1 }
      } catch { /* 跳过单个 */ }
    }
    return removed
  } catch { return 0 }
}

/** P1-A：备用机落 deferred 前的 diff 结构预校验开关（默认开，AWP_DEFERRED_APPLY_CHECK=0 关）。 */
export function deferredApplyCheckEnabled() {
  return String(process.env.AWP_DEFERRED_APPLY_CHECK || '').trim() !== '0'
}

/**
 * 用 `git apply --stat` 仅解析补丁结构（无需 base 工作树）：
 * corrupt/截断 hunk → 非零退出 → 立即抛 permanent 错，避免"伪装 DEFERRED 成功后延迟到主机 drain 才失败"。
 * 只做结构校验，内容/ base 匹配仍由主机 drain 在钉死 base 的隔离 worktree 上 apply --check 判定。
 */
export function assertDiffParseable(diffText) {
  if (typeof diffText !== 'string' || !diffText.trim()) {
    const e = fail('SOURCE_DIFF_EMPTY', 'codeDiff 为空。', 400); e.permanent = true; throw e
  }
  const root = worktreeRoot()
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.mkdtempSync(path.join(root, 'parse-'))
  const patchFile = path.join(dir, 'p.patch')
  try {
    fs.writeFileSync(patchFile, diffText, 'utf8')
    gitFor(dir, ['init', '-q'])
    try { gitFor(dir, ['apply', '--stat', patchFile]) }
    catch (e) {
      const msg = String((e && (e.stderr || e.message)) || e || '')
      const err = fail(
        'SOURCE_DIFF_CORRUPT',
        `codeDiff 结构损坏，git 无法解析：${msg.replace(/\s+/g, ' ').trim().slice(0, 240)}。请用 git diff 原样生成、保留结尾换行与上下文行（勿手改转义、勿 --ignore-all-space）。`,
        400,
      )
      err.permanent = true
      throw err
    }
    return true
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力 */ }
  }
}
