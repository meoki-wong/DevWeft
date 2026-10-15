/**
 * knowledge.js — 知识库工具（规范文档的存储与查询）
 * 替代旧 MCP 的 get_doc / query_style / query_ui_pattern / get_component_doc 等
 * 所有规范文档存储在 SQLite docs 表，支持 FTS5 全文搜索
 * 多租户：repo 字段隔离不同项目的规范
 */
import { isPostgres } from '../db/dialect-helpers.js'
import { z } from 'zod'
import db from '../db.js'

/** FTS5 引号转义：把 " 转义为 ""，外层再包一对 "，避免 (test / AND 等语法错误（#2 防崩） */
export function ftsEscape(keyword) {
  return `"${String(keyword).replace(/"/g, '""')}"`
}

/** get_doc：按名称获取规范文档全文 */
// QUERY_CLASS: TENANT —— docs.repo = ? 精确匹配，不回落 shared（方案 §2.7/§7.1）
function registerGetDoc(server) {
  server.registerTool(
    'get_doc',
    {
      title: '获取规范文档',
      description:
        '按名称获取项目规范文档全文。可用 list_docs 查看所有文档名。常见：CODING_STANDARDS / HARD_RULES / ANTI_PATTERNS / API_CONVENTIONS / ROUTER_GUIDE / MODULE_TEMPLATE / COMPONENT_INDEX / I18N_GUIDE / STYLE_INVENTORY / UI_PATTERNS / flow-triage / flow-lifecycle 等。',
      inputSchema: {
        name: z.string().describe('文档名称（大写下划线或 flow-xxx）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app；shared = 跨项目通用'),
      },
    },
    async ({ name, repo = 'demo-app' }) => {
      const row = await db.prepare(
        'SELECT name, category, content, updated_at, updated_by FROM docs WHERE repo = ? AND name = ?'
      ).get(repo, name)

      if (!row) {
        return { content: [{ type: 'text', text: `文档未找到：${name}（repo=${repo}）。可用 list_docs 查看所有文档。` }] }
      }

      return {
        content: [
          {
            type: 'text',
            text: `# ${row.name}\n\n分类: ${row.category || '未分类'}\n更新: ${row.updated_at}（${row.updated_by || 'unknown'}）\n\n---\n\n${row.content}`,
          },
        ],
      }
    }
  )
}

/** list_docs：列出所有可用文档 */
function registerListDocs(server) {
  server.registerTool(
    'list_docs',
    {
      title: '列出规范文档',
      description: '列出后端所有可用的规范文档。可选按分类过滤。如 list_docs() 或 list_docs("flow")。',
      inputSchema: {
        category: z.string().optional().describe('按分类过滤（coding/rules/api/flow/style/ui/component/router/module/i18n）'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ category, repo = 'demo-app' }) => {
      let rows
      if (category) {
        rows = await db.prepare(
          'SELECT name, category, updated_at FROM docs WHERE repo = ? AND category = ? ORDER BY name'
        ).all(repo, category)
      } else {
        rows = await db.prepare(
          'SELECT name, category, updated_at FROM docs WHERE repo = ? ORDER BY category, name'
        ).all(repo)
      }

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `无文档（repo=${repo}${category ? `, category=${category}` : ''}）。` }] }
      }

      const list = rows.map((r) => `- **${r.name}** [${r.category || '未分类'}] — 更新于 ${r.updated_at}`).join('\n')
      return { content: [{ type: 'text', text: `可用文档（${rows.length} 个）：\n${list}` }] }
    }
  )
}

