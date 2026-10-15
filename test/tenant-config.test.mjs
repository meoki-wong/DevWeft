/**
 * tenant-config.test.mjs — 批次四：租户定制（skills/rules/checks 读取层）
 *
 * 1. getTenantContextHints：rules/skills/openspec 扫描 + 坏 JSON 降级
 * 2. getTenantSkill：全文读取 + 非法名净化
 * 3. runTenantChecks（guest）：通过/失败/skip 三态（spawn cmd /c echo 类脚本）
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getTenantContextHints, getTenantSkill } from '../testing/tenant-config.js'
import { runTenantChecks } from '../runner/guest-agent/static.mjs'

function wsRoot({ withConfig = true, config = null, skills = null, rules = null, openspec = false } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'awp-tenant-'))
  // resolveRepoWorkspacePath uses the configured workspace; the fixture supplies package.json.
  writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'tenant-fixture' }))
  if (withConfig) {
    mkdirSync(join(ws, '.awp'), { recursive: true })
    writeFileSync(
      join(ws, '.awp', 'config.json'),
      JSON.stringify(config || { skills: '.awp/skills', rules: [] })
    )
  }
  if (skills) {
    for (const name of skills) {
      mkdirSync(join(ws, '.awp', 'skills', name), { recursive: true })
      writeFileSync(join(ws, '.awp', 'skills', name, 'SKILL.md'), `---\ndescription: ${name} 的用法\n---\n正文`)
    }
  }
  if (rules) {
    mkdirSync(join(ws, '.awp', 'rules'), { recursive: true })
    for (const name of rules) writeFileSync(join(ws, '.awp', 'rules', name), `# ${name} 规则内容示例`)
  }
  if (openspec) mkdirSync(join(ws, 'openspec', 'changes'), { recursive: true })
  return ws
}

describe('getTenantContextHints（租户上下文指路）', () => {
  it('扫描 rules/skills/openspec 并带描述', () => {
    const ws = wsRoot({ skills: ['table-page'], rules: ['coding.md'], openspec: true })
    const h = getTenantContextHints('demo-app', { env: { AWP_REPO_PATH_DEMO_APP: ws } })
    expect(h.applicable).toBe(true)
    expect(h.skills.map((s) => s.name)).toEqual(['table-page'])
    expect(h.skills[0].description).toContain('table-page 的用法')
    expect(h.rules.map((r) => r.name)).toEqual(['.awp/rules/coding.md'])
    expect(h.rules[0].excerpt).toContain('coding.md 规则内容')
    expect(h.hasOpenspec).toBe(true)
  })

  it('无配置 → 不适用；坏 JSON → invalid 标记（不抛异常）', () => {
    const noCfg = wsRoot({ withConfig: false })
    expect(getTenantContextHints('demo-app', { env: { AWP_REPO_PATH_DEMO_APP: noCfg } }).applicable).toBe(false)
    const wsBad = wsRoot({ withConfig: false })
    writeFileSync(join(wsBad, 'awp.config.json'), '{ broken json')
    const h = getTenantContextHints('demo-app', { env: { AWP_REPO_PATH_DEMO_APP: wsBad } })
    expect(h.applicable).toBe(true)
    expect(h.invalid).toBe(true)
  })
})

describe('getTenantSkill（全文读取）', () => {
  it('读取 SKILL.md 全文；名字非法被净化', () => {
    const ws = wsRoot({ skills: ['table-page'] })
    const s = getTenantSkill('demo-app', 'table-page', { env: { AWP_REPO_PATH_DEMO_APP: ws } })
    expect(s.content).toContain('table-page 的用法')
    expect(getTenantSkill('demo-app', '../escape', { env: { AWP_REPO_PATH_DEMO_APP: ws } })).toBeNull()
  })
})

describe('runTenantChecks（guest 租户检查三态）', () => {
  it('无配置 → skipped passed', () => {
    const ws = mkdtempSync(join(tmpdir(), 'awp-tenant-none-'))
    const r = runTenantChecks({ workspaceDir: ws })
    expect(r[0].status).toBe('passed')
    expect(r[0].detail).toContain('未定制')
  })

  it('检查通过 → passed；检查失败 → failed 带输出', () => {
    const ws = wsRoot({ config: { checks: [{ name: 'always-ok', script: 'echo ok' }] } })
    const pass = runTenantChecks({ workspaceDir: ws })
    expect(pass[0].status).toBe('passed')
    expect(pass[0].detail).toContain('1 项')

    const wsFail = wsRoot({ config: { checks: [{ name: 'always-fail', script: 'exit /b 3' }] } })
    const fail = runTenantChecks({ workspaceDir: wsFail })
    expect(fail[0].status).toBe('failed')
    expect(fail[0].detail).toContain('always-fail')
  })

  it('坏 JSON → failed', () => {
    const wsBad = mkdtempSync(join(tmpdir(), 'awp-tenant-bad2-'))
    writeFileSync(join(wsBad, 'awp.config.json'), '{ broken')
    const r = runTenantChecks({ workspaceDir: wsBad })
    expect(r[0].status).toBe('failed')
    expect(r[0].detail).toContain('解析失败')
  })
})
