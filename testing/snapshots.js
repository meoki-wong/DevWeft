import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { canonicalize, documentSha256 } from '../contracts/version.mjs'
import { ApiError } from './errors.js'
import { assertNoSecretPaths } from './secret-scan.js'

const SNAPSHOT_NAME = 'AWP Test Snapshot'
const SNAPSHOT_EMAIL = 'noreply@agent-workflow.invalid'
const SNAPSHOT_MESSAGE = 'awp-test snapshot v1'

function git(repoPath, args, env = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], {
    cwd: repoPath,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    // 捕获（而非透传）子进程 stderr：git 把探测性 fatal / CRLF 警告 / detached-HEAD advice 写到 stderr，
    // 默认会冒泡到进程 stderr → 污染 PM2 错误日志；这里 pipe 掉，出错时仍可从 err.stderr 取信息
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function realGit(repoPath, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=nul', ...args], {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

export function canonicalizeChangedPaths(paths) {
  const out = []
  for (const raw of paths) {
    let p = String(raw).replace(/\\/g, '/')
    p = p.normalize('NFC')
    if (p.startsWith('/') || p.includes('..')) throw new ApiError('INVALID_SCHEMA')
    out.push(p)
  }
  out.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const unique = [...new Set(out)]
  return { paths: unique, sha256: documentSha256(unique) }
}

function initTempGit(tmpRoot, repoPath) {
  const gitDir = path.join(tmpRoot, 'git')
  fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true })
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true })
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/snapshot\n')
  const objectsAbs = path.resolve(repoPath, realGit(repoPath, ['rev-parse', '--git-path', 'objects'])).replace(/\\/g, '/')
  fs.writeFileSync(path.join(gitDir, 'objects', 'info', 'alternates'), `${objectsAbs}\n`)
  return {
    GIT_DIR: gitDir,
    GIT_WORK_TREE: path.resolve(repoPath),
    GIT_INDEX_FILE: path.join(tmpRoot, 'index'),
  }
}

function buildOnce(repoPath, tmpRoot) {
  const env = initTempGit(tmpRoot, repoPath)
  const parent = realGit(repoPath, ['rev-parse', 'HEAD'])
  let sourceRef = 'HEAD'
  try { sourceRef = realGit(repoPath, ['symbolic-ref', '-q', 'HEAD']) } catch { /* detached HEAD */ }
  const dirty = Boolean(realGit(repoPath, ['status', '--porcelain', '-z']))
  git(repoPath, ['read-tree', parent], env)
  git(repoPath, ['add', '-A'], env)
  const treeOid = git(repoPath, ['write-tree'], env)
  const names = git(repoPath, ['diff', '--name-only', parent, treeOid], env)
  const changed = names ? names.split(/\r?\n/).filter(Boolean) : []
  const { sha256: changedPathsSha256, paths } = canonicalizeChangedPaths(changed)
  const parentTime = Number(realGit(repoPath, ['log', '-1', '--format=%ct', 'HEAD']))
  const commitEnv = {
    ...env,
    GIT_AUTHOR_NAME: SNAPSHOT_NAME,
    GIT_AUTHOR_EMAIL: SNAPSHOT_EMAIL,
    GIT_COMMITTER_NAME: SNAPSHOT_NAME,
    GIT_COMMITTER_EMAIL: SNAPSHOT_EMAIL,
    GIT_AUTHOR_DATE: `${parentTime + 1} +0000`,
    GIT_COMMITTER_DATE: `${parentTime + 1} +0000`,
  }
  const snapshotCommitOid = git(repoPath, ['commit-tree', treeOid, '-p', parent, '-m', SNAPSHOT_MESSAGE], commitEnv)
  return {
    headCommitOid: parent,
    sourceRef,
    dirty,
    snapshotTreeOid: treeOid,
    snapshotCommitOid,
    changedPathsSha256,
    changedPaths: paths,
    env,
  }
}

function defaultSnapshotTmp() {
  const base = process.env.LOCALAPPDATA || os.homedir()
  return path.join(base, 'awp-test', 'tmp', randomUUID())
}

