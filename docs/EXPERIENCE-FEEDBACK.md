# Structured experience feedback

New run resolutions can be submitted as structured feedback:

```http
POST /api/testing/experience-feedback
Content-Type: application/json

{
  "repo": "example-app",
  "runId": "<run-id>",
  "failureId": "<optional-failure-id>",
  "sourceType": "run",
  "failureSummary": "Checkout response assertion failed",
  "resolutionSummary": "Validate the response status before rendering confirmation",
  "scope": {"unit":"smoke","side":"web","caseKey":"checkout","phase":"smoke"},
  "evidence": {"runId":"<run-id>","caseKey":"checkout","source":"stored_run_report"}
}
```

Submission is always `unverified`. The API verifies that linked runs/failures belong to the selected repository and rejects secret-shaped values and sensitive JSON keys.

List feedback with `GET /api/testing/experience-feedback?repo=example-app&status=unverified`. Review an item with:

```http
POST /api/testing/experience-feedback/{feedbackId}/review
Content-Type: application/json

{"action":"confirm","reviewer":"maintainer","note":"Reproduced with the public fixture"}
```

Review actions are `confirm` or `reject`. Review time and reviewer are stored, and both submissions and reviews append audit events. An item can be reviewed only once. Confirmation applies to the submitted resolution; promotion into the shared experience library remains a separate existing workflow.
