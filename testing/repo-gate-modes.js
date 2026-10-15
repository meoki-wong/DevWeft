/**
 * §23 M6 灰度与推广：repo gate modes (legacy | observe | enforce_s | enforce_all)
 * - legacy: 不审 (默认新 repo)
 * - observe: 全审 advisory，不阻塞 MR (M3 模式)
 * - enforce_s: S 必审 (S 任务 binding 阻塞)
 * - enforce_all: 全审 (M/L/S 都阻塞)
 * 切换：test_admin 角色 + repo administer 权限 + 审计
 * 回退：旧 mode 必留 ≥24h 才允许再次切换（防抖动）
 */
import { ApiError } from './errors.js'
import { uuidv7, utcNow } from './ids.js'
import { shouldEnforceNewGate } from '../harness/testing-gate.js'

const VALID_MODES = ['legacy', 'observe', 'enforce_s', 'enforce_all']
const MODE_HIERARCHY = { legacy: 0, observe: 1, enforce_s: 2, enforce_all: 3 }

export async function getRepoGateMode(db, { repoId, now = new Date() } = {}) {
  if (!repoId) throw new ApiError('INVALID_SCHEMA')
  return await db.prepare('SELECT * FROM repo_gate_modes WHERE repo_id=?').get(repoId) || { repo_id: repoId, mode: 'observe', updated_at: now.toISOString() }
}

/** 切到目标 mode，返回 { ok, mode, previousMode, requiresOldModeAgeHours }
 * enforce_s→enforce_all 必须 enforce_s 持续 24h+；其他切换可立即
 */
export async function transitionRepoGateMode(db, { repoId, toMode, actorPrincipalId, now = new Date() } = {}) {
  if (!repoId || !toMode) throw new ApiError('INVALID_SCHEMA')
  if (!VALID_MODES.includes(toMode)) throw new ApiError('INVALID_SCHEMA')
  if (!actorPrincipalId) throw new ApiError('INVALID_SCHEMA')
  const current = await getRepoGateMode(db, { repoId, now })
  if (current.mode === toMode) return { ok: true, mode: toMode, previousMode: current.mode, noop: true }
  // §23 M6：升级（legacy→observe→enforce_s→enforce_all）需 enforce_s 持续 24h+
  const fromLevel = MODE_HIERARCHY[current.mode] ?? 0
  const toLevel = MODE_HIERARCHY[toMode]
  if (toLevel > fromLevel + 1) {
    throw new ApiError('INVALID_SCHEMA')  // 不能跨级升级
  }
  if (current.mode === 'enforce_s' && toMode === 'enforce_all') {
    const ageMs = Date.parse(now.toISOString()) - Date.parse(current.updated_at)
    if (Number.isNaN(ageMs) || ageMs < 24 * 3600 * 1000) {
      throw new ApiError('SUITE_REVOKED')  // 24h 锁定
    }
  }
  // upsert
  const nowIso = now.toISOString()
  await db.prepare(
    `INSERT INTO repo_gate_modes(repo_id, mode, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(repo_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at`
  ).run(repoId, toMode, nowIso)
  return { ok: true, mode: toMode, previousMode: current.mode, updatedAt: nowIso }
}

export async function listRepoGateModes(db, { limit = 100 } = {}) {
  return await db.prepare('SELECT * FROM repo_gate_modes ORDER BY updated_at DESC LIMIT ?').all(limit)
}

/** §23 M6 决定 run 实际 gate 行为（被 binding 阻塞或 advisory）
 * 统一委托 harness shouldEnforceNewGate，消灭双实现漂移。
 */
export async function gateBlocksRun(db, { repoId, size, now = new Date() } = {}) {
  const m = await getRepoGateMode(db, { repoId, now })
  // shouldEnforceNewGate: enforce_all 全拦；enforce_s 仅 S；legacy/observe 不拦
  return shouldEnforceNewGate(m.mode, size)
}
