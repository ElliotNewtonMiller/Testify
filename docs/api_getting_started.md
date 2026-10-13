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
   | ...and create a run for each build (`run_name`) | add `RUN_MANAGE` |
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

Testify identifies everything by id (a UUID). Test cases also have a readable id like `SHOP-101`, which works anywhere a case id does: `GET /api/v1/cases/SHOP-101`, `"test_case_id": "SHOP-101"`, CI results.

```bash
# Your project (a token sees only its own)
curl -s "$TESTIFY/api/v1/projects" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.projects[] | {id, name, prefix}'

# The project's test plans
curl -s "$TESTIFY/api/v1/projects/$PROJECT_ID/plans" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.plans[] | {id, name, status}'

# A plan's test runs, newest first
curl -s "$TESTIFY/api/v1/plans/$PLAN_ID/runs" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.runs[] | {id, name, status}'

# One case, with its latest version and steps
curl -s "$TESTIFY/api/v1/cases/SHOP-101" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '{case: .test_case.title, version: .latest_version.version_number}'

# The project's cases, a page at a time
curl -s "$TESTIFY/api/v1/projects/$PROJECT_ID/cases?version_status=APPROVED&limit=100" -H "Authorization: Bearer $TESTIFY_TOKEN" | jq '.cases[].external_id, .next_cursor'

# Cases matching words in their title or suite name
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/case-search" \
  -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/json' \
  -d '{"q": "checkout"}' | jq .case_ids
```

**Long lists come a page at a time.** A project's cases, a run's results and the audit log answer `next_cursor`; pass it back as `cursor` for the next page, until it is `null`. `limit` sets the page size.

```bash
CURSOR=""
while :; do
  PAGE=$(curl -s "$TESTIFY/api/v1/projects/$PROJECT_ID/cases?limit=500${CURSOR:+&cursor=$CURSOR}" -H "Authorization: Bearer $TESTIFY_TOKEN")
  echo "$PAGE" | jq -r '.cases[].external_id'
  CURSOR=$(echo "$PAGE" | jq -r '.next_cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

A readable id is unique within its project. Imported cases keep the ids from their file, so two projects can share one; then the request's project decides (an API token's own project, or the project its other ids name). Without one, the answer is `400 AMBIGUOUS_CASE_ID`; use the case's id instead.

In the web app, the Reports view's address shows the ids of the project, plan and run you're looking at (`#/reports/run?project=…&plan=…&run=…`).

## 5. Send results from CI

A **test plan** is the set of cases to run. A **test run** is one go at them: typically one CI build. Results are recorded per case in a run.

### Upload your JUnit file

Nearly every test runner can write a JUnit XML report. For example: pytest `--junitxml=report.xml`, Maven Surefire and Gradle (on by default), Jest `jest-junit`, Vitest `--reporter=junit`, Playwright `--reporter=junit`, Go `go-junit-report`. Send that file as it is, naming the run for this build:

```bash
curl -s -X POST "$TESTIFY/api/v1/plans/$PLAN_ID/results/junit?run_name=CI%20build%20$BUILD_NUMBER" \
  -H "Authorization: Bearer $TESTIFY_TOKEN" --data-binary @report.xml
```

- **The run:** the plan's run named `run_name` is created the first time (the token needs `RUN_MANAGE` for that) and reused after, so a re-run job adds to the same run, and parallel jobs of one build can each send their own file. To send into a run you already have, use `POST /api/v1/runs/{runId}/results/junit` instead.
- **Verdicts:** `<failure>` and `<error>` are FAILED, `<skipped>` is SKIPPED, anything else PASSED. The test's `time` becomes its duration, and the failure's message and text become the error and stack trace in reports.
- **Optional query parameters:** `environment` (e.g. `staging`); `ci_name`, `ci_run_id`, `ci_job_name`, `ci_url`, `commit_sha`, which link each result back to the build in reports; `close_run=true` to close the run afterwards.
- **Size:** up to 20,000 tests and 50 MB per file.

