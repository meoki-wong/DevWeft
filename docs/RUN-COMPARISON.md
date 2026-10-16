# Run comparison

The run evidence dialog can compare two runs from the same formal round. The dashboard API also supports explicit comparison:

```http
GET /api/testing/runs/{runId}/compare?against={otherRunId}
```

The response includes frozen suite lock and required-case-set digests, execution profile digest, runner image manifest digest, policy digest, lane, purpose, observed case keys, status changes, failed checks, elapsed time and the before/after denominators.

Case additions and removals are returned before outcome interpretation. `comparable` is true only when both runs have the same repository, unit, side, purpose, frozen configuration, and observed case-key set. If any of those differ or a required frozen value is missing, the response retains the raw evidence and explains why an overall outcome or duration comparison is not direct. Cross-repository and missing-run comparisons are rejected.

`durationDeltaMs` is `right - left`; it is `null` when either run has no recorded duration. Per-check status changes are still visible for common case keys even when the overall runs are not comparable. The denominator describes report checks returned by each run, not cases that were expected but never reported.
