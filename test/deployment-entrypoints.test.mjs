import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (file) => readFileSync(join(root, file), 'utf8')

describe('portable deployment entrypoints', () => {
  it('keeps all four Windows commands and role-specific PowerShell targets', () => {
    const targets = {
      'deploy.cmd': 'scripts\\fresh-deploy.ps1',
      'start.cmd': 'scripts\\preflight.ps1',
      'start-primary.cmd': 'scripts\\start-platform.ps1',
      'start-standby.cmd': 'scripts\\start-node.ps1',
    }
    for (const [file, target] of Object.entries(targets)) {
      expect(existsSync(join(root, file)), file).toBe(true)
      expect(read(file).toLowerCase()).toContain(target.toLowerCase())
    }
    expect(read('start-standby.cmd')).toContain('-Profile standby')
    expect(read('start.cmd')).toContain('-Profile standalone')
  })

  it('propagates elevated process exit codes and checks startup failures', () => {
    for (const file of ['deploy.cmd', 'start-primary.cmd']) {
      const source = read(file)
      expect(source).toContain('-Wait -PassThru')
      expect(source).toContain('$child.ExitCode')
      expect(source).toMatch(/exit \/b %\w+_EXIT_CODE%/)
    }
    for (const file of ['start.cmd', 'start-primary.cmd', 'start-standby.cmd']) {
      expect(read(file)).toMatch(/set "\w+_EXIT_CODE=%ERRORLEVEL%"/)
    }
  })

  it('uses one ignored deployment environment file and role-specific preflight', () => {
    const packageJson = JSON.parse(read('package.json'))
    expect(packageJson.scripts.start).toContain('--import=./scripts/load-deployment-env.mjs')
    expect(packageJson.scripts['db:init']).toContain('--import=./scripts/load-deployment-env.mjs')
    expect(existsSync(join(root, 'data/deploy.env.example'))).toBe(true)
    expect(existsSync(join(root, 'scripts/deploy.env.example'))).toBe(false)
    const preflight = read('scripts/preflight.ps1')
    for (const profile of ['deploy', 'standalone', 'primary', 'standby']) {
      expect(preflight).toContain(`'${profile}'`)
    }
    expect(preflight).toContain('data\\deploy.env')
    expect(preflight).toContain('data\\node.env')
    expect(read('scripts/Deploy.Common.ps1')).toContain('Migrated scripts\\deploy.env to data\\deploy.env')
    expect(read('scripts/deploy-test-platform.ps1')).toContain("$env:AWP_CONTROL_PORT")
    expect(read('scripts/deploy-test-platform.ps1')).toContain("$env:AWP_BROKER_PORT")
    expect(read('scripts/fresh-deploy.ps1')).toContain('$env:AWP_GIT_REMOTE_URL')
  })

  it('allows a standby to resolve its blob endpoint from the dashboard primary link', () => {
    const preflight = read('scripts/preflight.ps1')
    const startNode = read('scripts/start-node.ps1')
    expect(preflight).toContain('blob URL will resolve from the shared database primary link')
    expect(startNode).toContain('standby will resolve the primary link from the shared database')
    expect(startNode).toContain('AWP_BLOB_BASE_URL or the dashboard primary link')
    expect(preflight).not.toContain('Set AWP_BLOB_BASE_URL in data\\node.env')
    expect(startNode).not.toContain('Set AWP_BLOB_BASE_URL in data\\node.env')
  })

  it('restarts the configured DevWeft PM2 process for the active node role', () => {
    const server = read('server.js')
    const ecosystem = read('ecosystem.config.cjs')
    expect(ecosystem).toContain("name: 'devweft'")
    expect(server).toContain("nodeRole === 'standby' ? 'devweft-standby' : 'devweft'")
    expect(server).toContain('pm2 restart ${pm2ProcessName}')
  })
})
