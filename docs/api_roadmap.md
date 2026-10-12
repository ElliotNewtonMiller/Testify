# API & MCP Roadmap

The next steps for Testify's API and MCP endpoint, with recommendations, open questions and status. Keep it current as the work happens:
- update each step's **Status** line;
- record decisions in the **Decisions** table;
- add each finished change to `docs/changelog.md` as usual.

Status values: **Not started**, **Planning**, **In progress**, **Done**, **Dropped**.

---

## Where the API stands (2026-10-12)

**Good:**
- **Coverage:** about 84 endpoints cover nearly everything the web app does: projects, suites, cases and versions, plans, runs, results, search, import, export, custom fields, admin, API tokens, reports and report emails. The web app itself uses these endpoints, so anything you can click, a script can do.
- **Security:** project-bound API tokens (`tf_ci_...`), permissions checked per project, rate limits and an audit log (RFC 04).
- **CI:** results arrive in batches of up to 5,000 per request (`POST /api/v1/runs/{runId}/results/batch`).
- **Consistent** (step 1, 2026-10-12): one address style, verbs and status codes, one error format, one name per id, "runs" and "results" throughout.
- **Agents:** `POST /mcp` lets them list projects, search and read cases, and run every report.

**Weak:**
1. **Documented by hand only.** RFC 03 §1-4 has the conventions, every route and the error codes, with examples; [reports_api_and_mcp.md](reports_api_and_mcp.md) covers reports, MCP and CI results in depth. Request and response fields for most routes still have to be read from the code in `apps/server/src/routes/` (step 3).
2. ~~**Inconsistent, because it grew feature by feature.**~~ Fixed by step 1 (2026-10-11/12). Before, some addresses sat under a project and others didn't, errors came in two shapes, and runs were `builds` in addresses and fields.
3. **No paging.** Lists return everything at once. That's fine now, but will be slow with tens of thousands of cases or results.
4. **Machine-readable description in progress.** The OpenAPI spec (`/docs/json`) and docs page (`/docs`) cover sign-in, projects, plans, runs and results so far (step 3).
5. **Agents can only read.** MCP has no tools to create cases, record results or manage plans.
6. **Reads are coarse** (step 8): no fetching a single item by id, no dedicated list of a run's results, readable ids (SHOP-12) accepted almost nowhere, only a case's latest version.
7. ~~**API tokens reach global admin routes.**~~ Fixed 2026-10-12 (see below).

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

## Fixed first: API tokens on global admin routes

**Status:** Done (2026-10-12), both parts. Found the same day.

**The problem.** An API token is bound to one project, and the docs promise that binding is "checked centrally for every route". It's only checked when the request names a project. The admin routes (users, roles, custom fields, email settings, the audit log) don't name one, so the binding doesn't apply there. A token whose capabilities include an admin permission works across the whole system. Checked with a token made for one project holding `USER_MANAGE` and `CUSTOM_FIELD_MANAGE`; it could:
- list every user (names, emails, roles, permissions);
- read the whole Security Audit Log, every project's entries included;
- create users, though only with the empty No Access role, since the guard limits it to permissions it has globally (none);
- create a global custom field, which appears in every project and is written into every existing case if it has a default.

**Why it matters even though someone had to grant the permission.** The token does need the permission, granted by someone who holds it. But:
- **Who can grant it:** a token's ceiling is its issuer's permissions *in that project*. Someone who is an admin only in one project (a project role) can therefore make a token that does these things everywhere, which they can't do themselves.
- **Wider reach than the label:** the token is listed under one project's API Tokens and looks project-bound, so a leaked CI token can do far more than its owner expects.

**Recommendation:** refuse API tokens on every route that doesn't belong to a project (`/admin/...`), and stop offering admin-only permissions (`USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, and any others that only gate global routes) as token capabilities. Admin automation, if wanted later, gets its own kind of credential.

**What was done (decided with Elliot: both):**
- **Tokens refused outside a project.** Any route whose address names no project item answers a token with `403 TOKEN_NOT_ALLOWED`: every `/admin/...` route, creating a project, changing your own account. It's deny by default (`tokenMayUseRoute` in `middleware/auth.ts`), so a new route of this kind is closed to tokens without anyone remembering to list it. The exceptions stay within the token's project anyway: `GET /auth/me`, `GET /projects` (only its own project) and `/mcp` (each tool call checks its project).
- **System-wide permissions can't be given to a token:** `USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, `PROJECT_CREATE` and `API_TOKEN_MANAGE` (a token's own tokens would never work, since their issuer isn't a user), on top of `SYSTEM_ADMIN`. Asking for one is `400 CAPABILITY_NOT_GRANTABLE`, the API Tokens tab no longer offers them, and existing tokens lose them on their next use.
- Admin automation, if wanted later, gets its own kind of credential.

## Steps

### 1. Make the API consistent

