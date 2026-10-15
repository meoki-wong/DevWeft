# 租户测试包模板

新仓接入时复制本目录为 `suites/<slug>/`，并填写：

1. `repo/manifest.json` — 套件元数据
2. `repo/specs/*.md` — 考卷说明
3. `repo/fixtures/contracts/*.json` — 契约 fixture（见 schema：`contracts/contract-fixture.schema.json`）
4. `repo/risk-paths.json` — 动态门禁风险路径（可选，平台 seed 进 `gate_risk_rules`）

## 契约 fixture 要求

- 每个业务关键接口至少 1 条成功 + 空态 + 错误
- `scenarios` 建议含 empty / boundary / no-permission
- E2E 考卷须覆盖断言三件套中至少两类：网络 / 数据 / 边界

## 平台策略（按仓）

- `enforce_spec_contract`：true=提交期硬拒浅考卷；false=仅告警
- `enable_sides`：是否启用多个配置 smoke lanes
- `dynamic_gate`：全局开关（platform_settings）
- 风险路径：`gate_risk_rules`（repo_id 可空=全局）
