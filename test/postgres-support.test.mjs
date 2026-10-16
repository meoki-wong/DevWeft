import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import {
  assertSupportedPostgresVersion,
  checkPostgresDeployment,
  makePostgresCliConnection,
  resolvePostgresTool,
  sanitizePostgresError,
} from '../scripts/postgres-support.mjs'

const temporaryRoots = []
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('PostgreSQL deployment support', () => {
  it('requires PostgreSQL 15 or newer and parses server_version_num', () => {
    expect(assertSupportedPostgresVersion('150000')).toEqual({ major: 15, serverVersionNum: 150000 })
    expect(assertSupportedPostgresVersion('180006').major).toBe(18)
    expect(() => assertSupportedPostgresVersion('140024')).toThrow(/below the supported minimum \(15\+\)/)
    expect(() => assertSupportedPostgresVersion('unknown')).toThrow(/invalid server_version_num/)
  })

  it('rejects an old server before querying schema or migration state', async () => {
    const client = { query: async () => ({ rows: [{ server_version_num: '140000' }] }) }
    await expect(checkPostgresDeployment(client)).rejects.toThrow(/PostgreSQL 14 is below/)
  })

  it('supports connection-only checks without touching schema state', async () => {
    const calls = []
    const client = { query: async (sql) => { calls.push(sql); return { rows: [{ server_version_num: '160003' }] } } }
    await expect(checkPostgresDeployment(client, { connectionOnly: true })).resolves.toEqual({
      major: 16,
      serverVersionNum: 160003,
    })
    expect(calls).toEqual(['SHOW server_version_num'])
  })

  it('checks the public PostgreSQL baseline, runtime roles, and RLS on PGlite', async () => {
    const db = await PGlite.create({ extensions: { pg_trgm } })
    try {
      await db.exec(fs.readFileSync(new URL('../sql/postgres/baseline.sql', import.meta.url), 'utf8'))
      await db.exec(fs.readFileSync(new URL('../sql/postgres/rls.sql', import.meta.url), 'utf8'))
      const preMigration = await checkPostgresDeployment(db, { schemaOnly: true })
      expect(preMigration.major).toBeGreaterThanOrEqual(15)
      await db.query("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (1, 'postgres_baseline', 'test-checksum', 'test')")
      const result = await checkPostgresDeployment(db)
      expect(result.major).toBeGreaterThanOrEqual(15)
      await db.exec('ALTER ROLE awp_tenant LOGIN')
      await expect(checkPostgresDeployment(db)).rejects.toThrow(/must be NOLOGIN, NOSUPERUSER, and NOBYPASSRLS/)
    } finally {
      await db.close()
    }
  })

  it('moves URL credentials into the environment before invoking libpq tools', () => {
    const result = makePostgresCliConnection('postgresql://dbuser:p%40ssword@db.example:5432/app?sslmode=require', { PATH: '/bin' })
    expect(result.connectionString).toContain('dbuser@db.example')
    expect(result.connectionString).not.toContain('p%40ssword')
    expect(result.env.PGPASSWORD).toBe('p@ssword')
    expect(result.env.PATH).toBe('/bin')
  })

  it('redacts URL credentials from diagnostics', () => {
    const message = sanitizePostgresError(new Error('failed for postgresql://dbuser:p%40ssword@db.example/app'), 'postgresql://dbuser:p%40ssword@db.example/app')
    expect(message).not.toContain('p@ssword')
    expect(message).not.toContain('p%40ssword')
    expect(message).not.toContain('dbuser')
    expect(message).toContain('[redacted]')
  })

  it('keeps PostgreSQL connection secrets out of doctor failure output', () => {
    const secret = 'devweft-test-secret'
    const doctor = fileURLToPath(new URL('../scripts/postgres-doctor.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [doctor, '--connection-only'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        AWP_DB_DIALECT: 'postgres',
        AWP_PG_MODE: 'external',
        AWP_PG_URL: `postgresql://devweft:${secret}@127.0.0.1:1/devweft_test`,
      },
    })
    expect(result.status).toBe(1)
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
    expect(`${result.stdout}${result.stderr}`).toContain('[postgres doctor]')
  })

  it('finds bundled Windows client utilities when present and otherwise uses PATH', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devweft-postgres-tools-'))
    temporaryRoots.push(root)
    const bin = path.join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'pg_dump.exe'), '')
    expect(resolvePostgresTool('pg_dump', { root, platform: 'win32' })).toBe(path.join(bin, 'pg_dump.exe'))
    expect(resolvePostgresTool('pg_restore', { root, platform: 'win32' })).toBe('pg_restore')
    expect(resolvePostgresTool('pg_dump', { root, platform: 'linux' })).toBe('pg_dump')
  })

  it('preflights Windows cluster impact before initdb and never deletes the data directory', () => {
    const source = fs.readFileSync(new URL('../scripts/setup-local-postgres.ps1', import.meta.url), 'utf8')
    const initdb = source.indexOf('\n    & $initdb')
    expect(initdb).toBeGreaterThan(0)
    for (const check of ['AvailableFreeSpace', 'WriteAllText', 'Get-NetTCPConnection', 'PG_VERSION', 'Nothing was changed']) {
      expect(source).toContain(check)
      expect(source.indexOf(check)).toBeLessThan(initdb)
    }
    expect(source).not.toMatch(/Remove-Item\s+-LiteralPath\s+\$DataDirectory/i)
  })

  it('does not require an unused cluster-wide BYPASSRLS role in the RLS bootstrap', () => {
    const source = fs.readFileSync(new URL('../sql/postgres/rls.sql', import.meta.url), 'utf8')
    const executable = source.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    expect(executable).toMatch(/CREATE ROLE awp_tenant NOLOGIN/i)
    expect(executable).toMatch(/CREATE ROLE awp_worker NOLOGIN/i)
    expect(executable).not.toMatch(/CREATE ROLE awp_admin\b/i)
    expect(executable).not.toMatch(/BYPASSRLS/i)
  })
})
