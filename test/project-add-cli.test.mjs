import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'bin', 'devweft.js')

function makeRepo(packageName = '@team/example-service') {
  const repo = mkdtempSync(path.join(tmpdir(), 'devweft-project-add-'))
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: packageName, scripts: { test: 'node --test' } }, null, 2))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'DevWeft Test'], { cwd: repo })
  return realpathSync(repo)
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' })
}

describe('devweft project add', () => {
  it('keeps generated workspace profiles out of source control', () => {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', 'data/repo-platform.json'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(ignored).toBe('data/repo-platform.json')
  })

  it('keeps generated public example build output out of source control', () => {
    const ignored = execFileSync('git', ['check-ignore', '--no-index', 'examples/example-app/dist/web/index.html'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(ignored).toBe('examples/example-app/dist/web/index.html')
  })

  it('defaults to dry-run, identifies a local repo and writes nothing', () => {
    const repo = makeRepo()
    const config = path.join(mkdtempSync(path.join(tmpdir(), 'devweft-config-')), 'repo-platform.json')
    const result = runCli(['project', 'add', repo, '--config', config])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'dry-run',
      slug: 'example-service',
      changed: true,
      written: false,
      uploads: 0,
      profile: {
        workspaceEnv: 'AWP_REPO_PATH_EXAMPLE_SERVICE',
        workspacePath: repo,
        defaultSides: [],
        enabled: true,
      },
    })
    expect(existsSync(config)).toBe(false)
  })

  it('applies atomically and repeated apply is idempotent', () => {
    const repo = makeRepo('example-service')
    const config = path.join(mkdtempSync(path.join(tmpdir(), 'devweft-config-')), 'repo-platform.json')
    const first = runCli(['project', 'add', '--path', repo, '--config', config, '--apply'])
    expect(first.status, first.stderr).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ mode: 'apply', changed: true, written: true })
    const firstText = readFileSync(config, 'utf8')
    const second = runCli(['project', 'add', '--path', repo, '--config', config, '--apply'])
    expect(second.status, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ changed: false, written: false })
    expect(readFileSync(config, 'utf8')).toBe(firstText)
    expect(JSON.parse(firstText).repos['example-service'].workspacePath).toBe(repo)
  })

  it('updates only the discovered workspace fields and preserves manual suite settings', () => {
    const repo = makeRepo('example-service')
    const config = path.join(mkdtempSync(path.join(tmpdir(), 'devweft-config-')), 'repo-platform.json')
    writeFileSync(config, JSON.stringify({
      repos: {
        'another-project': { workspacePath: '/elsewhere' },
        'example-service': {
          workspacePath: '/old/path',
          smoke: { web: { build: ['build:web'] } },
          suiteSlug: 'approved-suite',
          enabled: false,
          defaultSides: ['web'],
        },
      },
    }, null, 2) + '\n')
    const result = runCli(['project', 'add', repo, '--config', config, '--apply'])
    expect(result.status, result.stderr).toBe(0)
    const saved = JSON.parse(readFileSync(config, 'utf8'))
    expect(saved.repos['another-project']).toEqual({ workspacePath: '/elsewhere' })
    expect(saved.repos['example-service']).toMatchObject({
      workspacePath: repo,
      smoke: { web: { build: ['build:web'] } },
      suiteSlug: 'approved-suite',
      enabled: false,
      defaultSides: ['web'],
    })
  })

  it('rejects non-repositories, invalid slugs and malformed config without changing files', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'devweft-not-repo-'))
    const config = path.join(mkdtempSync(path.join(tmpdir(), 'devweft-config-')), 'bad.json')
    writeFileSync(config, '{bad')
    expect(runCli(['project', 'add', empty, '--config', config]).status).not.toBe(0)
    const repo = makeRepo()
    expect(runCli(['project', 'add', repo, '--slug', 'Bad Slug', '--config', config]).status).not.toBe(0)
    expect(runCli(['project', 'add', repo, '--config', config, '--apply']).status).not.toBe(0)
    expect(readFileSync(config, 'utf8')).toBe('{bad')
  })

  it('supports help without reading a repository or making changes', () => {
    const result = runCli(['project', 'add', '--help'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('default to dry-run')
  })
})
