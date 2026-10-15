/**
 * Host Worker 常驻服务（§9.4 / §11.2）：pm2 承载，禁止交互登录。
 * 职责：worker 层心跳 15s 一跳；有空闲 queued run 时拉起 static lane。
 * 并发：可配置（DB platform_settings.worker_concurrency，默认 2，上限 3）。
 * Environment: AWP_RUNNER_ROOT, AWP_REPO_PATH_<SLUG>, AWP_GOLDEN_VHDX, AWP_WORKER_CONCURRENCY.
 */
import os from 'node:os'
import db, { initDB, openDb, DB_DIALECT } from '../../db.js'
import { loadOrCreateWorkerIdentity } from './identity.mjs'
import { touchWorkerHeartbeat, sweepWorkerHeartbeats, countOtherActiveWorkers } from '../../testing/workers.js'
import { reconcileRuns } from '../../testing/leases.js'
import { runStaticLane } from './run-static-lane.mjs'
import {
  claimPendingDeferred, completeDeferred, failDeferred, sweepStaleClaimed, classifyDeferredError,
} from '../../testing/deferred.js'
import { isStandbyControlPlane } from '../../db/standby.js'
import { submitGateRun } from '../../testing/submit-run.js'
import { gcIsolatedWorktrees } from '../../testing/workspace-pool.mjs'
import { resolveRepoWorkspacePath } from '../../testing/repo-platform.js'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const WORKER_HEARTBEAT_MS = 15 * 1000

if (DB_DIALECT === 'sqlite') initDB()
else await openDb() // postgres：结构由 baseline.sql 负责，仅连接（§13.1）
const runnerRoot = process.env.AWP_RUNNER_ROOT || 'C:\\awp-runner'
// 有 dev PKI 就用证书指纹身份，否则维持随机身份（dev）
const certPemPath = join(repoRoot, 'secret-broker', 'dev-certs', 'worker.crt')
// identity 已异步化(方案 §7 await 化):ESM 顶层 await
const worker = await loadOrCreateWorkerIdentity(db, {
  runnerRoot,
  hostname: os.hostname(),
  certSearchPaths: existsSync(certPemPath) ? [certPemPath] : [],
})
process.stdout.write(`[host-worker] ${worker.worker_id} thumbprint=${worker.certificate_thumbprint.slice(0, 12)}…\n`)

let active = 0
let stopping = false

/** 从 DB platform_settings 读并发上限（每次 tick 刷新，看板改了立即生效）；env 优先 */
async function getConcurrency() {
  const envN = Number.parseInt(process.env.AWP_WORKER_CONCURRENCY || '', 10)
  if (Number.isFinite(envN) && envN >= 1 && envN <= 3) return envN
  try {
    const row = await db.prepare(`SELECT value FROM platform_settings WHERE key='worker_concurrency'`).get()
    const n = Number.parseInt(row?.value || '', 10)
    if (Number.isFinite(n) && n >= 1 && n <= 3) return n
  } catch { /* 表可能未建 */ }
  return 2
}

async function queuedCount() {
  // PG COUNT(*) 返回 bigint 字符串，必须 Number() 否则 ===0 恒假、空队列也起 lane
  const row = await db.prepare(
    `SELECT COUNT(*) AS c FROM test_runs WHERE status='queued' AND desired_state='running'`
  ).get()
  return Number(row?.c || 0)
}

/**
 * 物理内存水位闸（10-10）：主机 31.5GB、常驻占用后可用偏低时，并发拉 VM 会触发
 * Hyper-V Start-VM 0x8007000E（OutOfMemory）——该错误可重试但烧 attempt 且拖慢整单。
 * 可用内存低于阈值时本轮不领新 run（run 维持 queued，不烧预算），下轮 tick 自然重试。
 * 阈值 = 单 VM 上限（默认 4096MB）× 1.25 余量，可用 AWP_HOST_MIN_FREE_MB 覆盖。
 */
function hostFreeMemoryOk() {
  try {
    const total = os.totalmem()
    const free = os.freemem()
    const minFree = Number(process.env.AWP_HOST_MIN_FREE_MB || 0)
      || Math.round(Number(process.env.AWP_VM_MEM_MAX_MB || 4096) * 1.25)
    const freeMB = Math.round(free / 1024 / 1024)
    const ok = freeMB >= minFree
    if (!ok) {
      process.stdout.write(`[host-worker] 内存水位不足：可用 ${freeMB}MB < 阈值 ${minFree}MB，本轮不领新 run（queued 保持）\n`)
    }
    return ok
  } catch {
    return true // 水位判定异常时不阻断调度
  }
}

/**
 * 主机 host-worker 消费 deferred_submissions：备用机（standby）收到 awp_test_run
 * 时不再本地快照，而是把 codeDiff 落这张表；主机每 tick 认领一条，按 repo profile
 * 走 submitGateRun 生成真 submission/run_groups/test_runs。
 *
 * 关键约束：
 *   - 备用机自身跑 drainDeferred = 死循环（提交回自己），必须先 isStandbyControlPlane 早退
 *   - 允许 env AWP_DEFERRED_DRAIN=0 临时关闭（排障用）
 *   - 单条处理；剩余留下轮，避免长 diff 卡住 tick 心跳
 *   - stale claimed（>10min）：worker 崩溃时回退到 pending
 */
