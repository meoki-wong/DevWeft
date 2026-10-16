import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadDeploymentEnv } from '../scripts/load-deployment-env.mjs'

const key = 'DEVWEFT_ENV_LOADER_TEST'
const previousValue = process.env[key]
const directories = []

afterEach(() => {
  if (previousValue === undefined) delete process.env[key]
  else process.env[key] = previousValue
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('deployment environment loader', () => {
  it('loads a configured env file and treats a missing file as optional', () => {
    const directory = mkdtempSync(join(tmpdir(), 'devweft-env-'))
    directories.push(directory)
    const file = join(directory, '.env')
    writeFileSync(file, `${key}=loaded\n# comment\n`)

    expect(loadDeploymentEnv(file)).toBe(true)
    expect(process.env[key]).toBe('loaded')
    expect(loadDeploymentEnv(join(directory, 'missing.env'))).toBe(false)
  })
})
