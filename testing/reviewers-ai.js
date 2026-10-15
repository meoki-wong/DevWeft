/**
 * testing/reviewers-ai.js — AI 审卷员 v1（规则打分，非 LLM；2026-09-26 实装预留插槽）
 *
 * 信号全部来自服务端客观历史（test_specs 行内）：fail_streak / last_result / 版本数。
 * 输出三档：approved（历史干净）/ rejected（预留给未来内容级信号）/ abstain（历史不稳，转人工）。
 * 近重复在 submitTestSpec 前段已由 findNearDuplicateFeatureKey 硬拒，不在此重复。
 *
 * 档位语义（reviewers.js）：
 *   record 档：submitTestSpec 调 aiShadowVerdict 把 AI 结论追加进 review_notes（影子，不改变生效行为）；
 *   ai 档：'ai' 在 CHAIN_BY_MODE.ai 链上，结论成为正式审核记录（该档位仍非阻塞——
 *          BLOCKING_MODES 未含 ai；要真拦截时把 'ai' 加入该集合即为一行开关）。
 */
import db from '../db.js'
import { registerReviewer } from './reviewers.js'

/** 客观历史信号（只读；conn 显式注入便于测试） */
export async function aiReviewSignals(conn, { repoId, featureKey }) {
  const row = await conn
    .prepare(
      `SELECT version, review_status, last_result, fail_streak
       FROM test_specs WHERE repo_id=? AND feature_key=? ORDER BY version DESC LIMIT 1`
    )
    .get(repoId, featureKey)
  return {
    exists: Boolean(row),
    version: row?.version ?? null,
    lastResult: row?.last_result ?? null,
    failStreak: Number(row?.fail_streak || 0),
  }
}

/** 纯判定（不触库）：入参 signals，便于单测注入 */
export function aiReviewDecide({ exists, lastResult, failStreak }) {
  if (!exists) return { decision: 'approved', notes: 'ai: 首版考卷，无历史信号' }
  if (failStreak >= 3) return { decision: 'abstain', notes: `ai: 连败 ${failStreak} 次历史不稳，转人工` }
  if (failStreak >= 1 || lastResult === 'failed') {
    return { decision: 'abstain', notes: `ai: 上轮失败(last=${lastResult || '-'} streak=${failStreak})，转人工复核` }
  }
  return { decision: 'approved', notes: `ai: 历史干净(last=${lastResult || '-'} streak=${failStreak})` }
}

/** 审核链适配（REVIEWERS.ai 包装；db 为全局单例） */
export async function aiReview({ spec }) {
  const signals = await aiReviewSignals(db, { repoId: spec.repoId, featureKey: spec.featureKey })
  return aiReviewDecide(signals)
}

registerReviewer('ai', {
  label: 'AI 审卷员（规则打分 v1）',
  review: aiReview,
})

/** 影子模式：record 档位下直接取 AI 结论（不进链、不改变生效行为）；任何异常降级 abstain */
export async function aiShadowVerdict({ spec }) {
  try {
    return await aiReview({ spec })
  } catch {
    return { decision: 'abstain', notes: 'ai-shadow: 信号不可用' }
  }
}