**Status:** Done (2026-10-12). All four stages finished; see below and the Decisions table.

**What:** decide the conventions, then change the routes to follow them:
- one address style (everything under `/projects/{projectId}/...`, or flat resources);
- one error format (problem details everywhere is the natural choice);
- "run" instead of "build" in addresses and fields;
- naming of fields and query parameters;
- what list, create and update responses look like.

**Why now:** nothing outside Testify depends on the API yet. Once people write scripts against it, every change breaks them.

**Recommendation (followed):** do this first, and write the result into RFC 03 to replace §1-4. The web app changes along with the routes.

**Decided:** shallow addresses, short path names, `builds`/`executions` renamed in the database too, no aliases (see Decisions).

**Stages** (each its own commit, tested by Elliot before the next):
1. **Database rename. Done 2026-10-11.** Migration `007`: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`, with their columns, constraints and indexes. The code that talks to them was renamed to match; the API was unchanged.
2. **One error format. Done 2026-10-12.** Every error is problem details (`application/problem+json`, with `code` and `detail`), sent through `sendError` in `apps/server/src/errors.ts`; unknown addresses and Fastify's own errors too. The web app reads messages through `errorMessage()` in `apps/web/src/api/errors.ts`. `apps/server/tests/api_conventions.test.ts` checks the format for every kind of error.
3. **Addresses, verbs and names. Done 2026-10-12.** The route map in RFC 03 §2; `PATCH` for partial updates; `201`/`200`/`204` for create/update/delete; `?force=true` for "delete anyway"; snake_case bodies; id fields named after the database columns (`test_plan_id`, `test_run_id`, ...); "run" and "result" instead of "build" and "execution" in addresses, fields, error codes and new audit rows (old audit rows keep their names). The web app's addresses move into one file (`apps/web/src/api/routes.ts`). A data migration (`008`) renames `plan_id` to `test_plan_id` inside stored report schedules. Two kept `PUT`, because each replaces the whole thing: updating a report schedule and saving the email settings. Removing a whole suite from a plan answers 200 with counts (`added`, `removed`, `retired`, `skipped`) rather than 204. `api_conventions.test.ts` checks the new shapes, that no response says "build" or "execution", and that the old addresses answer 404.
4. **Documentation. Done 2026-10-12.** RFC 03 §1-4 now describes the API as built: the conventions, the full route map, the CI batch format and the error codes. The other docs use the new addresses and names.

**Route map:** [RFC 03 §2](rfc_03_api_and_xml_contracts.md) (the one place it's kept). With items addressed by their own id, the server works out the project from the ids; a request naming ids from two projects is refused (`400 PROJECTS_DIFFER`).

### 2. Version the API

**Status:** Decided (2026-10-11): the cleaned-up API from step 1 becomes the stable `/api/v1`, with no aliases for old addresses.

**What:** decide how the API changes once it's published.

**Recommendation:** the cleaned-up API from step 1 becomes the stable `/api/v1`; it's safe to change v1 now because nobody depends on it yet. After publishing:
- additions are fine;
- breaking changes go into `/api/v2`, while v1 keeps working for a stated period.

**Open question:** keep the current addresses working temporarily as aliases, or just change them?

### 3. OpenAPI spec and docs page

**Status:** In progress. Stage 1 of 4 done (2026-10-12).

**What:**
- Add a schema to every route (inputs, outputs, errors).
- Generate the spec with `@fastify/swagger`.
- Serve the docs page with "try it" at `/docs`.
- Add a test that real responses match the spec.

**How it works** (`apps/server/src/openapi/`):
- **The page and spec:** Swagger UI at `/docs`, the spec at `/docs/json` and `/docs/yaml`, open to anyone. "Try it out" sends real requests: with the browser's session cookie (the page adds the `X-Testify-Client` header), or with a token entered under "Authorize". Routes without a schema yet are left out of the spec.
- **Route schemas** live in `openapi/areas/<area>.ts`; shared ones (`Problem`, `User`, `Project`, `Plan`, `Run`, ...) in `openapi/schemas.ts`, which become `#/components/schemas/...`.
- **Requests are validated** against them: bodies exactly as sent, query strings and path parameters with type coercion. A mismatch is `400 INVALID_REQUEST` naming each field. Routes that already check their input more precisely (single and batch results) keep their own checks; their body schema is documentation only (`handlerValidated`).
- **Responses aren't changed** by their schemas: they're serialized with plain `JSON.stringify`.
- **Tests keep the spec honest:** in tests every JSON response is checked against its route's schema, undocumented fields included; a mismatch fails the request with a message naming the field. So every existing test is also a contract test.

