# Reproducible run evidence pack

Download a run's evidence package from the evidence dialog or:

```http
GET /api/testing/runs/{runId}/evidence-pack
```

The deterministic ZIP contains:

- `manifest.json`: exact payload file list, byte sizes, and SHA-256 digests;
- `evidence.json`: run identity/status/timing, product and contract version, frozen snapshot/config digests;
- `suite-lock.json`: locked case keys, selection reasons, and revision digests without test source;
- `checks.json`: case keys, statuses, durations, and report attempt;
- `logs-summary.json`: attempt status, error code, phase summary, and bounded failed-step summaries;
- `artifacts.json`: artifact IDs, attempt, scan state, byte size, and manifest/archive/scanner hashes.

The package excludes source files, environment variables, secret references, raw artifacts, and unredacted log bodies. It is therefore a reviewable evidence snapshot, not a full reproduction environment.

Verify a downloaded file locally:

```sh
node scripts/verify-evidence-pack.mjs --file ./devweft-evidence-run-id.zip
```

The verifier checks the ZIP directory, rejects unlisted or unsafe paths, and verifies every listed file's byte size and SHA-256. A valid package confirms internal consistency; it does not attest that the run was trustworthy beyond the signatures and scanner results already recorded by DevWeft.
