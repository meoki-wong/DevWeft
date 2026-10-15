/**
 * harness_start 防误开：未终态同需求 / 正文 taskId= 必须续作
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'

// harnessStart 绑定全局 db.js；这里用全局 AWP_DB_PATH 的真实迁移结果 + 独立任务 id 空间
// 直接测状态机逻辑：用 memdb 不可行（state-machine import db.js）。
// 改为在隔离 DB 上动态 import 会拉全局库——故用「同一逻辑抽纯函数」不可行时，
// 直接对 harnessStart 做集成：设置 AWP_DB_PATH 后由 vitest 预加载。
// 本文件用真实 db.js（AWP_DB_PATH），任务 id 加随机后缀避免串扰。

const REPO = 'vitest-dup-guard'
const SUFFIX = Date.now().toString(36)

async function loadSm() {
  const mod = await import('../harness/state-machine.js')
  return mod
}

describe('harness_start 防误开', () => {
  it('正文 taskId= 未终态任务 → RESUME_EXISTING，不新建', async () => {
    const { harnessStart } = await loadSm()
    const openId = `dup-open-${SUFFIX}`
    const created = await harnessStart({
      taskId: openId,
      requirement: `独立需求 A ${SUFFIX}`,
      author: 'tester',
      repo: REPO,
    })
    expect(created.ok).toBe(true)

    const dup = await harnessStart({
      requirement: `另一段说明，taskId=${openId}，模块 X`,
      author: 'tester',
      repo: REPO,
    })
    expect(dup.ok).toBe(false)
    expect(dup.code).toBe('RESUME_EXISTING')
    expect(dup.existingTaskId).toBe(openId)
  })

  it('同指纹未终态且无 taskId → DUPLICATE_OPEN_TASK', async () => {
    const { harnessStart } = await loadSm()
    const req = `V2.6.7 测试防重指纹 ${SUFFIX} 移动端开发`
    const a = await harnessStart({ requirement: req, author: 'tester', repo: REPO })
    expect(a.ok).toBe(true)

    const b = await harnessStart({ requirement: req, author: 'tester', repo: REPO })
    expect(b.ok).toBe(false)
    expect(b.code).toBe('DUPLICATE_OPEN_TASK')
    expect(b.existingTaskId).toBe(a.taskId)
  })

  it('forceNew=true 可显式并行', async () => {
    const { harnessStart } = await loadSm()
    const req = `并行需求 ${SUFFIX} 独立目标说明`
    const a = await harnessStart({ requirement: req, author: 'tester', repo: REPO })
    expect(a.ok).toBe(true)
    const b = await harnessStart({ requirement: req, author: 'tester', repo: REPO, forceNew: true })
    expect(b.ok).toBe(true)
    expect(b.taskId).not.toBe(a.taskId)
  })
})
