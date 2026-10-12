# Reports API & MCP

Testify's reports are built for three audiences: QA engineers troubleshooting failures, stakeholders who want status, and agents/scripts that need the same numbers. Every report is computed in one place (`apps/server/src/services/reportService.ts`) and described once in a catalog (`packages/core/src/reporting/catalog.ts`). The web UI and this API therefore always agree.

In the web app, **📊 Reports** in the header opens the same reports as a full view (Overview, Run, Trends & Breakdown, Test Health, plus a case-history drawer). Its address is a shareable link (`#/reports/<tab>?project=&plan=&run=&case=`).

New to the API? Start with [api_getting_started.md](api_getting_started.md).

## Authentication

Send `Authorization: Bearer <token>` with either:

- **A login JWT.** `POST /api/v1/auth/login` returns one. It stays valid while it's used: it ends after 8 hours without a request, and 7 days after signing in at most.
- **A machine API token** (`tf_ci_…`), created in Admin Panel → API Tokens. This is the right credential for scripts and agents: it doesn't expire unless you set an expiry, and it's bound to one project. It needs the `SPEC_VIEW` capability.

A token used against any project other than its own gets `403 TOKEN_PROJECT_MISMATCH`; on a route that isn't part of a project (e.g. `/api/v1/admin/...`) it gets `403 TOKEN_NOT_ALLOWED`.

