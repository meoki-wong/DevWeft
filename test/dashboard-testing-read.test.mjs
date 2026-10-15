import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)

// 路由正常导入，但在模块加载前隔离全部生产入口；不打开生产 db、不初始化存储、不监听端口。
const isolated = vi.hoisted(() => ({ conn: null, blobs: new Map(), forbidden: () => { throw new Error('只读测试禁止调用生产服务') } }))
vi.mock('../db.js', () => ({ default: {
  prepare: (...args) => isolated.conn.prepare(...args),
  transaction: (fn) => isolated.conn.transaction(fn),
  tx: (fn) => isolated.conn.tx(fn),
} }))
vi.mock('../testing/blobs.js', () => ({ createBlobStore: () => ({ contentPath: (sha) => sha }) }))
vi.mock('node:fs', async (original) => ({ ...(await original()),
  existsSync: (path) => isolated.blobs.has(path),
  readFileSync: (path) => { if (!isolated.blobs.has(path)) throw new Error('禁止读取真实文件'); return isolated.blobs.get(path) },
}))
vi.mock('../scanner/zipscan.mjs', () => ({ readZipCentralEntries: (buffer) => JSON.parse(buffer.toString()).map((entry) => ({
  name: entry.path, uncompressedSize: Buffer.byteLength(entry.text), inflate: () => {
    if (entry.error) throw new Error(entry.error)
    return Buffer.from(entry.text)
  },
})) }))
vi.mock('../testing/test-specs.js', () => ({ getTestSpec: isolated.forbidden, listTestSpecs: isolated.forbidden,
  transitionTestSpec: isolated.forbidden, normalizeRepoId: isolated.forbidden, getE2eInjectMode: isolated.forbidden,
  setE2eInjectMode: isolated.forbidden, E2E_INJECT_MODES: [] }))
vi.mock('../audit/index.js', () => ({ recordAuditEvent: isolated.forbidden, queryAuditEvents: isolated.forbidden }))
vi.mock('../harness/testing-gate.js', () => ({ setRepoGateMode: isolated.forbidden, GATE_MODES: [], isCloudTestingEnabled: isolated.forbidden,
  getRepoGateMode: async (db, repo) => (await db.prepare('SELECT m.mode FROM repo_gate_modes m JOIN repositories r ON r.repo_id=m.repo_id WHERE r.slug=?').get(repo))?.mode || 'legacy',
  getTaskAcceptance: async () => [], evaluateAcCoverage: async () => ({ applicable: false, covered: [], missing: [] }), describeMutationVerification: async () => null }))
vi.mock('../testing/accounts.js', () => ({ listRepoEnvAccounts: isolated.forbidden, setRepoEnvAccount: isolated.forbidden,
  clearRepoEnvAccount: isolated.forbidden, getDefaultTestEnv: isolated.forbidden, setDefaultTestEnv: isolated.forbidden, ENV_ACCOUNT_ENVS: [] }))
vi.mock('../testing/leases.js', () => ({ requeueRun: isolated.forbidden }))
vi.mock('../harness/loop.js', () => ({ grantGateRetryBudget: isolated.forbidden }))
vi.mock('../testing/repo-platform.js', () => ({ resolveRepoWorkspacePath: isolated.forbidden, getRepoPlatformProfile: isolated.forbidden }))
vi.mock('../testing/tenant-config.js', () => ({ getTenantContextHints: isolated.forbidden }))
vi.mock('../harness/gate-policy.js', () => ({ resolveGatePolicy: isolated.forbidden, previewGatePolicy: isolated.forbidden,
  setPlatformSetting: isolated.forbidden, getPlatformSetting: isolated.forbidden, upsertGateRiskRule: isolated.forbidden,
  listGateRiskRules: isolated.forbidden, isDynamicGateEnabled: isolated.forbidden }))
vi.mock('../testing/quality-metrics.js', () => ({ qualityDashboard: isolated.forbidden, registerEscape: isolated.forbidden, listEscapes: isolated.forbidden }))
vi.mock('../testing/flaky.js', () => ({ quarantineSpec: isolated.forbidden, listQuarantined: isolated.forbidden,
  exitQuarantine: isolated.forbidden, ensureFlakyColumns: isolated.forbidden }))
