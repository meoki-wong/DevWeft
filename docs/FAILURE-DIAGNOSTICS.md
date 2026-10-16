# Failure diagnostics

The run evidence dialog has a **Failure diagnostics** tab. It combines the stored report, execution attempts, same-repository failure records, and reviewed experiences. It does not call a language model or treat a suggestion as verified knowledge.

## Read a run

```http
GET /api/testing/runs/{runId}/diagnostics
```

The response includes:

- `phase`, `failureAnalysis`, and the run-level `timeline` when available;
- `similarFailures`, matched by repository, case key, and classified failure class;
- `similarExperiences`, limited to reviewed experience records linked to matching failures or tagged for the failure class/case;
- `suggestions`, with a stable `suggestionId`, action, rationale, next step, and stored report evidence;
- the latest `feedback` for each suggestion, read from the append-only audit log.

An empty result means no matching evidence was found. It does not mean the run passed or that no historical failure exists outside the matching scope. Skipped checks are not converted to failures or passes.

## Record a review

```http
POST /api/testing/runs/{runId}/diagnostics/{suggestionId}/feedback
Content-Type: application/json

{"action":"confirm","note":"Checked the response log","author":"reviewer"}
```

`action` must be `confirm` or `ignore`; `note` is optional and limited to 1000 characters. The suggestion must be present in the current run's diagnostic response. Each review appends a `testing_diagnostic_feedback` audit event with the run, suggestion, action, author, timestamp, and optional note. A later review supersedes the earlier display state while preserving both audit events.

Confirming a suggestion records agreement with that proposed next step only. It does not promote an experience, modify a test, or change the run result. Curated experiences continue through the existing reviewed experience workflow.

## Evidence and privacy

The service uses the run's stored report and attempt records, then looks up history within the same repository. It returns only matching history, not source files or secret references. The audit payload passes through the shared audit redaction and size limits. Dashboard access follows the project's existing dashboard deployment boundary.