**Matching tests to Testify cases.** Each test in the file is matched to a case of the project, in this order:
1. A `testify_id` property on the test. In pytest: `record_property("testify_id", "SHOP-101")`.
2. A readable id in the test's name: `SHOP-101 logs in`, `[SHOP-101] logs in`, `logs in (SHOP-101)`.
3. Its suite and title. A JUnit import of the same file creates cases this way: one suite per class (the last part of `classname`), one case per test, named after it. So the simplest setup is to **import your JUnit file once** (Import in the web app, or `POST /api/v1/projects/{projectId}/imports/execute` with `"format": "JUNIT_XML"`), add the cases to the plan if you like, and upload each build's file from then on.

A matched case that isn't in the plan yet is added to it, if it's approved. A test that matches no case isn't recorded; it's listed in the response, so you can see what isn't tracked.

### Check what was saved

The answer is **201** when every test was recorded, and **207** when some were refused (usually: tests with no matching case). Anything else (400, 401, 403, 404, 413, 422) means nothing was recorded. Print the refused tests:

```bash
STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST \
  "$TESTIFY/api/v1/plans/$PLAN_ID/results/junit?run_name=CI%20build%20$BUILD_NUMBER" \
  -H "Authorization: Bearer $TESTIFY_TOKEN" --data-binary @report.xml)
jq -c '.summary // .' response.json
jq -r '.results[]? | select(.status >= 400) | "\(.code): \(.test_name)"' response.json
```

```text
{"total_submitted":148,"successful":146,"failed":2,"duration_ms":212}
CASE_NOT_FOUND: tests.misc.test_debug_helper
CASE_NOT_FOUND: tests.misc.test_scratch
```

The reasons a test (or a JSON result) can be refused:
- `CASE_NOT_FOUND`: no matching case, or it isn't approved.
- `CASE_REMOVED_FROM_PLAN`: the case was taken out of the plan.
- `RESULT_OVERWRITE_NOT_PERMITTED`: changing an earlier result in this run needs `EXECUTE_OVERWRITE`.
- `INVALID_RESULT`: a field is wrong; `invalid_params` names it.
- `UNKNOWN_STEP` (JSON only): a step result names a step the case doesn't have.

Add `all_or_nothing=true` to record nothing at all when any test is refused.

What else to know:
- **Re-running a test** in the same build adds another result, and the latest one counts. A different verdict from an earlier upload needs `EXECUTE_OVERWRITE`.
- **The run stays open** after CI results, even once every case has one, since a build may send several files or be re-run. Add `close_run=true` to the last upload of a build to close it (needs `RUN_MANAGE`), or close it in the web app. A closed run takes no more results (`422 RUN_CLOSED`); reopen it with `PATCH /api/v1/runs/{runId}` and `{"status": "OPEN"}`. (Runs executed by people in the web app close themselves the first time every case has a result.)

### CI examples

Each example sends the report even when tests failed, prints the refused tests, and fails the step only if the upload itself failed. A 207 for untracked tests doesn't fail the build; change the last check to `test "$STATUS" = 201` if it should. They need three settings: the token as a secret `TESTIFY_TOKEN`, and the server's address and the plan id as `TESTIFY_URL` and `TESTIFY_PLAN_ID`. They use `curl` and `jq`; `jq` also builds the query string, since build names and links need encoding.

**GitHub Actions** (`.github/workflows/test.yml`, after the step that runs the tests):

```yaml
- name: Send results to Testify
  if: ${{ !cancelled() }}
  env:
    TESTIFY_TOKEN: ${{ secrets.TESTIFY_TOKEN }}
    URL: ${{ vars.TESTIFY_URL }}/api/v1/plans/${{ vars.TESTIFY_PLAN_ID }}/results/junit
  run: |
    QUERY=$(jq -rn \
      --arg run_name "CI build ${{ github.run_number }}" --arg ci_name "GitHub Actions" \
      --arg ci_run_id "${{ github.run_id }}" --arg commit_sha "${{ github.sha }}" \
      --arg ci_url "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
      '$ARGS.named | to_entries | map("\(.key)=\(.value | @uri)") | join("&")')
    STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$URL?$QUERY" \
      -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/xml' --data-binary @report.xml)
    jq -c '.summary // .' response.json
    jq -r '.results[]? | select(.status >= 400) | "\(.code): \(.test_name)"' response.json
    test "$STATUS" = 201 -o "$STATUS" = 207
```

