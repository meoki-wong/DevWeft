import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { describe, expect, it } from 'vitest'
import { runTestingMigrations } from '../testing/migrate.js'
import { bootstrapTestingPlatform, registerWorker } from '../testing/bootstrap.js'
import { authenticateBearer } from '../testing/auth.js'
import { createBlobStore } from '../testing/blobs.js'
import { createTestSubmission } from '../testing/submissions.js'
import { previewSuitePlan } from '../testing/suite-plan.js'
import { documentSha256 } from '../contracts/version.mjs'
import { acquireLease, acceptLease, heartbeatLease, completeLease } from '../testing/leases.js'
import { generateEd25519Pem, publicKeySha256 } from '../testing/signing.js'
import { executeAcceptedRunInProcess } from '../runner/host-worker/index.mjs'
import { executeGuestAttempt } from '../runner/guest-agent/index.mjs'
import { filterCasesForUnit } from '../runner/guest-agent/units.mjs'
import { parseViteLocalUrl, resolveSmokeScripts, runSmokeChecks } from '../runner/guest-agent/smoke.mjs'
import { evaluateNewGate, requiredUnitsForSize } from '../harness/testing-gate.js'
import { utcNow } from '../testing/ids.js'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-smoke-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  // 最小 harness tasks 表：体量策略按服务端 tasks.type 选择 unit（memdb 只有 testing schema）
  await db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT NOT NULL, repo TEXT NOT NULL, size TEXT, type TEXT,
    PRIMARY KEY (repo, task_id)
  )`)
  return db
}

const OID = 'b'.repeat(40)

async function insertTask(db, boot, taskId, size, type = 'FEATURE') {
  const now = new Date().toISOString()
  const taskInstanceId = `018f0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`
  await db.prepare(
    `INSERT INTO task_instances(
       task_instance_id, repo_id, external_task_id, epoch, revision, phase, size, status, author_principal_id, created_at, updated_at
     ) VALUES (?, ?, ?, 1, 1, 'EXECUTE', ?, 'open', ?, ?, ?)`
  ).run(taskInstanceId, boot.repoId, taskId, size, boot.principalId, now, now)
  await db.prepare(
    `INSERT INTO legacy_task_mappings(repo_id, legacy_task_id, task_instance_id, migrated_at)
     VALUES (?, ?, ?, ?)`
  ).run(boot.repoId, taskId, taskInstanceId, now)
  // 同步 harness tasks 行：submissions/门禁判定的 type 以服务端 tasks 表为准（防 AI 虚报体量）
  await db.prepare('INSERT INTO tasks(task_id, repo, size, type) VALUES (?, ?, ?, ?)').run(taskId, 'demo-app', size, type)
  return taskInstanceId
}

async function submit(db, boot, blobs, blobDir, { taskId, size, type = 'FEATURE' }) {
  await insertTask(db, boot, taskId, size, type)
  const principal = await authenticateBearer(db, `Bearer ${boot.token}`)
  const payload = Buffer.from('git-bundle-bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const prep = blobs.prepare({ kind: 'git-bundle', sha256: sha, size: payload.length })
  if (prep.uploadId) await blobs.writeUpload(prep.uploadId, payload)
  return await createTestSubmission(db, blobs, {
    clientRequestId: `018f0000-0000-7000-8000-${Math.random().toString(16).slice(2, 14).padStart(12, '0')}`,
    repoId: boot.repoId,
    sourceRemoteId: boot.remoteId,
    branchIncarnationId: null,
    taskInstanceId: taskId,
    expectedTaskRevision: 1,
    git: {
      objectFormat: 'sha1',
      sourceRef: 'refs/heads/feature-x',
      headCommitOid: OID,
      snapshotCommitOid: OID,
      snapshotTreeOid: OID,
      changedPathsSha256: documentSha256([]),
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      mr: null,
    },
    bundle: { sha256: sha, size: payload.length },
    suiteRequest: { mode: 'auto', candidateRevisionIds: [], candidateApprovalIds: [] },
    executionRequest: { profile: 'auto', side: 'auto' },
  }, principal)
}

const passStub = async ({ cases }) => cases.map((c) => ({ caseKey: c.caseKey, status: 'passed', durationMs: 1 }))

async function driveRun(db, worker, accepted, runDir, { smokeExecutor = passStub } = {}) {
  await heartbeatLease(db, worker, accepted.__leaseId, {
    runId: accepted.runSpec.runId,
    workerId: worker.worker_id,
    attempt: accepted.runSpec.attempt,
    leaseEpoch: accepted.runSpec.leaseEpoch,
    leaseToken: accepted.__leaseToken,
    operationSeq: 1,
  })
  return executeAcceptedRunInProcess({
    db, worker, reservation: accepted.__reservation, accepted,
    cases: accepted.__cases, runDir,
    guestPrivateKeyPem: accepted.__guest.privateKeyPem,
    blobRoot: accepted.__blobRoot,
    smokeExecutor,
  })
}

async function leaseNext(db, worker, blobRoot) {
  const reservation = await acquireLease(db, worker)
  if (!reservation) return null
  const guest = generateEd25519Pem()
  const accepted = await acceptLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    guestPublicKey: guest.publicKeyPem,
    guestKeySha256: publicKeySha256(guest.publicKeyPem),
  })
  const plan = await db.prepare(
    `SELECT p.canonical_lock_json FROM test_runs r
     JOIN test_bindings b ON b.binding_id=r.binding_id
     JOIN suite_plans p ON p.suite_plan_id=b.suite_plan_id
     WHERE r.run_id=?`
  ).get(reservation.runId)
  return {
    __reservation: reservation,
    __leaseId: reservation.leaseId,
    __leaseToken: reservation.leaseToken,
    __guest: guest,
    __blobRoot: blobRoot,
    __cases: JSON.parse(plan.canonical_lock_json).cases || [],
    ...accepted,
  }
}

describe('M3.5 smoke suite cases and required units', () => {
  it('repository overlay declares configured smoke cases and the plan includes them', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const now = utcNow()
    await insertTask(db, boot, 'T-P', 'S')
    const preview = await previewSuitePlan(db, {
      repoId: boot.repoId,
      taskInstanceId: 'T-P',
      expectedTaskRevision: 1,
      branchIncarnationId: null,
      headCommitOid: OID,
      snapshotTreeOid: OID,
      changedPaths: [],
      changedPathsSha256: documentSha256([]),
      targetRemoteId: boot.remoteId,
      targetRef: 'refs/heads/stage',
      targetCommitOid: OID,
      candidateRevisionIds: [],
      requestedProfileName: 'auto',
      requestedSides: 'auto',
    })
    expect([...preview.requiredCaseKeys].sort()).toEqual([
      'test:smoke/web',
      'test:smoke/admin',
      'test:static/eslint',
      'test:static/hard-rules',
      'test:static/translation-fixture',
      'test:static/vitest',
    ])
  })

  it('M tasks produce runs by type (UI 类追加 smoke，FIX 类仅静态); S tasks stay static only', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-smokeblob-'))
    const blobs = createBlobStore(blobDir)
    expect(requiredUnitsForSize('M', ['web', 'admin'])).toEqual(['static:na', 'smoke:web', 'smoke:admin'])
    const m = await submit(db, boot, blobs, blobDir, { taskId: 'T-M1', size: 'M' })
    const runs = await db.prepare('SELECT unit, side, status FROM test_runs WHERE run_group_id=? ORDER BY unit, side').all(m.formalRunGroupId)
    expect(runs.map((r) => `${r.unit}:${r.side}`).sort()).toEqual(['smoke:web', 'smoke:admin', 'static:na'])
    // 纯逻辑/接口改动（FIX）不跑 e2e（防过量测试）
    const fix = await submit(db, boot, blobs, blobDir, { taskId: 'T-MF1', size: 'M', type: 'FIX' })
    const fixRuns = await db.prepare('SELECT unit, side FROM test_runs WHERE run_group_id=?').all(fix.formalRunGroupId)
    expect(fixRuns.map((r) => `${r.unit}:${r.side}`)).toEqual(['static:na'])
    const s = await submit(db, boot, blobs, blobDir, { taskId: 'T-S1', size: 'S' })
    const sRuns = await db.prepare('SELECT unit, side FROM test_runs WHERE run_group_id=?').all(s.formalRunGroupId)
    expect(sRuns.map((r) => `${r.unit}:${r.side}`)).toEqual(['static:na'])
    rmSync(blobDir, { recursive: true, force: true })
  })
})

describe('M3.5 guest unit dispatch', () => {
  it('filters cases by unit and side', async () => {
    const cases = [
      { caseKey: 'test:static/eslint' },
      { caseKey: 'test:smoke/web' },
      { caseKey: 'test:smoke/admin' },
    ]
    expect(filterCasesForUnit(cases, { unit: 'static', side: 'na' }).map((c) => c.caseKey)).toEqual(['test:static/eslint'])
    expect(filterCasesForUnit(cases, { unit: 'smoke', side: 'web' }).map((c) => c.caseKey)).toEqual(['test:smoke/web'])
    expect(filterCasesForUnit(cases, { unit: 'smoke', side: 'admin' }).map((c) => c.caseKey)).toEqual(['test:smoke/admin'])
    expect(filterCasesForUnit(cases, { unit: 'unknown', side: 'na' })).toEqual([])
  })

  it('static runs ignore smoke cases; smoke runs execute only their side via the injected executor', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-smokeblob2-'))
    const blobs = createBlobStore(blobDir)
    await submit(db, boot, blobs, blobDir, { taskId: 'T-M2', size: 'M' })

    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'smoke-worker' })
    // 第一个 run：static:na
    let leased = await leaseNext(db, worker, blobDir)
    expect(leased.runSpec.unit).toBe('static')
    const staticRunDir = mkdtempSync(join(tmpdir(), 'awp-smokeg1-'))
    mkdirSync(join(staticRunDir, 'workspace'), { recursive: true })
    writeFileSync(join(staticRunDir, 'workspace', 'ok.js'), 'const n = 1\n')
    const staticSidecar = await driveRun(db, worker, leased, staticRunDir, {
      smokeExecutor: async () => { throw new Error('static run 不应调用 smoke executor') },
    })
    expect(staticSidecar.result.status).toBe('passed')
    expect(staticSidecar.result.checks.every((c) => c.caseKey.startsWith('test:static/'))).toBe(true)
    rmSync(staticRunDir, { recursive: true, force: true })

    // 第二个 run：smoke:web
    leased = await leaseNext(db, worker, blobDir)
    expect(leased.runSpec.unit).toBe('smoke')
    expect(leased.runSpec.side).toBe('web')
    const webRunDir = mkdtempSync(join(tmpdir(), 'awp-smokeg2-'))
    mkdirSync(join(webRunDir, 'workspace'), { recursive: true })
    const webSidecar = await driveRun(db, worker, leased, webRunDir)
    expect(webSidecar.result.status).toBe('passed')
    expect(webSidecar.result.checks.map((c) => c.caseKey)).toEqual(['test:smoke/web'])
    rmSync(webRunDir, { recursive: true, force: true })

    // 第三个 run：smoke:admin
    leased = await leaseNext(db, worker, blobDir)
    expect(leased.runSpec.side).toBe('admin')
    const adminRunDir = mkdtempSync(join(tmpdir(), 'awp-smokeg3-'))
    mkdirSync(join(adminRunDir, 'workspace'), { recursive: true })
    const adminSidecar = await driveRun(db, worker, leased, adminRunDir)
    expect(adminSidecar.result.checks.map((c) => c.caseKey)).toEqual(['test:smoke/admin'])
    rmSync(adminRunDir, { recursive: true, force: true })
    rmSync(blobDir, { recursive: true, force: true })
  })
})

describe('M3.5 smoke executor primitives', () => {
  it('uses repository profile smoke commands and parses vite local url', async () => {
    const scripts = { web: { build: ['build'], entry: 'index.html', outDir: 'dist' } }
    expect(resolveSmokeScripts('web', { scripts })).toEqual(scripts.web)
    expect(resolveSmokeScripts('api', { scripts })).toBe(null)
    const out = [
      '  VITE v5.4.11  ready in 512 ms',
      '',
      '  ➜  Local:   http://127.0.0.1:5173/',
      '  ➜  Network: use --host to expose',
    ].join('\n')
    expect(parseViteLocalUrl(out)).toBe(5173)
    expect(parseViteLocalUrl('no url here')).toBeNull()
  })

  it('runs real smoke against a fake vite preview and fake playwright module', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'awp-smokews-'))
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      name: 'fake-project', version: '0.0.1', private: true,
      scripts: {
        'build:development:web': 'node --version',
      },
    }))
    mkdirSync(join(ws, 'fixtures'), { recursive: true })
    writeFileSync(join(ws, 'fixtures', 'i18n.json'), JSON.stringify({
      schemaVersion: 1, kind: 'translation-fixture',
      files: [{ path: 'src/locales/cnDict.json', content: '{}' }],
    }))
    // fake preview：命令数组注入，跳过 npm exec vite
    writeFileSync(join(ws, 'fake-preview.cjs'), [
      "const http = require('node:http')",
      "console.log('  ➜  Local:   http://127.0.0.1:5199/')",
      "const srv = http.createServer((req, res) => { res.end('<html><body><div id=\"app\">ok</div></body></html>') })",
      'srv.listen(5199, "127.0.0.1", () => {})',
      "setTimeout(() => process.exit(0), 30000)",
    ].join('\n'))
    const fakePlaywright = join(ws, 'fake-playwright.mjs')
    writeFileSync(fakePlaywright, [
      'export const chromium = {',
      '  async launch() {',
      '    return {',
      '      async newPage() {',
      '        return {',
      "          on: () => {},",
      '          async addInitScript() {},',
      "          async goto(url) { if (!url.startsWith('http://127.0.0.1:4173')) throw new Error('bad url ' + url) },",
      "          async waitForSelector(sel) { if (sel !== '#app') throw new Error('bad sel ' + sel) },",
      "          async title() { return 'fake-project' },",
      '          async close() {},',
      '        }',
      '      },',
      '      async close() {},',
      '    }',
      '  },',
      '}',
    ].join('\n'))
    const checks = await runSmokeChecks({
      workspaceDir: ws,
      cases: [{ caseKey: 'test:smoke/web' }],
      side: 'web',
      playwrightModule: 'file://' + fakePlaywright.replace(/\\/g, '/'),
      previewCommand: ['node', join(ws, 'fake-preview.cjs')],
      serveReadyTimeoutMs: 15000,
    })
    expect(checks).toHaveLength(1)
    if (checks[0].status !== 'passed') {
      throw new Error('smoke 未通过: ' + JSON.stringify(checks[0]))
    }
    expect(checks[0]).toMatchObject({ caseKey: 'test:smoke/web', status: 'passed' })
    rmSync(ws, { recursive: true, force: true })
  })



  it('marks checks error when playwright is unavailable', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'awp-smokews2-'))
    writeFileSync(join(ws, 'package.json'), JSON.stringify({
      name: 'fake-project', version: '0.0.1', private: true,
      scripts: {
        'build:development:web': 'node --version',
        'serve:web': 'node -e "console.log(\'  ➜  Local:   http://127.0.0.1:5198/\'); setTimeout(()=>process.exit(0), 8000)"',
      },
    }))
    writeFileSync(join(ws, 'fake-preview2.cjs'), "console.log('  ➜  Local:   http://127.0.0.1:5197/'); setTimeout(()=>process.exit(0), 8000)")
    const checks = await runSmokeChecks({
      workspaceDir: ws,
      cases: [{ caseKey: 'test:smoke/web' }],
      side: 'web',
      previewCommand: ['node', join(ws, 'fake-preview2.cjs')],
      playwrightModule: 'awp-definitely-not-installed',
      serveReadyTimeoutMs: 15000,
    })
    expect(checks[0].status).toBe('error')
    expect(String(checks[0].detail || '')).toMatch(/PLAYWRIGHT_UNAVAILABLE/)
    rmSync(ws, { recursive: true, force: true })
  })
})

describe('M3.5 M-size gate closes end to end', () => {
  it('three unit runs all pass and the M gate would not block', async () => {
    const db = await memdb()
    const boot = await bootstrapTestingPlatform(db, {
      remoteUrl: 'https://gitlab.example/Web/demo-app.git', rotateToken: true,
    })
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-smokeblob3-'))
    const blobs = createBlobStore(blobDir)
    const created = await submit(db, boot, blobs, blobDir, { taskId: 'T-M3', size: 'M' })
    const worker = await registerWorker(db, { certificateThumbprint: randomBytes(32).toString('hex'), hostname: 'm-worker' })
    for (let i = 0; i < 3; i += 1) {
      const leased = await leaseNext(db, worker, blobDir)
      const runDir = mkdtempSync(join(tmpdir(), `awp-m3g${i}-`))
      mkdirSync(join(runDir, 'workspace'), { recursive: true })
      if (leased.runSpec.unit === 'static') writeFileSync(join(runDir, 'workspace', 'ok.js'), 'const n = 1\n')
      await driveRun(db, worker, leased, runDir)
      rmSync(runDir, { recursive: true, force: true })
    }
    const statuses = await db.prepare(
      `SELECT unit, side, status FROM test_runs WHERE run_group_id=?`
    ).all(created.formalRunGroupId)
    expect(statuses.every((r) => r.status === 'passed')).toBe(true)
    const group = await db.prepare('SELECT status FROM run_groups WHERE run_group_id=?').get(created.formalRunGroupId)
    expect(group.status).toBe('passed')
    const evaluation = await evaluateNewGate(db, {
      repoSlug: 'demo-app',
      taskId: 'T-M3',
      size: 'M',
      gateBindingId: created.bindingId,
      expectedTaskRevision: created.taskRevision,
    })
    expect(evaluation.wouldBlock).toBe(false)
    rmSync(blobDir, { recursive: true, force: true })
  })
})
