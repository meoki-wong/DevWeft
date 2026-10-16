# Configuration reference

This page documents the supported public configuration entry points. The checked-in `.example` files are the canonical list for deployment profiles; optional code-level tuning flags may be added over time and are not all deployment settings.

## Configuration sources

| Source | Used by | Notes |
|---|---|---|
| Process environment | Node.js app, CLI, scripts | Takes precedence when a key is already set in the process environment. |
| `data/deploy.env` | Primary/local deployment and Node.js commands that use `--import=./scripts/load-deployment-env.mjs` | Copy from `data/deploy.env.example`; ignored by Git. Node's env-file loader does not overwrite an already-set process variable. |
| `data/node.env` | Standby startup | Copy from `data/node.env.example`; ignored by Git and loaded by the standby PowerShell entry point. |
| `data/repo-platform.json` | Repository profile resolver | Copy from `data/repo-platform.example.json`; local workspace paths belong here or in per-repository environment variables. |
| `<repo>/.awp/config.json` | Project check runner | Portable project checks, validated against `schemas/project-config.schema.json`. |

Never commit real credentials, generated bootstrap tokens, private keys, certificates, database files, backups, or local repository paths. Keep secrets in an ignored local env file or the deployment's secret manager. Do not place credentials in command-line arguments or support bundles.

## Local and primary deployment

Copy `data/deploy.env.example` to `data/deploy.env`. SQLite is the default and needs no extra database setting.

| Variable | Example/default | Meaning |
|---|---|---|
| `NODE_ENV` | `production` in the example standby file; otherwise runtime-defined | Node runtime mode. |
| `PORT` | `8787` for standalone `npm start` | Standalone HTTP/MCP listening port. |
| `AWP_DB_DIALECT` | `sqlite` | `sqlite` or `postgres`. |
| `AWP_PG_MODE` | `external` | PostgreSQL setup mode: externally managed database, or Windows single-host `embedded` deployment. |
| `AWP_PG_URL` | unset for SQLite | PostgreSQL connection string. Required when PostgreSQL is selected. Keep it private. |
| `AWP_PG_DATA_DIR` | `data/pgdata` when embedded mode is configured | Local bundled PostgreSQL data directory. Windows single-host mode only. |
| `AWP_PG_PORT` | `5432` | Local bundled PostgreSQL port. |
| `AWP_PG_DATABASE` | `awp_platform` | Database name used by the bundled setup helper. |
| `AWP_CONTROL_PORT` | `8791` | PM2 primary/standby control-plane port. |
| `AWP_GATEWAY_PORT` | `8787` | PM2 gateway port. |
| `AWP_BLOB_PORT` | `8792` | Separate blob service port for PostgreSQL deployments. |
| `AWP_BLOB_ROOT` | `data/blobs` | Authoritative local content-addressed artifact directory. |
| `AWP_BLOB_BASE_URL` | unset on primary/standby | Explicit standby URL for the primary artifact endpoint. When omitted on a standby, the app resolves the shared database's non-loopback dashboard primary link. |
| `AWP_BROKER_PORT` | `8788` | Optional secret broker port. |
| `AWP_RUNNER_ROOT` | `data/runner` | Local runner images and attempt workspace root. |
| `AWP_GIT_REMOTE_URL` | unset | Optional Git remote registered by bootstrap. |
| `AWP_SIGNING_KEY_DIR` | `data/signing-keys` | Local signing-key directory; do not publish its contents. |
| `AWP_HYPERV_ENABLED` | `false` | Explicitly enables the optional Windows Hyper-V host setup. |
| `AWP_RUNNER_BACKEND` | deployment-selected | `hyperv` for VM-backed execution, or `local` for trusted static checks without VM isolation. |
| `AWP_VM_NETWORK_CIDR` | `192.168.250.0/24` | Unused private `/24` reserved for the isolated Hyper-V network. Preflight checks for conflicts. |
| `AWP_VM_SWITCH_NAME` | `awp-isolated` | Name of the internal Hyper-V switch. |

