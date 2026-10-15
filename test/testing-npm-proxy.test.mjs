import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
installSqliteTx(Database)
import { runTestingMigrations } from '../testing/migrate.js'
import { generateDevPki, issuePackagesProxyCert } from '../scripts/gen-dev-pki.mjs'
import { buildDirtyWorkspaceSnapshot, cleanupSnapshotTmp } from '../testing/snapshots.js'
import { unbundleSnapshot, writeNpmrc, deleteNpmrc } from '../runner/guest-agent/unbundle.mjs'
import { eslintArgs } from '../runner/guest-agent/static.mjs'
import { guestProxyConfig, REGISTRY_URL, PROXY_HOST, PROXY_IP } from '../runner/network/policy.mjs'
import { verdaccioYaml, npmInstallErrorMessage } from '../runner/npm-proxy/start.mjs'
import { resolveRepoWorkspacePath } from '../testing/repo-platform.js'
import { probeRegistry } from '../runner/guest-agent/install.mjs'
import { stageGuestPack } from '../runner/guest-agent/stage-pack.mjs'

async function memdb() {
  const db = new Database(join(mkdtempSync(join(tmpdir(), 'awp-npm-')), 't.db'))
  db.pragma('foreign_keys = ON')
  await runTestingMigrations(db, { skipLegacyMap: true })
  return db
}

function initGit(dir) {
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
  writeFileSync(join(dir, 'ok.js'), 'const n = 1\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mini-project', version: '0.0.1', private: true }))
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({
    name: 'mini-project', lockfileVersion: 3, requires: true, packages: { '': { name: 'mini-project', version: '0.0.1' } },
  }))
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'i'], { cwd: dir })
}

