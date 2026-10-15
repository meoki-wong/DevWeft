import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function git(args, opts = {}) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=nul', ...args], {
    encoding: 'utf8',
    timeout: opts.timeout || 120000,
    cwd: opts.cwd,
  })
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`)
  }
  return r.stdout
}

export function unbundleSnapshot(bundlePath, workspaceDir) {
  if (!existsSync(bundlePath)) throw new Error('SNAPSHOT_HASH_MISMATCH')
  if (existsSync(workspaceDir)) rmSync(workspaceDir, { recursive: true, force: true })
  mkdirSync(workspaceDir, { recursive: true })
  git(['init', workspaceDir])
  const bundle = String(bundlePath).replace(/\\/g, '/')
  git(['-C', workspaceDir, 'fetch', bundle, 'refs/awp/snapshot:refs/heads/snapshot'])
  git(['-C', workspaceDir, 'checkout', 'snapshot'])
}

export function writeNpmrc(workspaceDir, { registry, cafile }) {
  const lines = [
    `registry=${registry}`,
    // 注意：不能加 replace-registry-host=always —— npm 会把 registry 的 /npm 前缀
    // 叠加到 lock 已重写的 resolved 上（/npm + /npm/zrender → 404）；
    // 路径正确性由 install.mjs 的 rewriteLockResolvedToRegistry 保证
    'fund=false',
    'audit=false',
  ]
  if (cafile) lines.push(`cafile=${cafile.replace(/\\/g, '/')}`)
  writeFileSync(join(workspaceDir, '.npmrc'), `${lines.join('\n')}\n`)
}

export function deleteNpmrc(workspaceDir) {
  const p = join(workspaceDir, '.npmrc')
  if (existsSync(p)) rmSync(p)
}
