#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { containsCredentialLikeValue, containsRetiredBrand, isPipelineConfigurationPath } from './public-residue.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const errors = []
const notes = []
const report = (label, message) => console.log(`[${label}] ${message}`)

function gitFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr || result.error}`)
  return [...new Set(result.stdout.split('\0').filter(Boolean))]
}

function check(condition, message) {
  if (!condition) errors.push(message)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
}

function readTextFile(file) {
  const fullPath = path.join(root, file)
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size > 2 * 1024 * 1024) return null
  const bytes = fs.readFileSync(fullPath)
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

function runNode(args, label) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const passed = result.status === 0
  check(passed, `${label} exited with ${result.status ?? result.signal ?? 'unknown status'}`)
  return passed
}

function runNpm(args, label) {
  if (process.env.npm_execpath) {
    runNode([process.env.npm_execpath, ...args], label)
    return
  }
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  const passed = result.status === 0
  check(passed, `${label} exited with ${result.status ?? result.signal ?? 'unknown status'}`)
  return passed
}

const files = gitFiles()
report('files', `${files.length} tracked or non-ignored project files`)

// Reject names and content tied to the former private brand or an internal pipeline.
const presentFiles = files.filter((file) => fs.existsSync(path.join(root, file)))
for (const file of presentFiles) {
  check(!isPipelineConfigurationPath(file), `pipeline configuration is present: ${file}`)
  check(!containsRetiredBrand(file), `retired brand reference found in path: ${file}`)
  const content = readTextFile(file)
  if (content === null) continue
  check(!containsRetiredBrand(content), `retired brand reference found in ${file}`)
  check(!containsCredentialLikeValue(content), `credential-like value found in ${file}`)
}
check(!fs.existsSync(path.join(root, 'testing/mr-client.js')), 'obsolete MR client adapter is present')
for (const file of presentFiles.filter((name) => name.startsWith('contracts/'))) {
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
  const parsed = parseYaml(fs.readFileSync(path.join(root, file), 'utf8'))
  check(parsed && typeof parsed === 'object', `invalid YAML contract: ${file}`)
}
report('public-residue', 'brand, credential, CI pipeline, and retired MR adapter checks finished')

// Validate every committed/public JSON document, the OpenAPI contract, deployment entrypoints,
// and the dependency manifest against its lockfile.
let jsonCount = 0
for (const file of presentFiles.filter((name) => name.endsWith('.json'))) {
  try {
    readJson(file)
    jsonCount += 1
  } catch (error) {
    errors.push(`invalid JSON in ${file}: ${error.message}`)
  }
}
const openapi = parseYaml(fs.readFileSync(path.join(root, 'contracts/testing-openapi.yaml'), 'utf8'))
check(typeof openapi.openapi === 'string' && openapi.paths && openapi.components?.schemas,
  'OpenAPI document is missing version, paths, or component schemas')

const packageJson = readJson('package.json')
const lock = readJson('package-lock.json')
const lockedRoot = lock.packages?.['']
check(lock.lockfileVersion >= 2, 'package-lock.json must use a supported lockfile version')
check(JSON.stringify(packageJson.dependencies || {}) === JSON.stringify(lockedRoot?.dependencies || {}),
  'package.json runtime dependencies differ from package-lock.json')
check(JSON.stringify(packageJson.devDependencies || {}) === JSON.stringify(lockedRoot?.devDependencies || {}),
  'package.json development dependencies differ from package-lock.json')
check(packageJson.engines?.node === lockedRoot?.engines?.node, 'Node engine range differs from package-lock.json')
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const supportedNode = (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor === 24 || nodeMajor >= 26
check(supportedNode, 'release verification requires Node.js 22.12+, 24+, or 26+')

const entrypoints = ['deploy.cmd', 'start.cmd', 'start-primary.cmd', 'start-standby.cmd']
for (const file of entrypoints) {
  check(fs.existsSync(path.join(root, file)) && fs.statSync(path.join(root, file)).size > 0,
    `required Windows entrypoint is missing or empty: ${file}`)
}
readJson('data/repo-platform.example.json')
readJson('templates/mcp.json')
report('config-contracts', `${jsonCount} JSON files, OpenAPI YAML, lockfile, and deployment entrypoints validated`)

// npm ls works from the local lock/install and does not contact the registry.
runNpm(['ls', '--omit=dev', '--depth=0'], 'runtime dependency tree check')
report('dependencies', 'runtime dependency tree is consistent with the local install')

if (process.argv.includes('--audit')) {
  runNpm(['audit', '--audit-level=high'], 'full npm dependency audit')
} else {
  notes.push('network audit skipped; rerun with --audit before publishing')
}

// PGlite setup has a 60-second correctness timeout. Bound file workers so a host that
// reports a very large CPU count does not initialize several embedded PostgreSQL
// clusters at once and turn a healthy release check into resource-contention timeouts.
const testsPassed = runNode([
  path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=dot', '--maxWorkers=4',
], 'full test suite')
report('tests', testsPassed ? 'full Vitest suite passed' : 'full Vitest suite failed')

for (const note of notes) report('note', note)
if (errors.length) {
  for (const error of errors) report('fail', error)
  process.exitCode = 1
} else {
  report('result', 'release verification passed')
}
