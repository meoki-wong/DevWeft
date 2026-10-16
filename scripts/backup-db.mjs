/**
 * Create a verified SQLite or PostgreSQL backup plus a SHA-256 manifest.
 *
 *   npm run backup -- --db data/team.db --out data/backups [--blob-dir data/blobs]
 *   AWP_DB_DIALECT=postgres AWP_PG_URL=... npm run backup -- --out data/backups
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  BACKUP_MANIFEST_VERSION,
  copyArtifactDirectory,
  describeArtifacts,
  sha256File,
  writeBackupManifest,
} from './backup-manifest.mjs'
import { makePostgresCliConnection, resolvePostgresTool } from './postgres-support.mjs'

const execFile = promisify(execFileCb)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIALECT = process.env.AWP_DB_DIALECT === 'postgres' ? 'postgres' : 'sqlite'

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
  return value
}

const DB_PATH = path.resolve(option('db', path.join(ROOT, 'data', 'team.db')))
const OUT_DIR = path.resolve(option('out', path.join(ROOT, 'data', 'backups')))
const BLOB_DIR = path.resolve(option('blob-dir', process.env.AWP_BLOB_ROOT || path.join(ROOT, 'data', 'blobs')))
const KEEP = Number(option('keep', '14'))

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function uniqueBackupPath(prefix, extension) {
  const base = `${prefix}.${timestamp()}.${process.pid}`
  const pathWithExtension = path.join(OUT_DIR, `${base}${extension}`)
  if (fs.existsSync(pathWithExtension) || fs.existsSync(`${pathWithExtension}.manifest.json`)) {
    throw new Error(`backup path already exists: ${pathWithExtension}`)
  }
  return pathWithExtension
}

async function verifySqlite(filePath) {
  const Database = (await import('better-sqlite3')).default
  const db = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()?.integrity_check
    if (integrity !== 'ok') throw new Error(`SQLite integrity_check failed: ${String(integrity)}`)
    const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    const schemaVersion = hasLedger
      ? Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get().version)
      : 0
    return { integrityCheck: integrity, schemaVersion }
  } finally {
    db.close()
  }
}

async function backupSqlite(backupPath, tempPath) {
  const Database = (await import('better-sqlite3')).default
  if (!fs.existsSync(DB_PATH)) throw new Error(`SQLite database does not exist: ${DB_PATH}`)
  const source = new Database(DB_PATH, { readonly: true, fileMustExist: true })
  try {
    await source.backup(tempPath)
  } finally {
    source.close()
  }
  const verified = await verifySqlite(tempPath)
  fs.renameSync(tempPath, backupPath)
  return { mode: 'sqlite-online-backup', ...verified }
}

async function currentPostgresSchemaVersion(url) {
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
    const result = await client.query('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    return Number(result.rows[0]?.version || 0)
  } finally {
    await client.end().catch(() => {})
  }
}

async function backupPostgres(backupPath, tempPath) {
  const url = process.env.AWP_PG_URL || option('pg-url', null)
  if (!url) throw new Error('PostgreSQL backup requires AWP_PG_URL or --pg-url')
  const schemaVersion = await currentPostgresSchemaVersion(url)
  const cli = makePostgresCliConnection(url, {
    ...process.env,
    ...(process.env.AWP_PG_PASSWORD ? { PGPASSWORD: process.env.AWP_PG_PASSWORD } : {}),
  })
  try {
    await execFile(resolvePostgresTool('pg_dump', { root: ROOT }), ['--format=custom', '--no-owner', '--no-privileges', '--file', tempPath, cli.connectionString], {
      env: cli.env,
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    await execFile(resolvePostgresTool('pg_restore', { root: ROOT }), ['--list', tempPath], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`PostgreSQL dump/verification failed. Check that pg_dump and pg_restore are installed, match the server version, and can reach the database. ${error.code || error.message}`)
  }
  if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size === 0) throw new Error('pg_dump did not produce a backup archive')
  fs.renameSync(tempPath, backupPath)
  return { mode: 'pg_dump-custom', integrityCheck: 'pg_restore list succeeded', schemaVersion }
}

function pruneBackups() {
  if (!Number.isInteger(KEEP) || KEEP < 1) throw new Error('--keep must be a positive integer')
  const candidates = fs.readdirSync(OUT_DIR)
    .filter((name) => /^team\.(?:sqlite|postgres)\..+\.(?:bak|dump)$/.test(name))
    .sort()
    .reverse()
  const removed = []
  for (const name of candidates.slice(KEEP)) {
    const filePath = path.join(OUT_DIR, name)
    fs.rmSync(filePath, { force: true })
    fs.rmSync(`${filePath}.manifest.json`, { force: true })
    fs.rmSync(`${filePath}.blobs`, { recursive: true, force: true })
    removed.push(name)
  }
  return { kept: Math.min(candidates.length, KEEP), removed }
}

async function main() {
  if (!Number.isInteger(KEEP) || KEEP < 1) throw new Error('--keep must be a positive integer')
  if (DIALECT === 'sqlite' && !fs.existsSync(DB_PATH)) throw new Error(`SQLite database does not exist: ${DB_PATH}`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const started = Date.now()
  const extension = DIALECT === 'sqlite' ? '.bak' : '.dump'
  const backupPath = uniqueBackupPath(DIALECT === 'sqlite' ? 'team.sqlite' : 'team.postgres', extension)
  const tempPath = `${backupPath}.${process.pid}.tmp`
  let result
  try {
    result = DIALECT === 'sqlite'
      ? await backupSqlite(backupPath, tempPath)
      : await backupPostgres(backupPath, tempPath)

    const artifactsIncluded = fs.existsSync(BLOB_DIR)
    const artifactPath = `${backupPath}.blobs`
    if (artifactsIncluded) {
      const outRoot = `${OUT_DIR}${path.sep}`
      if (BLOB_DIR === OUT_DIR || BLOB_DIR.startsWith(outRoot)) {
        throw new Error('blob directory cannot be inside the backup output directory')
      }
      copyArtifactDirectory(BLOB_DIR, artifactPath)
    }
    const artifacts = artifactsIncluded ? await describeArtifacts(artifactPath) : []
    const stat = fs.statSync(backupPath)
    const manifest = {
      manifestVersion: BACKUP_MANIFEST_VERSION,
      dialect: DIALECT,
      createdAt: new Date().toISOString(),
      backupFile: path.basename(backupPath),
      bytes: stat.size,
      sha256: await sha256File(backupPath),
      schemaVersion: result.schemaVersion,
      integrityCheck: result.integrityCheck,
      artifactsIncluded,
      artifacts,
    }
    const manifestPath = await writeBackupManifest(backupPath, manifest)
    const retention = pruneBackups()
    process.stdout.write(`${JSON.stringify({ ...result, backupPath, manifestPath, bytes: stat.size, sha256: manifest.sha256, retention, durationMs: Date.now() - started }, null, 2)}\n`)
  } catch (error) {
    fs.rmSync(tempPath, { force: true })
    fs.rmSync(backupPath, { force: true })
    fs.rmSync(`${backupPath}.manifest.json`, { force: true })
    fs.rmSync(`${backupPath}.blobs`, { recursive: true, force: true })
    throw error
  }
}

main().catch((error) => {
  process.stderr.write(`[backup] failed: ${error.message}\n`)
  process.exitCode = 1
})
