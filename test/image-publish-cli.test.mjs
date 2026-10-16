import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSbomDocument } from '../runner/image/sbom.mjs'

const root = process.cwd()
const temporaryDirs = []

function temporaryDirectory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devweft-image-cli-'))
  temporaryDirs.push(dir)
  return dir
}

function run(script, args, env) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, AWP_DB_DIALECT: 'sqlite', ...env },
  })
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runner image publishing CLI', () => {
  it('publishes a signed VHDX manifest and verifies it against an isolated database', () => {
    const dir = temporaryDirectory()
    const imageId = 'example-windows-node22-v1'
    const vhdxPath = path.join(dir, 'golden.vhdx')
    const sbomPath = path.join(dir, 'sbom.json')
    const env = {
      AWP_DB_PATH: path.join(dir, 'team.db'),
      AWP_SIGNING_KEY_DIR: path.join(dir, 'signing-keys'),
    }
    fs.writeFileSync(vhdxPath, 'test-vhdx-bytes')
    fs.writeFileSync(sbomPath, JSON.stringify(buildSbomDocument({
      imageId,
      generatedAt: '2026-10-15T00:00:00.000Z',
      components: [{ name: 'node', version: '22.12.0', source: 'nodejs.org' }],
    })))

    const publish = run('image-publish.mjs', [
      'publish', '--image-id', imageId, '--vhdx', vhdxPath, '--sbom', sbomPath, '--mode', 'active',
    ], env)
    expect(publish.status, publish.stderr).toBe(0)
    expect(publish.stdout).toContain(`published ${imageId} state=active`)

    const verify = run('verify-runner-image.mjs', ['--vhdx', vhdxPath], env)
    expect(verify.status, verify.stderr).toBe(0)
    const statusLine = verify.stdout.split(/\r?\n/).find((line) => line.startsWith('{"ok":'))
    expect(statusLine).toBeTruthy()
    expect(JSON.parse(statusLine)).toMatchObject({ ok: true, imageId })

    fs.writeFileSync(vhdxPath, 'changed-vhdx-bytes')
    const mismatch = run('verify-runner-image.mjs', ['--vhdx', vhdxPath], env)
    expect(mismatch.status).toBe(1)
    expect(mismatch.stderr).toContain('RUNNER_IMAGE_MISMATCH')
  })

  it('refuses publication without an SBOM', () => {
    const result = run('image-publish.mjs', ['publish', '--image-id', 'example-v1', '--vhdx', 'missing.vhdx'], {
      AWP_DB_PATH: path.join(temporaryDirectory(), 'team.db'),
      AWP_SIGNING_KEY_DIR: path.join(temporaryDirs.at(-1), 'signing-keys'),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Missing --sbom')
  })

  it('rejects SBOMs that do not identify a real image component set', () => {
    const dir = temporaryDirectory()
    const imageId = 'invalid-empty-sbom-v1'
    const vhdxPath = path.join(dir, 'golden.vhdx')
    const sbomPath = path.join(dir, 'sbom.json')
    fs.writeFileSync(vhdxPath, 'test-vhdx-bytes')
    fs.writeFileSync(sbomPath, JSON.stringify({
      schemaVersion: 1,
      imageId,
      generatedAt: '2026-10-15T00:00:00.000Z',
      components: [],
    }))

    const result = run('image-publish.mjs', [
      'publish', '--image-id', imageId, '--vhdx', vhdxPath, '--sbom', sbomPath,
    ], {
      AWP_DB_PATH: path.join(dir, 'team.db'),
      AWP_SIGNING_KEY_DIR: path.join(dir, 'signing-keys'),
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('SBOM must use schemaVersion 1')
  })
})
