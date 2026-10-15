/**
 * 任务上下文资产（2026-09-26）：awp_task_attach 背后的服务端逻辑
 * attach/list/summaries 全链路 + 校验边界 + contextPack 注入
 */
import { describe, expect, it } from 'vitest'
import { memdb } from './helpers/memdb.mjs'
import { attachTaskAsset, listTaskAttachments, taskAttachmentSummaries, ATTACHMENT_KINDS } from '../harness/attachments.js'
import { buildContextPack } from '../harness/context.js'

describe('attachTaskAsset 挂载与校验', () => {
  it('挂载需求文档 → 列表可读全文', async () => {
    const { db, slug, close } = await memdb()
    const r = await attachTaskAsset({
      repo: slug, taskId: 'T-1', kind: 'requirement',
      title: '优惠券需求 v2', content: '# 需求\n1. 列表展示\n2. 领取幂等', author: 'alice',
      conn: db,
    })
    expect(r.ok !== false).toBeTruthy()
    expect(r.chars).toBeGreaterThan(5)
    const rows = await listTaskAttachments(slug, 'T-1', { conn: db })
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('requirement')
    expect(rows[0].content).toContain('领取幂等')
    expect(rows[0].author).toBe('alice')
    close()
  })

  it('url-only（蓝湖链接）合法；content/url 都缺 → 拒绝', async () => {
    const { db, slug, close } = await memdb()
    expect((await attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'design', url: 'https://lanhuapp.com/x', author: 'a' , conn: db })).url).toBeTruthy()
    await expect(attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'api', author: 'a' , conn: db })).rejects.toThrow(/content 与 url/)
    close()
  })

  it('kind 白名单与超长 content 拒绝', async () => {
    const { db, slug, close } = await memdb()
    expect(ATTACHMENT_KINDS).toContain('requirement')
    await expect(attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'hack', content: 'x', author: 'a' , conn: db })).rejects.toThrow(/INVALID_SCHEMA/)
    await expect(
      attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'api', content: 'x'.repeat(100_001), author: 'a' , conn: db })).rejects.toThrow(/超限/)
    close()
  })

  it('未知仓显式报错（不静默默认仓）', async () => {
    const { db, close } = await memdb()
    await expect(attachTaskAsset({ repo: 'no-such-repo', taskId: 'T-1', kind: 'api', content: 'x', author: 'a' , conn: db })).rejects.toThrow(/UNRESOLVED_REPO/)
    close()
  })
})

describe('taskAttachmentSummaries → contextPack 注入', () => {
  it('按类型预算生成摘要：需求给足、超限截断提示', async () => {
    const { db, slug, close } = await memdb()
    await attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'requirement', title: '需求', content: 'R'.repeat(2000), author: 'a' , conn: db })
    await attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'api', title: '接口', content: 'A'.repeat(2000), author: 'a' , conn: db })
    await attachTaskAsset({ repo: slug, taskId: 'T-1', kind: 'design', url: 'https://lanhuapp.com/d/1', author: 'a' , conn: db })
    const s = await taskAttachmentSummaries(slug, 'T-1', { conn: db })
    expect(s).toContain('【需求文档】')
    expect(s).toContain('【接口文档】')
    expect(s).toContain('【设计稿】')
    expect(s).toContain('https://lanhuapp.com/d/1')
    expect(s).toContain('已截断') // 需求 2000 > 预算 1500
    close()
  })

  it('无附件返回 null；contextPack 无附件段', async () => {
    const { db, slug, close } = await memdb()
    expect(await taskAttachmentSummaries(slug, 'T-none', { conn: db })).toBeNull()
    const pack = buildContextPack('execute', {})
    expect(pack.instructions).not.toContain('任务材料')
    close()
  })

  it('contextPack 有附件时注入"任务材料"段', async () => {
    const pack = buildContextPack('execute', { attachmentsText: '【需求文档】优惠券' })
    expect(pack.instructions).toContain('任务材料')
    expect(pack.instructions).toContain('优惠券')
  })
})
