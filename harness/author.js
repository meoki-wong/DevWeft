/**
 * author.js — 会话 username 与占位作者（cursor-agent 等）归一
 *
 * IDE 常把 author 填成 cursor-agent；真实使用人在 MCP URL ?username= 或
 * x-awp-username。占位名不能参与「提交人 ≠ 任务负责人 → ai-drift」判定。
 */

export const PLACEHOLDER_AUTHORS = new Set([
  'cursor-agent',
  'cursor',
  'assistant',
  'unknown',
  'ai',
  'agent',
])

/** 需要 author 字段的 MCP 工具（schema 含 author，可安全回填） */
export const AUTHOR_TOOLS = new Set([
  'harness_start',
  'harness_advance',
  'distill_append',
  'distill_set_status',
  'lesson_record',
  'verify_report',
  'update_doc',
  'task_state',
  'awp_test_run',
  'awp_test_spec_submit',
  'awp_test_spec_review_status',
  'awp_task_attach',
  'awp_design_call',
])

export function isPlaceholderAuthor(name) {
  const n = String(name || '').trim().toLowerCase()
  return !n || PLACEHOLDER_AUTHORS.has(n)
}

/**
 * 显式 author 若为空或占位，改用连接级 username；否则保留显式值。
 * forceConn=true：只要连接有 username 就强制用连接身份（任务负责人=MCP 挂载用户）。
 */
export function resolveToolAuthor(explicit, connUser, { forceConn = false } = {}) {
  const a = String(explicit || '').trim()
  const u = String(connUser || '').trim()
  if (forceConn && u) return u
  if (isPlaceholderAuthor(a)) return u || a
  return a
}

/**
 * 仅当双方都是真人且不相等时，才视为「别人在修 AI 偏差」。
 */
export function isRealAuthorMismatch(gitAuthor, taskAuthor) {
  if (isPlaceholderAuthor(gitAuthor) || isPlaceholderAuthor(taskAuthor)) return false
  return String(gitAuthor).trim() !== String(taskAuthor).trim()
}

/**
 * 连接级 repo 归一（静默接入）：MCP URL ?repo= 或请求头 x-awp-repo。
 * 只接受全小写 slug（字母数字开头，可含 . _ -），大小写自动归一；
 * 提供但非法时明确报错，而不是静默落到默认仓 demo-app 造成串仓。
 */
export function normalizeRepoSlug(raw) {
  if (raw == null || raw === '') return { provided: false, ok: true, slug: null }
  const s = String(raw).trim().toLowerCase()
  if (!s) return { provided: true, ok: false, slug: null, reason: 'repo 不能为空' }
  if (s.length > 63) return { provided: true, ok: false, slug: null, reason: 'repo 过长（>63 字符）' }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
    return { provided: true, ok: false, slug: null, reason: `repo 含非法字符：${s}` }
  }
  return { provided: true, ok: true, slug: s }
}
