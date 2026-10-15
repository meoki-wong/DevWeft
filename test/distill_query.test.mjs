import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { ftsEscape } from '../tools/knowledge.js'

// 纯逻辑：FTS5 引号转义（#2 防崩）。
// 直接 import knowledge.js 会连带初始化 team.db，这里只取 ftsEscape 纯函数；
// 端到端防崩验证用独立内存库建 FTS5 表，不触碰真实库。
describe('ftsEscape — FTS5 引号转义（#2 防崩）', () => {
  it('普通关键词被双引号包裹成短语', () => {
    expect(ftsEscape('manualChunks')).toBe('"manualChunks"')
  })

  it('内部双引号双写转义（FTS5 转义规则）', () => {
    expect(ftsEscape('a"b')).toBe('"a""b"')
  })

  it('左括号 / 布尔保留字被包裹后不再是语法 token', () => {
    // 裸 "(test" 直接进 MATCH 会触发 FTS5 syntax error；包裹成短语后视为字面量
    expect(ftsEscape('(test')).toBe('"(test"')
    expect(ftsEscape('AND')).toBe('"AND"')
    expect(ftsEscape('OR NOT')).toBe('"OR NOT"')
  })

  it('转义后的短语对 FTS5 trigram 是合法 MATCH（不再抛语法错误）', async () => {
    const mem = new Database(':memory:')
    mem.exec('CREATE VIRTUAL TABLE t_escape USING fts5(body)')
    mem.exec("INSERT INTO t_escape(body) VALUES ('fix the (test) wrapper AND keep-alive')")
    mem.exec("INSERT INTO t_escape(body) VALUES ('normal content about border-radius')")

    // 这些裸 token 历史上会让 MATCH 直接抛 SqliteError，现在应被安全解析
    for (const kw of ['(test', 'AND', 'OR NOT', 'a"b']) {
      const rows = await mem.prepare('SELECT body FROM t_escape WHERE t_escape MATCH ?').all(ftsEscape(kw))
      expect(Array.isArray(rows)).toBe(true)
    }

    // 真实命中验证：短语 "(test" 应只匹配第一条
    const hit = await mem.prepare('SELECT body FROM t_escape WHERE t_escape MATCH ?').all(ftsEscape('(test'))
    expect(hit.length).toBe(1)
    expect(hit[0].body).toContain('(test)')
    mem.close()
  })
})
