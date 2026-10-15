# Setup and operations

This guide covers the control plane and optional test execution worker. The server can run without a worker; queued execution requires a configured runner.

## 1. Start the control plane

Use Node.js 22 or newer.

~~~sh
npm install
npm run db:init
npm run bootstrap
npm start
~~~

The server defaults to http://127.0.0.1:8787. Set PORT to use another port. Bootstrap creates the initial administrator and writes local bootstrap metadata into ignored files under data/.

SQLite is the default. PostgreSQL is optional. On a single Windows host, set `AWP_DB_DIALECT=postgres` and `AWP_PG_MODE=embedded` in the ignored `scripts/deploy.env`; `deploy.cmd` initializes the bundled local PostgreSQL instance, applies the schema and RLS scripts, and stores the generated connection string in ignored configuration. This embedded mode is for a single host only.

For a primary/standby pair, use an externally managed PostgreSQL database reachable from both machines. Set `AWP_DB_DIALECT=postgres`, `AWP_PG_MODE=external`, and `AWP_PG_URL`. Before deployment, initialize the empty database with a PostgreSQL owner account:

~~~sh
psql "$AWP_PG_URL" -v ON_ERROR_STOP=1 -f sql/postgres/baseline.sql
psql "$AWP_PG_URL" -v ON_ERROR_STOP=1 -f sql/postgres/rls.sql
~~~

Grant `awp_tenant` and `awp_worker` to the database login used in `AWP_PG_URL`. Deployment registers the baseline, applies forward migrations, and checks connectivity, roles, role membership, and row-level security. Use the same database URL on the standby host. Keep credentials out of Git.

### Windows one-click entry points

Run these from the repository root on Windows. `deploy.cmd` checks for Node.js 22+ and Git, and uses `winget` to install missing prerequisites when available. The other commands require the deployment prerequisites to be installed.

| File | Purpose |
|---|---|
| `deploy.cmd` | First Windows deployment: Git/Node prerequisites, dependency install, selected database setup, PM2 services, and health checks. Hyper-V host setup is optional and requires an edition that supports Hyper-V. |
| `start-primary.cmd` | Start or restart the full PM2 service set on the primary host. |
| `start-standby.cmd` | Start only the standby control-plane process after configuring `data/node.env`. |
| `start.cmd` | Start the standalone control plane in the foreground. |

The primary and standby hosts share one PostgreSQL database when running as a failover pair. The embedded PostgreSQL option is local-only and cannot serve the standby unless you separately configure and secure remote access. For a single-node install, SQLite is ready to use without database installation.

In PM2 host mode, the gateway defaults to port `8787` and the control plane to `8791`. `start.cmd` runs the standalone control plane on port `8787` for local use.

Useful commands:

| Command | Purpose |
|---|---|
| npm start | Start the HTTP and MCP server |
| npm run db:init | Create or migrate the local database |
| npm run bootstrap | Create the initial administrator and default repository |
| npm run backup | Back up SQLite or PostgreSQL data |
| npm test | Run the Vitest suite |
| npm run test:coverage | Run tests with coverage |
| npm run policies:build | Rebuild policy bundles |

## 2. Connect an MCP client

The server exposes Streamable HTTP at /mcp. A minimal client configuration is:

