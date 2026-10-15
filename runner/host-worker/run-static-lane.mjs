/**
 * Hyper-V host worker: isolated network, npm proxy, repository snapshot, and disposable VM.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import os from 'node:os'
import db, { initDB } from '../../db.js'
import { generateEd25519Pem, publicKeySha256 } from '../../testing/signing.js'
import { acquireLease, acceptLease, heartbeatLease, completeLease, rejectLease } from '../../testing/leases.js'
import { prepareRunArtifact, markArtifactUploaded } from '../../testing/artifacts.js'
import { createBlobStore } from '../../testing/blobs.js'
import { activeSpecsForRepo, specsForGateInject, loadLockedSpecs, recordSpecResult, filterSpecsForSpecInject, getE2eInjectMode } from '../../testing/test-specs.js'
import { refreshPlaceholderImage } from '../image/manifest.mjs'
import { getActiveImage } from '../image/lifecycle.mjs'
import { verifyVhdxSha256 } from '../image/manifest.mjs'
import { stageGuestPack } from '../guest-agent/stage-pack.mjs'
import { loadGuestSidecar } from './sidecar-verify.mjs'
import { uploadAttemptArtifact } from './index.mjs'
import { loadOrCreateWorkerIdentity } from './identity.mjs'
import { ensureCanaryStaticRun } from './canary.mjs'
import { resolveRepoWorkspacePath, getSmokeScriptsForSide, listSmokeSides, getRepoPlatformProfile } from '../../testing/repo-platform.js'
import { ensureNpmProxyListening } from '../npm-proxy/start.mjs'
import { createBrokerTransports } from './broker-client.mjs'
import { markGrantsFetched, markGrantsRevoked } from '../../testing/secrets.js'
import {
  guestProxyConfig, SWITCH_NAME, PROXY_IP, PROXY_PORT, PROXY_HOST,
  acquireGuestIp, releaseGuestIp,
} from '../network/policy.mjs'
import { documentSha256 } from '../../contracts/version.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

function readEnvFile(p) {
  if (!existsSync(p)) return {}
  const out = {}
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 1) continue
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim()
  }
  return out
}

function vmNameFor(runId, attempt) {
  return `awp-run-${runId}-a${attempt}`
}

function heartbeatBody(worker, reservation, seq) {
  return {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    operationSeq: seq,
  }
}

function spawnPs(file, args, { input = null } = {}) {
  return new Promise((resolvePs, reject) => {
    // stdin 总是管道并立即关闭（无载荷时传空串），避免 PS 侧 [Console]::In 在 pm2 管道上永久阻塞
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args,
    ], {
      stdio: ['pipe', 'inherit', 'inherit'],
      windowsHide: true, // 隐藏 PowerShell 窗口，避免重试时疯狂弹终端窗口
    })
    child.stdin.end(input === null ? '' : input)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePs()
      else reject(new Error(`${file} exit ${code}`))
    })
  })
}

export async function runStaticLane({
  runnerRoot = 'C:\\awp-runner',
  goldenVhdx = join('C:\\awp-runner', 'images', 'golden.vhdx'),
  passwordFile = join('C:\\awp-runner', 'images', 'golden.admin.password'),
  // smoke 全流程 = 开机~2min + npm ci ~15min + vite build ~10min + serve/playwright ~5min，
  // 20min 上限会让 smoke 结构性撞 GUEST_AGENT_TIMEOUT（9/7 第四轮实测），提到 45min
  waitMinutes = 45,
  // 开机就绪上限：VM 几分钟起不来就销毁并 rejectLease（infra 重试），避免长期卡 provisioning
  bootReadyMinutes = Number(process.env.AWP_BOOT_READY_MINUTES || 5),
} = {}) {
  initDB()
  const deploy = {
    ...readEnvFile(join(repoRoot, 'scripts', 'deploy.env.example')),
    ...readEnvFile(join(repoRoot, 'scripts', 'deploy.env')),
  }
  const tokenPath = join(repoRoot, 'data', 'bootstrap-admin.token')
  const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : null
  const workspacePath = resolveRepoWorkspacePath(process.env.AWP_DEFAULT_REPO || 'demo-app', {
    repoRoot,
    env: { ...deploy, ...process.env },
  })
  if (!workspacePath) {
    throw new Error('Repository workspace not found. Configure AWP_REPO_PATH_<SLUG> or data/repo-platform.json.')
  }
  process.stdout.write(`Repository snapshot source (read-only): ${workspacePath}\n`)

  process.stdout.write('配置隔离 Internal 交换机与宿主防火墙\n')
  await spawnPs(join(repoRoot, 'scripts', 'windows', 'ensure-isolated-network.ps1'), [
    '-SwitchName', SWITCH_NAME,
    '-ProxyIp', PROXY_IP,
    '-ProxyPort', String(PROXY_PORT),
    '-GuestCidr', '192.168.250.0/24',
  ])
  process.stdout.write('启动受控 npm 代理 packages.example.invalid:443\n')
  const proxy = await ensureNpmProxyListening({
    runnerRoot,
    caDir: join(repoRoot, 'secret-broker', 'dev-certs'),
  })
  process.stdout.write(`npm proxy reused=${proxy.reused} ${proxy.listen}\n`)

  process.stdout.write('校验 Golden SHA-256（可能需要几十秒）\n')
  // §9.2/§23 M3.1：使用 active 镜像行（生命周期管理），golden 文件必须与其 VHDX 摘要一致
  const image = await getActiveImage(db)
  if (!verifyVhdxSha256(goldenVhdx, image.vhdx_sha256)) {
    throw new Error(`IMAGE_CHANGED golden.vhdx 与 active 镜像 ${image.image_id} 的摘要不一致（镜像升级后请确认 C:\\awp-runner\\images\\golden.vhdx 已更新）`)
  }
  process.stdout.write(`image ${image.image_id} vhdxSha256=${image.vhdx_sha256.slice(0, 12)}…\n`)

  const blobRoot = join(repoRoot, 'data', 'blobs')
  // 饥饿保护：仅当没有其他排队 run 时才创建/消费 canary，避免 canary 无限插队真实任务
  const realQueued = Number((await db.prepare(
    `SELECT COUNT(*) AS c FROM test_runs r
     WHERE r.status='queued' AND r.desired_state='running'
       AND r.run_id NOT IN (
         SELECT r2.run_id FROM test_runs r2
         JOIN task_instances t ON t.task_instance_id=r2.task_instance_id
         WHERE t.external_task_id='AWP-STATIC-CANARY'
       )`
  ).get()).c || 0)
  if (realQueued === 0) {
    const canary = await ensureCanaryStaticRun(db, {
      blobRoot,
      remoteUrl: deploy.AWP_GIT_REMOTE_URL || process.env.AWP_GIT_REMOTE_URL || null,
      token,
      workspacePath,
    })
    process.stdout.write(`static run ${canary.runId} reused=${canary.reused} bundle=${canary.bundleSize} bytes\n`)
  }

  const worker = await loadOrCreateWorkerIdentity(db, {
    runnerRoot,
    hostname: os.hostname(),
    certSearchPaths: [join(repoRoot, 'secret-broker', 'dev-certs', 'worker.crt')],
  })
  const brokerUrl = process.env.AWP_BROKER_URL || deploy.AWP_BROKER_URL || null
  const broker = brokerUrl
    ? createBrokerTransports({ pkiDir: join(repoRoot, 'secret-broker', 'dev-certs'), brokerUrl })
    : null
  const reservation = await acquireLease(db, worker)
  if (!reservation) throw new Error('没有 queued static run')
  // 分步流程时间线：结束后看板可逐步点开追踪
  const steps = []
  const stepAt = (phase, name, {
    status = 'ok',
    detail = null,
    durationMs = null,
    logPath = null,
    expected = null,
    actual = null,
    action = null,
    target = null,
    evidence = null,
    note = null,
    caseKey = null,
  } = {}) => {
    const s = { at: new Date().toISOString(), phase, name, status }
    if (detail) s.detail = String(detail).slice(0, 2000)
    if (durationMs != null) s.durationMs = durationMs
    if (logPath) s.logPath = logPath
    if (expected) s.expected = String(expected).slice(0, 500)
    if (actual) s.actual = String(actual).slice(0, 500)
    if (action) s.action = action
    if (target != null) s.target = String(target).slice(0, 200)
    if (evidence) s.evidence = evidence
    if (note) s.note = String(note).slice(0, 500)
    if (caseKey) s.caseKey = caseKey
    steps.push(s)
    return s
  }
  const persistSteps = async () => {
    try {
      await db.prepare('UPDATE run_attempts SET steps_json=? WHERE run_id=? AND attempt=?').run(
        JSON.stringify(steps),
        reservation.runId,
        reservation.attempt
      )
    } catch (err) {
      process.stderr.write(`steps persist skip: ${err.message}\n`)
    }
  }
  stepAt('lease', '领取执行租约（lease）', {
    detail: `attempt=${reservation.attempt} epoch=${reservation.leaseEpoch}`,
    expected: '成功占用 worker 执行槽',
    actual: `attempt=${reservation.attempt}`,
  })
  const guest = generateEd25519Pem()
  const accepted = await acceptLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    guestPublicKey: guest.publicKeyPem,
    guestKeySha256: publicKeySha256(guest.publicKeyPem),
  }, { broker: broker ? broker.controlPlane : null })
  stepAt('lease', '接受租约并生成 Guest 密钥', {
    detail: `image=${accepted.runSpec?.runnerImageId || '-'}`,
    expected: 'runSpec 签名校验通过，Guest 密钥就绪',
    actual: `image=${accepted.runSpec?.runnerImageId || '-'}`,
  })
  const attemptDir = join(runnerRoot, 'attempts', reservation.runId)
  mkdirSync(join(attemptDir, 'input'), { recursive: true })
  mkdirSync(join(attemptDir, 'output'), { recursive: true })
  mkdirSync(join(attemptDir, 'workspace'), { recursive: true })
  mkdirSync(join(attemptDir, 'suite', 'fixtures'), { recursive: true })
  writeFileSync(join(attemptDir, 'input', 'guest.ed25519.pem'), guest.privateKeyPem, { mode: 0o600 })
  const staged = stageGuestPack(join(attemptDir, 'input'))
  writeFileSync(join(attemptDir, 'input', 'runspec.json'), JSON.stringify(accepted.runSpec))
  writeFileSync(join(attemptDir, 'input', 'runspec.sig'), accepted.runSpecSignature)
  writeFileSync(join(attemptDir, 'input', 'runspec.pub.pem'), (await db.prepare(
    'SELECT public_key_pem FROM signing_keys WHERE key_id=?'
  ).get(accepted.signingKeyId)).public_key_pem)
  const plan = await db.prepare(
    `SELECT p.canonical_lock_json FROM test_runs r
     JOIN test_bindings b ON b.binding_id=r.binding_id
     JOIN suite_plans p ON p.suite_plan_id=b.suite_plan_id
     WHERE r.run_id=?`
  ).get(reservation.runId)
  writeFileSync(join(attemptDir, 'input', 'cases.json'), JSON.stringify(JSON.parse(plan.canonical_lock_json).cases || []))
  const profileRow = await db.prepare(
    'SELECT profile_json FROM execution_profile_revisions WHERE profile_revision_id=?'
  ).get(accepted.runSpec.profileRevisionId)
  if (profileRow) {
    writeFileSync(join(attemptDir, 'input', 'profile.json'), profileRow.profile_json)
  }
  writeFileSync(
    join(attemptDir, 'input', 'npm-proxy.json'),
    JSON.stringify(guestProxyConfig({ cafile: 'C:\\awp-run\\input\\packages-ca.crt' })),
  )
  cpSync(proxy.caPath, join(attemptDir, 'input', 'packages-ca.crt'))
  // eslint 基线 ratchet（v11）：本任务改动文件清单随快照存库，注入 guest 供 test:static/eslint-ratchet 判定；
  // v11 前的历史 run 无该列值 → 不注入 → guest 侧 skipped（不阻塞老任务）
  try {
    const cfRow = await db.prepare(
      `SELECT s.changed_files_json, s.head_commit_oid FROM test_runs r
       JOIN test_bindings b ON b.binding_id=r.binding_id
       JOIN business_snapshots s ON s.snapshot_id=b.snapshot_id
       WHERE r.run_id=?`
    ).get(reservation.runId)
    const changedFiles = cfRow?.changed_files_json ? JSON.parse(cfRow.changed_files_json) : null
    if (Array.isArray(changedFiles)) {
      writeFileSync(join(attemptDir, 'input', 'changed-files.json'), JSON.stringify(changedFiles))
      // 任务边界（行级变异/归因诊断）：独立查询，失败不影响 changed-files 注入
      let startHeadOid = null
      try {
        const bRow = await db.prepare(
          `SELECT t.meta AS meta FROM test_runs r
           JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
           JOIN repositories repos ON repos.repo_id = ti.repo_id
           JOIN tasks t ON t.task_id = ti.external_task_id AND t.repo = repos.slug
           WHERE r.run_id=?`
        ).get(reservation.runId)
        const meta = bRow?.meta ? JSON.parse(bRow.meta) : {}
        startHeadOid = typeof meta?.startHeadOid === 'string' ? meta.startHeadOid : null
      } catch { startHeadOid = null }
      writeFileSync(
        join(attemptDir, 'input', 'task-boundary.json'),
        JSON.stringify({
          startHeadOid,
          headCommitOid: cfRow?.head_commit_oid || null,
          note: startHeadOid ? 'task-boundary' : 'no-start-ref',
        })
      )
      process.stdout.write(
        `changed-files injected: ${changedFiles.length}` +
          (startHeadOid ? ` start=${String(startHeadOid).slice(0, 12)}` : '') +
          '\n'
      )
      stepAt('inject', '注入本任务改动文件清单', {
        detail: `changed-files=${changedFiles.length}` + (startHeadOid ? ` start=${String(startHeadOid).slice(0, 12)}` : ' start=none'),
        expected: 'changed-files.json 写入 attempt input',
        actual: `${changedFiles.length} 个文件`,
      })
    }
  } catch (err) {
    process.stdout.write(`changed-files inject skip: ${err.message}\n`)
  }
  // 多仓 smoke profile：按 binding 的 repo 注入 smoke-scripts.json
  // Without a profile, write an empty object so the guest cannot fall back to built-in project commands.
  try {
    const repoRow = await db
      .prepare(
        `SELECT r.slug FROM test_bindings b
         JOIN repositories r ON r.repo_id=b.repo_id
         WHERE b.binding_id=?`
      )
      .get(accepted.runSpec.bindingId)
    const slug = repoRow?.slug || 'demo-app'
    const sides = listSmokeSides(slug)
    const scripts = {}
    for (const s of sides) scripts[s] = getSmokeScriptsForSide(slug, s)
    writeFileSync(join(attemptDir, 'input', 'smoke-scripts.json'), JSON.stringify(scripts, null, 2))
    process.stdout.write(
      sides.length
        ? `smoke-scripts injected for ${slug}: ${sides.join(',')}\n`
        : `smoke-scripts empty for ${slug}（未配置 profile，smoke lane 会报 SMOKE_SIDE_UNKNOWN）\n`
    )
  } catch (err) {
    process.stdout.write(`smoke-scripts inject skip: ${err.message}\n`)
  }
  const blobs = createBlobStore(blobRoot)
  const bundleSrc = blobs.contentPath(accepted.runSpec.sourceBlobSha256)
  if (!existsSync(bundleSrc)) {
    // 认领后、开 VM 前发现快照 bundle blob 不在本机（提交/后台曾在无共享盘的节点产生）：不可恢复。
    // 显式 rejectLease 并传递 terminalReason='SNAPSHOT_HASH_MISMATCH' → 直接终态 error，不重试（重试无意义，bundle 永远不会在本机出现）。
    // 避免租约滞留到 TTL 造成队列假死；infra_error 会被 loop 归为 infra 且可 ops 重推。随后抛出终止本车道。
    process.stderr.write(`SNAPSHOT_HASH_MISMATCH run=${reservation.runId} 快照 bundle 缺失于本机 blob 存储，直接终态（不重试）\n`)
    try {
      await rejectLease(db, worker, reservation.leaseId, {
        runId: reservation.runId,
        workerId: worker.worker_id,
        attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch,
        leaseToken: reservation.leaseToken,
        terminalReason: 'SNAPSHOT_HASH_MISMATCH', // 不可恢复错误，不重试
      })
    } catch (rejectErr) {
      process.stderr.write(`reject(snapshot mismatch): ${rejectErr.message}\n`)
    }
    throw new Error('SNAPSHOT_HASH_MISMATCH')
  }
  cpSync(bundleSrc, join(attemptDir, 'input', 'snapshot.bundle'))
  // 测试资产注入（feature-key 模式）：按 binding 冻结的执行清单离线写入 input/test-specs。
  // 清单在提交时定死（版本 + 内容 sha256），执行侧只按清单取内容并逐条校验——
  // 提交后改卷/归档/换版本都不影响本 run；清单不可用时才回落「当前 active 全量」并明确打点。
  // 按 spec_type 分流：e2e/smoke → 顶层（guest smoke 断言后逐个执行）；unit → unit/ 子目录（guest static 跑）
  try {
    const bindingRepoId = (await db
      .prepare('SELECT repo_id FROM test_bindings WHERE binding_id = ?')
      .get(accepted.runSpec.bindingId))?.repo_id
    if (bindingRepoId) {
      // 变异验卷 run：只注入 payload.featureKey 指定的考卷，manifest 带 mutation 标记（guest 据此暗改代码）
      const runMeta = await db.prepare('SELECT purpose, payload_json FROM test_runs WHERE run_id = ?').get(reservation.runId) || {}
      const mutationPayload = runMeta.purpose === 'mutation' ? JSON.parse(runMeta.payload_json || '{}') : null
      let specs = null
      let injectSource = 'asset-lock'
      try {
        const bindingDoc = JSON.parse(
          (await db.prepare('SELECT canonical_binding_json FROM test_bindings WHERE binding_id=?').get(accepted.runSpec.bindingId))
            ?.canonical_binding_json || '{}'
        )
        if (Array.isArray(bindingDoc.assetLock?.specs)) {
          specs = loadLockedSpecs(bindingDoc.assetLock)
        }
      } catch (err) {
        // 清单存在但内容缺失/摘要不符 → 本 run 直接失败（fail-closed），禁止静默跑「别的版本」
        throw new Error(`ASSET_LOCK_UNRESOLVED: ${err.message}`)
      }
      if (!specs) {
        // 旧 binding（本次升级前提交）无冻结清单：回落「本任务 draft + 公共」+ 过滤
        injectSource = 'live-active'
        let gateTaskId = null
        try {
          gateTaskId = (await db.prepare(
            `SELECT ti.external_task_id AS tid FROM test_runs r
             JOIN task_instances ti ON ti.task_instance_id = r.task_instance_id
             WHERE r.run_id = ?`
          ).get(reservation.runId))?.tid || null
        } catch { gateTaskId = null }
        let live = await specsForGateInject(bindingRepoId, gateTaskId)
        const injectSlug = (await db.prepare('SELECT slug FROM repositories WHERE repo_id = ?').get(bindingRepoId))?.slug || ''
        let cfForSpecs = null
        try {
          const cRow = await db.prepare(
            `SELECT s.changed_files_json FROM test_runs r
             JOIN test_bindings b ON b.binding_id=r.binding_id
             JOIN business_snapshots s ON s.snapshot_id=b.snapshot_id
             WHERE r.run_id=?`
          ).get(reservation.runId)
          cfForSpecs = cRow?.changed_files_json ? JSON.parse(cRow.changed_files_json) : null
        } catch { cfForSpecs = null }
        const beforeFilter = live.length
        live = filterSpecsForSpecInject(live, {
          changedFiles: cfForSpecs,
          mode: await getE2eInjectMode(db, injectSlug),
          taskId: gateTaskId,
        })
        process.stdout.write(
          `test-specs LEGACY inject (no asset-lock): ${beforeFilter} → ${live.length} taskId=${gateTaskId || '-'}\n`
        )
        specs = live
      }
      if (mutationPayload?.featureKey) specs = specs.filter((s) => s.feature_key === mutationPayload.featureKey)
      let mutationPages = null
      if (mutationPayload?.featureKey) {
        try {
          const pj = mutationPayload.specId
            ? (await db.prepare('SELECT pages_json FROM test_specs WHERE spec_id=?').get(mutationPayload.specId))?.pages_json
            : (await db.prepare('SELECT pages_json FROM test_specs WHERE repo_id=? AND feature_key=? ORDER BY version DESC LIMIT 1').get(bindingRepoId, mutationPayload.featureKey))?.pages_json
          mutationPages = pj ? JSON.parse(pj) : null
        } catch { mutationPages = null }
      }
      // Run a side-scoped asset only in its configured smoke lane; unscoped assets remain available to all lanes.
      const runSide = accepted.runSpec.side || null
      const e2eSpecs = specs.filter((s) => s.spec_type !== 'unit' && (!s.side || s.side === runSide))
      const unitSpecs = specs.filter((s) => s.spec_type === 'unit')
      if (e2eSpecs.length) {
        const specDir = join(attemptDir, 'input', 'test-specs')
        mkdirSync(specDir, { recursive: true })
        for (const s of e2eSpecs) writeFileSync(join(specDir, s.entry), s.content, 'utf8')
        writeFileSync(
          join(specDir, 'manifest.json'),
          // mutation 带 featureKey：guest 暗改 seed 含考卷标识，每张考卷面对不同暗改点（旧版布尔仅表开关）
          // 每条带 version/blobSha256：执行身份随报告回传，门禁可与冻结清单逐条对齐
          JSON.stringify({
            mutation: mutationPayload?.featureKey ? { featureKey: mutationPayload.featureKey, pages: mutationPages } : null,
            injectSource,
            specs: e2eSpecs.map((s) => ({ featureKey: s.feature_key, entry: s.entry, version: s.version, blobSha256: s.blob_sha256 })),
          }, null, 1),
        )
        process.stdout.write(`test-specs injected (e2e, side=${runSide}${mutationPayload ? ', mutation' : ''}, src=${injectSource}): ${e2eSpecs.length}\n`)
        stepAt('inject', `注入 E2E 考卷资产（${e2eSpecs.length} 张）`, {
          detail: `side=${runSide} count=${e2eSpecs.length} src=${injectSource}`,
          expected: 'input/test-specs/manifest.json 与考卷文件就绪',
          actual: `side=${runSide || '-'} 注入 ${e2eSpecs.length} 张（来源 ${injectSource}）`,
        })
      }
      // 租户质量阈值下发（如样式复用率）：guest static 据此启用对应检查
      try {
        const slug = (await db.prepare('SELECT slug FROM repositories WHERE repo_id = ?').get(bindingRepoId))?.slug
        const profile = slug ? getRepoPlatformProfile(slug) : null
        if (profile?.styleReuseThreshold) {
          writeFileSync(
            join(attemptDir, 'input', 'static-config.json'),
            JSON.stringify({ styleReuseThreshold: profile.styleReuseThreshold }),
            'utf8'
          )
          process.stdout.write(`static-config injected (styleReuseThreshold=${profile.styleReuseThreshold})\n`)
        }
      } catch (err) {
        process.stdout.write(`static-config inject skip: ${err.message}\n`)
      }
      if (unitSpecs.length) {
        const unitDir = join(attemptDir, 'input', 'test-specs', 'unit')
        mkdirSync(unitDir, { recursive: true })
        for (const s of unitSpecs) writeFileSync(join(unitDir, s.entry), s.content, 'utf8')
        writeFileSync(
          join(unitDir, 'manifest.json'),
          JSON.stringify({
            injectSource,
            specs: unitSpecs.map((s) => ({ featureKey: s.feature_key, entry: s.entry, version: s.version, blobSha256: s.blob_sha256 })),
          }, null, 1),
        )
        process.stdout.write(`test-specs injected (unit, src=${injectSource}): ${unitSpecs.length}\n`)
      }
    }
  } catch (err) {
    // 冻结清单解析失败必须硬失败：静默 skip 等于用「没注入任何考卷」的空 run 去判卷。
    // 且不可裸抛：此处尚在心跳定时器（line 477）与 VM try/finally（line 518）之前，裸抛会遗弃租约，
    // 45s 后被 reconcile 判 HEARTBEAT_LOST → 空烧 3 次 attempt 后报 terminal=lost（10-09 三轮秒败根因）。
    // 正确姿势：先 rejectLease（terminalReason 进不可重试清单 → 直接终态 error，同执可见 ASSET_LOCK_UNRESOLVED）再抛。
    if (String(err.message || '').startsWith('ASSET_LOCK_UNRESOLVED')) {
      try {
        await rejectLease(db, worker, reservation.leaseId, {
          runId: reservation.runId,
          workerId: worker.worker_id,
          attempt: reservation.attempt,
          leaseEpoch: reservation.leaseEpoch,
          leaseToken: reservation.leaseToken,
          terminalReason: 'ASSET_LOCK_UNRESOLVED',
        })
      } catch (rejectErr) {
        process.stderr.write(`reject(asset lock): ${rejectErr.message}\n`)
      }
      throw err
    }
    process.stdout.write(`test-specs inject skip: ${err.message}\n`)
  }

  let seq = 1
  await heartbeatLease(db, worker, reservation.leaseId, heartbeatBody(worker, reservation, seq++))
  const timer = setInterval(async () => {
    try {
      await heartbeatLease(db, worker, reservation.leaseId, heartbeatBody(worker, reservation, seq++))
    } catch (err) {
      process.stderr.write(`heartbeat: ${err.message}\n`)
    }
  }, 10000)

  const name = vmNameFor(reservation.runId, reservation.attempt)
  // §14.10：明文只在 Worker 内存 → 经 stdin 交 PS1 → Direct 写 Guest run-local；attempt 结束 revoke
  // secret grants：M3.3 §14.10 明文不落宿主盘。重构后 agent 由开机任务跑，secret 走「离线注入」
  //   1. lane 从 broker fetch（明文仅在 worker 内存）
  //   2. 写入 attemptDir/secret-grants.json（base64）
  //   3. lane 进程内清零（finally 立即 revoke 抹去 broker 端明文）
  //   4. guest 开机任务从镜像里读 secret-grants.json → 写 Guest run-local
  if (accepted.secretGrants.length && broker) {
    const grants = []
    for (const g of accepted.secretGrants) {
      const fetched = await broker.worker.fetchGrant({
        secretGrantId: g.secretGrantId,
        workerId: worker.worker_id,
        leaseId: reservation.leaseId,
        capability: g.capability,
      })
      grants.push({
        capability: g.capability,
        base64: Buffer.from(String(fetched.plaintext), 'utf8').toString('base64'),
      })
    }
    await markGrantsFetched(db, { leaseId: reservation.leaseId })
    const grantsFile = join(attemptDir, 'secret-grants.json')
    writeFileSync(grantsFile, JSON.stringify({
      runLocalDir: 'C:\\awp-run\\run-local',
      grants,
    }, null, 1))
    process.stdout.write(`secret grants offline-written: ${grants.length}\n`)
  }
  let laneError = null
  // 并行 attempt 各占一个 Guest IP，避免 Internal 交换机同 IP 冲突（此前 smoke a1/a2 稳定 ~30s infra_error）
  let guestIp = null
  try {
    guestIp = acquireGuestIp(reservation.leaseId)
    process.stdout.write(`guestIp=${guestIp} lease=${reservation.leaseId} attempt=${reservation.attempt}\n`)
    stepAt('network', '为 Guest 分配内网 IP', {
      detail: guestIp,
      expected: '从 IP 池取到可用 Guest IP',
      actual: guestIp,
    })
  } catch (err) {
    laneError = err
    process.stderr.write(`guestIp acquire: ${err.message}\n`)
    stepAt('network', '为 Guest 分配内网 IP', {
      status: 'failed',
      detail: err.message,
      expected: '从 IP 池取到可用 Guest IP',
      actual: err.message,
    })
  }
  try {
    if (laneError) throw laneError
    stepAt('vm', '启动 Hyper-V 一次性测试虚拟机', {
      detail: name,
      expected: 'VM 从 golden 镜像启动并进入执行',
      actual: `vm=${name}`,
    })
    // 依赖缓存层（v21 dep_cache=on）：把 lockfile 哈希交给 lane 决定是否挂预热层。
    // 租户隔离按 repo+lockhash 命名，不同租户/不同依赖永不共享。
    let repoSlug = null
    try {
      const bindingRowDc = await db.prepare(
        `SELECT s.bundle_sha256, b.repo_id FROM test_bindings b
         JOIN business_snapshots s ON s.snapshot_id = b.snapshot_id
         WHERE b.binding_id = ?`
      ).get(accepted.runSpec.bindingId)
      repoSlug = bindingRowDc?.repo_id
        ? (await db.prepare('SELECT slug FROM repositories WHERE repo_id = ?').get(bindingRowDc.repo_id))?.slug
        : null
      if (repoSlug) writeFileSync(join(attemptDir, 'input', 'dep-cache-repo'), repoSlug, 'utf8')
      if (bindingRowDc?.bundle_sha256) {
        // bundle 哈希已覆盖"依赖集合"语义（bundle 内容含 lockfile）；取 16 位做层名
        writeFileSync(join(attemptDir, 'input', 'dep-cache-lockhash'), bindingRowDc.bundle_sha256.slice(0, 16), 'utf8')
      }
    } catch (err) {
      process.stdout.write(`dep-cache inject skip: ${err.message}\n`)
    }
    await spawnPs(join(here, 'hyperv-static-lane.ps1'), [
      '-VmName', name,
      '-GoldenVhdx', goldenVhdx,
      '-PasswordFile', passwordFile,
      '-AttemptDir', attemptDir,
      '-ExpectedVhdxSha256', image.vhdx_sha256,
      '-WaitMinutes', String(waitMinutes),
      '-BootReadyMinutes', String(bootReadyMinutes),
      '-SwitchName', SWITCH_NAME,
      '-ProxyIp', PROXY_IP,
      '-GuestIp', guestIp,
      '-ProxyPort', String(PROXY_PORT),
      '-ProxyHostName', PROXY_HOST,
      '-Repo', repoSlug || '',
      '-RepoRootPath', repoRoot,
    ])
    stepAt('vm', 'VM 内测试执行完成', {
      detail: 'lane 退出码 0',
      expected: 'Guest agent 正常退出并回写 sidecar',
      actual: '退出码 0',
    })
  } catch (err) {
    laneError = err
    stepAt('vm', 'VM 执行失败', {
      status: 'failed',
      detail: err.message,
      expected: 'Guest agent 正常退出',
      actual: err.message,
    })
  } finally {
    // 网络/开机类失败：该 IP 冷却 2 分钟，避免同一坏 IP 连烧 attempt 预算
    const netish = laneError && /PROXY|GUEST|BOOT|TIMEOUT|NOT_READY|IP_POOL/i.test(String(laneError.message || laneError))
    releaseGuestIp(reservation.leaseId, { cooldownMs: netish ? 120000 : 0 })
    await persistSteps()
    if (broker) {
      for (const g of accepted.secretGrants) {
        try {
          await broker.worker.revokeGrant({
            secretGrantId: g.secretGrantId,
            workerId: worker.worker_id,
            leaseId: reservation.leaseId,
          })
        } catch (revokeErr) {
          process.stderr.write(`secret revoke: ${revokeErr.message}\n`)
        }
      }
      await markGrantsRevoked(db, { leaseId: reservation.leaseId })
    }
  }
  if (laneError) {
    clearInterval(timer)
    try {
      await rejectLease(db, worker, reservation.leaseId, {
        runId: reservation.runId,
        workerId: worker.worker_id,
        attempt: reservation.attempt,
        leaseEpoch: reservation.leaseEpoch,
        leaseToken: reservation.leaseToken,
      })
    } catch (rejectErr) {
      process.stderr.write(`reject: ${rejectErr.message}\n`)
    }
    throw laneError
  }
  clearInterval(timer)

  const loaded = loadGuestSidecar(join(attemptDir, 'output'))
  stepAt('result', '回读 Guest sidecar 判定结果', {
    detail: `status=${loaded.result?.status || '-'} checks=${(loaded.result?.checks || []).length}`,
    expected: 'sidecar result.json 可解析且含 checks',
    actual: `status=${loaded.result?.status || '-'}`,
    logPath: 'output/boot.log',
  })
  for (const c of loaded.result?.checks || []) {
    const key = String(c.caseKey || '')
    let name = key
    let expected = '检查项通过'
    if (key.startsWith('test:spec/')) {
      const fk = key.slice('test:spec/'.length)
      name = `E2E 考卷《${fk}》${c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'}`
      expected = '页面断言全部通过（网络/数据/元素）'
    } else if (key.startsWith('test:unit-spec/')) {
      const fk = key.slice('test:unit-spec/'.length)
      name = `单测资产《${fk}》${c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'}`
      expected = '注入的 unit 测试全部执行且通过'
    } else if (key.startsWith('test:static/')) {
      name = `静态检查 ${key.slice('test:static/'.length)} ${c.status === 'passed' ? '通过' : c.status === 'skipped' ? '跳过' : '失败'}`
      expected = '平台静态规则通过'
    }
    stepAt('check', name, {
      status: c.status === 'passed' ? 'ok' : c.status === 'skipped' ? 'skip' : 'failed',
      detail: c.detail || null,
      durationMs: c.durationMs ?? null,
      logPath: 'output/agent.log',
      caseKey: c.caseKey,
      expected,
      actual: c.status === 'passed' ? '通过' : (c.detail || null),
    })
  }
  await persistSteps()
  uploadAttemptArtifact(db, blobs, worker, reservation, accepted, attemptDir, {
    result: loaded.result,
    resultSha256: loaded.manifest.resultSha256,
    manifestSha256: documentSha256(loaded.manifest),
  })
  await completeLease(db, worker, reservation.leaseId, {
    runId: reservation.runId,
    workerId: worker.worker_id,
    attempt: reservation.attempt,
    leaseEpoch: reservation.leaseEpoch,
    leaseToken: reservation.leaseToken,
    bindingId: accepted.runSpec.bindingId,
    status: loaded.result.status,
    resultSha256: loaded.manifest.resultSha256,
    runnerImageId: accepted.runSpec.runnerImageId,
    runnerImageManifestSha256: accepted.runSpec.runnerImageManifestSha256,
    checks: loaded.result.checks,
    artifactManifestSha256: documentSha256(loaded.manifest),
  })
  // spec 执行结果回写（feature-key 模式）：fail_streak 连续失败自动标 orphan-candidate（防线三）
  // 变异验卷 run 跳过 fail_streak 回写——变异失败是"考卷有效"的证明，不是考卷质量事故（verified 回写在 leases）
  const runPurpose = (await db.prepare('SELECT purpose FROM test_runs WHERE run_id = ?').get(reservation.runId))?.purpose
  try {
    const bindingRepoId = (await db
      .prepare('SELECT repo_id FROM test_bindings WHERE binding_id = ?')
      .get(accepted.runSpec.bindingId))?.repo_id
    if (bindingRepoId && runPurpose !== 'mutation') {
      for (const c of loaded.result.checks || []) {
        const key = String(c.caseKey || '')
        if (key.startsWith('test:spec/')) {
          await recordSpecResult({
            repoId: bindingRepoId,
            featureKey: key.slice('test:spec/'.length),
            passed: c.status === 'passed',
          })
        } else if (key.startsWith('test:unit-spec/')) {
          await recordSpecResult({
            repoId: bindingRepoId,
            featureKey: key.slice('test:unit-spec/'.length),
            passed: c.status === 'passed',
          })
        }
      }
    }
  } catch (err) {
    process.stderr.write(`spec result write-back skip: ${err.message}\n`)
  }
  return { reservation, result: loaded.result, attemptDir, workspacePath }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  (await runStaticLane()).then((out) => {
    process.stdout.write(`STATIC LANE OK status=${out.result.status} dir=${out.attemptDir}\n`)
    process.stdout.write('（status=passed 为产品 static 通过；failed/error 仍表示 VM/代理路径跑完）\n')
  }).catch((err) => {
    process.stderr.write(`${err.stack || err}\n`)
    process.exit(1)
  })
}
