# Getting started with the Testify API

This guide takes you from nothing to a CI pipeline that records its test results in Testify, and reads them back. Every example was run against a real server.

The full reference is on your server: **`/docs`** (for example `http://localhost:3001/docs`). It lists every route with its fields, their allowed values and its errors, and its "Try it out" button sends real requests. The spec behind it is at `/docs/json` (OpenAPI 3.1). The conventions are in [RFC 03 §1-4](rfc_03_api_and_xml_contracts.md).

## 1. What you need

- **The server's address:** below it's in `$TESTIFY`, e.g. `export TESTIFY=https://testify.example.com`.
- **A credential:**
  - For scripts and CI, an **API token**, made in the next step.
  - For a quick try, `POST /api/v1/auth/login` with `{"username": "...", "password": "..."}` returns a `token` you can use the same way. It ends after 8 hours without use.
- **`curl` and `jq`** for the examples. Any HTTP client works.

## 2. Make an API token

1. In Testify, open **Admin Panel → API Tokens** (it needs the `API_TOKEN_MANAGE` permission).
2. Pick the **project** the token is for. A token works only in that one project.
3. Give it a name, and tick its **capabilities**: what it may do. Pick only what the job needs:

   | Job | Capabilities |
   | :--- | :--- |
   | Send CI results into an existing run | `SPEC_VIEW`, `EXECUTE_RUN` |
   | ...and create a run for each build | add `RUN_MANAGE` |
   | ...and change a result already recorded in the run | add `EXECUTE_OVERWRITE` |
   | Read reports (a dashboard, a bot) | `SPEC_VIEW` |
   | Import test cases | `SPEC_VIEW`, `IMPORT_DATA` |
   | Export | `SPEC_VIEW`, `EXPORT_DATA` |

4. **Copy the token** (`tf_ci_…`). It's shown once. Store it as a secret in your CI system.

A token can never do more than you can: its capabilities are capped by your own permissions in the project. It stops working if your account is disabled or loses `API_TOKEN_MANAGE` there. You can revoke it at once from the same tab. Tokens can't use the admin routes (users, roles, custom field definitions, email settings).

```bash
export TESTIFY_TOKEN=tf_ci_...
```

## 3. Your first call

Every request sends the token as `Authorization: Bearer <token>`.

```bash
curl -s "$TESTIFY/api/v1/auth/me" -H "Authorization: Bearer $TESTIFY_TOKEN" \
  | jq '{username: .user.username, project: .user.api_token.project_id, permissions: .user.permissions}'
```

```json
{
  "username": "CI",
  "project": "01a131ac-1fce-71d8-9647-5cd7980f1e30",
  "permissions": ["SPEC_VIEW", "RUN_MANAGE", "EXECUTE_RUN"]
}
```

`permissions` is what the token can do *right now*. That's its capabilities, minus any its issuer no longer has.

## 4. Find the ids you need

Testify identifies everything by id (a UUID). Test cases also have a readable id like `SHOP-101`, which CI results can use directly.

```bash
# Your project (a token sees only its own)
curl -s "$TESTIFY/api/v1/projects" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.projects[] | {id, name, prefix}'

# The project's test plans
curl -s "$TESTIFY/api/v1/projects/$PROJECT_ID/plans" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.plans[] | {id, name, status}'

# A plan's test runs, newest first
curl -s "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.runs[] | {id, name, status}'

# A case's id from its readable id, title or suite name
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/case-search" \
  -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/json' \
  -d '{"q": "SHOP-101"}' | jq .case_ids
```

In the web app, the Reports view's address shows the ids of the project, plan and run you're looking at (`#/reports/run?project=…&plan=…&run=…`).

## 5. Send results from CI

A **test plan** is the set of cases to run. A **test run** is one go at them: typically one CI build. Results are recorded per case in a run.

### Create the run for this build (or reuse it)

Run names are unique within a plan. So use the build number in the name, and reuse the run if the job is re-run:

```bash
AUTH="Authorization: Bearer $TESTIFY_TOKEN"
RUN_NAME="CI build $BUILD_NUMBER"
RUN_ID=$(curl -sf "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "$AUTH" \
  | jq -r --arg name "$RUN_NAME" '.runs[] | select(.name == $name) | .id')
if [ -z "$RUN_ID" ]; then
  RUN_ID=$(curl -sf -X POST "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "$AUTH" \
    -H 'content-type: application/json' -d "$(jq -n --arg name "$RUN_NAME" '{name: $name}')" | jq -r .run.id)
fi
```