~~~json
{
  "mcpServers": {
    "workflow-platform": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp?repo=demo-app"
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

Set a workspace path per repository. For a slug such as demo-app, the environment key is AWP_REPO_PATH_DEMO_APP:

~~~sh
AWP_DEFAULT_REPO=demo-app
AWP_REPO_PATH_DEMO_APP=/work/demo-app
~~~

Each profile can define:

- workspaceEnv, workspacePath, and optional workspaceCandidates.
- smoke, mapping a side name to its build command, entry page, and output directory.
- defaultSides, casePrefix, and suiteSlug.
- gateMode, which defaults to observe for a newly configured repository.
- enabled, to turn the profile off without removing it.

Smoke commands are read from the profile and frozen into each run. The platform does not supply business-project build commands. Define suite assets under suites/<suiteSlug>/stable and suites/<suiteSlug>/repo when using the suite registry.

## 4. Configure a test worker

The worker is optional. The included VM lane currently targets Windows with Hyper-V; the control plane and MCP server do not require Windows.

The worker needs:

1. A runner image and matching image manifest.
2. Worker and broker certificates under the local, ignored secret-broker/dev-certs/ directory.
3. A private runner root, such as `data/runner`, with the image and attempt directories.
4. Repository workspace profiles on the host that creates source snapshots.
5. A local npm proxy configuration when guest VMs need package installation.

The Windows deployment helper configures the bundled PM2 services and optional Hyper-V worker. `deploy.cmd` launches it with an elevation prompt. On supported Windows editions, it enables the Hyper-V feature and requests a restart if needed; rerun `deploy.cmd` after restarting to finish the host setup. It creates an internal switch, assigns the isolated host address, opens the npm proxy port to the guest CIDR, and blocks the control-plane ports. The switch name can be changed with `AWP_VM_SWITCH_NAME`; the worker's isolated address range is fixed at `192.168.250.0/24` so host, guest, proxy, and firewall settings stay aligned.

Hyper-V is optional for the control plane. VM execution also needs a prepared Windows runner image at `data/runner/images/golden.vhdx` and a matching image manifest. The repository does not include Windows installation media or a prebuilt Windows image; provide an appropriately licensed image before expecting VM runs to execute. Deployment verification reports when the image is missing.

You can also run the deployment helper directly from PowerShell:

~~~powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\deploy-test-platform.ps1
~~~

The deployment accepts `-ControlPort`, `-BrokerPort`, `-RunnerRoot`, `-SwitchName`, `-SkipHyperV`, `-SkipNpmCi`, `-SkipPm2`, `-SkipVerify`, `-ForcePki`, `-RotateToken`, `-RunTests`, and `-InstallStartup`. `scripts/verify-test-platform.ps1` can be run separately after deployment.

For a standby host, copy `data/node.env.example` to `data/node.env`, then set the primary PostgreSQL URL and blob-store URL. Start it with `start-standby.cmd`. If the standby must submit artifacts, copy the primary's `data/bootstrap-admin.token` through a secure channel to the same ignored path on the standby. The startup script never creates a shared default token.

~~~cmd
copy data\node.env.example data\node.env
notepad data\node.env
~~~

The isolated network helpers live in scripts/windows/. They create an internal Hyper-V switch and firewall rules for the npm proxy while blocking access to the control-plane ports.

## 5. Optional services

### Secret broker

The optional broker runs with the control plane when configured in ecosystem.config.cjs. Local certificates and broker data are excluded from Git. Generate development certificates with node scripts/gen-dev-pki.mjs <output-directory>.

## 6. Data and backups

The following are local runtime data and must not be committed:

- SQLite/PostgreSQL files, database backups, and content-addressed test artifacts.
- Bootstrap tokens, private keys, development certificates, and broker state.
- data/repo-platform.json and data/deploy.env.

Create a SQLite backup with npm run backup. PostgreSQL backups use pg_dump and require AWP_PG_URL plus the PostgreSQL client tools.

## 7. Troubleshooting

- Native SQLite dependency fails to install: use a supported Node.js release and platform toolchain, then rerun npm install.
- MCP client reports an Accept-header error: use a Streamable HTTP MCP client that accepts both JSON and event-stream responses.
- A test submission reports an unknown repository: add the repository to the local profile or set its AWP_REPO_PATH_<SLUG> variable.
- A smoke run reports an unknown side: declare that side under the repository profile's smoke object.
- The worker does not claim runs: check worker heartbeat, active runner image, certificates, Hyper-V state, and data/logs/.
