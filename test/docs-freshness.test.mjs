/**
 * docs-freshness.test.mjs — 文档新鲜度护栏
 *
 * README / ONBOARDING 里的 MCP 工具清单必须与 tools/ 代码实际注册一致：
 * 数量一致 + 每个工具名都出现。新增/删除工具时忘了更新文档，这里直接红。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 从 tools/*.js 源码提取注册的工具名（registerTool( 与名称常跨行） */
function registeredToolNames() {
  const names = new Set()
  const files = readdirSync(join(ROOT, 'tools')).filter((f) => f.endsWith('.js'))
  for (const f of files) {
    const src = readFileSync(join(ROOT, 'tools', f), 'utf8')
    const re = /server\.registerTool\(\s*['"]([a-z0-9_]+)['"]/gs
    let m
    while ((m = re.exec(src)) !== null) names.add(m[1])
  }
  return names
}

describe('文档新鲜度（工具清单与代码一致）', () => {
  const tools = registeredToolNames()

  it('护栏自身有效：tools/ 下确实注册了工具', () => {
    expect(tools.size).toBeGreaterThanOrEqual(20)
  })

  it('README 工具总数与代码注册一致，且列出每个工具名', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const m = readme.match(/##\s*(\d+)\s*个 MCP 工具/)
    expect(m, 'README 缺少 "## N 个 MCP 工具" 标题').toBeTruthy()
    expect(Number(m[1]), 'README 标题里的工具数量过期').toBe(tools.size)
    for (const name of tools) {
      expect(readme, `README 工具表缺少 ${name}`).toContain(`\`${name}\``)
    }
  })

  it('ONBOARDING 工具总数与代码注册一致，且列出每个工具名', () => {
    const doc = readFileSync(join(ROOT, 'ONBOARDING.md'), 'utf8')
    const m = doc.match(/可用 MCP 工具（(\d+) 个）/)
    expect(m, 'ONBOARDING 缺少 "可用 MCP 工具（N 个）" 标题').toBeTruthy()
    expect(Number(m[1]), 'ONBOARDING 标题里的工具数量过期').toBe(tools.size)
    for (const name of tools) {
      expect(doc, `ONBOARDING 缺少工具 ${name}`).toContain(name)
    }
  })
})
