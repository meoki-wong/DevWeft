# Setup and operations

This guide covers the control plane and optional test execution worker. The server can run without a worker; queued execution requires a configured runner.

For the component map, see [Architecture](docs/ARCHITECTURE.md). For a consolidated list of deployment and project settings, see [Configuration reference](docs/CONFIGURATION.md).

## 1. Start the control plane

Use Node.js 22.12+, 24+, or 26+ (matching the test runner's supported releases).

~~~sh
npm install
npm run db:init
cp data/repo-platform.example.json data/repo-platform.json
AWP_DEFAULT_REPO=example-app npm run bootstrap
npm start
~~~

The server defaults to http://127.0.0.1:8787. Set PORT to use another port. Bootstrap creates the initial administrator and writes local bootstrap metadata into ignored files under data/.

`data/deploy.env` is the canonical local deployment configuration. Copy `data/deploy.env.example` to that path when you need to set database, port, workspace, or Hyper-V options; Node commands and the PowerShell scripts read the same file. SQLite is the default, so the file is optional for a basic local start. The PostgreSQL deployment minimum is version 15; check the [PostgreSQL supported-version policy](https://www.postgresql.org/support/versioning/) when choosing or upgrading a server. On a single Windows host, set `AWP_DB_DIALECT=postgres` and `AWP_PG_MODE=embedded` in `data/deploy.env`; `deploy.cmd` initializes the bundled local PostgreSQL instance, applies the schema and RLS scripts, and writes the generated connection string back to the same ignored file. This embedded mode is for a single host only.

### PostgreSQL setup and checks

The repository does not install a system PostgreSQL service on Linux or macOS. Install PostgreSQL 15 or newer and its client utilities using your operating-system package manager, then verify `psql`, `pg_dump`, and `pg_restore` are available. Examples:

~~~sh
# Ubuntu: the distribution package may be older than 15 on older Ubuntu releases.
sudo apt install postgresql postgresql-client
psql --version
pg_dump --version
pg_restore --version
~~~

If the Ubuntu package is older than 15, use the [official PostgreSQL Apt repository instructions](https://www.postgresql.org/download/linux/ubuntu/) and install a supported major version. On macOS, the official PostgreSQL download page lists Homebrew, Postgres.app, and installer options; for example, `brew install postgresql@18` followed by `brew services start postgresql@18` ([Homebrew formula](https://formulae.brew.sh/formula/postgresql@18)). On Windows, use the single-host bundled mode below or install an external PostgreSQL server from the [official Windows downloads page](https://www.postgresql.org/download/windows/).

The bundled Windows mode checks the data directory, write access, available disk space, and port before initializing a new cluster. A port conflict stops deployment before initialization; an existing cluster is preserved and is never deleted by the setup script. It warns when the target drive has less than 5 GB free because PostgreSQL data can grow. The bundled package and scheduled startup are intended for one Windows host, not a shared primary/standby database.

For a primary/standby pair, use an externally managed PostgreSQL database reachable from both machines. Set `AWP_DB_DIALECT=postgres`, `AWP_PG_MODE=external`, and `AWP_PG_URL` in `data/deploy.env` on the primary and `data/node.env` on the standby. PostgreSQL roles are cluster-wide: a database administrator should create `awp_tenant` and `awp_worker`, grant both to the application login, and make that login the owner of the empty application database. Then use that owner login in `AWP_PG_URL`; it must be able to create and alter objects in the database. Applying the RLS bootstrap with an application owner does not require creating a separate `BYPASSRLS` role.

For a fresh dedicated cluster, the DBA can create the application roles and assign database ownership once (replace `devweft_app` and `devweft` with the chosen login and database names; omit `CREATE ROLE` lines for roles that already exist):

~~~sql
CREATE ROLE awp_tenant NOLOGIN;
CREATE ROLE awp_worker NOLOGIN;
GRANT awp_tenant, awp_worker TO devweft_app;
ALTER DATABASE devweft OWNER TO devweft_app;
~~~

The application roles are shared at the PostgreSQL cluster level. Use a dedicated cluster, or have the DBA verify that any pre-existing `awp_tenant` and `awp_worker` roles are the expected non-login, non-superuser roles before reusing them.

Before schema setup, check the connection and server version without printing the URL or its password:

~~~sh
npm run postgres:check -- --connection-only
~~~

Initialize the empty database as the application database owner. The role definitions must already exist in the cluster; `sql/postgres/rls.sql` also creates the two non-login roles when the current database login has `CREATEROLE` permission. The application login must be a member of both roles so it can run tenant and worker transactions.

~~~sh
# Load the ignored local deployment settings into this shell for psql.
set -a
. data/deploy.env
set +a
psql "$AWP_PG_URL" -v ON_ERROR_STOP=1 -f sql/postgres/baseline.sql
psql "$AWP_PG_URL" -v ON_ERROR_STOP=1 -f sql/postgres/rls.sql
~~~

If a DBA pre-created the roles, grant membership from the DBA connection (replace `devweft_app` with the actual login):

~~~sql
GRANT awp_tenant, awp_worker TO devweft_app;
~~~

Before deployment, verify the baseline and role setup with `npm run postgres:check -- --schema-only`. Deployment registers the baseline, applies forward migrations, and checks connectivity, minimum version, roles, role membership, and row-level security. Run `npm run postgres:check` after deployment to check migration readiness too. Use the same database URL on the standby host. Keep credentials in ignored local env files; do not put them in shell history, source control, or support bundles.

PostgreSQL backup and restore use the native `pg_dump` and `pg_restore` utilities. `npm run postgres:check -- --require-backup-tools` also checks that both utilities are installed and not older than the server. The bundled Windows package is searched automatically; Linux and macOS use the utilities from `PATH`. For backups, the password from `AWP_PG_URL` is passed through `PGPASSWORD`, not as a command-line argument.

### Windows one-click entry points

Run these from the repository root on Windows. `deploy.cmd` checks for Node.js 22.12+, 24+, or 26+ and Git, then uses `winget` to install missing prerequisites when available. The startup commands run role-specific PowerShell preflight checks and return a nonzero exit code when configuration or startup fails.

| File | Purpose |
|---|---|
| `deploy.cmd` | First Windows deployment: Git/Node prerequisites, dependency install, selected database setup, PM2 services, and health checks. Hyper-V host setup is optional and requires an edition that supports Hyper-V. |
| `start-primary.cmd` | Start or restart the full PM2 service set on the primary host. |
| `start-standby.cmd` | Start only the standby control-plane process after configuring `data/node.env`. |
| `start.cmd` | Start the standalone control plane in the foreground. |

The primary and standby hosts share one PostgreSQL database when running as a failover pair. The embedded PostgreSQL option is local-only and cannot serve the standby unless you separately configure and secure remote access. For a single-node install, SQLite is ready to use without database installation. `start-primary.cmd` reads `data/deploy.env`; `start-standby.cmd` reads the standby-specific `data/node.env` copied from `data/node.env.example`.

This is control-plane failover, not automatic artifact replication. The primary's `data/blobs` directory is authoritative; a standby has no local cache and must reach the primary blob endpoint. Configure `AWP_BLOB_BASE_URL` directly, or leave it blank to resolve the non-loopback primary link from the dashboard's link pool in the shared database. `/api/health/ready` reports the node role and required storage state, and standby readiness fails while the remote blob endpoint is unavailable. For PostgreSQL failover, use the separate blob endpoint (default port `8792`) so uploads continue during control-plane restarts. See [Availability and artifact storage](docs/AVAILABILITY.md) for health response fields, recovery steps, and backup boundaries.

In PM2 host mode, the gateway defaults to port `8787` and the control plane to `8791`. `start.cmd` runs the standalone control plane on port `8787` for local use.

Useful commands:

| Command | Purpose |
|---|---|
| npm start | Start the HTTP and MCP server |
| npm run db:init | Create or migrate the local database |
| npm run bootstrap | Create the initial administrator and default repository |
| npm run postgres:check | Check PostgreSQL version, schema readiness, and backup utilities |
| npm run backup | Create a SHA-256 verified SQLite or PostgreSQL backup and manifest |
| npm run restore -- --backup <file> --db <target> --dry-run | Verify a backup and preview a SQLite restore |
| npm run restore -- --backup <file> --db <target> | Restore SQLite to a new target database |
| npm test | Run the Vitest suite |
| npm run test:coverage | Run tests with coverage |
| npm run policies:build | Rebuild policy bundles |

## 2. Connect an MCP client

The server exposes Streamable HTTP at /mcp. A minimal client configuration is:

~~~json
{
  "mcpServers": {
    "devweft": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp?repo=example-app"
    }
  }
}
~~~

The example client template is in templates/mcp.json. Set the repository slug to the project you are working on. The server also exposes REST routes under /api/ and /v1/.

## 3. Configure repositories

Copy the sample profile to the ignored local file:

~~~sh
cp data/repo-platform.example.json data/repo-platform.json
~~~

Set a workspace path per repository. For the public example profile, the workspace is `examples/example-app`; for another slug such as `my-service`, the environment key is `AWP_REPO_PATH_MY_SERVICE`:

~~~sh
AWP_DEFAULT_REPO=example-app
AWP_REPO_PATH_EXAMPLE_APP=/work/example-app
~~~

Each profile can define:

- workspaceEnv, workspacePath, and optional workspaceCandidates.
- smoke, mapping a side name to its build command, entry page, and output directory.
- defaultSides, casePrefix, and suiteSlug.
- gateMode, which defaults to observe for a newly configured repository.
- enabled, to turn the profile off without removing it.

Smoke commands are read from the profile and frozen into each run. The platform does not supply business-project build commands. Define suite assets under suites/<suiteSlug>/stable and suites/<suiteSlug>/repo when using the suite registry.

## 4. Configure a test worker

The worker is optional. The isolated VM lane targets Windows with Hyper-V; a local process backend can run static checks on Windows, macOS, and Linux for trusted projects.

### Local process runner

To run static checks without preparing a VM image, set `AWP_RUNNER_BACKEND=local` in `data/deploy.env` and start the worker with PM2 through `start-primary.cmd`, or run `npm run worker` from a shell. The local backend claims static runs only; smoke runs remain queued. It uses the same runSpec, signed sidecar, artifact upload, and lease completion protocol as the VM lane. The signed result records `local-process` / `host-process`, but project code still runs with the worker user's filesystem and network permissions. Use it only for trusted repositories. The local backend does not inject run secrets.

For untrusted repository code, use the Hyper-V backend. Set `AWP_RUNNER_BACKEND=hyperv`, prepare a signed runner image, then set `AWP_HYPERV_ENABLED=true` and follow the isolated worker setup below.

The worker needs:

1. A runner image and matching image manifest.
2. Worker and broker certificates under the local, ignored secret-broker/dev-certs/ directory.
3. A private runner root, such as `data/runner`, with the image and attempt directories.
4. Repository workspace profiles on the host that creates source snapshots.
5. A local npm proxy configuration when guest VMs need package installation.

`deploy.cmd` defaults to control-plane-only mode and does not enable Hyper-V. The VM worker is opt-in because it needs a separately prepared and licensed Windows image. First deploy the control plane with `AWP_HYPERV_ENABLED=false`, then prepare a golden VHDX and an `installed-components.json` file that lists the software in that image. The repository does not include Windows installation media or a prebuilt image.

Generate an SBOM and publish the image into the configured database. Use a new immutable image ID for every image revision:

The components input should identify software actually present in the VHDX, for example:

~~~json
{
  "components": [
    { "name": "windows-server", "version": "2025", "source": "licensed installation media" },
    { "name": "node", "version": "22.12.0", "source": "https://nodejs.org/" }
  ]
}
~~~

~~~cmd
npm run image:sbom -- --components data\runner\installed-components.json --image-id windows-node22-2026-10 --out data\runner\images\windows-node22-2026-10.sbom.json
npm run image:publish -- publish --image-id windows-node22-2026-10 --vhdx data\runner\images\golden.vhdx --sbom data\runner\images\windows-node22-2026-10.sbom.json --mode active
npm run image:verify -- --vhdx data\runner\images\golden.vhdx
~~~

Then set `AWP_HYPERV_ENABLED=true` in ignored `data/deploy.env` and rerun `deploy.cmd` from an elevated PowerShell. Deployment verifies the active image signature and VHDX hash before changing host network settings. It uses an Internal Hyper-V switch, opens only the npm proxy port to the guest CIDR, and blocks the gateway, broker, control-plane, and blob-store ports. Existing switches, IP addresses, routes, firewall rules, and runner certificate files are reused only when compatible; conflicts stop deployment without deleting or replacing those resources.

The default isolated range is `192.168.250.0/24`. If it overlaps a LAN, VPN, adapter address, or route, choose another unused RFC1918 `/24` in `AWP_VM_NETWORK_CIDR`. The deployment derives `.1` for the proxy, `.10` for a single guest, and `.11`–`.26` for parallel guests. The exact adapter, switch, route, firewall rules, and address conflicts are checked by a read-only preflight before network changes.

You can also run the deployment helper directly from PowerShell:

~~~powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\deploy-test-platform.ps1
~~~

The deployment accepts `-ControlPort`, `-BrokerPort`, `-RunnerRoot`, `-SwitchName`, `-VmNetworkCidr`, `-SkipHyperV`, `-SkipNpmCi`, `-SkipPm2`, `-SkipVerify`, `-ForcePki`, `-RotateToken`, `-RunTests`, and `-InstallStartup`. `scripts/verify-test-platform.ps1` can be run separately after deployment; with `AWP_HYPERV_ENABLED=true` it treats a missing or mismatched signed runner image as a failure.

For a standby host, copy `data/node.env.example` to `data/node.env`, then set the shared PostgreSQL URL and standby port. You can set `AWP_BLOB_BASE_URL` directly or leave it blank to use the non-loopback primary link saved in the dashboard's link pool and shared PostgreSQL database. For control-plane failover, set it directly to the primary's separate blob endpoint (default port `8792`), so uploads continue while the primary control-plane process restarts. Start it with `start-standby.cmd`. If the standby must submit artifacts, copy the primary's `data/bootstrap-admin.token` through a secure channel to the same ignored path on the standby. The startup script never creates a shared default token.

~~~cmd
copy data\node.env.example data\node.env
notepad data\node.env
~~~

The isolated network helpers live in scripts/windows/. `ensure-isolated-network.ps1 -PreflightOnly` checks planned changes without mutating the host. With no conflicts, the setup creates only missing resources and never removes user-defined switches, IP addresses, routes, or firewall rules.

## 可用 MCP 工具（37 个）

The MCP server currently registers:

`awp_design_call`, `awp_design_tools`, `awp_impact_preview`, `awp_loop_resume`, `awp_loop_sessions`, `awp_loop_wait`, `awp_skill_get`, `awp_skills_list`, `awp_task_attach`, `awp_task_attach_list`, `awp_test_active_specs`, `awp_test_explain`, `awp_test_list`, `awp_test_lookup`, `awp_test_run`, `awp_test_spec_get`, `awp_test_spec_review_status`, `awp_test_spec_submit`, `distill_append`, `distill_promote`, `distill_query`, `distill_review_queue`, `distill_set_status`, `drift_stats`, `generate_rule_pr`, `get_doc`, `harness_advance`, `harness_start`, `harness_status`, `lesson_record`, `list_docs`, `query_docs`, `task_state`, `update_doc`, `update_docs_batch`, `verify_report`, `weekly_report`.

## 5. Optional services

### Secret broker

The optional broker runs with the control plane when configured in ecosystem.config.cjs. Local certificates and broker data are excluded from Git. Generate development certificates with node scripts/gen-dev-pki.mjs <output-directory>.

## 6. Data and backups

The following are local runtime data and must not be committed:

- SQLite/PostgreSQL files, database backups, and content-addressed test artifacts.
- Bootstrap tokens, private keys, development certificates, and broker state.
- data/repo-platform.json and data/deploy.env.

Create a SQLite backup with `npm run backup -- --db data/team.db --out data/backups`. The backup manifest records its database dialect, schema version, SHA-256, size, integrity result, and local content-addressed artifact list. Restore with `npm run restore -- --backup <backup-file> --db <target.db> --dry-run`, inspect the verification output, then rerun without `--dry-run`. Restoring onto an existing SQLite target requires `--force`; the command keeps a timestamped copy of the replaced database. Stop the service first and remove/checkpoint any SQLite WAL sidecars. PostgreSQL backups use custom-format `pg_dump`, require `AWP_PG_URL` plus `pg_dump`/`pg_restore`, and restores require `--force` because they replace database objects in one transaction. Always verify a PostgreSQL restore against a scratch database before using it as a production recovery procedure.

## 7. Troubleshooting

- Native SQLite dependency fails to install: use a supported Node.js release and platform toolchain, then rerun npm install.
- MCP client reports an Accept-header error: use a Streamable HTTP MCP client that accepts both JSON and event-stream responses.
- A test submission reports an unknown repository: add the repository to the local profile or set its AWP_REPO_PATH_<SLUG> variable.
- A smoke run reports an unknown side: declare that side under the repository profile's smoke object.
- The worker does not claim runs: check worker heartbeat, active runner image, certificates, Hyper-V state, and data/logs/.
