/**
 * Per-repository runner configuration.
 *
 * Profiles live in data/repo-platform.json, which is intentionally ignored by
 * Git. Use data/repo-platform.example.json as a starting point. Paths can be
 * supplied with AWP_REPO_PATH_<SLUG> environment variables.
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CONFIG_PATH = join(REPO_ROOT, 'data', 'repo-platform.json')

export const DEFAULT_REPO = process.env.AWP_DEFAULT_REPO || 'demo-app'
export const BUILTIN_PROFILES = Object.freeze({})

export function slugEnvKey(slug) {
  return `AWP_REPO_PATH_${String(slug || '').replace(/[^\w]/g, '_').toUpperCase()}`
}

function readEnvFile() {
  const file = join(REPO_ROOT, 'data', 'deploy.env')
  if (!existsSync(file)) return {}
  const values = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const text = line.trim()
    if (!text || text.startsWith('#')) continue
    const splitAt = text.indexOf('=')
    if (splitAt > 0) values[text.slice(0, splitAt).trim()] = text.slice(splitAt + 1).trim()
  }
  return values
}

/** Merge optional local deploy settings without adding project-specific names. */
export function withDeployWorkspaceEnv(env = process.env) {
  return { ...readEnvFile(), ...env }
}

function normalizeProfile(slug, cfg) {
  if (!slug || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
  const smoke = cfg.smoke && typeof cfg.smoke === 'object' && !Array.isArray(cfg.smoke)
    ? cfg.smoke
    : null
  return {
    slug,
    workspaceEnv: cfg.workspaceEnv || slugEnvKey(slug),
    workspacePath: typeof cfg.workspacePath === 'string' ? cfg.workspacePath : null,
    workspaceCandidates: Array.isArray(cfg.workspaceCandidates) ? cfg.workspaceCandidates : [],
    smoke,
    impact: cfg.impact && typeof cfg.impact === 'object' && !Array.isArray(cfg.impact) ? cfg.impact : null,
    defaultSides: Array.isArray(cfg.defaultSides) ? cfg.defaultSides : Object.keys(smoke || {}),
    casePrefix: cfg.casePrefix || slug.split('-')[0] || 'repo',
    suiteSlug: cfg.suiteSlug || null,
    gateMode: cfg.gateMode || 'observe',
    enabled: cfg.enabled !== false,
    note: cfg.note || null,
  }
}

function loadFileProfiles() {
  if (!existsSync(CONFIG_PATH)) return {}
  let raw
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`Invalid JSON in ${CONFIG_PATH}: ${error.message}`)
  }
  const repos = raw?.repos && typeof raw.repos === 'object' ? raw.repos : raw
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) {
    throw new Error(`${CONFIG_PATH} must contain an object or a {"repos": {...}} object`)
  }
  return Object.fromEntries(
    Object.entries(repos)
      .map(([slug, cfg]) => [slug, normalizeProfile(slug, cfg)])
      .filter(([, profile]) => profile)
  )
}

export function getRepoPlatformProfile(slug, { env = process.env } = {}) {
  const key = String(slug || '').trim()
  if (!key) return null
  const configured = loadFileProfiles()[key]
  if (configured) return configured
  const workspaceEnv = slugEnvKey(key)
  if (env[workspaceEnv]) {
    return normalizeProfile(key, { workspaceEnv, workspacePath: env[workspaceEnv] })
  }
  return null
}

function absolutePath(path, baseDir) {
  if (!path) return null
  return isAbsolute(path) ? path : resolve(baseDir, path)
}

export function resolveRepoWorkspacePath(slug, {
  env = process.env,
  repoRoot = REPO_ROOT,
  loadDeployEnv = true,
} = {}) {
  const envMerged = loadDeployEnv ? withDeployWorkspaceEnv(env) : env
  const profile = getRepoPlatformProfile(slug, { env: envMerged })
  if (!profile || !profile.enabled) return null

  const candidates = [
    absolutePath(profile.workspacePath, repoRoot),
    absolutePath(envMerged[profile.workspaceEnv], repoRoot),
    ...profile.workspaceCandidates.map((path) => absolutePath(path, repoRoot)),
    repoRoot ? join(repoRoot, '..', slug) : null,
  ].filter(Boolean)

  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
    || candidates.find((candidate) => existsSync(candidate))
    || null
}

export function getSmokeScriptsForSide(slug, side, { env = process.env } = {}) {
  const script = getRepoPlatformProfile(slug, { env })?.smoke?.[side]
  return script && typeof script === 'object' ? { ...script, side } : null
}

export function listSmokeSides(slug, { env = process.env } = {}) {
  const profile = getRepoPlatformProfile(slug, { env })
  return profile?.smoke ? Object.keys(profile.smoke) : []
}

export function getCasePrefix(slug, { env = process.env } = {}) {
  return getRepoPlatformProfile(slug, { env })?.casePrefix || 'repo'
}

export function listPlatformRepos(env = process.env) {
  const slugs = new Set(Object.keys(loadFileProfiles()))
  for (const key of Object.keys(env)) {
    if (key.startsWith('AWP_REPO_PATH_') && env[key]) slugs.add(`(env:${key})`)
  }
  return [...slugs]
}

export function examplePlatformConfig() {
  return {
    repos: {
      'demo-app': {
        workspaceEnv: 'AWP_REPO_PATH_DEMO_APP',
        casePrefix: 'demo-app',
        suiteSlug: 'demo-app',
        defaultSides: [],
        smoke: {},
        enabled: true,
      },
    },
  }
}
