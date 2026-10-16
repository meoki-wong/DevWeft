import pg from 'pg'
import {
  checkPostgresDeployment,
  inspectPostgresBackupTools,
  sanitizePostgresError,
} from './postgres-support.mjs'

const connectionString = process.env.AWP_PG_URL
const dialect = process.env.AWP_DB_DIALECT || 'sqlite'
const mode = process.env.AWP_PG_MODE || 'external'
const connectionOnly = process.argv.includes('--connection-only')
const schemaOnly = process.argv.includes('--schema-only')
const requireBackupTools = process.argv.includes('--require-backup-tools')

if (dialect !== 'postgres' && !connectionString) {
  console.log('PostgreSQL is not configured; this deployment uses SQLite.')
  process.exit(0)
}
if (dialect !== 'postgres' && connectionString) {
  console.warn('AWP_PG_URL is set while AWP_DB_DIALECT is not postgres; checking the PostgreSQL URL explicitly.')
}
if (mode === 'embedded' && process.platform !== 'win32') {
  console.error('The bundled PostgreSQL mode is supported only on Windows. Install PostgreSQL with your OS package manager and use AWP_PG_MODE=external, or connect to a managed PostgreSQL server.')
  process.exit(1)
}
if (!connectionString) {
  console.error('AWP_PG_URL is required. Set it in data/deploy.env, then rerun npm run postgres:check.')
  process.exit(1)
}

let parsed
try {
  parsed = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('scheme')
} catch {
  console.error('AWP_PG_URL must be a valid postgres:// or postgresql:// URL. Keep the password in the ignored data/deploy.env file.')
  process.exit(1)
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 })
try {
  await client.connect()
  const { major } = await checkPostgresDeployment(client, { schemaOnly, connectionOnly })
  console.log(`PostgreSQL ${major} connection is reachable and meets the supported minimum (15).`)
  if (!connectionOnly) {
    console.log(schemaOnly
      ? 'PostgreSQL baseline, roles, and tenant row security are ready for migration registration.'
      : 'PostgreSQL baseline, migration ledger, roles, and tenant row security are ready.')
  }

  const tools = await inspectPostgresBackupTools()
  const missing = Object.entries(tools).filter(([, result]) => !result.available)
  const incompatible = Object.entries(tools).filter(([, result]) => result.available && result.major !== null && result.major < major)
  for (const [name, result] of Object.entries(tools)) {
    if (result.available) console.log(`${name}: ${result.version}`)
    else console.warn(`${name}: unavailable (PostgreSQL backup or restore will not work until the client tools are installed)`)
  }
  if (incompatible.length) {
    console.warn(`Backup tool major version is older than PostgreSQL ${major}: ${incompatible.map(([name]) => name).join(', ')}. Install matching or newer client tools.`)
  }
  if (requireBackupTools && (missing.length || incompatible.length)) process.exitCode = 1
} catch (error) {
  console.error(`[postgres doctor] ${sanitizePostgresError(error, connectionString)}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