The PM2 ports and standalone `PORT` serve different deployment entry points. `deploy.cmd` and the `start-*.cmd` scripts use the role-specific settings described in [Setup and operations](../ONBOARDING.md).

## Standby node

Copy `data/node.env.example` to `data/node.env` on the standby and set its host-specific values:

| Variable | Required | Meaning |
|---|---:|---|
| `NODE_ENV` | No | Runtime mode. |
| `PORT` | No | Standby control-plane port; example is `8791`. |
| `AWP_DB_DIALECT` | Yes | Use `postgres` for a shared primary/standby database. |
| `AWP_PG_URL` | Yes | Same externally managed PostgreSQL database used by the primary. |
| `AWP_BLOB_BASE_URL` | No | Explicit reachable primary blob endpoint. If unset, the standby resolves the non-loopback primary link stored in the shared database by the dashboard link pool. There is no standby local cache. |
| `AWP_STANDBY` | Yes | Set to `1` to activate standby behavior. |

For control-plane failover, set this explicitly to the primary's separate blob endpoint (default port `8792`). The dashboard primary-link fallback is useful when that primary link serves blob routes, but it may be unavailable during a primary control-plane restart.

SQLite and embedded PostgreSQL are single-host configurations and do not provide shared-database failover.

## Repository profiles

The local `data/repo-platform.json` maps repository slugs to workspaces and test-suite settings. The public starter file is [`data/repo-platform.example.json`](../data/repo-platform.example.json). Common settings are:

| Field | Purpose |
|---|---|
| `workspaceEnv` / `workspacePath` | Resolve the local working tree. Prefer an environment variable for machine-specific paths. |
| `workspaceCandidates` | Ordered fallback paths for local development. |
| `suiteSlug` | Selects the suite assets under `suites/<suiteSlug>/`. |
| `casePrefix` | Restricts which cases belong to a repository profile. |
| `defaultSides` | Default test sides for a run. |
| `smoke` | Explicit side-to-build/entry/output mapping for browser smoke lanes. |
| `gateMode` | `observe` is the safe default for a newly onboarded repository; strengthen it after validating evidence. |
| `enabled` | Enables or disables a profile without deleting it. |

`AWP_DEFAULT_REPO` selects the default slug. `AWP_REPO_PATH_<SLUG>` overrides a local workspace path; replace non-alphanumeric characters in the slug with underscores and uppercase the result. Example: `AWP_REPO_PATH_MY_SERVICE`.

Use `npm run devweft -- project add <path>` to preview a profile. Add `--apply` to write it to the ignored local profile file. The command does not upload source code or secrets.

## Project test configuration

Project checks live in `<repo>/.awp/config.json` and use `command` as an argv array. Commands are started without a shell. Existing string-based `checks[].script` entries must be migrated to argv arrays.

```json
{
  "$schema": "https://raw.githubusercontent.com/meoki-wong/DevWeft/main/schemas/project-config.schema.json",
  "schemaVersion": 1,
  "checks": [
    {
      "id": "unit-tests",
      "name": "Unit tests",
      "command": ["npm", "test", "--", "--run"],
      "timeoutSeconds": 120
    }
  ]
}
```

Validate the config with `npm run devweft -- project validate <repo-path>`. The schema also supports `skills`, `rules`, and `acTemplate`; see the schema for size and naming limits.

## Optional design provider

The design-source extension is offline/disabled by default. The optional Lanhu adapter only becomes active when `AWP_LANHU_MCP_URL` is explicitly configured. Keep provider tokens outside tracked files and use the offline fixture in `examples/extensions/example-design-source.mjs` for adapter development.

## Find a setting's implementation

The example env files define supported deployment settings. For additional runtime tuning flags, search the source for the exact `process.env.AWP_...` name and check its default and consumer before using it. Do not assume an undocumented flag is stable across releases.