vi.mock('../harness/stop-task.js', () => ({ forceStopTask: isolated.forbidden }))
vi.mock('../tools/knowledge.js', () => ({ ftsEscape: isolated.forbidden }))

import { mountTestingDashboard, readTaskTestingView } from '../dashboard/testing.js'
import { mountDashboardApi } from '../dashboard/api.js'
import { utf8Tail } from '../dashboard/testing-read-model.js'

let handlers
async function call(route, { params = {}, query = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    send(body) { this.body = body; return this },
    setHeader(key, value) { this.headers[key] = value; return this },
  }
  await handlers.get(route)({ params, query }, res)
  return res
}
function seed(sql) {
  isolated.conn.pragma('query_only = OFF')
  try { isolated.conn.exec(sql) } finally { isolated.conn.pragma('query_only = ON') }
}
function artifact(id, attempt, text, runId = 'run', extra = {}) {
  isolated.conn.pragma('query_only = OFF')
  isolated.conn.prepare(`INSERT INTO artifacts VALUES (?, ?, ?, 20, 0, ?, ?, ?, ?, ?)`).run(
    id, runId, attempt, extra.scan || 'passed', id, extra.expire || '2099-01-01', extra.deleted || null, `2026-01-0${attempt}`)
  isolated.conn.pragma('query_only = ON')
  isolated.blobs.set(id, Buffer.from(JSON.stringify([{ path: 'output/agent.log', text }])))
}

beforeEach(() => {
  isolated.conn = new Database(':memory:')
  isolated.blobs.clear()
  isolated.conn.exec(`
    CREATE TABLE repositories(repo_id TEXT, slug TEXT);
    CREATE TABLE repo_gate_modes(repo_id TEXT, mode TEXT);
    CREATE TABLE task_instances(task_instance_id TEXT, repo_id TEXT, external_task_id TEXT, epoch INTEGER, revision INTEGER, phase TEXT, status TEXT, active_binding_id TEXT, size TEXT, type TEXT);
    CREATE TABLE tasks(task_id TEXT, repo TEXT, phase TEXT, requirement TEXT, type TEXT, completed TEXT, pending TEXT, author TEXT, created_at TEXT, updated_at TEXT, closed_at TEXT, meta TEXT);
    CREATE TABLE gate_loops(repo TEXT, task_id TEXT, iteration INTEGER, state TEXT, max_iterations INTEGER, needs_human INTEGER);
    CREATE TABLE test_submissions(submission_id TEXT, task_instance_id TEXT, binding_id TEXT, status TEXT, created_at TEXT, finished_at TEXT, expected_task_revision INTEGER, principal_id TEXT);
    CREATE TABLE run_groups(run_group_id TEXT, submission_id TEXT, kind TEXT, required_units_json TEXT, gate_eligible INTEGER);
    CREATE TABLE test_runs(run_id TEXT, run_group_id TEXT, purpose TEXT, unit TEXT, side TEXT, status TEXT, terminal_reason TEXT, next_attempt INTEGER, started_at TEXT, finished_at TEXT, coverage_complete INTEGER, created_at TEXT, total_ms INTEGER, report_json TEXT, payload_json TEXT);
    CREATE TABLE workers(worker_id TEXT, hostname TEXT);
    CREATE TABLE run_attempts(run_id TEXT, attempt INTEGER, status TEXT, started_at TEXT, finished_at TEXT, heartbeat_at TEXT, error_code TEXT, error_detail TEXT, image_id TEXT, steps_json TEXT, worker_id TEXT);
    CREATE TABLE artifacts(artifact_id TEXT, run_id TEXT, attempt INTEGER, size INTEGER, artifact_truncated INTEGER, scan_state TEXT, archive_sha256 TEXT, expire_at TEXT, deleted_at TEXT, created_at TEXT);
    INSERT INTO repositories VALUES ('r1','repo1'),('r2','repo2');
    INSERT INTO repo_gate_modes VALUES ('r1','observe'),('r2','enforce_s');
    INSERT INTO task_instances VALUES ('old','r1','task',1,1,'DONE','done','b-old','M','FIX'),('current','r1','task',2,7,'DONE','done','b','M','FIX'),('foreign','r2','task',9,4,'EXECUTE','open','b-foreign','S','FIX');
    INSERT INTO tasks(task_id,repo,phase,updated_at) VALUES ('task','repo1','DONE','2026-01-01'),('task','repo2','EXECUTE','2026-01-01');
    INSERT INTO gate_loops VALUES ('repo1','task',4,'verifying',9,0);
    INSERT INTO test_submissions VALUES ('s-old','old','b-old','passed','2026-01-01',NULL,1,NULL),('s','current','b','failed','2026-01-02',NULL,7,NULL),('s-foreign','foreign','b-foreign','passed','2026-01-03',NULL,4,NULL);
    INSERT INTO run_groups VALUES ('g-old','s-old','formal','["smoke:web"]',1),('g','s','formal','["smoke:web","static:na"]',1),('g-foreign','s-foreign','formal','[]',1),('candidate','s','candidate','[]',0);
    INSERT INTO test_runs(run_id,run_group_id,purpose,unit,side,status,next_attempt,created_at,report_json) VALUES
      ('run','g','gate','smoke','web','failed',2,'2026-01-02','{"attempt":1,"checks":[{"caseKey":"business","status":"failed"}]}'),
      ('mutation','candidate','mutation','smoke','web','active',1,'2026-01-02','{}');
    INSERT INTO run_attempts(run_id,attempt,status) VALUES ('run',1,'failed'),('run',2,'active');
  `)
  isolated.conn.pragma('query_only = ON')
  handlers = new Map()
  // 假 app：读路由登记到 handlers；写路由（含链路 DELETE）仅需存在即可（本测试不触发）
  const app = { get: (path, handler) => handlers.set(path, handler), post: () => {}, delete: () => {} }
  mountTestingDashboard(app)
  mountDashboardApi(app)
})
afterEach(() => { isolated.conn.close(); isolated.conn = null; vi.useRealTimers() })

