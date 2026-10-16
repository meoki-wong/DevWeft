# DevWeft 实机部署与主备验收矩阵

本文提供 D05 的可复现检查步骤和证据模板。只在明确获准的测试主机、测试数据库和可丢弃数据上执行故障注入；不要在生产网络上制造交换机、防火墙或服务故障。

## 0. 填写运行信息

每轮验收先复制下面表格到内部/本地验收记录。提交到公开仓库前，只保留脱敏结果，删除主机名、用户名、IP、数据库 URL、token、证书、仓库地址和业务数据。

| 字段 | 实际值 |
|---|---|
| 验收日期（含时区） | 待填写 |
| 验收人 / 变更或任务号 | 待填写 |
| DevWeft commit | `git rev-parse HEAD` |
| Windows 版本/Build/Edition | 待填写 |
| PowerShell 版本 | `$PSVersionTable.PSVersion` |
| Node.js / npm / PM2 版本 | `node --version; npm --version; pm2 --version` |
| PostgreSQL 版本及模式 | 待填写：真实外部 / Windows embedded / 不适用 |
| Hyper-V 版本与 VM 开关 | 待填写：可用/不可用；本轮 true/false |
| 验收环境标识 | 待填写：一次性 VM / 隔离测试机 / 其他 |
| 证据目录（仓库外） | 待填写 |

建议证据目录在仓库之外。只保存命令输出、脱敏日志、截图、版本信息和测试结果；不要复制数据库文件、私钥、token 或 VHDX 到报告中。

## 1. 基础 Windows 单机（SQLite，无 Hyper-V）

目标：确认公开仓库在普通 Windows 主机可一键部署，不要求 Hyper-V、预制 VM 镜像或 PostgreSQL。

1. 在干净 Windows 测试机克隆本仓库并切到待验收 commit。
2. 复制 `data/deploy.env.example` 为 `data/deploy.env`，确认 `AWP_DB_DIALECT=sqlite`、`AWP_HYPERV_ENABLED=false`。
3. 在仓库根目录运行：

   ```powershell
   .\deploy.cmd
   .\start-primary.cmd
   Invoke-RestMethod http://127.0.0.1:8791/api/health/ready | ConvertTo-Json -Depth 8
   pm2 status
   ```

4. 运行 `npm test`，并按 README 的公开 `example-app` 步骤完成一次本地示例测试。
5. 记录 `/api/health/ready` 的 `node.role=primary`、`node.executionMode=disabled`、`blobStorage.mode=local` 和 `blobStorage.ok=true`。确认 PM2 列表没有 `awp-blob-store`、`awp-host-worker`。

通过条件：部署命令退出码为 0；ready 为 200；示例运行成功；SQLite 模式不启动独立 blob/Hyper-V 进程。

## 2. Windows PostgreSQL 主机

优先使用隔离测试数据库。共享主备测试应使用管理员预先创建的 PostgreSQL 数据库/登录，数据库必须允许应用账号创建和迁移 schema。单机体验可单独验证 Windows embedded PostgreSQL，但 embedded 数据库不能直接作为跨主机共享数据库。

### 2.1 外部或共享 PostgreSQL

1. 在忽略的 `data/deploy.env` 设置 `AWP_DB_DIALECT=postgres`、`AWP_PG_MODE=external` 和测试数据库 `AWP_PG_URL`。不要把 URL 放进命令行参数、截图或证据文件。
2. 运行连接/权限预检和部署：

   ```powershell
   npm run postgres:check -- --schema-only
   .\deploy.cmd
   .\start-primary.cmd
   npm run postgres:check
   Invoke-RestMethod http://127.0.0.1:8791/api/health/ready | ConvertTo-Json -Depth 8
   Invoke-RestMethod http://127.0.0.1:8792/api/health/ready | ConvertTo-Json -Depth 8
   pm2 status
   ```

3. 确认控制面与 blob 服务都显示 `ready=true`，PM2 包含 `awp-blob-store`，且两服务的 `blobStorage` 都指向预期的本地主机存储配置。
4. 运行 PostgreSQL 备份并在隔离数据库验证 restore 的 dry-run；按 [backup/restore 说明](../ONBOARDING.md) 操作，不能把真实备份作为验收附件。

### 2.2 Windows embedded PostgreSQL（单机）

