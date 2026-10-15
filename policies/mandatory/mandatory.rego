# policies/mandatory/mandatory.rego — 方案 §10：强制层（只升不降 + checkGuard 已测阻断）
# 输入由 JS 组装（证据/DB 读取留在 JS）；策略不做任何数据库连接（§16.1）。
# blocked 非空 → 拒绝推进；mandatory 的阻断任何租户包不得覆盖（§16.2）。
package awp.mandatory

import rego.v1

mode_rank := {"disabled": 0, "legacy": 1, "observe": 2, "enforce_s": 3, "enforce_ml": 4, "enforce_all": 5}

# —— checkGuard:plan → execute 须先记录 pending 或 decisions ——
blocked contains {"code": "PLAN_RECORD_REQUIRED", "message": "plan 须记录 pending 或 decisions"} if {
	input.feature == "harness.guard"
	input.phase == "plan"
	input.target == "execute"
	input.facts.pendingCount == 0
	input.facts.decisionsCount == 0
}

# —— checkGuard:离开 execute 须至少一次新鲜 L1 ——
# L1 只是本地自检（prettier/eslint/build），不含 E2E；E2E 由云端门禁（awp_test_run）执行
l1_message := "离开 execute 前须至少一次 L1 通过（verify_report 带 taskId）。L1 只是本地自检（prettier/eslint/build），不含 E2E；E2E 由云端门禁（awp_test_run）执行。" if {
	some r in input.facts.l1Reasons
	r == "no_report"
} else := concat("", ["L1 证据不新鲜：", concat("、", input.facts.l1Reasons)])

blocked contains {"code": "L1_REQUIRED", "message": l1_message} if {
	input.feature == "harness.guard"
	input.phase == "execute"
	input.target in {"static", "smoke", "done"}
	not input.facts.l1Ok
}

# —— checkGuard:done 时云端不可用须本地 L2 兜底 ——
blocked contains {"code": "L2_REQUIRED", "message": "云端门禁不可用：须本地 L2 通过（verify.sh L2）作为功能验证兜底"} if {
	input.feature == "harness.guard"
	input.phase in {"static", "smoke", "distill"}
	input.target == "done"
	input.facts.needLocalL2
	not input.facts.l2Ok
}

# —— checkGuard:done 时风险路径/契约变更须 l3Confirmed ——
blocked contains {"code": "L3_REQUIRED", "message": "命中风险路径或契约变更，完成前须 data.l3Confirmed=true"} if {
	input.feature == "harness.guard"
	input.phase in {"static", "smoke", "distill"}
	input.target == "done"
	input.facts.riskPath
	not input.facts.l3Confirmed
}

blocked contains {"code": "L3_REQUIRED", "message": "命中风险路径或契约变更，完成前须 data.l3Confirmed=true"} if {
	input.feature == "harness.guard"
	input.phase in {"static", "smoke", "distill"}
	input.target == "done"
	input.facts.contractTouch
	not input.facts.l3Confirmed
}

# —— gate 模式只升不降（§16.1：只升不降写在 mandatory）——
blocked contains {"code": "MODE_DOWNGRADE", "message": sprintf("模式只升不降：candidate=%v 低于 repoMode=%v", [input.facts.candidateMode, input.facts.repoMode])} if {
	input.feature == "gate.policy"
	input.facts.candidateMode != null
	mode_rank[input.facts.candidateMode] < mode_rank[input.facts.repoMode]
}

decision := {"blocked": blocked}