export function buildDirtyWorkspaceSnapshot(repoPath, { tmpRoot, maxRounds = 3, withBundle = false } = {}) {
  // Git 实际工作树根目录（含链接解析），不把调用方路径声明当成服务端来源事实。
  repoPath = fs.realpathSync(realGit(repoPath, ['rev-parse', '--show-toplevel']))
  const root = tmpRoot || defaultSnapshotTmp()
  fs.mkdirSync(root, { recursive: true })
  let completed = false
  try {
    let last = null
    for (let round = 0; round < maxRounds; round += 1) {
      const aDir = path.join(root, `a-${round}`)
      const bDir = path.join(root, `b-${round}`)
      fs.mkdirSync(aDir, { recursive: true })
      fs.mkdirSync(bDir, { recursive: true })
      const a = buildOnce(repoPath, aDir)
      const b = buildOnce(repoPath, bDir)
      if (a.headCommitOid === b.headCommitOid && a.sourceRef === b.sourceRef && a.dirty === b.dirty
        && a.snapshotTreeOid === b.snapshotTreeOid && a.changedPathsSha256 === b.changedPathsSha256) {
        last = a
        break
      }
      last = null
    }
    if (!last) throw new ApiError('WORKSPACE_CHANGED_DURING_SNAPSHOT')
    assertNoSecretPaths(last.changedPaths)
    const out = {
      workspacePath: repoPath,
      sourceRef: last.sourceRef,
      dirty: last.dirty,
      headCommitOid: last.headCommitOid,
      snapshotTreeOid: last.snapshotTreeOid,
      snapshotCommitOid: last.snapshotCommitOid,
      changedPathsSha256: last.changedPathsSha256,
      changedPaths: last.changedPaths,
    }
    if (withBundle) {
      const bundlePath = path.join(root, 'snapshot.bundle')
      git(repoPath, ['update-ref', 'refs/awp/snapshot', last.snapshotCommitOid], last.env)
      git(repoPath, ['bundle', 'create', bundlePath, 'refs/awp/snapshot'], last.env)
      const buf = fs.readFileSync(bundlePath)
      out.bundleSha256 = createHash('sha256').update(buf).digest('hex')
      out.bundleSize = buf.length
      out.bundlePath = bundlePath
    }
    completed = true
    return out
  } finally {
    if (!withBundle || !completed) fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 判断 oid 是否为本仓可达 commit */
function isCommitOid(repoPath, oid) {
  try {
    realGit(repoPath, ['cat-file', '-e', `${oid}^{commit}`])
    return true
  } catch {
    return false
  }
}

/** maybeAncestor 是否为 rev 的祖先（含相等） */
function isAncestorOrSame(repoPath, maybeAncestor, rev) {
  try {
    const a = realGit(repoPath, ['rev-parse', String(maybeAncestor)])
    const b = realGit(repoPath, ['rev-parse', String(rev)])
    if (a === b) return true
    // merge-base --is-ancestor 成功（exit 0）才是祖先；非 0 由 execFileSync 抛出
    realGit(repoPath, ['merge-base', '--is-ancestor', a, b])
    return true
  } catch {
    return false
  }
}

function diffNameOnly(repoPath, range) {
  try {
    const names = realGit(repoPath, ['diff', '--name-only', ...range])
    return names ? names.split(/\r?\n/).filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * 兼容口径下的已提交改动窗口（仅在「无任务起点」时使用）。
 * merge：与上游 merge-base..HEAD（无可信上游 → null，宁可少算）；普通：HEAD~1..HEAD。
 */
function legacyCommittedRange(repoPath) {
  try {
    let isMerge = false
    try {
      const ps = realGit(repoPath, ['rev-list', '--no-walk', '--parents', 'HEAD']).split(/\s+/).filter(Boolean)
      isMerge = ps.length > 2
    } catch { isMerge = false }
    if (isMerge) {
      let base = null
      for (const up of ['@{u}', 'origin/HEAD', 'origin/master', 'origin/main']) {
        try { base = realGit(repoPath, ['merge-base', up, 'HEAD']) || null } catch { base = null }
        if (base) break
      }
      return base ? [base, 'HEAD'] : null
    }
    // HEAD 无父（初始提交/浅克隆）时 HEAD~1 不存在 → 保持历史容错为空
    realGit(repoPath, ['rev-parse', 'HEAD~1'])
    return ['HEAD~1', 'HEAD']
  } catch {
    return null
  }
}

/**
 * 解析本任务改动文件全集 + 来源分解。
 *
 * changedFiles = 脏改动(changedPaths) ∪ 任务边界内已提交改动。
 * 任务边界优先用 startHeadOid（harness_start 时的 HEAD）：
 *   - startHeadOid == HEAD → 已提交集为空（纯脏任务，不把 HEAD 上无关历史提交算进来）
 *   - 否则 committed = diff(startHeadOid, HEAD)，只含任务创建后的提交
 *
 * 无 startHeadOid 时：
 *   - dirty 非空 → 只认脏改动（脏区交付约定；避免 HEAD~1 无关提交归因污染）
 *   - dirty 空   → 兼容旧口径（merge-base / HEAD~1..HEAD），仅作纯提交交付兜底
 *
 * 紧急回退：AWP_CHANGED_FILES_LEGACY=1 强制旧 HEAD~1..HEAD 口径。
 *
 * @returns {{ paths: string[], provenance: object }}
 */
export function resolveTaskChangedFiles(repoPath, changedPaths = [], opts = {}) {
  const dirty = Array.isArray(changedPaths) ? changedPaths : []
  const startHeadOid = opts?.startHeadOid || null
  const legacy = process.env.AWP_CHANGED_FILES_LEGACY === '1'

  let committed = []
  let mode = 'dirty-only'
  let committedRange = null
  let note = ''

  if (legacy) {
    const range = legacyCommittedRange(repoPath)
    mode = range ? (range[0] === 'HEAD~1' ? 'legacy-head1' : 'merge-base') : 'dirty-only'
    committedRange = range ? range.join('..') : null
    note = 'AWP_CHANGED_FILES_LEGACY'
    if (range) committed = diffNameOnly(repoPath, range)
  } else if (startHeadOid && isCommitOid(repoPath, startHeadOid)) {
    const start = realGit(repoPath, ['rev-parse', String(startHeadOid)])
    const head = safeHead(repoPath)
    if (head && start === head) {
      mode = 'dirty-only'
      note = 'start==HEAD'
    } else if (head && isAncestorOrSame(repoPath, start, head)) {
      // start 是 HEAD 祖先：只含任务创建后的提交
      mode = 'task-range'
      committedRange = `${start.slice(0, 12)}..${head.slice(0, 12)}`
      note = 'task-boundary'
      committed = diffNameOnly(repoPath, [start, 'HEAD'])
    } else {
      // start 不在 HEAD 祖先链（串仓记错 / HEAD 回退 / 分叉）：两点 tree-diff 会误并无关文件，宁可少算
      mode = dirty.length > 0 ? 'dirty-only' : 'legacy-head1'
      note = 'start-not-ancestor-of-HEAD, skip task-range'
      if (dirty.length === 0) {
        const range = legacyCommittedRange(repoPath)
        if (range) {
          mode = range[0] === 'HEAD~1' ? 'legacy-head1' : 'merge-base'
          committedRange = range.join('..')
          committed = diffNameOnly(repoPath, range)
        } else {
          mode = 'dirty-only'
          note = 'start-not-ancestor-of-HEAD, no-committed-range'
        }
      }
    }
  } else if (dirty.length > 0) {
    // 脏区交付主路径：禁止再并 HEAD~1（会把分支上无关历史提交算进本任务）
    mode = 'dirty-only'
    note = 'dirty fallback, skip HEAD~1'
  } else {
    const range = legacyCommittedRange(repoPath)
    if (range) {
      mode = range[0] === 'HEAD~1' ? 'legacy-head1' : 'merge-base'
      committedRange = range.join('..')
      note = 'legacy committed tip'
      committed = diffNameOnly(repoPath, range)
    } else {
      note = 'no-committed-range'
    }
  }

  const { paths } = canonicalizeChangedPaths([...dirty, ...committed])
  return {
    paths,
    provenance: {
      mode,
      dirtyCount: dirty.length,
      committedCount: committed.length,
      committedRange,
      startHeadOid: startHeadOid || null,
      note,
      totalCount: paths.length,
    },
  }
}

/**
 * 本任务改动文件全集（兼容旧签名：始终返回 string[]）。
 * 用于 eslint 基线 ratchet / style-reuse / scoped 注入：只应包含本任务碰过的文件。
 * 详见 resolveTaskChangedFiles 的边界语义。
 */
export function collectTaskChangedFiles(repoPath, changedPaths = [], opts = {}) {
  return resolveTaskChangedFiles(repoPath, changedPaths, opts).paths
}

/** 读取工作区当前 HEAD oid；失败返回 null */
export function resolveWorkspaceHeadOid(repoPath) {
  return safeHead(repoPath)
}

export function cleanupSnapshotTmp(snapshot) {
  if (snapshot?.bundlePath) {
    const dir = path.dirname(snapshot.bundlePath)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 门禁下单前把工作区对齐到声明的 ref/commit（fetch + checkout，禁止 commit/push）。
 * 解决「修复在 feature 分支，门禁源仍是 master 旧树」——否则 style-reuse/lint 永远报旧错。
 * @returns {{ synced: boolean, head: string, target: string, detail: string }}
 */
export function syncWorkspaceToRef(repoPath, { ref = null, commitOid = null, allowFetch = true } = {}) {
  const fail = (code, detail) => {
    const error = new ApiError(code, { detail })
    error.httpStatus = 409
    return error
  }
  if (!ref && !commitOid) {
    return { ok: true, synced: false, head: safeHead(repoPath), target: null, detail: '未声明 sourceRef/codeCommitOid，跳过对齐（按当前工作区快照）' }
  }
  if (commitOid && (typeof commitOid !== 'string' || !/^[a-f0-9]{7,40}$/i.test(commitOid))) {
    throw fail('SYNC_TARGET_INVALID', 'codeCommitOid 必须是合法 commit SHA，不能静默忽略。')
  }
  const r = ref ? String(ref).replace(/^refs\/heads\//, '') : null
  if (ref) {
    try { realGit(repoPath, ['check-ref-format', '--branch', r]) } catch {
      throw fail('SYNC_TARGET_INVALID', 'sourceRef 必须是合法分支名。')
    }
    if (r.startsWith('-') || r.includes('@{')) throw fail('SYNC_TARGET_INVALID', '不接受选项或 reflog 作为目标分支。')
  }
  let target = null          // 解析出的 commit SHA：来源锁校验的唯一真相
  let checkoutTarget = null  // 实际交给 git checkout 的目标：分支名会附着 HEAD，SHA 会游离
  let detail = ''
  if (commitOid) {
    try {
      target = realGit(repoPath, ['rev-parse', '--verify', `${commitOid}^{commit}`])
      checkoutTarget = target
      detail = `本地已有 commit ${target.slice(0, 12)}`
    } catch {
      if (!allowFetch) throw fail('SYNC_REF_NOT_FOUND', '本地无请求的 commit。')
      try {
        realGit(repoPath, ['fetch', '--no-tags', 'origin', commitOid])
        target = realGit(repoPath, ['rev-parse', '--verify', `${commitOid}^{commit}`])
        checkoutTarget = target
        detail = `fetch 后拿到 commit ${target.slice(0, 12)}`
      } catch {
        throw fail('SYNC_REF_NOT_FOUND', '无法从本仓 origin 取得请求的 commit。')
      }
    }
  } else {
    try {
      target = realGit(repoPath, ['rev-parse', '--verify', `refs/heads/${r}^{commit}`])
      // 本地分支：checkout 分支名而非 SHA，HEAD 附着到分支（不游离），后续提交仍落在该分支上。
      checkoutTarget = r
      detail = `本地分支 ${r}`
    } catch {
      if (!allowFetch) throw fail('SYNC_REF_NOT_FOUND', '本地无请求的分支。')
      try {
        realGit(repoPath, ['fetch', '--no-tags', 'origin', `${r}:refs/remotes/origin/${r}`])
        target = realGit(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${r}^{commit}`])
        // 远端分支：游离到该 commit（不自动创建本地分支，避免覆盖既有同名分支的副作用）。
        checkoutTarget = target
        detail = `fetch origin/${r}`
      } catch {
        throw fail('SYNC_REF_NOT_FOUND', '无法从本仓 origin 取得请求的分支。')
      }
    }
  }
  const before = safeHead(repoPath)
  if (target === before) {
    return { ok: true, synced: false, head: before, target, detail: `已是目标 ${detail}` }
  }
  let stashRef = null
  try {
    const dirty = realGit(repoPath, ['status', '--porcelain'])
    if (dirty) {
      // 门禁对齐语义：以声明分支为准；脏改动先 stash 保底（不自动 pop，可事后恢复）
      stashRef = `awp-gate-sync-${Date.now()}`
      realGit(repoPath, ['stash', 'push', '-u', '-m', stashRef])
      detail += `；脏改动已 stash(${stashRef})`
    }
  } catch {
    throw fail('SYNC_CHECKOUT_FAILED', '脏工作区保存失败，停止对齐。')
  }
  try {
    realGit(repoPath, ['checkout', checkoutTarget])
  } catch {
    throw fail('SYNC_CHECKOUT_FAILED', '对齐请求的版本失败。')
  }
  const head = safeHead(repoPath)
  if (head !== target) throw fail('SOURCE_SNAPSHOT_MISMATCH', '对齐后 HEAD 与解析目标不符。')
  return { ok: true, synced: true, head, target, stashRef, detail: `${detail} → HEAD ${head.slice(0, 12)}` }
}

/** git 子进程错误摘要：去 URL、截断，仅用于诊断（不泄漏凭据）。 */
function safeGitError(e) {
  const raw = String((e && (e.stderr || e.message)) || e || '')
  return raw.replace(/https?:\/\/[^\s]+/gi, '[redacted-url]').replace(/\s+/g, ' ').trim().slice(0, 1200)
}

/** 从 git diff 补丁解析涉及文件路径（b 侧），用于 secret 预扫与回执统计（近似即可，真源是快照 changedPaths）。 */
function parseDiffPaths(diffText) {
  const paths = new Set()
  for (const raw of String(diffText).split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('diff --git ')) continue
    const rest = line.slice('diff --git '.length)
    const idx = rest.indexOf(' b/')
    let p = idx > 0 ? rest.slice(idx + 3) : rest.replace(/^a\//, '')
    p = p.replace(/^"|"$/g, '').trim()
    if (p) paths.add(p)
  }
  return [...paths]
}

/**
 * 门禁下单前刷新远端 refs（用户约定「每次先 pull」）。
 * best-effort：无 origin / 离线不致命——只要 base 本地可达仍可继续；返回诊断供审计。
 * @returns {{ ok: boolean, detail: string }}
 */
export function prefetchOrigin(repoPath) {
  try {
    realGit(repoPath, ['fetch', '--no-tags', 'origin'])
    return { ok: true, detail: 'git fetch --no-tags origin 完成' }
  } catch (e) {
    return { ok: false, detail: `git fetch origin 跳过（不致命）：${safeGitError(e)}` }
  }
}

/**
 * 复位工作树到纯净 base：丢弃已跟踪改动 + 删除未跟踪(非 ignore)文件。
 * 关键：**不带 -x**，故 node_modules/dist 等被 .gitignore 忽略的构建依赖不会被删；额外 -e 兜底。
 * 用于「应用 diff 前保证 base 纯净、清除上一轮 diff 残留」与「快照后复位防污染下一次提交」。
 */
export function ensurePristineWorkspace(repoPath) {
  try { realGit(repoPath, ['reset', '--hard', 'HEAD']) } catch { /* 空仓/无 HEAD：忽略 */ }
  try {
    realGit(repoPath, ['clean', '-fd', '-e', 'node_modules', '-e', 'dist', '-e', '.env', '-e', '.env.local'])
  } catch { /* clean 失败不致命：随后 apply --check 会再拦 */ }
}

/**
 * base 对齐编排：baseSha → branch → 默认分支(master/main) 回退链。
 * **复用** syncWorkspaceToRef 做实际 fetch/checkout/stash，本函数只负责按优先级尝试与回退，不重复造 checkout。
 * fallbackToDefault=false（无 diff 的旧路径）时严格：baseSha/branch 不可达即抛错，禁止静默回落（保持既有语义）。
 * @returns {{ ok: boolean, synced: boolean, head: string|null, target: string|null, baseVia: string, detail: string, stashRef?: string|null }}
 */
export function alignWorkspaceBase(repoPath, { baseSha = null, branch = null, fallbackToDefault = false } = {}) {
  if (baseSha) {
    try { return { ...syncWorkspaceToRef(repoPath, { commitOid: baseSha }), baseVia: 'baseSha' } }
    catch (e) { if (!fallbackToDefault || e?.code !== 'SYNC_REF_NOT_FOUND') throw e }
  }
  if (branch) {
    try { return { ...syncWorkspaceToRef(repoPath, { ref: branch }), baseVia: 'branch' } }
    catch (e) { if (!fallbackToDefault || e?.code !== 'SYNC_REF_NOT_FOUND') throw e }
  }
  if (fallbackToDefault) {
    for (const d of ['master', 'main']) {
      try { return { ...syncWorkspaceToRef(repoPath, { ref: d }), baseVia: `default:${d}` } } catch { /* 试下一个默认分支 */ }
    }
  }
  if (!baseSha && !branch) {
    // 未声明任何目标：维持当前工作区（旧行为），不回退、不 checkout
    return { ok: true, synced: false, head: safeHead(repoPath), target: null, baseVia: 'current', detail: '未声明 base，按当前工作区快照' }
  }
  const err = new ApiError('SYNC_REF_NOT_FOUND', { detail: 'base 不可达：baseSha/branch/默认分支(master,main) 均无法解析。' })
  err.httpStatus = 409
  throw err
}

/**
 * 将 AI 经 MCP 上传的未提交改动 diff 应用到（已对齐 base 的）工作树。
 * 跨机器送测的唯一 product 通道：AI 无插件、改动落不进门禁本机工作区，故传 diff 文本由门禁代应用；
 * 应用后工作树变脏，交由 buildDirtyWorkspaceSnapshot 冻结为「base + diff」快照。
 * 安全：写临时补丁文件再 git apply（绕开 Windows 命令行长度限制）；先 --check 原子校验；secret 路径预扫；
 *       返回值只含 sha256/文件清单，绝不含原始 diff 全文。
 * @returns {{ applied: true, fileCount: number, appliedPaths: string[], diffSha256: string }}
 */
export function applyWorkspaceDiff(repoPath, diffText, { maxBytes = 24 * 1024 * 1024 } = {}) {
  const fail = (code, detail) => { const e = new ApiError(code, { detail }); e.httpStatus = 409; return e }
  if (typeof diffText !== 'string' || !diffText.trim()) {
    throw fail('SOURCE_DIFF_EMPTY', 'codeDiff 为空：请传 git diff 全文（含新文件先 `git add -N .` 再 `git diff`）。')
  }
  if (Buffer.byteLength(diffText, 'utf8') > maxBytes) {
    throw fail('SOURCE_DIFF_TOO_LARGE', `codeDiff 超过 ${maxBytes} 字节上限：请缩小任务范围或仅传业务改动。`)
  }
  if (!/(^|\n)diff --git /.test(diffText) && !/(^|\n)--- /.test(diffText)) {
    throw fail('SOURCE_DIFF_MALFORMED', 'codeDiff 不像 git diff 补丁（缺 `diff --git` / `---` 头）。请用 `git diff`（默认 -p1）生成。')
  }
  const appliedPaths = parseDiffPaths(diffText)
  assertNoSecretPaths(appliedPaths) // 应用前预扫，避免把 secret 文件写进工作树再被快照拦
  const patchFile = path.join(os.tmpdir(), `awp-diff-${randomUUID()}.patch`)
  fs.writeFileSync(patchFile, diffText, 'utf8')
  try {
    try {
      realGit(repoPath, ['apply', '--check', '--whitespace=nowarn', patchFile])
    } catch (e) {
      throw fail('SOURCE_DIFF_APPLY_FAILED', `diff 无法应用到当前 base（多半是 base 与生成 diff 时不一致，或补丁在传输中损坏）：${safeGitError(e)}`)
    }
    try {
      realGit(repoPath, ['apply', '--whitespace=nowarn', patchFile])
    } catch (e) {
      throw fail('SOURCE_DIFF_APPLY_FAILED', `diff 应用失败：${safeGitError(e)}`)
    }
  } finally {
    fs.rmSync(patchFile, { force: true })
  }
  return {
    applied: true,
    fileCount: appliedPaths.length,
    appliedPaths,
    diffSha256: createHash('sha256').update(diffText).digest('hex'),
  }
}

function safeHead(repoPath) {
  try {
    return realGit(repoPath, ['rev-parse', 'HEAD'])
  } catch {
    return null
  }
}

export function hashCanonical(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex')
}