(Creating a run needs `RUN_MANAGE`. Without it, create the run in the web app and use its id.)

### Send the results

Up to 5,000 results per request, saved in one transaction:

```bash
curl -s -X POST "$TESTIFY/api/v1/runs/$RUN_ID/results/batch" \
  -H "$AUTH" -H 'content-type: application/json' \
  -d '{
    "environment": "staging",
    "runner_info": { "name": "GitHub Actions", "run_id": "1234", "commit_sha": "a1b2c3d", "url": "https://github.com/acme/shop/actions/runs/1234" },
    "results": [
      { "case_identifier": { "external_id": "SHOP-101" }, "verdict": "PASSED", "duration_ms": 3420 },
      { "case_identifier": { "external_id": "SHOP-102" }, "verdict": "FAILED", "duration_ms": 12450,
        "failure_message": "Expected 200, got 500",
        "stack_trace": "Error: Expected 200, got 500\n    at checkout.spec.ts:45:12" }
    ]
  }'
```

What to know:

- **Which case:**
  - `case_identifier` is usually `{ "external_id": "SHOP-101" }`.
  - `{ "by_uuid": "<case id>" }` and `{ "by_path_title": { "suite_path": "Payments / Checkout", "title": "..." } }` also work.
  - A case that isn't in the plan yet is added to it, if it's approved.
- **`verdict`:** one of `PASSED`, `FAILED`, `BLOCKED`, `SKIPPED`, `RETEST_REQUIRED`, `KNOWN_ISSUE`.
- **Worth sending:** `failure_message` (the short error), `stack_trace` and `duration_ms`. They show up in run summaries, case history and the "slowest" and "flaky" reports.
- **`runner_info`:** links each result back to your CI run. Its `run_id` is your CI system's id, not Testify's.
- **Re-running a test** in the same build adds another result, and the latest one counts. A different verdict from an earlier request needs `EXECUTE_OVERWRITE`.
- **The run closes itself** the first time every case in the plan has a result. A closed run takes no more results; reopen it with `PATCH /api/v1/runs/{runId}` and `{"status": "OPEN"}`.

### Check what was saved

The answer is **201** when everything was saved, and **207** when some results were refused. A refused result doesn't stop the others. Check the status, and print the refused ones:

```bash
STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$TESTIFY/api/v1/runs/$RUN_ID/results/batch" \
  -H "$AUTH" -H 'content-type: application/json' --data @results.json)
jq '.summary' response.json
jq -r '.results[] | select(.status >= 400) | "result \(.index): \(.code) \(.detail)"' response.json
```

```text
{ "total_submitted": 2, "successful": 1, "failed": 1, "duration_ms": 6 }
result 1: CASE_NOT_FOUND Case identifier not found in test plan
```

The reasons a result can be refused:
- `INVALID_RESULT`: a field is wrong; `invalid_params` names it.
- `CASE_NOT_FOUND`: no such case, or it isn't approved.
- `CASE_REMOVED_FROM_PLAN`: the case was taken out of the plan.
- `RESULT_OVERWRITE_NOT_PERMITTED`: changing an earlier result needs `EXECUTE_OVERWRITE`.
- `UNKNOWN_STEP`: a step result names a step the case doesn't have.

Add `?all_or_nothing=true` to save nothing at all when any result is refused.

### Example: a GitHub Actions step

Your test framework writes `results.json` in the format above. This step then records it, and fails if any result was refused (the log lists them). Store the token as the secret `TESTIFY_TOKEN`, and the server's address and the plan id as the variables `TESTIFY_URL` and `TESTIFY_PLAN_ID`.

```yaml
- name: Send results to Testify
  if: always()
  env:
    TESTIFY: ${{ vars.TESTIFY_URL }}
    TESTIFY_TOKEN: ${{ secrets.TESTIFY_TOKEN }}
    PLAN_ID: ${{ vars.TESTIFY_PLAN_ID }}
    RUN_NAME: "CI build ${{ github.run_number }}"
  run: |
    AUTH="Authorization: Bearer $TESTIFY_TOKEN"
    RUN_ID=$(curl -sf "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "$AUTH" \
      | jq -r --arg name "$RUN_NAME" '.runs[] | select(.name == $name) | .id')
    if [ -z "$RUN_ID" ]; then
      RUN_ID=$(curl -sf -X POST "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "$AUTH" \
        -H 'content-type: application/json' -d "$(jq -n --arg name "$RUN_NAME" '{name: $name}')" | jq -r .run.id)
    fi
    STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$TESTIFY/api/v1/runs/$RUN_ID/results/batch" \
      -H "$AUTH" -H 'content-type: application/json' --data @results.json)
    jq '.summary' response.json
    jq -r '.results[]? | select(.status >= 400) | "result \(.index): \(.code) \(.detail)"' response.json
    test "$STATUS" -eq 201
```