/** query_docs：FTS5 全文搜索规范文档 */
// QUERY_CLASS: TENANT —— docs.repo = ? 精确匹配，不回落 shared（方案 §2.7/§7.1）
function registerQueryDocs(server) {
  server.registerTool(
    'query_docs',
    {
      title: '搜索规范文档',
      description:
        'FTS5 全文搜索所有规范文档。替代旧 query_style / query_ui_pattern。如 query_docs("border-radius") 或 query_docs("Empty 组件", "coding")。',
      inputSchema: {
        keyword: z.string().describe('搜索关键词'),
        category: z.string().optional().describe('按分类过滤'),
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
      },
    },
    async ({ keyword, category, repo = 'demo-app' }) => {
      // §2.8:sqlite 走 FTS5 MATCH + bm25;postgres 走 pg_trgm ILIKE(基线已建 GIN),无 bm25 时按更新时间排序
      let sql = isPostgres(db)
        ? `SELECT d.name, d.category, substr(d.content, 1, 300) as preview,
               0 as rank
        FROM docs d
        WHERE (d.content ILIKE ? OR d.name ILIKE ?) AND d.repo = ?`
        : `
        SELECT d.name, d.category, substr(d.content, 1, 300) as preview,
               bm25(docs_fts) as rank
        FROM docs_fts f
        JOIN docs d ON d.rowid = f.rowid
        WHERE docs_fts MATCH ? AND d.repo = ?
      `
      const kwLike = `%${keyword}%`
      const ftsQuery = ftsEscape(keyword)
      const params = isPostgres(db) ? [kwLike, kwLike, repo] : [ftsQuery, repo]

      if (category) {
        sql += ' AND d.category = ?'
        params.push(category)
      }

      sql += ' ORDER BY rank LIMIT 10'

      let rows
      try {
        rows = await db.prepare(sql).all(...params)
      } catch (e) {
        return { content: [{ type: 'text', text: `搜索失败：${e.message}` }] }
      }

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: `文档搜索未命中：${keyword}` }] }
      }

      const results = rows
        .map((r) => `### ${r.name} [${r.category || '未分类'}]\n${r.preview}...`)
        .join('\n\n')
      return { content: [{ type: 'text', text: `搜索 "${keyword}" 命中 ${rows.length} 个文档：\n\n${results}` }] }
    }
  )
}

