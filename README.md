# DevWeft

A self-hosted AI engineering workflow platform that connects coding tools to team knowledge, task workflows, test assets, and optional isolated test execution through MCP and HTTP APIs.

## Project status

DevWeft is an open-source project. The SQLite control plane runs on Windows, macOS, and Linux; the isolated Hyper-V worker is an optional Windows deployment mode.

## Features

- MCP tools for shared knowledge, engineering records, task workflows, and test submissions.
- Multi-repository data isolation and per-repository workspace profiles.
- A browser dashboard for tasks, test runs, artifacts, and service health.
- SQLite by default, with an optional PostgreSQL adapter.
- An optional Windows Hyper-V worker for isolated Node.js and Playwright runs.

## Requirements

- Node.js 22.12+, 24+, or 26+ (matching the test runner's supported releases).
- npm.
- Git for repository snapshots and workspace isolation.
- A Windows edition that supports Hyper-V only when using the isolated VM worker.

## Quick start

```sh
npm ci
cp data/deploy.env.example data/deploy.env
cp data/repo-platform.example.json data/repo-platform.json
npm run db:init
AWP_DEFAULT_REPO=example-app npm run bootstrap
npm start
```

The server listens on port `8787` by default. Set `PORT` to change it. Open `http://127.0.0.1:8787/dashboard.html`; the health endpoint is `http://127.0.0.1:8787/api/health`.

Bootstrap writes its local token and summary under `data/`. Those generated files are ignored by Git.

## Repository profiles

The repository profile example points at `examples/example-app`. Copy it to the ignored `data/repo-platform.json` before bootstrapping. Configure other workspace paths with environment variables or profile values. Environment variable names follow `AWP_REPO_PATH_<SLUG>`, with non-alphanumeric characters replaced by underscores and the result uppercased.

```sh
AWP_DEFAULT_REPO=example-app
AWP_REPO_PATH_EXAMPLE_APP=/path/to/example-app
```

Profiles can declare smoke commands, sides, a suite directory, a case prefix, and a starting gate mode. New repositories default to the `observe` gate mode; choose a stricter mode after configuring and validating that repository's checks. Run the sample app's `npm test` from `examples/example-app` to verify its deterministic tests.

For a local Git repository, let the CLI identify its Git root and package name, then preview and apply an ignored profile without uploading repository contents:

```sh
npm run devweft -- project add ../my-app
npm run devweft -- project add ../my-app --apply
```

The command defaults to dry-run. It writes `data/repo-platform.json` only with `--apply`; the file is local and ignored by Git. Review the generated profile before adding smoke lanes or choosing a stricter gate mode.

Choose a project check template and validate the repository configuration with:

```sh
npm run devweft -- project template node-unit ../my-app
npm run devweft -- project template node-unit ../my-app --apply
npm run devweft -- project validate ../my-app
```

Available templates are `node-unit`, `playwright-web`, and `http-api`. They add checks to `.awp/config.json`; the argv-based schema is [project-config.schema.json](schemas/project-config.schema.json). The Playwright template expects the repository to install `@playwright/test`; the HTTP API template expects tests under `tests/api`. Existing string-based `checks[].script` commands must be migrated to `checks[].command` arrays before they can run; shell command strings are no longer executed.

## Optional integrations

### Isolated Windows worker

The control plane runs without Hyper-V and can be deployed with the npm commands above on Windows, macOS, or Linux. Windows also has four click-to-run entry points:

- `deploy.cmd` performs the full Windows deployment and starts the PM2 services. If needed, it installs Node.js LTS and Git with `winget`.
- `start-primary.cmd` starts or restarts all services on the primary worker host.
- `start-standby.cmd` starts only a configured standby control plane.
- `start.cmd` runs the standalone control plane in the foreground.

See [ONBOARDING.md](./ONBOARDING.md) for prerequisites, standby configuration, and Hyper-V setup.
See [architecture](docs/ARCHITECTURE.md) for component boundaries, [configuration reference](docs/CONFIGURATION.md) for deployment and project settings, and [contributing guide](CONTRIBUTING.md) for the offline development and release-verification workflow.

For trusted development repositories, the optional local process backend can run static checks without a VM: set `AWP_RUNNER_BACKEND=local` in `data/deploy.env`, then start the host worker. It executes project code with the host user's permissions and is not an isolation boundary; smoke runs and secret-bearing runs are not claimed by this backend.

Use `awp_test_explain` or `GET /v1/test-runs/{runId}/explain` to inspect the frozen lane, suite cases, profile, image, and policy choices for a run. See [decision explanation](docs/DECISION-EXPLAIN.md) for the stable reason codes.

The run evidence dialog also provides same-repository failure diagnostics and reviewed experiences. Suggestions can be confirmed or ignored; feedback is appended to the audit log. See [failure diagnostics](docs/FAILURE-DIAGNOSTICS.md) for the API and evidence rules.

The same evidence dialog compares runs within a formal round. Added/removed cases are shown before outcomes, and runs with different frozen configurations or denominators are marked incomparable. See [run comparison](docs/RUN-COMPARISON.md) for metric semantics.

You can also download a deterministic, redacted evidence package for a run and verify its manifest and file hashes locally with `node scripts/verify-evidence-pack.mjs --file <path>`. It contains run metadata and artifact hashes, not source code or raw log archives. See [evidence package](docs/EVIDENCE-PACK.md).

Contributors can submit structured failure resolutions from the diagnostic tab. Submissions remain unverified until a maintainer reviews them; see [experience feedback](docs/EXPERIENCE-FEEDBACK.md) for the API and state transitions.

The dashboard's **测试趋势** page shows evidence-backed pass rates, failure categories, coverage, and duration by repository. Each rate displays its denominator; skipped or incomplete evidence is never counted as passing. See [testing trends](docs/TESTING-TRENDS.md).

Provider integrations use small validated adapter contracts for Git, design sources, runner backends, and blob storage. The Lanhu connector is disabled unless configured. See [extension contracts](docs/EXTENSIONS.md) and its offline fixture example.

## 37 个 MCP 工具

The MCP server exposes these tools:

| Area | Tools |
|---|---|
| Knowledge and documents | `get_doc`, `list_docs`, `query_docs`, `update_doc`, `update_docs_batch`, `distill_append`, `distill_query`, `distill_review_queue`, `distill_set_status`, `distill_promote`, `lesson_record` |
| Tasks and workflow | `harness_start`, `harness_status`, `harness_advance`, `task_state`, `awp_loop_sessions`, `awp_loop_wait`, `awp_loop_resume`, `awp_task_attach`, `awp_task_attach_list` |
| Tests and quality | `awp_test_list`, `awp_test_lookup`, `awp_test_run`, `awp_test_explain`, `awp_test_spec_get`, `awp_test_spec_submit`, `awp_test_spec_review_status`, `awp_test_active_specs`, `awp_impact_preview`, `verify_report`, `drift_stats`, `weekly_report` |
| Engineering records | `awp_skill_get`, `awp_skills_list`, `awp_design_tools`, `awp_design_call`, `generate_rule_pr` |

## Development

```sh
npm ci
npm test
npm run test:watch
npm run test:coverage
npm run policies:build
npm run verify:release
```

See [ONBOARDING.md](./ONBOARDING.md) for storage, MCP connection, repository profiles, and optional worker setup.

## License

DevWeft is licensed under the [MIT License](./LICENSE).