## 6. Read results back

```bash
# What happened in the run, compared with the plan's previous run, as Markdown for a PR comment
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/reports/run_summary?format=markdown" \
  -H "$AUTH" -H 'content-type: application/json' -d "{\"test_run_id\": \"$RUN_ID\"}"
```

```markdown
## Test run "CI build 1234" (plan "Release Regression")

**Pass rate 50%** · 2/12 executed (16.7%) · 1 passed · 1 failed · 0 blocked · 0 skipped · 10 untested

Compared with "Run 1.0.8": **0 new failures** · 0 fixed · 1 still failing · 8 not run
```

Other ways to read results:
- **Each case's latest result in a run:** `GET /api/v1/plans/{planId}/cases?test_run_id={runId}`.
- **One case's whole history:** the `case_history` report, with `{"test_case_id": "SHOP-101"}`.
- **Health over many runs:** the `test_health` report lists flaky, slow and always-failing cases.
- **Everything in a run as a file:** `POST /api/v1/projects/{projectId}/exports/results` with `{"test_run_id": "..."}` (needs `EXPORT_DATA`).

Every report, and what each number means, is in [reports_api_and_mcp.md](reports_api_and_mcp.md).

## 7. When something goes wrong

Every error is the same shape (`application/problem+json`). Read `code` in your script; show `detail` to people:

```json
{
  "type": "https://api.testify.dev/errors/INVALID_RESULT",
  "title": "Bad Request",
  "status": 400,
  "code": "INVALID_RESULT",
  "detail": "Nothing was recorded (all_or_nothing): results[0].verdict must be one of PASSED, FAILED, BLOCKED, SKIPPED, RETEST_REQUIRED, KNOWN_ISSUE",
  "invalid_params": [{ "name": "results[0].verdict", "reason": "must be one of PASSED, FAILED, BLOCKED, SKIPPED, RETEST_REQUIRED, KNOWN_ISSUE" }],
  "instance": "/api/v1/runs/01a131ac-75a0-7521-8801-27b3e476c3a0/results/batch?all_or_nothing=true",
  "timestamp": "2026-10-12T19:52:28.401Z"
}
```

The ones you're most likely to meet:

| Status and code | Means | Do |
| :--- | :--- | :--- |
| 401 `INVALID_TOKEN`, `TOKEN_REVOKED`, `TOKEN_EXPIRED` | The token doesn't work any more | Make a new one |
| 401 `TOKEN_ISSUER_INACTIVE` | Whoever made the token was disabled or lost `API_TOKEN_MANAGE` | Ask someone who manages tokens for a new one |
| 403 `FORBIDDEN` | The token lacks a capability; `required_permission` names it | Make a token with it |
| 403 `TOKEN_PROJECT_MISMATCH` | An id from another project | Use that project's token |
| 403 `TOKEN_NOT_ALLOWED` | An admin route; tokens can't use them | Sign in as a user |
| 422 `RUN_CLOSED`, `PLAN_LOCKED` | The run is closed, or the plan locked or archived | Reopen it, or use another run |
| 429 `RATE_LIMITED` | Too many requests | Wait the seconds in `Retry-After`, then retry |

The full list is in [RFC 03 §4.2](rfc_03_api_and_xml_contracts.md). An unexpected `500` carries a `request_id`. Give it to whoever runs the server: the server's log line has the same id.

## 8. Limits

- 1,200 requests a minute per token (MCP calls included); the allowance refills evenly.
- 5,000 results per batch request.
- 120 exports and 60 report emails an hour.
- Imports: 50 MB per file, two at a time.

## 9. Going further

- **Everything else** (suites, cases, versions, plans, custom fields, imports, reports, report emails): see `/docs`.
- **Generated client libraries:** tools that read OpenAPI 3.1 (for example OpenAPI Generator) can build a typed client for Python, TypeScript and other languages from `/docs/json`.
- **AI agents:** connect them to the MCP endpoint at `/mcp` with a `SPEC_VIEW` token; see [reports_api_and_mcp.md](reports_api_and_mcp.md).
