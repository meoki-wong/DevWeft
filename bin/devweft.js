#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { validateProjectConfig } from '../testing/project-config.js'

const platformRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultConfig = path.join(platformRoot, 'data', 'repo-platform.json')

function parseArgs(argv) {
  if (argv[0] !== 'project' || argv[1] !== 'add') {
    throw new Error('Usage: devweft project add [repository-path] [--slug <slug>] [--config <path>] [--apply|--dry-run]')
  }
  const options = { apply: false, path: null, slug: null, config: null }
  const positional = []
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (['--path', '--slug', '--config'].includes(arg)) {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--path') options.path = value
      if (arg === '--slug') options.slug = value
      if (arg === '--config') options.config = value
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else positional.push(arg)
  }
  if (positional.length > 1 || (positional.length && options.path)) {
    throw new Error('Provide the repository path once, either positionally or with --path')
  }
  if (positional.length) options.path = positional[0]
  return options
}

function readProject(repositoryPath) {
  const requestedPath = path.resolve(repositoryPath || process.cwd())
  let stat
  try { stat = statSync(requestedPath) } catch {
    throw new Error(`Repository path does not exist: ${requestedPath}`)
  }
  if (!stat.isDirectory()) throw new Error(`Repository path is not a directory: ${requestedPath}`)

  let root
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: requestedPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw new Error(`Not inside a Git worktree: ${requestedPath}`)
  }

  const packagePath = path.join(root, 'package.json')
  let packageJson = null
  if (existsSync(packagePath)) {
    try { packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) } catch (error) {
      throw new Error(`Invalid package.json in repository root: ${error.message}`)
    }
  }
  return {
    root: path.resolve(root),
    packageName: typeof packageJson?.name === 'string' ? packageJson.name : null,
  }
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}

function chooseSlug(project, override) {
  const source = override || project.packageName?.split('/').at(-1) || path.basename(project.root)
  const slug = slugify(source)
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) {
    throw new Error('Could not derive a valid project slug; pass --slug with lowercase letters, digits, and hyphens.')
  }
  if (override && slug !== override) throw new Error('--slug must already be lowercase and use only letters, digits, and hyphens.')
  return slug
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return { document: { repos: {} }, repos: null }
  let document
  try { document = JSON.parse(readFileSync(configPath, 'utf8')) } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`)
  }
  const repos = document?.repos && typeof document.repos === 'object' && !Array.isArray(document.repos)
    ? document.repos
    : document
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) {
    throw new Error(`Config must be an object or contain a "repos" object: ${configPath}`)
  }
  return { document, repos }
}

function writeAtomic(filePath, content) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  let fd
  try {
    fd = openSync(tempPath, 'wx', 0o600)
    writeFileSync(fd, content, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, filePath)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(tempPath, { force: true })
    throw new Error(`Could not atomically update ${filePath}: ${error.message}`)
  }
}

function parseProjectCommandArgs(argv, { needsTemplate = false } = {}) {
  const positional = []
  const options = { apply: false, config: null }
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') options.apply = true
    else if (arg === '--dry-run') options.apply = false
    else if (arg === '--config') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--config requires a path')
      options.config = value
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    } else positional.push(arg)
  }
  const expected = needsTemplate ? [1, 2] : [0, 1]
  if (positional.length < expected[0] || positional.length > expected[1]) {
    throw new Error(needsTemplate
      ? 'Usage: devweft project template <node-unit|playwright-web|http-api> [repository-path] [--config <path>] [--apply|--dry-run]'
      : 'Usage: devweft project validate [repository-path] [--config <path>]')
  }
  if (needsTemplate) options.template = positional[0]
  options.path = needsTemplate ? positional[1] : positional[0]
  return options
}

function projectConfigPath(project, configuredPath) {
  if (configuredPath) return path.resolve(project.root, configuredPath)
  const rootConfig = path.join(project.root, 'awp.config.json')
  if (existsSync(rootConfig)) return rootConfig
  return path.join(project.root, '.awp', 'config.json')
}

function readProjectConfig(configPath) {
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${error.message}`)
  }
}

function runProjectValidate(argv) {
  const options = parseProjectCommandArgs(argv)
  const project = readProject(options.path)
  const configPath = projectConfigPath(project, options.config)
  const config = readProjectConfig(configPath)
  if (!config) throw new Error(`No project config found at ${configPath}; add one with "devweft project template <name> --apply"`)
  const result = validateProjectConfig(config)
  process.stdout.write(`${JSON.stringify({ valid: result.valid, repository: project.root, configPath, errors: result.errors }, null, 2)}\n`)
  if (!result.valid) process.exitCode = 1
}

