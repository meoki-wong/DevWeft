import pg from 'pg'
import { checkPostgresDeployment, sanitizePostgresError } from './postgres-support.mjs'

const connectionString = process.env.AWP_PG_URL
const schemaOnly = process.argv.includes('--schema-only')
if (!connectionString) {
  console.error('AWP_PG_URL is required for AWP_DB_DIALECT=postgres.')
  process.exit(1)
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 })
try {
  await client.connect()
  const { major } = await checkPostgresDeployment(client, { schemaOnly })
  console.log(schemaOnly
    ? `PostgreSQL ${major} connection, schema, runtime roles, and tenant RLS are ready for migration registration.`
    : `PostgreSQL ${major} connection, schema baseline, runtime roles, and tenant RLS are ready.`)
} catch (error) {
  console.error(`[postgres preflight] ${sanitizePostgresError(error, connectionString)}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
