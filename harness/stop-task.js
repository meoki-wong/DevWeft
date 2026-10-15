/**
 * harness/stop-task.js — 看板/AI 一键中止任务
 * 1) phase → ABORTED（AI 调 harness_status 会看到，禁止再推进）
 * 2) 取消本任务全部 queued/active 云端 run（desired_state=canceled + 立即置 canceled）
 * 3) 撤销 lease，尽力 Stop/Remove Hyper-V VM（awp-run-*）
 */
import { spawn } from 'node:child_process'
import db from '../db.js'
import { harnessAdvance, harnessStatus } from './state-machine.js'
import { recordAuditEvent } from '../audit/index.js'

async function listTaskRuns(repoSlug, taskId) {
  try {
    return await db
      .prepare(
        `SELECT DISTINCT r.run_id, r.status
         FROM test_runs r
         JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
         JOIN repositories rep ON rep.repo_id = r.repo_id
         WHERE ti.external_task_id = ? AND rep.slug = ?`
      )
      .all(taskId, repoSlug)
  } catch {
    try {
      return await db
        .prepare(
          `SELECT DISTINCT r.run_id, r.status
           FROM test_runs r
           JOIN legacy_task_mappings m ON m.task_instance_id = r.task_instance_id
           JOIN repositories rep ON rep.repo_id = r.repo_id
           WHERE m.legacy_task_id = ? AND rep.slug = ?`
        )
        .all(taskId, repoSlug)
    } catch {
      return []
    }
  }
}

async function cancelRunNow(db, runId, nowIso) {
  const run = await db.prepare('SELECT run_id, status, run_group_id FROM test_runs WHERE run_id=?').get(runId)
  if (!run) return null
  const wasLive = ['queued', 'active', 'running'].includes(run.status)
  await db.prepare(
    `UPDATE test_runs SET desired_state='canceled', status='canceled', terminal_reason='canceled', finished_at=?
     WHERE run_id=? AND status IN ('queued','active','running')`
  ).run(nowIso, runId)
  await db.prepare(
    `UPDATE run_attempts SET status='canceled', finished_at=?
     WHERE run_id=? AND status IN ('reserved','leased','provisioning','running')`
  ).run(nowIso, runId)
  await db.prepare(`UPDATE runner_leases SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL`).run(nowIso, runId)
  return { runId, wasLive, status: 'canceled', runGroupId: run.run_group_id }
}