const byTask = '/api/testing/by-task/:taskId'
const logs = '/api/testing/runs/:runId/logs'
const log = '/api/testing/runs/:runId/log'
const timeline = '/api/testing/runs/:runId/timeline'
const request = (query = {}, runId = 'run') => ({ params: { runId }, query })

describe('只读路由新旧契约', () => {
  it('cloud-status 修复跨仓与 formal 选择；旧 round 仍为闭环次数，新 summary 与历史页同源', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T10:00:00Z'))
    const older = (await call(byTask, { params: { taskId: 'task' }, query: { repo: 'repo1', before: 's' } }))
    const cloud = (await call('/api/testing/cloud-status', { query: { taskId: 'task', repo: 'repo1' } }))
    expect(older.statusCode).toBe(200)
    expect(older.body.submissions[0].submissionId).toBe('s-old')
    expect(cloud.body).toMatchObject({ ok: true, round: 4, maxRounds: 9, instanceStatus: 'done',
      submission: { id: 's', requiredUnits: ['smoke:web', 'static:na'] }, node: { status: 'passed', finished: true } })
    expect(cloud.body.runs).toHaveLength(1)
    expect(cloud.body.runs[0]).toMatchObject({ attempts: 2, unit: 'smoke', status: 'failed' })
    expect(cloud.body.summary).toEqual(older.body.summary)
    expect(cloud.body.summary).toMatchObject({ formalRoundCount: 2, latestSubmissionId: 's',
      execution: { state: 'failed', failed: 1, required: 2, missing: ['static:na'] }, mutation: { active: 1 },
      mode: { configured: 'observe', effective: null, source: null }, assessment: { kind: 'observation', targetTransition: null } })
    expect((await readTaskTestingView(isolated.conn, { repo: 'repo1', taskId: 'task' })).summary).toEqual(cloud.body.summary)
    expect(JSON.stringify(cloud.body.summary)).not.toContain('canAdvance')
  })
  it('缺参数与越仓历史游标保持400；无记录仍有完整 summary', async () => {
    expect(((await call('/api/testing/cloud-status'))).statusCode).toBe(400)
    expect(((await call(byTask, { params: { taskId: 'task' }, query: { repo: 'repo1', before: 's-foreign' } }))).statusCode).toBe(400)
    const absent = (await call(byTask, { params: { taskId: 'absent' }, query: { repo: 'repo1' } }))
    expect(absent.body).toMatchObject({ linked: false, total: 0, submissions: [], summary: { version: 1, assessment: { kind: 'unavailable' } } })
  })
  it('任务 items gateSummary 不跨仓同名；单仓旧 gates 仍含原键', async () => {
    let all
    try {
      all = (await call('/api/tasks', { query: { repo: 'all', status: 'all' } })).body
      console.log('DEBUG all =', JSON.stringify(all).slice(0, 400))
    } catch (e) {
      console.log('DEBUG call threw =', String(e))
    }
    expect(all.items.find((t) => t.repo === 'repo1').gateSummary.latestSubmissionId).toBe('s')
    expect(all.items.find((t) => t.repo === 'repo2').gateSummary.latestSubmissionId).toBe('s-foreign')
    expect(all.gates.task).toBeUndefined()
    const one = (await call('/api/tasks', { query: { repo: 'repo1', status: 'all' } })).body
    expect(one.gates.task).toEqual({ status: 'failed', passed: 0, total: 1, at: '2026-01-02' })
    expect(one.phaseCounts).toEqual({ DONE: 1 })
    expect(one.items[0].gateSummary.mutation).toMatchObject({ active: 1, detailAvailable: false })
  })
  it('timeline 保留原键，补报告归属及每步来源；旧报告不会标为最新尝试', async () => {
    const result = (await call(timeline, request())).body
    expect(result).toMatchObject({ ok: true, runId: 'run', unit: 'smoke', side: 'web', status: 'failed', reportAttempt: 1 })
    expect(result).toHaveProperty('failureAnalysis')
    expect(result).toHaveProperty('summary')
    expect(result.steps.every((step) => Object.hasOwn(step, 'attempt') && step.source)).toBe(true)
    expect(result.steps.find((step) => step.caseKey === 'business')).toMatchObject({ attempt: 1, source: 'synthesized', at: null })
    expect(((await call(timeline, request({}, 'absent')))).statusCode).toBe(404)
  })
})

