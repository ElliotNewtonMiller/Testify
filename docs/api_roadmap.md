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
2. **Inconsistent, because it grew feature by feature:**
   - Some addresses sit under a project (`/api/v1/projects/{projectId}/test-cases`), others don't (`/api/v1/test-cases/{caseId}/latest-version`, `/api/v1/test-plans/{planId}/cases`).
   - Errors come in two shapes. Most routes send a plain `{ error, code }` (about 160 places). The shared helpers in `errors.ts` send problem details (`type`, `title`, `status`, `code`, `detail`, `invalid_params`); they're used for validation, conflicts and permission refusals.
   - Test runs are still `builds` in addresses and fields.
   - The single-result route lives in `server.ts`, not with the other routes.
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

**Status:** In progress. Plan: shallow addresses, short path names, database renamed too, no aliases (Decisions below). Stage 1 of 4 (database rename) done 2026-10-11.

**What:** decide the conventions, then change the routes to follow them:
- one address style (everything under `/projects/{projectId}/...`, or flat resources);
- one error format (problem details everywhere is the natural choice);
- "run" instead of "build" in addresses and fields;
- naming of fields and query parameters;
- what list, create and update responses look like.

**Why now:** nothing outside Testify depends on the API yet. Once people write scripts against it, every change breaks them.

**Recommendation:** do this first, and write the result into RFC 03 to replace §1-4. The web app changes along with the routes.

**Open questions:**
- Nested or flat addresses?
- Rename `builds` in the database too, or only in the API?

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
