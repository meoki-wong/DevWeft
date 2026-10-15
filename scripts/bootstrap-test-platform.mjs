#!/usr/bin/env node
/**
 * 控制面首次引导：创建 bootstrap-admin、首个 repo、ACL、可选 git remote、签发 token。
 * Usage: node scripts/bootstrap-test-platform.mjs [--rotate]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import db, { DB_DIALECT, initDB, openDb } from '../db.js'
import { bootstrapTestingPlatform } from '../testing/bootstrap.js'
import { DEFAULT_REPO, resolveRepoWorkspacePath } from '../testing/repo-platform.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const rotate = process.argv.includes('--rotate')

function detectRemoteUrl() {
  if (process.env.AWP_GIT_REMOTE_URL) return process.env.AWP_GIT_REMOTE_URL
  const sibling = resolveRepoWorkspacePath(DEFAULT_REPO, { repoRoot: root }) || path.join(root, '..', DEFAULT_REPO)
  try {
    return execFileSync('git', ['-C', sibling, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

if (DB_DIALECT === 'sqlite') initDB()
const database = await openDb()
try {
  const remoteUrl = detectRemoteUrl()
  const result = await bootstrapTestingPlatform(database, { slug: DEFAULT_REPO, remoteUrl, rotateToken: rotate })
  const outDir = path.join(root, 'data')
  fs.mkdirSync(outDir, { recursive: true })
  const tokenPath = path.join(outDir, 'bootstrap-admin.token')
  if (result.token) {
    fs.writeFileSync(tokenPath, `${result.token}\n`, { encoding: 'utf8' })
  }
  const summary = {
    principalId: result.principalId,
    repoId: result.repoId,
    slug: result.slug,
    remoteId: result.remoteId,
    canonicalUrl: result.canonicalUrl,
    tokenPath: (result.token || fs.existsSync(tokenPath)) ? tokenPath : null,
    tokenReuse: result.tokenReuse,
    issuedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(outDir, 'bootstrap-admin.json'), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ ok: true, ...summary, tokenWritten: Boolean(result.token) }, null, 2)}\n`)
  if (!remoteUrl) {
    process.stderr.write(`warning: no git remote registered. Set AWP_GIT_REMOTE_URL or configure the ${DEFAULT_REPO} workspace.\n`)
  }
} finally {
  if (DB_DIALECT === 'postgres') await database.close()
}
