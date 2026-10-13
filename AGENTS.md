# Testify — Agent / Contributor Guide

This file orients any AI coding agent (Claude, Gemini/Antigravity, etc.) or human contributor working in this repo. It describes how things are **now**. The history behind them -- every change, why it was made and how it was tested -- is in `docs/changelog.md`. Read this file before making changes, and check `docs/changelog.md` before changing something that looks odd: it's often a decision made with Elliot (the project's owner).

## What Testify is

Testify is an open-source, self-hosted test case management app meant to replace TestLink. It's feature-complete enough to deploy (README, Docker, CI, production build).

**Specification:**
- Projects contain a tree of test suites, which contain test cases.
- Each test case has versions (DRAFT → APPROVED → DEPRECATED) holding the summary, preconditions and steps.
- Admins can define custom fields (six types) on cases and suites.

**Execution:**
- A test plan pins a set of cases at a version; a test run belongs to a plan. Runs and results are `test_runs`/`test_results` in the database and "runs"/"results" in the API (older docs and audit rows say "build" and "execution").
- Results are recorded per case in a run: by people with hotkeys in the web app, or by CI through the batch API (JSON, or a JUnit XML file, optionally into a run named by the build and created on first use).

**Everything else:**
- Reports: run summaries and diffs, trends, flaky and slow tests, case history, breakdowns. They're available in the app, the REST API, scheduled email and MCP.
- Webhooks: a project's events (runs, results, test cases, imports) sent as they happen, as signed JSON or Slack-style messages, with retries and a delivery log.
- Import (TestLink XML, JUnit XML, TestRail CSV, CSV, JSON) and export (JSON, CSV).
- Editable roles, per-project roles and permission overrides, and project-scoped API tokens.

Not built:
- Attachments (no file storage; the planned `IStorageProvider`).
- Detailed schemas for report outputs in the OpenAPI spec (only their top level is described; every route is in it).
- Step-level results in the web app; the API accepts them.

## Running things

```bash
npm install
npm test                                 # every test (Vitest), all workspaces
npm run typecheck                        # tsc --noEmit in all four workspaces
npm run dev --workspace=apps/server      # API on :3001, in-memory database (src/dev.ts sets DATABASE_URL=memory)
npm run dev --workspace=apps/web         # web app on :3000, proxies /api to :3001
npm run build                            # production: apps/web/dist + apps/server/dist/server.js
npm start                                # production: one process serving the API and web app (needs DATABASE_URL, JWT_SECRET)
docker compose up -d                     # Testify + PostgreSQL; copy .env.example to .env first
npx tsx apps/server/scripts/report-demo.ts   # loads a demo project with 8 runs of results through the API
```

**Development database:**
- The dev server uses an in-memory database (PGlite), so every restart starts empty and signs everyone out.
- It seeds the role registry, an `admin` / `password` user, and fixture users for each built-in role with password `DevTest123!`: `test_lead`, `tester`, `viewer`, `automation_bot`, `project_admin`, `override_tester`.
- It seeds no projects; run the demo script for data.
- Backend or shared-package changes need a dev-server restart.
- `.claude/launch.json` defines `api-server` and `web` for the preview tools.

**Configuration** comes only from environment variables; there's no `.env` loader except Docker Compose's. A bad value stops startup with a `ConfigError` saying what to set. The full table is in `docs/deployment.md`. In short:
- `DATABASE_URL` is required: a Postgres URL, or `memory` (refused with `NODE_ENV=production`).
- `JWT_SECRET` (32+ characters) is required with a real database.
- Also read: `SECRETS_KEY`, `ADMIN_PASSWORD`, `PORT`, `TRUST_PROXY`, `CORS_ORIGINS`, `LOG_LEVEL`, `WEB_DIST_DIR`, `SEED_SAMPLE_DATA`, `SEED_DEV_FIXTURES`, `WEBHOOK_ALLOW_LOCAL`.
- All of it is parsed in `apps/server/src/config.ts`.

