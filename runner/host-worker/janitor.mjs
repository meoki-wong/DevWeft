/**
 * Janitor（§21.4 保留 / §23 M3 重启对账）：
 *   - DB：过期 artifacts 标记 deleted_at、过期幂等记录/nonce/challenge 清理；
 *   - 文件：runnerRoot/attempts 下不属于活动 attempt 的残留目录删除；
 *   - Hyper-V：awp-run-* 残留 VM 清理由 janitor-hyperv.ps1（管理员）完成，--hyperv 时调用。
 * 物理归档 blob 内容寻址共享，不随 deleted_at 删除（保留期后另行处理）。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export async function janitorPlan(db, { runnerRoot, now = new Date() } = {}) {
  const nowIso = now.toISOString()
  const expiredArtifacts = (await db.prepare(
    `SELECT artifact_id FROM artifacts WHERE expire_at < ? AND deleted_at IS NULL`
  ).all(nowIso)).map((r) => r.artifact_id)
  const expiredIdempotency = (await db.prepare(
    `SELECT COUNT(*) AS c FROM idempotency_records WHERE expire_at < ?`
  ).get(nowIso)).c
  const expiredWorkerOps = (await db.prepare(
    `SELECT COUNT(*) AS c FROM worker_idempotency_records WHERE created_at < ?`
  ).get(new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString())).c
  const expiredNonces = (await db.prepare(
    `SELECT COUNT(*) AS c FROM runspec_nonces WHERE expires_at < ? AND consumed_at IS NULL`
  ).get(nowIso)).c
  const attemptDirResidue = []
  if (runnerRoot && existsSync(join(runnerRoot, 'attempts'))) {
    const activeDirs = new Set((await db.prepare(
      `SELECT DISTINCT run_id FROM run_attempts
       WHERE status IN ('reserved','leased','provisioning','running')`
    ).all()).map((r) => r.run_id))
    for (const name of readdirSync(join(runnerRoot, 'attempts'))) {
      if (!activeDirs.has(name)) attemptDirResidue.push(join(runnerRoot, 'attempts', name))
    }
  }
  return { expiredArtifacts, expiredIdempotency, expiredWorkerOps, expiredNonces, attemptDirResidue }
}

export async function runJanitor(db, { runnerRoot, now = new Date(), hyperV = false } = {}) {
  const plan = await janitorPlan(db, { runnerRoot, now })
  const nowIso = now.toISOString()
  let artifactsMarkedDeleted = 0
  await db.tx(async (tx) => {
    artifactsMarkedDeleted = (await tx.prepare(
      `UPDATE artifacts SET deleted_at=? WHERE expire_at < ? AND deleted_at IS NULL`
    ).run(nowIso, nowIso)).changes
    await tx.prepare(`DELETE FROM idempotency_records WHERE expire_at < ?`).run(nowIso)
    await tx.prepare(
      `DELETE FROM worker_idempotency_records WHERE created_at < ?`
    ).run(new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString())
    await tx.prepare(`DELETE FROM runspec_nonces WHERE expires_at < ? AND consumed_at IS NOT NULL`).run(nowIso)
  })
  for (const dir of plan.attemptDirResidue) {
    rmSync(dir, { recursive: true, force: true })
  }
  let hyperVResidue = null
  if (hyperV) {
    hyperVResidue = runHyperVJanitor()
  }
  return { ...plan, artifactsMarkedDeleted, hyperVResidue }
}

function runHyperVJanitor() {
  return new Promise((resolve, reject) => {
    const ps = join(here, 'janitor-hyperv.ps1')
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ exitCode: code, output: out.trim().split('\n').slice(-10) }))
  })
}

const entryIsSelf = process.argv[1] && process.argv[1].endsWith('janitor.mjs')
// PM2 fork 模式下 argv[1]=ProcessContainerFork.js，须与 server.js 同款兜住
const launchedByPm2 = process.env.pm_id != null && process.env.pm_exec_path != null
const wantLoop = process.argv.includes('--loop')
if (entryIsSelf || launchedByPm2) {
  const runnerRoot = process.env.AWP_RUNNER_ROOT || 'C:\\awp-runner'
  const hyperv = process.argv.includes('--hyperv')
  import('../../db.js').then(async ({ default: db, openDb, DB_DIALECT, initDB }) => {
    if (DB_DIALECT === 'sqlite') initDB()
    else await openDb()
    const runOnce = async () => {
      const result = await runJanitor(db, { runnerRoot, hyperV: hyperv })
      process.stdout.write(`janitor: deleted_artifacts=${result.artifactsMarkedDeleted} attempt_dirs=${result.attemptDirResidue.length} hyperv=${JSON.stringify(result.hyperVResidue)}\n`)
    }
    if (wantLoop) {
      // 常驻守护循环：启动先跑一次，之后按间隔循环；单轮失败不退出（记录后下一轮继续），进程保持 online。
      const intervalMs = Math.max(60_000, Number(process.env.AWP_JANITOR_INTERVAL_MS) || 3_600_000)
      const tick = async () => {
        try { await runOnce() } catch (e) { process.stderr.write(`janitor: cycle failed ${e && e.message ? e.message : e}\n`) }
      }
      await tick()
      const timer = setInterval(tick, intervalMs)
      const shutdown = () => { clearInterval(timer); process.exit(0) }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
      process.stdout.write(`janitor: daemon loop started interval=${intervalMs}ms hyperv=${hyperv}\n`)
      // 不 process.exit —— 交给 pm2 维持 online；autorestart:true 会在异常退出时拉起
      return
    }
    try { await runOnce(); process.exit(0) }
    catch (err) { process.stderr.write(`janitor: fatal ${err && err.message ? err.message : err}\n`); process.exit(1) }
  }).catch((err) => {
    process.stderr.write(`janitor: fatal ${err && err.message ? err.message : err}\n`)
    process.exit(1)
  })
}
