/**
 * tools/skills.js — 租户技能 MCP 工具（内容在业务仓 .awp/skills/，服务端只读）
 */
import { z } from 'zod'
import { getTenantSkill, getTenantContextHints } from '../testing/tenant-config.js'

function textOut(s) {
  return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] }
}

export function registerSkillTools(server) {
  server.registerTool(
    'awp_skills_list',
    {
      title: '列出本租户可用技能',
      description:
        '列出当前项目业务仓 .awp/skills/ 下的技能清单（名称 + 描述）。' +
        '匹配当前工作时用 awp_skill_get 读对应 SKILL.md 全文。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ repo = 'demo-app' }) => {
      const hints = getTenantContextHints(repo)
      if (!hints.applicable) return textOut(`项目 ${repo} 无业务仓工作区或未配置技能（.awp/skills/）。`)
      if (hints.invalid) return textOut(`⚠ 项目 ${repo} 的 awp.config.json 解析失败。`)
      if (!hints.skills.length) return textOut(`项目 ${repo} 暂无技能（.awp/skills/ 为空）。`)
      return textOut(
        hints.skills.map((s) => `- ${s.name}：${s.description || '(无描述)'}（${s.path}）`).join('\n')
      )
    }
  )

  server.registerTool(
    'awp_skill_get',
    {
      title: '读取租户技能全文',
      description: '按名称读取技能 SKILL.md 全文。名称来自 awp_skills_list。',
      inputSchema: {
        name: z.string().describe('技能名（awp_skills_list 列出的名称）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ name, repo = 'demo-app' }) => {
      const skill = getTenantSkill(repo, name)
      if (!skill) return textOut(`技能不存在：${name}（awp_skills_list 查看可用清单）`)
      return textOut(`# ${skill.name}\n\n${skill.content}`)
    }
  )
}