describe('artifact精确归属与日志错误契约', () => {
  it('无参 latest，指定 artifactId 锁定包；新包到达不改变已选文件内容', async () => {
    artifact('old', 1, '旧尝试日志')
    const first = (await call(logs, request())).body
    expect(first).toMatchObject({ ok: true, artifactId: 'old', attempt: 1, files: [{ path: 'output/agent.log', kind: 'text' }] })
    artifact('new', 2, '新尝试日志')
    expect(((await call(logs, request()))).body).toMatchObject({ artifactId: 'new', attempt: 2 })
    expect(((await call(logs, request({ artifactId: 'old' })))).body).toMatchObject({ artifactId: 'old', attempt: 1 })
    expect(((await call(log, request({ artifactId: first.artifactId, path: 'output/agent.log' })))).body).toMatchObject({ text: '旧尝试日志', artifactId: 'old', attempt: 1 })
    expect(((await call(log, request({ path: 'output/agent.log' })))).body).toMatchObject({ text: '新尝试日志', artifactId: 'new', attempt: 2 })
  })
  it('别的 run 的包或不存在的包绝不回退最新包', async () => {
    artifact('mine', 1, '本次')
    artifact('foreign-artifact', 2, '别人的', 'other-run')
    for (const id of ['foreign-artifact', 'absent', '']) {
      expect(((await call(logs, request({ artifactId: id })))).body).toMatchObject({ ok: false, files: [], artifactId: null, attempt: null })
      const result = (await call(log, request({ artifactId: id, path: 'output/agent.log' })))
      expect(result.statusCode).toBe(404)
      expect(result.body.error).toContain('没有上传')
    }
    expect(((await call(logs, request({}, 'unknown-run')))).statusCode).toBe(404)
  })
  it.each([
    [{ expire: '2000-01-01' }, '已过保留期'], [{ deleted: '2026-01-01' }, '已过保留期'], [{ scan: 'rejected' }, '未通过安全扫描'],
  ])('过期/已删除/拒绝保留清单200与内容404语义 %j', async (extra, reason) => {
    artifact('blocked', 1, '不可读', 'run', extra)
    const index = (await call(logs, request({ artifactId: 'blocked' })))
    expect(index.statusCode).toBe(200)
    expect(index.body).toMatchObject({ ok: false, artifactId: 'blocked', attempt: 1, files: [] })
    expect(index.body.reason).toContain(reason)
    const content = (await call(log, request({ artifactId: 'blocked', path: 'output/agent.log' })))
    expect(content.statusCode).toBe(404)
    expect(content.body.error).toContain(reason)
  })
  it('未上传、blob缺失、解析失败、文件不存在、非法路径及解压失败维持错误契约', async () => {
    expect(((await call(logs, request()))).body.reason).toContain('没有上传')
    artifact('pack', 1, '日志')
    isolated.blobs.delete('pack')
    expect(((await call(logs, request()))).body.reason).toContain('内容缺失')
    isolated.blobs.set('pack', Buffer.from('invalid'))
    expect(((await call(logs, request()))).body.reason).toContain('解析失败')
    isolated.blobs.set('pack', Buffer.from(JSON.stringify([{ path: 'output/agent.log', text: 'bad', error: '坏压缩数据' }])))
    expect(((await call(log, request({ path: 'missing.txt' })))).statusCode).toBe(404)
    expect(((await call(log, request({ path: '../bad' })))).statusCode).toBe(400)
    expect(((await call(log, request({ path: 'output/agent.log' }))))).toMatchObject({ statusCode: 500, body: { error: '解压失败：坏压缩数据' } })
  })
  it('媒体保留二进制响应并通过响应头给出精确包与尝试归属', async () => {
    artifact('media', 1, '')
    isolated.blobs.set('media', Buffer.from(JSON.stringify([{ path: 'video.webm', text: 'video-bytes' }])))
    const result = (await call(log, request({ artifactId: 'media', path: 'video.webm' })))
    expect(result.headers).toMatchObject({ 'Content-Type': 'video/webm', 'X-Artifact-Id': 'media', 'X-Artifact-Attempt': '1' })
    expect(Buffer.isBuffer(result.body)).toBe(true)
  })
  it('真实日志路由按512KiB严格截尾，不从半个汉字或emoji开始', async () => {
    const text = '头部' + '中🙂'.repeat(90000)
    artifact('large', 1, text)
    const result = (await call(log, request({ path: 'output/agent.log' }))).body
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(512 * 1024)
    expect(result.text).not.toContain('\uFFFD')
    expect(text.endsWith(result.text)).toBe(true)
    expect(result.returnedBytes + result.offsetBytes).toBe(Buffer.byteLength(text))
    expect(result).toMatchObject({ artifactId: 'large', attempt: 1 })
  })
})

describe('UTF-8边界纯函数', () => {
  it('逐个预算验证ASCII/汉字/emoji/组合字符边界，保持输入不变', async () => {
    const text = 'a中🙂e\u0301结尾'
    const buffer = Buffer.from(text)
    const copy = Buffer.from(buffer)
    for (let bytes = 0; bytes <= buffer.length + 2; bytes++) {
      const result = utf8Tail(buffer, bytes)
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(bytes)
      expect(result.text).not.toContain('\uFFFD')
      expect(text.endsWith(result.text)).toBe(true)
      expect(result.returnedBytes + result.offsetBytes).toBe(buffer.length)
    }
    expect(buffer).toEqual(copy)
    expect(utf8Tail(Buffer.from(''), 0)).toEqual({ text: '', truncated: false, offsetBytes: 0, returnedBytes: 0 })
  })
})
