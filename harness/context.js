/**
 * context.js — 按 phase + size 返回上下文装配包（IDE 无关）
 * 测试是否发生由 Harness 控制；禁止让用户执行平台操作命令。
 * CLRP：云端未终态禁止宣称完成；失败必须按返工包回环。
 */
import { PHASE_LABELS, SIZE_LABELS, buildWorkflowView } from './labels.js'
import { phaseToActivity, exitCriteriaFor, toolsForActivity } from './activity-plan.js'

const ACTIVITY_DOCS = {
  receive: ['flow-triage'],
  classify: ['flow-triage'],
  retrieve: ['flow-lookup'],
  plan: ['flow-lifecycle'],
  execute: ['HARD_RULES'],
  static: ['flow-verify'],
  smoke: ['flow-verify'],
  distill: ['flow-distill'],
  done: [],
  aborted: [],
}

const ACTIVITY_INSTRUCTIONS = {
  receive: '记录需求后，按活动计划推进到下一活动。禁止让用户执行平台命令。',
  classify: '信号已记录。按 activityPlan 进入下一活动。',
  retrieve: '用 query_docs 检索片段，结论写入 decisions。不要用 get_doc 拉全文。',
  plan: '提交 pending 或 decisions，以及 data.acceptance。快照之前 AC 可以改。',
  execute: '改代码并 verify_report(L1)。然后 awp_test_run(wait=true)，side 只填实际改动端。⚠跨机器：门禁读不到你磁盘的改动，必须传 codeDiff（`git add -N .` 后 `git diff` 全文）+ codeCommitOid（`git rev-parse HEAD` 的 base）；门禁会切到你的 base 再应用 diff 做脏区快照送测。全程只读生成，禁止 git commit/push。失败后在本活动 distill_append，不要为了写经验推进到 distill。未绿不能完成。',
  static: '静态检查未绿不能完成。失败后在本活动 distill_append，再重提。',
  smoke: '只跑已确定的端。端未定先声明 side。失败后在本活动 distill_append，再重提。',
  distill: '写完经验后回到进入沉淀前的活动，不会退回 plan。',
  done: '任务已结束。',
  aborted: '任务已中止。禁止继续编码、测试或推进。',
}

