# awp AI 协作（固定模板 · 请勿按仓修改）

本仓库通过 MCP 服务 **awp-ai** 接入团队 Harness。

1. 开始任何编码任务前，先使用 MCP 工具 `harness_start`（若存在未完成任务，先 `harness_status` 续作）。
2. 具体阶段步骤、完成定义、硬规则、云端门禁，一律以 MCP 下发为准（连接后 `instructions` + `harness_status.contextPack` + 工具说明）。
3. 本文件与 MCP 冲突时，**以 MCP 为准**。禁止在本文件维护阶段细则或门禁规则。
4. 仅当 MCP 工具列表里没有 awp-ai 相关 harness 工具时，才降级为普通开发，并向用户说明。
5. 云端测试跨机器：门禁读不到你磁盘的改动。下单时必须传 `codeDiff`（`git add -N .` 后 `git diff` 全文）+ `codeCommitOid`（`git rev-parse HEAD`），**全程只读生成，无需 `git commit`/`git push`，禁止要求用户提交代码**。

业务仓接入只保留本文件 + `.mcp.json`。硬约束由云端 MCP 注入，不在业务仓维护。

<!-- awp-agents-template: v3 -->