在可丢弃的 Windows 虚拟机上单独测试 `AWP_PG_MODE=embedded` 的首次初始化、重复启动和保留现有 cluster 行为。记录 data path、监听端口、首次初始化退出码及第二次部署结果。必须确认脚本发现已有 `PG_VERSION` 时不会重跑 `initdb` 或删除数据库文件。不要用 embedded 模式声称完成主备验收。

## 3. Hyper-V worker 主机

前置条件：支持 Hyper-V 的 Windows edition、管理员权限、已授权的 Windows 安装媒体、已构建的 golden VHDX、准确的 `installed-components.json`/SBOM，以及测试数据库中签名有效的 active image。仓库不分发 Windows 镜像。

1. 先保持 `AWP_HYPERV_ENABLED=false`，完成第 1 节控制面基础部署。
2. 依照 [runner image 步骤](../ONBOARDING.md)生成 SBOM、发布并验证镜像：

   ```powershell
   npm run image:sbom -- --components data\runner\installed-components.json --image-id <本轮唯一镜像 ID> --out data\runner\images\<本轮唯一镜像 ID>.sbom.json
   npm run image:publish -- publish --image-id <本轮唯一镜像 ID> --vhdx data\runner\images\golden.vhdx --sbom data\runner\images\<本轮唯一镜像 ID>.sbom.json --mode active
   npm run image:verify -- --vhdx data\runner\images\golden.vhdx
   ```

3. 在 `data/deploy.env` 设置 `AWP_HYPERV_ENABLED=true` 和一个经确认无冲突的 RFC1918 `/24`；先仅运行只读网络预检：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\ensure-isolated-network.ps1 -PreflightOnly
   ```

4. 保存预检输出及当前主机网络资源清单；无冲突后再从管理员 PowerShell 运行 `.deploy.cmd`、`.start-primary.cmd` 和 `.scripts\verify-test-platform.ps1`。
5. 验收 active image 签名/哈希、Internal switch、proxy `.1`、guest 网络、worker PM2 进程及一条可销毁测试任务。记录 VM 创建和销毁结果、worker heartbeat 与失败/成功运行证据。

通过条件：合法镜像完成 guest 启动与受限网络测试；control-plane、broker、blob 等禁止端口不能从 guest 访问；测试 VM 和临时数据按流程清理。镜像缺失/哈希不符时应在改主机网络前停止。

## 4. 网络安全失败路径

只在可回滚的专用 Windows VM 做会改变系统配置的冲突构造。先保留 VM 快照及冲突前后的 `Get-VMSwitch`、`Get-NetIPAddress`、`Get-NetRoute`、`Get-NetFirewallRule` 输出。

| 场景 | 检查步骤 | 预期结果 |
|---|---|---|
| 已用网段与 runner `/24` 重叠 | `-PreflightOnly` 选择一个仅与测试 VM 网卡/路由重叠的 CIDR | 报 `SUBNET_OVERLAP` 或 `ROUTE_OVERLAP` 并非零退出；IP、路由、交换机及防火墙规则前后不变 |
| 同名 switch 类型不兼容 | 在测试 VM 预建相同名称的非 Internal switch，再运行只读 preflight | 报 `SWITCH_TYPE_CONFLICT`；不得转换或删除该 switch |
| 同名网卡/防火墙规则配置冲突 | 在测试 VM 创建策略不一致的资源，再运行只读 preflight | 报对应冲突码；不覆盖、不删除现存资源 |
| active image 缺失或哈希不符 | 使用隔离的测试 DB/image fixture 执行部署/worker 启动预检 | 在网络 setup、proxy 与 worker 启动前失败；不改主机网络 |

若不能安全构造真实资源冲突，记录“实机冲突分支未运行”，附当前只读检查结果；不要在日常开发机上为了让矩阵全绿而制造网络冲突。

## 5. 主备与 blob 故障矩阵

前置条件：两个隔离 Windows 主机、同一个可达的真实 PostgreSQL 测试库、主机固定/稳定的 blob endpoint、两台主机时钟同步，以及用于测试的 token。不得用 SQLite 或 PGlite 替代真实主备数据库验收。

1. **主机正常态**：主机设 `AWP_DB_DIALECT=postgres`、`AWP_HYPERV_ENABLED=false`；部署后确认 `http://127.0.0.1:8791/api/health/ready` 与 `http://127.0.0.1:8792/api/health/ready` 为 200。
2. **启动备用机**：在另一台主机将 `data/node.env.example` 复制为忽略文件 `data/node.env`，设置同一 `AWP_PG_URL` 和备用控制面 `PORT`。本矩阵需要验证控制面重启期间 blob 服务持续可用，因此将 `AWP_BLOB_BASE_URL` 显式设为主机可达的独立 blob endpoint（默认 `http://<主机 IP>:8792`）；普通运行也可留空并从共享数据库中看板配置的非 loopback 主链路解析。按需安全复制 bootstrap token，然后运行 `.start-standby.cmd`。
3. 查询备用机 `http://127.0.0.1:<备用 PORT>/api/health/ready`。期望 200、`node.role=standby`、`executionMode=disabled`、`blobStorage.mode=remote`、`localCache=false`。确认备用机不启动 Hyper-V worker、不创建本地 blob 副本。
4. **控制面进程重启**：在隔离测试环境单独停止主机 `devweft` 控制面，保持 PostgreSQL 与 `awp-blob-store` 存活。备用 readiness 应仍为 200，主机 blob endpoint 应仍能响应；随后恢复主控制面。记录恢复和探针时间。
5. **blob 故障注入**：仅在隔离环境运行 `pm2 stop awp-blob-store`。期望主机 readiness 仍反映本地存储可用，但 `standbyUploadEndpoint.ok=false`；备用 `/api/health/ready` 为 503，状态 `remote_unavailable`，没有本地缓存。对备用机 blob prepare 路由发送一次非生产测试请求，应返回 `BLOB_STORE_UNAVAILABLE` 503。
6. **恢复**：运行 `pm2 restart awp-blob-store --update-env`，确认 blob 服务及 standby readiness 恢复为 200。重新提交一个新的测试样例，确认工件存在于主机规范存储，不存在于备用机本地目录。
7. **主机丢失语义**：只做桌面演练/故障切换计划评审，不在本轮删除主机数据。说明 PostgreSQL 共享本身不会复制 blob；必须先把 blob 存储从已验证备份/副本恢复，或将稳定 blob endpoint 切到已恢复的规范存储，才能声明制品服务恢复。

