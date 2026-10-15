/**
 * §7.5 MR 集成抽象层：晋升 5 步中的"控制面 suites MR"
 * 真实实现接 GitLab/GitHub API（不在 in-memory 范围）；测试用 MockMRClient。
 * 抽象：openMR / getMRState / mergeMR / closeMR
 */
export class AbstractMRClient {
  async openMR(_opts) { throw new Error('not implemented') }
  async getMRState(_id) { throw new Error('not implemented') }
  async mergeMR(_id) { throw new Error('not implemented') }
  async closeMR(_id, _opts) { throw new Error('not implemented') }
}

/** MockMRClient：in-memory 状态机，单测用 */
export class MockMRClient extends AbstractMRClient {
  constructor() {
    super()
    this.mrs = new Map()
    this.idCounter = 0
  }
  async openMR({ repoId, sourceBranch, targetBranch, title, body }) {
    const id = String(++this.idCounter)
    const mr = {
      id, repoId, sourceBranch, targetBranch, title, body,
      state: 'opened', createdAt: new Date().toISOString(),
    }
    this.mrs.set(`${repoId}:${id}`, mr)
    return mr
  }
  async getMRState(mrKey) {
    const mr = this.mrs.get(mrKey)
    if (!mr) throw new Error('MR not found')
    return { id: mr.id, state: mr.state }
  }
  async mergeMR(mrKey) {
    const mr = this.mrs.get(mrKey)
    if (!mr) throw new Error('MR not found')
    mr.state = 'merged'
    mr.mergedAt = new Date().toISOString()
    return mr
  }
  async closeMR(mrKey, _opts) {
    const mr = this.mrs.get(mrKey)
    if (!mr) throw new Error('MR not found')
    mr.state = 'closed'
    return mr
  }
  // 测试辅助
  setState(mrKey, state) { const mr = this.mrs.get(mrKey); if (mr) mr.state = state }
  get(mrKey) { return this.mrs.get(mrKey) }
}

/** 在 proposal transitioning to merging 时调用 */
export async function openProposalMR(mrClient, db, { proposalId, sourceBranch, targetBranch, title, body, repoId, now = new Date() } = {}) {
  if (!proposalId) throw new Error('proposalId required')
  const mr = await mrClient.openMR({ repoId, sourceBranch, targetBranch, title, body })
  // 先持久化 MR 元数据（mr_iid/mr_url/mr_project_id），然后同步 state
  await db.prepare(
    `UPDATE promotion_proposals SET mr_provider='mock', mr_project_id=?, mr_iid=?, mr_url=?, updated_at=? WHERE proposal_id=?`
  ).run(repoId, mr.id, `mock://${repoId}/mr/${mr.id}`, now.toISOString(), proposalId)
  await syncProposalMRState(mrClient, db, { proposalId, mrKey: `${repoId}:${mr.id}`, now })
  return mr
}
export async function syncProposalMRState(mrClient, db, { proposalId, mrKey, now = new Date() } = {}) {
  const s = await mrClient.getMRState(mrKey)
  await db.prepare('UPDATE promotion_proposals SET mr_state=?, updated_at=? WHERE proposal_id=?').run(s.state, now.toISOString(), proposalId)
  return s
}

export async function mergeProposalMR(mrClient, db, { proposalId, mrKey, now = new Date() } = {}) {
  const m = await mrClient.mergeMR(mrKey)
  await db.prepare("UPDATE promotion_proposals SET mr_state='merged', updated_at=? WHERE proposal_id=?").run(now.toISOString(), proposalId)
  return m
}
