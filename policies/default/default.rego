# policies/default/default.rego — 方案 §10：默认层（resolveGatePolicy 已测的升级决策）
# 升级证据（risk-path/large-diff/task-fail-streak/contract-ac 的因子）由 JS 组装进 input.factors；
# 本层只做决策：任一 enforce 因子 → effectiveMode 升至 enforce_all，否则维持 repoMode。
# 只升不降由 mandatory 层强制（§16.1）；租户包可整体替换本层输出，但不得覆盖 mandatory。
package awp.default

import rego.v1

mode_rank := {"disabled": 0, "legacy": 1, "observe": 2, "enforce_s": 3, "enforce_ml": 4, "enforce_all": 5}

enforce_factor_exists if {
	some f in input.factors
	f.effect == "enforce"
}

effective_mode := "enforce_all" if {
	enforce_factor_exists
} else := input.facts.repoMode

# 默认层自身不产生阻断；阻断集中在 mandatory（守卫规则）与租户包
blocked := []

decision := {"blocked": blocked, "effectiveMode": effective_mode}