**Stages** (each its own commit, tested by Elliot before the next):
1. **Infrastructure and the first area. Done 2026-10-12.** The packages, the page, validation, the response check; sign-in, projects, plans, runs and results (18 routes). `apps/server/tests/openapi.test.ts`.
2. **Specification and plans.** Not started. Suites, cases, versions, custom-field values, search, move, the spec tree, plan membership and the Execute queue.
3. **Everything else.** Not started. Reports, report email, import, export, API tokens, admin, health, and `/mcp` described. Then every route is in the spec, and a test checks that none is missing.
4. **Getting-started guide and docs.** Not started. A short guide (tokens, first call, sending CI results) beside the reference; RFC 03 points to `/docs` for field-level detail.

**To improve while doing stages 2-3:** Swagger UI's "Example Value" view shows only one value per field (e.g. `"verdict": "PASSED"`). The allowed values are in the "Schema" view next to it. List them in each field's description too, so they show in both views.

**Open questions:** none.

**Needs:** `@fastify/swagger` and `@fastify/swagger-ui` (installed 2026-10-12, with Elliot's OK); `ajv`, which Fastify already used, is now a direct dependency.

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

### 8. Fill the read gaps

**Status:** Not started. Added 2026-10-12.

**What:** reads a script needs and doesn't have today:
- **Single items by id:** `GET /projects/{id}`, `/plans/{id}`, `/runs/{id}`, `/suites/{id}`, `/cases/{id}` (the case with its latest version and steps), `/results/{id}` (with step results). Today only lists exist, or the whole project's tree.
- **A run's results:** `GET /runs/{id}/results`, every result with its duration, notes, error, step results and who recorded it, filterable by verdict and case; paged (step 4). Today the options are the Execute queue (latest verdict only), the reports, or an export (limited to 120 an hour).
- **Readable ids:** accept a case's external id (SHOP-12) wherever a case id is taken, or add a lookup (`GET /projects/{id}/cases?external_id=SHOP-12`). Today only CI batches and the case-history report accept them.
- **Version history:** `GET /cases/{id}/versions` (every version, not just the latest) and `GET /versions/{id}`.
- **Report schedule recipients:** a way to add or remove one recipient (`PATCH /report-schedules/{id}` with only `recipients`), instead of resending the whole schedule.

**Why:** with these, a script can find something by its readable id, read it, and act on it in one or two calls, instead of searching, downloading whole lists and chaining lookups.

**Recommendation:** after step 3 stages 2-3, so the new routes get their schemas as they're added; together with step 4 (paging) for the lists. Bulk changes (e.g. deprecating many cases in one call) belong in the same pass.

### Related gaps worth doing alongside

- Plan and run create/edit/delete write no audit entry (add with step 1).
- `allow_draft_plan_linking` has no UI (a project settings form).
- Step-level results can be sent through the API but not recorded in the web app.

---

## Recommended order

1. **Steps 1 and 2:** consistency and versioning. Done.
2. **Fix first:** API tokens on global admin routes. Done.
3. **Step 3:** finish the spec and docs page (stages 2-4).
4. **Steps 8 and 4:** the missing reads and paging, together.
5. **Step 5:** CI integration, built on the published spec.
6. **Steps 6 and 7:** agent writes and webhooks.

---

## Decisions

| Date | Decision | Notes |
| :--- | :--- | :--- |
| 2026-10-11 | Prefer an OpenAPI spec with a served docs page over a hand-written reference. | Confirmed 2026-10-12 (step 3). |
| 2026-10-11 | Shallow addresses: lists and creation under the parent (`/projects/{id}/plans`), each item by its own id (`/plans/{id}`). | Chosen over fully nested and flat. |
| 2026-10-11 | Short path names: `/suites`, `/cases`, `/versions`, `/plans`, `/runs`, `/results`. | |
| 2026-10-11 | Rename in the database too: `builds` → `test_runs`, `executions` → `test_results`, `execution_steps` → `test_step_results`. | Migration `007`. |
| 2026-10-11 | Id fields use the database column names (`test_plan_id`, `test_run_id`, ...) everywhere in the API. | One name per id, no translation layer. |
| 2026-10-11 | No aliases: old addresses change outright; the cleaned-up API becomes the stable `/api/v1` (step 2). | Nothing outside Testify uses the API yet. |
| 2026-10-12 | `PUT` stays for updates that replace the whole thing: report schedules and the email settings. Everything else that updates part of an item is `PATCH`. | Found while converting; a missing field in those bodies clears the value. |
| 2026-10-12 | Removing a whole suite from a plan answers 200 with counts, not 204. | The counts (`removed`, `retired`, `skipped`) are what the web app shows. |
| 2026-10-12 | Swagger UI for the docs page. | Chosen over Scalar: it serves all its files from Testify, so it works without internet access. |
| 2026-10-12 | `/docs` and the spec are open to anyone. | They describe the API, not data; "Try it out" still needs a sign-in or token. |
| 2026-10-12 | Schemas validate requests, but don't replace the routes' own checks where those give more specific errors (results, batch). Responses are never reshaped by schemas; tests check them instead. | Keeps behaviour and error codes the same while the spec is added area by area. |
