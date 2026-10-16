import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { installSqliteTx } from '../db/sqlite-tx.js'
import { runTestingMigrations } from '../testing/migrate.js'

installSqliteTx(Database)

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const tempDirs = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devweft-backup-'))
  tempDirs.push(dir)
  return dir
}

function runScript(script, args, env = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AWP_DB_DIALECT: 'sqlite', ...env },
    timeout: 60_000,
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('verified backup and restore commands', () => {
  it('backs up and restores SQLite schema, data, and content-addressed artifacts', async () => {
    const dir = tempDir()
    const sourceDb = path.join(dir, 'source.db')
    const backupDir = path.join(dir, 'backups')
    const sourceBlobs = path.join(dir, 'source-blobs')
    const targetDb = path.join(dir, 'restored', 'target.db')
    const targetBlobs = path.join(dir, 'restored-blobs')
    fs.mkdirSync(sourceBlobs, { recursive: true })
    fs.mkdirSync(path.join(sourceBlobs, 'sha256', 'ab'), { recursive: true })
    fs.writeFileSync(path.join(sourceBlobs, 'sha256', 'ab', 'artifact'), 'artifact bytes')

    const source = new Database(sourceDb)
    await runTestingMigrations(source, { skipLegacyMap: true })
    source.exec('CREATE TABLE restore_probe (value TEXT NOT NULL)')
    source.prepare('INSERT INTO restore_probe(value) VALUES (?)').run('preserve me')
    source.close()

    const backupRun = runScript('backup-db.mjs', [
      '--db', sourceDb, '--out', backupDir, '--blob-dir', sourceBlobs,
    ])
    expect(backupRun.status, backupRun.stderr).toBe(0)
    const backupResult = JSON.parse(backupRun.stdout)
    expect(backupResult.schemaVersion).toBe(43)
    expect(backupResult.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(fs.existsSync(backupResult.manifestPath)).toBe(true)

    const dryRun = runScript('restore-db.mjs', [
      '--backup', backupResult.backupPath, '--db', targetDb, '--blob-dir', targetBlobs, '--dry-run',
    ])
    expect(dryRun.status, dryRun.stderr).toBe(0)
    expect(JSON.parse(dryRun.stdout).dryRun).toBe(true)
    expect(fs.existsSync(targetDb)).toBe(false)

    const restoreRun = runScript('restore-db.mjs', [
      '--backup', backupResult.backupPath, '--db', targetDb, '--blob-dir', targetBlobs,
    ])
    expect(restoreRun.status, restoreRun.stderr).toBe(0)
    const restored = new Database(targetDb, { readonly: true })
    expect(restored.prepare('SELECT value FROM restore_probe').get().value).toBe('preserve me')
    expect(Number(restored.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v)).toBe(43)
    restored.close()
    expect(fs.readFileSync(path.join(targetBlobs, 'sha256', 'ab', 'artifact'), 'utf8')).toBe('artifact bytes')

    const noForce = runScript('restore-db.mjs', [
      '--backup', backupResult.backupPath, '--db', targetDb, '--blob-dir', targetBlobs,
    ])
    expect(noForce.status).not.toBe(0)
    expect(noForce.stderr).toMatch(/pass --force/)

    const beforeReplace = new Database(targetDb)
    beforeReplace.prepare('INSERT INTO restore_probe(value) VALUES (?)').run('keep as safety copy')
    beforeReplace.close()
    const forced = runScript('restore-db.mjs', [
      '--backup', backupResult.backupPath, '--db', targetDb, '--blob-dir', targetBlobs, '--force',
    ])
    expect(forced.status, forced.stderr).toBe(0)
    const forcedResult = JSON.parse(forced.stdout)
    expect(fs.existsSync(forcedResult.preservedDatabase)).toBe(true)
    const safetyCopy = new Database(forcedResult.preservedDatabase, { readonly: true })
    expect(safetyCopy.prepare('SELECT COUNT(*) AS n FROM restore_probe').get().n).toBe(2)
    safetyCopy.close()

    fs.writeFileSync(backupResult.backupPath, 'tampered')
    const tampered = runScript('restore-db.mjs', [
      '--backup', backupResult.backupPath, '--db', targetDb, '--blob-dir', targetBlobs, '--force',
    ])
    expect(tampered.status).not.toBe(0)
    expect(tampered.stderr).toMatch(/size|SHA-256/)
    const stillIntact = new Database(targetDb, { readonly: true })
    expect(stillIntact.prepare('SELECT value FROM restore_probe').get().value).toBe('preserve me')
    stillIntact.close()
  })

  it('missing source database exits nonzero and does not create a backup', () => {
    const dir = tempDir()
    const out = path.join(dir, 'backups')
    const result = runScript('backup-db.mjs', ['--db', path.join(dir, 'missing.db'), '--out', out])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/does not exist/)
    expect(fs.existsSync(out)).toBe(false)
  })
})
