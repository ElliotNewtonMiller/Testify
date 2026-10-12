# API & MCP Roadmap

The next steps for Testify's API and MCP endpoint, with recommendations, open questions and status. Keep it current as the work happens:
- update each step's **Status** line;
- record decisions in the **Decisions** table;
- add each finished change to `docs/changelog.md` as usual.

Status values: **Not started**, **Planning**, **In progress**, **Done**, **Dropped**.

---

## Where the API stands (2026-10-11)

**Good:**
- **Coverage:** about 84 endpoints cover nearly everything the web app does: projects, suites, cases and versions, plans, runs, results, search, import, export, custom fields, admin, API tokens, reports and report emails. The web app itself uses these endpoints, so anything you can click, a script can do.
- **Security:** project-bound API tokens (`tf_ci_...`), permissions checked per project, rate limits and an audit log (RFC 04).
- **CI:** results arrive in batches of up to 5,000 per request (`POST /api/v1/test-plans/{planId}/builds/{buildId}/executions/batch`).
- **Agents:** `POST /mcp` lets them list projects, search and read cases, and run every report.

**Weak:**
1. **Mostly undocumented.** Only reports, MCP and the CI results format are written up ([reports_api_and_mcp.md](reports_api_and_mcp.md)). Everything else has to be learned from the code in `apps/server/src/routes/`.
2. **Inconsistent, because it grew feature by feature.** Fixed by step 1 (stages 1-3, 2026-10-11/12): one address style, one error format, "runs" and "results" everywhere, one name per id. Stage 4 (documentation) is still to do.
   - Before: some addresses sat under a project (`/api/v1/projects/{projectId}/test-cases`), others didn't (`/api/v1/test-cases/{caseId}/latest-version`, `/api/v1/test-plans/{planId}/cases`).
   - Before: errors came in two shapes, plain `{ error, code }` and problem details.
   - Before: test runs were `builds` in addresses and fields, and the single-result route lived in `server.ts`.
3. **No paging.** Lists return everything at once. That's fine now, but will be slow with tens of thousands of cases or results.
4. **No machine-readable description.** There's no OpenAPI spec. RFC 03 §1-4 describes an API that was never built that way.
5. **Agents can only read.** MCP has no tools to create cases, record results or manage plans.

---

## Background: what an OpenAPI spec and a "try it" page are

An **OpenAPI spec** is one structured file in a standard format that describes every endpoint:
- the address and verb;
- what it needs (parameters and body, with types, limits and required fields);
- what it returns, with examples;
- its possible errors;
- which permission it requires.

Many tools read that format, so the one file gives:
1. **A documentation page** served by Testify itself (e.g. `/docs`), generated from the file.
2. **"Try it":** on that page, paste an API token, fill in a form for any endpoint, press Send, and see the real answer.
3. **Client libraries:** tools can generate Python, TypeScript or other code for calling the API.
4. **Imports into other tools and agents,** which can read the file to understand the whole API.
5. **Docs that can't go stale:** tests check the server's real answers against the file.

**How it fits Testify:** Fastify (the server framework) has an official plugin that builds the spec from a description (a JSON schema) attached to each route, and another plugin serves the page: Swagger UI, or Scalar. No route has a schema yet; input is checked by hand-written code. Adding schemas route by route is the main work. The same schemas then also do the input checking, so documentation and behavior can't disagree.

---

## Steps

### 1. Make the API consistent

**Status:** In progress. Stages 1-3 of 4 done (2026-10-11, 2026-10-12, 2026-10-12); see the stages below and the Decisions table.

**What:** decide the conventions, then change the routes to follow them:
- one address style (everything under `/projects/{projectId}/...`, or flat resources);
- one error format (problem details everywhere is the natural choice);
- "run" instead of "build" in addresses and fields;
- naming of fields and query parameters;
- what list, create and update responses look like.

**Why now:** nothing outside Testify depends on the API yet. Once people write scripts against it, every change breaks them.

**Recommendation:** do this first, and write the result into RFC 03 to replace §1-4. The web app changes along with the routes.

**Decided:** shallow addresses, short path names, `builds`/`executions` renamed in the database too, no aliases (see Decisions).

