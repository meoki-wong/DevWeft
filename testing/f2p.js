import { utcNow } from './ids.js'

/**
 * testing/f2p.js — FAIL_TO_PASS 验卷（SWE-bench 金标准机制）
 *
 * 原理：有效考卷必须能区分"改动前"与"改动后"两个世界：
 *   baseline（改动前 HEAD）上 spec 必须失败
 *   snapshot（改动后）上 spec 必须通过
 * 两者同时满足 → 考卷有效（f2p_status='ok'）
 *
 * 数据来源：business_snapshots.head_commit_oid / snapshot_commit_oid（已有，零采集成本）
 * 可达性：bundle 全量历史包含 baseline ✓（2026-09-13 实测）
 */

/** 从 baseline/snapshot 两轮结果推导 f2p_status */
export function computeF2pStatus(baselineResult, snapshotResult) {
  if (baselineResult === 'skipped' || snapshotResult === 'skipped') return 'skipped'
  if (baselineResult === 'failed' && snapshotResult === 'passed') return 'ok'
  if (baselineResult === 'passed' && snapshotResult === 'passed') return 'always_pass'
  if (baselineResult === 'failed' && snapshotResult === 'failed') return 'always_fail'
  if (baselineResult === 'passed' && snapshotResult === 'failed') return 'regressed'
  // error 混入按 skipped 处理（不判定）
  return 'skipped'
}

/** F2P 结果是否可用于门禁判定（ok = 有效考卷；其他状态不算通过但也不一定阻塞） */
export function isF2pOk(status) {
  return status === 'ok'
}

/** F2P 结果是否"走过场实锤"（永远通过 = 考卷无判别力） */
export function isF2pAlwaysPass(status) {
  return status === 'always_pass'
}

/** 落库一条 F2P 结果 */
export async function recordSpecF2p(db, {
  runId, repoId, featureKey, version,
  baselineOid, snapshotOid,
  baselineResult, snapshotResult,
  detail = null,
}) {
  const f2pStatus = computeF2pStatus(baselineResult, snapshotResult)
  const resultId = `f2p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await db.prepare(
    `INSERT INTO spec_f2p_results(
       result_id, run_id, repo_id, feature_key, version,
       baseline_oid, snapshot_oid, baseline_result, snapshot_result,
       f2p_status, detail, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    resultId, runId, repoId, featureKey, version,
    baselineOid, snapshotOid, baselineResult, snapshotResult,
    f2pStatus, detail, utcNow()
  )
  return { resultId, f2pStatus }
}

/**
 * B（防「原地空转熬豁免」）：统计某考卷在 sinceIso 之后、**不同变异点**的 survived(always_pass) 次数。
 * detail 形如 `mutation survived @file:line find->replace`，同一变异点 detail 相同 → COUNT(DISTINCT detail)
 * 即「换过落点的有效重试数」：考卷版本+业务代码都没变时反复 survived 只算 1，不因重复提交自动攒够 cap 豁免。
 */
export async function countDistinctSurvivedPoints(db, { repoId, featureKey, sinceIso }) {
  return (await db.prepare(
    `SELECT COUNT(DISTINCT detail) AS c FROM spec_f2p_results
     WHERE repo_id=? AND feature_key=? AND f2p_status='always_pass' AND created_at >= ?`
  ).get(repoId, featureKey, sinceIso))?.c || 0
}
