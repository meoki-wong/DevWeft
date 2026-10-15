import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROFILES,
  getRepoPlatformProfile,
  getSmokeScriptsForSide,
  listSmokeSides,
  resolveRepoWorkspacePath,
  getCasePrefix,
} from '../testing/repo-platform.js'
import { filterCasesForUnit } from '../runner/guest-agent/units.mjs'
import { resolveSmokeScripts } from '../runner/guest-agent/smoke.mjs'

describe('repository profiles', () => {
  it('does not provide project-specific built-in commands', () => {
    expect(BUILTIN_PROFILES).toEqual({})
    expect(getRepoPlatformProfile('unknown-repo', { env: {} })).toBe(null)
    expect(getSmokeScriptsForSide('unknown-repo', 'web', { env: {} })).toBe(null)
    expect(listSmokeSides('unknown-repo', { env: {} })).toEqual([])
  })

  it('does not resolve a workspace for an unknown repository', () => {
    expect(resolveRepoWorkspacePath('unknown-repo', { env: {} })).toBe(null)
  })

  it('uses a neutral case prefix when no profile is configured', () => {
    expect(getCasePrefix('unknown-repo', { env: {} })).toBe('repo')
  })
})

describe('profile-injected smoke commands', () => {
  it('does not fall back to a built-in command set', () => {
    expect(resolveSmokeScripts('web', {})).toBe(null)
  })

  it('uses the configured side and returns null for an unconfigured side', () => {
    const scripts = { web: { build: ['build'], entry: 'index.html', outDir: 'dist' } }
    expect(resolveSmokeScripts('web', { scripts })).toEqual(scripts.web)
    expect(resolveSmokeScripts('api', { scripts })).toBe(null)
  })
})

describe('case filtering', () => {
  it('selects static checks without a repository-specific prefix', () => {
    const cases = [
      { caseKey: 'web:static/eslint' },
      { caseKey: 'api:static/eslint' },
      { caseKey: 'web:smoke/web' },
    ]
    const r = filterCasesForUnit(cases, { unit: 'static' })
    expect(r.map((c) => c.caseKey).sort()).toEqual(['api:static/eslint', 'web:static/eslint'])
  })

  it('selects only the requested smoke side', () => {
    const cases = [
      { caseKey: 'web:smoke/web' },
      { caseKey: 'web:smoke/api' },
      { caseKey: 'api:smoke/web' },
    ]
    const r = filterCasesForUnit(cases, { unit: 'smoke', side: 'web' })
    expect(r.map((c) => c.caseKey).sort()).toEqual(['api:smoke/web', 'web:smoke/web'])
  })
})
