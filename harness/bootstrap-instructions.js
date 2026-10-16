/** MCP InitializeResult.instructions for DevWeft clients. */
import db from '../db.js'

// QUERY_CLASS: PLATFORM — inject configured shared rules from repo='shared'.
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
  const rules = await loadRulesManifest()

  const lines = [
    'You are connected to DevWeft, a self-hosted engineering workflow and test evidence service.',
    repo
      ? `This connection is bound to repo: ${repo}.`
      : 'No repo bound on this connection; pass repo on tools when needed.',
    username ? `Attributed user: ${username}.` : null,
    'Use the selected repository as the scope for code changes and configured checks.',
    '',
  ].filter(Boolean)

  lines.push(
    '## Tracked task workflow',
    '- For a new tracked task, call harness_start. Resume an unfinished task with harness_status.',
    '- Use harness_advance to change the task phase and follow the allowed transitions returned by harness_status.',
    '- Report completion only after the task is in its terminal phase and required checks have real, successful results.',
    '- When a check fails, follow its remediation guidance and distinguish product, test, and infrastructure failures.',
    '- Follow repository instructions and any configured shared rules. Do not assume optional integrations are enabled.',
    ''
  )

  if (rules) {
    lines.push('## Configured shared rules', rules, '')
  }

  lines.push(
    '## Shared knowledge',
    'When shared knowledge is configured, query relevant prior lessons before repeating non-obvious work.',
    'Record concise, reusable lessons when useful. Never include credentials, personal data, private URLs, or unrelated source code.',
    '',
    'Use distill_query for relevant lessons. Use distill_append or lesson_record only for durable, reusable findings.',
    '',
    '## Test execution',
    '- Use awp_test_run only with a configured test runner. Wait for the run to reach a terminal status before reporting its result.',
    '- A remote runner cannot read a local worktree. Send a source patch only when the user has requested testing through that configured remote runner.',
    '- Before sending a patch, inspect it and include only the intended changes. Exclude credentials, private data, generated files, and unrelated work. Include a base commit only when the runner protocol requires it.',
    '- If the runner shares the same workspace or uses a local process, do not send a source patch.',
    '- Do not create commits or push changes unless requested.',
    ''
  )

  return lines.join('\n')
}