**GitLab CI** (`.gitlab-ci.yml`; set `TESTIFY_TOKEN` as a masked CI/CD variable). The upload is its own job, so a failed upload shows as a failed job:

```yaml
test:
  stage: test
  script:
    - pytest --junitxml=report.xml
  artifacts:
    when: always
    paths: [report.xml]
    reports:
      junit: report.xml

testify:
  stage: .post
  when: always
  needs: [{ job: test, artifacts: true }]
  script:
    - |
      QUERY=$(jq -rn \
        --arg run_name "CI pipeline $CI_PIPELINE_IID" --arg ci_name "GitLab CI" \
        --arg ci_run_id "$CI_PIPELINE_ID" --arg ci_url "$CI_PIPELINE_URL" --arg commit_sha "$CI_COMMIT_SHA" \
        '$ARGS.named | to_entries | map("\(.key)=\(.value | @uri)") | join("&")')
      STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$TESTIFY_URL/api/v1/plans/$TESTIFY_PLAN_ID/results/junit?$QUERY" \
        -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/xml' --data-binary @report.xml)
      jq -c '.summary // .' response.json
      jq -r '.results[]? | select(.status >= 400) | "\(.code): \(.test_name)"' response.json
      test "$STATUS" = 201 -o "$STATUS" = 207
```

**Jenkins** (`Jenkinsfile` with Maven; store the token as a "Secret text" credential with the id `testify-token`). Surefire writes one file per test class; each is sent, and they all land in the same run:

```groovy
post {
  always {
    withCredentials([string(credentialsId: 'testify-token', variable: 'TESTIFY_TOKEN')]) {
      sh '''
        QUERY=$(jq -rn \
          --arg run_name "CI build $BUILD_NUMBER" --arg ci_name "Jenkins" --arg ci_job_name "$JOB_NAME" \
          --arg ci_url "$BUILD_URL" --arg commit_sha "${GIT_COMMIT:-}" \
          '$ARGS.named | to_entries | map("\\(.key)=\\(.value | @uri)") | join("&")')
        for f in target/surefire-reports/TEST-*.xml; do
          STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$TESTIFY_URL/api/v1/plans/$TESTIFY_PLAN_ID/results/junit?$QUERY" \
            -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/xml' --data-binary @"$f")
          jq -c '.summary // .' response.json
          jq -r '.results[]? | select(.status >= 400) | "\\(.code): \\(.test_name)"' response.json
          test "$STATUS" = 201 -o "$STATUS" = 207 || exit 1
        done
      '''
    }
  }
}
```