/** update_doc：创建或更新规范文档（可选 baseVersion 乐观锁） */
function registerUpdateDoc(server) {
  server.registerTool(
    'update_doc',
    {
      title: '更新规范文档',
      description:
        '创建或更新一条规范文档。团队维护规范无需 git commit，即时生效，全团队可见。' +
        '可选 baseVersion：与 docs_versions 最新版本不一致时返回 DOC_VERSION_CONFLICT，防止覆盖云端人工修订。',
      inputSchema: {
        name: z.string().describe('文档名称（大写下划线，如 CODING_STANDARDS）'),
        content: z.string().describe('文档全文（Markdown）'),
        category: z.string().optional().describe('分类：coding/rules/api/flow/style/ui/component/router/module/i18n'),
        repo: z.string().optional().describe('项目标识，默认 demo-app；shared = 跨项目通用'),
        author: z.string().describe('操作人（必填，可追溯）'),
        baseVersion: z.number().optional().describe('乐观锁：期望的当前版本号；不匹配则拒绝写入'),
      },
    },
    async ({ name, content, category, repo = 'demo-app', author, baseVersion = null }) => {
      const now = new Date().toISOString()

      const lastVersion = await db.prepare(
        'SELECT COALESCE(MAX(version), 0) as v FROM docs_versions WHERE repo = ? AND name = ?'
      ).get(repo, name)
      const currentVersion = lastVersion?.v || 0
      if (baseVersion != null && baseVersion !== currentVersion) {
        return {
          content: [
            {
              type: 'text',
              text: `DOC_VERSION_CONFLICT: ${name} 当前版本 v${currentVersion}，请求 baseVersion=v${baseVersion}。请先 get_doc 刷新后再改，或显式省略 baseVersion 强制覆盖。`,
            },
          ],
        }
      }

      const existing = await db.prepare(
        'SELECT content, category FROM docs WHERE repo = ? AND name = ?'
      ).get(repo, name)
      const nextVersion = currentVersion + 1

      const tx = async (tx) => {
        // 首次创建也记版本账本，baseVersion 语义完整
        await tx.prepare(`
          INSERT INTO docs_versions (repo, tenant_id, name, version, content_before, content_after, category_before, category_after, author, created_at)
          VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          repo, repo, name, nextVersion,
          existing?.content ?? null, content,
          existing?.category ?? null, category || existing?.category || null,
          author, now
        )
        await tx.prepare(`
          INSERT INTO docs (repo, tenant_id, name, category, content, updated_at, updated_by)
          VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?)
          ON CONFLICT(repo, name) DO UPDATE SET
            category = COALESCE(excluded.category, docs.category),
            content = excluded.content,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `).run(repo, repo, name, category || null, content, now, author)
      }
      await db.tx(tx)

      return {
        content: [
          {
            type: 'text',
            text:
              `文档已更新：${name}（repo=${repo}, category=${category || '未变'}, v${nextVersion}, ${content.length} chars）` +
              `，已存快照（可 GET /api/docs/versions?name=${name} 查看 / POST /api/docs/rollback 回滚）`,
          },
        ],
      }
    }
  )
}

/** update_docs_batch：多文档原子发布（全成或全败） */
function registerUpdateDocsBatch(server) {
  server.registerTool(
    'update_docs_batch',
    {
      title: '批量原子更新规范文档',
      description:
        '一次事务写入多条文档；任一 baseVersion 冲突则整体失败，不留下半更新索引。供 import-modules 等批量导入使用。',
      inputSchema: {
        repo: z.string().optional().describe('项目标识，默认 demo-app'),
        author: z.string().describe('操作人'),
        baseVersions: z
          .record(z.number())
          .optional()
          .describe('name → 期望版本号映射；省略某 name 表示不检查'),
        docs: z
          .array(
            z.object({
              name: z.string(),
              content: z.string(),
              category: z.string().optional(),
            })
          )
          .describe('待写入文档列表'),
      },
    },
    async ({ repo = 'demo-app', author, baseVersions = {}, docs = [] }) => {
      if (!Array.isArray(docs) || docs.length === 0) {
        return { content: [{ type: 'text', text: 'docs 为空' }] }
      }
      const now = new Date().toISOString()
      try {
        const results = []
        const tx = async (tx) => {
          for (const d of docs) {
            const lastVersion = await tx.prepare(
              'SELECT COALESCE(MAX(version), 0) as v FROM docs_versions WHERE repo = ? AND name = ?'
            ).get(repo, d.name)
            const currentVersion = lastVersion?.v || 0
            if (baseVersions[d.name] != null && baseVersions[d.name] !== currentVersion) {
              const err = new Error(
                `DOC_VERSION_CONFLICT: ${d.name} 当前 v${currentVersion}，期望 v${baseVersions[d.name]}`
              )
              err.code = 'DOC_VERSION_CONFLICT'
              throw err
            }
            const existing = await tx.prepare(
              'SELECT content, category FROM docs WHERE repo = ? AND name = ?'
            ).get(repo, d.name)
            const nextVersion = currentVersion + 1
            await tx.prepare(`
              INSERT INTO docs_versions (repo, tenant_id, name, version, content_before, content_after, category_before, category_after, author, created_at)
              VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              repo, repo, d.name, nextVersion,
              existing?.content ?? null, d.content,
              existing?.category ?? null, d.category || existing?.category || null,
              author, now
            )
            await tx.prepare(`
              INSERT INTO docs (repo, tenant_id, name, category, content, updated_at, updated_by)
              VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, ?, ?, ?, ?)
              ON CONFLICT(repo, name) DO UPDATE SET
                category = COALESCE(excluded.category, docs.category),
                content = excluded.content,
                updated_at = excluded.updated_at,
                updated_by = excluded.updated_by
            `).run(repo, repo, d.name, d.category || null, d.content, now, author)
            results.push({ name: d.name, version: nextVersion })
          }
        }
        await db.tx(tx)
        return {
          content: [
            {
              type: 'text',
              text: `批量更新成功：${results.length} 条 → ${results.map((r) => `${r.name}@v${r.version}`).join(', ')}`,
            },
          ],
        }
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: `批量更新失败（已整体回滚）：${e.message}`,
            },
          ],
        }
      }
    }
  )
}

export function registerKnowledgeTools(server) {
  registerGetDoc(server)
  registerListDocs(server)
  registerQueryDocs(server)
  registerUpdateDoc(server)
  registerUpdateDocsBatch(server)
}
