import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

describe('Hyper-V deployment safety contracts', () => {
  it('uses exact adapters and does not remove or rewrite existing host networking', () => {
    const helper = read('scripts/windows/isolated-network.ps1')
    expect(helper).toContain('$_.Name -eq $want')
    expect(helper).toContain('function Get-ExactVMSwitch')
    expect(helper).not.toMatch(/Remove-VMSwitch|Remove-NetIPAddress|Disable-NetAdapterBinding|Remove-NetFirewallRule/)
    expect(helper).toContain('SWITCH_TYPE_CONFLICT')
    expect(helper).toContain('SUBNET_OVERLAP')
    expect(helper).toContain('ROUTE_OVERLAP')
    expect(helper).toContain('FIREWALL_RULE_CONFLICT')
  })

  it('offers an explicit read-only network preflight and fails on incompatible existing resources', () => {
    const ensure = read('scripts/windows/ensure-isolated-network.ps1')
    const preflightBranch = ensure.indexOf('if ($PreflightOnly)')
    const firstNetworkMutation = ensure.indexOf('Ensure-IsolatedSwitch $SwitchName')
    expect(ensure).toContain('[switch]$PreflightOnly')
    expect(preflightBranch).toBeGreaterThan(-1)
    expect(firstNetworkMutation).toBeGreaterThan(preflightBranch)
  })

  it('defaults to control-plane-only and checks image before network setup when opted in', () => {
    const deploy = read('scripts/deploy-test-platform.ps1')
    const ecosystem = read('ecosystem.config.cjs')
    expect(deploy).toContain("else { 'false' }")
    expect(ecosystem).toContain("runnerBackend === 'local'")
    expect(ecosystem).toContain("runnerBackend === 'hyperv'")
    const imageCheck = deploy.indexOf('verify-runner-image.mjs')
    const networkSetup = deploy.lastIndexOf('ensure-isolated-network.ps1')
    expect(imageCheck).toBeGreaterThan(-1)
    expect(networkSetup).toBeGreaterThan(imageCheck)
    expect(deploy).not.toContain('Copy-Item -Force $src $dst')
    expect(deploy).toContain('RUNNER_CERT_CONFLICT')
    expect(deploy).toContain('AWP_HYPERV_ENABLED=$hyperVSetting')
  })

  it('includes the standalone blob service only for PostgreSQL and Hyper-V only when opted in', () => {
    const namesFor = (setting, dialect, backend = 'hyperv') => {
      const result = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./ecosystem.config.cjs').apps.map((app) => app.name)))"], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, AWP_HYPERV_ENABLED: setting, AWP_DB_DIALECT: dialect, AWP_RUNNER_BACKEND: backend },
      })
      expect(result.status, result.stderr).toBe(0)
      return JSON.parse(result.stdout.trim())
    }
    const sqlite = namesFor('false', 'sqlite')
    expect(sqlite).not.toContain('awp-host-worker')
    expect(sqlite).not.toContain('awp-blob-store')
    expect(namesFor('false', 'sqlite', 'local')).toContain('awp-host-worker')
    const postgres = namesFor('true', 'postgres')
    expect(postgres).toContain('awp-blob-store')
    expect(postgres).toContain('awp-host-worker')
  })

  it('repeats image and network checks when starting or restarting the primary worker', () => {
    const start = read('scripts/start-platform.ps1')
    const restart = read('scripts/restart-worker.ps1')
    for (const script of [start, restart]) {
      const imageCheck = script.indexOf('verify-runner-image.mjs')
      const networkCheck = script.indexOf('ensure-isolated-network.ps1')
      expect(imageCheck).toBeGreaterThan(-1)
      expect(networkCheck).toBeGreaterThan(imageCheck)
    }
    expect(start).toContain("$HyperVEnabled = $hyperVSetting -eq 'true'")
    expect(start).toContain("& pm2 delete awp-host-worker")
  })

  it('derives worker directories from AWP_RUNNER_ROOT instead of a machine-specific drive', () => {
    const worker = read('runner/host-worker/worker-service.mjs')
    const lane = read('runner/host-worker/run-static-lane.mjs')
    const hyperv = read('runner/host-worker/hyperv-static-lane.ps1')
    expect(worker).toContain("process.env.AWP_RUNNER_ROOT || join(repoRoot, 'data', 'runner')")
    expect(lane).toContain("process.env.AWP_RUNNER_ROOT || join(repoRoot, 'data', 'runner')")
    expect(hyperv).toContain("Join-Path $RunnerRoot 'dep-cache'")
    expect(`${worker}\n${lane}\n${hyperv}`).not.toContain('C:\\awp-runner')
  })
})
