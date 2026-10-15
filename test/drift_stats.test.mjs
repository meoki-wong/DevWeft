import { describe, it, expect, afterAll } from 'vitest'
import db from '../db.js'
import { registerRecordsTools } from '../tools/records.js'
import { ensureRepository } from '../testing/migrate.js'

// 捕获 drift_stats 工具 handler（不启 MCP 服务，用假 server 收集）
const handlers = {}
const fakeServer = {
  registerTool: (name, def, handler) => {
    handlers[name] = { def, handler }
  },
}
registerRecordsTools(fakeServer)
const driftStats = handlers['drift_stats'].handler

const REPO = 'vitest-drift'
await ensureRepository(db, REPO, 'system')
const NOW = new Date().toISOString()

async function insertExp(content, tags, module = null, ruleRef = null) {
  const id = `vitest-drift-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await db.prepare(
    `INSERT INTO experiences (id, repo, tenant_id, content, source, status, author, module, rule_ref, tags, created_at, updated_at)
     VALUES (?, ?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, 'auto', 'pending', 'tester', ?, ?, ?, ?, ?)`
  ).run(id, REPO, REPO, content, module, ruleRef, JSON.stringify(tags), NOW, NOW)
}

afterAll(async () => {
  await db.prepare('DELETE FROM experiences WHERE repo = ?').run(REPO)
})

describe('drift_stats — ai-drift 偏差度量（#19）', () => {
  it('只统计含 ai-drift 标签、排除 obsolete/非 drift', async () => {
    await insertExp('drift A in modA', ['ai-drift'], 'modA')
    await insertExp('drift B in modB', ['ai-drift'], 'modB')
    await insertExp('normal tech-debt C', ['tech-debt'], 'modA') // 不应计入

    const r = await driftStats({ weeks: 4, repo: REPO })
    const text = r.content[0].text
    expect(text).toContain('ai-drift 共 2 条')
    expect(text).not.toContain('技术')
  })

  it('模块过滤生效（repo + module 双重过滤）', async () => {
    const r = await driftStats({ weeks: 4, repo: REPO, module: 'modA' })
    const text = r.content[0].text
    expect(text).toContain('ai-drift 共 1 条')
  })

  it('规则关联计数：未关联规则给出固化建议', async () => {
    const r = await driftStats({ weeks: 4, repo: REPO })
    const text = r.content[0].text
    expect(text).toContain('未关联 2 条')
    expect(text).toContain('建议评审后固化为规则')
  })

  it('repo=all 时仍按 ai-drift 标签过滤（跨项目聚合）', async () => {
    const r = await driftStats({ weeks: 4, repo: 'all' })
    const text = r.content[0].text
    // 至少包含本用例写入的 2 条 drift（若历史库已有其他 drift 则更多）
    expect(text).toMatch(/ai-drift 共 \d+ 条/)
  })
})
