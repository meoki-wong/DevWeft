/**
 * testing/verify-mode.js — 功能验证（本地 L2）与云端门禁的优先级
 *
 * 规则（全项目统一）：
 *  1. 云端门禁健康（最近有 passed formal 或可提交）→ 真源=cloud，本地 L2 仅兜底/隐藏
 *  2. 云端不可用（无 recent pass / worker 异常）→ 真源=local，必须 L2
 *  3. 业务仓无 verify.sh / 无 L2 → 永不强制本地 L2
 *  4. 按 repo 隔离，互不影响
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { utcNow } from './ids.js'
import { resolveRepoWorkspacePath } from './repo-platform.js'
import { allowCrossRepoHealth } from './verify-evidence.js'

/** 该仓是否有本地功能验证脚本 */
export function repoHasLocalVerify(db, slug, { env = process.env, repoRoot = null } = {}) {
  try {
    const ws = resolveRepoWorkspacePath(slug, { env, repoRoot })
    if (!ws) return false
    return existsSync(join(ws, 'scripts', 'verify.sh'))
  } catch {
    return false
  }
}

/** 最近是否出现过云端 formal 全绿（健康信号） */
export async function recentCloudPass(db, repoId, { hours = 48 } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM test_submissions
         WHERE repo_id = ? AND status = 'passed' AND created_at >= ?`
      )
      .get(repoId, since)
    return (row?.c || 0) > 0
  } catch {
    return false
  }
}

/** worker 最近心跳（若有 workers 表且有 recent lease 完成） */
export async function recentWorkerActivity(db, { hours = 48, repoId = null } = {}) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  try {
    if (repoId) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM test_runs
           WHERE repo_id = ?
             AND ((finished_at IS NOT NULL AND finished_at >= ?)
               OR (started_at IS NOT NULL AND started_at >= ?))`
        )
        .get(repoId, since, since)
      return (row?.c || 0) > 0
    }
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM test_runs
         WHERE (finished_at IS NOT NULL AND finished_at >= ?)
            OR (started_at IS NOT NULL AND started_at >= ?)`
      )
      .get(since, since)
    return (row?.c || 0) > 0
  } catch {
    return false
  }
}

/**
 * 解析该仓当前「功能验证真源」
 * @returns {{ source: 'cloud'|'local'|'none', localAvailable, cloudHealthy, showLocalVerify, hint }}
 */
export async function resolveVerifySource(db, slug, opts = {}) {
  const localAvailable = repoHasLocalVerify(db, slug, opts)
  let repoId = slug
  try {
    const r = await db.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(slug)
    if (r) repoId = r.repo_id
  } catch { /* keep slug */ }

  // verify_cross_repo_health=false 时：其他仓 activity 不得让本仓判云端健康
  const crossOk = await allowCrossRepoHealth(db)
  const cloudHealthy =
    await recentCloudPass(db, repoId) ||
    await recentWorkerActivity(db, crossOk ? {} : { repoId })

  // 云端健康 → 真源 cloud，隐藏本地 L2 节点（仍可手动跑 verify 作自检）
  if (cloudHealthy) {
    return {
      source: 'cloud',
      localAvailable,
      cloudHealthy: true,
      showLocalVerify: false,
      hint: '云端门禁健康：功能验证以云端测试为准；本地 verify.sh L2 仅作可选自检，不再作为 harness 必过节点。',
    }
  }

  // 云端不健康 + 有本地 verify → 切换本地兜底
  if (localAvailable) {
    return {
      source: 'local',
      localAvailable: true,
      cloudHealthy: false,
      showLocalVerify: true,
      hint: '云端门禁暂不可用：请用本地 verify.sh L2 作功能验证兜底，并上报 verify_report。',
    }
  }

  // 云端不健康 + 无本地 verify → 只能等云端
  return {
    source: 'none',
    localAvailable: false,
    cloudHealthy: false,
    showLocalVerify: false,
    hint: '云端门禁暂不可用，且本仓无本地 verify.sh：无法做功能验证，请先恢复云端 worker/门禁。',
  }
}
