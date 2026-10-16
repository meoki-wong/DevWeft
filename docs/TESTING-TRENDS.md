# Evidence-backed testing trends

Open the dashboard's **测试趋势** page or query:

```http
GET /api/testing/trends?repo=example-app&days=30&bucket=day
```

`days` is bounded to 1–366. `bucket` is `day` or `week`; `unit` and `side` optionally narrow the data. The route supports inclusive UTC `from=YYYY-MM-DD` and `to=YYYY-MM-DD` dates; `to` is converted to the next UTC midnight for an exclusive SQL boundary. A single repository is required so unrelated project denominators are not mixed.

The response provides per-bucket and overall counts, failure categories, reported check pass rate, complete-coverage gate pass rate, and mean gate duration. Every rate includes its numerator and denominator.

- Check pass rate = `passed / (passed + failed + error)`. `skipped` and unknown statuses are excluded and counted separately.
- Gate pass rate uses only gate runs with `coverage_complete = 1` and at least one reported result check. Failed/error results count as failures; incomplete-coverage and no-check runs are reported separately.
- Duration is the mean recorded `total_ms` among runs in the gate pass-rate denominator that also have a recorded duration.
- A zero denominator returns `null`; the dashboard displays “未知”, never a 100% success rate.

The endpoint uses stored `test_runs.report_json` and coverage markers. It does not infer unreported cases or claim that skipped, waived, incomplete, or missing evidence passed.