async function drainDeferred() {
  // P0-2a：默认备用机不 drain（主机是唯一执行源）。仅当显式 AWP_STANDBY_DRAIN_TAKEOVER=1
  // 且无其它活跃 worker（疑似主机停摆/整机故障）时，备用机才接管 drain，避免与主机双跑。
  if (isStandbyControlPlane()) {
    if (String(process.env.AWP_STANDBY_DRAIN_TAKEOVER || '').trim() !== '1') return
    const others = await countOtherActiveWorkers(db, worker.worker_id, {
      ttlMs: Number(process.env.AWP_STANDBY_TAKEOVER_STALE_MS || 60000),
    }).catch(() => 1)
    if (others > 0) return
  }
  if (String(process.env.AWP_DEFERRED_DRAIN || '').trim() === '0') return
  try { await sweepStaleClaimed(db, { ttlMs: 10 * 60 * 1000 }) } catch { /* 表未建时静默 */ }
  let row = null
  try {
    row = await claimPendingDeferred(db, worker.worker_id)
  } catch (e) {
    // 表不存在（首启动 migrate 尚未跑完）：静默
    if (!/no such table|deferred_submissions/i.test(String(e?.message || ''))) {
      process.stderr.write('[host-worker] claimPendingDeferred 异常: ' + e.message + '\n')
    }
    return
  }
  if (!row) return
  process.stdout.write('[host-worker] drain deferred ' + row.deferred_id.slice(0, 8) + ' repo=' + row.repo_id + ' task=' + row.task_id + '\n')
  try {
    const repoRow = await db.prepare('SELECT slug FROM repositories WHERE repo_id=?').get(row.repo_id)
    if (!repoRow) throw new Error('DEFERRED_REPO_UNKNOWN: repo_id=' + row.repo_id)
    // 复用真 submitGateRun：此处非 standby，走原完整流程（本地 workspace + 快照 + bundle + PG 记录）
    const out = await submitGateRun(db, {
      taskId: row.task_id,
      author: row.author,
      side: row.side,
      sideReason: row.side_reason || null,
      repoSlug: repoRow.slug,
      sourceRef: row.source_ref || null,
      codeCommitOid: row.code_commit_oid || null,
      codeDiff: row.code_diff,
      triggerReason: (row.trigger_reason || '(deferred)') + ' [via standby-drain]',
      // standby 受控接管时绕过"落 deferred"早退，用备用机自身工作区做本地快照（默认关时不会走到这里）
      forceLocalSnapshot: isStandbyControlPlane(),
    })
    await completeDeferred(db, { deferredId: row.deferred_id, processedSubmissionId: out.submissionId })
    process.stdout.write('[host-worker] deferred ' + row.deferred_id.slice(0, 8) + ' processed -> submission ' + out.submissionId + '\n')
  } catch (e) {
    const errorClass = classifyDeferredError(e)
    const res = await failDeferred(db, { deferredId: row.deferred_id, errorMessage: e.message || String(e), errorClass })
    process.stderr.write('[host-worker] deferred ' + row.deferred_id.slice(0, 8) + ' 处理失败(' + errorClass
      + ', attempts=' + res.attempts + (res.willRetry ? ', 将退避重试' : ', 终态') + '): ' + (e.message || String(e)) + '\n')
  }
}

async function tick() {
  await touchWorkerHeartbeat(db, worker.worker_id)
  await reconcileRuns(db)
  await sweepWorkerHeartbeats(db)
  // P0-1：回收崩溃残留的隔离 worktree（陈旧目录 + git worktree prune）；仅主机、锁占用时静默跳过
  if (!isStandbyControlPlane()) {
    try {
      const repos = await db.prepare('SELECT slug FROM repositories').all()
      for (const repo of repos) {
        const workspace = resolveRepoWorkspacePath(repo.slug)
        if (workspace) gcIsolatedWorktrees(workspace)
      }
    } catch { /* best-effort */ }
  }
  // 主机侧：把备用机 standby 落表的 deferred 转成真 submission（fire-and-forget，出错不阻断本 tick）
  try { await drainDeferred() } catch (e) { process.stderr.write('[host-worker] drainDeferred 兜底: ' + e.message + '\n') }
  // 方案A：主机是唯一的「代码基线 + 快照 + 计算」执行源。备用机（standby）host-worker 只做控制面热备，
  // 绝不领 run / 不起 Hyper-V lane —— 否则会与主机抢租约、在备用机 E:\ 工作区跑测试并在宿主弹终端窗口。
  if (isStandbyControlPlane()) return
  const max = await getConcurrency()
  if (active >= max || stopping || await queuedCount() === 0) return
  // 内存水位闸：可用内存不足时领新 run 必撞 Start-VM OOM，不领、等下轮（queued 不烧 attempt）
  if (!hostFreeMemoryOk()) return
  active += 1
  runStaticLane({
    runnerRoot,
    goldenVhdx: process.env.AWP_GOLDEN_VHDX || join(runnerRoot, 'images', 'golden.vhdx'),
    passwordFile: process.env.AWP_GOLDEN_PASSWORD_FILE || join(runnerRoot, 'images', 'golden.admin.password'),
  }).then((out) => {
    process.stdout.write(`[host-worker] run ${out.reservation.runId} status=${out.result.status}\n`)
  }).catch((err) => {
    process.stderr.write(`[host-worker] lane 失败: ${err.message}\n${err.stack || ''}\n`)
  }).finally(() => {
    active -= 1
  })
}

await tick()
const timer = setInterval(async () => { tick().catch((err) => process.stderr.write(`[host-worker] tick: ${err.message}\n`)) }, WORKER_HEARTBEAT_MS)
process.stdout.write(`[host-worker] heartbeat loop started (15s, concurrency=up to ${await getConcurrency()})\n`)

process.on('SIGINT', () => {
  stopping = true
  clearInterval(timer)
  process.exit(0)
})
void readFileSync
