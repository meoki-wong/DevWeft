/**
 * §7.5 replay_runner 调度：candidate_replay_runs 真实状态机
 * - enqueue (queued) → start (running) → finish (passed/failed/error/canceled)
 * - runner 本身是抽象接口（real = 跑 git 检出 + 执行 suite + 上传报告；mock = 内存模拟）
 * - 多个 replay 并行由 caller 控制；本模块只负责生命周期
 */
import { ApiError } from './errors.js'
import { enqueueReplayRun, markReplayRun as setStatus } from './promotion.js'

/**
 * 抽象 runner：proposal + snapshot + 已绑定测试资源 → 跑出结果对象
 * 实现: { runStarted, runFinished, status, checksPassed }
 * Provider and execution adapters can be supplied by deployments; tests use a deterministic mock.
 */
export class AbstractReplayRunner {
  async run(_proposal, _snapshotId, _opts) {
    throw new Error('AbstractReplayRunner.run not implemented by subclass')
  }
}

/** Mock runner：deterministic outcome by proposal id hash */
export class MockReplayRunner extends AbstractReplayRunner {
  constructor({ defaultPass = true } = {}) { super(); this.defaultPass = defaultPass }
  async run(proposal, snapshotId, _opts) {
    const started = new Date().toISOString()
    const pass = this.defaultPass && !(proposal.proposal_id.includes('fail'))
    await new Promise((r) => setTimeout(r, 1))  // simulate async
    return {
      status: pass ? 'passed' : 'failed',
      checksPassed: pass ? { total: 5, passed: 5, failed: 0 } : { total: 5, passed: 3, failed: 2 },
      startedAt: started,
      finishedAt: new Date().toISOString(),
    }
  }
}

export async function runReplay(db, { proposalId, businessSnapshotId, runner, now = new Date() } = {}) {
  if (!proposalId || !businessSnapshotId) throw new ApiError('INVALID_SCHEMA')
  if (!runner || typeof runner.run !== 'function') throw new ApiError('INVALID_SCHEMA')
  const proposal = await db.prepare('SELECT * FROM promotion_proposals WHERE proposal_id=?').get(proposalId)
  if (!proposal) throw new ApiError('INVALID_SCHEMA')
  // 排到队列
  const queued = await enqueueReplayRun(db, { proposalId, businessSnapshotId, now })
  // 立即转 running
  setStatus(db, { replayRunId: queued.replayRunId, status: 'running' })
  try {
    const result = await runner.run(proposal, businessSnapshotId, {})
    setStatus(db, {
      replayRunId: queued.replayRunId, status: result.status,
      checksPassed: result.checksPassed,
      now: new Date(result.finishedAt),
    })
    return { replayRunId: queued.replayRunId, ...result }
  } catch (err) {
    setStatus(db, { replayRunId: queued.replayRunId, status: 'error' })
    throw err
  }
}
