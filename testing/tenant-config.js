/**
 * testing/tenant-config.js — 租户定制内容读取层（skills / rules / openspec / checks）
 *
 * 原则：配置放业务仓（awp.config.json + .awp/ 目录），随代码版本化；
 * 服务端通过 workspacePath 只读访问。读取失败一律降级为"无定制"，不阻断流程。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepoWorkspacePath } from './repo-platform.js'

function readWorkspaceConfig(workspaceDir) {
  for (const p of [join(workspaceDir, 'awp.config.json'), join(workspaceDir, '.awp', 'config.json')]) {
    if (!existsSync(p)) continue
    try {
      return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
    } catch {
      return { __invalid: true }
    }
  }
  return null
}

/** 解析租户工作区（未配置/不存在 → null） */
export function resolveTenantWorkspace(repoSlug, { env = process.env, repoRoot = null } = {}) {
  try {
    return resolveRepoWorkspacePath(repoSlug, { env, repoRoot })
  } catch {
    return null
  }
}

/**
 * 租户上下文提示（注入 harness context pack 的"指路清单"，不搬运全文——
 * 业务仓文件 AI 在 IDE 里本来就能读到）：
 *   rules: .awp/rules 下的 markdown 规则
 *   skills: .awp/skills 下各技能（SKILL.md 格式）
 *   openspec: openspec 目录存在性
 */
export function getTenantContextHints(repoSlug, { env = process.env, repoRoot = null } = {}) {
  try {
    const ws = resolveTenantWorkspace(repoSlug, { env, repoRoot })
    if (!ws) return { applicable: false, rules: [], skills: [], hasOpenspec: false }
    const cfg = readWorkspaceConfig(ws)
    if (!cfg) return { applicable: false, rules: [], skills: [], hasOpenspec: false }
    if (cfg.__invalid) {
      return { applicable: true, invalid: true, rules: [], skills: [], hasOpenspec: false }
    }
    const rules = []
    const rulesDir = join(ws, '.awp', 'rules')
    if (existsSync(rulesDir)) {
      for (const f of readdirSync(rulesDir)) {
        if (/\.md$/i.test(f)) {
          let excerpt = ''
          try { excerpt = readFileSync(join(rulesDir, f), 'utf8').slice(0, 160) } catch { }
          rules.push({ name: `.awp/rules/${f}`, excerpt })
        }
      }
    }
    for (const r of Array.isArray(cfg.rules) ? cfg.rules : []) {
      if (typeof r === 'string' && !rules.some((x) => x.name === r)) rules.push({ name: r, excerpt: '' })
    }
    const skillsDir = typeof cfg.skills === 'string' ? join(ws, cfg.skills) : join(ws, '.awp', 'skills')
    const skills = []
    if (existsSync(skillsDir)) {
      for (const d of readdirSync(skillsDir)) {
        if (existsSync(join(skillsDir, d, 'SKILL.md'))) {
          let description = ''
          try {
            const md = readFileSync(join(skillsDir, d, 'SKILL.md'), 'utf8')
            description = (md.split(/\r?\n/).find((l) => l.startsWith('description:')) || '').replace(/^description:\s*/, '').slice(0, 120)
          } catch { }
          skills.push({ name: d, path: `.awp/skills/${d}/SKILL.md`, description })
        }
      }
    }
    return {
      applicable: true,
      invalid: false,
      rules,
      skills,
      hasOpenspec: existsSync(join(ws, 'openspec')),
      acTemplate: typeof cfg.acTemplate === 'string' ? cfg.acTemplate : null,
    }
  } catch {
    return { applicable: false, rules: [], skills: [], hasOpenspec: false }
  }
}

/** 租户技能全文（awp_skill_get 用）；找不到返回 null */
export function getTenantSkill(repoSlug, skillName, { env = process.env, repoRoot = null } = {}) {
  try {
    const ws = resolveTenantWorkspace(repoSlug, { env, repoRoot })
    if (!ws) return null
    const cfg = readWorkspaceConfig(ws) || {}
    const skillsDir = typeof cfg.skills === 'string' ? join(ws, cfg.skills) : join(ws, '.awp', 'skills')
    const p = join(skillsDir, String(skillName || '').replace(/[^\w.-]/g, ''), 'SKILL.md')
    if (!existsSync(p)) return null
    return { name: String(skillName), path: `.awp/skills/${skillName}/SKILL.md`, content: readFileSync(p, 'utf8') }
  } catch {
    return null
  }
}
