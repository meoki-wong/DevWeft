#!/usr/bin/env node
/**
 * scripts/dev-gate.mjs — 开发期文件守卫（非 Git 闸）
 *
 * 解决：AI 在开发中不 harness_start 就改业务代码；Git pre-commit 太晚。
 * 做法：监听业务仓 src/**（及指定路径），变更后立即校验：
 *   1. 是否存在合法 harness 任务（.awp-ai-task 或 AWP_AI_TASK_ID）
 *   2. 控制面 /api/harness/status：任务存在且 phase 非 DONE/ABORTED
 * 不合法 → 控制台红字警告 + 可选回滚（--revert）
 *
 * 用法（在业务仓根目录）：
 *   node ../DevWeft/scripts/dev-gate.mjs
 *   node .../dev-gate.mjs --revert          # 无任务时 git restore 该文件
 *   node .../dev-gate.mjs --watch src,public
 *   AWP_AI_URL=http://127.0.0.1:8787 node .../dev-gate.mjs
 *
 * 建议配合 IDE：任务未开始时先跑 /start-task；本进程只做「开发中」硬提醒/回滚。
 */
import { watch, existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const REVERT = args.includes('--revert')
const DRY = args.includes('--dry-run')
const watchIdx = args.indexOf('--watch')
const WATCH_DIRS = watchIdx >= 0 && args[watchIdx + 1]
  ? args[watchIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : ['src']
const AWP_AI_URL = process.env.AWP_AI_URL || 'http://127.0.0.1:8787'
const ROOT = process.env.AWP_DEV_GATE_ROOT || process.cwd()
const IGNORE = /node_modules|\.git|dist|\.awp-run/

function log(...a) { console.log('[dev-gate]', ...a) }
function warn(...a) { console.error('[dev-gate]', ...a) }

function readTaskMarker() {
  const env = process.env.AWP_AI_TASK_ID
  if (env) return env
  const p = join(ROOT, '.awp-ai-task')
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, 'utf8').trim() || null
  } catch {
    return null
  }
}

async function checkTask(taskId, repo) {
  const q = new URLSearchParams({ taskId })
  if (repo) q.set('repo', repo)
  const res = await fetch(`${AWP_AI_URL}/api/harness/status?${q}`)
  if (!res.ok) return { ok: false, reason: `status HTTP ${res.status}` }
  const data = await res.json()
  const phase = data.phase || data.status?.phase
  const terminal = phase === 'DONE' || phase === 'ABORTED'
  return {
    ok: Boolean(data.ok) && !terminal,
    phase,
    terminal,
    reason: data.ok ? (terminal ? `phase=${phase} 已终态` : null) : (data.error || '任务不存在'),
  }
}

function gitRestore(relPath) {
  const r = spawnSync('git', ['checkout', '--', relPath], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return r.status === 0
}

const pending = new Map()
function queueCheck(relPath) {
  pending.set(relPath, Date.now())
}

async function flushChecks() {
  if (!pending.size) return
  const files = [...pending.keys()]
  pending.clear()
  const repo = process.env.AWP_AI_REPO || null
  const taskId = readTaskMarker()
  if (!taskId) {
    warn('未绑定 harness 任务（无 .awp-ai-task / AWP_AI_TASK_ID）')
    for (const f of files) warn(`  变更：${f}`)
    warn('请先 harness_start，或写入 taskId 到 .awp-ai-task')
    if (REVERT && !DRY) {
      for (const f of files) {
        if (gitRestore(f)) log(`已回滚：${f}`)
        else warn(`回滚失败：${f}`)
      }
    }
    return
  }
  let st
  try {
    st = await checkTask(taskId, repo)
  } catch (e) {
    warn(`无法连接控制面 ${AWP_AI_URL}：${e.message}（仅提示，不回滚）`)
    return
  }
  if (!st.ok) {
    warn(`任务校验失败 taskId=${taskId}：${st.reason || st.phase}`)
    for (const f of files) warn(`  变更：${f}`)
    if (st.terminal && REVERT && !DRY) {
      for (const f of files) {
        if (gitRestore(f)) log(`已回滚（任务已终态）：${f}`)
      }
    }
    return
  }
  log(`任务 ${taskId} phase=${st.phase} · 变更 ${files.length} 个文件（允许）`)
}

let timer = null
function scheduleFlush() {
  clearTimeout(timer)
  timer = setTimeout(() => { flushChecks().catch((e) => warn(e.message)) }, 400)
}

function watchDir(dirRel) {
  const abs = join(ROOT, dirRel)
  if (!existsSync(abs)) {
    log(`跳过不存在目录：${dirRel}`)
    return
  }
  watch(abs, { recursive: true }, (event, filename) => {
    if (!filename) return
    const rel = join(dirRel, filename)
    if (IGNORE.test(rel)) return
    try {
      if (statSync(join(ROOT, rel)).isDirectory()) return
    } catch {
      // 可能是删除
    }
    queueCheck(rel.replace(/\\/g, '/'))
    scheduleFlush()
  })
  log(`监听中：${relative(ROOT, abs)}  revert=${REVERT}  url=${AWP_AI_URL}`)
}

for (const d of WATCH_DIRS) watchDir(d)
log('开发期守卫已启动（Ctrl+C 退出）。Git pre-commit 仍可另配，本进程只管「写码中途」。')
