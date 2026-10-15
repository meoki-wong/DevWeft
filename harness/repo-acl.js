/**
 * repo-acl.js — Harness 入口权限（方案第 4 节）
 *
 * 开关：platform_settings 键 `harness_repo_acl`，值 `off`/`on`，缺省 `off`（方案决定 4）。
 * - off：行为与今天完全一致
 * - on：写任务类工具要求 `submit`；只读类工具要求 `read_result`；
 *   repo 先换成 repo_id 再调用 requireRepoPermission（testing/auth.js），失败码 CROSS_REPO_REFERENCE
 *
 * 权限判断必须用注入之后的最终 repo（方案 §8.1）。本模块不新增权限值、不改 ACL CHECK。
 */
import { getPlatformSetting } from './gate-policy.js'
import { findPrincipalBySubject, createPrincipal, requireRepoPermission } from '../testing/auth.js'

/** 会写任务的工具 → submit（方案 §8.1 第 3 条） */
export const HARNESS_ACL_WRITE_TOOLS = new Set([
  'harness_start',
  'harness_advance',
  'awp_test_run',
  'awp_loop_wait',
  'awp_loop_resume',
  'verify_report',
  'task_state',
  'distill_append',
])

/** 只读工具 → read_result */
export const HARNESS_ACL_READ_TOOLS = new Set([
  'harness_status',
  'get_doc',
  'query_docs',
  'list_docs',
])

export async function getHarnessRepoAclMode(db) {
  // 缺省必须 'off'（方案 §8.1 第 4 条）
  const mode = await getPlatformSetting(db, 'harness_repo_acl', 'off')
  return mode === 'on' ? 'on' : 'off'
}

/**
 * 入口 ACL 检查。返回 null = 放行（含开关 off / 工具不在清单内）；返回 { code, blockedBy } = 拒绝。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ toolName: string|null, repo: string|null, username: string|null }} input
 */
export async function enforceHarnessRepoAcl(db, { toolName, repo, username }) {
  if (!toolName) return null
  const isWrite = HARNESS_ACL_WRITE_TOOLS.has(toolName)
  const isRead = HARNESS_ACL_READ_TOOLS.has(toolName)
  if (!isWrite && !isRead) return null
  if (await getHarnessRepoAclMode(db) !== 'on') return null

  const permission = isWrite ? 'submit' : 'read_result'
  const subject = username ? String(username) : null
  let principal = subject ? await findPrincipalBySubject(db, subject) : null
  if (!principal && subject) {
    // 首次出现的使用人：建 principal，但不授予任何仓权限（方案 §8.1 第 1 条）
    try {
      await createPrincipal(db, { subject, displayName: subject })
      principal = await findPrincipalBySubject(db, subject)
    } catch { /* 并发创建等：按无权限处理 */ }
  }
  if (!principal) {
    return {
      code: 'CROSS_REPO_REFERENCE',
      blockedBy: [`harness_repo_acl=on：未识别的使用人（username 缺失或无效），要求 ${permission}`],
    }
  }

  const acl = await db
    .prepare('SELECT repo_id, permission FROM principal_repo_acl WHERE principal_id = ?')
    .all(principal.principal_id)
  const repoRow = repo
    ? await db.prepare('SELECT repo_id FROM repositories WHERE slug = ?').get(String(repo))
    : null
  try {
    // repo 先换 repo_id；仓不存在/未授权 → CROSS_REPO_REFERENCE（方案 §8.1 第 3 条）
    requireRepoPermission({ acl }, repoRow ? repoRow.repo_id : null, permission)
  } catch {
    return {
      code: 'CROSS_REPO_REFERENCE',
      blockedBy: [
        `harness_repo_acl=on：subject=${subject} 对 repo=${repo || '(未提供)'} 缺少 ${permission} 权限`,
      ],
    }
  }
  return null
}
