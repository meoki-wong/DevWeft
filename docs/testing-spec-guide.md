# 测试资产编写指南

平台按仓库保存并执行 E2E 与单元测试资产。具体构建命令和工作区由仓库 profile 配置；平台不包含任何业务项目路由、原生容器模拟或构建脚本。

## E2E 测试

每个 E2E 资产使用 ESM 默认导出：

```js
export default async function run({ page, baseURL, expect }) {
  await page.goto(baseURL)
  await expect(page.locator('body')).toBeVisible()
}
```

编写时遵循以下约定：

- 用注入的 `baseURL` 构造导航地址。
- 优先使用稳定的 `data-test` 属性或可访问角色。
- 只写应用断言；启动、构建和环境准备放在仓库 profile 与 runner 中。
- 使用状态等待和响应等待，避免固定时长的 sleep。
- 同一业务行为使用稳定的 `featureKey`，变更断言时更新同一资产。
- 需要按多个 smoke lane 执行时，在仓库 profile 配置 lane 和 impact 规则；无法从文件推断时显式传入 side。

提交时平台会检查 ESM 语法、受支持的依赖以及必要的运行参数，不会在提交接口中执行测试文件。执行结果、日志与截图会关联到对应任务和资产版本。

## 单元测试

单元资产验证纯逻辑，不使用 Playwright 页面对象。示例：

```js
import { describe, it, expect } from 'vitest'

describe('formatAmount', () => {
  it('formats cents as a decimal amount', () => {
    expect((1234 / 100).toFixed(2)).toBe('12.34')
  })
})
```

## 资产生命周期

新提交的资产进入活动状态。执行失败会累计失败次数并产生待处理状态；团队可以修订、停用或归档资产。更新既有功能时优先扩展原有 `featureKey`，避免为同一行为创建重复资产。

## 运行档位

- S：静态检查。
- M：静态检查；页面或集成类任务可按配置增加 smoke。
- L：按任务绑定和仓库 profile 执行完整回归。

任务大小由服务端任务信息决定，提交方不能通过测试请求绕过门禁策略。
