/**
 * Database readiness probes. The live endpoint has no dependencies; readiness
 * validates the actual migration ledger and the structures required to serve work.
 */
import { CONTRACT_VERSION } from '../contracts/version.mjs'
import { getTestingMigrationManifest } from '../testing/migrate.js'

const REQUIRED_COLUMNS = {
  repositories: ['repo_id', 'slug'],
  test_bindings: ['binding_id', 'repo_id'],
  test_runs: ['run_id', 'repo_id', 'binding_id', 'status'],
  schema_migrations: ['version', 'name', 'checksum', 'applied_at'],
}

const REQUIRED_INDEXES = ['idx_bindings_task', 'idx_runs_queue']

async function columnExists(database, table, column, dialect) {
  if (dialect === 'postgres') {
    const row = await database.prepare(`
      SELECT 1 AS present FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?
    `).get(table, column)
    return Boolean(row)
  }
  const rows = await database.prepare(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => row.name === column)
}

async function indexExists(database, indexName, dialect) {
  const row = dialect === 'postgres'
    ? await database.prepare(`
        SELECT 1 AS present FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = ?
      `).get(indexName)
    : await database.prepare(`
        SELECT 1 AS present FROM sqlite_master WHERE type='index' AND name=?
      `).get(indexName)
  return Boolean(row)
}

function manifestCheck(rows, dialect) {
  const byVersion = new Map(rows.map((row) => [Number(row.version), row]))
  const checks = []
  const latest = rows.reduce((max, row) => Math.max(max, Number(row.version) || 0), 0)
  const manifest = getTestingMigrationManifest(dialect)
  for (const expected of manifest) {
    const row = expected.version === null
      ? rows.find((entry) => entry.name === expected.name)
      : byVersion.get(expected.version)
    const ok = Boolean(row && row.name === expected.name && row.checksum === expected.checksum)
    const label = expected.version === null ? `migration:${expected.name}` : `migration:v${expected.version}`
    checks.push({
      name: label,
      ok,
      ...(row ? { version: Number(row.version) } : {}),
      ...(!ok ? { reason: row ? 'name_or_checksum_mismatch' : 'missing_migration' } : {}),
    })
  }

  const expectedVersions = new Set(manifest.filter((entry) => entry.version !== null).map((entry) => entry.version))
  for (const row of rows) {
    if (row.name === 'postgres_baseline') continue
    if (!expectedVersions.has(Number(row.version))) {
      checks.push({ name: `migration:v${row.version}`, ok: false, reason: 'unexpected_migration' })
    }
  }
  return { checks, latest }
}

export function mountHealthRoutes(app, {
  database = null,
  expectedSchemaVersion = null,
  nodeRole = 'primary',
  executionMode = 'disabled',
  getBlobStorage = null,
  getStandbyUploadEndpoint = null,
} = {}) {
  app.get('/api/health/live', (req, res) => {
    res.json({ ok: true, live: true, at: new Date().toISOString() })
  })

  app.get('/api/health/ready', async (req, res) => {
    const checks = []
    const dialect = database?.dialect === 'postgres' ? 'postgres' : 'sqlite'
    let ready = true
    let dbOk = false
    let schemaVersion = 0
    let blobStorage = null
    let standbyUploadEndpoint = null

    try {
      if (!database) throw new Error('no database handle')
      const one = await database.prepare('SELECT 1 AS one').get()
      dbOk = Number(one?.one) === 1
      checks.push({ name: `${dialect}_query`, ok: dbOk })
      if (!dbOk) ready = false
    } catch (err) {
      checks.push({ name: `${dialect}_query`, ok: false, reason: err.message })
      ready = false
    }

    if (dbOk) {
      try {
        const tables = Object.keys(REQUIRED_COLUMNS)
        const probe = dialect === 'postgres'
          ? (table) => database.prepare(`
              SELECT count(*) AS n FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = ?
            `).get(table)
          : (table) => database.prepare(
              `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?`
            ).get(table)
        for (const table of tables) {
          const count = Number((await probe(table)).n)
          const ok = count > 0
          checks.push({ name: `table:${table}`, ok })
          if (!ok) ready = false
        }

        for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
          for (const column of columns) {
            const ok = await columnExists(database, table, column, dialect)
            checks.push({ name: `column:${table}.${column}`, ok })
            if (!ok) ready = false
          }
        }

        for (const indexName of REQUIRED_INDEXES) {
          const ok = await indexExists(database, indexName, dialect)
          checks.push({ name: `index:${indexName}`, ok })
          if (!ok) ready = false
        }

        const migrationRows = await database.prepare(
          'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
        ).all()
        const ledger = manifestCheck(migrationRows, dialect)
        checks.push(...ledger.checks)
        schemaVersion = ledger.latest
        if (ledger.checks.some((check) => !check.ok)) ready = false
        if (expectedSchemaVersion !== null && schemaVersion < expectedSchemaVersion) {
          checks.push({ name: 'schema_version', ok: false, expected: expectedSchemaVersion, actual: schemaVersion })
          ready = false
        }
      } catch (err) {
        checks.push({ name: 'schema_validation', ok: false, reason: err.message })
        ready = false
      }
    }

    if (getBlobStorage) {
      try {
        blobStorage = await getBlobStorage()
        const ok = blobStorage?.ok === true
        checks.push({
          name: 'blob_storage',
          ok,
          state: blobStorage?.state || (ok ? 'available' : 'unavailable'),
        })
        // Primary PostgreSQL nodes can still store locally while their separate
        // standby upload endpoint is degraded. Standby submissions require the
        // remote canonical store, so that probe is readiness-critical there.
        if (!ok && (
          nodeRole === 'standby' || blobStorage?.required === true || blobStorage?.mode === 'local'
        )) ready = false
      } catch {
        blobStorage = {
          ok: false,
          mode: nodeRole === 'standby' ? 'remote' : 'local',
          state: 'probe_failed',
          localCache: false,
          recovery: nodeRole === 'standby'
            ? 'retry_submission_after_remote_blob_restore'
            : 'restore_from_backup_or_replicate_blob_root',
        }
        checks.push({ name: 'blob_storage', ok: false, state: 'probe_failed' })
        ready = false
      }
    }

    if (getStandbyUploadEndpoint) {
      try {
        standbyUploadEndpoint = await getStandbyUploadEndpoint()
      } catch {
        standbyUploadEndpoint = { ok: false, state: 'probe_failed' }
      }
    }

    const status = {
      schemaVersion,
      contractVersion: CONTRACT_VERSION,
      checks,
      node: { role: nodeRole, executionMode },
      ...(blobStorage ? { blobStorage } : {}),
      ...(standbyUploadEndpoint ? { standbyUploadEndpoint } : {}),
    }

    if (ready) {
      res.json({ ok: true, ready: true, ...status })
    } else {
      res.status(503).json({ ok: false, ready: false, ...status })
    }
  })
}
