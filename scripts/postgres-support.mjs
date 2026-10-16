import fs from 'node:fs'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export const MINIMUM_POSTGRES_MAJOR = 15
export const MINIMUM_POSTGRES_VERSION_NUM = MINIMUM_POSTGRES_MAJOR * 10_000

export function assertSupportedPostgresVersion(serverVersionNum) {
  const value = Number(serverVersionNum)
  if (!Number.isInteger(value) || value < 70_000) {
    throw new Error(`PostgreSQL returned an invalid server_version_num: ${String(serverVersionNum)}`)
  }
  const major = Math.floor(value / 10_000)
  if (major < MINIMUM_POSTGRES_MAJOR) {
    throw new Error(
      `PostgreSQL ${major} is below the supported minimum (${MINIMUM_POSTGRES_MAJOR}+). Upgrade the server, then rerun the PostgreSQL preflight.`
    )
  }
  return { major, serverVersionNum: value }
}

export function makePostgresCliConnection(connectionString, baseEnv = process.env) {
  let url
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('AWP_PG_URL must be a valid PostgreSQL connection URL.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('AWP_PG_URL must use the postgres:// or postgresql:// scheme.')
  }

  const env = { ...baseEnv }
  if (baseEnv.AWP_PG_PASSWORD) env.PGPASSWORD = baseEnv.AWP_PG_PASSWORD
  else if (url.password) env.PGPASSWORD = decodeURIComponent(url.password)
  delete env.AWP_PG_PASSWORD
  url.password = ''
  return { connectionString: url.toString(), env }
}

export function resolvePostgresTool(name, { root = process.cwd(), platform = process.platform } = {}) {
  if (!['pg_dump', 'pg_restore'].includes(name)) throw new Error(`Unsupported PostgreSQL utility: ${name}`)
  if (platform === 'win32') {
    const bundled = path.join(root, 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin', `${name}.exe`)
    if (fs.existsSync(bundled)) return bundled
  }
  return name
}

export async function inspectPostgresBackupTools({ root = process.cwd(), platform = process.platform } = {}) {
  const results = {}
  for (const name of ['pg_dump', 'pg_restore']) {
    const command = resolvePostgresTool(name, { root, platform })
    try {
      const { stdout, stderr } = await execFile(command, ['--version'], { timeout: 10_000, windowsHide: true })
      const output = `${stdout}${stderr}`.trim()
      const match = output.match(/PostgreSQL\)\s+(\d+)/i)
      results[name] = { available: true, command, major: match ? Number(match[1]) : null, version: output }
    } catch {
      results[name] = { available: false, command, major: null, version: null }
    }
  }
  return results
}

export async function checkPostgresDeployment(client, { schemaOnly = false, connectionOnly = false } = {}) {
  const version = await client.query('SHOW server_version_num')
  const server = assertSupportedPostgresVersion(version.rows?.[0]?.server_version_num)
  if (connectionOnly) return server

  const schema = await client.query(`
    SELECT
      to_regclass('public.principals') IS NOT NULL AS has_baseline,
      to_regclass('public.schema_migrations') IS NOT NULL AS has_migration_ledger,
      has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_public_objects,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_tenant') AS has_tenant_role,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_worker') AS has_worker_role,
      COALESCE((SELECT rolcanlogin OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'awp_tenant'), false) AS tenant_role_overprivileged,
      COALESCE((SELECT rolcanlogin OR rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'awp_worker'), false) AS worker_role_overprivileged,
      COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'awp_tenant'), 'MEMBER'), false) AS can_set_tenant_role,
      COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'awp_worker'), 'MEMBER'), false) AS can_set_worker_role
  `)
  const state = schema.rows[0]
  if (!state.has_baseline || !state.has_migration_ledger) {
    throw new Error('The database schema is not initialized. Apply sql/postgres/baseline.sql before deployment.')
  }
  if (!state.can_create_public_objects) {
    throw new Error('The AWP_PG_URL role cannot create objects in the public schema. Use the database owner or grant CREATE on schema public before applying migrations.')
  }
  if (!schemaOnly) {
    const baseline = await client.query("SELECT 1 FROM schema_migrations WHERE name = 'postgres_baseline' LIMIT 1")
    if (baseline.rowCount === 0) {
      throw new Error('The PostgreSQL baseline is not registered. Reapply the repository bootstrap SQL or repair the migration ledger.')
    }
  }
  if (!state.has_tenant_role || !state.has_worker_role) {
    throw new Error('PostgreSQL runtime roles are missing. Apply sql/postgres/rls.sql.')
  }
  if (state.tenant_role_overprivileged || state.worker_role_overprivileged) {
    throw new Error('awp_tenant and awp_worker must be NOLOGIN, NOSUPERUSER, and NOBYPASSRLS roles. Ask the database administrator to correct these shared cluster roles.')
  }
  if (!state.can_set_tenant_role || !state.can_set_worker_role) {
    throw new Error('The AWP_PG_URL user cannot SET ROLE awp_tenant/awp_worker. Grant both roles to the configured database user.')
  }
  const rls = await client.query(`
    SELECT count(*)::int AS enabled
    FROM pg_class
    WHERE oid IN (SELECT to_regclass(path) FROM unnest(ARRAY['public.tasks', 'public.docs', 'public.experiences']) AS paths(path))
      AND relrowsecurity
  `)
  if (rls.rows[0].enabled !== 3) {
    throw new Error('Tenant row security is not enabled on all core tables. Apply sql/postgres/rls.sql.')
  }
  return server
}

export function sanitizePostgresError(error, connectionString = process.env.AWP_PG_URL) {
  let message = error?.message || String(error)
  if (connectionString) {
    try {
      const url = new URL(connectionString)
      for (const value of [url.password, url.username]) {
        if (!value) continue
        message = message.replaceAll(value, '[redacted]')
        try { message = message.replaceAll(decodeURIComponent(value), '[redacted]') } catch { /* keep the encoded form redacted */ }
      }
    } catch {
      // Invalid URLs are reported using the generic validation message elsewhere.
    }
  }
  return message
}
