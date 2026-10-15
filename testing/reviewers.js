/**
 * testing/reviewers.js — 审核者插槽（可插拔）
 *
 * 审核者接口：review({ spec, policy }) -> { decision, notes }
 *   decision: 'approved' | 'rejected' | 'abstain'
 *   'abstain' = 本审核者不做判断，交给链上的下一环
 *
 * 关键不变量：
 *   ① 审核者只返回结论，不直接改库 —— 落库由 submitTestSpec/transition 统一做
 *   ② 审核者抛异常一律降级为放行 —— 审核基础设施故障不得阻塞提交
 *   ③ 是否阻塞由「档位」决定，不由审核者决定 —— 换审核者不改行为语义
 *
 * 与 submit 硬校验的关系：validateE2eSpecContent 的 throw 仍在 submitTestSpec
 * 前段先行（现状不变、契约不过直接拒收），审核链在其后做归因记录与未来扩展
 * （ai/human 审核者）的插槽。
 */
import { validateE2eSpecContent } from './spec-contract.js'

/** 档位阶梯：off → record → auto → ai → human（沿用 repo_gate_modes 的形状） */
export const REVIEW_MODES = ['off', 'record', 'auto', 'ai', 'human']

/** 档位 → 审核链（按顺序执行，遇到第一个非 abstain 结论即返回） */
const CHAIN_BY_MODE = {
  off: [],
  record: ['auto:contract'],
  auto: ['auto:contract'],
  ai: ['auto:contract', 'ai'],
  human: ['human'],
}

/** 审核不通过时是否阻塞生效（draft）。record / ai 只记录不阻塞。 */
const BLOCKING_MODES = new Set(['auto', 'human'])

export const REVIEWERS = {
  'auto:pass': {
    label: '自动放行',
    review: () => ({ decision: 'approved', notes: '自动放行（未启用实质审核）' }),
  },

  'auto:contract': {
    label: '确定性契约校验',
    review: ({ spec, policy }) => {
      if (!policy?.enforceSpecContract) {
        return { decision: 'abstain', notes: '本仓未启用契约校验，交由下一环' }
      }
      const isUnit = spec.specType === 'unit'
      const verdict = validateE2eSpecContent(spec.content, {
        side: isUnit ? null : (spec.side || null),
        specType: spec.specType,
        enforceContract: true,
      })
      return verdict.ok
        ? {
            decision: 'approved',
            notes: '契约校验通过：run 签名 / baseURL / side 一致 / data-test 落点',
          }
        : { decision: 'rejected', notes: verdict.errors.join('；') }
    },
  },

  human: {
    label: '人工确认',
    review: () => ({ decision: 'abstain', notes: '待人工在看板确认' }),
  },

  // 'ai' 审卷员由 testing/reviewers-ai.js 在被 import 时经 registerReviewer 注册
  // （规则打分 v1：fail_streak / last_result 客观历史信号；2026-09-26 实装）
}

/** 动态注册审核者（供 reviewers-ai 等扩展插槽使用；不覆盖既有 id） */
export function registerReviewer(id, def) {
  if (!REVIEWERS[id]) REVIEWERS[id] = def
  return REVIEWERS[id]
}

/** 从仓策略里取档位，非法值回落到 record（安全默认） */
export function getReviewMode(policy) {
  const m = policy?.reviewMode || policy?.review_mode || 'record'
  return REVIEW_MODES.includes(m) ? m : 'record'
}

/**
 * 执行审核链，返回落库所需的完整结论。
 * @returns {{reviewStatus:string, decision:string, by:string, notes:string}}
 */
export function reviewSpec({ spec, policy, mode = 'record' }) {
  const chain = CHAIN_BY_MODE[mode] ?? CHAIN_BY_MODE.record
  const blocking = BLOCKING_MODES.has(mode)

  if (!chain.length) {
    return { reviewStatus: 'active', decision: 'approved', by: 'auto:pass', notes: '档位 off：不审核' }
  }

  for (const id of chain) {
    const reviewer = REVIEWERS[id]
    if (!reviewer) continue
    let r
    try {
      r = reviewer.review({ spec, policy })
    } catch (e) {
      // 不变量②：审核者故障不得阻塞提交
      return {
        reviewStatus: 'active',
        decision: 'abstain',
        by: id,
        notes: `审核者异常，已放行：${e.message}`,
      }
    }
    if (!r || r.decision === 'abstain') continue
    if (r.decision === 'rejected') {
      return {
        reviewStatus: blocking ? 'draft' : 'active',
        decision: 'rejected',
        by: id,
        notes: r.notes || '',
      }
    }
    return { reviewStatus: 'active', decision: 'approved', by: id, notes: r.notes || '' }
  }

  // 全链 abstain：阻塞档位进 draft 等人，非阻塞档位照常生效
  return {
    reviewStatus: blocking ? 'draft' : 'active',
    decision: 'abstain',
    by: chain.join('+'),
    notes: '审核链未给出结论',
  }
}

/** 供看板/运维展示可用审核者与档位 */
export function listReviewers() {
  return Object.entries(REVIEWERS).map(([id, r]) => ({ id, label: r.label }))
}
