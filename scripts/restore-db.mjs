/**
 * Restore a backup produced by scripts/backup-db.mjs.
 * SQLite restores are atomic file replacements after verification. PostgreSQL
 * restores run as one pg_restore transaction and require the explicit --force flag.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { copyArtifactDirectory, loadAndVerifyBackup } from './backup-manifest.mjs'
import { getTestingMigrationManifest } from '../testing/migrate.js'
import { makePostgresCliConnection, resolvePostgresTool } from './postgres-support.mjs'

const execFile = promisify(execFileCb)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function validateSqliteMigrationLedger(db, expectedSchemaVersion) {
  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all()
  const manifest = new Map(getTestingMigrationManifest('sqlite').map((entry) => [entry.version, entry]))
  const seen = new Set()
  for (const row of rows) {
    const version = Number(row.version)
    const expected = manifest.get(version)
    if (!expected || expected.name !== row.name || expected.checksum !== row.checksum) {
      throw new Error(`SQLite backup has an unknown or mismatched migration ledger entry at version ${version}`)
    }
    seen.add(version)
  }
  if (rows.length && Math.max(...rows.map((row) => Number(row.version))) !== expectedSchemaVersion) {
    throw new Error('SQLite backup schema version does not match its manifest')
  }
  if (expectedSchemaVersion > 0 && seen.size !== rows.length) {
    throw new Error('SQLite backup migration ledger contains duplicate versions')
  }
  if (expectedSchemaVersion === 0 && rows.length) throw new Error('SQLite backup schema version does not match its manifest')
}

async function verifySqliteBackup(backupPath, expectedSchemaVersion) {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${String(integrity)}`)
    const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    const schemaVersion = hasLedger
      ? Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version)
      : 0
    if (schemaVersion !== expectedSchemaVersion) throw new Error('SQLite backup schema version does not match its manifest')
    if (hasLedger) validateSqliteMigrationLedger(db, expectedSchemaVersion)
    else if (schemaVersion !== 0) throw new Error('SQLite backup migration ledger is missing')
    return { integrityCheck: integrity, schemaVersion }
  } finally {
    db.close()
  }
}

async function restoreSqlite(backupPath, manifest, targetPath, blobTarget) {
  if (!targetPath) throw new Error('SQLite restore requires --db <target-path>')
  if (path.resolve(targetPath) === path.resolve(backupPath)) throw new Error('restore target cannot be the backup file')
  if (fs.existsSync(targetPath) && !flag('force')) throw new Error(`target exists; pass --force to preserve and replace it: ${targetPath}`)
  if (fs.existsSync(`${targetPath}-wal`) || fs.existsSync(`${targetPath}-shm`)) {
    throw new Error('target has SQLite WAL sidecars; stop the service and checkpoint/close the database before restoring')
  }
  if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) throw new Error('restore target cannot be a symbolic link')
  const targetDir = path.dirname(targetPath)
  fs.mkdirSync(targetDir, { recursive: true })
  const suffix = `${Date.now()}-${process.pid}`
  const tempDb = `${targetPath}.restore-${suffix}.tmp`
  const safetyDb = fs.existsSync(targetPath) ? `${targetPath}.pre-restore-${suffix}.bak` : null
  const artifactArchive = `${backupPath}.blobs`
  const installArtifacts = manifest.artifactsIncluded
  const blobTemp = `${blobTarget}.restore-${suffix}.tmp`
  const safetyBlobs = installArtifacts && fs.existsSync(blobTarget) ? `${blobTarget}.pre-restore-${suffix}` : null

  try {
    fs.copyFileSync(backupPath, tempDb, fs.constants.COPYFILE_EXCL)
    await verifySqliteBackup(tempDb, manifest.schemaVersion)
    if (installArtifacts) copyArtifactDirectory(artifactArchive, blobTemp)
    if (safetyDb) fs.copyFileSync(targetPath, safetyDb, fs.constants.COPYFILE_EXCL)
    if (safetyBlobs) fs.cpSync(blobTarget, safetyBlobs, { recursive: true, errorOnExist: true, force: false })

    fs.renameSync(tempDb, targetPath)
    try {
      if (installArtifacts) {
        if (fs.existsSync(blobTarget)) fs.rmSync(blobTarget, { recursive: true, force: true })
        fs.renameSync(blobTemp, blobTarget)
      }
    } catch (error) {
      if (safetyDb) fs.copyFileSync(safetyDb, targetPath)
      else fs.rmSync(targetPath, { force: true })
      if (safetyBlobs) fs.cpSync(safetyBlobs, blobTarget, { recursive: true, force: true })
      throw error
    }
    return { dialect: 'sqlite', databasePath: targetPath, schemaVersion: manifest.schemaVersion, preservedDatabase: safetyDb, preservedBlobs: safetyBlobs }
  } finally {
    fs.rmSync(tempDb, { force: true })
    fs.rmSync(blobTemp, { recursive: true, force: true })
  }
}

async function postgresSchemaVersion(url) {
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
    const result = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    return Number(result.rows[0]?.version || 0)
  } finally {
    await client.end().catch(() => {})
  }
}

async function restorePostgres(backupPath, manifest) {
  const url = process.env.AWP_PG_URL || option('pg-url')
  if (!url) throw new Error('PostgreSQL restore requires AWP_PG_URL or --pg-url')
  if (!flag('force')) throw new Error('PostgreSQL restore replaces database objects; pass --force after confirming the target and taking a fresh backup')
  const cli = makePostgresCliConnection(url, {
    ...process.env,
    ...(process.env.AWP_PG_PASSWORD ? { PGPASSWORD: process.env.AWP_PG_PASSWORD } : {}),
  })
  try {
    await execFile(resolvePostgresTool('pg_restore', { root: ROOT }), [
      '--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
      '--dbname', cli.connectionString, backupPath,
    ], { env: cli.env, timeout: 600_000, maxBuffer: 10 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`pg_restore failed. Check database connectivity and permissions. ${error.code || error.message}`)
  }
  const schemaVersion = await postgresSchemaVersion(url)
  if (schemaVersion !== manifest.schemaVersion) {
    throw new Error(`restored PostgreSQL schema version ${schemaVersion} does not match backup manifest ${manifest.schemaVersion}`)
  }
  return { dialect: 'postgres', schemaVersion }
}

async function main() {
  const backupPath = option('backup')
  if (!backupPath) throw new Error('usage: npm run restore -- --backup <backup-file> --db <target-file> [--force]')
  const absoluteBackupPath = path.resolve(backupPath)
  if (!fs.existsSync(absoluteBackupPath)) throw new Error(`backup file does not exist: ${absoluteBackupPath}`)
  const { manifest } = await loadAndVerifyBackup(absoluteBackupPath)
  if (manifest.integrityCheck !== 'ok' && manifest.dialect === 'sqlite') {
    throw new Error('SQLite backup manifest does not report a successful integrity_check')
  }
  if (manifest.dialect === 'postgres' && manifest.integrityCheck !== 'pg_restore list succeeded') {
    throw new Error('PostgreSQL backup manifest is missing its archive verification result')
  }

  if (flag('dry-run')) {
    if (manifest.dialect === 'sqlite') {
      const verified = await verifySqliteBackup(absoluteBackupPath, manifest.schemaVersion)
      const targetPath = path.resolve(option('db', path.join(ROOT, 'data', 'team.db')))
      const blobTarget = path.resolve(option('blob-dir', process.env.AWP_BLOB_ROOT || path.join(ROOT, 'data', 'blobs')))
      process.stdout.write(`${JSON.stringify({ dryRun: true, dialect: 'sqlite', verified, targetPath, targetExists: fs.existsSync(targetPath), blobTarget, artifacts: manifest.artifacts.length }, null, 2)}\n`)
      return
    }
    await execFile(resolvePostgresTool('pg_restore', { root: ROOT }), ['--list', absoluteBackupPath], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
    process.stdout.write(`${JSON.stringify({ dryRun: true, dialect: 'postgres', backupPath: absoluteBackupPath, schemaVersion: manifest.schemaVersion, archiveVerified: true }, null, 2)}\n`)
    return
  }

  if (manifest.dialect === 'postgres') {
    const result = await restorePostgres(absoluteBackupPath, manifest)
    process.stdout.write(`${JSON.stringify({ ...result, backupPath: absoluteBackupPath }, null, 2)}\n`)
    return
  }

  const targetPath = path.resolve(option('db', path.join(ROOT, 'data', 'team.db')))
  const blobTarget = path.resolve(option('blob-dir', process.env.AWP_BLOB_ROOT || path.join(ROOT, 'data', 'blobs')))
  const result = await restoreSqlite(absoluteBackupPath, manifest, targetPath, blobTarget)
  process.stdout.write(`${JSON.stringify({ ...result, backupPath: absoluteBackupPath }, null, 2)}\n`)
}

main().catch((error) => {
  process.stderr.write(`[restore] failed: ${error.message}\n`)
  process.exitCode = 1
})
