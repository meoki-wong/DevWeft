/**
 * harness/attachments.js — 任务上下文资产（需求文档/接口文档/设计引用）
 *
 * 背景（2026-09-26）：需求文档/接口文档此前只活在 IDE 会话里，平台侧"失明"——
 * 会话压缩后 AI 忘需求是返工主源。本模块把任务简报变成一等公民资产：
 *   attach（AI 上传）→ 随 contextPack 每个活动注入（推送优于拉取）→ 全程审计。
 * 表：task_attachments（migration v32）。
 */
import db from '../db.js'
import { uuidv7, utcNow } from '../testing/ids.js'
import { recordAuditEvent } from '../audit/index.js'

export const ATTACHMENT_KINDS = ['requirement', 'api', 'design', 'other']
const KINDS = new Set(ATTACHMENT_KINDS)
const MAX_CONTENT_CHARS = 100_000
// contextPack 注入配额：需求给足，接口次之，总盘受限（AI 侧 token 成本可控）
const SUMMARY_BUDGET = { requirement: 1500, api: 900, design: 300, other: 300, maxTotal: 3200 }

/** 挂载任务资产（AI 上传需求/接口文档或设计链接）；conn 可注入（测试/旁路） */
export async function attachTaskAsset({ repo, taskId, kind, title = null, content = null, url = null, author, conn = db }) {
  if (!repo || !taskId || !KINDS.has(String(kind))) {
    throw Object.assign(new Error(`INVALID_SCHEMA: repo/taskId/kind 必填，kind 须为 ${ATTACHMENT_KINDS.join('/')}`), { code: 'INVALID_SCHEMA' })
  }
  const c = content == null ? null : String(content)
  const u = url == null ? null : String(url).trim() || null
  if (!c && !u) throw Object.assign(new Error('INVALID_SCHEMA: content 与 url 至少传一个'), { code: 'INVALID_SCHEMA' })
  if (c && c.length > MAX_CONTENT_CHARS) {
    throw Object.assign(new Error(`INVALID_SCHEMA: content 超限（>${MAX_CONTENT_CHARS} 字符），请拆分或只传要点`), { code: 'INVALID_SCHEMA' })
  }
  const repoRow = await conn.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(String(repo))
  if (!repoRow) throw Object.assign(new Error(`UNRESOLVED_REPO: ${repo}`), { code: 'UNRESOLVED_REPO' })
  const id = uuidv7()
  const now = utcNow()
  await conn.prepare(
    `INSERT INTO task_attachments(attachment_id, repo_id, task_id, kind, title, content, url, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, repoRow.repo_id, String(taskId), String(kind), title ? String(title).slice(0, 200) : null, c, u, author ? String(author).slice(0, 80) : null, now)
  try {
    await recordAuditEvent({
      eventType: 'task_asset_attached',
      toolName: 'awp_task_attach',
      method: 'mcp',
      repo: String(repo),
      taskId: String(taskId),
      author,
      status: 'ok',
      detail: `kind=${kind} title=${title || '-'} chars=${c ? c.length : 0} url=${u ? 'yes' : 'no'}`,
      payload: { kind, attachmentId: id },
    })
  } catch { /* 审计失败不阻断 */ }
  return { attachmentId: id, kind, title: title || null, chars: c ? c.length : 0, url: u }
}

/** 列取任务全部附件（含全文，供 AI 按需取） */
export async function listTaskAttachments(repo, taskId, { maxCharsPer = 20_000, conn = db } = {}) {
  const repoRow = await conn.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(String(repo))
  if (!repoRow) return []
  const rows = await conn.prepare(
    `SELECT attachment_id, kind, title, content, url, author, created_at FROM task_attachments
     WHERE repo_id=? AND task_id=? ORDER BY created_at ASC, attachment_id ASC`
  ).all(repoRow.repo_id, String(taskId))
  return rows.map((r) => ({
    attachmentId: r.attachment_id,
    kind: r.kind,
    title: r.title,
    url: r.url,
    author: r.author,
    createdAt: r.created_at,
    content: r.content ? String(r.content).slice(0, maxCharsPer) : null,
    truncated: r.content ? r.content.length > maxCharsPer : false,
  }))
}

/**
 * contextPack 注入文本（推送优于拉取）：需求给足预算、接口次之、总盘受限。
 * 任何异常静默返回 null——注入是增益不是依赖。
 */
export async function taskAttachmentSummaries(repo, taskId, { conn = db } = {}) {
  try {
    const repoRow = await conn.prepare('SELECT repo_id FROM repositories WHERE slug=?').get(String(repo))
    if (!repoRow) return null
    const rows = await conn.prepare(
      `SELECT kind, title, content, url FROM task_attachments
       WHERE repo_id=? AND task_id=? ORDER BY created_at ASC, attachment_id ASC`
    ).all(repoRow.repo_id, String(taskId))
    if (!rows.length) return null
    const KIND_LABEL = { requirement: '需求文档', api: '接口文档', design: '设计稿', other: '附件' }
    let total = 0
    const blocks = []
    for (const r of rows) {
      const budget = SUMMARY_BUDGET[r.kind] || SUMMARY_BUDGET.other
      let body = ''
      if (r.content) {
        body = String(r.content).slice(0, budget)
        if (r.content.length > budget) body += `\n…[已截断，全文用 awp_task_attach_list 获取]`
      } else if (r.url) {
        body = `链接：${r.url}`
      }
      if (!body) continue
      total += body.length
      if (total > SUMMARY_BUDGET.maxTotal) { blocks.push(`…[附件过多，其余用 awp_task_attach_list 获取]`); break }
      blocks.push(`【${KIND_LABEL[r.kind] || r.kind}】${r.title || ''}\n${body}`)
    }
    return blocks.length ? blocks.join('\n') : null
  } catch {
    return null
  }
}