用于快速观察响应（正常状态及 503 都会输出）：

```powershell
curl.exe -sS -i http://127.0.0.1:8791/api/health/ready
curl.exe -sS -i http://127.0.0.1:8792/api/health/ready
curl.exe -sS -i http://127.0.0.1:<备用 PORT>/api/health/ready
```

通过条件：节点角色与进程匹配；blob 断开不被误报成 standby ready；主机控制面健康与 standby 上传通道降级能区分；恢复后新提交成功；操作人能明确说明恢复 artifact durability 所需的数据步骤。

## 6. 每个场景的结果与证据

| ID | 场景 | 结果：通过/失败/未运行 | 运行时间 | 脱敏证据路径 | 问题/跟进项 |
|---|---|---|---|---|---|
| W01 | SQLite 单机与示例 | 未运行 |  |  |  |
| W02 | 外部 PostgreSQL 主机 | 未运行 |  |  |  |
| W03 | Windows embedded PostgreSQL 单机 | 未运行/不适用 |  |  |  |
| W04 | Hyper-V 合法镜像与 guest | 未运行 |  |  |  |
| W05 | 网络/镜像冲突 fail-closed | 未运行 |  |  |  |
| W06 | 共享 PG 主备正常启动 | 未运行 |  |  |  |
| W07 | 主控制面停机、blob 持续服务 | 未运行 |  |  |  |
| W08 | blob 断连、readiness 降级、恢复重试 | 未运行 |  |  |  |
| W09 | PostgreSQL 与 blob 分开备份/恢复演练 | 未运行 |  |  |  |

关闭验收时，逐项写明真实设备、软件版本、commit、测试时间、退出码和实际结果。失败要保存可脱敏的错误码与日志片段，并创建跟进项；未运行项必须保持“未运行”，不能用单元测试、PGlite、静态检查或模拟输出来替代实机结论。

## 7. 当前自动化环境记录

2026-10-15，当前实施环境为 macOS。`npm run verify:release -- --audit` 本地通过（147 个测试文件、1185 项通过、7 项环境跳过）；D04 定向测试与 PowerShell BOM 检查通过。用户可提供主备环境，但当前不在内网，无法连接目标 Windows、CMD/PowerShell、Hyper-V 和真实 PostgreSQL 主备设施，所以 W01–W09 暂缓且保持“未运行”。这些本地结果不能证明真实 Windows 部署、网络变更、PG failover 或 blob 备份恢复成功。回到内网后按本矩阵执行并记录真实证据。