/** 尽力关闭本任务相关 Hyper-V VM（失败不阻断中止） */
function destroyTaskVms(runIds) {
  if (!runIds.length || process.platform !== 'win32') {
    return { attempted: 0, destroyed: [], skipped: true }
  }
  const names = []
  for (const id of runIds) {
    // run-static-lane 命名：awp-run-<runId>-a<attempt>
    names.push(`awp-run-${id}`)
  }
  return new Promise((resolve) => {
    const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$ids = @(${runIds.map((id) => `'${String(id).replace(/'/g, '')}'`).join(',')})
$vms = Get-VM | Where-Object { $n = $_.Name; $ids | Where-Object { $n -like ('awp-run-' + $_ + '*') } }
foreach ($v in $vms) {
  Write-Output ('stop:' + $v.Name)
  if ($v.State -ne 'Off') { Stop-VM -Name $v.Name -TurnOff -Force -ErrorAction SilentlyContinue }
  Remove-VM -Name $v.Name -Force -ErrorAction SilentlyContinue
  Write-Output ('removed:' + $v.Name)
}
`
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
    })
    let out = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve({ attempted: names.length, destroyed: [], skipped: false, error: 'spawn' }))
    child.on('exit', () => {
      const destroyed = out.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('removed:')).map((l) => l.slice(8))
      resolve({ attempted: names.length, destroyed, skipped: false })
    })
  })
}

/**
 * @returns {{ok, taskId, repo, phase, canceledRuns, vm, message}}
 */
export async function forceStopTask({ taskId, repo = 'demo-app', reason = null, author = 'dashboard', destroyVm = true }) {
  const nowIso = new Date().toISOString()
  const task = await db.prepare('SELECT task_id, phase FROM tasks WHERE repo=? AND task_id=?').get(repo, taskId)
  if (!task) {
    return { ok: false, code: 'TASK_NOT_FOUND', error: `任务不存在：${taskId}` }
  }
  if (['DONE', 'ABORTED', 'done', 'aborted'].includes(task.phase)) {
    return {
      ok: false,
      code: 'ALREADY_TERMINAL',
      error: `任务已是终态 ${task.phase}，无需停止`,
      taskId,
      repo,
      phase: task.phase,
    }
  }

  const abortReason = reason || '看板手动停止：终止全部活动并关闭云端 VM'

  // 1) harness → ABORTED（AI 侧 harness_status 可见）
  const adv = await harnessAdvance({
    taskId,
    to: 'ABORTED',
    data: { reason: abortReason },
    author,
    repo,
  })
  if (!adv?.ok) {
    // 兜底：直接写库（防御 advance 被异常拦）
    try {
      await db.prepare(
        `UPDATE tasks SET phase='aborted', updated_at=?, closed_at=?, meta=?
         WHERE repo=? AND task_id=? AND phase NOT IN ('DONE','ABORTED','done','aborted')`
      ).run(nowIso, nowIso, JSON.stringify({ abortReason }), repo, taskId)
    } catch { /* ignore */ }
  }

  // 2) 取消云端 run
  const runs = await listTaskRuns(repo, taskId)
  const canceled = []
  for (const r of runs) {
    const c = await cancelRunNow(db, r.run_id, nowIso)
    if (c) canceled.push(c)
  }

  // 刷新 formal group 状态（best effort）
  try {
    const groups = new Set(canceled.map((c) => c.runGroupId).filter(Boolean))
    for (const gid of groups) {
      const gRuns = await db.prepare('SELECT status FROM test_runs WHERE run_group_id=?').all(gid)
      const allTerm = gRuns.every((r) => !['queued', 'active', 'running'].includes(r.status))
      if (allTerm) {
        await db.prepare(`UPDATE run_groups SET status='canceled' WHERE run_group_id=? AND status IN ('queued','running')`).run(gid)
      }
    }
  } catch { /* ignore */ }

  // 3) 关 VM
  let vm = { attempted: 0, destroyed: [], skipped: true }
  if (destroyVm) {
    try {
      vm = await destroyTaskVms(runs.map((r) => r.run_id))
    } catch (e) {
      vm = { attempted: runs.length, destroyed: [], skipped: false, error: String(e.message || e) }
    }
  }

  try {
    await recordAuditEvent({
      eventType: 'task_stopped',
      toolName: 'harness_stop',
      method: 'dashboard',
      repo,
      taskId,
      author,
      status: 'ok',
      detail: `ABORTED · canceledRuns=${canceled.length} · vms=${(vm.destroyed || []).length}${reason ? ` · ${reason}` : ''}`,
      payload: { reason: abortReason, canceledRuns: canceled.map((c) => c.runId), vm },
    })
  } catch { /* ignore */ }

  let status = null
  try {
    status = await harnessStatus({ taskId, repo })
  } catch { /* ignore */ }

  return {
    ok: true,
    taskId,
    repo,
    phase: 'ABORTED',
    abortReason,
    canceledRuns: canceled,
    vm,
    message:
      `任务已中止（ABORTED）。云端 run 已取消 ${canceled.length} 个；` +
      `VM 清理 ${vm.skipped ? '跳过（非 Win 或无 run）' : `销毁 ${(vm.destroyed || []).length} 台`}。` +
      'AI Coding 请调用 harness_status 查看终态，禁止再 harness_advance / test_run。',
    aiHint:
      'TASK_ABORTED: 本任务已被管理员中止。请立即停止编码与测试活动；' +
      '调用 harness_status(taskId) 确认 phase=ABORTED；如需继续请另开新任务（harness_start），禁止复活本任务。',
    status,
  }
}

export { listTaskRuns, cancelRunNow }

/**
 * 下一次例行清理时点（每日 hour 点整，本地时区）。now 已过当日 hour 点 → 明日。
 * 独立导出便于单测（假时钟）。
 */
export function computeNextRunAt(now = new Date(), hour = 5) {
  const next = new Date(now)
  next.setHours(hour, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next
}

/**
 * 每日 05:00 例行清理（2026-09-26 决策）：结束**所有**未完成任务。
 * 每个任务走 forceStopTask 完整链路：ABORTED + 取消在飞 run + 撤销租约 + 销毁 awp-run-* VM，
 * 不留孤儿算力。旧的超时阈值清扫（sweepStaleTasks 3 天档）保留作为回滚开关。
 */
export async function dailySweepUnfinishedTasks({
  author = 'system:5am',
  reason = '每日05:00例行清理：结束所有未完成任务',
  destroyVm = true,
  now = new Date(),
} = {}) {
  const rows = await db
    .prepare(
      `SELECT repo, task_id FROM tasks WHERE phase NOT IN ('DONE', 'ABORTED', 'done', 'aborted')
       AND task_id NOT LIKE 'nightly-%'`
    )
    .all()
  const results = []
  for (const row of rows) {
    try {
      results.push(await forceStopTask({ taskId: row.task_id, repo: row.repo, reason, author, destroyVm }))
    } catch (e) {
      results.push({ ok: false, taskId: row.task_id, repo: row.repo, error: String(e.message || e) })
    }
  }
  return { sweptAt: now.toISOString(), swept: rows.length, stopped: results.filter((r) => r.ok).length, results }
}