describe('npm-proxy-only-v1 guest install helpers', () => {
  it('writes registry npmrc without leaving it behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-npmrc-'))
    writeNpmrc(dir, { registry: REGISTRY_URL, cafile: 'C:\\awp-run\\input\\packages-ca.crt' })
    const text = readFileSync(join(dir, '.npmrc'), 'utf8')
    expect(text).toContain(`registry=${REGISTRY_URL}`)
    // replace-registry-host=always 会把 registry 的 /npm 前缀叠加到 lock resolved path（/npm/npm/... 404），已移除；
    // 路径正确性由 install.mjs 的 rewriteLockResolvedToRegistry 保证
    expect(text).not.toContain('replace-registry-host')
    expect(text).toContain('cafile=C:/awp-run/input/packages-ca.crt')
    deleteNpmrc(dir)
    expect(existsSync(join(dir, '.npmrc'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('never passes --fix to eslint', () => {
    expect(eslintArgs(['src/a.js']).includes('--fix')).toBe(false)
    expect(eslintArgs().includes('--fix')).toBe(false)
    expect(eslintArgs(['src/a.js'])).toContain('src/a.js')
    expect(eslintArgs()).not.toContain('.')
  })

  it('unbundles a dirty-workspace snapshot ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-appmini-'))
    initGit(dir)
    writeFileSync(join(dir, 'extra.txt'), 'dirty')
    const tmp = mkdtempSync(join(tmpdir(), 'awp-bund-'))
    const snap = buildDirtyWorkspaceSnapshot(dir, { tmpRoot: tmp, withBundle: true })
    const dest = mkdtempSync(join(tmpdir(), 'awp-ws-'))
    unbundleSnapshot(snap.bundlePath, dest)
    expect(readFileSync(join(dest, 'extra.txt'), 'utf8')).toBe('dirty')
    expect(readFileSync(join(dest, 'ok.js'), 'utf8')).toContain('const n')
    cleanupSnapshotTmp(snap)
    rmSync(dir, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  })

  it('issues packages.example.invalid cert from existing CA', () => {
    const caDir = mkdtempSync(join(tmpdir(), 'awp-ca-'))
    generateDevPki(caDir)
    const outDir = mkdtempSync(join(tmpdir(), 'awp-pkgcert-'))
    const issued = issuePackagesProxyCert(caDir, outDir, { dnsNames: [PROXY_HOST], ips: [PROXY_IP] })
    expect(existsSync(issued.certPath)).toBe(true)
    expect(existsSync(issued.keyPath)).toBe(true)
    expect(readFileSync(issued.certPath, 'utf8')).toContain('BEGIN CERTIFICATE')
    rmSync(caDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  })

  it('renders verdaccio config bound to loopback HTTP (TLS 由 tls-front 提供)', () => {
    const yaml = verdaccioYaml({
      storage: 'C:\\awp-runner\\npm-proxy\\storage',
      listen: '127.0.0.1:4873',
      uplinks: {
        npmjs: 'https://registry.npmjs.org/',
        company: 'https://packages.example.invalid/npm/',
      },
      packageRules: { '@example/*': 'company' },
      htpasswd: 'C:\\awp-runner\\npm-proxy\\htpasswd',
    })
    expect(yaml).toContain('listen: 127.0.0.1:4873')
    expect(yaml).not.toMatch(/^https:/m)
    expect(yaml).not.toMatch(/^url_prefix:/m)
    expect(yaml).toContain('proxy: company')
    expect(yaml).not.toContain('8787')
  })

  it('does not treat npm deprecated warnings as the install failure', () => {
    const warns = [
      'npm warn deprecated inflight@1.0.6: x',
      'npm warn deprecated verdaccio@5.33.0: migrate to 6.x',
    ].join('\n')
    const timed = npmInstallErrorMessage(
      { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } },
      warns,
    )
    expect(timed).toContain('超时')
    expect(timed).not.toContain('inflight')
    const failed = npmInstallErrorMessage({ status: 1, signal: null, error: null }, warns)
    expect(failed).toContain('exit=1')
    expect(failed).not.toContain('deprecated')
  })

  it('resolves a repository workspace from its slug-specific environment variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'awp-workspace-'))
    writeFileSync(join(dir, 'package.json'), '{}')
    expect(resolveRepoWorkspacePath('fixture-app', {
      env: { AWP_REPO_PATH_FIXTURE_APP: dir },
      repoRoot: dir,
    })).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  it('treats an unreachable registry as PRIVATE_REGISTRY_UNAVAILABLE', async () => {
    await expect(probeRegistry('https://127.0.0.1:1/', undefined)).rejects.toThrow('PRIVATE_REGISTRY_UNAVAILABLE')
  })

  it('stages unbundle and install into the guest pack', () => {
    const packDir = mkdtempSync(join(tmpdir(), 'awp-pack2-'))
    stageGuestPack(packDir)
    expect(existsSync(join(packDir, 'unbundle.mjs'))).toBe(true)
    expect(existsSync(join(packDir, 'install.mjs'))).toBe(true)
    rmSync(packDir, { recursive: true, force: true })
  })

  it('guestProxyConfig does not include uplink URLs', () => {
    const cfg = guestProxyConfig({ cafile: 'C:\\awp-run\\input\\packages-ca.crt' })
    const text = JSON.stringify(cfg)
    expect(cfg).not.toHaveProperty('uplinks')
    expect(cfg.registry).toBe(REGISTRY_URL)
  })

  it('canary with a workspace path stores a real git bundle, not the dummy blob', { timeout: 60_000 }, async () => {
    const db = await memdb()
    const dir = mkdtempSync(join(tmpdir(), 'awp-canary-'))
    initGit(dir)
    const blobDir = mkdtempSync(join(tmpdir(), 'awp-blob-'))
    const { ensureCanaryStaticRun, DUMMY_PREFIX } = await import('../runner/host-worker/canary.mjs')
    const dummy = await ensureCanaryStaticRun(db, {
      blobRoot: blobDir,
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
    })
    expect(dummy.bundleSize).toBeLessThan(256)
    const real = await ensureCanaryStaticRun(db, {
      blobRoot: blobDir,
      remoteUrl: 'https://gitlab.example/Web/demo-app.git',
      workspacePath: dir,
    })
    expect(real.reused).toBe(false)
    expect(real.bundleSize).toBeGreaterThan(dummy.bundleSize)
    expect(DUMMY_PREFIX).toBe('awp-static-canary:')
    const queued = await db.prepare(`SELECT status, run_id FROM test_runs WHERE run_id=?`).get(dummy.runId)
    expect(queued.status).toBe('error')
    rmSync(dir, { recursive: true, force: true })
    rmSync(blobDir, { recursive: true, force: true })
  })
})
