import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const connectionString = process.env.AWP_PG_URL
const databaseName = process.env.AWP_PG_DATABASE || 'awp_platform'
if (!connectionString) throw new Error('AWP_PG_URL is required to provision local PostgreSQL.')
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
  throw new Error('AWP_PG_DATABASE must use letters, digits, and underscores, and cannot start with a digit.')
}

const adminUrl = new URL(connectionString)
adminUrl.pathname = '/postgres'
const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 10000 })
let database
try {
  await admin.connect()
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  if (exists.rowCount === 0) {
    await admin.query(`CREATE DATABASE "${databaseName}"`)
  }

  database = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 })
  await database.connect()
  const current = await database.query("SELECT to_regclass('public.principals') IS NOT NULL AS ready")
  const root = resolve(process.cwd())
  if (!current.rows[0].ready) {
    await database.query(readFileSync(resolve(root, 'sql/postgres/baseline.sql'), 'utf8'))
  }
  await database.query(readFileSync(resolve(root, 'sql/postgres/rls.sql'), 'utf8'))
  console.log(`Local PostgreSQL schema is ready for database ${databaseName}.`)
} finally {
  await database?.end().catch(() => {})
  await admin.end().catch(() => {})
}
