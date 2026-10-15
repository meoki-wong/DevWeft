# DevWeft

A self-hosted AI engineering workflow platform that connects coding tools to team knowledge, task workflows, test assets, and optional isolated test execution through MCP and HTTP APIs.

## Project status

This is an early public release. The generic control plane and deployment entry points are available, while parts of the legacy test suite still need to be adapted to the public demo profile. `npm test` currently has failing cases; see the test output before relying on the optional VM worker.

## Features

- MCP tools for shared knowledge, engineering records, task workflows, and test submissions.
- Multi-repository data isolation and per-repository workspace profiles.
- A browser dashboard for tasks, test runs, artifacts, and service health.
- SQLite by default, with an optional PostgreSQL adapter.
- An optional Windows Hyper-V worker for isolated Node.js and Playwright runs.

## Requirements

- Node.js 22 or newer.
- npm.
- Git for repository snapshots and workspace isolation.
- A Windows edition that supports Hyper-V only when using the isolated VM worker.

## Quick start

```sh
npm install
npm run db:init
npm run bootstrap
npm start
```

The server listens on port `8787` by default. Set `PORT` to change it. Open `http://127.0.0.1:8787/dashboard.html`; the health endpoint is `http://127.0.0.1:8787/api/health`.

Bootstrap writes its local token and summary under `data/`. Those generated files are ignored by Git.

## Repository profiles

Copy `data/repo-platform.example.json` to the ignored `data/repo-platform.json`, then configure workspace paths with environment variables or profile values. Environment variable names follow `AWP_REPO_PATH_<SLUG>`, with non-alphanumeric characters replaced by underscores and the result uppercased.

```sh
AWP_DEFAULT_REPO=demo-app
AWP_REPO_PATH_DEMO_APP=/path/to/demo-app
```

Profiles can declare smoke commands, sides, a suite directory, a case prefix, and a starting gate mode. New repositories default to the `observe` gate mode; choose a stricter mode after configuring and validating that repository's checks.

## Optional integrations

### Isolated Windows worker

The control plane runs without Hyper-V and can be deployed with the npm commands above on Windows, macOS, or Linux. Windows also has four click-to-run entry points:

- `deploy.cmd` performs the full Windows deployment and starts the PM2 services. If needed, it installs Node.js LTS and Git with `winget`.
- `start-primary.cmd` starts or restarts all services on the primary worker host.
- `start-standby.cmd` starts only a configured standby control plane.
- `start.cmd` runs the standalone control plane in the foreground.

See [ONBOARDING.md](./ONBOARDING.md) for prerequisites, standby configuration, and Hyper-V setup.

## Development

```sh
npm test
npm run test:watch
npm run test:coverage
npm run policies:build
```

See [ONBOARDING.md](./ONBOARDING.md) for storage, MCP connection, repository profiles, and optional worker setup.

## License

DevWeft is licensed under the [MIT License](./LICENSE).
