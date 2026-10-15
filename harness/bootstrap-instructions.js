/**
 * bootstrap-instructions.js — MCP InitializeResult.instructions
 * 业务仓 AGENTS.md 仅 bootstrap；工作流铁律与硬规则摘要在此注入。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import db from '../db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let contractCache = null
function loadWorkflowContract() {
  if (contractCache != null) return contractCache
  try {
    contractCache = readFileSync(
      path.join(__dirname, '..', 'seed', 'AGENTS_WORKFLOW_CONTRACT.md'),
      'utf8'
    )
  } catch {
    contractCache = ''
  }
  return contractCache
}

// QUERY_CLASS: PLATFORM —— 读 repo='shared' 的规则真源，跨租户注入 instructions（方案 §2.7/§7.1）
// 上限 4000 字符：RULES_MANIFEST 由 update_doc 写入且会注入到每一次会话，
// 无上限会让一条超长规则撑爆整个 initialize 响应。
const RULES_MANIFEST_MAX_CHARS = 4000

async function loadRulesManifest() {
  try {
    const row = await db
      .prepare(
        "SELECT content FROM docs WHERE repo = 'shared' AND name = 'RULES_MANIFEST' ORDER BY updated_at DESC LIMIT 1"
      )
      .get()
    const text = String(row?.content || '').trim()
    return text.length > RULES_MANIFEST_MAX_CHARS
      ? `${text.slice(0, RULES_MANIFEST_MAX_CHARS)}\n…（规则清单过长已截断）`
      : text
  } catch {
    return ''
  }
}

/**
 * @param {{ repo?: string|null, username?: string|null }} ctx
 * @returns {string}
 */
export async function buildBootstrapInstructions(ctx = {}) {
  const repo = ctx.repo || null
  const username = ctx.username || null
  const contract = loadWorkflowContract().trim()
  const rules = await loadRulesManifest()

  const lines = [
    'You are connected to agent-workflow-platform (team harness).',
    repo
      ? `This connection is bound to repo: ${repo}.`
      : 'No repo bound on this connection; pass repo on tools when needed.',
    username ? `Attributed user: ${username}.` : null,
    'Business repositories only contain a bootstrap AGENTS.md. THIS server is the source of truth.',
    '',
  ].filter(Boolean)

  if (contract) {
    lines.push(
      '## Workflow',
      '1. New task: harness_start. Resume: harness_status.',
      '2. Only harness_advance changes phase.',
      '3. Do not claim done until phase=DONE and planned static/smoke are green.',
      '4. Failures follow the Remediation Packet.',
      '5. Hard rules: read HARD_RULES via query_docs when editing code. Do not invent rules from the business repo.',
      ''
    )
  } else {
    lines.push(
      '## Workflow iron rules',
      '1. New task: harness_start. Resume unfinished task: harness_status first.',
      '2. Only harness_advance changes phase.',
      '3. Do not claim done while cloud test is not terminal.',
      '4. Failures loop via Remediation Packet (suite/product/infra).',
      '5. After disconnect, resume from harness_status; do not fake-complete with a new start.',
      '6. Done only when phase=DONE.',
      ''
    )
  }

  lines.push(
    '## Always first',
    '- 新任务：harness_start。续作：harness_status。',
    '- 只有 harness_advance 能改阶段。',
    '- 未完成不得宣称任务完成。',
    '- 当前活动不允许的工具会返回 TOOL_NOT_IN_ACTIVITY。',
    ''
  )

  // 团队规则真源（docs RULES_MANIFEST）。此前 rules 查出来却从未拼进输出，
  // 导致「遇到 bug 先 distill_query」这类铁律从未真正到达 AI。
  if (rules) {
    lines.push('## Team hard rules（团队硬规则，改代码前必读）', rules, '')
  }

  lines.push(
    '## 经验沉淀（知识飞轮）',
    '团队经验库是唯一团队记忆。你不写，别人也会重复踩同一个坑。',
    '',
    '动手前：遇到不熟的写法/组件/报错，先 distill_query 查关键词（如 distill_query("白屏")）。命中了就按经验改，别自己试错。',
    '',
    '踩坑后：以下情况必须 distill_append 沉淀，不许留到下轮——',
    '- 排查耗时超过 2 轮的 bug；',
    '- 云端测试返回 suite 类失败（考卷/脚本本身写错）；',
    '- 某写法看似可行但被硬规则/门禁打回；',
    '- 发现团队规则与实际不符。',
    '',
    'content 模板（四段，缺一不可，便于他人检索复用）：',
    '现象：<什么场景下、报什么错/什么表现>',
    '根因：<真正的原因>',
    '修法：<具体怎么改，命令或代码片段>',
    '适用条件：<什么版本/什么条件下适用>',
    '',
    `category：dev=开发经验（写码时查，默认）；test=测试考卷经验（修脚本时查）。`,
    '跨仓通用经验（例如构建配置与常见 UI framework issues）用 lesson_record 写入 shared 命名空间。',
    ''
  )

  lines.push(
    '## 云端测试下单顺序（不要跳步）',
    '1. harness_advance(execute) 进入开发阶段。',
    '2. 写/改考卷 → awp_test_spec_submit(featureKey, content, acceptanceRefs, pages, side)。',
    '   content 是完整 Playwright/Vitest 用例；acceptanceRefs 对齐任务 AC id；pages 填该用例覆盖的页面路径（平台据此决定是否注入，勿乱填否则该卷不会被执行）。',
    '3. awp_test_run(taskId, codeDiff, codeCommitOid) 下单——这两个参数必传，缺了门禁读不到你的改动。',
    '4. awp_loop_wait 等结果（勿空转重下单，重复下单会烧迭代额度）。',
    '5. 按返回的分类处理：product=改业务代码；suite=改考卷；infra=平台问题，等自动重试，不要浪费一轮改代码。',
    '6. harness_advance(next) 推进；仅在全绿时 advance 到 done。',
    '',
    '云端测试跨机器：门禁读不到你磁盘的改动。下单时必须传 codeDiff（`git add -N .` 后 `git diff` 全文）+ codeCommitOid（`git rev-parse HEAD`）；门禁切到你的 base 再应用 diff 做脏区快照。全程只读，禁止 git commit/push，也禁止要求用户提交代码。',
    ''
  )

  return lines.join('\n')
}
