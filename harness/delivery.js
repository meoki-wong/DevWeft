/**
 * harness/delivery.js — DONE 交付包（2026-09-26）
 *
 * 流程事实（务必与代码一致）：代码由 aicoding 侧写在开发机上，平台侧不写码、不留码
 * （送测 diff 在 submit-run.js finally 中 ensurePristineWorkspace 复位）。
 * 因此交付包是"随 DONE 返回的收尾文本"：通用变更说明 + 建议 commit message
 * + 收尾清单，代码托管动作永远发生在开发机。
 * 数据源全部为库内现成事实：changed files / AC 覆盖 / 轮数 / 考卷变更 / artifact 下载。
 */
import { changedFilesForBinding } from '../testing/impact.js'
import { evaluateAcCoverage } from './testing-gate.js'

export async function buildDeliveryPack(db, { repo, taskId }) {
  const task = await db.prepare('SELECT requirement, type, phase, closed_at FROM tasks WHERE repo=? AND task_id=?').get(repo, taskId)
  if (!task) return null
  const loop = await db.prepare('SELECT iteration, last_binding_id FROM gate_loops WHERE repo=? AND task_id=?').get(repo, taskId) || null

  let files = []
  try {
    files = (loop?.last_binding_id ? await changedFilesForBinding(db, loop.last_binding_id) : []) || []
  } catch { files = [] }

  let ac = { covered: [], missing: [] }
  try {
    const c = await evaluateAcCoverage(db, { repoSlug: repo, taskId })
    ac = { covered: c?.covered || [], missing: c?.missing || [] }
  } catch { /* AC 评估失败不阻断交付包 */ }

  let specs = []
  try {
    specs = await db.prepare(
      `SELECT feature_key, version, review_status, spec_type FROM test_specs
       WHERE repo_id=(SELECT repo_id FROM repositories WHERE slug=?) AND demand_ref=?
       ORDER BY feature_key, version`
    ).all(repo, taskId)
  } catch { specs = [] }

  let rounds = 0
  try {
    rounds = (await db.prepare(
      `SELECT COUNT(*) c FROM test_submissions s
       JOIN task_instances ti ON ti.task_instance_id=s.task_instance_id
       WHERE ti.repo_id=(SELECT repo_id FROM repositories WHERE slug=?) AND ti.external_task_id=?`
    ).get(repo, taskId))?.c || 0
  } catch { rounds = 0 }

  let lastRunId = null
  try {
    lastRunId = (await db.prepare(
      `SELECT r.run_id FROM test_runs r
       JOIN task_instances ti ON ti.task_instance_id=r.task_instance_id
       WHERE ti.repo_id=(SELECT repo_id FROM repositories WHERE slug=?) AND ti.external_task_id=? AND r.purpose='gate'
       ORDER BY r.created_at DESC LIMIT 1`
    ).get(repo, taskId))?.run_id || null
  } catch { lastRunId = null }

  const title = String(task.requirement || '').split('\n')[0].trim().slice(0, 60) || taskId
  const acLine = ac.covered.length
    ? `AC 覆盖 ${ac.covered.length} 条${ac.missing.length ? `（另有未覆盖 ${ac.missing.length} 条）` : ''}`
    : '无 AC 记录'
  const specLine = specs.length
    ? `${specs.length} 个考卷版本（${[...new Set(specs.map((s) => s.feature_key))].join('、')}）`
    : '无新增考卷'

  const commitMsg = `feat(${repo}): ${title}\n\n- 任务 ${taskId} 云端门禁通过（${rounds} 轮）\n- ${acLine}\n- ${specLine}`

  const lines = []
  lines.push(`════ 任务交付包 ════`)
  lines.push(`任务：${taskId}  ${title}（${task.type || 'FEATURE'}）`)
  lines.push(`状态：DONE · 云端门禁 ${rounds} 轮`)
  lines.push(``)
  lines.push(`── ① 建议 commit message ──`)
  lines.push(commitMsg)
  lines.push(``)
  lines.push(`── ② 变更说明 ──`)
  lines.push(`【变更内容】`)
  lines.push(`${title}（任务 ${taskId}，云端门禁通过）`)
  lines.push(`【改动文件】${files.length ? `（${files.length} 个）` : ''}`)
  lines.push(...(files.length ? files.slice(0, 30).map((f) => `- ${f}`) : ['-（以你本地工作区实际改动为准）']))
  lines.push(`【测试情况】`)
  lines.push(`· 云端门禁：${rounds} 轮通过`)
  lines.push(`· ${specLine}`)
  lines.push(`· ${acLine}`)
  lines.push(``)
  lines.push(`── ③ 收尾清单（在你自己的机器上做）──`)
  lines.push(`□ 1. 确认本地工作区为最终版（一切以你本地未提交改动为准）`)
  lines.push(`□ 2. git add -A && git commit（用上面的 message；开发期"禁止 commit/push"约束至此解除）`)
  lines.push(`□ 3. 将分支推送到项目配置的 Git 远端，并按团队流程完成代码评审`)
  lines.push(`□ 4. 按项目交付流程更新需求状态`)
  if (lastRunId) {
    lines.push(``)
    lines.push(`── ④ 备份 ──`)
    lines.push(`最后一次送测快照下载：GET /v1/test-runs/${lastRunId}/artifact/content（仅当本地改动意外丢失时用）`)
  }
  return {
    taskId, repo, rounds, changedFiles: files, ac, specs: specs.length, lastRunId,
    commitMessage: commitMsg,
    text: lines.join('\n'),
  }
}