**Rate limits** (generous, so automation and agents aren't held back):

- Every request made with an API token, including MCP calls: 1,200 per minute per token. A burst of up to 1,200 at once is fine; the allowance refills evenly.
- Exports: 120 per hour per user or token.
- Sending report emails: 60 per hour per user or token. Previews and scheduled sends don't count.

Over a limit, the reply is `429` with a `Retry-After` header (seconds) and `code: "RATE_LIMITED"`. Wait that long, then retry. The limits are kept per server process.

## Endpoints

```
GET  /api/v1/projects/:projectId/reports
POST /api/v1/projects/:projectId/reports/:reportId[?format=json|markdown|csv]
```

**The catalog** (`GET …/reports`) lists every report, what question it answers, its parameters as JSON Schema, and its output formats. It also returns `definitions`: exactly how every number is computed. Start there.

**Running a report** (`POST …/reports/:reportId`) takes the report's parameters as a JSON body. Errors are problem details, like every API error: `{ status, code, detail, invalid_params? }` (with `type`, `title`, `instance` and `timestamp`). The codes:

| Status | When | Body |
|---|---|---|
| 400 | Invalid parameters | `INVALID_PARAMS`, with `invalid_params: [{ name, reason }]` |
| 400 | An id from another project | `PROJECTS_DIFFER`, with `project_ids` |
| 404 | An unknown report, run, plan or case | `REPORT_NOT_FOUND`, `RUN_NOT_FOUND`, `PLAN_NOT_FOUND` or `CASE_NOT_FOUND` |
| 403 | No `SPEC_VIEW` | `FORBIDDEN`, with `required_permission` |

## Reports

| id | Params | What it answers |
|---|---|---|
| `overview` | `days` | Status at a glance: each active plan's latest run (pass rate, completion, new failures vs. the run before), spec health (cases by status, drafts awaiting approval, never-executed cases), and results per day split by people (UI) vs. automation (API). |
| `run_summary` | `test_run_id`, `compare_to?`, `filter?`, `limit?` | What happened in a run, and what changed since the previous run of the plan (or `compare_to`; `null` = no comparison): new failures, fixed, still failing, not run. Lists every failure with its error, how long it's been failing and a flaky flag. Formats: `json`, `markdown`, `csv`. |
| `case_history` | `test_case_id` (id or external id like `SHOP-12`), `limit`, `cursor` | Every result the case ever got across plans and runs, newest first, as `results` (each with `test_result_id`). Each result includes error, stack trace, environment and CI runner, plus stats (pass rate, streak, last pass/fail). Paginate with `next_cursor`. |
| `plan_trend` | `test_plan_id`, `runs`, `filter?` | Counts, pass rate, completion and new failures per run, oldest first. |
| `test_health` | `test_plan_id`, `runs`, `stale_days`, `filter?`, `limit?` | Five lists: flaky, slowest, getting slower, always failing, and stale cases. |
| `breakdown` | `test_plan_id`, `test_run_id?`, `group_by`, `filter?` | Compares groups of cases. Group by `suite`, `priority`, `execution_type`, `version_status`, `tester` or a custom field (`cf:<id>` / `suite_cf:<id>`). Without `test_run_id` it shows plan coverage; with it, verdicts per group. |

**`filter`** has the same shape as the case-search API (`q` matches a case's external id, title, or the name of any suite it's in): `{ "q": "login", "filters": [{ "field": "priority", "op": "any_of", "value": ["HIGH"] }] }`. Field keys and operators come from `GET /api/v1/projects/:projectId/case-search/fields`.

## Definitions (short version — the catalog has the full text)

- **Final result:** a case's latest result in a run. Re-running adds a result; nothing is overwritten.
- **Pass rate:** passed ÷ (total − untested − skipped). **Completion:** (total − untested) ÷ total. Rates are fractions from 0 to 1.
- **Failing:** FAILED or BLOCKED. Batch results can also be RETEST_REQUIRED or KNOWN_ISSUE, which count as OTHER.
- **Flaky:** either of these:
  - The pass/fail **flip score** across runs is at least 0.3. The score is (transitions − 1) ÷ (outcomes − 2), so a single real break or fix scores 0.
  - The case both passed and failed within one run.
- **Durations** come only from automated results, sent through the batch API. People's results aren't timed.

## Sending results that make good reports

`POST /api/v1/runs/:runId/results/batch` (needs `EXECUTE_RUN`), with the results in a `results` list, stores per result (a JUnit XML file sent to `POST /api/v1/runs/:runId/results/junit` fills the same fields from the file; see [api_getting_started.md](api_getting_started.md) §5):

- `verdict`
- `duration_ms`
- `failure_message` (the short error)
- `stack_trace`
- `notes`
- `environment_tags`

Per submission, it also stores `environment` and `runner_info`: `{ name, run_id, job_name, commit_sha, url }` (`run_id` is your CI system's run id, not Testify's). The full request and response are in [RFC 03 §3](rfc_03_api_and_xml_contracts.md). The failure message and stack trace show up in run summaries and case history, and the commit shows up in run summaries.

## MCP (for AI agents)

The API server also serves the reports, and tools to change test cases, plans and results, as an MCP server, built in at `POST /mcp`. It uses the Streamable HTTP transport, stateless, with JSON responses. It authenticates exactly like the REST API, so the best credential is an API token made for the agent, with just the capabilities it should have: `SPEC_VIEW` alone for an agent that only reads.

```bash
claude mcp add --transport http testify http://localhost:3001/mcp --header "Authorization: Bearer tf_ci_..."
```

Every tool checks `SPEC_VIEW` on the project it's asked about. A token only ever sees its own project.

**Reading** (`readOnlyHint: true`):

| Tool | What it does |
|---|---|
| `list_projects` | Projects you can read |
| `list_plans_and_runs` | Plans with their recent runs |
| `list_suites` | The suite tree: ids, paths, case counts |
| `search_cases` | Text and property search; same filters as the UI |
| `get_case` | A case's content: steps, expected results, custom fields |
| `list_report_fields` | Filter and group-by keys, with their operators |
| `report_overview`, `report_run_summary`, `report_case_history`, `report_plan_trend`, `report_test_health`, `report_breakdown` | The reports above, generated from the catalog. List sizes default to 25. `report_run_summary` also takes `format: "markdown"`. |

**Changing** (`readOnlyHint: false`):

| Tool | What it does | Needs |
|---|---|---|
| `create_suite` | A new suite | `SPEC_CREATE` |
| `create_case` | A new case with steps, always as a **DRAFT** | `SPEC_CREATE` |
| `update_case` | Title, priority, execution type, custom fields; summary, preconditions and steps on the DRAFT (an approved case gets a **new DRAFT version**) | `SPEC_EDIT` (`PLAN_MANAGE` for custom fields) |
| `update_cases` | Priority, execution type, suite or custom fields of up to 500 cases | as above |
| `create_run` | A run of a plan | `RUN_MANAGE` |
| `record_results` | Up to 500 results in a run | `EXECUTE_RUN` (`EXECUTE_OVERWRITE` to change others' results) |
| `update_plan_cases` | Add or remove up to 500 cases in a plan; cases with results are retired only with `retire_if_has_results` | `PLAN_MANAGE` |

How the write tools are kept safe:
- **They act as the caller.** Each one calls the REST routes with the caller's credential, so an agent can do exactly what its token or user may, with the same rules and errors. An API token is offered only the tools its capabilities allow.
- **A person approves agents' cases.** Cases an agent creates start as DRAFT even if the token holds `SPEC_AUTO_APPROVE`, and editing an approved case's content creates a new DRAFT version. Only approved cases can join a plan or get results. There are no tools to approve, deprecate, restore or delete; people do that in the web app, or scripts through the REST API.
- **Everything is audit-logged.** Each change writes its usual audit row (e.g. `CASE_CREATED`), with "(via Testify MCP)" added to its User-Agent, and each write-tool call writes an `MCP_WRITE` row (tool, success or error) to the Security Audit Log in the Admin Panel.

Ask, for example:
- *"What broke in the latest run of the Release Regression plan, and is any of it flaky?"*
- *"Write test cases for the new coupon feature in the Checkout suite, from this spec: …"* (they arrive as DRAFTs to review)
- *"Mark SHOP-12 and SHOP-14 as failed in run 'RC 2', with the error from this log."*

## Emailing reports

People with the `REPORT_EMAIL` permission (Admin and Test Lead by default) can email reports to any address.

- **In the web app:** use **✉ Email this report** in the Reports sidebar, or set up daily or weekly emails in the **Scheduled Emails** tab.
- **Mail server:** an admin sets it in Admin Panel → ✉ Email. Until a mail server is set, emails are only captured, not sent; that tab shows the last email sent or captured.

API:

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/projects/:projectId/report-emails` | Send now. Body: `{ "sections": [{ "report_id", "params" }], "recipients": "a@x.com, b@y.com", "message"?, "preview"? }`. `preview: true` returns `{ subject, html }` without sending. |
| `GET` / `POST /api/v1/projects/:projectId/report-schedules` | List or create schedules. |
| `PUT` / `DELETE /api/v1/report-schedules/:scheduleId` | Replace or remove a schedule. `PUT` takes the whole schedule, like create. |
| `POST /api/v1/report-schedules/:scheduleId/recipients` | Add one recipient: `{ "email": "a@x.com" }`. Answers the schedule. |
| `DELETE /api/v1/report-schedules/:scheduleId/recipients/:email` | Remove one recipient (not the last: `409 LAST_RECIPIENT`). |
| `POST /api/v1/report-schedules/:scheduleId/send-now` | Send a schedule now. |

A schedule's fields:
- `name` (used as the email subject).
- `sections`, each one of:
  - `{ kind: "overview" }`
  - `{ kind: "latest_run", test_plan_id }` (the plan's newest run when it's sent)
  - `{ kind: "test_health", test_plan_id }`
  - `{ kind: "plan_trend", test_plan_id }`
- `recipients`, `message`.
- Timing: `frequency` (`DAILY` | `WEEKLY`), `weekday` (0 = Sunday), `time_of_day` (`HH:MM`), `timezone` (IANA, e.g. `Europe/London`).
- `only_when_new_run`, `enabled`.

## Examples

```bash
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT/reports/run_summary?format=markdown" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"test_run_id\": \"$RUN\"}"

curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT/reports/case_history" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"test_case_id": "SHOP-12", "limit": 10}'
```

To try it with realistic data, fill a running dev server with a demo project (8 runs with regressions, flaky and slow cases):

```bash
npx tsx apps/server/scripts/report-demo.ts
```

The script prints the project id and an API token.
