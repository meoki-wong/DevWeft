import pg from 'pg'

const connectionString = process.env.AWP_PG_URL
const schemaOnly = process.argv.includes('--schema-only')
if (!connectionString) {
  console.error('AWP_PG_URL is required for AWP_DB_DIALECT=postgres.')
  process.exit(1)
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 })
try {
  await client.connect()
  const schema = await client.query(`
    SELECT
      to_regclass('public.principals') IS NOT NULL AS has_baseline,
      to_regclass('public.schema_migrations') IS NOT NULL AS has_migration_ledger,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_tenant') AS has_tenant_role,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awp_worker') AS has_worker_role,
      COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'awp_tenant'), 'MEMBER'), false) AS can_set_tenant_role,
      COALESCE(pg_has_role(current_user, (SELECT oid FROM pg_roles WHERE rolname = 'awp_worker'), 'MEMBER'), false) AS can_set_worker_role
  `)
  const state = schema.rows[0]
  if (!state.has_baseline || !state.has_migration_ledger) {
    throw new Error('The database schema is not initialized. Apply sql/postgres/baseline.sql before deployment.')
  }
  if (!schemaOnly) {
    const baseline = await client.query(
      `SELECT 1 FROM schema_migrations WHERE name = 'postgres_baseline' LIMIT 1`
    )
    if (baseline.rowCount === 0) {
      throw new Error('The PostgreSQL baseline is not registered. Reapply the repository bootstrap SQL or repair the migration ledger.')
    }
  }
  if (!state.has_tenant_role || !state.has_worker_role) {
    throw new Error('PostgreSQL runtime roles are missing. Apply sql/postgres/rls.sql.')
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
  console.log(schemaOnly
    ? 'PostgreSQL connection, schema, runtime roles, and tenant RLS are ready for migration registration.'
    : 'PostgreSQL connection, schema baseline, runtime roles, and tenant RLS are ready.')
} catch (error) {
  console.error(`[postgres preflight] ${error.message}`)
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