**First admin on a real database:** username `admin`. The password is `ADMIN_PASSWORD` if set; otherwise a random one is printed once in the log, and Testify makes the admin change it at first sign-in.

## Repo layout

npm workspaces (root `package.json`: `packages/*`, `apps/*`). Use `npm run <script> --workspace=<path>`; no pnpm or Turborepo.

```
apps/server/       Fastify API (TypeScript, ESM). Entry src/server.ts (createServer + startup); src/dev.ts for development.
  src/routes/      One file per area: auth, admin, projects (projects/plans/runs), specEditing (suites/cases/versions/move),
                   testPlanCases (spec tree, plan membership, Execute queue), customFields, caseSearch, ingestion (import),
                   exports, results (one result), batchExecution (CI results as JSON), junitResults (CI results as JUnit XML),
                   bulkChanges (many cases in one call), webhooks, reports, reportEmail, emailAdmin, apiTokens.
  src/services/    Logic shared by routes: adminGuard, caseFilterService, reportService, reportEmailService, mailer,
                   rateLimits, loginThrottle, resultValidation, resultOverwrite, stepValidation, secrets,
                   batchResults (recording a CI batch, JSON or JUnit), runByName (CI's run per build),
                   webhooks (the delivery worker), webhookEvents (what each event sends), webhookTargets (address rules).
  src/middleware/auth.ts   Authentication and permission checks (see "Auth and permissions").
  src/mcp/          mcpServer.ts: POST /mcp, read tools over the same services; writeTools.ts: write tools that call
                   the REST routes as the caller (internalRequests.ts).
  src/openapi/     The OpenAPI spec and /docs page: index.ts (setup, validation, test-time response check),
                   schemas.ts (shared schemas, helpers), areas/ (route schemas per area).
  src/{config,errors,audit,observability,webApp,sessionCookie,sessionLifetime,runAutoClose,internalRequests}.ts
  scripts/build.mjs        esbuild bundle (workspace packages bundled, other dependencies external).
apps/web/          React + Vite. src/App.tsx (~680 lines) calls the hooks, provides the context, lays out panes and modals, wires hotkeys.
  src/hooks/       One hook per feature: useSession, useScope (project/plan/run), useExecutionWorkspace, useSpecTree,
                   useCaseSearch, useExecution, useSpecSelection, useCaseEditor, useSuiteEditor, useHotkeyEngine, useFocusFSM, ...
  src/components/  layout/ (header, banners), workspace/ (panes 1-2), spec/ and execute/ (pane 3), reports/ (Reports view), modals,
                   Admin Panel tabs (AdminPanelModal, EmailSettingsPanel, WebhooksPanel).
  src/api/         routes.ts (every API address, as functions) and errors.ts (reading error messages).
  src/app/         AppContext (useApp) and shared messages. src/utils/ pure helpers. src/types.ts shared types.
packages/core/     Domain logic with no database, each module unit-tested: ingestion/ (parsers), export/, reporting/
                   (report math, catalog, email rendering, schedules), rbac/ (permission registry, default roles),
                   custom-fields/ (validation, defaults, type inference, regex time limit), case-filter/, execution/
                   (verdict and status lists), security/ (JWT, password policy), webhooks/ (events, signing, Slack messages,
                   blocked addresses).
packages/db/       Kysely, Postgres-compatible SQL only. createDbClient(): no connection string = in-memory PGlite,
                   otherwise pg. migrations/ (tracked), repositories/, seeds/ (rbac registry, sample project, dev fixtures).
docs/              changelog.md, api_roadmap.md, api_getting_started.md, deployment.md, reports_api_and_mcp.md, and the design docs (RFCs, blueprint, roadmap).
```

## Domain rules

