# Dependency inventory

This file records why each direct package is present and which packages are needed only for development or optional deployments. Recheck it when changing `package.json`.

## Runtime dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP server protocol implementation. |
| `@open-policy-agent/opa-wasm` | Evaluate the configured OPA policy bundle in the control plane. |
| `acorn` | Parse JavaScript for static analysis and test-execution safety checks. |
| `ajv` | Validate local project check configuration against the published JSON Schema. |
| `better-sqlite3` | Default local SQLite database adapter. |
| `express` | HTTP API, dashboard, health, and MCP transport routes. |
| `pg` | Optional PostgreSQL adapter. |
| `zod` | Runtime validation of API and configuration inputs. |

## Development dependencies

| Package | Purpose |
|---|---|
| `@electric-sql/pglite` | Embedded PostgreSQL-compatible engine for migration and contract tests; not loaded by production code. |
| `@vitest/coverage-v8` | V8 coverage provider for Vitest. |
| `happy-dom` | DOM implementation used by dashboard and browser-facing unit tests. |
| `vitest` | Unit and integration test runner. |
| `yaml` | Parse the public OpenAPI YAML document during local release verification. |

## Optional deployment dependency

| Package | Purpose |
|---|---|
| `@embedded-postgres/windows-x64` | Optional bundled PostgreSQL server for the single-host Windows deployment path. External PostgreSQL and SQLite deployments do not require it. |

## Audit notes

- Run `npm audit` before a release and review advisories for both runtime and development dependencies.
- The latest published `@open-policy-agent/opa-wasm` release currently depends on `sprintf-js`; the published `sprintf-js` versions are covered by a [moderate-severity upstream advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) with no patched release listed. Do not mask this finding with a downgrade or an unreviewed package override. Recheck the upstream advisory before each release.
- On 2026-10-15, the full `npm audit --audit-level=high` reported zero high/critical advisories and two moderate package entries for this same dependency chain. The suggested forced OPA downgrade is a breaking change and was not applied.
- Current exposure assessment: the only shipped `sprintf` call is in [`mandatory.rego`](../policies/mandatory/mandatory.rego), with a fixed format string and mode values passed as arguments. Tenant bundles are discovered from local files by [`opa-policy.js`](../harness/opa-policy.js); the shipped API has no policy-bundle upload route. Both current OPA call sites convert evaluation errors into fail-closed results. This is a source-based assessment of the current defaults, not a claim that the dependency is fixed: custom tenant policies must never use untrusted input as a format string, and operators should keep tracking the upstream patch.
- `npm run verify:release` validates the local dependency tree and lockfile without requiring network access. Pass `--audit` to audit the full runtime and development dependency graph; this option requires network access and fails on high or critical advisories.
