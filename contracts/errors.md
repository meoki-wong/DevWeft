# 测试平台错误码

契约版本：`1.0.0`  
来源：本文是错误码清单的唯一权威来源；OpenAPI 错误枚举必须与本文一致。
HTTP 响应信封：`{ data, error, meta }`；成功时 `error` 必须为 `null`。

`error` 对象：

| 字段 | 必须 | 说明 |
|---|---|---|
| `code` | 是 | 下表错误码 |
| `validationErrors` | 仅 `INVALID_SCHEMA` | 服务端 schema 校验明细 |

未在本表出现的错误码禁止返回。MCP 工具错误码与本表一一对应。

| 错误码 | HTTP | 处置 |
|---|---:|---|
| `UNKNOWN_FIELD` | 400 | 客户端发送未定义字段，升级/修正客户端 |
| `INVALID_SCHEMA` | 400 | 按 validationErrors 修正 |
| `RUN_NOT_FOUND` | 404 | 检查 runId 是否属于当前项目并仍可读取 |
| `BLOB_STORE_UNAVAILABLE` | 503 | 确认主机 blob 服务与共享存储恢复后重试提交；备用机没有本地缓存 |
| `UNRESOLVED_REMOTE` | 403 | 管理员登记 provider project/remote |
| `CROSS_REPO_REFERENCE` | 403 | 拒绝并审计租户对象拼接 |
| `BRANCH_UNVERIFIED` | 409 | 刷新远程 ref；仅允许 task advisory，禁止正式门禁 |
| `BRANCH_GENERATION_CHANGED` | 409 | 重新 resolve、生成 binding 并测试 |
| `TASK_REVISION_CONFLICT` | 412 | 刷新 task 状态后重试 |
| `SNAPSHOT_HASH_MISMATCH` | 400 | 重新生成 bundle |
| `WORKSPACE_CHANGED_DURING_SNAPSHOT` | 409 | 停止修改文件后重试 |
| `BUNDLE_TOO_LARGE` | 413 | 拆分改动或管理员调整 repo 策略 |
| `SECRET_FILES_DETECTED` | 400 | 移除敏感文件；禁止默认绕过 |
| `SUITE_CASE_CONFLICT` | 409 | 修复 case_key/replaces 声明 |
| `PROTECTED_CASE_VIOLATION` | 403 | 移除覆盖；protected case 不允许 waiver |
| `SUITE_CAPABILITY_DENIED` | 403 | 申请已发布 profile/capability |
| `SUITE_REVOKED` | 409 | 重新选择有效 suite |
| `CANDIDATE_NOT_APPROVED` | 403 | 只能 advisory，发起语义审批 |
| `CANDIDATE_APPROVAL_STALE` | 409 | 重新 resolve prospective binding 并审批 |
| `AUTHOR_CANNOT_REVIEW` | 403 | 由其他 reviewer 审批 |
| `BINDING_STALE` | 409 | 按 staleReasons 重新提交 |
| `TASK_BINDING_SUPERSEDED` | 409 | 使用 active binding |
| `TARGET_BASE_MOVED` | 409 | 重新生成 snapshot/binding |
| `POLICY_CHANGED` | 409 | 重新 resolve suite plan |
| `PROFILE_CHANGED` | 409 | 重新 resolve binding |
| `IMAGE_CHANGED` | 409 | 按策略重新测试 |
| `STALE_LEASE` | 409 | Worker 丢弃结果并销毁 VM |
| `LEASE_EXPIRED` | 409 | Worker 立即停止 VM |
| `RUNSPEC_SIGNATURE_INVALID` | 400 | 停止 attempt 并告警 |
| `WORKSPACE_ATTESTATION_REQUIRED` | 409 | 在当前工作区重新签发单次证明 |
| `ARTIFACT_HASH_MISMATCH` | 400 | 删除临时产物并标记 attempt error |
| `ARTIFACT_TOO_LARGE` | 413 | 截断非必要产物并重传 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 使用新 key 或重放原请求 |
| `PRECONDITION_FAILED` | 412 | 读取最新 revision 后重做决策 |
| `CLIENT_TOO_OLD` | 426 | 按响应升级 CLI/Worker |
| `NODE_VERSION_UNSUPPORTED` | 409 | 使用受支持镜像/profile |
| `PRIVATE_REGISTRY_UNAVAILABLE` | 503 | 基础设施故障，不生成产品经验 |
| `TRANSLATION_FIXTURE_INVALID` | 409 | 修复或重新发布 fixture revision |
| `MOCK_CONTRACT_MISSING` | 409 | 评审并发布新的 mock contract revision |
| `GRANT_NOT_FOUND` | 404 | 控制面重新签发 grant；Worker 禁止猜测 secret_ref |
| `GRANT_ALREADY_FETCHED` | 409 | 同一 grant 禁止二次取回明文 |
| `GRANT_REVOKED` | 409 | 停止使用该 secret；需要则重新签发 |
| `GRANT_EXPIRED` | 409 | 停止 VM；控制面按 TTL 重新签发 |
| `GRANT_IDENTITY_MISMATCH` | 403 | worker/lease/capability 与 grant 不一致 |
| `SECRET_REF_UNKNOWN` | 404 | 运维向独立 broker 带外注入物料；禁止经控制面传明文 |
