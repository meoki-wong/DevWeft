/**
 * test-harness.mjs — Harness 状态机冒烟测试（AWP_AI_ENV=test 不入库上报）
 * 用法：node test-harness.mjs
 */
import db from './db.js'
import { harnessStart, harnessStatus, harnessAdvance } from './harness/state-machine.js'

const REPO = '__harness_test__'
const AUTHOR = 'test-runner'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// 清理测试数据
db.prepare('DELETE FROM task_versions WHERE repo = ?').run(REPO)
db.prepare('DELETE FROM tasks WHERE repo = ?').run(REPO)
db.prepare('DELETE FROM verify_reports WHERE repo = ?').run(REPO)

console.log('1. harness_start')
const start = harnessStart({ requirement: '冒烟测试任务', type: 'FIX', author: AUTHOR, repo: REPO })
assert(start.ok, 'start failed')
const taskId = start.taskId
console.log('   taskId:', taskId)

console.log('2. harness_status RECEIVE')
const s1 = harnessStatus({ taskId, repo: REPO })
assert(s1.phase === 'RECEIVE', 'phase should be RECEIVE')

console.log('3. advance → CLASSIFY (with size M)')
const a1 = harnessAdvance({ taskId, to: 'CLASSIFY', data: { size: 'M' }, author: AUTHOR, repo: REPO })
assert(a1.ok, `CLASSIFY failed: ${JSON.stringify(a1)}`)

console.log('4. advance → EXECUTE (M skips LOCATE/PLAN)')
const a2 = harnessAdvance({ taskId, to: 'EXECUTE', author: AUTHOR, repo: REPO })
assert(a2.ok, `EXECUTE failed: ${JSON.stringify(a2)}`)

console.log('5. advance → VERIFY without L1 should fail')
const a3 = harnessAdvance({ taskId, to: 'VERIFY', author: AUTHOR, repo: REPO })
assert(!a3.ok, 'VERIFY should be blocked without L1')
assert(a3.blockedBy?.length > 0, 'should have blockedBy')

console.log('6. insert fake L1 pass and advance → VERIFY')
db.prepare(
  `INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
   VALUES ('test-l1', ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'L1', 'na', 'src/test.vue', 1, 0, '', ?, ?, ?)`
).run(REPO, REPO, AUTHOR, taskId, new Date().toISOString())
const a4 = await harnessAdvance({ taskId, to: 'VERIFY', author: AUTHOR, repo: REPO })
assert(a4.ok, `VERIFY failed: ${JSON.stringify(a4)}`)

console.log('7. advance → DONE without L2 should fail')
const a5 = await harnessAdvance({ taskId, to: 'DONE', data: { l3Confirmed: true }, author: AUTHOR, repo: REPO })
assert(!a5.ok, 'DONE should be blocked without L2')

console.log('8. insert L2 pass and advance → DONE')
db.prepare(
  `INSERT INTO verify_reports (id, repo, tenant_id, level, side, file, pass, errors, detail, author, task_id, created_at)
   VALUES ('test-l2', ?, (SELECT repo_id FROM repositories WHERE slug = ?), 'L2', 'na', NULL, 1, 0, '', ?, ?, ?)`
).run(REPO, REPO, AUTHOR, taskId, new Date().toISOString())
const a6 = await harnessAdvance({ taskId, to: 'DONE', data: { l3Confirmed: true }, author: AUTHOR, repo: REPO })
assert(a6.ok, `DONE failed: ${JSON.stringify(a6)}`)

const final = harnessStatus({ taskId, repo: REPO })
assert(final.phase === 'DONE', 'final phase should be DONE')

// cleanup
db.prepare('DELETE FROM verify_reports WHERE repo = ?').run(REPO)
db.prepare('DELETE FROM task_versions WHERE repo = ?').run(REPO)
db.prepare('DELETE FROM tasks WHERE repo = ?').run(REPO)

console.log('\n✅ Harness 冒烟测试全部通过')
