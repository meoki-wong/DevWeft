# Test baseline and public fixture migration

## Initial snapshot

Captured on 2026-10-15 from `codex/devweft-public` before implementation changes:

```text
npx vitest run --reporter=json --outputFile=/tmp/devweft-vitest-baseline.json
408 test files discovered; 1111 tests reported; 1088 passed; 23 failed.
The PostgreSQL RLS suite also timed out in its beforeAll hook before running assertions.
```

This is a diagnostic snapshot, not the current result. The failures were grouped by cause before changing code or expectations.

| Area | Initial failure | Classification | Implemented correction |
|---|---|---|---|
| Contracts | `test/contracts.test.mjs` read deleted `docs/TEST-PLATFORM-ENTERPRISE.md` | Stale documentation source | Make `contracts/errors.md` authoritative and sync OpenAPI to it. |
| Documentation | `test/docs-freshness.test.mjs` could not find the tool-count headings or current tool names | Missing public documentation | Document the 36 registered MCP tools in README and ONBOARDING. |
| Tenant slug | `test/ensure-tenant-repo.test.mjs` expected `test-new-repo` after lowercasing `Sample-New-Repo` | Stale expectation | Expect the actual normalized slug, `sample-new-repo`. |
| Asset order | `test/gate-execution-evidence.test.mjs` expected input order although the frozen asset lock sorts by key | Stale expectation | Assert the deterministic lock order. |
| Git portability | `test/guest-mutation.test.mjs` checked out an implicit `master` branch | Platform assumption | Initialize the fixture repository on explicit `main`. |
| Blob URL | `test/remote-blob-store.test.mjs` supplied the same loopback URL for contradictory fallback expectations | Fixture defect | Test a non-loopback `links.primary` URL separately from loopback fallback. |
| Review result | `test/review-plugin.test.mjs` expected `approved` when contract review is not enabled | Overstated test contract | Assert `abstain`; `record` mode must not claim a review happened. |
| PostgreSQL RLS | `test/rls-tenant.test.mjs` exceeded Vitest's default 10-second hook timeout during PGlite setup | Test environment configuration | Give database setup hooks the same bounded 60-second allowance as tests. |
| Tenant checks | `test/tenant-config.test.mjs` ran a Windows-only `cmd.exe` implementation on macOS | Cross-platform product defect | Select the native command shell by platform and keep failure fixtures portable. |
| E2E template | `test/test-engine-full.test.mjs` found that `GOLDEN_E2E_SPEC` did not meet the engine's own network/data assertion rule | Product fixture defect | Make the golden example exercise a network response and a meaningful page assertion. |
| Example artifacts | `test/testing-artifacts.test.mjs` copied a fixture from a removed `suites/demo-app` directory | Missing public fixture | Add a generic `example-app` and use its checked-in fixture. |
| Suite registry and smoke | `test/testing-m1.test.mjs`, `test/testing-m2.test.mjs`, and `test/testing-m3-smoke.test.mjs` assumed removed built-in demo suites and smoke profiles | Missing public example/profile | Add stable and repository overlays plus explicit smoke profile data for `example-app`. |
| Runner image lifecycle | `test/testing-m3-image.test.mjs` expected a retired image identifier instead of the configured default | Stale image identifier | Use `DEFAULT_IMAGE_ID` so tests follow the declared deployment profile. |

## Public sample contract

`examples/example-app` is the dependency-free application sample. It provides deterministic Node tests, a small HTTP API, and build scripts for its two optional browser smoke lanes. `suites/example-app` holds the stable and repository test overlays and reusable fixtures. `data/repo-platform.example.json` points at this sample; it remains an example that users copy into the ignored local configuration file.

The sample must not require a private Git provider, network service, secret, Windows image, or internal repository. A successful test of the sample does not imply that Hyper-V or a real PostgreSQL server was exercised.

## Reproduction and current status

Run the full baseline with:

```sh
npm test
```

After B01, `npm test -- --reporter=dot` completed with 131 test files passed, 1105 tests passed, and 6 skipped. After B02 added four migration/readiness cases, the suite completed with 131 test files passed, 1109 tests passed, and 6 skipped. After D01 and D02, `npm run verify:release` completed with 136 test files passed, 1123 tests passed, and 6 skipped. After D03, the same release gate completed with 138 test files passed, 1138 tests passed, and 6 skipped. After F02, the release gate completed with 141 test files passed, 1158 tests passed, and 6 skipped. After F02A and F03, `npm run verify:release` completed with 142 test files passed, 1162 tests passed, and 6 skipped. The release script caps Vitest at four file workers so multiple PGlite instances do not exceed the 60-second database setup hook under high reported CPU counts. The skips are guarded by unavailable PostgreSQL, Playwright package, or Chromium prerequisites. The public example's own `npm test` passed 2/2, and both `build:web` and `build:admin` completed. These results cover the local test environment only; they do not verify a real PostgreSQL server, Windows host, or Hyper-V deployment. The latest release-gate run did not include the optional network audit.

After F07 added migration v43 and X02 completed contributor documentation, `npm run verify:release` completed with 147 test files passed, 1178 tests passed, and 6 environment-guarded skips. The release script's residue, configuration, and dependency checks also passed. The optional network audit was not run. The three stale schema-version assertions in backup and readiness tests were updated from 42 to 43 to match the migration manifest and API response.

After the public bootstrap instructions, standby dashboard-link fallback, retired-brand, credential, common CI-path, and sample-build ignore checks, the latest release verification passed with 147 test files, 1185 tests passed, and 7 environment-guarded skips. The skips explicitly represent unavailable real PostgreSQL and offline Playwright/Chromium prerequisites. The four Windows CMD entrypoints, configuration contracts, dependency tree, public-residue checks, and optional full dependency audit also passed; the audit reported two moderate transitive advisories and no high or critical advisories.

The full runtime and development dependency audit was also run on 2026-10-15. It reported no high or critical advisories, and two moderate entries for the same upstream `@open-policy-agent/opa-wasm` → `sprintf-js` dependency issue. No patched `sprintf-js` release is available; the audit suggests a breaking OPA downgrade, so that change was not applied. See [dependency inventory](DEPENDENCIES.md) before publishing.

An additional isolated local startup smoke used a temporary SQLite database and the public `example-app` profile. It bootstrapped the sample, started the control plane without a worker, and verified `/api/health/ready` = 200, `/dashboard.html` = 200, MCP `initialize` and `tools/list` = 200, and the presence of `awp_test_explain`. Temporary database, signing-key, and blob directories were removed afterward. This verifies the basic macOS control-plane path; it does not substitute for the W01–W09 Windows/Hyper-V/PostgreSQL matrix.

The implementation record in `docs/implementation-records/` tracks each work package's target tests and unresolved environment-specific checks. Update this file after each baseline-relevant correction; do not change a production assertion solely to make the count green.
