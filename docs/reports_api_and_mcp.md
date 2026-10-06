# Reports API

Testify's reports are built for three audiences: QA engineers troubleshooting failures, stakeholders who want status, and agents/scripts that need the same numbers. Every report is computed in one place (`apps/server/src/services/reportService.ts`) and described once in a catalog (`packages/core/src/reporting/catalog.ts`). The web UI and this API therefore always agree.

In the web app, **📊 Reports** in the header opens the same reports as a full view (Overview, Run, Trends & Breakdown, Test Health, plus a case-history drawer). Its address is a shareable link (`#/reports/<tab>?project=&plan=&run=&case=`).

## Authentication

Send `Authorization: Bearer <token>` with either:

- **A login JWT.** `POST /api/v1/auth/login` returns one; it expires after 15 minutes.
- **A machine API token** (`tf_ci_…`), created in Admin Panel → API Tokens. This is the right credential for scripts and agents: it doesn't expire unless you set an expiry, and it's bound to one project. It needs the `SPEC_VIEW` capability.

A token used against any project other than its own gets `403 TOKEN_PROJECT_MISMATCH`.

## Endpoints

```
GET  /api/v1/projects/:projectId/reports
POST /api/v1/projects/:projectId/reports/:reportId[?format=json|markdown|csv]
```

**The catalog** (`GET …/reports`) lists every report, what question it answers, its parameters as JSON Schema, and its output formats. It also returns `definitions`: exactly how every number is computed. Start there.

**Running a report** (`POST …/reports/:reportId`) takes the report's parameters as a JSON body. Errors:

| Status | When | Body |
|---|---|---|
| 400 | Invalid parameters | `{ error: "INVALID_PARAMS", details: [{ param, reason }] }` |
| 404 | An unknown report, or an id from another project | `RUN_NOT_FOUND`, `PLAN_NOT_FOUND` or `CASE_NOT_FOUND` |
| 403 | No `SPEC_VIEW` | — |

## Reports

| id | Params | What it answers |
|---|---|---|
| `overview` | `days` | Status at a glance: each active plan's latest run (pass rate, completion, new failures vs. the run before), spec health (cases by status, drafts awaiting approval, never-executed cases), and results per day split by people (UI) vs. automation (API). |
| `run_summary` | `run_id`, `compare_to?`, `filter?`, `limit?` | What happened in a run, and what changed since the previous run of the plan (or `compare_to`; `null` = no comparison): new failures, fixed, still failing, not run. Lists every failure with its error, how long it's been failing and a flaky flag. Formats: `json`, `markdown`, `csv`. |
| `case_history` | `case_id` (id or external id like `SHOP-12`), `limit`, `cursor` | Every result the case ever got across plans and runs, newest first. Each result includes error, stack trace, environment and CI runner, plus stats (pass rate, streak, last pass/fail). Paginate with `next_cursor`. |
| `plan_trend` | `plan_id`, `runs`, `filter?` | Counts, pass rate, completion and new failures per run, oldest first. |
| `test_health` | `plan_id`, `runs`, `stale_days`, `filter?`, `limit?` | Five lists: flaky, slowest, getting slower, always failing, and stale cases. |
| `breakdown` | `plan_id`, `run_id?`, `group_by`, `filter?` | Compares groups of cases. Group by `suite`, `priority`, `execution_type`, `version_status`, `tester` or a custom field (`cf:<id>` / `suite_cf:<id>`). Without `run_id` it shows plan coverage; with it, verdicts per group. |

**`filter`** has the same shape as the case-search API: `{ "q": "login", "filters": [{ "field": "priority", "op": "any_of", "value": ["HIGH"] }] }`. Field keys and operators come from `GET /api/v1/projects/:projectId/case-search/fields`.

## Definitions (short version — the catalog has the full text)

- **Final result:** a case's latest execution in a run. Re-running adds an execution; nothing is overwritten.
- **Pass rate:** passed ÷ (total − untested − skipped). **Completion:** (total − untested) ÷ total. Rates are fractions from 0 to 1.
- **Failing:** FAILED or BLOCKED. Batch results can also be RETEST_REQUIRED or KNOWN_ISSUE, which count as OTHER.
- **Flaky:** either of these:
  - The pass/fail **flip score** across runs is at least 0.3. The score is (transitions − 1) ÷ (outcomes − 2), so a single real break or fix scores 0.
  - The case both passed and failed within one run.
- **Durations** come only from automated results, sent through the batch API. People's results aren't timed.

## Sending results that make good reports

`POST /api/v1/test-plans/:planId/builds/:runId/executions/batch` (needs `EXECUTE_RUN`) stores, per result:

- `verdict`
- `duration_ms`
- `failure_message` (the short error)
- `stack_trace`
- `notes`
- `environment_tags`

Per submission, it also stores `environment` and `runner_info`: `{ name, run_id, job_name, commit_sha, url }`. The failure message and stack trace show up in run summaries and case history, and the commit shows up in run summaries.

## Examples

```bash
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT/reports/run_summary?format=markdown" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"run_id\": \"$RUN\"}"

curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT/reports/case_history" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"case_id": "SHOP-12", "limit": 10}'
```

To try it with realistic data, fill a running dev server with a demo project (8 runs with regressions, flaky and slow cases):

```bash
npx tsx apps/server/scripts/report-demo.ts
```

The script prints the project id and an API token.
