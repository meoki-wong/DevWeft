import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProjectConfig } from '../testing/project-config.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'devweft.js')

function makeRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), 'devweft-template-'))
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'template-fixture' }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  return realpathSync(repo)
}

function command(...args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
}

describe('project config JSON Schema and test templates', () => {
  it('validates command vectors and rejects shell-script strings', () => {
    const valid = validateProjectConfig({
      schemaVersion: 1,
      checks: [{ id: 'unit', name: 'unit', command: ['node', '--test'], timeoutSeconds: 120 }],
    })
    expect(valid).toMatchObject({ valid: true, errors: [] })

    const invalid = validateProjectConfig({ checks: [{ name: 'unsafe', script: 'npm test' }] })
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.length).toBeGreaterThan(0)
  })

  it('rejects duplicate check IDs and invalid timeout bounds', () => {
    const invalid = validateProjectConfig({ checks: [
      { id: 'unit', name: 'first', command: ['node', '--test'], timeoutSeconds: 601 },
      { id: 'unit', name: 'second', command: ['node', '--test'] },
    ] })
    expect(invalid.valid).toBe(false)
    expect(invalid.errors.some((error) => error.keyword === 'unique')).toBe(true)
    expect(invalid.errors.some((error) => error.keyword === 'maximum')).toBe(true)
  })

  it('templates default to dry-run, apply atomically, compose, and remain idempotent', () => {
    const repo = makeRepo()
    const config = path.join(repo, '.awp', 'config.json')
    const preview = command('project', 'template', 'node-unit', repo)
    expect(preview.status, preview.stderr).toBe(0)
    expect(JSON.parse(preview.stdout)).toMatchObject({ mode: 'dry-run', additions: ['node-unit'], written: false, uploads: 0 })
    expect(existsSync(config)).toBe(false)

    const applied = command('project', 'template', 'node-unit', repo, '--apply')
    expect(applied.status, applied.stderr).toBe(0)
    expect(JSON.parse(applied.stdout)).toMatchObject({ mode: 'apply', changed: true, written: true })
    expect(validateProjectConfig(JSON.parse(readFileSync(config, 'utf8'))).valid).toBe(true)

    const added = command('project', 'template', 'http-api', repo, '--apply')
    expect(added.status, added.stderr).toBe(0)
    expect(JSON.parse(readFileSync(config, 'utf8')).checks.map((check) => check.id)).toEqual(['node-unit', 'http-api'])

    const repeated = command('project', 'template', 'node-unit', repo, '--apply')
    expect(repeated.status, repeated.stderr).toBe(0)
    expect(JSON.parse(repeated.stdout)).toMatchObject({ changed: false, additions: [], written: false })
  })

  it('validates a repository config and reports schema errors with a nonzero exit code', () => {
    const repo = makeRepo()
    const config = path.join(repo, '.awp', 'config.json')
    const valid = command('project', 'template', 'playwright-web', repo, '--apply')
    expect(valid.status, valid.stderr).toBe(0)
    const checked = command('project', 'validate', repo)
    expect(checked.status, checked.stderr).toBe(0)
    expect(JSON.parse(checked.stdout)).toMatchObject({ valid: true, configPath: config })

    writeFileSync(config, JSON.stringify({ schemaVersion: 1, checks: [{ id: 'bad', name: 'bad', command: 'node --test' }] }))
    const rejected = command('project', 'validate', repo)
    expect(rejected.status).toBe(1)
    expect(JSON.parse(rejected.stdout).valid).toBe(false)
  })

  it('does not overwrite a different check with the same ID or accept unknown templates', () => {
    const repo = makeRepo()
    const config = path.join(repo, '.awp', 'config.json')
    mkdirSync(path.dirname(config), { recursive: true })
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, checks: [{
      id: 'node-unit', name: 'custom unit', command: ['node', 'custom-test.js'],
    }] }))
    const before = readFileSync(config, 'utf8')
    expect(command('project', 'template', 'node-unit', repo, '--apply').status).not.toBe(0)
    expect(readFileSync(config, 'utf8')).toBe(before)
    expect(command('project', 'template', 'unknown', repo, '--apply').status).not.toBe(0)
  })
})
