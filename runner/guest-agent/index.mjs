import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { verifyCanonical } from './verify.mjs'
import { runStaticChecks } from './static.mjs'
import { writeSidecarDir } from './sidecar.mjs'
import { unbundleSnapshot } from './unbundle.mjs'
import { runNpmCiHardened, needsVitestRuntime, ensureVitestRuntime } from './install.mjs'
import { buildArtifact } from './artifact.mjs'
import { startGuestHeartbeat } from './guest-heartbeat.mjs'
import { filterCasesForUnit } from './units.mjs'
import { runSmokeChecks } from './smoke.mjs'

function sha256file(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function executeGuestAttempt({
  runDir,
  runSpec,
  runSpecSignature,
  runspecPublicKeyPem,
  cases,
  guestPrivateKeyPem = null,
  smokeExecutor = runSmokeChecks,
  signingVerify = verifyCanonical,
}) {
  if (runSpec.audience !== 'awp-guest-agent') throw new Error('RUNSPEC_SIGNATURE_INVALID')
  if (!signingVerify(runspecPublicKeyPem, runSpec, runSpecSignature)) {
    throw new Error('RUNSPEC_SIGNATURE_INVALID')
  }
  const workspaceDir = join(runDir, 'workspace')
  const outputDir = join(runDir, 'output')
  mkdirSync(workspaceDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  // 阶段打点（boot.log）：VM 开机→agent 拉起之间是黑盒（9/9 静态 run 空窗 23min 无法定位），
  // agent 侧各阶段补 ISO 时间戳，与 autorun.cmd 的 cmd 侧打点拼成完整启动时间线
  const mark = (stage) => {
    try { appendFileSync(join(outputDir, 'boot.log'), `${new Date().toISOString()} ${stage}\n`) } catch { /* 打点不阻断主流程 */ }
  }
  mark('agent-enter')
  // §11.2：Guest 5s 心跳，宿主 watchdog 30s 停滞判定
  const stopGuestHeartbeat = startGuestHeartbeat(runDir)
  try {
    const bundlePath = join(runDir, 'input', 'snapshot.bundle')
    if (existsSync(bundlePath)) {
      if (sha256file(bundlePath) !== runSpec.sourceBlobSha256) throw new Error('SNAPSHOT_HASH_MISMATCH')
      unbundleSnapshot(bundlePath, workspaceDir)
      mark('unbundle-done')
    }

    const proxyPath = join(runDir, 'input', 'npm-proxy.json')
    const proxy = existsSync(proxyPath) ? JSON.parse(readFileSync(proxyPath, 'utf8')) : null
    let installError = null
    if (proxy && existsSync(join(workspaceDir, 'package-lock.json'))) {
      try {
        mark('install-start')
        await runNpmCiHardened({ workspaceDir, proxy })
        mark('install-done')
      } catch (err) {
        mark('install-failed')
        const msg = String(err && err.message ? err.message : err)
        if (/^PRIVATE_REGISTRY_UNAVAILABLE/.test(msg)) {
          writeFileSync(join(outputDir, 'install.log'), `${msg}\n`)
          throw err
        }
        installError = msg
      }
    }

    const unitCases = filterCasesForUnit(cases, runSpec)
    // 零接入单测运行时：业务仓未装 vitest 时平台经同一隔离网代理补装（--no-save 不动业务 lock）；
    // 装不上不拦安装链，由 static.mjs 的 vitestBin 检查报 VITEST_UNAVAILABLE check 级 error
    if (!installError && proxy && needsVitestRuntime({ workspaceDir, runDir, unit: runSpec.unit, cases: unitCases })) {
      await ensureVitestRuntime({ workspaceDir, proxy })
    }
    mark('checks-start')
    const checks = runSpec.unit === 'static'
      ? runStaticChecks({ workspaceDir, cases: unitCases, runDir })
      : runSpec.unit === 'smoke'
        ? await smokeExecutor({ workspaceDir, cases: unitCases, side: runSpec.side, runDir })
        : []
    mark('checks-done')
    const failed = checks.some((c) => c.status !== 'passed')
    const status = installError ? 'error' : (failed ? 'failed' : 'passed')

    const artifact = buildArtifact({ runDir, checks })
    writeFileSync(join(outputDir, 'artifact.zip'), artifact.archive)
    if (installError) writeFileSync(join(outputDir, 'install.log'), `${installError}\n`)

    const sidecar = writeSidecarDir(outputDir, {
      runSpec,
      status,
      checks,
      archiveSha256: sha256Buffer(artifact.archive),
      files: artifact.files,
      totalSize: artifact.totalSize,
      artifactTruncated: artifact.artifactTruncated,
      guestPrivateKeyPem,
    })
    // 宿主轮询文件存在（不依赖 Direct/Hyper-V 心跳）；创建后立即触发自关机
    if (process.env.AWP_GUEST_VM === '1') {
      writeFileSync(join(outputDir, 'AGENT_DONE'), new Date().toISOString())
    }
    return sidecar
  } finally {
    stopGuestHeartbeat()
    // VM 上下文：结果已落盘（含 AGENT_DONE 信号），宿主靠该文件存在 + VM Off 状态离线拉取
    if (process.env.AWP_GUEST_VM === '1') {
      process.stdout.write('agent done; shutting down guest VM\n')
      spawnSync('shutdown.exe', ['/s', '/t', '5', '/f', '/c', 'awp-agent-done'], { windowsHide: true })
    }
  }
}

if (process.env.AWP_RUN_DIR) {
  const runDir = process.env.AWP_RUN_DIR
  const spec = JSON.parse(readFileSync(join(runDir, 'input', 'runspec.json'), 'utf8'))
  const signature = readFileSync(join(runDir, 'input', 'runspec.sig'), 'utf8').trim()
  const pub = readFileSync(join(runDir, 'input', 'runspec.pub.pem'), 'utf8')
  const cases = JSON.parse(readFileSync(join(runDir, 'input', 'cases.json'), 'utf8'))
  const guestKeyPath = join(runDir, 'input', 'guest.ed25519.pem')
  const guestPrivateKeyPem = existsSync(guestKeyPath) ? readFileSync(guestKeyPath, 'utf8') : null
  executeGuestAttempt({
    runDir,
    runSpec: spec,
    runSpecSignature: signature,
    runspecPublicKeyPem: pub,
    cases,
    guestPrivateKeyPem,
  }).then(() => {
    process.exit(0)
  }).catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n')
    process.exit(1)
  })
}
