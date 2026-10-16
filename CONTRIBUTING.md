# Contributing to DevWeft

Thanks for helping improve DevWeft. Contributions should work from the public repository and its checked-in fixtures; no private service, account, or dataset is required for the standard development loop.

## Development setup

Requirements: Node.js 22.12+, 24+, or 26+, npm, and Git. SQLite is local and is the default; PostgreSQL, Windows, Hyper-V, and the secret broker are optional for ordinary code changes.

```sh
git clone https://github.com/meoki-wong/DevWeft.git
cd DevWeft
npm ci
npm test
```

Run a focused test while iterating, then run the release gate before submitting:

```sh
npm test -- test/project-config.test.mjs
npm run verify:release
```

The release gate checks public residue, JSON/OpenAPI and deployment contracts, installed runtime dependencies, and the complete Vitest suite. It does not audit the npm registry unless invoked with `npm run verify:release -- --audit`; that option checks the full runtime and development dependency graph.

The offline sample is in `examples/example-app`; its reusable test assets are in `suites/example-app`. To verify the public sample without installing extra dependencies:

```sh
cd examples/example-app
npm test
npm run build:web
npm run build:admin
```

To try the application, follow the root [README quick start](README.md). For onboarding another Git checkout, use `npm run devweft -- project add <path>` from the repository root; it previews changes by default and writes only with `--apply`. Local configuration and runtime data are under ignored paths in `data/`.

## Change workflow

1. Read [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md), and the relevant feature document before changing a subsystem.
2. Keep changes scoped to one behavior. Preserve existing API and stored-data compatibility unless the change intentionally introduces a versioned contract.
3. Add or update tests at the owning layer. Use the public fixture and deterministic dependencies; tests must not require a private URL, token, machine, or repository.
4. For database changes, follow the migration rules below and include upgrade/readiness coverage.
5. Update user-facing docs and any implementation record or test baseline affected by the change.
6. Run `git diff --check`, focused tests, and `npm run verify:release` before asking for review.

## Database migration rules

- Treat an applied migration as immutable. Do not edit a released migration SQL file or rewrite its manifest checksum.
- Add a forward migration and update the SQLite migration manifest in `testing/migrate.js`. PostgreSQL changes must also be reflected in its patch-up path and generated baseline as applicable.
- Regenerate `sql/postgres/baseline.sql` with `node scripts/gen-postgres-baseline.mjs` when the baseline source changes; do not hand-edit generated SQL.
- Add tests for a fresh database, an existing supported schema where relevant, repeat application, and failure behavior. The migration ledger must remain unchanged when validation fails.
- Run `npm run db:init` and `npm run postgres:check` for the database path being changed. PGlite tests exercise PostgreSQL compatibility but do not replace a real PostgreSQL deployment check.

## Adding an extension

Use the interfaces in `extensions/contracts.js` and read [extension contracts](docs/EXTENSIONS.md). Keep optional provider SDKs in adapter modules, leave the core default offline/local, and translate provider errors to stable extension codes.

Add contract tests for normal output, malformed inputs, intentionally unsupported calls, and temporary service failures. Use [`examples/extensions/example-design-source.mjs`](examples/extensions/example-design-source.mjs) as an offline reference. An adapter's advertised capabilities must not change existing permission, isolation, or secret rules.

## Documentation and issue reports

Document new configuration in the example env/profile file and [configuration reference](docs/CONFIGURATION.md). Document observable API behavior in its contract and feature guide. Keep examples runnable from the repository root.

When reporting a bug, include the platform, Node.js version, command, sanitized error output, and the smallest reproducible public fixture. Remove passwords, tokens, private repository paths, employee or customer data, and raw source artifacts from logs and attachments.

## Pull request checklist

- [ ] The change has a focused test or a clear reason why no test is needed.
- [ ] `npm run verify:release` passes locally.
- [ ] `git diff --check` passes.
- [ ] Public docs and schemas match the implementation.
- [ ] No generated credentials, internal URLs, private artifacts, or local runtime files are included.
- [ ] Any environment-specific validation limits are stated plainly.

There is no required CI provider configuration in this repository. Maintainers can run the same local release gate from any supported development environment.