**Test case versions:**
- Content (summary, preconditions, steps) is versioned; title, priority and execution type live on the case and stay editable.
- Content is editable only while the latest version is a DRAFT. Editing an APPROVED case means "Edit" (create a draft copying the latest version) and later Approve.
- Lifecycle is DRAFT → APPROVED → DEPRECATED, and Restore goes from DEPRECATED back to APPROVED. There's no IN_REVIEW.
- A deprecated case can't be edited or added to a plan, and is hidden from the spec tree unless "Show deprecated" (`include_deprecated=true`) is on.
- `SPEC_AUTO_APPROVE` makes new cases start APPROVED, unless a required custom field would be unsatisfied.
- Approving or restoring re-pins the case to that version in every **ACTIVE** plan; LOCKED and ARCHIVED plans keep their pin.

**Plans:**
- Only APPROVED cases can be added to a plan, unless the project setting `allow_draft_plan_linking` is true. That setting has no UI.
- Removing a case that has results **retires** the link (`test_plan_cases.removed_at`) after a confirmation, rather than deleting it. Old runs keep the case where it has a result; it's read-only there unless re-added.
- A run's contents follow `TestResultRepository.getFinalResultsForRuns`, the one rule everything uses: reports, the Execute queue, and the verdict filter.

**Results:**
- Results are never edited; a new row becomes the latest.
- Re-recording a case that already has a result in the run needs `EXECUTE_OVERWRITE`. The exception is re-sending your own latest verdict (adding notes).
- Results are refused on a CLOSED run and on retired links.
- A run auto-closes the first time every case has a result, once only (marked by its `RUN_AUTO_CLOSED` audit row; older runs by `BUILD_AUTO_CLOSED`). Only results recorded one at a time trigger it: CI batches and JUnit uploads never auto-close a run (a build may send several files or be re-run); `close_run=true` closes it.
- Manual (UI) results are never timed: duration is null. Only batch/CI results carry durations.

**Custom fields:**
- Defined globally by admins. Imports can also create project-scoped ones.
- Values are **not versioned** and not recorded on results. The UI only allows editing them while the case is a DRAFT. Elliot chose this; don't "fix" it unprompted.
- A required field must always have a usable default, enforced on create and update. CHECKBOX fields can't be required.
- Creating a field writes its default into every existing case or suite. Making a field required fills blank values with the default. Removing an option deselects it everywhere.
- Validation regexes run in a `node:vm` sandbox with a 50 ms limit.

**Search and ids:**
- Search (`q`) matches a case's external id, title, or the names of its suite and the suites above it, never custom field values.
- Filters (`packages/core/src/case-filter`) are evaluated server-side for the UI, every report's `filter` param and MCP.
- External ids are PREFIX-n, highest + 1, assigned under a per-project advisory lock (`TestCaseRepository.lockExternalIds`). A project's prefix is locked once it has cases.

**Deleting:**
- Projects, suites, cases, plans, runs and custom fields warn first: without `force`, a `409` names what would be lost; with `force=true`, everything is deleted in RESTRICT-safe order.

## Auth and permissions

**Sign-ins:**
- The web app uses an HttpOnly `testify_session` cookie (`POST /auth/login` with `session: "cookie"`). Its writes must send `X-Testify-Client: web` (CSRF guard).
- Scripts use `Authorization: Bearer <jwt>` from a plain login.
- Every sign-in is a server-side session (`sessions` table): 8 hours idle, 7 days maximum.
- Sign-out, a password change (which needs the current password), an admin's password reset, and disabling a user all end sessions.

**Lockouts:**
- 20 wrong passwords lock an account for 15 minutes; an admin can Unlock it.
- 50 failures from one address in 15 minutes block that address.

