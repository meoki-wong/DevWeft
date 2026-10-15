#!/usr/bin/env node
/**
 * build-policies.mjs — 方案 §10：把 Rego 策略编译为进程内 WASM bundle。
 *
 * 用法：node scripts/build-policies.mjs
 * 依赖：OPA CLI(≥1.0)。查找顺序：AWP_OPA_BIN → 仓库 tools/bin/opa(.exe) → PATH。
 * 产物（提交入库，运行时零编译）：
 *   policies/mandatory/bundle/policy.wasm + data.json
 *   policies/default/bundle/policy.wasm + data.json
 *   policies/tenants/<slug>/bundle/…（有租户策略时）
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const policiesDir = path.join(root, 'policies')

function findOpa() {
  const candidates = [
    process.env.AWP_OPA_BIN,
    path.join(root, 'tools', 'bin', process.platform === 'win32' ? 'opa.exe' : 'opa'),
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  return 'opa' // PATH
}

const opa = findOpa()
console.log(`[policies] opa: ${opa}`)

function extractTarGz(tarPath, dest) {
  // Git Bash 的 tar 会把 Windows 盘符路径当远程主机:把包拷到目标目录内用相对文件名解包
  fs.mkdirSync(dest, { recursive: true })
  const localName = 'bundle.tar.gz'
  fs.copyFileSync(tarPath, path.join(dest, localName))
  execFileSync('tar', ['-xzf', localName], { cwd: dest })
  fs.rmSync(path.join(dest, localName), { force: true })
  // 清理解包杂质(Windows 盘符路径残留目录),只留 policy.wasm / data.json / .manifest
  for (const entry of fs.readdirSync(dest)) {
    if (['policy.wasm', 'data.json', '.manifest'].includes(entry)) continue
    fs.rmSync(path.join(dest, entry), { recursive: true, force: true })
  }
}

function buildPackage(name) {
  const src = path.join(policiesDir, name)
  if (!fs.existsSync(src)) return
  const outTar = path.join(os.tmpdir(), `awp-policy-${name}.tar.gz`)
  const entry = name === 'tenants' ? null : `awp/${name}/decision`
  execFileSync(opa, ['build', '-t', 'wasm', '-e', entry, '-o', outTar, path.relative(root, src)], { cwd: root })
  const dest = path.join(src, 'bundle')
  fs.rmSync(dest, { recursive: true, force: true })
  extractTarGz(outTar, dest)
  fs.rmSync(outTar, { force: true })
  console.log(`[policies] built ${name} → bundle/policy.wasm`)
}

for (const name of ['mandatory', 'default']) buildPackage(name)

// 租户包:每个 policies/tenants/<slug> 独立编译(package 名统一 policies.tenant)
const tenantsDir = path.join(policiesDir, 'tenants')
if (fs.existsSync(tenantsDir)) {
  for (const slug of fs.readdirSync(tenantsDir)) {
    const dir = path.join(tenantsDir, slug)
    if (!fs.statSync(dir).isDirectory()) continue
    if (!fs.readdirSync(dir).some((f) => f.endsWith('.rego'))) continue
    const outTar = path.join(os.tmpdir(), `awp-policy-tenant-${slug}.tar.gz`)
    execFileSync(opa, ['build', '-t', 'wasm', '-e', 'awp/tenant/decision', '-o', outTar, path.relative(root, dir)], { cwd: root })
    const dest = path.join(dir, 'bundle')
    fs.rmSync(dest, { recursive: true, force: true })
    extractTarGz(outTar, dest)
    fs.rmSync(outTar, { force: true })
    console.log(`[policies] built tenant ${slug} → bundle/policy.wasm`)
  }
}
console.log('[policies] 全部编译完成')