/** @returns {{ docs: string[], instructions: string, tools: string[] }} */
export function buildContextPack(phase, { size = null, type = null, testing = null, verifyMode = null, tenantHints = null, relatedExperiences = null, attachmentsText = null } = {}) {
  const activity = phaseToActivity(phase)
  const docs = new Set(ACTIVITY_DOCS[activity] || ['HARD_RULES'])
  const tools = toolsForActivity(activity)

  let instructions = ACTIVITY_INSTRUCTIONS[activity] || ''
  instructions += `\n${exitCriteriaFor(activity)}`
  if (size) {
    instructions += `\n当前规模：${size}（${SIZE_LABELS[size] || size}）`
  }
  // 经验复用闭环 v1（2026-09-26）：任务开始即推送按需求匹配的历史经验——推送优于拉取
  if (Array.isArray(relatedExperiences) && relatedExperiences.length) {
    instructions +=
      `\n历史相关经验（平台按需求自动匹配，动手前先看，避免踩同样的坑）：` +
      relatedExperiences.map((e) => `\n· [${e.id}#${e.category || 'dev'}] ${e.excerpt}`).join('')
  }
  // 任务上下文资产（2026-09-26）：需求文档/接口文档/设计稿引用随每个活动注入，不靠会话记忆
  if (attachmentsText) {
    instructions += `\n任务材料（需求/接口/设计，已随任务持久化，禁止凭记忆复述需求）：\n${attachmentsText}`
  }
  if (testing) {
    instructions += `\n测试由 Harness 控制（mode=${testing.mode}）。禁止让用户执行操作命令，禁止要求用户 git commit/push，也不要自己 commit——云端门禁与你的开发机通常不同工作区，改动靠 codeDiff（git diff 全文）+ codeCommitOid（base HEAD）上传，门禁切到 base 再应用 diff 做脏区快照送测（diff/rev-parse 均只读）。`
    if (testing.enabled === false) {
      // 云端测试已按仓关闭：指引切换为本地直通
      instructions += `\n${testing.hint}`
    } else {
      instructions += `\n写/改 E2E 前必须遵守 awp_test_spec_submit 工具说明中的平台契约：run({page,baseURL})、goto 用 \${baseURL}、单侧必须 side、优先 data-test。`
      if (testing.submitRequired) {
        instructions +=
          ` 离开 EXECUTE 前必须 awp_test_run(wait=true) 并等到终态；` +
          `harness_advance.data 必须带 gateBindingId、expectedTaskRevision。` +
          `requiredUnits=${JSON.stringify(testing.requiredUnits)}。` +
          `云端未绿禁止宣称任务完成。`
      }
    }
  }
  // 功能验证真源：云端健康则本地 L2 不作为必过节点
  if (verifyMode) {
    instructions += `\n功能验证真源：${verifyMode.source}。${verifyMode.hint}`
    if (verifyMode.showLocalVerify) {
      instructions += ` 本地兜底：verify.sh L2（taskId 上报）。`
    }
  }
  // 租户定制约束（rules/skills/openspec）：指路清单，全文在业务仓里 AI 可直接读
  if (tenantHints?.applicable) {
    if (tenantHints.invalid) {
      instructions += `\n⚠ 本项目 awp.config.json 解析失败：请修复 JSON 语法（租户定制约束未生效）。`
    } else {
      if (tenantHints.rules.length) {
        instructions += `\n本租户附加约束（写码前必读，文件在仓内）：${tenantHints.rules.map((r) => r.name).join('、')}。`
      }
      if (tenantHints.skills.length && (activity === 'retrieve' || activity === 'plan' || activity === 'execute')) {
        instructions += `\n本租户可用技能：${tenantHints.skills.map((s) => `${s.name}(${s.description || 'SKILL.md'})`).join('、')}。匹配当前工作时先读对应 SKILL.md。`
      }
      if (tenantHints.hasOpenspec && (activity === 'retrieve' || activity === 'plan')) {
        instructions += `\n本项目启用 OpenSpec：PLAN 前先读 openspec/ 目录的变更提案与规格。`
      }
    }
  }

  const current = PHASE_LABELS[phase] || { name: phase, summary: '' }
  // 云端健康时「功能验证」摘要改为云端口径（不展示本地 L2 节点语义）
  let phaseLabel = current
  if ((activity === 'static' || activity === 'smoke') && verifyMode?.source === 'cloud') {
    phaseLabel = {
      name: '功能验证',
      summary: '以云端门禁为准（本地 L2 非必过）；确认业务后 advance DONE',
    }
  } else if ((activity === 'static' || activity === 'smoke') && verifyMode?.source === 'local') {
    phaseLabel = {
      name: '功能验证',
      summary: '云端暂不可用，用本地 verify.sh L2 兜底并上报',
    }
  }

  return {
    docs: [...docs],
    instructions,
    tools,
    relatedExperiences: Array.isArray(relatedExperiences) ? relatedExperiences : [],
    testing,
    verifyMode: verifyMode || undefined,
    currentPhase: {
      phase,
      name: phaseLabel.name,
      summary: phaseLabel.summary,
      doingNow: `当前阶段：${phaseLabel.name} — ${phaseLabel.summary}`,
    },
    workflow: buildWorkflowView(phase, size, verifyMode),
    clrp: {
      protocol: 'CLRP/1',
      rules: [
        '云端测试未终态时禁止结束工作并宣称完成',
        '失败必须按 Remediation Packet 回环：suite 修资产 / product 修代码 / infra 报运维',
        '断线后 harness_status.resumable=true 必须续作，禁止 harness_start 冒充完成',
        '仅 phase=DONE 允许输出任务完成',
      ],
    },
  }
}