**API tokens** (`tf_ci_...`):
- Each is bound to one project, so a token used on another project gets 403 (`TOKEN_PROJECT_MISMATCH`).
- Routes outside any project (`/admin/...`, creating a project, `PATCH /auth/me`) refuse tokens (`TOKEN_NOT_ALLOWED`); deny by default via `tokenMayUseRoute`, except `GET /auth/me`, `GET /projects` and `/mcp`. A new route outside a project is therefore closed to tokens automatically.
- A token's capabilities are capped by its issuer's **current** permissions, checked on every use. Disabling the issuer revokes their tokens.
- Some permissions can never be granted to a token: the system-wide `SYSTEM_ADMIN`, `USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, `PROJECT_CREATE`, `API_TOKEN_MANAGE`, and `WEBHOOK_MANAGE` (a webhook sends data anywhere) (`TOKEN_EXCLUDED_PERMISSIONS` in `packages/core/src/rbac/registry.ts`; existing tokens lose them on use).
- Limit: 1,200 requests per minute per token.

**Permissions:**
- The registry is in `packages/core/src/rbac/registry.ts` (20 keys).
- Default roles: Admin, Test Lead, Tester, Viewer, Automation Service and No Access. Roles are editable and deletable once unused. New users default to Tester.
- `SYSTEM_ADMIN` passes every check.
- A project role replaces the global role in that project. Overrides (global or per project) have the final say.
- To limit a user to some projects, give them the No Access global role plus project roles.

**Where permissions are checked** (`apps/server/src/middleware/auth.ts`):
- `authenticateRequest` resolves the request's project from the route's ids (`resolveRequestProject`) and evaluates permissions **in that project**.
- Routes use `requirePermission(key)` or `requireAnyPermission(keys)` as preHandlers.
- Reads needed for executing accept `SPEC_VIEW` or `EXECUTE_RUN` (`EXECUTION_READ_PERMISSIONS`). Without `SPEC_VIEW`, the spec tree only shows the plan's cases.
- `GET /api/v1/projects` lists only projects the caller can view or execute in, with `permissions` for each.
- The web app uses those per-project permissions (`can`); the Admin Panel button and "Create project" use global permissions (`globalCan`).

**Admin changes** go through `services/adminGuard.ts`:
- Nobody can grant a permission they don't hold.
- Nobody can change a user or role that outranks them.
- The last active admin can't be removed.

## Server conventions

- **Routes** (conventions, the full route map and the error codes are in `docs/rfc_03_api_and_xml_contracts.md` §1-4; keep it current when a route changes):
  - Lists and creation sit under the parent (`/projects/:projectId/plans`); each item has its own address (`/plans/:planId`, `/runs/:runId`, `/cases/:caseId`, ...).
  - `authenticateRequest` works out the project from every id the request names (path, query and JSON body) and stores it as `request.projectId`; ids from two projects get `400 PROJECTS_DIFFER`. Routes still check that other ids in the request belong to that project.
  - Verbs: `PATCH` for a partial update; `PUT` only to replace a whole thing (a custom-field value, a user's override set, a report schedule, the email settings); `?force=true` for "delete anyway".
  - Responses: create answers 201 with the item wrapped in its name (`{ "plan": {...} }`), update 200 the same way, delete 204 with no body. Lists are `{ "plans": [...] }`.
  - Lists that grow (a project's cases, a run's results, the audit log, case history) are paged: `limit` and `cursor` in, `next_cursor` out (null on the last page). Keyset helpers are in `packages/db/src/paging.ts`; routes read the page with `readPage` (`apps/server/src/paging.ts`), which answers `400 INVALID_CURSOR`. Short lists stay whole.
  - Fields are snake_case, and ids are named after their database columns (`test_plan_id`, `test_run_id`, `test_case_id`, ...). Never "build" or "execution" in a new address, field or code.
  - A case may be named by its readable id (SHOP-12) wherever a case id is taken: `authenticateRequest` replaces `:caseId`, `test_case_id` and `case_ids` with internal ids once the caller is known (`caseRefs.ts`). A readable id shared by several projects is settled by the request's project or an API token's, otherwise `400 AMBIGUOUS_CASE_ID`.
  - Bulk changes (`routes/bulkChanges.ts`) and MCP write tools run each change through its ordinary route in-process (`innerRequest` in `internalRequests.ts`, as the caller), so they need no rules of their own. Such requests carry a per-process secret: they aren't rate-limited twice, and `internalVia(request)` says `bulk` or `mcp` (`mcp` makes new cases DRAFT and marks audit User-Agents "(via Testify MCP)").
  - In the web app, take addresses from `apps/web/src/api/routes.ts`.
- **Route schemas (OpenAPI):**
  - A documented route has `schema` (tags, summary, params, query, body, responses) from `apps/server/src/openapi/areas/<area>.ts`; shared schemas and helpers (`wrapped`, `list`, `authedErrors`, `NO_CONTENT`, `FORCE_QUERY`, `handlerValidated`, and `oneOf` for any field limited to a set of values, which also lists them in the description) are in `openapi/schemas.ts`. Routes without a tag stay out of the spec, and `openapi.test.ts` fails if any `/api` or `/mcp` route is missing (or mark it `hide: true`).
  - Request schemas are enforced (bodies without type coercion; query and params with it), giving `400 INVALID_REQUEST` with `invalid_params`. Mark a body `handlerValidated` when the route checks it itself with more specific errors.
  - Response schemas never change a response (plain `JSON.stringify`). In tests every JSON response is checked against its schema, undocumented fields included; a mismatch answers 500 and prints `[openapi] ...`. When you change a route's output, change its schema.
- **Errors:**
  - Every error is problem details (`application/problem+json`): `type`, `title`, `status`, `code`, `detail` (the message people see), the request path as `instance`, `timestamp`, optional `invalid_params: [{ name, reason }]`, and extension fields in snake_case (e.g. `required_permission`, `project_ids`).
  - Send errors with `sendError(reply, status, detail, { code?, invalid_params?, ...extensions })` from `errors.ts`, or one of its specific `send*Error` helpers. `code` defaults from the status (404 → `NOT_FOUND`).
  - Throw a plain `Error` only when its message is meant for users (`isPublicError`).
  - Anything else becomes a generic 500 with a `request_id`, and the details go only to the log. Unknown addresses get a 404 in the same format.
  - Exceptions: the MCP endpoint answers in JSON-RPC (the protocol requires it), and a batch request's per-item results carry their own `detail`/`code` inside a normal response.
  - In the web app, read error messages with `errorMessage(body)` from `apps/web/src/api/errors.ts`.
- **Audit rows:**
  - Write one for every security-relevant change, with `...requestOrigin(request)` (real address and User-Agent) and `actor_type: actorType(user)` (`SERVICE_ACCOUNT` for an API token).
  - A new action only shows in the Admin Panel's Security Audit Log once it's added to `securityActions` in `routes/admin.ts`.
  - Plan and run create/edit/delete currently write none.
- **Webhook events:** after a change commits, call the matching helper in `services/webhookEvents.ts` (`emitRunClosed`, `emitResultsRecorded`, ...); it queues deliveries for subscribed webhooks and never throws. A new event goes into `WEBHOOK_EVENTS` (`packages/core/src/webhooks/`), the Slack renderer there, and RFC 03 §7.3.
- **Validate input up front** (`resultValidation.ts`, `stepValidation.ts`, `nameProblem` in `specEditing.ts`), so bad input gets a 400 naming each field instead of a database error.
- **Transactions:** group a change into one transaction. Repositories that may run inside a caller's transaction use the `runInTransaction` pattern (if `db.isTransaction`, run directly; otherwise open one).
- **Schema changes:** a new migration `packages/db/src/migrations/00N_<name>.ts` with `up` and `down`, registered in `MIGRATIONS`. Never edit a migration that has shipped; databases record which ones they ran. Ids are `varchar(36)` UUIDs, so never prefix them.
- **Logging and limits:**
  - Logs are JSON lines to stdout (`observability.ts`). Never log headers or bodies.
  - `GET /api/v1/health` is the health check.
  - Rate limits live in `services/rateLimits.ts`, per process: 120 exports per hour and 60 report emails per hour per caller.
  - Imports: at most 50 MB per file, 2 at a time.
  - CSV exports neutralize spreadsheet formulas.
- **Sending responses:** only set `Content-Type: application/json` when there's a body. Fastify answers 400 to an empty JSON body.

## Web conventions

- **State lives in feature hooks**, each returning one object (`type X = ReturnType<typeof useX>`), passed to panes as props.
- **`useApp()`** gives only app-wide values: `currentUser`, `handleLogout`, `handleAuthExpiry`, `showToast`, `can`, `globalCan`, `scope`.
- **Hook order in `App.tsx` matters:** each hook needs values from the ones above it.
- **Requests:**
  - Use `authHeaders()` / `jsonHeaders()` from `utils/session.ts`; never store a token.
  - Any 401 from `/api` signs the user out with "Your sign-in has ended" (`watchForEndedSession`).
- **Loaders that can race** keep a request-sequence ref and apply only the latest response. Clearing state on an empty selection must happen before an early return.
- **Custom-field inputs:**
  - Text, number and date inputs are uncontrolled. Key them per entity *and* field, and clear values before fetching, or one case's value shows on another.
  - A rejected save remounts the input so it shows the stored value again.
- **UI patterns:**
  - Warnings and confirmations use the amber banner; deletes use the two-step warn-then-"Delete Anyway" flow.
  - Toggles are colored squares or pills, as in `CustomFieldEditor` and the permission grids. Only the email settings and schedule forms use native checkboxes.
  - The app starts in Spec mode.
- **Hotkeys** (`useHotkeyEngine`):
  - `j`/`k` move, `/` focuses search, `[`/`]` collapse and expand the tree.
  - `p`/`f`/`b`/`s` record a verdict in Execute mode, and Ctrl+Enter submits notes and jumps to the next folder.
  - Verdict keys are blocked in Spec mode, on closed runs and without permission.

## Decisions to keep

These were chosen deliberately; don't reverse them without asking Elliot.

- **PostgreSQL only.** SQLite was dropped (native-binding problems), and PGlite is the zero-setup in-memory option. Don't add a second dialect.
- **No sample projects on startup.** Users and roles are seeded, plus dev fixture users on the in-memory database. The sample project exists only for tests (`SEED_SAMPLE_DATA`).
- **Role templates and template-based dev accounts stay** (audit scope).
- **Custom field rules:** values are unversioned, required fields always have a default, CHECKBOX fields can't be required (see "Domain rules").
- **Results:** notes are kept for every verdict, manual results aren't timed, auto-close happens once and never from CI uploads, results don't snapshot custom fields.
- **Search** covers ids, titles and suite names, not custom field values.
- **Rate limits are generous**, since CI and agents make many calls.
- **Sign-ins:** 8 hours idle and 7 days at most.
- **The Execute-mode suite filter** (`execSuiteFilterId`) is separate from Spec-mode suite selection.
- **Pane widths aren't persisted.**
- **AI agents (MCP):** cases they create are always DRAFT, editing an approved case makes a new DRAFT, and there are no MCP tools to approve, deprecate, restore or delete. Write tools act only as the caller, through the REST routes.

## Known gaps

- Plan and run create/edit/delete write no audit entry.
- No UI for `allow_draft_plan_linking`.
- Imports:
  - No remembered field mappings and no per-case duplicate-resolution UI.
  - TestRail CSV supports only the combined Steps/Expected Result column format.
  - Files are held in memory, hence the 50 MB cap.
- CSV re-import is lossy in two ways:
  - Any priority other than HIGH/MEDIUM/LOW becomes MEDIUM.
  - A custom field named like a built-in column (`title`, `suite`, `action`, ...) is read as that column.
- No "sign out everywhere" button or list of your sessions. Changing `SECRETS_KEY` has no rotation; the SMTP password must be re-entered.
- Several server instances share the database, but rate and sign-in limits are counted per instance.
- A custom-field change made by another admin shows only after the next case or suite switch or a reload; nothing is pushed.
- `AuditLogRepository` is used only by tests; routes insert audit rows directly.
- Recharts 2 is deprecated upstream; the Recharts 3 upgrade hasn't been done.
- Webhooks:
  - A webhook that keeps failing isn't turned off automatically; each delivery gives up after 6 attempts.
  - No filters beyond events (e.g. only one plan's runs), and no Teams card format.
  - Events are queued just after their change commits, so a crash between the two loses one. Order isn't guaranteed across retries.
  - The Admin Panel's Webhooks tab (and the Admin Panel button) follow global permissions, like API Tokens: someone with `WEBHOOK_MANAGE` only through a project role uses the API.

## Testing and verification

- **Commands:** `npm test` runs every test; it must stay green. `npm run typecheck` must stay clean.
- **Where tests live:**
  - Server tests start a real server per test on an in-memory database (`createServer()`) and use `app.inject`.
  - Web tests are pure-logic tests, plus `apps/web/src/tests/app.smoke.test.tsx` (jsdom), which renders `<App />` against a fake API.
- **CI** (`.github/workflows/ci.yml`) also runs the production build against real PostgreSQL and builds the Docker image.
- **Verify browser-visible changes live** in a separate origin (`http://127.0.0.1:3000`), so Elliot's sign-in at `localhost:3000` isn't affected. Never drive automated drags in his browser-pane tab; use a fresh tab.
- **Dev servers** may be restarted at any time; their data is throwaway.