(In Groovy's `'''` strings a backslash must be doubled, hence `\\(`.)

**Azure DevOps** (`azure-pipelines.yml`; add `TESTIFY_TOKEN` as a secret pipeline variable; secrets reach a script only when mapped into `env`):

```yaml
- script: |
    QUERY=$(jq -rn \
      --arg run_name "CI build $(Build.BuildNumber)" --arg ci_name "Azure DevOps" \
      --arg ci_run_id "$(Build.BuildId)" --arg commit_sha "$(Build.SourceVersion)" \
      --arg ci_url "$(System.CollectionUri)$(System.TeamProject)/_build/results?buildId=$(Build.BuildId)" \
      '$ARGS.named | to_entries | map("\(.key)=\(.value | @uri)") | join("&")')
    STATUS=$(curl -s -o response.json -w '%{http_code}' -X POST "$(TESTIFY_URL)/api/v1/plans/$(TESTIFY_PLAN_ID)/results/junit?$QUERY" \
      -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/xml' --data-binary @report.xml)
    jq -c '.summary // .' response.json
    jq -r '.results[]? | select(.status >= 400) | "\(.code): \(.test_name)"' response.json
    test "$STATUS" = 201 -o "$STATUS" = 207
  displayName: Send results to Testify
  condition: succeededOrFailed()
  env:
    TESTIFY_TOKEN: $(TESTIFY_TOKEN)
```

### Sending JSON instead

When your results aren't a JUnit file, or you want more than it holds (step results, `executed_at`, other verdicts such as `BLOCKED`), send them as JSON: up to 5,000 per request, saved in one transaction. `POST /api/v1/plans/{planId}/results/batch?run_name=...` creates or reuses the run, as above; `POST /api/v1/runs/{runId}/results/batch` sends into a run you have.

```bash
curl -s -X POST "$TESTIFY/api/v1/plans/$PLAN_ID/results/batch?run_name=CI%20build%20$BUILD_NUMBER" \
  -H "Authorization: Bearer $TESTIFY_TOKEN" -H 'content-type: application/json' \
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

- **Which case:** `case_identifier` is usually `{ "external_id": "SHOP-101" }`; `{ "by_uuid": "<case id>" }` and `{ "by_path_title": { "suite_path": "Checkout", "title": "..." } }` (the suite's name and the case's title) also work.
- **`verdict`:** one of `PASSED`, `FAILED`, `BLOCKED`, `SKIPPED`, `RETEST_REQUIRED`, `KNOWN_ISSUE`.
- **Worth sending:** `failure_message` (the short error), `stack_trace` and `duration_ms`. They show up in run summaries, case history and the "slowest" and "flaky" reports.
- **`runner_info`:** links each result back to your CI run. Its `run_id` is your CI system's id, not Testify's.
- The response, refusals and `all_or_nothing` work as for JUnit files; refused results are identified by their `index` in `results`.

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
- **Every result in a run**, with notes, durations, errors, step results and who recorded them: `GET /api/v1/runs/{runId}/results`. Filter with `verdict=FAILED,BLOCKED`, `test_case_id=SHOP-101`, `source=API` (CI results only), and `latest_only=true` (each case's latest result, which is what reports count). One result: `GET /api/v1/results/{resultId}`.
- **Each case's latest result in a run, untested cases included:** `GET /api/v1/plans/{planId}/cases?test_run_id={runId}`.
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
- 5,000 results per JSON batch; 20,000 tests and 50 MB per JUnit file.
- 120 exports and 60 report emails an hour.
- Imports: 50 MB per file, two at a time.

## 9. Get notified: webhooks

A webhook makes Testify send a project's events to another system as they happen: a run finishing (with its pass rate and new failures), tests failing, a case drafted by an AI agent waiting for review, an import finishing. Setting one up needs `WEBHOOK_MANAGE` in the project (Admin and Test Lead have it); API tokens can't. The easiest way is **Admin Panel → Webhooks** in the web app, which also shows each webhook's deliveries; the API below does the same. `GET /api/v1/webhook-events` lists the events.

**To a Slack channel.** In Slack, add an *Incoming Webhook* to the channel and copy its URL. Then:

```bash
curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/webhooks" -H "Authorization: Bearer $LOGIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name": "QA channel", "url": "https://hooks.slack.com/services/T000/B000/XXXX", "format": "slack",
       "events": ["run.closed", "results.failed", "test_case.created"]}' | jq '{id: .webhook.id, secret}'
curl -s -X POST "$TESTIFY/api/v1/webhooks/$WEBHOOK_ID/ping" -H "Authorization: Bearer $LOGIN_TOKEN" | jq '.delivery | {status, response_status, error}'
```

The `slack` format also suits Mattermost and Rocket.Chat, and Discord when its webhook URL ends in `/slack`. (`$LOGIN_TOKEN` is from `POST /api/v1/auth/login`; set the server's public address in Admin Panel → Email for the messages to link back to Testify.)

**To your own code** (`"format": "json"`, the default), each event arrives as a signed JSON `POST`, described in [RFC 03 §7.3](rfc_03_api_and_xml_contracts.md). Check the signature before trusting it: the secret is answered once when the webhook is created (`secret`), or by `POST /api/v1/webhooks/{id}/rotate-secret`.

```js
// Node (Express): app.post('/testify', express.raw({ type: 'application/json' }), handler)
import { createHmac, timingSafeEqual } from 'node:crypto';
function fromTestify(req, secret) {
  const ts = req.get('X-Signature-Timestamp');
  const expected = createHmac('sha256', secret).update(`${ts}.${req.body}`).digest('hex'); // req.body: the raw bytes
  const given = req.get('X-Signature-SHA256') ?? '';
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    && Math.abs(Date.now() / 1000 - Number(ts)) < 300; // and not a replay
}
```

```python
# Python (Flask)
import hmac, hashlib, time
def from_testify(request, secret: str) -> bool:
    ts = request.headers.get("X-Signature-Timestamp", "")
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + request.get_data(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, request.headers.get("X-Signature-SHA256", "")) and abs(time.time() - float(ts or 0)) < 300
```

What to know:
- **Answer quickly with a 2xx.** Anything else, no answer within 10 seconds, or a redirect, counts as a failure, retried after 1 minute, 5 minutes, 30 minutes, 2 hours and 8 hours.
- **Events can arrive twice or out of order** (after a retry). Each has an `id` that stays the same: use it to ignore repeats.
- **The delivery log** (`GET /api/v1/webhooks/{id}/deliveries`, then `GET /api/v1/webhook-deliveries/{id}`) shows each attempt and the start of your answer; `POST /api/v1/webhook-deliveries/{id}/redeliver` sends one again.
- **Addresses:** webhooks can reach the internet and your private network, but not the Testify server's own machine (`localhost`) or link-local addresses, unless the server sets `WEBHOOK_ALLOW_LOCAL=true`.

## 10. Going further

- **Everything else** (suites, cases, versions, plans, custom fields, imports, reports, report emails): see `/docs`.
- **Generated client libraries:** tools that read OpenAPI 3.1 (for example OpenAPI Generator) can build a typed client for Python, TypeScript and other languages from `/docs/json`.
- **Changing many cases at once:** one call instead of a loop, up to 500 cases (readable ids work), each reported on its own (200, or 207 when some failed):

  ```bash
  # Deprecate three cases (needs SPEC_APPROVE); also: approve, restore, and update with "changes"
  curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/cases/bulk" -H "Authorization: Bearer $TESTIFY_TOKEN" \
    -H 'content-type: application/json' -d '{"action": "deprecate", "case_ids": ["SHOP-12", "SHOP-14", "SHOP-15"]}' | jq -c '.summary'

  # Raise priority and set a custom field (by name or label) on many cases
  curl -s -X POST "$TESTIFY/api/v1/projects/$PROJECT_ID/cases/bulk" -H "Authorization: Bearer $TESTIFY_TOKEN" \
    -H 'content-type: application/json' -d '{"action": "update", "case_ids": ["SHOP-12", "SHOP-14"], "changes": {"priority": "HIGH", "custom_fields": {"Component": "checkout"}}}'

  # Add many cases to a plan (or "remove"; add "retire_if_has_results": true to retire cases that have results)
  curl -s -X POST "$TESTIFY/api/v1/plans/$PLAN_ID/cases/bulk" -H "Authorization: Bearer $TESTIFY_TOKEN" \
    -H 'content-type: application/json' -d '{"action": "add", "case_ids": ["SHOP-12", "SHOP-14"]}'
  ```
- **AI agents:** connect them to the MCP endpoint at `/mcp` with a token made for the agent. With `SPEC_VIEW` alone it can read and run reports; add `SPEC_CREATE`, `SPEC_EDIT`, `PLAN_MANAGE`, `RUN_MANAGE` or `EXECUTE_RUN` to let it write cases (always as DRAFTs for you to approve), manage plans, start runs and record results. See [reports_api_and_mcp.md](reports_api_and_mcp.md).