function runProjectTemplate(argv) {
  const options = parseProjectCommandArgs(argv, { needsTemplate: true })
  const project = readProject(options.path)
  const templatePath = path.join(platformRoot, 'templates', `${options.template}.json`)
  if (!['node-unit', 'playwright-web', 'http-api'].includes(options.template) || !existsSync(templatePath)) {
    throw new Error(`Unknown project template "${options.template}"; choose node-unit, playwright-web, or http-api`)
  }
  const template = JSON.parse(readFileSync(templatePath, 'utf8'))
  const templateValidation = validateProjectConfig(template)
  if (!templateValidation.valid) throw new Error(`Bundled template is invalid: ${JSON.stringify(templateValidation.errors)}`)

  const configPath = projectConfigPath(project, options.config)
  const current = readProjectConfig(configPath) || { schemaVersion: 1, checks: [] }
  const next = structuredClone(current)
  if (!next.$schema) next.$schema = template.$schema
  if (next.schemaVersion === undefined) next.schemaVersion = 1
  if (!Array.isArray(next.checks)) next.checks = []
  const additions = []
  for (const check of template.checks) {
    const previous = next.checks.find((entry) => entry?.id === check.id)
    if (!previous) {
      next.checks.push(check)
      additions.push(check.id)
    } else if (!isDeepStrictEqual(previous, check)) {
      throw new Error(`Check id "${check.id}" already exists with different settings; edit ${configPath} manually before adding this template`)
    }
  }
  const validation = validateProjectConfig(next)
  if (!validation.valid) {
    throw new Error(`Project config does not match schemas/project-config.schema.json: ${JSON.stringify(validation.errors)}`)
  }
  const output = `${JSON.stringify(next, null, 2)}\n`
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
  const changed = existing !== output
  if (options.apply && changed) writeAtomic(configPath, output)
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    template: options.template,
    repository: project.root,
    configPath,
    additions,
    changed,
    written: Boolean(options.apply && changed),
    uploads: 0,
  }, null, 2)}\n`)
}

function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage:\n  devweft project add [repository-path] [--slug <slug>] [--config <path>] [--apply|--dry-run]\n  devweft project template <node-unit|playwright-web|http-api> [repository-path] [--apply|--dry-run]\n  devweft project validate [repository-path]\n')
    process.stdout.write('Project changes are local. Mutating commands default to dry-run; project checks use argv arrays and do not concatenate shell commands.\n')
    return
  }
  if (argv[0] === 'project' && argv[1] === 'template') return runProjectTemplate(argv)
  if (argv[0] === 'project' && argv[1] === 'validate') return runProjectValidate(argv)
  const options = parseArgs(argv)
  const project = readProject(options.path)
  const slug = chooseSlug(project, options.slug)
  const configPath = options.config
    ? path.resolve(options.config)
    : process.env.AWP_REPO_PLATFORM_CONFIG
      ? path.resolve(platformRoot, process.env.AWP_REPO_PLATFORM_CONFIG)
      : defaultConfig
  const { document, repos: loadedRepos } = readConfig(configPath)
  const wrapped = Object.hasOwn(document, 'repos')
  const repos = loadedRepos || document.repos
  const previous = repos[slug]
  const workspaceEnv = `AWP_REPO_PATH_${slug.replace(/[^a-z0-9]/g, '_').toUpperCase()}`
  const nextProfile = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    workspaceEnv,
    workspacePath: project.root,
    casePrefix: previous?.casePrefix || slug,
    defaultSides: Array.isArray(previous?.defaultSides) ? previous.defaultSides : [],
    enabled: previous?.enabled !== false,
  }
  const nextDocument = structuredClone(document)
  if (wrapped) nextDocument.repos[slug] = nextProfile
  else nextDocument[slug] = nextProfile
  const output = `${JSON.stringify(nextDocument, null, 2)}\n`
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : null
  const changed = current !== output

  if (options.apply && changed) writeAtomic(configPath, output)
  process.stdout.write(`${JSON.stringify({
    mode: options.apply ? 'apply' : 'dry-run',
    repository: { root: project.root, packageName: project.packageName },
    slug,
    configPath,
    changed,
    written: Boolean(options.apply && changed),
    profile: {
      workspaceEnv: nextProfile.workspaceEnv,
      workspacePath: nextProfile.workspacePath,
      casePrefix: nextProfile.casePrefix,
      defaultSides: nextProfile.defaultSides,
      enabled: nextProfile.enabled,
    },
    uploads: 0,
  }, null, 2)}\n`)
}

try {
  run(process.argv.slice(2))
} catch (error) {
  process.stderr.write(`devweft: ${error.message}\n`)
  process.exitCode = 2
}