**Stages** (each its own commit, tested by Elliot before the next):
1. **Database rename. Done 2026-10-11.** Migration `007`: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`, with their columns, constraints and indexes. The code that talks to them was renamed to match; the API was unchanged.
2. **One error format. Done 2026-10-12.** Every error is problem details (`application/problem+json`, with `code` and `detail`), sent through `sendError` in `apps/server/src/errors.ts`; unknown addresses and Fastify's own errors too. The web app reads messages through `errorMessage()` in `apps/web/src/api/errors.ts`. `apps/server/tests/api_conventions.test.ts` checks the format for every kind of error.
3. **Addresses, verbs and names. Done 2026-10-12.** The route map below; `PATCH` for partial updates; `201`/`200`/`204` for create/update/delete; `?force=true` for "delete anyway"; snake_case bodies; id fields named after the database columns (`test_plan_id`, `test_run_id`, ...); "run" and "result" instead of "build" and "execution" in addresses, fields, error codes and new audit rows (old audit rows keep their names). The web app's addresses move into one file (`apps/web/src/api/routes.ts`). A data migration (`008`) renames `plan_id` to `test_plan_id` inside stored report schedules. Two kept `PUT`, because each replaces the whole thing: updating a report schedule and saving the email settings. Removing a whole suite from a plan answers 200 with counts (`added`, `removed`, `retired`, `skipped`) rather than 204. `api_conventions.test.ts` checks the new shapes, that no response says "build" or "execution", and that the old addresses answer 404.
4. **Documentation.** Not started. RFC 03 §1-4 replaced with these conventions and the route map; the other docs updated.

**Route map** (all under `/api/v1`):

| Area | Routes |
| :--- | :--- |
| Auth | `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/me` (replaces `PUT /auth/credentials`; body `username`, `email`, `password`, `current_password`) |
| Projects | `GET`/`POST /projects`, `PATCH`/`DELETE /projects/{id}` |
| Spec | `GET /projects/{id}/spec-tree`, `POST /projects/{id}/move`, `POST /projects/{id}/suites`, `PATCH`/`DELETE /suites/{id}`, `POST /projects/{id}/cases`, `PATCH`/`DELETE /cases/{id}` |
| Versions | `GET /cases/{id}/versions/latest`, `POST /cases/{id}/versions` (new draft), `PATCH /versions/{id}`, `POST /versions/{id}/approve`, `/deprecate`, `/restore` |
| Custom field values | `GET /cases/{id}/custom-fields`, `PUT`/`DELETE /cases/{id}/custom-fields/{definitionId}`; the same under `/suites/{id}` |
| Search | `POST /projects/{id}/case-search`, `GET /projects/{id}/case-search/fields` |
| Plans | `GET`/`POST /projects/{id}/plans`, `PATCH`/`DELETE /plans/{id}`, `GET /plans/{id}/cases?test_run_id=`, `POST /plans/{id}/cases`, `DELETE /plans/{id}/cases/{caseId}`, `POST`/`DELETE /plans/{id}/suites/{suiteId}/cases` |
| Runs and results | `GET`/`POST /plans/{id}/runs`, `PATCH`/`DELETE /runs/{id}`, `POST /runs/{id}/results` (one result), `POST /runs/{id}/results/batch` (CI) |
| Reports | `GET /projects/{id}/reports`, `POST /projects/{id}/reports/{reportId}` |
| Report email | `POST /projects/{id}/report-emails`, `GET`/`POST /projects/{id}/report-schedules`, `PUT`/`DELETE /report-schedules/{id}`, `POST /report-schedules/{id}/send-now` |
| Import and export | `POST /projects/{id}/imports/dry-run`, `/imports/execute`, `GET /projects/{id}/imports/custom-field-options`, `POST /projects/{id}/exports/definitions`, `POST /projects/{id}/exports/results` |
| API tokens | `GET`/`POST /projects/{id}/api-tokens`, `DELETE /api-tokens/{id}` |
| Admin | `/admin/users` (`PATCH /admin/users/{id}` for status; `PATCH …/roles`; `PUT …/permission-overrides`; `POST …/reset-password`), `PATCH /admin/roles/{id}`, `PATCH /admin/custom-fields/{id}`, `PUT /admin/email-settings`, `POST /admin/email-settings/test`, `GET /admin/last-email`, `GET /admin/audit-logs`, `GET /admin/permissions` |
| Unchanged | `GET /api/v1/health`, `POST /mcp` |

With items addressed by their own id, the server works out the project from the item. A request that also names a project must name the same one, or it's refused (`400 PROJECTS_DIFFER`).

### 2. Version the API

**Status:** Decided (2026-10-11): the cleaned-up API from step 1 becomes the stable `/api/v1`, with no aliases for old addresses.

**What:** decide how the API changes once it's published.

**Recommendation:** the cleaned-up API from step 1 becomes the stable `/api/v1`; it's safe to change v1 now because nobody depends on it yet. After publishing:
- additions are fine;
- breaking changes go into `/api/v2`, while v1 keeps working for a stated period.

**Open question:** keep the current addresses working temporarily as aliases, or just change them?

### 3. OpenAPI spec and docs page

**Status:** Not started

**What:**
- Add a schema to every route (inputs, outputs, errors).
- Generate the spec with `@fastify/swagger`.
- Serve the docs page with "try it" at `/docs`.
- Add a test that real responses match the spec.

**Recommendation:**
- Do it area by area, together with step 1, so each area is cleaned up and documented once.
- The schemas replace the hand-written checks in `resultValidation.ts`, `stepValidation.ts` and similar.
- Keep a short getting-started guide (tokens, first call, sending CI results) beside the generated reference.

**Open questions:**
- Swagger UI or Scalar for the page?
- Should `/docs` be public, or need a sign-in?

**Needs:** new npm packages (ask before downloading).

### 4. Paging and filtering for lists

**Status:** Not started

**What:**
- Lists return a page at a time (e.g. 100) with a way to ask for the next page.
- Common filters: status, verdict, "changed since".

**Recommendation:**
- Use cursor paging (a "next page" token), which stays fast on large tables.
- Start with the lists that grow: cases, results, audit log, case history.
- The web app may keep loading whole projects at first.

### 5. Make CI integration easy

**Status:** Not started

**What:**
- A guide and ready-made examples for common setups: GitHub Actions, GitLab CI, JUnit result files.
- Possibly a small command-line uploader.
- Possibly a client library generated from the spec (step 3).

**Recommendation:** after step 3, since the examples and libraries should come from the published spec.

### 6. Write tools for MCP agents

**Status:** Not started

**What:** MCP tools that change things, such as creating and editing test cases, recording results, creating plans and runs, and adding cases to plans.

**Recommendation:**
- Give agents their own permissions and limits.
- Use a safe default: agents create drafts, and a person approves them. That fits the existing DRAFT → APPROVED lifecycle.
- Mark write tools clearly, and audit-log every agent change. RFC 04 threat vector 7 covers prompt injection risks.

**Open questions:**
- Which actions should agents be allowed first?
- Should agent-created cases always need human approval?

### 7. Webhooks

**Status:** Not started

**What:** Testify calls other systems when something happens, such as a run finishing, a test failing or a case being approved, so Slack, a bug tracker or CI can react. Each call is signed so the receiver can trust it. Designed in RFC 03 §7.3; not built.

**Recommendation:** after steps 1-3. Needs a settings screen, retries for failed deliveries, and a delivery log.

### Related gaps worth doing alongside

- Plan and run create/edit/delete write no audit entry (add with step 1).
- `allow_draft_plan_linking` has no UI (a project settings form).
- Step-level results can be sent through the API but not recorded in the web app.

---

## Recommended order

1. **Steps 1 and 2:** consistency and versioning. Decisions first, since they shape everything else.
2. **Steps 3 and 4:** spec, docs page and paging, done area by area together with step 1's changes.
3. **Step 5:** CI integration, built on the published spec.
4. **Steps 6 and 7:** agent writes and webhooks.

---

## Decisions

| Date | Decision | Notes |
| :--- | :--- | :--- |
| 2026-10-11 | Prefer an OpenAPI spec with a served docs page over a hand-written reference. | Recommended; confirm during planning. |
| 2026-10-11 | Shallow addresses: lists and creation under the parent (`/projects/{id}/plans`), each item by its own id (`/plans/{id}`). | Chosen over fully nested and flat. |
| 2026-10-11 | Short path names: `/suites`, `/cases`, `/versions`, `/plans`, `/runs`, `/results`. | |
| 2026-10-11 | Rename in the database too: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`. | Migration `007`. |
| 2026-10-11 | Id fields use the database column names (`test_plan_id`, `test_run_id`, ...) everywhere in the API. | One name per id, no translation layer. |
| 2026-10-11 | No aliases: old addresses change outright; the cleaned-up API becomes the stable `/api/v1` (step 2). | Nothing outside Testify uses the API yet. |
| 2026-10-12 | `PUT` stays for updates that replace the whole thing: report schedules and the email settings. Everything else that updates part of an item is `PATCH`. | Found while converting; a missing field in those bodies clears the value. |
| 2026-10-12 | Removing a whole suite from a plan answers 200 with counts, not 204. | The counts (`removed`, `retired`, `skipped`) are what the web app shows. |
