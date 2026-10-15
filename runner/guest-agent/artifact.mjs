/**
 * Guest 内 artifact 组装（§12）：先脱敏、限量、压缩，再交给 sidecar 计算摘要。
 * 只收集白名单输出；文本条目命中 secret 模式一律替换为 [REDACTED]。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZip } from './zip.mjs'

export const ARCHIVE_MAX_BYTES = 500 * 1024 * 1024
export const FILE_MAX_BYTES = 10 * 1024 * 1024

const TEXT_EXT = /\.(xml|json|log|txt|md)$/i
const OUTPUT_SUBDIRS = ['logs', 'traces', 'screenshots', 'videos']

const REDACT_PATTERNS = [
  [/npm_[0-9a-zA-Z]{20,}/g, 'npm_[REDACTED]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED-JWT]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, '$1 [REDACTED]'],
  [/((?:password|passwd|secret|token|api[-_]?key|authToken|_authToken|authorization)["'\s:=]+)[^\s"',;)}\]]{4,}/gi, '$1[REDACTED]'],
]

export function redactText(text) {
  let out = String(text)
  for (const [pattern, replacement] of REDACT_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]))
}

export function buildJunitXml(checks) {
  const cases = (checks || []).map((c) => {
    const attrs = `name="${xmlEscape(c.caseKey)}" classname="awp.project" time="${(Number(c.durationMs) || 0) / 1000}"`
    return c.status === 'passed'
      ? `    <testcase ${attrs}/>`
      : `    <testcase ${attrs}><failure message="${xmlEscape(c.status)}"/></testcase>`
  }).join('\n')
  const total = (checks || []).length
  const failed = (checks || []).filter((c) => c.status !== 'passed').length
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${total}" failures="${failed}">`,
    '  <testsuite name="awp-project" tests="' + total + '" failures="' + failed + '">',
    cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].filter((s) => s !== '').join('\n')
}

function sha256buf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function truncateTail(buf, max) {
  const marker = Buffer.from('\n[awp: file truncated to last bytes]\n', 'utf8')
  const keep = max - marker.length
  return Buffer.concat([marker, buf.subarray(Math.max(0, buf.length - Math.max(0, keep)))])
}

function listFilesRecursive(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) listFilesRecursive(p, acc)
    else acc.push(p)
  }
  return acc
}

export function buildArtifact({
  runDir,
  checks,
  fileMaxBytes = FILE_MAX_BYTES,
  archiveMaxBytes = ARCHIVE_MAX_BYTES,
}) {
  const outputDir = join(runDir, 'output')
  const entries = []
  let artifactTruncated = false

  function push(name, buf, { isText = false } = {}) {
    let data = buf
    if (isText && TEXT_EXT.test(name)) data = Buffer.from(redactText(data.toString('utf8')), 'utf8')
    if (data.length > fileMaxBytes) {
      if (isText) {
        data = truncateTail(data, fileMaxBytes)
        artifactTruncated = true
      } else {
        artifactTruncated = true
        return
      }
    }
    entries.push({ name, data })
  }

  push('junit.xml', Buffer.from(buildJunitXml(checks), 'utf8'))
  push('resource-usage.json', Buffer.from(JSON.stringify({
    memoryRssBytes: process.memoryUsage().rss,
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    platform: process.platform,
  }), 'utf8'))
  const installLog = join(outputDir, 'install.log')
  if (existsSync(installLog)) push('install.log', readFileSync(installLog), { isText: true })
  for (const sub of OUTPUT_SUBDIRS) {
    const base = join(outputDir, sub)
    for (const p of listFilesRecursive(base)) {
      const rel = `${sub}/${p.slice(base.length + 1).replace(/\\/g, '/')}`
      push(rel, readFileSync(p), { isText: TEXT_EXT.test(rel) })
    }
  }

  const files = []
  let totalSize = 0
  const kept = []
  for (const e of entries) {
    if (totalSize + e.data.length > archiveMaxBytes) {
      artifactTruncated = true
      continue
    }
    totalSize += e.data.length
    files.push({ path: e.name, sha256: sha256buf(e.data), size: e.data.length })
    kept.push(e)
  }
  const archive = createZip(kept)
  return { archive, files, totalSize, artifactTruncated }
}
