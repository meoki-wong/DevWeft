/**
 * DONE 交付包（2026-09-26，修正版口径）：
 * 平台不写码不留码——交付包是随 DONE 返回的收尾文本（变更说明/commit message/清单）。
 * 数据源全部为库内现成事实。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../db.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { seedGateChain } from './helpers/submission-chain.mjs'
import { buildDeliveryPack } from '../harness/delivery.js'

const slug = `dl-${randomUUID().slice(0, 8)}`
let boot = null
let taskId = null

beforeAll(async () => {
  boot = await bootstrapTestingPlatform(db, { slug, remoteUrl: `https://git.test/${slug}.git` })
  taskId = `T-dl-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  await db.prepare(
    `INSERT INTO tasks(repo, tenant_id, task_id, requirement, type, phase, meta, author, created_at, updated_at)
     VALUES (?, (SELECT repo_id FROM repositories WHERE slug = ?), ?, '门店页新增优惠券领取入口\n1. 列表展示\n2. 领取幂等', 'FEATURE', 'DONE', '{}', 'alice', ?, ?)`
  ).run(slug, slug, taskId, now, now)
  await seedGateChain(db, {
    repoId: boot.repoId, taskId,
    groupStatus: 'passed',
    runs: [{ unit: 'static', side: 'na', status: 'passed' }, { unit: 'smoke', side: 'admin', status: 'passed' }],
  })
})

describe('buildDeliveryPack', () => {
  it('包含 commit message / 通用变更说明 / 收尾清单 / diff 备份链接', async () => {
    const pack = await buildDeliveryPack(db, { repo: slug, taskId })
    expect(pack).toBeTruthy()
    expect(pack.rounds).toBeGreaterThanOrEqual(1)
    expect(pack.commitMessage).toContain(`feat(${slug})`)
    expect(pack.commitMessage).toContain('门店页新增优惠券领取入口')
    expect(pack.text).toContain('════ 任务交付包 ════')
    expect(pack.text).toContain('── ① 建议 commit message ──')
    expect(pack.text).toContain('── ② 变更说明 ──')
    expect(pack.text).toContain('── ③ 收尾清单（在你自己的机器上做）──')
    expect(pack.text).toContain('以你本地工作区实际改动为准') // 平台不留码：一切以本地为准
    expect(pack.text).toContain('禁止 commit/push"约束至此解除')
    expect(pack.text).toMatch(/\/v1\/test-runs\/.+\/artifact\/content/) // diff 备份链接
  })

  it('不存在的任务返回 null（不伪造）', async () => {
    expect(await buildDeliveryPack(db, { repo: slug, taskId: 'T-nope' })).toBeNull()
  })
})
