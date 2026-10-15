/**
 * testing/failure-writeback.js — M5 旁路：run 终态后自动失败立案
 *
 * completeLease 成功回写后调用（旁路，不依赖 agent 是否 distill）：
 *  - 按 check 分类 suite/product/infra
 *  - product/suite/regression → recordFailure + createExperiencePending
 *  - infra → 仅 recordFailure，禁止进经验 pending（§23）
 * 同 fingerprint 已 open 时 recordFailure 自动 occurrence+1。
 */
import { classifyCheck } from '../harness/loop.js'
import { recordFailure, createExperiencePending } from './failures.js'

const EXPERIENCE_CLASSES = new Set(['suite', 'product', 'regression'])

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ runId, status, terminalReason, bindingId, taskInstanceId, repoId, checks }} input
 */
export async function writebackRunFailures(db, {
  runId,
  status,
  terminalReason = null,
  bindingId,
  taskInstanceId,
  repoId,
  checks = [],
}) {
  if (status !== 'failed' && status !== 'error') return { recorded: 0, pending: 0 }
  if (!repoId || !bindingId || !taskInstanceId) return { recorded: 0, pending: 0, skipped: 'missing identity' }

  if (terminalReason === 'infra_error' || terminalReason === 'timed_out' || status === 'error') {
    // infra：立案但不进经验
    const sig = String(terminalReason || status)
    try {
      const f = await recordFailure(db, {
        repoId,
        bindingId,
        taskInstanceId,
        failurePhase: 'unknown',
        failureClass: 'infra',
        errorSignature: `${runId}:${sig}`,
        caseKey: null,
      })
      return { recorded: 1, pending: 0, failureId: f.failureId, class: 'infra' }
    } catch (e) {
      process.stderr.write(`failure-writeback infra skip: ${e.message}\n`)
      return { recorded: 0, pending: 0 }
    }
  }

  let recorded = 0
  let pending = 0
  for (const c of checks || []) {
    if (!c || c.status === 'passed') continue
    // 归因结论优先（attributeSuiteChecks 已改判的真回归不能被 caseKey 推导盖回 suite）
    const attributed = c.class === 'product' || c.class === 'suite' || c.class === 'infra' ? c.class : null
    const cls = attributed || classifyCheck({ caseKey: c.caseKey, status: c.status, detail: c.detail })
    if (!cls) continue
    const failureClass = cls === 'suite' ? 'suite' : cls === 'infra' ? 'infra' : 'product'
    const phase = phaseFromCase(c.caseKey)
    const signature = `${c.caseKey}|${String(c.detail || c.status).slice(0, 200)}`
    let failureId
    try {
      const f = await recordFailure(db, {
        repoId,
        bindingId,
        taskInstanceId,
        failurePhase: phase,
        failureClass,
        errorSignature: signature,
        caseKey: c.caseKey || null,
      })
      failureId = f.failureId
      recorded += 1
    } catch (e) {
      process.stderr.write(`recordFailure skip ${c.caseKey}: ${e.message}\n`)
      continue
    }
    // infra 不进经验 pending（§23：平台问题不占用 AI 的沉淀/迭代）
    if (EXPERIENCE_CLASSES.has(failureClass) && failureId) {
      try {
        const content = [
          `云端门禁失败（run ${runId}）`,
          `case: ${c.caseKey}`,
          `class: ${failureClass}`,
          c.detail ? `detail: ${String(c.detail).slice(0, 400)}` : null,
          failureClass === 'suite'
            ? '处理：awp_test_spec_get/submit 修复资产（baseURL/side）→ distill_append → 重提 test_run'
            : '处理：distill_append 总结 → 修复业务代码 → 重提 test_run',
        ].filter(Boolean).join('\n')
        await createExperiencePending(db, {
          repoId,
          sourceId: failureId,
          failureClass,
          content,
          title: `gate-fail ${c.caseKey}`,
          tagsJson: ['gate-loop', failureClass, String(c.caseKey || '')],
        })
        pending += 1
      } catch (e) {
        process.stderr.write(`experience_pending skip ${c.caseKey}: ${e.message}\n`)
      }
    }
  }
  return { recorded, pending }
}

function phaseFromCase(caseKey) {
  const k = String(caseKey || '')
  if (k.includes('smoke') || k.startsWith('test:spec/')) return 'smoke'
  if (k.includes('static') || k.startsWith('test:unit-spec/')) return 'static'
  if (k.includes('vitest')) return 'static'
  return 'unknown'
}