## Workflow

- **Every change gets an entry at the end of `docs/changelog.md`:** what changed, why, decisions made with Elliot, tests added, and how it was verified.
- **Update this file** only when a fact, convention, decision or gap above changes. Keep it describing the present.
- **`AGENTS.md` is an identical copy** of this file for other agents. Update both together.
- **Commits:** Elliot has authorized committing directly to the local repo, in logical commits with clear messages. There's no git remote; don't add one or push unless asked.
- **Ask before downloading** packages or images.
- **After a change,** give Elliot a short checklist of what to test.
- **API work:** `docs/api_roadmap.md` tracks the planned API and MCP steps. Update a step's status and the Decisions table as the work happens.
- **Design docs:** when a change makes an RFC, the blueprint or the roadmap wrong, fix that doc in the same change.

## Doc map

1. `README.md`: overview and quick start. `docs/deployment.md`: running Testify for real.
2. `docs/changelog.md`: the history and reasoning behind everything.
3. `docs/api_getting_started.md`: the API for scripts and CI, step by step. `docs/reports_api_and_mcp.md`: reports, the results API, MCP. The reference itself is `/docs` on a running server.
4. `docs/api_roadmap.md`: where the API stands, and the planned next steps for the API and MCP, with their status.
5. Design documents, updated 2026-10-11 (RFC 03 §1-4 on 2026-10-12) to match the code (each says plainly what isn't built):
   - `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`: the overview, linking to the RFCs.
   - `docs/rfc_01_domain_model.md` (domain, schema, state machines), `rfc_02` (layout, hotkeys), `rfc_03` (the API: conventions, route map, CI results, errors, import), `rfc_04` (permissions, tokens, audit, threat model).
   - `docs/01_vertical_slices_roadmap.md`: what each build slice planned and delivered.
   - `docs/00_requirements_alignment.md` (identical to `.antigravity/requirements_alignment.md`): the locked intake decisions, with "As built" notes.
   - `.antigravity/agents/*.md`: the original planning briefs; they record what was asked for, not what was built.
