/**
 * query-class.test.mjs — 方案第 3 节：查询分类标记防删除
 *
 * 只防止分类注释被删掉；不证明 SQL 正确（方案 §7.3）。
 * 注：方案表格中的 topRelatedExperiences 已不存在于代码，
 *     实际经验检索入口为 tools/records.js 的 distill_query，PLATFORM 标注落在该处。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

describe('QUERY_CLASS 分类标记（方案 §7.1）', () => {
  it('testing/leases.js — acquireLease 为 WORKER', () => {
    expect(read('testing/leases.js')).toContain('QUERY_CLASS: WORKER')
  })

  it('dashboard/testing.js — projects 路由为 ADMIN', () => {
    expect(read('dashboard/testing.js')).toContain('QUERY_CLASS: ADMIN')
  })

  it('harness/bootstrap-instructions.js — loadRulesManifest 为 PLATFORM', () => {
    expect(read('harness/bootstrap-instructions.js')).toContain('QUERY_CLASS: PLATFORM')
  })

  it('tools/records.js — 经验检索为 PLATFORM', () => {
    expect(read('tools/records.js')).toContain('QUERY_CLASS: PLATFORM')
  })

  it('tools/knowledge.js — get_doc / query_docs 为 TENANT', () => {
    expect(read('tools/knowledge.js')).toContain('QUERY_CLASS: TENANT')
  })

  it('harness/state-machine.js — harnessStatus / harnessAdvance 为 TENANT', () => {
    expect(read('harness/state-machine.js')).toContain('QUERY_CLASS: TENANT')
  })
})
