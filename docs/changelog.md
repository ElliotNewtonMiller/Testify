# Testify change log

One entry per change, oldest first: what was changed, why, what was decided with Elliot, and how it was tested. Add a new entry at the end for every change.

The entries describe the code **as it was at the time**. Later entries often replace earlier ones -- for example, entries before 2026-10-07 edit `001_initial_schema.ts` in place, which is no longer allowed, and entries before 2026-10-09 refer to a single large `App.tsx`. For how things are now, read `CLAUDE.md`; this log explains how they got that way.

Entries up to 2026-10-11 lived in `CLAUDE.md` and were moved here unchanged on 2026-10-11.

## SQLite support was dropped (2026-09-11) — Postgres-compatible SQL only, everywhere

The original roadmap called for a true dual-driver DB layer: literal SQLite (`better-sqlite3`, a native binding) for local/offline use, and real Postgres for production. In practice, `better-sqlite3`'s prebuilt binary needed a newer glibc than the dev machine had (Ubuntu 22.04 / glibc 2.35) and couldn't be rebuilt from a sandboxed shell with no network access — a real cross-platform fragility risk for an open-source project, not just a local quirk. A deliberate decision was made to drop SQLite entirely rather than fix the native binding, since `packages/db/src/dialects/postgres.ts` already had a zero-config fallback that works everywhere with zero native dependencies: when `createDbClient()`/`createPostgresClient()` gets no `connectionString`, it spins up an ephemeral `@electric-sql/pglite` instance (a WASM build of real Postgres) instead of connecting to a server.

What changed:
- `packages/db/src/dialects/sqlite.ts` deleted; `better-sqlite3` and `@types/better-sqlite3` removed from `packages/db/package.json` and `node_modules` (`npm uninstall` + `npm prune`, both ran fine offline).
- `packages/db/src/client.ts`: `DbClientConfig` no longer has a `driver` field — just an optional `connectionString`. `createDbClient()` (no args) = ephemeral PGlite. `createDbClient({ connectionString: '...' })` = real Postgres.
- `packages/db/src/migrations/001_initial_schema.ts`: the `isPostgres`/`isSqlite` branching for the `audit_logs` immutability triggers and the SQLite `PRAGMA foreign_keys` toggling in `up()`/`down()` are gone — there's one trigger implementation (real Postgres syntax) since there's only one dialect now.
- `apps/server/src/server.ts`: `createServer(driver)` → `createServer(connectionString?)`. The dev-server bootstrap now reads `process.env.DATABASE_URL` (previously nothing read env vars at all, so this is a small new capability, not just a rename) — unset, it falls back to ephemeral PGlite; set it to a real Postgres connection string in production.
- All four `packages/db/tests/*.test.ts` files that parametrized `describe.each` over `['SQLite (in-memory better-sqlite3)', 'PostgreSQL (ephemeral PGlite)']` now just run once, against PGlite, as a plain `describe`. `dual_driver_parity.test.ts` was renamed to `migration_and_crud_integrity.test.ts` and its title/comments/assertions were reworded to drop "dual-driver" framing (the underlying CRUD/FK/migration/audit-trigger checks it runs are all still valid and were kept as-is). `verification_matrix_acceptance.test.ts`'s "[Req 14] Dual-Driver Parity" test was renamed to "[Req 14] Operational Integrity" and now asserts the full core-loop workflow completes cleanly on the one supported engine, rather than claiming SQLite/Postgres parity that no longer applies.
- The three `apps/server/tests/*.test.ts` files that called `createServer('sqlite')`/`createServer('postgres')` now just call `createServer()`.

Result: `npm test` is **66/66 passing, 10/10 test files green** (was 39 failing/49 passing when the glibc issue was first found).

`docs/rfc_01_domain_model.md` **has been updated** (2026-09-11) — its Section 4 ("Dual-Driver Database Normalization (SQLite + PostgreSQL)") was rewritten to "Database Engine: Single Postgres-Compatible Dialect (PGlite + PostgreSQL)", with an amendment note at the top of the doc explaining the change; the rest of that RFC (domain model, ERD, state machines, RBAC, custom fields) was already dialect-agnostic and didn't need changes.

`.antigravity/agents/lead_architect.md`, `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`, and `docs/01_vertical_slices_roadmap.md` were also rewritten (2026-09-14) to match — see "Docs rewritten to match the single-dialect architecture" below. All planning/architecture docs now describe the single-dialect architecture consistently; there's no remaining doc that still calls for a literal dual-SQLite-and-Postgres design.

## Auth: unsigned tokens replaced with signed JWTs (2026-09-11)

`apps/server/src/routes/auth.ts` used to issue `Buffer.from(JSON.stringify({...})).toString('base64')` as the session "token" -- anyone could base64-decode it, change `userId`, and re-encode a token for any account. Investigating that turned up two adjacent holes that were arguably worse: `apps/server/src/middleware/auth.ts` accepted an `X-User-Id` header as an outright impersonation shortcut (no proof of identity needed at all), and when a request carried *no* auth at all, it silently fell back to treating the caller as the seeded initial admin user. Fixing only the token signing would have left the API just as open via either of those two bypasses, so all three were fixed together:

- New module `packages/core/src/security/jwt.ts` -- a small, dependency-free HMAC-SHA256 JWT implementation (`signJwt`/`verifyJwt`) built on Node's built-in `node:crypto` (`createHmac`, `timingSafeEqual`). No new npm dependency; produces/consumes standard three-segment compact JWTs. Covered by `packages/core/tests/jwt.test.ts` (valid round-trip, wrong secret, tampered payload, expiry, malformed input).
- `apps/server/src/routes/auth.ts`: `POST /api/v1/auth/login` now signs a real JWT (`sub` = user id, 15 minute expiry) instead of the base64 blob.
- `apps/server/src/middleware/auth.ts`: `authenticateRequest` now requires a valid `Authorization: Bearer <jwt>` and verifies its signature + expiry. The `X-User-Id` header is no longer read at all, and there is no more fallback to any user (admin or otherwise) when auth is missing or invalid -- an unauthenticated/invalid request gets a `401` and nothing else. `requirePermission` (used to gate all of `routes/admin.ts`) threads through the same check.
- The signing secret (`jwtSecret`) is generated in `createServer()` (`apps/server/src/server.ts`): reads `process.env.JWT_SECRET` if set, otherwise generates a random 32-byte secret for that process only (fine for local dev -- tokens just don't survive a restart -- **not** fine for a real deployment, where `JWT_SECRET` must be set and shared across every server instance). A console warning fires when it's auto-generated outside of tests.
- `apps/server/tests/auth_and_admin_api.test.ts`: every test that used to rely on the no-auth-means-admin fallback (or the `X-User-Id` header) now logs in for real and sends a Bearer token. Added explicit tests that a forged legacy-format token, a malformed token, no token, and the `X-User-Id` header are all now rejected with `401`, and that an authenticated non-admin user still gets `403` from admin-only routes.

Result: `npm test` is **74/74 passing, 11/11 test files green** (up from 66/66 -- 8 new tests: 6 for the JWT module, 2 new auth-rejection cases).

One thing this pass deliberately did **not** touch, worth a follow-up:

- `apps/server/src/routes/ingestion.ts` and `apps/server/src/routes/batchExecution.ts` still have **zero** auth/permission checks of any kind -- not even the old broken ones. That's a separate, arguably larger gap (it also ties into the machine API token system from RFC 04, `tl_live_...`/`tl_ci_...`, which doesn't exist yet), so it's flagged rather than folded into this fix.

## Frontend: client-side fake-admin fallback removed (2026-09-11)

`apps/web/src/App.tsx`'s `fetchCurrentUser()` and `apps/web/src/components/LoginPage.tsx`'s `handleLogin()` each had their own client-side fallback: if the real request failed (`/auth/me` returning non-OK or throwing; `/auth/login` throwing on a network error) and a magic value was present (`localStorage.user_id === "usr_admin_01"`, `auth_token === "simulated_dev_token"`, or typing `admin`/`password` while offline), the UI fabricated a full fake Admin session object purely client-side -- no server round-trip. Once the server started requiring real signed tokens (see "Auth" above), this could no longer be used to actually act as admin against the API, but it could still make the UI *display* an admin session backed by nothing real, which was confusing and pure dead-code risk at that point. Removed both fallbacks:

- `fetchCurrentUser()` now: no stored token → logged out; server rejects the token → the stale token is cleared from `localStorage` and the user is logged out; network error → logged out. No fabricated session in any path. Also dropped the `X-User-Id` header it used to send to `/auth/me` (the backend hasn't honored that header since the Auth fix above; sending it was vestigial).
- `LoginPage.tsx`'s `handleLogin()` now just surfaces an error message on any failure -- "Unable to reach the server..." for a network error, the usual invalid-credentials message otherwise -- instead of minting a `simulated_dev_token` session for `admin`/`password`.

Note: `apps/web/src/App.tsx` still sends an `X-User-Id` header on the `POST /api/v1/executions` call (the execution-logging inline route in `server.ts`). That's untouched and harmless either way, since that route -- like `ingestion.ts`/`batchExecution.ts` above -- has no auth check on the server side at all yet.

## Renamed to Testify (2026-09-11)

The codebase used to call itself "TestLink Sequel" (root `package.json` name `testlink-sequel`, npm workspace scope `@testlink/*`) even though the repo folder and Elliot's own name for the project were already "Testify" -- flagged as a gap in this file until now. Renamed everywhere it was self-referential:

- `package.json` names: root `testlink-sequel` -> `testify`; workspace scope `@testlink/core|db|server|web` -> `@testify/core|db|server|web` (and every `import ... from '@testlink/...'` in `apps/server/src`). `npm install` re-links the workspaces after a scope rename like this -- ran fine offline.
- Branding strings in code: the password-policy doc comment, audit-log `user_agent` values (`TestLinkAdminService`/`TestLinkAuthService` -> `TestifyAdminService`/`TestifyAuthService`), the RFC-7807 problem-type base URI (`https://api.testlink-next.io/errors/...` -> `https://api.testify.dev/errors/...`, both in code and the 3 tests asserting on it), and the default/seed admin & test-user email domain (`@testlink.local` -> `@testify.local`, across `user.repository.ts` and the tests that assert on it).
- UI copy in `apps/web`: the login screen title ("TESTLINK SEQUEL" -> "TESTIFY"), the "contact your ... Administrator" copy, and the fallback/mock workspace data (`"TestLink Sequel Core"` -> `"Testify Core"`, external-ID prefix `TLS` -> `TFY`).
- Docs: renamed every *self-referential* mention across `docs/00_requirements_alignment.md`, `docs/01_vertical_slices_roadmap.md`, `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`, and `docs/rfc_01..04*.md` -- including the RFCs that called the product "TestLink-Next" rather than "TestLink Sequel" (both were just this project's earlier names). Also renamed the not-yet-implemented machine API token prefix scheme documented there (`tl_live_...`/`tl_ci_...` -> `tf_live_...`/`tf_ci_...`) and a couple of cosmetic example strings (mock S3 bucket/webhook names) for consistency.

Deliberately **left alone**, because it's describing the real external tool/format, not this product: every "TestLink" that means the legacy TestLink application Testify replaces or is migrating from (e.g. "replacement for TestLink", "TestLink's legacy pain points"), and the **TestLink XML** import format name (`TESTLINK_XML` format id, `SaxXmlParser`, related test names/fixtures) -- that's the actual name of the legacy interchange format Testify's importer parses, unrelated to what this product calls itself. Also left alone: the `.antigravity/` planning docs (they only ever say generic things like "a modernized TestLink alternative" -- they never named the product itself, so there was nothing to rename). The stale `file://...testlink-local/...` cross-reference links inside `docs/MASTER_ARCHITECTURE_BLUEPRINT.md` and `docs/01_vertical_slices_roadmap.md` were left alone at the time this rename happened, but were fixed on 2026-09-14 alongside the single-dialect rewrite -- see "Docs rewritten to match the single-dialect architecture" below.

`npm test`: 74/74, unchanged. `tsc --noEmit` clean on `apps/web`/`packages/core`; the same 2 pre-existing errors remain on `apps/server`/`packages/db` (see "SQLite support was dropped" above), unrelated to this rename.

## Resolved: all 3 pre-existing tsc type errors fixed (2026-09-14)

Two of the three `tsc` type errors found during the SQLite-removal sanity check (see above) were real bugs, not just noise `vitest`'s transpile-only mode had been hiding. Both were type drift between two independently-typed representations of the same "role name" concept:

- `packages/db/src/repositories/role.repository.ts(92,5)`: `getUserProjectRoles()` declared its return type as `Array<{ project_id: string; role: RoleName }>`, but `user_project_roles.project_id` was typed `string | null` in `types.ts` -- because the migration never actually marked that column `NOT NULL`, even though the only code path that ever inserts a row into that table (`assignProjectRole`) always supplies a `projectId: string`. Fixed at the source: added `.notNull()` to the `project_id` column in `packages/db/src/migrations/001_initial_schema.ts` and narrowed `UserProjectRolesTable.project_id` in `types.ts` from `string | null` to `string` to match. (Safe to edit the initial migration directly rather than adding a new `ALTER TABLE` migration -- there's no persisted production database yet; see the same reasoning applied to the SQLite removal above. `user_permission_overrides.project_id` has the identical nullable pattern but is unused by any repository yet, so it was left alone.)
- `apps/server/src/routes/admin.ts(51,9)`: `POST /admin/users` casts the request body's `global_role` to `RoleName` (which includes `'Automation Service'`), but `UserRepository`'s `CreateUserInput.global_role` was a separately hand-typed union that had drifted and forgotten `'Automation Service'`. Fixed by having `CreateUserInput.global_role` import and use the real `RoleName` type from `role.repository.ts` instead of re-declaring a narrower one -- one source of truth for role names instead of two that can drift apart again.

`npm run build --workspace=apps/server` was clean after those two. The third error (`user.repository.ts(5,40)`, a cross-package `rootDir` config issue from importing `packages/core/src/security/passwordPolicy.ts` by relative path instead of via the `@testify/core` package) was left open at that point -- it hadn't been part of what was asked, so it was flagged as a known gap rather than fixed opportunistically.

Fixed on 2026-09-14, per direct request: `packages/db/src/repositories/user.repository.ts` now imports `validatePasswordPolicy` from `@testify/core` instead of `../../../core/src/security/passwordPolicy.js`. This required `packages/core/package.json` to actually resolve for consumers -- it previously pointed `main`/`types` at `./dist/index.js`/`./dist/index.d.ts` (build output that isn't kept as a committed/maintained artifact), unlike `packages/db/package.json`, which points `main`/`module`/`exports` directly at `./src/index.ts`. Changed `packages/core/package.json` to match that same source-pointing pattern (`main`/`module`/`types`/`exports` all → `./src/index.ts`), and added `"@testify/core": "*"` to `packages/db/package.json`'s dependencies so the workspace link resolves. `npm install --offline` re-linked it (already-symlinked workspace package, so this was just picking up the new package.json fields).

All four workspace builds (`packages/core`, `packages/db`, `apps/server`, `apps/web`) are now clean under `tsc`. `npm test`: still 74/74. No pre-existing `tsc` errors remain.

## Docs rewritten to match the single-dialect architecture (2026-09-14)

`docs/rfc_01_domain_model.md` was updated to the single-dialect (PGlite + PostgreSQL) architecture back on 2026-09-11 (see "SQLite support was dropped" above), but three other planning/architecture docs were left describing the old dual-SQLite-and-PostgreSQL design and old `pnpm`/Turborepo tooling assumptions, flagged as a known gap. Elliot asked for these to be brought in line too, and said plainly he's not interested in preserving them as historical artifacts -- so unlike the RFC doc's "amended" callout treatment, these were edited directly to describe the current architecture as just how it is, no amendment notes.

- **`.antigravity/agents/lead_architect.md`**: Section 1 retitled from "Dual-Driver Database Layer (SQLite + PostgreSQL)" to "Postgres-Compatible Database Layer"; its "Zero Lock-In" and "Driver Abstraction" bullets rewritten to describe one Postgres-compatible dialect (PGlite locally / PostgreSQL in production) instead of two engines to normalize across. The custom-field storage bullet dropped its "JSONB in Postgres / JSON1 in SQLite" framing. The "Dual-Driver Normalization Spec" deliverable was renamed "Migration & Schema Versioning Spec" and reworded to drop the cross-database compatibility matrix (nothing to reconcile with one dialect).
- **`docs/MASTER_ARCHITECTURE_BLUEPRINT.md`**: the architecture diagram's storage-layer box, Section 3's heading ("Relational ERD & Database Schema (PostgreSQL & SQLite)" → "...(PostgreSQL-Compatible)"), Section 3.2's heading ("Unified Dual-Driver SQL DDL" → "PostgreSQL-Compatible Schema DDL"), and the commented-out SQLite trigger block in the DDL were all updated or removed. The attachment-storage provider bullets no longer pair `LocalStorageProvider` with "dev/SQLite" and `S3StorageProvider` with "prod/PostgreSQL" (storage backend choice is orthogonal to DB dialect). Requirement #14 in the verification matrix, "Dual-Driver Parity," was retitled "Operational Integrity" to match how `rfc_01_domain_model.md` and the test suite (`verification_matrix_acceptance.test.ts`) already renamed the equivalent requirement/test back on 2026-09-11. Stale absolute `file://home/elliot/.../testlink-local/...` cross-reference links (an old pre-rename directory name) were also fixed to plain relative links.
- **`docs/01_vertical_slices_roadmap.md`**: the heaviest of the three -- Slice 0's overview, target file tree (dropped `pnpm-workspace.yaml`/`turbo.json`/`dialects/sqlite.ts`, retitled `client.ts`'s comment), module dependency list (dropped `better-sqlite3`/`turborepo`, added `@electric-sql/pglite`), the database table reference (column header and the `projects` row's dialect-specific note), the `/health` and `/api/v1/system/info` example JSON payloads (dropped `driver`/`sqlite_support`/`dual_driver` fields), and the Slice 0 verification tests/prerequisites were all rewritten for one dialect. Every `pnpm --filter <pkg> <script>` command across all five slices (26 occurrences) and the master slicing matrix were converted to `npm run <script> --workspace=<path>`, matching how this repo actually works. Requirement #14 in the coverage box was retitled to match the blueprint doc. Stale `file://...testlink-local/...` links were fixed the same way as in the blueprint doc.

Checked before rewriting rather than assumed: `packages/db/src/client.ts` and `dialects/postgres.ts` (confirmed Kysely + PGlite/pg.Pool is still an accurate description, so that terminology was kept), and `001_initial_schema.ts` (confirmed the `settings`/JSON-ish columns are still plain `TEXT`, not `JSONB` -- the docs were corrected to say `TEXT` rather than assuming an upgrade that never happened). No `/health` or `/api/v1/system/info` route actually exists yet in `apps/server/src` -- those JSON examples in the roadmap are still aspirational/spec, so they were only scrubbed of dual-driver fields, not verified against a real response.

`npm test`: 74/74, unchanged (docs-only change). No code was touched in this pass.

## Fixed: RBAC & User Administration Panel couldn't actually create users (2026-09-14)

The auth rework on 2026-09-11 (see "Auth: unsigned tokens replaced with signed JWTs" above) made the server require a real `Authorization: Bearer <jwt>` on every admin request and stopped honoring the old `X-User-Id` header entirely. `apps/web/src/components/AdminPanelModal.tsx` was never updated to match -- all 5 of its fetch calls (`fetchUsers`, `fetchAuditLogs`, `handleCreateUser`, `handleToggleStatus`, `handleSavePrivileges`) still sent `"X-User-Id": currentUser?.id || ""`, which the server just ignores now, so every admin-panel request came back `401 Unauthorized: missing Bearer token` -- including the roster/audit-log loads on open, not just user creation.

Fixed by adding a small `getAuthHeaders()` helper inside the component that reads the JWT from `localStorage["auth_token"]` (the same key/pattern `App.tsx`'s `fetchCurrentUser` already uses) and returns an `Authorization: Bearer <token>` header, then using it in place of the `X-User-Id` header at all 5 call sites. No prop threading needed -- `AdminPanelModal` reads the token directly, matching how `App.tsx` itself does it (there's no shared `token` React state anywhere in this app; it's always read from `localStorage` at the point of use).

Also renamed the panel's create-user copy per Elliot's request, since "provision" read as unnecessarily formal for what's just adding a user: the form heading "Provision New User" -> "Add New User", the submit button "Provision Account" -> "Add User", and the panel subtitle "Provision users, assign global/project privileges..." -> "Add users, assign global/project privileges...".

Known, separate, pre-existing issue **not** touched by this fix: `App.tsx`'s `submitVerdict` (`POST /api/v1/executions`) still sends the same stale `X-User-Id` header. It was flagged and deliberately left alone back on 2026-09-11 because that route has no server-side auth check at all yet (see "Notable gaps" below) -- the header is currently a no-op either way, unlike the admin panel where it actively broke every request. Worth fixing together with adding real auth to that route.

`npx tsc --noEmit -p apps/web` clean. `npm test`: 74/74, unchanged (no test currently exercises `AdminPanelModal`'s fetch calls directly).

## Fixed: execution-submission route had no auth, and used a hardcoded fake tester (2026-09-14)

Elliot asked about `App.tsx`'s execution-submission call (the hotkey-driven Pass/Fail/Blocked/Skipped verdict recorder, wired to `submitVerdict` and the `j/k/p/f/b/s` hotkeys) and authorized adding real auth to it -- this was one of the three routes flagged as auth-free back on 2026-09-11 (see "Notable gaps" below), deliberately left out of the original JWT rework since it wasn't asked for at the time.

Two separate problems fixed together, since they're the same root cause (the route never looked at who was calling it):

- **No auth check at all.** `POST /api/v1/executions` in `apps/server/src/server.ts` took no token and required no permission -- anyone could record execution verdicts. Gated it behind `requirePermission('EXECUTE_RUN', db, jwtSecret)`, the same permission key already used for this concept in `packages/db/src/repositories/role.repository.ts`'s `ROLE_PERMISSIONS` (held by Admin, Test Lead, Tester, and Automation Service -- everyone except Viewer, which is exactly the right shape for "can record a test run").
- **Hardcoded fake actor.** Both the `executions.tester_id` column and the `audit_logs.actor_id` column were being written as the literal string `'usr_tester_01'` regardless of who actually submitted the verdict -- so every execution and every audit log entry lied about who recorded it. Now both are set from `request.user!.id`, the real authenticated caller (available once `requirePermission`'s `preHandler` runs and populates `request.user`).

Frontend (`apps/web/src/App.tsx`'s `submitVerdict`) updated to match: sends `Authorization: Bearer <token>` (read from `localStorage["auth_token"]`, same pattern as everywhere else in this app) instead of the old ignored `X-User-Id` header. Also added explicit handling for the two failure modes a real permission check makes newly possible: a `401` (token missing/expired -- login tokens are 15-minute JWTs with no refresh mechanism, so this can now happen mid-session) clears the dead token and drops the user back to a logged-out state with a clear "Session expired" status instead of silently failing every subsequent verdict; a `403` (authenticated but lacking `EXECUTE_RUN`, e.g. a Viewer) shows "Not permitted: your role can't record executions" instead of a generic error.

`apps/server/tests/core_loop_e2e.test.ts` updated: logs in as admin and sends a real Bearer token on both execution-recording calls (it would otherwise now fail with 401), and gained new assertions that `tester_id`/`actor_id` on the recorded execution and audit log equal the real logged-in user's id rather than the old hardcoded stub, plus a new test asserting a request with no token gets `401` and a Viewer (provisioned via the admin API, the one role without `EXECUTE_RUN`) gets `403` -- and that neither attempt actually recorded anything.

`npx tsc --noEmit` clean on `apps/server` and `apps/web`. `npm test`: **75/75** (was 74/74 -- the new rejection test), all green.

Still open, not part of this fix: `ingestion.ts` and `batchExecution.ts` remain auth-free (see "Notable gaps" below) -- worth doing together with the not-yet-built machine API token system (RFC 04), since those two are meant for both interactive and CI/automation callers.

## Added: Specification / Execution mode toggle + plan-curation UI (2026-09-16)

Elliot wanted a way to see and manage *which* test cases are actually in a test plan -- until now the app only ever showed whatever a plan already contained, with no UI to add/remove cases, and the Suite Tree was non-functional (flat data, no real selection, fake per-suite counts). The DB schema and repository layer for plan membership (`test_plan_cases`, `TestPlanRepository.addCase/removeCase/getPinnedCases`) already existed and matched the RFC's design intent exactly, but nothing exposed it over HTTP.

Added a two-way toggle in the Suite Tree header (`apps/web/src/App.tsx`): **Execute** (today's queue-driven execution against the selected plan, unchanged in behavior) and **Spec** (browse every suite/case in the selected project, read-only detail, with a per-case and per-suite plan-inclusion toggle). Curation-only by design -- no new create/edit UI for suites/cases/steps; bulk import remains the only content-creation path.

- **New backend routes**, `apps/server/src/routes/testPlanCases.ts`: `GET /api/v1/projects/:id/spec-tree?plan_id=` (suite tree + case list annotated with plan-inclusion state, in one fetch), `GET /api/v1/test-cases/:id/latest-version` (lazy per-case step detail), `GET /api/v1/test-plans/:id/cases?build_id=` (parameterized replacement for the old hardcoded `/api/v1/workspace`), `POST`/`DELETE /api/v1/test-plans/:id/cases[/:caseId]` (per-case toggle), and `POST /api/v1/test-plans/:id/suites/:suiteId/cascade` (suite-level toggle, cascading to every case in the subtree in one call, partial-success with a `skipped` list rather than all-or-nothing). Also `apps/server/src/routes/projects.ts`: `GET /api/v1/projects` and `GET /api/v1/projects/:id/plans`, replacing `App.tsx`'s hardcoded fake dropdown data (`prj_01/02/03`, `pln_01/02/03` -- none of which existed in the DB).
- **RBAC**: read routes are unauthenticated-but-open (any logged-in user can view Spec mode, per Elliot's call to not design new permission gating yet -- he wants permissions to eventually be matrix-based/customizable); the mutation routes require the existing `PLAN_MANAGE` permission (already defined, held by Admin/Test Lead), same pattern as `admin.ts`'s `USER_MANAGE` gate.
- **Approved-only linking enforced**, per `docs/rfc_01_domain_model.md` §2.3: a case can only be added to a plan if its latest version is `APPROVED`, unless the project's `settings.allow_draft_plan_linking` is `true` (renamed from the previously-unenforced, misnamed `allow_draft_testing` key). The check (`resolveCaseLinkability` in `testPlanCases.ts`) is shared with `batchExecution.ts`'s auto-link path, which previously had **no such check at all** despite a comment claiming otherwise -- a real pre-existing gap, fixed as part of this work so the rule means the same thing everywhere plan membership can be created.
- **`CASE_HAS_EXECUTIONS` guard**: `executions.test_plan_case_id` → `test_plan_cases.id` is `ON DELETE RESTRICT`, so removing a case with recorded executions now gets a clear 422 instead of a raw DB constraint error.
- **Frontend**: `VirtualizedSuiteTree.tsx` now receives real nested suite data (previously flat with fake project-wide counts on every node) and a working `selectedSuiteId`/`onSelectSuite` (previously declared but never wired), plus a tri-state cascade-toggle indicator in Spec mode. New `apps/web/src/components/SpecCaseListGrid.tsx` (sibling to `TestCaseQueueGrid`, not a mode flag on it -- the payload/interaction diverges enough to warrant a separate component). `useHotkeyEngine.ts` gained a `mode` option that disables the verdict hotkeys (`p/f/b/s`, `Ctrl+Enter`) in Spec mode with a toast; `j/k`/`/`/`[`/`]` stay valid in both modes.
- **Fixed two real bugs found while testing this live in the browser** (not just via the test suite): (1) the DELETE toggle sent `Content-Type: application/json` with no body, which Fastify's JSON parser 400s on -- fixed by only setting that header when there's an actual JSON body (the POST/cascade calls). (2) A request race: `selectedProjectId`/`selectedPlanId` go through a fake-seed → real-id bootstrap sequence (multiple fetches fire in quick succession), and a slower, now-stale response could resolve after a newer one and silently overwrite fresh data -- fixed with a per-loader sequence-number guard (`specTreeRequestSeq`/`executionWorkspaceRequestSeq` refs in `App.tsx`) so only the most recently issued request's response is ever applied.
- Also, since Spec mode fundamentally needs "all cases in the *currently selected* project" (a concept the old hardcoded `/api/v1/workspace` endpoint didn't have), the Project/Plan dropdowns' "select" handlers were rewired to just update selection state and let a `useEffect` (keyed on mode + selection) do a real refetch, instead of cosmetically patching the `workspace` object in place -- this incidentally fixes a pre-existing bug where switching projects/plans never actually changed any fetched data.
- Added `.claude/launch.json` (not previously present) so `apps/server`/`apps/web` can be started via the browser-preview tooling instead of two manual terminals.

New tests: `packages/db/tests/repositories.test.ts` (4 new repo methods), `apps/server/tests/spec_and_plan_curation.test.ts` (new file, 9 tests covering the full route surface), `apps/server/tests/batch_and_xml.test.ts` (+1, the auto-link reconciliation), `apps/web/src/tests/hotkeys.test.ts` (+3, Spec-mode hotkey gating). `npm test`: **90/90**, all green. `tsc --noEmit` clean on all four workspaces. Manually verified end-to-end in a real browser session: real project/plan/build data loading, suite tree nesting + tri-state indicators, per-case and per-suite add/remove (including the two bugs above, found and fixed during this manual pass), and verdict recording still works and persists across reloads in Execution mode.

Not done as part of this: `allow_draft_plan_linking` has no UI to toggle it yet (would need a project-settings form -- out of scope for a curation-only pass); it's only settable by editing the `settings` JSON directly for now. `GET /api/v1/workspace` was left in place rather than deleted (still used by `core_loop_e2e.test.ts`) -- worth deprecating explicitly once the new endpoints are further proven out.

## Added: admin-editable role templates & per-user permission overrides (2026-09-17)

RBAC used to be entirely closed: `role.repository.ts` had a fixed 5-role TS union and a hardcoded in-memory `ROLE_PERMISSIONS` map -- no way to create a role, edit what one grants, or adjust a single user's permissions independent of their role. Elliot asked for exactly that from the Admin Panel, with the 5 built-ins pre-existing as defaults but not protected from deletion.

The schema already had 4 tables shaped for this since the very first migration -- `roles`, `permissions`, `role_permissions`, `user_permission_overrides` -- created on day one but **never queried anywhere** (confirmed by a full-repo grep before touching anything). This resurrects them instead of designing new ones:

- New `packages/core/src/rbac/` module (`registry.ts`, `evaluate.ts`) -- finally building the module this file already flagged as planned-but-missing (see the old Slice 3 bullet below, now updated). Holds the 16-key permission registry (with descriptions + a `module` grouping used to render the Admin Panel's toggle grids) and a pure `applyPermissionOverrides` merge function.
- `role.repository.ts` rewritten: `RoleName` is now a plain `string`, not a closed union. `evaluatePermissions` resolves the base permission set via real SQL against `roles`/`role_permissions` (SYSTEM_ADMIN short-circuits to the *full* registry, not a hardcoded 'Admin' bundle), then layers user overrides on top -- global first, then project-scoped, so a project override always wins a conflict with a global one, and either can even revoke a key from an otherwise-full-admin user (overrides always have final say, deliberately). New CRUD (`createRole`/`updateRole`/`deleteRole`/`listRoles`) and override methods (`getUserOverrides`/`setUserOverrides`, scoped per-project via an optional `projectId`, not just globally). `deleteRole` blocks (with a count of affected users) when a role is currently assigned to anyone -- `is_system_role` is informational only, never a deletion guard, so even a default role deletes cleanly once unused.
- New seed `seed_rbac_registry.ts` populates the 16 permissions + 5 default roles + their bundles on a fresh install, reproducing the old hardcoded behavior exactly. Wired into `server.ts` startup between `migration001.up()` and the core-loop/admin seeds (order matters -- `seedInitialAdmin` needs `roles` populated first now that role names are validated against it).
- Migration edit (`001_initial_schema.ts`, in place per this repo's established precedent): added the missing FK from `user_permission_overrides.user_id` to `users.id`, which required moving that table's creation to after `users` exists and fixing `down()`'s drop order to match.
- New `apps/server/src/routes/admin.ts` routes (all `USER_MANAGE`-gated, same as the 5 pre-existing ones): `GET /admin/permissions`, full CRUD on `/admin/roles` (409 `ROLE_IN_USE` with the blocked user count and role name on delete-while-assigned), and `GET`/`PUT /admin/users/:id/permission-overrides` (optional `project_id` query/body param for scope). `GET /admin/users` now also returns each user's raw global overrides alongside their resolved permissions.
- `AdminPanelModal.tsx` gained a 4th tab, **Role Templates** (create/edit/delete a template's name/description/permission bundle via a toggle grid grouped by module, styled on `VirtualizedSuiteTree`'s existing checkbox-button idiom -- the app still has zero native `<input type="checkbox">`), and the Matrix tab gained an **Individual Permission Overrides** section per user (a Global/per-project scope picker, same toggle grid, 3 visual states: granted-by-role, denied-by-role, overridden). All 3 previously-hardcoded, independently-drifted role-name `<select>` lists (create-user form, Matrix global-role picker, Matrix per-project picker) now share one dynamically-fetched list -- which incidentally fixed "Automation Service" being missing from all three.
- Fixed two bugs found while wiring this up: `AdminPanelModal` was mounted with `projects={[workspace.project]}` (only the single active project, not the full list -- per-project role/override rows could only ever show one project); and there was no mechanism anywhere to refresh the signed-in admin's *own* `currentUser`/`userPermissions` after they edited their own access (a new `onSelfPermissionsChanged` prop, wired to `App.tsx`'s existing `fetchCurrentUser`, closes this).

New tests: `packages/core/tests/rbac.test.ts`, `packages/db/tests/role_templates.test.ts`, `apps/server/tests/admin_roles_and_overrides.test.ts`. `packages/db/tests/user_and_rbac.test.ts` needed one addition (`seedRbacRegistry(db)` in its `beforeEach`, since `evaluatePermissions` now needs the registry seeded rather than reading an in-memory map) but no assertion changes -- it passed against the rewritten repository otherwise unmodified, which is itself good evidence the seed reproduces prior behavior exactly. `npm test`: **125/125**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser: created a custom template role and assigned it, deleted an *unused default* role (Automation Service) to confirm defaults aren't protected, confirmed deleting an *in-use* role is blocked with a friendly named message ("Role 'Tester' is currently assigned to 1 user..."), revoked a permission from the signed-in admin's own SYSTEM_ADMIN-derived permission set via a global override and confirmed it took effect immediately without a reload, and confirmed a project-scoped override wins a conflict with a global one.

## Fixed: password change sent a dead X-User-Id header; Admin Panel saves gave no feedback (2026-09-17)

Two small bugs found while exercising the RBAC feature above:

- `AuthModal.tsx`'s `handleUpdateCredentials` (the profile modal's password/username/email form, `PUT /api/v1/auth/credentials`) still sent the pre-2026-09-11 `X-User-Id` header instead of `Authorization: Bearer <jwt>` -- the one call site missed by the JWT auth rework, so changing your own password always failed with "Unauthorized: missing Bearer token". Fixed by reading `localStorage["auth_token"]` and sending it as a Bearer token, same pattern as every other authenticated call site in the app.
- `AdminPanelModal.tsx`'s `handleSavePrivileges`, `handleSaveOverrides`, and `handleSaveTemplate` all succeeded silently -- no visual confirmation a save actually happened. Added a shared `successMessage` state + `flashSuccess(msg)` helper (auto-clears after 3000ms, mirrors `App.tsx`'s existing toast pattern) plus `isSavingPrivileges`/`isSavingOverrides`/`isSavingTemplate` booleans that disable the relevant button and show "Saving..." while the request is in flight.

Verified live in a browser: changed the admin's password via the profile modal, signed out, signed back in with the new password; saved a privilege delegation and a permission override and confirmed the green "✓ ... saved." banner appears and clears itself.

## Added: local-dev fixture seed for rapid manual testing (2026-09-17)

Every dev-server restart starts from a fresh, empty ephemeral PGlite instance (see "SQLite support was dropped" above) with only the single seeded admin + one core-loop project -- not enough to exercise multi-project switching or the RBAC override/matrix UI without manually creating projects and users first every time. Elliot asked for a way to skip that setup when testing locally.

- New `packages/db/src/seeds/seed_dev_fixtures.ts`, exported alongside `seed_core_loop.ts`/`seed_rbac_registry.ts`: two extra projects (Mobile Banking Platform/BANK, Internal Admin Console/ADMN, each with a suite/plan/build and a couple of APPROVED, plan-linked cases) and six users covering every built-in role (`test_lead`, `tester`, `viewer`, `automation_bot`, `project_admin`, `override_tester`), all password `DevTest123!` (exported as `DEV_FIXTURE_PASSWORD`). `project_admin` gets a per-project Admin role override on BANK (exercises `user_project_roles`); `override_tester` gets a global `PLAN_MANAGE` permission override (exercises `user_permission_overrides`) -- so the Matrix tab's override sections have real data to show immediately, not just the RBAC feature's own manually-created test rows.
- Idempotent via the same fixed-id + `onConflict(...).doNothing()` convention as the other seeds. IDs are generated by a small `devId(scope, n)` helper templating a 36-character string -- exactly `varchar(36)`'s limit, which only holds for a **1-character** scope tag (`35 + scope.length` chars total); `devId` now throws if given a longer scope, after a first draft's `'ur'`/`'upr'`/`'upo'` scope tags (37-38 chars) crashed the dev server on startup with a real Postgres `22001: value too long for type character varying(36)` error, caught immediately by this repo's live-verification habit before it was ever committed.
- Wired into `server.ts` startup, gated to fire only when it's actually a local dev run: `!connectionString` (ephemeral PGlite, not a real `DATABASE_URL`) `&& NODE_ENV !== 'test'` (vitest sets this, so the full test suite never sees these fixtures) `&& SEED_DEV_FIXTURES !== 'false'` (explicit opt-out).

`npm test`: **125/125**, unchanged (the `NODE_ENV=test` gate keeps this seed out of every test run, confirmed by the suite passing untouched). `tsc --noEmit` clean on `packages/db` and `apps/server`. Verified live: dev server starts cleanly, Project dropdown shows all 3 projects (SHOP + BANK + ADMN), switching to Mobile Banking Platform loads its real suite/plan/cases, and logging in as `tester`/`DevTest123!` shows the correct restricted UI (no Admin Panel button).

## Added: global admin-defined custom fields for Test Cases and Test Suites (2026-09-18)

`docs/01_vertical_slices_roadmap.md` §3.4 calls for a "Dynamic Custom Fields Engine" as a Slice 3 deliverable, and this file has repeatedly flagged `packages/core/src/custom-fields/` as planned-but-missing (see "Added: admin-editable role templates..." above). Elliot asked for arbitrary fields on Test Cases and Test Suites, defined globally (not per-project), with a warn-then-confirm flow when deleting a field that has recorded data, and with the built-in fields (title, steps, notes, etc.) left completely untouched.

Three DB tables for exactly this -- `custom_field_definitions`, `custom_field_options`, `custom_field_values` -- already existed in `001_initial_schema.ts` since the very first migration, created but **never queried by any repository or route** except ad hoc inline queries in `routes/ingestion.ts` (confirmed by a full-repo grep before touching anything). This resurrects them rather than designing new storage, closing the gap this file already flagged:

- New `packages/core/src/custom-fields/` module (`customFieldValidator.ts`): the 6 supported types (`TEXT`, `NUMBER`, `CHECKBOX`, `DATE`, `SINGLE_SELECT`, `MULTI_SELECT`), `parseCustomFieldValue`/`readCustomFieldValue` for validating a raw incoming value against a field's type/options/regex and converting to/from the typed-column storage shape (`string_value`/`number_value`/`boolean_value`/`date_value`/`json_value`).
- New `packages/db/src/repositories/custom_field.repository.ts` (`CustomFieldRepository`): CRUD for field definitions (always `project_id: null` -- the sole enforcement point for "global only"; `entity_type`/`field_type` immutable after creation) and values (`getValuesForEntity`, `setValue`, `deleteValue`). `deleteDefinition(id, {force?})` is the delete-with-confirmation flow, modeled on `role.repository.ts`'s `deleteRole` but deliberately more permissive: without `force`, a definition with recorded values is left completely untouched and the call returns a blocked result with the affected count (doubling as a pre-check); with `force: true` (or when unused), it transactionally deletes the values, then options, then the definition itself -- required because `custom_field_values.custom_field_definition_id` is `ON DELETE RESTRICT`.
- Migration edit (`001_initial_schema.ts`, in place per this repo's established precedent): added a **partial unique index** `ON custom_field_definitions (entity_type, name) WHERE project_id IS NULL`, since a plain column-level unique constraint wouldn't stop two global fields sharing a name (Postgres treats `NULL` as distinct-per-row) -- this leaves `ingestion.ts`'s project-scoped rows (non-null `project_id`) completely unaffected. Backed by an app-layer pre-check (`FIELD_NAME_TAKEN`, mirroring `ROLE_NAME_TAKEN`) for a friendly error rather than a raw constraint violation.
- New permission key `CUSTOM_FIELD_MANAGE` in `packages/core/src/rbac/registry.ts` (16 -> 17 keys), Admin-only, gating the new `apps/server/src/routes/customFields.ts` definition-CRUD routes (`GET`/`POST /admin/custom-fields`, `PUT`/`DELETE /admin/custom-fields/:id`). The value routes (`GET`/`PUT`/`DELETE /api/v1/test-cases/:id/custom-field-values[/:definitionId]` and the `test-suites` equivalent) are gated by `PLAN_MANAGE` for mutation and open (any authenticated user) for read, matching `testPlanCases.ts`'s existing gate on every other Spec-mode curation mutation -- deliberately not the currently-dead `SPEC_EDIT` key, to avoid resurrecting a second dormant permission in the same change.
- **Coexistence, deliberately not reconciled**: `routes/ingestion.ts`'s existing custom-field auto-creation during XML/CSV/JSON import (`entity_type: 'TestCaseVersion'`, project-scoped, hardcoded `field_type: 'STRING'`, no real validation) is a separate, lower-quality, pre-existing system that writes into the same 3 tables. Because it always uses a different `entity_type` value and a non-null `project_id`, there's zero row-level collision -- confirmed by a regression test that a simulated ingestion-style row is invisible to this feature's `listDefinitions()`. Left untouched.
- **Frontend**: `AdminPanelModal.tsx` gained a 5th tab, **Custom Fields** (built on the Role Templates tab's real-CRUD structure, not `EntityManagementModal.tsx`'s fake client-only pattern) -- field list grouped by entity type, a detail form (entity type/field type locked after creation, is-required toggle, default value, validation regex, and a fresh options editor for SINGLE_SELECT/MULTI_SELECT), and a new two-step delete-confirmation panel (this codebase had no `window.confirm`/wired confirm-dialog precedent anywhere -- the first `DELETE` call doubles as the pre-check, a 409 populates an inline warning card with Cancel/"Delete Anyway", and nothing is deleted until the second confirmed call). `App.tsx`'s Spec-mode case detail pane (previously 100% read-only, explicitly commented as such) gained a "Custom Fields" card section with live per-type editors -- the first real edit affordance in that view -- gated on the existing `hasPlanManagePermission` flag. New shared `apps/web/src/components/CustomFieldEditor.tsx` (pure props-in/callback-out per-type renderer: text/number/date inputs, a `VirtualizedSuiteTree`-style colored-square toggle for CHECKBOX, a `<select>` for SINGLE_SELECT, pill toggles for MULTI_SELECT) is reused by both the case detail section and a brand-new `SuiteCustomFieldsPanel.tsx` -- there was no suite-level detail surface anywhere in this app before (selecting a suite only ever filtered the case list), so this adds a lightweight inline panel (not a modal, to stay consistent with this app's dense, non-interrupting UI) opened via a small "✎" button next to each suite row's existing plan-inclusion indicator in `VirtualizedSuiteTree.tsx`.

New tests: `packages/core/tests/customFieldValidator.test.ts`, `packages/db/tests/custom_fields.repository.test.ts`, `apps/server/tests/custom_fields_admin_and_values.test.ts` (including a regression test that editing a value on a case whose latest version is `APPROVED` still succeeds -- values are never version-locked). `packages/core/tests/rbac.test.ts` and `apps/server/tests/admin_roles_and_overrides.test.ts` updated for the 16 -> 17 permission-count bump. `npm test`: **160/160**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser: created a field of each of the 6 types across both entity types, edited values on a locked (`APPROVED`) case and confirmed they saved, opened the new suite fields panel and confirmed persistence across a reload, confirmed a Viewer (no `PLAN_MANAGE`) sees the values read-only with all editors disabled, deleted an unused field (no warning) and a field with recorded data (warning with an accurate count, Cancel is a no-op, "Delete Anyway" removes the field and its data for good), and confirmed built-in fields are completely unaffected throughout.

Known follow-up, not fixed here: if an admin deletes/edits a field definition while a case with that field already open in Spec mode is on screen, that open case detail keeps showing the stale value until case reselection or a reload -- the fetch is keyed only on `[workspaceMode, specSelectedCaseId]`, not on Admin Panel field-definition changes. Flagged as a background task rather than blocking this feature.

## Added: create/edit/delete for Test Suites and Test Cases in Specification mode (2026-09-18)

Specification mode could curate (plan-inclusion toggles, custom-field values) but never author content -- suites, cases, and their versioned summary/preconditions/steps were entirely read-only, exactly as originally scoped when Spec mode was built ("Curation-only by design... no new create/edit UI for suites/cases/steps"). This was the last major curation-only limitation. Closing it also finally activates `SPEC_CREATE`/`SPEC_EDIT`/`SPEC_APPROVE`/`SPEC_DELETE` -- four permission keys that have sat fully defined and seeded into every default role's bundle since RBAC was built, deliberately left unwired specifically for this (see the RBAC feature's entry above).

The DB repository layer (`TestSuiteRepository`, `TestCaseRepository`, `TestCaseVersionRepository`) already had almost all the CRUD this needed -- `create`/`update`/`delete`/`move` on suites, `create`/`update`/`delete` on cases, `create`/`updateStatus`/`addStep`/`updateSteps`/`delete` on versions -- fully implemented but never called by any route except reads (confirmed by grepping every route file before touching anything). This resurrects that layer rather than redesigning it. Per-project scoping needed no changes -- `test_suites.project_id`/`test_cases.project_id` were already `NOT NULL`.

- **Versioning**: editing an `APPROVED` version's content now requires an explicit "Create New Draft" step (`TestCaseVersionRepository.createDraftFromLatest`, new) that copies the latest version's summary/preconditions/steps into a new `DRAFT` version -- there was previously no code anywhere that created a new draft from an approved one. A separate "Approve" action (`SPEC_APPROVE`-gated) transitions `DRAFT` → `APPROVED` with real validation (rejects anything not currently `DRAFT`) that `TestCaseVersionRepository.updateStatus` itself never had. `IN_REVIEW`/`DEPRECATED` remain valid enum values with no UI wired to them yet -- deliberately out of scope for this pass. Title/priority/execution_type live directly on `test_cases` (not versioned) and stay editable regardless of version status, the same way custom field values already do.
- **Delete-with-force**, matching the custom-fields feature's exact warn-then-confirm shape rather than a hard block: new `TestCaseRepository.deleteWithForce`/`TestSuiteRepository.deleteWithForce` check usage first and, without `force`, touch nothing and report blocked counts (plan links / executions for a case; sub-suites / cases / plan links / executions recursively for a suite). The schema has a real asymmetry worth remembering here -- `test_case_versions`/`test_steps` are `ON DELETE CASCADE` from `test_cases`, but `test_plan_cases`/`executions`/`execution_steps.test_step_id` are all `ON DELETE RESTRICT` -- so a forced case delete must delete `executions` (which cascades `execution_steps`) *before* the case's own version/step cascade can run, or it fails partway through; a forced suite delete recurses the case-delete sequence for every case in the subtree (via the existing materialized-`path` `findDescendants`) and then deletes sub-suites leaf-to-root. New `sendSuiteInUseError`/`sendCaseInUseError` (409, `errors.ts`) name every nonzero count.
- **External IDs auto-generate sequentially**: new `TestCaseRepository.getNextExternalId(projectId, prefix)` scans existing `<prefix>-<n>` ids for the project and returns `max + 1` (ignoring non-numeric-suffix legacy/imported ids) -- there was no reusable sequence generator anywhere; the only precedent (`routes/ingestion.ts`'s import fallback) is a collision-prone random 4-digit suffix, not worth reusing.
- **New routes**, `apps/server/src/routes/specEditing.ts`, all nested under `/api/v1/projects/:projectId/...` rather than a flatter path like `testPlanCases.ts` uses -- `authenticateRequest` (`middleware/auth.ts`) resolves project-scoped role overrides from `request.params.projectId` specifically, so a flat path would silently fall back to the caller's global role for permission evaluation. Nesting also lets every handler cheaply verify a target suite/case actually belongs to the URL's project before mutating it. Covers suite CRUD (create/update-and-move/delete), case CRUD (create with an initial DRAFT v1/update/delete), and version actions (create-draft, update DRAFT content+steps, approve). This supersedes and removes the old `PUT /api/v1/test-case-versions/:versionId` stub in `server.ts` (unauthenticated, steps-blind, no draft-creation capability) -- its one dependent test (`batch_and_xml.test.ts`) was migrated to the new authenticated, project-scoped route with the same assertion.
- **Frontend**, all inline in the existing Spec-mode surfaces rather than new modals, matching how the custom-fields feature was done: `VirtualizedSuiteTree.tsx` gained create-child (`+`)/rename (`✏️`)/delete (`🗑️`) icon buttons per row (same style as the existing "✎ Fields" button), each gated on new `hasSpecCreatePermission`/`hasSpecEditPermission`/`hasSpecDeletePermission` flags (added next to `hasPlanManagePermission` in `App.tsx`, same `.includes(...) || SYSTEM_ADMIN` shape); a "+ Suite" button in Pane 1's header opens an inline create form (name, description, a "Parent Suite" `<select>` -- no drag-and-drop, since no such precedent exists anywhere in this app) reused for both create and rename/move. A "+ Case" button in Pane 2's header opens an inline create form. The case detail pane's title becomes an always-editable input, priority/execution_type become always-editable selects, and preconditions/summary/steps become editable (textareas / an add-remove-reorder row list, modeled on `AdminPanelModal.tsx`'s custom-field options editor with new ▲/▼ reorder buttons added) only while the latest version is `DRAFT` -- an APPROVED case shows a "Create New Draft" button instead, and a DRAFT case shows "✓ Approve". Suite and case delete both reuse the exact two-step confirm-panel pattern (`Cancel`/`Delete Anyway`) just built for custom fields, with the warning text naming every nonzero count from the new error helpers.

New tests: `packages/db/tests/test_case_versioning.repository.test.ts` (external-id sequencing, draft-from-latest copying, both `deleteWithForce` methods including a 3-level sub-suite cascade), `apps/server/tests/spec_editing.test.ts` (full route coverage: create/rename/move, the locked→draft→edit→approve lifecycle including the 422/409 edge cases, 409-then-force delete for both suites and cases with accurate counts, 403s for all 4 new keys per role). `packages/core/tests/rbac.test.ts` gained a regression test asserting the 4 `SPEC_*` keys' existing per-role grants (Admin/Test Lead: all 4; Tester: create/edit only; Viewer/Automation Service: none) now that they're finally load-bearing. `npm test`: **185/185**, all green (25 new: 14 repository + 10 route + 1 rbac regression check). `tsc --noEmit` clean on all four workspaces. Verified live in a browser: created a nested suite (parent + child), created a case with 2 steps in it, approved it (fields locked, "Create New Draft" appeared), created a v2 draft (content/steps copied), reordered steps, deleted a case with no plan links (immediate, no warning), deleted a plan-linked case (warning named the exact count, Cancel was a no-op, "Delete Anyway" removed it), deleted a suite containing 9 cases/9 plan links (aggregate warning, force-delete removed everything), and confirmed a Tester (create/edit, no approve/delete) and a Viewer (nothing) each see exactly the affordances their role grants.

## Added: machine API tokens for CI/automation callers; closed the last two auth-free routes (2026-09-18)

Elliot asked for a well-rounded feature roadmap (reporting/charts, import, export, MCP, API) and this was the agreed starting point: `apps/server/src/routes/ingestion.ts` and `apps/server/src/routes/batchExecution.ts` were the last two live routes with zero auth of any kind (flagged in "Notable gaps" since the JWT rework), and the `api_tokens` table + `API_TOKEN_MANAGE` permission had existed since the first migration/RBAC seed without a single line of code ever touching them -- the same "designed on day one, never queried" pattern this session already resurrected for role templates and custom fields.

**Design decisions locked in with Elliot:** one generic token type for v1 (prefix always `tf_ci_`, no live/ci distinction); a token's grantable capabilities are capped at the issuing admin's own effective permissions on that project at creation time; no rate limiting this pass (new gap below); token management lives in a 6th `AdminPanelModal.tsx` tab with its own project-scope picker (tokens are project-scoped, unlike every other tab).

**Critical security finding that drove the core design, verified directly against source before committing to it:** `PERMISSION_KEYS` (`packages/core/src/rbac/registry.ts`) includes the literal string `'SYSTEM_ADMIN'` as its own registry entry, and `RoleRepository.evaluatePermissions` sets `basePermissions` to the *entire* registry -- `SYSTEM_ADMIN` included -- whenever a user holds `SYSTEM_ADMIN`. So a real Admin's own effective-permissions array literally contains the string `'SYSTEM_ADMIN'`. A naive "capabilities ⊆ issuer's permissions" ceiling check would therefore let an Admin mint a token with `capabilities: ['SYSTEM_ADMIN']` -- and since `requirePermission` treats `permissions.includes('SYSTEM_ADMIN')` as an unconditional bypass on *every* route, that token would be a global, cross-project super-admin credential, completely defeating the project-scoping this feature exists to enforce. Fixed by unconditionally excluding `SYSTEM_ADMIN` from grantable token capabilities everywhere -- never offered in the UI, always rejected server-side (its own 400, checked before the ceiling comparison) even for a SYSTEM_ADMIN-holding issuer.

- New `packages/db/src/repositories/api_token.repository.ts`: tokens are `tf_ci_<64 hex chars>` (32 random bytes), hashed with plain unsalted `SHA-256` (`token_hash` has a UNIQUE index needing O(1) equality lookup at auth time -- the per-token-salted slow KDF `user.repository.ts` uses for human passwords can't be looked up by value at all; a 32-byte random token has enough entropy that this is safe, the same approach GitHub/Stripe use, and needs no new dependency). `token_prefix` stores the first 8 hex chars for display. Revocation is a soft-delete (`is_revoked` via UPDATE, never a hard DELETE) -- revoking is always immediate/safe with no "in use" collision to check, but the row's forensic value (`created_by`, `capabilities` at mint time, `last_used_at`) is exactly what you want to keep *after* revoking a suspected-compromised token.
- `apps/server/src/middleware/auth.ts`: `authenticateRequest` now sniffs the Bearer value's prefix -- `tf_ci_` dispatches to a new `authenticateApiToken` path (hash → look up → check revoked/expired → best-effort `touchLastUsed` → build a synthetic `AuthenticatedUser` with `permissions` frozen at mint time and a new `api_token: {id, project_id}` field), anything else still goes through the existing `verifyJwt` path unchanged. `requirePermission` needed zero changes, since a token's capabilities can never contain `SYSTEM_ADMIN`, its bypass clause simply never fires for one. The synthetic user's `id` is the token's own 36-char id with no prefix -- an earlier draft prefixed it (`svc_token_<id>`) and immediately hit the exact `varchar(36)` overflow this repo has now hit twice (see the dev-fixtures seed entry above); `api_token` being present is what actually signals "this is a machine identity" to code that cares, not the id string.
- New `apps/server/src/routes/apiTokens.ts`, nested under `/api/v1/projects/:projectId/api-tokens[/:id]` (not the RFC's flat `/api/v1/tokens/{id}` -- nesting means `authenticateRequest` has already resolved the issuer's project-scoped permission ceiling into `request.user!.permissions` by the time the handler runs, no redundant second lookup needed), gated by the existing `API_TOKEN_MANAGE` permission. `POST` validates name/capabilities/expiry, rejects `SYSTEM_ADMIN` outright, enforces the capability ceiling, and returns the plaintext exactly once (`{token, plaintext}`); `GET` returns metadata only plus `issuer_capability_ceiling` (bundled to save the frontend a round-trip); `DELETE` revokes. `API_TOKEN_GENERATED`/`API_TOKEN_REVOKED` were already pre-anticipated in `admin.ts`'s Security Audit Log allowlist -- zero changes needed there.
- **`ingestion.ts` -- fixed a real bug**: `parseImportRequest`'s silent fallback to an arbitrary project (`db.selectFrom('projects')...executeTakeFirst()`, picking *any* project when none was specified) is removed entirely. Both import routes now authenticate, require `IMPORT_DATA`, and resolve the target project explicitly -- a token's own bound project is authoritative (a mismatched body field is rejected, not silently overridden); a JWT caller with no project id anywhere now gets a `400` instead of a silent guess. `execute` (not `dry-run`) now logs an `IMPORT_EXECUTED` audit row.
- **`batchExecution.ts` -- fixed a real bug**: `tester_id` was `body.runner_info?.name || 'usr_ci_runner'` -- an unvalidated client-supplied string or a hardcoded literal, so every batch-recorded execution lied about who ran it. Now `request.user!.id`, matching exactly how the single-execution `POST /api/v1/executions` route already does it (see "Fixed: execution-submission route had no auth" above). Also gained the token-vs-build-project mismatch check and a new `BATCH_EXECUTION_RECORDED` audit row per call (summary counts, not per-item -- this route previously had zero audit logging at all, unlike its single-execution sibling).
- **Frontend**: new 6th `AdminPanelModal.tsx` tab, "API Tokens" -- a project-scope picker, a token list (capability pills, revoked tokens shown greyed-out rather than removed, a one-step Revoke button modeled on the Role Templates tab's simple immediate-delete pattern, no confirmation dialog since revocation has no "in use" collision to warn about), and a create form whose module-grouped capability-toggle grid excludes `SYSTEM_ADMIN` entirely and only ever renders keys present in `issuer_capability_ceiling`. On create, the plaintext is stashed in a separate `justCreatedToken` state (never merged into the token list, so it can't survive a refetch or reappear on remount) and rendered as this app's first-ever copy-to-clipboard UI (grepped for "copy"/"clipboard" beforehand -- zero prior precedent) with an explicit "shown once" warning; cleared on dismiss, tab switch, project-scope change, or modal close.

New tests: `packages/db/tests/api_token.repository.test.ts` (8 -- format/hashing, `findByHash`, per-project `listByProject` scoping and hash-leak safety, `revoke`'s wrong-project/double-revoke/nonexistent-id behavior), `apps/server/tests/api_tokens.test.ts` (7 -- full route surface including the SYSTEM_ADMIN-always-rejected case and a Test Lead hitting `CAPABILITY_CEILING_EXCEEDED`), `apps/server/tests/api_token_auth.test.ts` (5 -- dual-mode dispatch: fresh/garbage/revoked/expired tokens, `last_used_at` updates, no JWT-path regression), `apps/server/tests/batch_and_xml.test.ts` (rewritten to add Bearer auth to every existing call plus new auth-gating/project-mismatch/real-actor-id assertions for both routes). `npm test`: **371/371**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end: created a token with fewer capabilities than the admin holds and confirmed the one-time reveal/copy banner never reappears after a reload; confirmed the capability grid never renders `SYSTEM_ADMIN`; via curl, confirmed a Test Lead is rejected for a capability they don't hold and for `SYSTEM_ADMIN` itself (even as a real Admin); used a minted token against batch-execution for its own project (success, `tester_id` set to the token's real id) and a different project (`403 TOKEN_PROJECT_MISMATCH`); revoked it via the UI (one click, no dialog) and confirmed it then `401`s (`TOKEN_REVOKED`); confirmed both `API_TOKEN_GENERATED`/`API_TOKEN_REVOKED` appear correctly in the existing Security Audit Log tab with no plaintext anywhere in the diff; confirmed all three previously-auth-free endpoints (`imports/dry-run`, `imports/execute`, the batch-execution route) now `401` with no token.

## Added: flexible multi-format import wizard with interactive field mapping; unified the two custom-field systems (2026-09-19)

Elliot asked for the Import feature to be "very flexible" -- more formats, and a real dialogue when an imported column doesn't match an existing field (map to existing / drop / create new). Investigation found the backend was already substantially built (`packages/core/src/ingestion/`'s `SaxXmlParser`/`JsonSchemaParser`/`CsvParser` behind a shared `IFileParser` interface, and `apps/server/src/routes/ingestion.ts`'s `/imports/dry-run` and `/imports/execute` with a `CustomFieldMappingConfig` type already modeling `DROP`/`AUTO_CREATE`/`ROUTE_TO_EXISTING`) but had **zero frontend** (import was curl-only) and, more importantly, wrote imported custom fields through a raw, unvalidated SQL path into a third, undeclared entity type (`'TestCaseVersion'`, string-only values) that completely bypassed the validated `CustomFieldRepository`/`parseCustomFieldValue()` system already backing the Admin Panel's global Custom Fields tab and Spec-mode case detail.

**Decisions locked in with Elliot:** file-format based only, no remote/API-pull import; add **JUnit XML** and **TestRail's CSV export format** as two new parsers; **unify the two custom-field systems** (imported fields become real, validated, project-scoped custom fields); no mapping-profile persistence (every import re-resolves mappings from scratch, matching the backend's existing stateless/re-parse-per-request design); JUnit XML data (pass/fail/duration) becomes ordinary case-level custom fields through the same mapping dialogue, not real Execution records (keeps this inside the suite/case importer rather than building a second execution-focused import path).

- **Two new parsers**, `packages/core/src/ingestion/JUnitXmlParser.ts` (sax-based like `SaxXmlParser`; nests `<testcase classname="...">` by full dotted classname into suite levels; emits `junit_status`/`junit_duration_seconds`/`junit_failure_message` as ordinary custom fields; `canHandle()` disambiguates from TestLink XML via `tests=`/`classname=` attributes TestLink never has -- and is checked *before* `SaxXmlParser` in the auto-sniff order, since `SaxXmlParser`'s broad `<testsuite>` match would otherwise greedily claim JUnit files too) and `TestRailCsvParser.ts` (v1 supports only the common combined-column export shape -- one `Steps` column paired with one `Expected Result` column, both numbered-list text; the indexed-column variant like `Steps (Step 1)` is flagged with an `UNSUPPORTED_TESTRAIL_COLUMN_FORMAT` warning rather than mis-parsed; folds TestRail's `Critical` priority onto Testify's `HIGH`; **`canHandle()` always returns `false`** -- this format can never collide with generic CSV auto-detection and always requires explicit selection). Building the TestRail parser surfaced a real bug in the reused line-based CSV buffering approach: a quoted multi-line field (exactly what TestRail's Steps column needs) breaks a naive "split into lines first" strategy, since the embedded newline is inside quotes. Fixed by adding a genuine quote-aware whole-text tokenizer (`parseCsvText`/`bufferStreamToText` in a new shared `packages/core/src/ingestion/csvHelpers.ts`, alongside `parseCsvLine`/`splitSuitePath`/`slugifyColumnName` extracted from the existing `CsvParser.ts` without changing its behavior) that `TestRailCsvParser` uses; `CsvParser.ts` itself still uses the older line-based approach (untouched, proven-behavior-preserving via a new `CsvParser.test.ts` baseline written before the extraction).
- **Real custom-field type inference**: new `packages/core/src/custom-fields/inferFieldType.ts` (`inferFieldType(samples: string[])`) replaces the old hardcoded `'STRING'`/`'TEXT'` placeholder in dry-run's `unmapped_custom_fields[].detected_type` -- checks up to 5 collected samples per unmapped column against CHECKBOX (checked first, so a lone `"1"`/`"0"` infers boolean not number) → NUMBER → DATE → TEXT fallback. `SINGLE_SELECT`/`MULTI_SELECT` are deliberately never auto-inferred.
- **Unified custom-field systems**: `packages/db/src/repositories/custom_field.repository.ts` (previously hardcoded `project_id IS NULL` everywhere, global-only) now accepts an optional `project_id`/`projectId` throughout -- `listDefinitions`/`getDefinition` stay global-only by default (zero behavior change for the existing Admin Panel, which never passes the new param), a new `listVisibleToProject(projectId, entityType)` returns the union of global + that project's own definitions (global first) for the import wizard's "map to existing field" dropdown, and `setValue`/`getDefinition` gained an optional `projectId` to widen their lookup. Two required correctness fixes surfaced along the way: `deleteDefinition`'s existence check hardcoded `project_id IS NULL`, meaning a project-scoped definition could never be deleted through it (dropped the filter -- an `id` lookup is already maximally specific); and `CustomFieldRepository`'s three internal `this.db.transaction().execute(...)` calls broke when the repository was constructed with an already-open `trx` (the exact "nested transaction" class of bug this repo has hit before with `TestCaseVersionRepository`) -- fixed with a `runInTransaction()` helper that checks `this.db.isTransaction` and runs directly against it instead of nesting when already inside one. A new partial unique index `uq_custom_field_def_project_scope ON custom_field_definitions (project_id, entity_type, name) WHERE project_id IS NOT NULL` (edited into `001_initial_schema.ts` in place, alongside the existing global-scope index) enforces per-project name uniqueness without constraining global fields. Imported per-case fields now use `entity_type: 'TestCase'` (eliminating the old undeclared `'TestCaseVersion'` type entirely) with `entity_id` = the case's own id, not a version id -- matching "never version-locked" semantics of every other Spec-mode custom field value, and this is exactly what makes an imported field's value show up through the existing `GET /api/v1/test-cases/:caseId/custom-field-values` read path (used by both Spec-mode's case detail panel and the value-editing routes) with zero special-casing. Verified live: an imported "Create New" field is correctly invisible in the Admin Panel's global-only Custom Fields tab (by design -- it's project-scoped, not global) but shows up, is correctly typed, and is editable in Spec-mode's case detail for the imported case, round-tripping through a real `PUT`.
- **`apps/server/src/routes/ingestion.ts` execute handler**, previously completely unwrapped (a mid-loop error left partial writes with no rollback) and writing custom field values as raw string-only inserts: now wraps the whole handler in `db.transaction()`, routes `AUTO_CREATE`/`ROUTE_TO_EXISTING` through `CustomFieldRepository.createDefinition()`/`setValue()` (real type/regex/option validation via `parseCustomFieldValue()`), and catches a per-value validation failure (e.g. a value that doesn't match a `SINGLE_SELECT`'s configured options) without aborting the rest of the import -- the failure is counted (`skipped_custom_field_values_count`) and named (`skipped_custom_field_value_warnings[]`) in the response instead. New `GET /api/v1/imports/custom-field-options` route (gated on `IMPORT_DATA`/`CUSTOM_FIELD_MANAGE`/`SYSTEM_ADMIN` -- more permissive than the Admin-only global-fields route, since an importer needs read access to the field catalog without needing full field-management rights) backs the wizard's "map to existing" dropdown.
- **Fixed a real, unrelated pre-existing bug found while verifying this live**: `IMPORT_EXECUTED` audit log rows were being written correctly (confirmed by direct DB query) but never actually appeared in the Admin Panel's Security Audit Log tab or its `GET /api/v1/admin/audit-logs` route, because that route's `securityActions` allowlist (`admin.ts`) had simply never included `'IMPORT_EXECUTED'` -- added it.
- **`CustomFieldMappingConfig.field_type`/`UnmappedCustomField.detected_type`** switched from an ad hoc, inconsistent vocabulary (`'STRING'`/`'BOOLEAN'`/`'MARKDOWN_TEXT'`, not matching `CUSTOM_FIELD_TYPES` at all) to the real `CustomFieldType` (`'TEXT'`/`'CHECKBOX'`/etc.) -- a deliberate breaking wire-format change, safe since nothing external depended on the old one yet. `packages/db/src/types.ts`'s stale `CustomFieldDefinitionsTable` doc-comment (still listing the old vocabulary and the never-real `'TestCaseVersion'`/`'Execution'`/`'Project'` entity types) was corrected to match `CUSTOM_FIELD_ENTITY_TYPES`/`CUSTOM_FIELD_TYPES` exactly.
- **Frontend**: new `apps/web/src/components/ImportWizardModal.tsx` -- a brand-new 5-step wizard (Upload → Field Mapping → Duplicates → Confirm → Results; no wizard/multi-step pattern existed anywhere in this app before, though the tab-bar's visual style doubles as a non-interactive step indicator). Reads the file via `FileReader` into base64 and resends that same content across dry-run/execute calls (no multipart from the browser, no server-side session/ticket -- matches the backend's existing stateless-per-request design). Field-mapping step is a master-detail layout (unmapped-field list + per-field Drop/Map-to-Existing/Create-New resolution, the target dropdown grouped Global vs. This Project) styled on the Custom Fields tab's existing convention; `SINGLE_SELECT`/`MULTI_SELECT` are disabled as a "Create New" choice for now (no options-editor sub-UI yet -- mapping *to* an existing one of either type still works fully). New permission-gated "📥 Import" header button (`hasImportDataPermission`, same `.includes('IMPORT_DATA') || .includes('SYSTEM_ADMIN')` pattern as every other permission flag in `App.tsx`) opens it; `onImportComplete` calls the existing `refreshSpecTree` so Spec mode reflects new data immediately.

New tests: `packages/core/tests/{inferFieldType,csvHelpers,CsvParser,JUnitXmlParser,TestRailCsvParser}.test.ts` (40 tests total, including the `CsvParser` baseline written before its helper extraction to prove behavior-preservation). `packages/db/tests/custom_fields.repository.test.ts` gained a `describe('project-scoped definitions')` block (6 tests) covering the full scoping contract, including the DB-level partial unique index (not just the app-level pre-check) and a regression test that renaming/deleting a project-scoped field re-checks the right scope. `apps/server/tests/batch_and_xml.test.ts` gained atomicity (a later `AUTO_CREATE` failure rolls back an earlier-in-the-same-transaction successful one), per-value-skip, JUnit XML, TestRail-CSV-must-be-explicit, and `/imports/custom-field-options` auth tests, plus updated its existing AUTO_CREATE assertions for the new `entity_type: 'TestCase'`/`entity_id: caseId` behavior and a regression check that the audit log entry is visible through the real admin route. `apps/server/tests/custom_fields_admin_and_values.test.ts` gained a regression test that a project-scoped definition never leaks into the Admin Panel's global-only listing. `npm test`: **423/423**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end (via the exact requests the wizard makes, since this sandboxed browser's tooling can't drive a native file-picker dialog): dry-run correctly inferred a real type for an unmapped column; `AUTO_CREATE`-mapped an import into a new project-scoped field; confirmed it does **not** appear in the Admin Panel's global Custom Fields list (correct -- project-scoped, by design) but does appear, correctly typed, and is editable via a real `PUT`, in Spec-mode's case detail panel; confirmed the Security Audit Log now shows `IMPORT_EXECUTED` (after fixing the allowlist bug above); confirmed a Viewer sees neither the Import nor Admin Panel buttons.

Known v1 limitations, deliberately not built here: no UI for per-case duplicate-resolution overrides (only the global default action); no options-editor for creating a new `SINGLE_SELECT`/`MULTI_SELECT` field via import; TestRail's indexed step-column export variant isn't parsed (flagged with a warning instead); no mapping-profile persistence across separate imports (each import re-resolves from scratch, per the locked-in decision).

## Added: flexible export -- suite/case definitions and execution results, JSON/CSV (2026-09-21)

Elliot asked for Export to be "rather flexible" too, mirroring Import. Investigation found this was a clean greenfield build: `EXPORT_DATA` already existed as an RBAC permission (`packages/core/src/rbac/registry.ts`, already granted to Admin/Test Lead/Tester/Viewer by default) but was checked by zero routes, and no export route/service/UI existed anywhere. The planning docs disagreed on scope (the roadmap sketched a single CSV-only `GET /exports/csv`; the RBAC threat-model doc described exporting "suites, plans, and execution metrics" plus audit logging and rate limiting) -- resolved in favor of the richer scope.

**Decisions locked in with Elliot:** export both (a) suite/case **definitions** (suites, cases, versions, steps, custom field values) and (b) **execution results** (a Build's executions -- verdicts, durations, notes, step results), as two distinct export "kinds," not one combined format; **Native JSON and CSV only** (no XML/XLSX this pass); **round-trip fidelity** for JSON (ids, exact priority/status values, typed custom-field values with field metadata -- genuinely useful as a backup or for moving data between projects, not just a report); **no rate limiting**, deferred as a documented gap the same way the machine-API-tokens feature deferred it.

- New module `packages/core/src/export/` (mirrors `ingestion/`'s layout): `types.ts` defines `DefinitionsExportBundle`/`ExecutionResultsExportBundle` and an `IFileSerializer` interface, `JsonExportSerializer.ts` (trivial -- full fidelity by construction), `CsvExportSerializer.ts`. The CSV definitions export deliberately emits the **exact header set `CsvParser.ts`'s importer already recognizes** (`Suite Path,External ID,Title,Summary,Preconditions,Importance,Execution Type,Step Number,Action,Expected Result` + `cf_<name>` columns), one row per step with case-level fields repeated -- so a CSV export is directly re-importable through the existing importer with **zero new import-side code**, verified end-to-end by a test that exports a project, imports the CSV into a second project, and asserts the data round-trips. Two lossiness/collision risks were verified against the actual importer code (not assumed) and are surfaced in the Export modal's CSV helper text and below: `Importance` folds anything that isn't exactly `HIGH`/`MEDIUM`/`LOW` to `MEDIUM` on reimport (a `CRITICAL` priority silently becomes `MEDIUM`), and a custom field whose name collides with a reserved substring the importer checks first (`title`/`suite`/`action`/`result`/etc.) will be miscategorized as that built-in column rather than preserved as a custom field. `environment_tags` (not `custom_fields_snapshot` -- see below) is CSV-omitted for execution results (no natural flat shape for an arbitrary map).
- **New batched repository methods**, all following the same "one query + `Map`-grouping" pattern `TestCaseRepository.findByProjectWithLatestVersion` already established, added specifically because export can touch hundreds of cases/executions in one request and the existing single-entity methods would mean one round-trip per row: `CustomFieldRepository.getValuesForEntities(entityType, entityIds, projectId?)`, `TestCaseVersionRepository.findByIds(versionIds)`/`getStepsForVersions(versionIds)`, `ExecutionRepository.getExecutionStepsForExecutions(executionIds)`.
- New `apps/server/src/routes/exports.ts`, nested under `/api/v1/projects/:projectId/exports/...` (matching `apiTokens.ts`/`specEditing.ts`'s convention, not `ingestion.ts`'s ad hoc manual check) so `requirePermission('EXPORT_DATA', ...)` resolves project-scoped overrides automatically as a Fastify preHandler. `POST .../exports/definitions` supports three scopes -- `PROJECT` (everything), `SUITE` (one subtree, via `TestSuiteRepository.getTree(projectId, suiteId)`), and `PLAN` (a plan's linked cases at their **pinned** version, via `TestPlanRepository.getPinnedCases` + the new `findByIds`/`getStepsForVersions` -- deliberately not each case's *latest* version, since the whole point of exporting a plan is "what was actually locked into it"; a regression test re-versions a case after pinning and asserts the export still reflects the pinned content) -- plus an optional `APPROVED_ONLY` status filter (suites are kept in the tree even when emptied by the filter, for structural fidelity). `POST .../exports/execution-results` takes `{plan_id, build_id}` and validates build↔plan↔project consistency by mirroring `batchExecution.ts`'s existing join/check pattern. Both routes are the **first non-JSON responses in this codebase** -- `reply.header('Content-Type', ...).header('Content-Disposition', 'attachment; filename="..."').send(rawString)` -- confirmed empirically to work correctly (Fastify doesn't run its JSON serializer once `Content-Type` is set explicitly). A small new `GET .../plans/:planId/builds` route backs the Export modal's Build picker (no existing lightweight route listed just a plan's builds -- the only other caller of `BuildRepository.findByTestPlan` is the much heavier `GET .../test-plans/:planId/cases`).
- Both export routes write a `DATA_EXPORTED` audit log row (`diff: {export_kind, format, scope/plan+build, record_count}`). **Added `'DATA_EXPORTED'` to `admin.ts`'s `securityActions` allowlist in the same change** -- this directly avoids repeating the exact bug this session already hit once for `IMPORT_EXECUTED` (written correctly but invisible in the Security Audit Log tab because the allowlist simply omitted it, only caught during manual verification); a regression test hits `GET /api/v1/admin/audit-logs` after an export and asserts the entry is there, and this was also confirmed live in a browser in this same pass rather than needing a follow-up fix.
- **Frontend**: new `apps/web/src/components/ExportModal.tsx` -- a **single-step modal**, not a wizard (no dry-run/field-mapping/duplicate-resolution equivalent is needed for a read-only export), reusing `ImportWizardModal.tsx`'s established style conventions. An Export-kind toggle (Definitions / Execution Results) switches the visible scope controls; Suite options come from the existing `GET .../spec-tree` route, Plan options from `GET .../plans`, Build options from the new `GET .../plans/:planId/builds` route. First-ever download pattern in this frontend (confirmed zero prior `Blob`/`createObjectURL`/`<a download>` precedent): `fetch` → `res.blob()` → parse the filename out of the `Content-Disposition` response header → `URL.createObjectURL` + a synthetic `<a download>` click → `URL.revokeObjectURL`. New permission-gated "📤 Export" header button (`hasExportDataPermission`, same pattern as `hasImportDataPermission`), inserted right after the Import button.

New tests: `packages/core/tests/{JsonExportSerializer,CsvExportSerializer}.test.ts` (9), new `describe` blocks in `packages/db/tests/{custom_fields.repository,test_case_versioning.repository,repositories}.test.ts` (6) for the new batched methods (each asserting the batched result matches N individual calls), `apps/server/tests/exports.test.ts` (12, new file -- permission gating, all 3 definitions scopes in both formats, the PLAN-scope pinned-version regression test, the `APPROVED_ONLY` filter, custom field values, the audit-log-visible-via-admin-route regression test, the CSV-round-trips-through-the-real-importer proof, execution-results in both formats plus the build/plan/project-mismatch 404, and the new builds-listing route). `npm test`: **449/449**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end: exported a project's definitions as JSON and CSV (both downloaded and were well-formed, confirmed via direct fetch inspection since this sandboxed browser's tooling can't drive a native save-file dialog to inspect the actual downloaded bytes); recorded a real execution via the hotkey verdict flow and exported the build's execution results in both formats, confirming the real verdict/tester/notes appeared; confirmed `DATA_EXPORTED` appeared in the Security Audit Log immediately after each export with accurate diffs; confirmed a Viewer (holds `EXPORT_DATA` but not `IMPORT_DATA`/`SYSTEM_ADMIN`) sees only the Export button, not Import or Admin Panel, and can successfully export.

Known limitations, deliberately not built here: no rate limiting on the export routes (same deferred-gap treatment as machine API tokens -- see below); CSV's `Importance`-folding and reserved-substring custom-field-column collision risks (both pre-existing importer behaviors, not new); no XML or XLSX export format; execution-results export has no CSV import counterpart (there's no CSV importer for executions, only the JSON `BatchExecutionRequest` path).

## Added: thorough reporting -- verdict breakdown, execution trend, coverage, slowest/flakiest tests (2026-09-21)

The last item on the original feature roadmap (Import/Export/API tokens already shipped). This was the least-specified of the four going in -- no charting library existed in the frontend, and no aggregation/grouping SQL existed anywhere in this codebase's production code (`count`/`groupBy`/`sum` had only ever appeared in test-file row-count assertions). Building it also surfaced and fixed a real, pre-existing data-quality bug that had nothing to do with charting per se.

**Decisions locked in with Elliot:** add **Recharts** (`^2.15.4`) as the frontend's first charting library; four report types -- verdict breakdown (Build-scoped), execution trend across the last N builds (Plan-scoped), coverage by suite (Plan-scoped, flat not cumulative), and slowest/flakiest tests (Build- or Plan-scoped); single-project scope for v1, matching every other feature this session; fix `execution_duration_ms` fabrication as part of this work rather than filing it as a separate gap.

- **Fixed a real data-quality bug**: `execution_duration_ms` was fabricated at two independent call sites that both build raw insert objects directly rather than going through `ExecutionRepository.create`/`createBatch` -- `server.ts`'s single-execution route defaulted to a hardcoded `450`, and `batchExecution.ts`'s batch route defaulted to `0`. Neither reflects a real measurement, and nothing before this feature ever read the column in a way that would have surfaced the lie. Fixed by making the column genuinely nullable (`packages/db/src/migrations/001_initial_schema.ts`, `execution_duration_ms` dropped its `NOT NULL DEFAULT 0`) and switching both sites' `|| <fabricated value>` to `?? null` -- a caller that doesn't report a real duration now honestly records "not measured" instead of a plausible-looking fake number. Every duration-based reporting query filters `WHERE execution_duration_ms IS NOT NULL` explicitly, so a null can never silently pollute an average or a "slowest tests" ranking.
- **First aggregation/grouping SQL in this codebase's production code**, and the first use of window functions -- empirically verified against this repo's exact Kysely/PGlite versions with throwaway scripts before committing to the approach (both compiled SQL and results checked by hand), since there was zero existing precedent to lean on. `packages/db/src/repositories/execution.repository.ts` gained three new methods: `getLatestExecutionsForPlanAcrossBuilds(planId, buildIds)` (the shared building block for both verdict-breakdown and trend -- `ROW_NUMBER() OVER (PARTITION BY test_plan_case_id ORDER BY execution_timestamp DESC, created_at DESC)` in a CTE per build, looped over `buildIds` rather than one cross-build raw-SQL query, since `buildIds` is always small and bounded by the route's own `limit`), `getAverageDurationByPlanCase(planId)` (plain `avg`/`count`/`groupBy`, excluding nulls), and `getVerdictVolatility(scope)` (`LAG(verdict) OVER (PARTITION BY test_plan_case_id ORDER BY execution_timestamp)` plus a `SUM(CASE WHEN ...)` -- the one narrow, justified raw `sql` template fragment, matching this file's existing DDL-only precedent for raw SQL). `packages/db/src/repositories/test_suite.repository.ts` gained `getCoverageByPlan(projectId, planId)`, a flat per-suite `GROUP BY` -- deliberately not reusing `testPlanCases.ts`'s `annotateTreeCounts()`, which is cumulative up the suite tree for a different UI (the Specification-mode tri-state indicator), not this flat bar chart. New index `idx_executions_timestamp` backs all of the above.
- New `packages/core/src/reporting/` module (`flakiness.ts`'s `computeFlakinessScores` -- default `minExecutions: 2`, since a single execution has no prior verdict to diverge from; `trend.ts`'s `computeTrendPoints` -- safe division, zero-case/zero-execution builds never produce `NaN`), pure and independently unit-tested, mirroring `export/`'s module shape.
- New `apps/server/src/routes/reports.ts`, nested under `/api/v1/projects/:projectId/reports/...` (`verdict-breakdown`, `trend`, `coverage`, `test-health`), all gated on `SPEC_VIEW` -- already the broadest "can see this project's data" permission, held by all 5 default roles including Viewer, so this needed no RBAC registry change. Because every default role holds it, none of them can exercise the 403 path -- `apps/server/tests/reports.test.ts` creates a throwaway custom role via the existing role-template API with `SPEC_VIEW` deliberately omitted to test that.
- **Frontend**: new `apps/web/src/components/ReportingModal.tsx` (960px full-screen overlay, following `ExportModal.tsx`'s shell/style constants), a Project/Plan/Build scope-picker row plus a 2x2 grid of independently-fetching cards -- Verdict Breakdown (Recharts donut `PieChart`), Execution Trend (Recharts `BarChart`, `pass_rate` 0-100%), Coverage by Suite (Recharts stacked horizontal `BarChart`), and Slowest+Flakiest Tests (plain sorted tables, not charts -- exact numeric columns read better as tables at this list size than as bars). New `hasSpecViewPermission` flag and a "📊 Reports" header button in `App.tsx`, inserted between Export and Admin Panel.

New tests: `packages/db/tests/execution_reporting.repository.test.ts` (7, hand-seeded known datasets for all three new `ExecutionRepository` methods), a new `TestSuiteRepository.getCoverageByPlan` case in `packages/db/tests/repositories.test.ts`, `packages/core/tests/reporting.test.ts` (9, pure unit tests for the flakiness/trend math), `apps/server/tests/reports.test.ts` (9 -- permission gating via the throwaway-custom-role technique above, each of the 4 endpoints against inline-seeded known data, and regression tests that both duration-fabrication sites now store real `null`). `npm test`: **475/475**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser: recorded real executions via the hotkey flow and confirmed the donut/trend/coverage/test-health cards all reconcile with what was just recorded (including real, non-fabricated durations in the Slowest table); confirmed the Build selector only re-fetches Build-scoped cards while Plan-scoped ones hold steady; confirmed a custom role without `SPEC_VIEW` gets both a 403 from the API and a hidden "📊 Reports" button in the UI; confirmed via curl that an execution posted with no `execution_duration_ms` stores `null`, not the old fabricated `450`.

**Notable gap surfaced, not fixed here** (closed 2026-10-06, see "Reports overhaul, phase 3"): `docs/rfc_04_rbac_security_matrix.md`'s threat-model section names 6 specific attack vectors (spec tampering, verdict spoofing, mass export exfiltration, privilege escalation, token leakage, brute-force/DoS) but has no entry for this new aggregate-data read surface -- worth a 7th entry (something like "reporting/analytics data exposure") next time that doc gets revisited, but out of scope to add unprompted here.

## Fixed six Spec-mode case-editing UX issues, including a real session bug (2026-09-21)

Enter now submits the Suite/Test Case name fields, the case-title field autofocuses when the create-case form opens, new-case priority now defaults to `MEDIUM` (was `HIGH`, client and server-side fallback both changed), "+ Add Step" now focuses the new row's Action field, and "Save Steps" moved to the bottom of the steps editor. The sixth item was a real bug, not a UX tweak: `handleSaveSteps` and its four sibling save handlers (`handleUpdateCaseField`, `handleCreateDraft`, `handleApproveVersion`, `handleSaveVersionContent`) had no 401 handling at all, so an expired 15-minute JWT surfaced as a raw `"Unauthorized: Token expired"` server string instead of logging the user out cleanly -- these handlers are especially prone to it since drafting/reordering steps is pure client-side state with zero requests, so Save is often the first request issued after a long idle-but-editing session. Fixed with a shared `handleAuthExpiry()` helper (`apps/web/src/App.tsx`, mirrors `submitVerdict`'s existing 401 branch) wired into all five handlers. `npm test`: 475/475. Verified live: recorded the exact repro (corrupted the stored token, clicked Save Steps, got a clean logout instead of the raw error) and confirmed all five other fixes in a real browser session.

## Added: real Test Plan create/edit/delete, and made Spec mode reactive to plan changes (2026-09-21)

Elliot asked whether the stack could make Spec mode's "In Plan" badges/`+ Add` affordance update immediately when the last plan for a project is deleted (should clear) or a first plan is created (should reactivate) -- with "or does our stack not support that?" as an open question. Investigation found the premise didn't hold: Test Plan create/edit/delete (the toolbar next to the Plan dropdown) was **100% client-side mock state** -- `EntityManagementModal`'s `handleSaveEntity` PLAN branch never called the backend at all (no `POST`/`PUT`/`DELETE /api/v1/projects/:id/plans[...]` route existed anywhere), the exact "fake client-only pattern" this file has already flagged and fixed for RBAC, custom fields, and Suite/Case editing -- Elliot chose to build it properly (Recommended) rather than just patch around it.

- **`TestPlanRepository.create`/`update`/`delete` existed since the very first migration but were never called by any route** -- yet another instance of the "designed on day one, never queried" pattern (see RBAC/custom-fields/API-tokens entries above). Resurrected via new `POST`/`PUT`/`DELETE /api/v1/projects/:projectId/plans[/:planId]` routes (`apps/server/src/routes/projects.ts`), gated on `PLAN_MANAGE` -- whose registry description ("Create test plans and manage which test cases are in one") already named this exact capability.
- New `TestPlanRepository.deleteWithForce`, modeled directly on `TestSuiteRepository`/`TestCaseRepository`'s existing warn-then-confirm shape: without `force`, a plan with builds or pinned cases is left untouched and the blocked counts are reported; with `force` (or an empty plan), it deletes every execution under the plan's builds (their `execution_steps` cascade automatically), then the builds, then the plan's `test_plan_cases` links, then the plan itself -- ordered to respect `builds.test_plan_id`/`test_plan_cases.test_plan_id`/`executions.build_id` all being `ON DELETE RESTRICT`. New `sendPlanInUseError` (`errors.ts`) names the plan and counts, matching `sendSuiteInUseError`'s just-updated convention (`Test Plan {name} still contains {N} builds, {N} plan-linked cases...`).
- **The actual root cause of the "stale badges" symptom, once real deletes existed to test against**: `refreshSpecTree` required `selectedPlanId` to be truthy before fetching at all, even though `GET .../spec-tree`'s `plan_id` query param was already optional server-side (every case just comes back `in_plan: false` without it -- confirmed by reading the route, not assumed). Relaxed the guard to only require `selectedProjectId`, so Spec mode still loads real suites/cases (correctly annotated as not-in-plan) when a project has zero plans, instead of leaving whatever was last fetched for a since-deleted plan stale on screen. Also fixed a real bug in `loadPlans`: `if (data.plans.length > 0)` skipped both `setPlansList`/`setSelectedPlanId` entirely when a project's plan list came back empty, leaving `selectedPlanId` dangling on a stale id indefinitely -- now always sets the list and clears `selectedPlanId` to `""` when there are none.
- **Frontend**: `handleSaveEntity`'s PLAN branch rewritten to call the real routes (fire-and-forget async, matching how the modal already doesn't await `onSave`); a new `deletePlanPrompt` state + confirm banner (rendered below the header, `Cancel`/`Delete Anyway`) reuses the exact two-step warn-then-force pattern already established for Suite/Case delete, since a real plan can now genuinely have builds/executions attached. New `applyPlanDeletedLocally` helper clears `selectedPlanId` to `""` when the deleted plan was the last one, rather than falling back to a plan that may not exist. `EntityManagementModal.tsx`'s Plan status dropdown dropped the `"DRAFT"` option, which was never in `TestPlanRepository`'s real `'ACTIVE' | 'LOCKED' | 'ARCHIVED'` status union -- a UI/schema drift only visible once this path was ever exercised against the real backend.
- **Scope note**: `PROJECT` and `RUN` (Build) entity types in `EntityManagementModal`/`handleSaveEntity` still use the identical fake client-only CRUD pattern -- confirmed to have the same shape of bug, but out of scope here since only Test Plans were asked about. Worth the same treatment later.

New tests: a `TestPlanRepository.deleteWithForce` `describe` block in `packages/db/tests/test_case_versioning.repository.test.ts` (5 tests -- empty-plan immediate delete, blocked-with-counts, force-cascade, build-only-no-cases blocking, missing-plan), and a `describe` block in `apps/server/tests/spec_and_plan_curation.test.ts` (7 tests -- `PLAN_MANAGE` gating, create + immediate listing, 400s for missing name/invalid status, update, 404 cross-project, blocked-then-forced delete against the real seeded plan/build/execution, and an empty throwaway plan deleting immediately). `npm test`: **487/487**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end: deleted the seeded plan (blocked with the real message naming 1 build/10 plan-linked cases, then force-deleted), confirmed all 10 cases immediately flipped from "✓ In Plan" to "+ Add" with zero manual reload; created a new real plan and confirmed "+ Add" immediately worked (a real `POST .../test-plans/:id/cases` succeeded) with no reload needed either; confirmed the changes described in the previous dated entry (auto-grow textareas, steps-autosave-on-blur) alongside this, including that edits survived a full page reload.

## Added: auto-growing textareas and autosave-on-blur for the step editor (2026-09-21)

Two more Spec-mode requests from the same session as the Plan CRUD work above: Summary/Preconditions/Action/Expected Result textareas should expand to fit their content instead of scrolling, and steps should save automatically per-field rather than needing an explicit "Save Steps" click.

- New `autoGrowTextarea(el)` helper in `App.tsx` (reset `height: auto` then set it to `scrollHeight` -- the reset is what allows shrinking back down too, not just growing, since `scrollHeight` never reports smaller than the element's current height). Wired to all four fields via a mount-time `ref` callback (so a field that already has long content shows fully expanded immediately, not just after the first keystroke) plus `onInput` while typing. `resize: "none"` replaces `resize: "vertical"` on all four, since a manual drag-resize would otherwise fight the next keystroke's auto-size.
- `handleSaveSteps` renamed `saveSteps`, now takes an optional explicit steps array so a structural change (`removeStep`/`moveStep`) can save the freshly-computed array as a plain synchronous call immediately after `setStepsDraft`, rather than nesting an async fetch inside `setStepsDraft`'s own updater callback (impure, and risky under React StrictMode's intentional double-invocation of updaters) or racing `stepsDraft`'s stale closure value. Each Action/Expected Result `<textarea>` gained `onBlur={() => saveSteps()}`, matching Summary/Preconditions' existing silent-autosave convention exactly (no toast on success, same as those two fields already did). The "Save Steps" button was removed entirely and replaced with a small "Saving…" indicator that only appears while a save is in flight.

No new automated tests (pure frontend behavior with no new backend surface -- covered by the existing `handleSaveAuthExpiry`/route tests already exercising the same PUT endpoint). Verified live in a browser: typed multi-line content into Summary and a step's Expected Result and watched both fields grow to fit with no scrollbar; confirmed two `PUT .../test-case-versions/:id` calls fired from field blurs alone, with no button ever clicked; reloaded the page and confirmed both edits persisted and rendered already-expanded on load (proving the mount-time ref sizing, not just the live-typing path).

## Added: real Test Run (Build) CRUD; fixed the Plan-delete double-dialog and message wording (2026-09-24)

Three follow-ups to the Test Plan CRUD work above, all from the same live-testing pass: Test Runs needed the identical real-backend treatment Test Plans just got (confirmed via investigation: `BuildRepository.create/update/delete` were exactly as dormant as `TestPlanRepository`'s had been, `handleSaveEntity`'s RUN branch was still 100% fake client-side state); the Plan-delete-with-content warning's second sentence read like a raw API hint ("Pass force=true...") instead of a real confirmation; and deleting a plan with content showed **two** confirmation dialogs back to back (`EntityManagementModal`'s generic "Are you sure?" modal, then the informative blocked-with-counts banner) when it should show exactly one.

- **Real Test Run CRUD**: new `POST`/`PUT`/`DELETE /api/v1/projects/:projectId/plans/:planId/builds[/:buildId]` routes (`apps/server/src/routes/projects.ts`), gated on `BUILD_MANAGE` -- already registered/seeded (held by Admin/Test Lead/Automation Service) since the RBAC feature, just never had a route to gate. New `BuildRepository.deleteWithForce` (`packages/db/src/repositories/build.repository.ts`), same warn-then-confirm shape as the Suite/Case/Plan versions: blocks on recorded executions without `force`, cascades (delete executions, their `execution_steps` cascade automatically, then the build) with it. New `sendBuildInUseError` (`errors.ts`). The DB already enforced `uq_build_plan_name` (a run's name is unique per-plan, confirmed in the initial migration) -- the create route now surfaces a real `409` on that constraint instead of a raw Postgres error. **Runs were already correctly plan-scoped for reads** (`GET .../plans/:planId/builds` existed from the Export feature, and `refreshExecutionWorkspace`'s own per-plan build fetch already worked) -- the gap was entirely on the write side. **Plan-delete cascading Runs was also already true** before this entry -- `TestPlanRepository.deleteWithForce` (built for the Plan CRUD feature above) already deletes every build under a force-deleted plan; confirmed with a new regression test rather than assumed.
- **Frontend**: `handleSaveEntity`'s RUN branch rewritten to call the real routes (CREATE/EDIT only -- DELETE bypasses the modal, see below); a run always belongs to whichever plan is currently selected, with no plan-picker needed in the modal (same implicit-scoping pattern Suite creation already uses for the selected project). `EntityManagementModal.tsx`'s Run status dropdown dropped `"IN_PROGRESS"`, which was never in `BuildRepository`'s real `'OPEN' | 'CLOSED'` status union -- the same UI/schema drift bug fixed for Plan's `"DRAFT"` option in the previous entry, caught the same way (only visible once the path was wired to a real backend). New `applyPlanDeletedLocally` behavior: when a project's last plan is deleted, `runsList`/`selectedRunId` are now explicitly cleared too (previously only `selectedPlanId` was) -- without this, a stale, now-actually-deleted Run stayed shown in the dropdown forever, since `refreshExecutionWorkspace` self-guards on `!selectedPlanId` and never touches it again once there's no plan.
- **Removed the duplicate delete-confirmation dialog for Test Plans** (and built Test Run delete the same way from the start, so it never had the bug to begin with): both `handleDeletePlanClick`/`handleDeleteRunClick` now attempt the real (non-force) delete immediately on the trash-icon click -- no `EntityManagementModal` step first. The existing blocked-with-counts banner (`deletePlanPrompt`/new `deleteRunPrompt`) is the only confirmation ever shown, exactly matching how Suite/Case delete already worked (immediate delete for empty content, one informative banner with Cancel/"Delete Anyway" when blocked). `handleSaveEntity`'s PLAN/RUN branches now only handle CREATE/EDIT.
- **Reworded the Plan-in-use message**: `sendPlanInUseError`'s second sentence changed from `"Pass force=true to delete it anyway and permanently discard all of it."` to `"Are you sure you want to delete the test plan with its builds and links to test cases?"`, per direct request -- the first sentence (still contains N builds, N plan-linked cases...) is unchanged. `sendBuildInUseError` uses the equivalent phrasing for Runs from the start.

New tests: a `BuildRepository.deleteWithForce` `describe` block in `packages/db/tests/test_case_versioning.repository.test.ts` (4 tests), and a `describe` block in `apps/server/tests/spec_and_plan_curation.test.ts` (8 tests -- `BUILD_MANAGE` gating, create + immediate listing, 400s for missing name/invalid status, 409 for a duplicate name within the same plan, update, 404 cross-plan, blocked-then-forced delete against a real recorded execution, an empty run deleting immediately, and an explicit regression test that force-deleting a plan really does delete its runs too). `npm test`: **499/499**, all green. `tsc --noEmit` clean on all four workspaces. Verified live in a browser: deleted the seeded plan and confirmed exactly one dialog appeared with the reworded merged message ("Test Plan Sprint 42 Regression Plan still contains 1 build, 10 plan-linked cases. Are you sure you want to delete the test plan with its builds and links to test cases?"), confirmed the Run dropdown cleared immediately alongside the Plan dropdown (not just the Plan); created a new plan and a new real run under it (persisted, correctly scoped, `IN_PROGRESS` no longer offered); deleted the empty run immediately with no dialog, matching Suite/Case's established pattern.

## Fixed: stale Plan/Run dropdown data leaking across projects; "No test plan set" warning; warning banners recolored (2026-09-25)

Elliot reported "test runs can exist independently of test plans" still happening despite the previous entry's real Run CRUD. Investigation (and a live repro against his own running dev server, with his explicit go-ahead) found the actual remaining gap wasn't in the backend at all -- `builds.test_plan_id` is `NOT NULL`, so a Run genuinely cannot exist without a real Plan at the DB level -- it was two frontend staleness bugs that made it *look* that way:

- **`runsList`/`selectedRunId` started from hardcoded fake seed data** (`bld_01`/`bld_02`/`bld_03`) that nothing ever cleared before the real bootstrap fetch completed. Changed both to start empty, and added one reactive `useEffect` (`if (!selectedPlanId) { setRunsList([]); setSelectedRunId(""); }`) as the single catch-all for every path that can leave `selectedPlanId` empty -- covers the plan-delete path (already explicitly handled in `applyPlanDeletedLocally`) plus any future one, rather than relying on each call site to remember.
- **`loadPlans` only updated state on a successful (`res.ok`) response** -- reproduced live: switching to a project whose `GET .../plans` call fails (e.g. a fake `PROJECT`-branch id, since `PROJECT` create/edit/delete is still the one remaining client-side-mock entity type -- see below) left `plansList`/`selectedPlanId` on whatever the *previous* project had, and therefore `runsList` too, showing a Run that had nothing to do with the currently selected project. Now the `else`/`catch` branches also clear `plansList`/`selectedPlanId` to empty, which the new reactive effect above then propagates to clear `runsList` too.
- **New "No test plan set" warning**: the "+ Create New Test Run" button now checks `selectedPlanId` before opening the create-run modal; with none selected, it shows a `noPlanSetWarning` banner in the exact same slot `deletePlanPrompt`/`deleteRunPrompt` already use (directly below the header), with a single "OK" dismiss button instead of a destructive action.
- **All "Confirm Deletion"-style warning banners recolored** to a deep amber/yellow (`#78350f` background, `#92400e` border, `#fbbf24` label text, `#fde68a` body text) per direct request -- previously they used the same dark slate (`#111827`) as ordinary panels, distinguished only by a small amber "⚠️" label, easy to miss at a glance. Covers all 5 instances: `deletePlanPrompt`, `deleteRunPrompt`, `deleteSuitePrompt`, `deleteCasePrompt` (`App.tsx`), and the custom-field `deleteFieldPrompt` panel (`AdminPanelModal.tsx`, whose surrounding card background is now conditional on whether it's showing the warning). Error banners (red, e.g. `specEditError`) were deliberately left alone -- the request was about warnings specifically, and red already reads as more severe than a recolored amber would.

`npm test`: **499/499** effectively (498 + the same pre-existing flaky 1000-item batch timeout under parallel test-file load, confirmed passing in isolation as it has every time this has come up before). `tsc --noEmit` clean on all four workspaces. Verified live in a browser against Elliot's own running dev server (with his explicit go-ahead, minimal throwaway actions only): clicking "+ Create New Test Run" with no plan selected showed the new deep-yellow "No test plan set" banner; created a real plan + run from scratch and confirmed the plan-delete warning showed the same recolored banner with the right blocked count; confirmed force-deleting that plan cascaded the run too and cleared both dropdowns immediately; reproduced the stale-Run bug live by creating a throwaway fake project (exercising the still-unfixed `PROJECT` mock-CRUD path) and confirming the old code left a stale Run from a different project showing, then confirmed the fix.

- **Scope note**: `PROJECT` remains the one entity type in `EntityManagementModal`/`handleSaveEntity` still using the fake client-only CRUD pattern (per the previous entry) -- this session's repro leaned on that exact gap to reliably trigger the stale-data bug, underscoring it's worth the same real-backend treatment next.

## Fixed four Execution-mode/Plan-deletion UX issues; found and fixed a real Plan-dropdown race bug along the way (2026-09-25)

Four small, independent requests from the same live-testing session: the Run dropdown didn't clear when switching to a plan with zero runs; Ctrl+Enter always just advanced to `selectedIndex + 1` instead of jumping to the next suite/folder; the Plan-deletion warning's count/wording was off; and the "no plan set" banner had a trailing clause Elliot wanted dropped.

- **Stale Run dropdown, fixed**: `refreshExecutionWorkspace` (`apps/web/src/App.tsx`) had `if (builds.length > 0) { setRunsList(...); setSelectedRunId(...) }` — the same "guard skips setters, leaves stale state" bug class already fixed twice before for `loadPlans` (see the Plan/Run CRUD entries above), just triggered here by switching to a *real* plan that has zero runs rather than having no plan at all. Both setters now run unconditionally, with `selectedRunId` explicitly cleared to `""` when the new plan's build list is empty. The function's `catch`/fallback path got the same treatment for consistency, even though not separately reported.
- **Ctrl+Enter now jumps by suite/folder, not by raw array order**: `workspace.cases` is plan-case append/insertion order, not suite-grouped (confirmed via investigation before assuming otherwise — individually-added cases keep pin order, suite-cascade-added cases all collide at `position: 0` and sort by `external_id` among themselves, interleaving suites). New `apps/web/src/utils/executionCaseOrder.ts` (first file in a new frontend `utils/` directory, since this is UI-flow logic rather than domain logic that belongs in `packages/core`) — `buildExecutionCaseOrder` re-groups the same cases (by index into the original array, so `selectedIndex`-based code needs no changes) into real suite-tree pre-order, reusing the existing `suiteNodes`/`flattenSuiteOptions` machinery and each case's already-populated `test_suite_id`; `nextExecutionCaseIndex` advances within that order and wraps from the last case in the last folder back to the first case in the first folder. A suite with zero cases simply contributes nothing, which is "skip empty folders" with no special-casing. 10 new unit tests in `apps/web/src/tests/executionCaseOrder.test.ts`. Wired into `onSubmitNotes` in place of the old flat `selectedIndex + 1`.
- **Plan-deletion wording**: `sendPlanInUseError` (`apps/server/src/errors.ts`) now reads `"Test Plan {name} still contains {N} test cases. Are you sure you want to delete the test plan with its test runs and links to test cases?"` — using the plan-linked-case count (previously the message used whichever counts were nonzero, worded around "builds"). `invalid_params` still reports the full build/case/execution breakdown for API consumers.
- **"No plan set" banner shortened**: dropped the trailing `"-- a run always belongs to one."` clause, per direct request.
- **Found and fixed live, not part of the original four asks**: verifying the Run-dropdown fix required switching between plans on a fresh page load, which surfaced the Plan `<select>` rendering with zero options despite the backend correctly returning plans — `loadPlans` had no request-sequence guard, unlike `refreshSpecTree`/`refreshExecutionWorkspace` (see the Spec/Execution mode toggle entry above), even though `selectedProjectId` goes through the exact same fake-seed → real-id bootstrap sequence those two already guard against. A fast-resolving stale call (even one for an abandoned fake project id) could resolve after the real one and silently wipe `plansList` back to empty. Fixed with a `plansRequestSeq` ref, same pattern as the other two. Confirmed by reproducing the race on a clean page load before the fix and confirming it was gone after.

`npm test`: **509/509**, all green (10 new: `executionCaseOrder.test.ts`). `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end: created two plans (one with a run, one without) and confirmed switching between them correctly blanked/restored the Run dropdown with no staleness in either direction, including on a fresh page load (exercising the `loadPlans` race fix); built a 3-suite plan (populated suite A, empty suite B, populated suite C) and confirmed Ctrl+Enter from the last case in suite A jumped straight to the first case in suite C (skipping empty suite B), and confirmed Ctrl+Enter from the very last case overall wrapped back to the first case in suite A; force-deleted the seeded plan (10 plan-linked cases) and confirmed the reworded message ("...still contains 10 test cases. Are you sure you want to delete the test plan with its test runs and links to test cases?"); confirmed the "no plan set" banner reads "Select or create a test plan before creating a test run" with no trailing clause.

## Fixed a real project-switch race; added SPEC_AUTO_APPROVE; added active-suite highlighting in Execution mode (2026-09-25)

Three follow-up requests from the same live-testing session as the previous entry: the Run dropdown still leaked a stale run across a *project* switch (not just a plan switch, which the previous entry fixed), a request for a permission that skips the draft-review step on case creation, and a request to visually surface which suite/folder a case being executed lives in.

- **Real bug, reproduced live before fixing**: switching directly from a project with a plan+run selected to a project with zero plans correctly blanked the Plan dropdown, but left the previous project's Run showing. Root cause: the effect that calls `refreshExecutionWorkspace()` (`apps/web/src/App.tsx`) fires on `selectedProjectId` changing, independent of `selectedPlanId` -- so it fires once immediately with the *old* project's still-current `selectedPlanId` (a real, valid plan id, so its fetch legitimately succeeds and populates `runsList` with the old project's run) and then again once `loadPlans`'s async response clears `selectedPlanId` to `""`. The existing `executionWorkspaceRequestSeq` guard didn't help because `refreshExecutionWorkspace`'s `if (!selectedPlanId) return;` early-exit happened *before* the sequence counter was incremented, so the second (correct, empty-plan) call never invalidated the first (stale) call's in-flight request -- when that first request resolved after the correct clear had already happened, it silently repopulated `runsList` with the old run. Fixed by moving the sequence bump to the very top of the function, before the early-return, and having the early-return path itself explicitly clear `workspace`/`runsList`/`selectedRunId` (matching the `specTreeRequestSeq` pattern already used elsewhere in this file). Verified the fix holds even under rapid back-to-back project switching (BANK → ADMN → BANK → ADMN with no waits between), not just a single switch.
- **New permission `SPEC_AUTO_APPROVE`** (`packages/core/src/rbac/registry.ts`, 17 → 18 keys): a case created by a user holding this key is immediately `APPROVED` (with `reviewer_id` set to the creator) instead of starting as `DRAFT`, wired into `POST /api/v1/projects/:projectId/test-cases` (`apps/server/src/routes/specEditing.ts`) via `actor.permissions.includes('SPEC_AUTO_APPROVE')` -- `TestCaseVersionRepository.create` already accepted an optional `status`/`reviewer_id`, so no repository changes were needed. Granted by default to Admin and Test Lead (the same two roles that already hold `SPEC_APPROVE`), not Tester/Viewer/Automation Service -- a deliberate opt-in-by-role default rather than blanket-enabling it, so it reads as "the roles that can already approve things can also skip the step," not a silent global behavior change. Note for future reference: because `evaluatePermissions` expands `SYSTEM_ADMIN` to the *entire* registry unconditionally (see the machine-API-tokens entry above), any `SYSTEM_ADMIN` holder gets this automatically regardless of their role's explicit bundle -- consistent with how `SYSTEM_ADMIN` already bypasses every other permission check, but worth remembering if a future permission is ever meant to be admin-excludable (per that same entry, the only such key is `SYSTEM_ADMIN` itself, which is unconditionally excluded from grantable API token capabilities for exactly this reason).
- **Suite Tree now highlights the active case's containing folder in Execution mode**: `VirtualizedSuiteTree.tsx` gained a new `activeSuiteId` prop, distinct from the existing click-driven `selectedSuiteId` (which stays Specification-mode-only -- curation filtering, new-case target suite, etc.) -- a cyan/teal tint + left border (`#22d3ee`), visually distinct from `selectedSuiteId`'s blue, so the two concepts don't look identical if a suite is ever both. `App.tsx` passes `activeCase?.test_suite_id` (already-populated on every case in `workspace.cases`) when `workspaceMode === "EXECUTION"`, `null` otherwise -- purely a "you are here" visual cue with no effect on selection, filtering, or click behavior. No new tests (pure styling derived from an already-tested value); verified live by linking cases from two different suites into a plan and confirming the highlight moved from one suite row to the other as the active case changed, and disappeared entirely in Specification mode.

New tests: `packages/core/tests/rbac.test.ts` (+1, the 18-key count plus a new regression test for `SPEC_AUTO_APPROVE`'s per-role grants), `apps/server/tests/spec_editing.test.ts` (the existing Admin-creates-a-case test updated to expect `APPROVED`/`reviewer_id` now that Admin holds the new permission by default, plus a new test proving a role without it -- Tester -- still gets `DRAFT`), `apps/server/tests/admin_roles_and_overrides.test.ts` (permission-count assertion updated to 18). `npm test` in this worktree: **508/508** effective (511 total minus 3 failures confined entirely to `.claude/worktrees/vigilant-haslett-05b0d0/` -- a separate, concurrently-running git worktree/session on branch `claude/vigilant-haslett-05b0d0` whose own copies of `rbac.test.ts`/`role_templates.test.ts` are now stale against the shared `packages/core` registry this change touched; not this session's files to edit, flagged for whoever owns that worktree). `tsc --noEmit` clean on all four workspaces. Verified live in a browser: reproduced the project-switch staleness bug pre-fix (BANK → ADMN left "v1.0-rc1" showing under a zero-plan project), confirmed it gone post-fix including under rapid repeated switching; created a case as Admin and confirmed it was immediately `APPROVED` and pinnable to a plan with no approve step; confirmed the Suite Tree's active-suite highlight moved correctly between two real suites as the active case changed via direct row clicks.

## Fixed the step-editor scroll jump; relabeled "Create New Draft" to "Edit"; confirmed two other reports already fixed (2026-09-25)

Four more requests from the same ongoing live-testing session. Two were real, two turned out to already be fixed by earlier entries today -- confirmed by deliberately trying to reproduce each live before touching any code, rather than assuming either way.

- **Fixed: "+ Add Step" jumped the case-detail pane's scrollbar upward.** The existing `captureStepsScroll`/`restoreStepsScroll` pair (built for `moveStep`/`removeStep` -- see the auto-grow-textareas entry above) restores the pane's *previous* scroll position, which is the right behavior for reordering/removing a step but wrong for adding one: a new step is appended at the end, so the previous scrollTop now falls short of the true new bottom by one row's height, which would leave the newly-focused row off-screen -- the opposite of what "stay at the bottom" means here. `addStep()`'s own focus effect (`apps/web/src/App.tsx`) now force-sets `specDetailScrollRef.current.scrollTop = scrollHeight` in a `requestAnimationFrame` after focusing the new row, deterministically landing at the true bottom regardless of whatever caused the original upward jump (never root-caused precisely, but this makes the final scroll position correct by construction rather than depending on getting the cause right). Verified live: scrolled to the very top of a 9-step draft and confirmed clicking "+ Add Step" jumped straight down to reveal the new row, both from a scrolled-up starting position and adding several steps consecutively from the bottom.
- **"Create New Draft" relabeled to "Edit"**: per direct clarification after asking -- the original ask ("an edit button next to delete") sounded like it might mean introducing a real view/edit-mode toggle for the already-always-editable fields, which would have been a much bigger change; the actual intent was simpler -- the existing "Create New Draft" button (shown when an APPROVED case's fields are locked) *is* conceptually the edit action already, it just needed the right label. Pure text change, no behavior or position change, `apps/web/src/App.tsx`.
- **Confirmed already fixed, no code change needed**: the "test runs still show for the wrong plan" report matches request #1 fixed in this file's immediately preceding entry ("Fixed a real project-switch race...") almost exactly, except this time for switching *directly between two plans* rather than switching *projects*. Reproduced the user's exact described steps live three separate ways (scripted API calls, full UI-driven create-plan/create-plan/create-run/create-run/switch-back, and rapid back-to-back switching with no waits) and the Run dropdown correctly cleared every time on the current code -- this specific path was already covered by the very first fix in the preceding entry (`refreshExecutionWorkspace`'s response for the *newly selected* plan is always authoritative for that plan's own builds, regardless of what stale `build_id` a lagging closure happens to send as a query param). Likely explanation: the report reflects testing against a not-yet-restarted server process from before that fix landed (this repo's dev server needs a manual restart to pick up any backend/shared-package change -- see "Running things" -- easy to lose track of across a long live-testing session).
- **Confirmed already fixed, no code change needed**: the Plan-deletion warning's wording ("replace 'builds' with 'runs'") was already corrected to say "test runs" in this file's "Added: real Test Run (Build) CRUD..." entry (2026-09-24) and reconfirmed by this session's very first fix today (see "Fixed a real project-switch race..." above, request #3) -- `sendPlanInUseError`'s `detail` string has read "...with its test runs and links to test cases" since that fix. Re-verified live by triggering the actual blocked-delete banner in the browser just now; grepped the whole frontend for any other user-facing "build" wording and found none (the remaining `build`-named identifiers are all variable/route-path/comment references, never rendered text).

No new automated tests -- the scroll fix is pure client-side visual behavior with no new backend surface (same treatment as the auto-grow-textareas entry above), and the two "already fixed" items needed no code change to verify. `tsc --noEmit` clean on `apps/web`. Full `npm test` run to confirm no regressions from the one touched file.

## Fixed the step-editor scroll jitter for real -- root-cause pass, plus a genuine data-loss bug found along the way (2026-09-25)

Two earlier same-day fixes (the auto-grow-textareas entry and the "fix step-editor scroll jump on Add Step" entry above) hadn't actually resolved it -- Elliot reported "+Add Step" still visibly jumped to the top and focus-swapping between fields still jittered, and asked for a real investigation rather than another patch: why does this happen, what's been tried, what else could work. Used plan mode for this -- direct code reading plus an independent Plan-agent review that validated and substantially extended the diagnosis -- before touching any code.

**Root causes, all in `apps/web/src/App.tsx`'s Spec-mode case-detail pane (`specDetailScrollRef`, holding Summary/Preconditions/the steps list):**

1. **The conditionally-rendered "Saving…" autosave indicator was the primary cause of focus-swap/blur jitter, not any focus-restoration mechanism.** `saveSteps()` toggles `isSavingSteps` around every autosave; the indicator was a normal flow `<div>`, so it grew/shrank `scrollHeight` on every save. When a save resolved and the indicator disappeared, `scrollHeight` shrinking below the current `scrollTop` made the **browser itself synchronously clamp `scrollTop` down** as part of that commit -- a real, visible jump with zero involvement from React or any of the existing scroll-preservation code, firing on literally every blur of every field.
2. **`addStep`'s corrective scroll ran in a `useEffect` (after paint), so the wrong frame was still visible before the correction landed.** React's commit-phase focus/selection restoration (`restoreSelection`) engages whenever a mutation touches a subtree containing the focused node -- inserting a new row before the still-focused "+Add Step" button qualifies -- and can misapply a stale scroll offset. The old fix's `useEffect` + double-`requestAnimationFrame` correction only ran after the browser had already painted that wrong frame at least once.
3. **`addStep` never blurred the active element before mutating state**, unlike `moveStep`/`removeStep` (which already do, with a comment explaining why) -- a plain parity gap. (Caveat surfaced during review: whether the button is actually focused pre-click is browser-dependent -- Chromium focuses buttons on click, Safari/Firefox-mac traditionally don't -- so this alone wouldn't have fully fixed it even combined with fix 1; fix 2 is what makes it browser-independent.)
4. **The per-row Action textarea's `ref` callback was a fresh closure every render** (it closes over the row index `i`), so React detached/reattached it -- re-running `autoGrowTextarea`'s forced-reflow resize -- for *every existing row*, not just a changed one, on every commit that touched the list. Extra layout thrash interleaved with exactly the commits fix 2/3 care about.
5. **A genuine data-loss race, found while tracing the same code paths (confirmed in scope, not just cosmetic):** if a field is still focused when Move/Remove is clicked, the field's native blur fires *before* the button's own `onClick` -- triggering a `saveSteps()` with the **stale pre-reorder** array. `moveStep`/`removeStep` then fire their own save with the freshly reordered array. Both hit the same PUT endpoint with no sequencing; if the stale request happened to resolve after the fresh one, the reorder/removal was silently reverted server-side.

**Fixes applied, in order:**

1. Made the "Saving…" indicator layout-neutral -- always mounted, `opacity`/`visibility` (+`aria-hidden`) toggle instead of conditional mounting. Structurally removes the shrink-on-resolve → native-clamp jump rather than compensating for it.
2. Added `useLayoutEffect` to the React import; switched `addStep`'s corrective effect from `useEffect` to `useLayoutEffect`, and its `.focus()` call to `.focus({ preventScroll: true })` -- the correction now runs synchronously before paint, the last word before the user ever sees a frame, and the browser's own native scroll-into-view never fires to begin with.
3. Added the missing `(document.activeElement as HTMLElement | null)?.blur()` to `addStep`, matching `moveStep`/`removeStep`.
4. Stabilized the per-row Action textarea's `ref` callback: only calls `autoGrowTextarea` on genuine mount (guarded by `!el.style.height`), not on every reattach -- live growth while typing is already covered by the existing `onInput` handler.
5. Fixed the stale-save race: `saveSteps` now aborts any still-in-flight save (via a per-call `AbortController` stored in a ref) before starting a new one, so only the most-recently-started save can ever complete/apply -- an aborted request's `catch` treats `AbortError` as expected (no error toast), and its `finally` only clears `isSavingSteps` if it's still the current (non-superseded) call, so a fast-aborting stale request can't flip the indicator off while a real save is still in flight.
6. Centralized the capture/blur/mutate/restore discipline into a new `useStepsScrollPreserved(scrollRef)` hook (module-level, next to `autoGrowTextarea`) returning `{ captureScroll, blurActiveElement, scheduleRestore }` -- `scheduleRestore(mode)` (`"restore"` re-applies the captured position, for reorder/removal; `"scrollToBottom"` scrolls to the new bottom, for append) bumps a tick consumed by one shared `useLayoutEffect`, replacing four independently-hand-rolled call sites (this inconsistency, per the review, is exactly *why* `addStep` was missing the blur in the first place -- centralizing is what stops a third recurrence). `moveStep`/`removeStep`/`addStep`/the two textareas' `onBlur` all route through this now; the old inline `captureStepsScroll`/`restoreStepsScroll`/`preservedStepsScrollTopRef` are gone.

No new automated tests (pure client-side interaction/timing behavior plus a racy-save fix, consistent with how this same feature area was verified all session: live browser only). `npm test`: unchanged at **508/508** in this worktree (the 3 failures a full run shows live entirely in `.claude/worktrees/vigilant-haslett-05b0d0/` -- a separate concurrent session's git worktree, not touched, see the "SPEC_AUTO_APPROVE" entry above for the same note). `tsc --noEmit` clean on `apps/web` after every step, not just at the end. Verified live in a browser with concrete measurements, not just visual inspection: scrolled a real DRAFT case's step editor (Lorem-Ipsum-sized content, `scrollHeight` ~2400px) to the very top and clicked "+Add Step" -- landed at `scrollTop` exactly equal to `scrollHeight - clientHeight` (no gap, unlike the ~48px shortfall observed pre-fix); focused a field, typed, and Tab'd to the adjacent field mid-list -- `scrollTop` was measured identical (bit-for-bit) immediately before the blur, immediately after, and after the autosave resolved, i.e. zero movement, not just "no visible jump"; reproduced the stale-save race directly (focused a field with an unsaved edit, clicked Move-up on a *different* row without blurring first, reloaded the case from the server) and confirmed the reorder persisted correctly rather than reverting.

## Fixed: execution notes were discarded on Pass/Skip verdicts (2026-09-25)

Elliot reported that typing a note and then clicking Pass didn't save the note. Root cause: `submitVerdict`'s `resolvedNotes` computation (`apps/web/src/App.tsx`) only carried the Notes field's content through for `FAILED`/`BLOCKED` verdicts -- `PASSED`/`SKIPPED` explicitly discarded it (`null`), an unstated assumption from whenever this route was first built that notes were failure-reason-only. The Notes field itself was never actually scoped that way -- it's a single general-purpose textarea (placeholder: "Type execution details or notes here...") always visible regardless of which verdict is about to be recorded, so the restriction was a real oversight, not an intentional constraint worth preserving.

Fixed by dropping the verdict check entirely: `resolvedNotes` now carries whatever's in the Notes field (if non-empty) through for every verdict -- `const resolvedNotes = notes || (failureNotes.trim() ? failureNotes : null);`. No other changes needed -- the Pass/Skip button handlers already called `submitVerdict(verdict)` with no explicit `notes` argument, so they pick up the fix automatically; Fail/Block were already correct and are unaffected.

No new automated tests (this route has no existing test coverage for the notes field specifically, and the fix is a one-line removal of an incorrect condition). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 508/508 in this worktree. Verified live end-to-end: typed a note, clicked Pass, confirmed the status bar recorded `PASSED`, navigated back to the same case and saw the note still showing, then confirmed directly against the server (`GET .../test-plans/:id/cases`) that `latest_verdict: "PASSED"` and `latest_notes` both persisted correctly -- not just a client-side optimistic-update artifact.

## Fixed: Run dropdown never refreshed in Specification mode; a related stale-selection bug in ExportModal (2026-09-25)

A recent same-session fix made the header's Run dropdown correctly react to Project/Plan switches while in Execution mode. Elliot noticed it was still broken in Specification mode and asked for a general investigation of the Project/Plan/Run dropdowns, not just a quick patch. Used plan mode -- direct code reading validated by an independent Plan-agent review -- before touching any code.

**Root cause**: `apps/web/src/App.tsx` has exactly one function, `refreshExecutionWorkspace`, that ever fetches a plan's real builds from the server and populates `runsList`/`selectedRunId`. The single effect that triggers refreshes on Project/Plan/mode change only called it `if (workspaceMode === "EXECUTION")` -- in Specification mode nothing ever repopulated the Run dropdown's data at all, so it stayed frozen at whatever it last showed in Execution mode. The Run `<select>` itself is part of the always-rendered shared header (not gated by mode), so it was visible and interactive in Spec mode, just fed stale data. A separate mode-agnostic effect already correctly *clears* `runsList`/`selectedRunId` whenever `selectedPlanId` becomes empty, which is why switching to a planless project/plan looked like it "worked" -- masking that switching between two plans that both have real runs showed completely stale data. Confirmed already correct and unaffected: the Project dropdown (`loadProjects`) and Plan dropdown (`loadPlans`, has its own `plansRequestSeq` guard from an earlier fix) -- both mode-agnostic already. Confirmed sufficient for a lightweight fix: `selectedRunId` has exactly 4 read sites in the file and nothing Spec-mode-specific depends on it; `refreshSpecTree`'s own route only ever takes `plan_id`.

- **New `refreshRunsList` function**, `apps/web/src/App.tsx`, a lighter sibling of `refreshExecutionWorkspace` that hits the lightweight `GET /api/v1/projects/:projectId/plans/:planId/builds` route (`apps/server/src/routes/exports.ts`, already built for `ExportModal.tsx`'s own Build picker -- confirmed to return the exact same `Build` shape via the same `BuildRepository.findByTestPlan` call, no new backend code needed) instead of the heavy `/test-plans/:planId/cases` endpoint Execution mode needs (which also fetches the full case/step queue Spec mode has no use for). The shared refresh effect now does `if (workspaceMode === "EXECUTION") { refreshExecutionWorkspace(); } else { refreshRunsList(); }` -- exactly one of the two runs per trigger, no double-fetch in either mode.
- **`executionWorkspaceRequestSeq` renamed to `runsListRequestSeq`** and is now shared by both functions, not just `refreshExecutionWorkspace`. This matters because a stale in-flight call from *either* function must be able to invalidate a newer one from *either* -- e.g. switching Spec (plan A) -> Execute (still A) -> a different plan B while still in Execute mode must not let plan A's now-abandoned Spec-mode fetch resolve later and silently overwrite plan B's freshly-loaded runs. One seq per logical resource being protected (`runsList`/`selectedRunId`), not one per function, matching how `plansRequestSeq`/`specTreeRequestSeq` are already scoped. `refreshRunsList` bumps it before its own early-return, mirroring `refreshExecutionWorkspace`'s existing fix for the identical race (documented in that function's own comment) -- skipping this would have reintroduced the exact bug class in the sibling function.
- **`apps/web/src/components/ExportModal.tsx` -- a second, related bug found during the same investigation**: the modal's own Project `<select>` never cleared its (entirely separate, modal-local) `selectedPlanId`/`selectedBuildId` state when the project changed, unlike `ReportingModal.tsx`'s identical picker, which already resets both correctly. Fixed by adding the same two-effect pattern `ReportingModal.tsx` already uses: one clearing `selectedPlanId`/`selectedBuildId`/`plans`/`builds` whenever `targetProjectId` changes, and the existing Build-picker effect now also unconditionally clears `selectedBuildId`/`builds` at its top before conditionally refetching (a build is plan-scoped, so a stale selection from a previous plan must never survive into a newly-selected one).

Edge cases confirmed already covered by this design, no extra code needed: rapid Spec/Execute mode-toggling mid-fetch (closed by the shared seq counter); initial mount and full-page-reload always start in Execution mode (`workspaceMode` isn't persisted), so this fix only changes in-session mode-switch behavior; Run CRUD racing an in-flight refresh is a pre-existing, already-accepted low-probability race unrelated to this fix (CRUD handlers already do direct/optimistic `setRunsList` calls with no seq check, in both modes, today).

No new automated tests (same class of client-side interaction/timing behavior verified live-only all session, mirroring how the Execution-mode version of this exact fix was verified). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 508/508 in this worktree. Verified live in a browser: created a plan with a distinct run, confirmed the Run dropdown showed it correctly in Spec mode; switched to a different plan (same project) while staying in Spec mode and confirmed the Run dropdown updated to that plan's own runs, not the stale one; switched project entirely while in Spec mode and confirmed both Plan and Run cascaded correctly to the new project's own data; switched to a project/plan with zero runs and confirmed it blanked correctly; stress-tested rapid back-to-back project switching with no waits between and confirmed no staleness; opened the Export modal, picked a plan in one project, switched the modal's own Project dropdown, and confirmed the Plan/Build selects reset instead of showing a stale cross-project selection.

## Fixed: Ctrl+Enter flipped a Skipped verdict to Failed; moved the case-detail Edit button next to Delete, removed its duplicate "+ Add to Plan" (2026-09-27)

Two more Spec/Execution-mode requests. Both in `apps/web/src/App.tsx`.

- **Root cause of the verdict flip**: `pendingVerdictRef` (the ref `onSubmitNotes`/Ctrl+Enter reads to decide which verdict to resubmit alongside notes) was only ever explicitly set to `"FAILED"`/`"BLOCKED"` -- everywhere else it defaulted to `"FAILED"`, including the per-case reset effect that runs whenever the active case changes (`pendingVerdictRef.current = activeCase?.latest_verdict === "BLOCKED" ? "BLOCKED" : "FAILED"`, unconditionally defaulting PASSED/SKIPPED/UNTESTED alike to FAILED). So navigating to an already-SKIPPED case, adding a note, and pressing Ctrl+Enter silently resubmitted it as FAILED -- confirmed by reproducing live (verdict flipped even though nothing but a note was touched) before fixing. Also latent in the hotkey path: `onVerdict` only updated `pendingVerdictRef` for FAILED/BLOCKED, and the Pass/Skip mouse buttons never updated it at all -- harmless in the common case (both auto-advance to the next case, which re-runs the per-case reset effect and re-derives the ref from the new case's own data) but exposed on the very last case in a plan, where neither button advances and the stale ref would survive into a later Ctrl+Enter.
- **Fix**: the per-case reset effect now preserves whatever verdict a case already has (`activeCase.latest_verdict`) whenever it's a real one, only defaulting to FAILED when the case is genuinely `UNTESTED` -- so a note-only Ctrl+Enter always resubmits the existing verdict unless the user explicitly chose a different one. `onVerdict` (the hotkey handler) now updates `pendingVerdictRef` for every verdict, not just FAILED/BLOCKED (the auto-focus-notes side effect stays FAILED/BLOCKED-only, unchanged). The Pass and Skip mouse buttons now also set `pendingVerdictRef` explicitly, closing the last-case edge case.
- **Case-detail header cleanup**: the "Edit" button (relabeled from "Create New Draft" in an earlier entry above) moved from beside the version/status badge down to the header's right-side action row, next to the delete button, per direct request. The "+ Add to Plan"/"✓ In Plan" toggle that used to live in that right-side slot was removed entirely -- it duplicated the identical per-row toggle every case already has in the case list (`SpecCaseListGrid`'s `onToggleInclusion`, sharing the same `handleToggleCaseInclusion`/`pendingToggleId` state, confirmed still wired and unaffected) -- and Edit now occupies that slot instead. The "✓ Approve" button (shown for DRAFT cases) was left in its original place beside the badge -- only Edit was asked to move.

No new automated tests (pure client-side interaction/state-derivation logic and a JSX relocation, no new backend surface -- consistent with how this whole feature area was verified live-only all session). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 508/508 in this worktree (3 unrelated failures remain confined to the separate `.claude/worktrees/vigilant-haslett-05b0d0/` session, per the recurring note above). Verified live in a browser: pressed 's' to skip a case (correctly auto-advanced, as designed), navigated back to it, added a note, pressed Ctrl+Enter, and confirmed via a direct server fetch that both `latest_verdict: "SKIPPED"` and the new note persisted -- not flipped to FAILED; opened an APPROVED case in Spec mode and confirmed Edit now sits beside Delete (not near the badge) with no "+ Add to Plan" button present, clicked Edit to create a draft and Approve to lock it again, confirming both still work correctly from the new position.

## Added: required custom fields gate auto-approve and explicit approve; checkbox styling and edit-mode gating (2026-09-27)

Four requests closing gaps in the custom-fields/auto-approve interaction introduced earlier this session: a case with an unfilled required custom field was being silently auto-approved anyway, and there was no way to block an explicit Approve either; the CHECKBOX custom field's checkmark glyph was too small at 16px; and custom field values stayed editable regardless of whether the case itself was locked.

- **New shared pure function** `findUnsatisfiedRequiredFields(definitions, values)` in a new `packages/core/src/custom-fields/requiredFieldsCheck.ts` (9 unit tests) -- returns every definition that's required, has no `default_value`, and has no real value recorded (`null`/`undefined`/`''`, matching `customFieldValidator.ts`'s own `isEmpty` semantics; an explicit `false` on a CHECKBOX someone actually toggled off correctly counts as provided, not missing, since `getValuesForEntity`/`readCustomFieldValue` already distinguish "never set" from "explicitly unchecked" -- confirmed by reading the validator before assuming, not guessed). A required field *with* a default_value is always considered satisfied, even with no value row yet -- the default effectively provides it. Deliberately a minimal duck-typed interface (not importing `packages/db`'s `CustomFieldDefinition`/`CustomFieldValueEntry` types directly) to avoid a circular workspace dependency from `packages/core`.
- **`POST /api/v1/projects/:projectId/test-cases`** (`specEditing.ts`): the SPEC_AUTO_APPROVE gate now also checks `findUnsatisfiedRequiredFields(await customFieldRepo.listVisibleToProject(projectId, 'TestCase'), [])` (empty `values` array is exactly right for a brand-new case -- nothing's been recorded yet, so any required field with no default is unconditionally unsatisfied) -- if anything's unsatisfied, the case is created `DRAFT` regardless of the permission, same as before SPEC_AUTO_APPROVE existed.
- **`POST .../test-case-versions/:versionId/approve`**: now runs the identical check against the case's *actual* recorded values (`customFieldRepo.getValuesForEntity('TestCase', owningCase.id, projectId)`) before flipping DRAFT→APPROVED, rejecting with a new `sendRequiredCustomFieldsMissingError` (`errors.ts`, 422, names every missing field by label) if anything's still unsatisfied. This is a real, previously-open gap -- nothing gated Approve on custom fields at all before this.
- **`CustomFieldEditor.tsx`'s CHECKBOX rendering**: dropped the `✓` glyph entirely (was rendered as the button's text content at 10px inside a 16px square, illegible) -- the green fill + border when checked is the only on/off signal now, matching how the request framed it ("just leave it filled green when checked").
- **Custom field values in the Spec-mode case detail pane now follow the same DRAFT-only editability as everything else in that pane** (`App.tsx`): `disabled={!(isDraft && hasPlanManagePermission)}` (was `!hasPlanManagePermission` alone), with a `disabledTitle` that names the actual reason (locked vs. missing permission). Deliberately a **frontend-only** gate -- the backend `PUT .../custom-field-values/:definitionId` route is untouched and still accepts writes regardless of version status, preserving the explicit, already-tested design decision from the original custom-fields feature ("values are never version-locked," see that entry above) rather than silently reversing it. `isDraft` is the same variable the summary/preconditions/steps editors already key off of, already in scope in the same block.

New tests: `packages/core/tests/requiredFieldsCheck.test.ts` (9), two new cases in `apps/server/tests/spec_editing.test.ts` (a required-field-no-default case walking through create→DRAFT→422-on-approve→set-value→200-on-approve, and a required-field-WITH-default case confirming it auto-approves normally). `npm test`: **519/519** in this worktree (508 + 11 new; the usual 3 unrelated failures stay confined to the separate `.claude/worktrees/vigilant-haslett-05b0d0/` session). `tsc --noEmit` clean on all four workspaces. Verified live in a browser end-to-end: created a required "Severity" TEXT field with no default and a non-required "Automated OK" CHECKBOX field via the Admin Panel; created a new case as Admin (a SPEC_AUTO_APPROVE holder by default) and confirmed it stayed DRAFT instead of auto-approving; confirmed the checkbox renders as a plain colored square with no glyph, and both fields were live-editable while DRAFT; clicked Approve with Severity still empty and got the new inline error naming it by label; filled in Severity, approved successfully; confirmed both custom field controls immediately became genuinely `disabled` (checked via `element.disabled`, not just visually) with the new "Editable only while in Draft" tooltip once the case was locked.

## Fixed: TEXT custom fields didn't wrap, leaked values across cases/suites, and ignored their default on new cases (2026-09-28)

Three more custom-fields bugs from the same live-testing session as the required-fields-gate entry above, all specific to TEXT-type fields (though two of the three root causes turned out to affect NUMBER/DATE too): a long value didn't wrap or grow the box, just scrolled horizontally; switching from case A to case B showed case A's text still sitting in case B's field; and a TEXT field's configured `default_value` was never applied to a newly created case.

- **Wrapping/auto-grow**: `CustomFieldEditor.tsx`'s TEXT case was a single-line `<input type="text">` -- switched to a `<textarea>` with the same `autoGrowTextarea` ref+`onInput` pattern `App.tsx`'s Summary/Preconditions fields already use (reset height to `auto` then set it to `scrollHeight`), `resize: none`, `rows={1}`. Same `onBlur`-commits-the-value semantics as before, just wrapped/growing instead of clipped.
- **Default value now applied when unset**: new `resolveDefaultValue(fieldType, defaultValue, opts)` in `packages/core/src/custom-fields/customFieldValidator.ts` -- coerces a definition's free-text `default_value` (stored as one generic string regardless of type, see `AdminPanelModal.tsx`'s single "Default Value" input) into the same JS-value shape `readCustomFieldValue()` returns, type-aware but lenient (a default that doesn't cleanly coerce for its type, e.g. a non-numeric NUMBER default, resolves to `null` rather than throwing). Wired into `CustomFieldRepository.getValuesForEntity`/`getValuesForEntities` (`packages/db`) as the fallback when no `custom_field_values` row exists, replacing the old unconditional `: null`. This is a **read-time** fix, not a write-time seed at case creation -- deliberately, since it's simpler, needs no change to the create routes, and applies uniformly to every entity (new or pre-existing, TestCase or TestSuite) that's never had the field touched, which is exactly the same "no row yet" state a genuinely-new case is in. Already consistent with `findUnsatisfiedRequiredFields`'s existing rule that a `default_value` satisfies a required field with no value row.
- **Cross-entity value leak, root-caused properly rather than patched once and declared done** -- three real bugs stacked, found by reproducing live in the browser after an initial one-line fix didn't hold up:
  1. `CustomFieldEditor`'s TEXT/NUMBER/DATE inputs are uncontrolled (`defaultValue`, committing on blur) but were keyed only by `entry.definition.id` in both render sites (`App.tsx`'s case detail, `SuiteCustomFieldsPanel.tsx`) -- since the same field definition is shared across every case/suite, switching entities never changed the key, so React reused the same mounted DOM input and a changed `defaultValue` prop had no effect on its live value. Fixed by keying on `${specSelectedCaseId}-${entry.definition.id}` / `${suiteId}-${entry.definition.id}` instead, forcing a real remount per entity.
  2. That alone wasn't sufficient: the key change fires *before* the newly-selected entity's fetch resolves, so the freshly-remounted input's `defaultValue` snapshots whatever `specCaseCustomFieldValues`/`values` state still happens to hold at that instant -- the *previous* entity's data, since the fetch is async. Because it's uncontrolled, once mounted with that stale snapshot, the correct data arriving moments later via the same fetch has no way to update it either. Fixed by clearing the values state to `null` **synchronously at the top of the fetch effect**, before the `fetch()` call -- so there's nothing (or a brief empty gap) to snapshot until the fresh data is actually in hand, in both `App.tsx` and `SuiteCustomFieldsPanel.tsx`.
  3. A separate, genuine data-corruption race in the *save* path: `handleCustomFieldValueChange`/`SuiteCustomFieldsPanel.handleChange`'s optimistic `setSpecCaseCustomFieldValues`/`setValues` update after a successful PUT blindly patched whatever the *current* state array was, keyed only by `definitionId` -- if a blur-triggered autosave for entity A was still in flight when the user switched to entity B, A's late-arriving response would patch entity B's now-current array with entity A's saved value (the PUT itself was harmless, always hitting A's real endpoint -- only the client-side display got corrupted). Fixed with a ref (`specSelectedCaseIdRef`/`suiteIdRef`, mirrored from the corresponding state/prop via a `useEffect`) that the async handler checks *after* its request resolves, skipping the optimistic display update if the user has since navigated to a different entity.
  All three fixes were required together -- reproduced and confirmed each one still broken after only the previous fix(es) were in place, rather than assuming the first attempt was sufficient.

No new automated tests (pure client-side interaction/timing behavior for the leak fixes, consistent with how this whole feature area was verified live-only all session; the default-value fallback is a small, obvious repository change covered indirectly by existing `getValuesForEntity`/`getValuesForEntities` tests, none of which assert `default_value` interacts with a null value row). `npm test`: unchanged at 519/519 in this worktree (the same 3 unrelated failures stay confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on all four workspaces. Verified live end-to-end against a real running dev server: created a TEXT field with a long default value and confirmed a brand-new case immediately showed it, wrapped across multiple lines with the box auto-expanded, no code touching it; created a second case with an explicit distinct value; switched back and forth between the two cases five times in rapid succession (including a batch of clicks with no waits between) and confirmed each settled on its own correct value every time, with no leakage in either direction; typed a long value live into a DRAFT case's TEXT field and watched it wrap/grow in real time; confirmed the value persisted and rendered already-wrapped/expanded after a full page reload.

## Changed: the app now starts in Specification mode by default (2026-09-28)

Elliot asked for the app to open in Spec mode rather than Execution mode. Simple on the surface (`workspaceMode`'s `useState` initial value, `apps/web/src/App.tsx`), but flipping it surfaced a real, previously-latent bug: `workspace` (the Execution-mode queue/build data structure -- distinct from `specData`, which drives Spec mode) started as `null` and was only ever populated by `refreshExecutionWorkspace()`, which the mode-driven bootstrap effect only calls `if (workspaceMode === "EXECUTION")`. With Spec mode now the default, that fetch never fires on a fresh load, so `workspace` stayed `null` forever -- and the top-level `if (!workspace) return <Loading...>` gate (guarding the entire authenticated app shell, not just Execution-mode UI) never resolved, leaving the app stuck on "Loading High-Density Workspace..." indefinitely. Confirmed live before fixing, not assumed: a fresh login hung on the loading screen.

First attempt (reverted): a one-time bootstrap effect that force-called `refreshExecutionWorkspace()` once on mount regardless of mode. This interacted badly with the shared `runsListRequestSeq` guard (see the "Run dropdown never refreshed in Specification mode" entry above) -- the bootstrap's request used the still-fake seed project/plan ids, 404s while its stale-response fallback logic was in flight, and by the time it tried to apply the fallback, subsequent legitimate `refreshRunsList()` calls (from Spec mode's own bootstrap, racing the same seq counter) had already bumped the sequence number past it, so the guard correctly-but-unhelpfully treated the bootstrap's own fallback write as stale and dropped it -- leaving `workspace` permanently `null` since the one-time ref never allowed a retry. Reproduced and confirmed dead before abandoning the approach.

**Actual fix**: `workspace`'s `useState` now initializes directly to `DEFAULT_FALLBACK_WORKSPACE` (the same placeholder object `refreshExecutionWorkspace()` itself already falls back to on a no-plan-selected/failed fetch) instead of `null`. This needed no change to any fetch/effect logic at all -- `passedCount`/`failedCount` and the other unconditional `workspace.cases` reads (`App.tsx` lines ~2035-2085) turned out to already be used only inside Execution-mode-gated UI branches (confirmed by reading every call site, not assumed), so briefly holding placeholder data is invisible to a user who starts in and stays in Spec mode; the moment they actually switch to Execution mode, the existing mode-driven effect fetches real data exactly as it always has. The `if (!workspace)` loading gate is now effectively dead code (nothing ever sets `workspace` back to `null`), left in place as a harmless no-op rather than restructured, to keep the diff minimal.

No new automated tests (a `useState` initial-value change plus a one-line `if` gate becoming unreachable; no new backend surface). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 519/519 in this worktree (same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`, per the recurring note elsewhere in this file). Verified live in a browser: a fresh login now lands directly in Specification mode with the Suite Tree, case list, and Run dropdown all correctly populated with real data (not stuck loading, not showing fallback placeholders); switching to Execution mode from there correctly fetches and displays the real case queue and Pass/Fail counts, not lingering placeholder data.

## Changed: custom fields moved under the steps, shown in Execution mode; required fields must have a default (2026-09-28)

Three requests, all around custom fields.

- **Position**: in Spec mode's case detail (`apps/web/src/App.tsx`) the custom-fields block moved from between Preconditions and the steps to *below* the steps (after the step table/editor). Because content now sits under the step list, "+ Add Step" can no longer scroll to the container's true bottom (that would push the new row off-screen behind the custom fields) -- `useStepsScrollPreserved` now takes an optional end-of-steps anchor (`stepsEndAnchorRef`, a zero-height div right after the "+ Add Step" button) and scrolls just far enough (never upward) to bring it into view. Two real bugs surfaced while measuring this live: (1) `CustomFieldEditor`'s TEXT textarea used an inline `ref` that re-ran `autoGrowTextarea` (height -> auto -> scrollHeight) on every commit, momentarily collapsing the field and, with it now at the tail of the scroll container, snapping `scrollTop` to 0 right after an add -- fixed with the same mount-only guard (`!el.style.height`) the step textareas already use; (2) `saveSteps`' `finally` schedules a `"restore"` that re-applies the `scrollTop` captured at the preceding blur, which silently undid every *second and later* add (the first add sits at the captured position anyway) -- the hook now updates its captured position after an append scroll so a later restore lands where the append put it. Verified: five consecutive adds each advanced `scrollTop` by exactly one row (48px) with the new focused row visible every time.
- **Execution mode**: the active case's custom field values now render, read-only (disabled `CustomFieldEditor`s, tooltip pointing to Spec mode), between the step table and the drawer/Notes. New `execCaseCustomFieldValues` state + a fetch effect keyed on `[workspaceMode, activeCase.case_id]`, same clear-before-fetch discipline as the Spec-mode fetch (the editors are uncontrolled). Read-only is a deliberate reading of "shown" -- easy to make editable if wanted.
- **Required fields need a default**: `POST /api/v1/admin/custom-fields` and `PUT .../:id` (`apps/server/src/routes/customFields.ts`) now return `422 REQUIRED_FIELD_NEEDS_DEFAULT` when the resulting field would be required with no usable default -- blank default, or one that doesn't coerce for the field type (`resolveDefaultValue` returns null, e.g. a non-numeric NUMBER default or a SINGLE_SELECT default that isn't one of its options). The message tells the admin that existing test cases/suites need an initial value, provided via the Default Value field (defaults are applied read-time to every record with no value row -- see the 2026-09-28 TEXT-field entry). PUT evaluates the merged state, so flipping an optional field to required, or clearing a required field's default, is blocked too; the Admin Panel already displays `data.error`. The repository itself stays permissive (import/AUTO_CREATE and tests can still build legacy states), which is why the older "required, no default blocks auto-approve/approve" server checks remain as defense in depth -- the existing `spec_editing.test.ts` case now builds that state through `CustomFieldRepository` directly.

New tests: `custom_fields_admin_and_values.test.ts` +1 (create/update matrix: no default, invalid NUMBER default, valid default, optional->required, clear default). `tsc --noEmit` clean. Verified live: the API returns the message; clearing the default in the Admin Panel and saving shows it inline; a pre-existing case showed the field (default applied) under its steps in Spec mode and read-only under its steps in Execution mode.

## Refined the same-day required-default rule to create-only; CHECKBOX field settings simplified (2026-09-28)

Four follow-up corrections to the entry immediately above, from the same session.

- ~~**The required-default check is now create-time only.**~~ **Reverted the next day (2026-09-29) -- see "Reverted: required-default check is enforced on update again" below.** Elliot's framing at the time: a required field only needs a default *at creation*, so pre-existing records get a real value from day one -- once the field exists, there's no equivalent gap to protect against, so an update should never be blocked on this. `PUT /api/v1/admin/custom-fields/:id` (`apps/server/src/routes/customFields.ts`) no longer called `requiredFieldDefaultError` at all; only `POST` (create) did. Concretely: flipping an already-existing optional field to required with no default succeeded, and clearing an already-required field's default succeeded too -- both previously blocked. This turned out to be a misstatement of the actual intent (a required field must *always* have a default, not just at creation) and was corrected the next day.
- **Message reworded** to Elliot's exact wording at the time: *"Creating a required custom field must include a default value. Otherwise preexisting test cases and suites will have an empty required field. You may remove the default after creation."* -- also superseded by the 2026-09-29 revert below, since "you may remove the default after creation" is no longer true.
- **CHECKBOX fields have no "Required" option.** `AdminPanelModal.tsx`'s field-editor form now hides the Required toggle entirely when `fieldType === "CHECKBOX"` (both for a new field and when editing an existing one), and switching a new field's type to CHECKBOX clears any already-set `is_required` so a stale value can't be silently submitted. A `false` CHECKBOX value already reads as "explicitly provided" everywhere in this codebase (see `findUnsatisfiedRequiredFields`'s established `null`-vs-`false` distinction) -- the practical effect of "required" on a boolean field was always marginal, and Elliot asked for it gone rather than reasoned about.
- **CHECKBOX's Default Value is now a checkbox, not a text box.** Same `AdminPanelModal.tsx` form: when `fieldType === "CHECKBOX"`, the Default Value row renders the same colored-square toggle `CustomFieldEditor.tsx`'s CHECKBOX control already uses (no free-text "type true/1" affordance) instead of the shared text input every other type still uses. Storage is unchanged -- still the one generic `default_value: string | null` column, just written/read as the literal strings `"true"` or `""` (empty = no default, mapped to `null` on save) instead of admin-typed text; `resolveDefaultValue`'s existing CHECKBOX coercion (`"true"`/`"1"` -> `true`) needed no changes.

New tests: `custom_fields_admin_and_values.test.ts`'s create/update-matrix test rewritten to assert the update-never-blocks behavior instead of the old blocked-update assertions it had one entry ago (making an existing optional field required with no default now expects `200`, not `422`; clearing an existing required field's default now expects `200` too). `tsc --noEmit` clean on `apps/server`/`apps/web`. Verified live in the Admin Panel and via curl: creating a required TEXT field with no default shows the exact new message and is rejected; creating one with a default succeeds; clearing that field's default via `PUT` afterward now returns `200` (previously `422`); selecting "Checkbox" as the field type hides the Required toggle and swaps the Default Value input for a checkbox that renders the same filled-green style as `CustomFieldEditor`'s own CHECKBOX control; created a real CHECKBOX field with a checked default and confirmed it round-trips correctly through the edit view after saving.

## Added: creating a custom field with a default now freezes that default into every pre-existing record (2026-09-28)

Elliot flagged a real, previously-unnoticed side effect of the create-time default requirement added earlier the same day: `getValuesForEntity`'s `resolveDefaultValue` fallback (see the "TEXT custom fields ... ignored their default on new cases" entry above) is computed fresh from the definition's *current* `default_value` every time it's read -- so an admin editing a field's default after the fact (even just to fix a typo) would silently change the *displayed* value for every pre-existing case/suite that had never been individually touched, rewriting what those records "had" at the moment the field was created.

- New `CustomFieldRepository.seedDefaultValueForAllEntities(definition)` (`packages/db`): called once, right after `createDefinition()`, never on update. Coerces the definition's `default_value` via the same `resolveDefaultValue()` the read-time fallback already uses, then bulk-inserts a real `custom_field_values` row for every existing entity the definition is visible to -- every `test_cases`/`test_suites` row project-wide for a global field (the only kind the Admin Panel creates), or just that project's own rows for a project-scoped one (the import wizard's `AUTO_CREATE` path). A no-op (returns `0`) with no default, or a default that doesn't coerce for the field's type -- nothing sensible to seed either way, matching the read-time fallback's own treatment of an unusable default as "no default." Wired into `POST /api/v1/admin/custom-fields` (`apps/server/src/routes/customFields.ts`) right after `createDefinition()` succeeds; the seeded count is included in both the audit log `diff` and the response body (`seeded_count`) and the create route stays the only caller -- `PUT` was deliberately left alone per the same-day "create-only" decision above, and there's no equivalent gap on update to protect against (an update can't retroactively affect what records looked like before it ran).
- **An entity created *after* the field already exists still gets today's read-time fallback**, unchanged -- there's no "pre-existing" data for a not-yet-created record to protect, so it continues to reflect whatever the default is at the moment it's read, exactly like before this fix. This is a deliberate asymmetry, not an oversight: freezing only applies to records that existed at creation time.
- **Frontend**: `AdminPanelModal.tsx`'s save-field success toast appends `" Default applied to N existing records."` when the create response's `seeded_count` is nonzero, so the effect (and its scale) is visible without requiring the admin to go check individual cases.

New tests: `packages/db/tests/custom_fields.repository.test.ts` gained a `describe('seedDefaultValueForAllEntities')` block (4 tests -- seeds and freezes a `TestCase`, no-op for no/invalid default, seeds `TestSuite` too, and confirmed project-scoped seeding never touches a different project's entities). `apps/server/tests/custom_fields_admin_and_values.test.ts` gained an end-to-end test: create with a default seeds every pre-existing seeded case (asserted against the real `seed.caseIds.length`), confirms the frozen value via the real value-read route, edits the definition's default via `PUT`, re-reads the same pre-existing case and confirms it's unchanged, then creates a brand-new case and confirms *that* one picks up the new default. `npm test`: **525/528** in this worktree (the usual 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on `packages/db`/`apps/server`/`apps/web`. Verified live end-to-end against the real running dev server: created a required TEXT field with a default via the API and confirmed `seeded_count` matched the real pre-existing case count (15); changed the definition's default via `PUT`; confirmed an already-existing case's value stayed at the original default while a brand-new case created afterward picked up the new one; created a second field through the actual Admin Panel UI and confirmed the toast read "✓ Custom field created. Default applied to 16 existing records."

## Reverted: required-default check is enforced on update again (2026-09-29)

Elliot flagged the "create-only" relaxation from the entry above as a mistake he'd asked for: the actual, corrected rule is that a required custom field must *always* have a usable default -- full stop, not just at the moment it's created. Reverted back to the original behavior from the very first "require a default" entry, with the create-only detour left in the doc history above (struck through) rather than silently erased.

- `requiredFieldDefaultError` (`apps/server/src/routes/customFields.ts`) is unchanged in shape but its doc comment now states the rule applies identically on create and update, and its no-default message dropped the now-false "you may remove the default after creation" framing, back to *"A required custom field must have a default value. Existing test cases and suites need an initial value for it, so provide one in the Default Value field."*
- `PUT /api/v1/admin/custom-fields/:id` calls `requiredFieldDefaultError` again, evaluated against the *merged* final state (existing definition's `is_required`/`default_value`/`options`, overridden by whatever the request body actually supplies) -- exactly the logic the create-only commit removed, restored verbatim from before it. Concretely, both now `422` again: making an already-existing optional field required with no default, and clearing an already-required field's default.
- The `seedDefaultValueForAllEntities` freeze-on-create feature (the very next entry above, same day) is untouched -- Elliot's correction was specifically about the create-only *validation* relaxation, not the freezing behavior, and the two are independent (freezing only ever runs from `POST`, which always required a default regardless of this back-and-forth).

Test reverted to match: `custom_fields_admin_and_values.test.ts`'s create/update test (renamed back to `'refuses to create OR update a required field without a usable default value'`) now asserts both blocked-update cases return `422` again, matching the test's shape from before the create-only commit.

`npm test`: 525/528 (a full run's 524/528 the same pass includes the already-documented flaky 1000-item batch timeout tripping this time, see "Fixed: stale Plan/Run dropdown..." above) -- all failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`, none in this session's own files. `tsc --noEmit` clean on `apps/server`. Verified via curl against the real running dev server: making an existing optional field required with no default now returns `422` again (was `200` the previous day); clearing an existing required field's default now returns `422` again too.

## Shortened the required-default error message (2026-09-29)

Per direct request: `requiredFieldDefaultError`'s no-default message (`apps/server/src/routes/customFields.ts`) trimmed from the two-sentence explanation to just *"A required custom field must have a default value."* -- the server string has no `⚠️` prefix itself; that's added by `AdminPanelModal.tsx`'s existing `⚠️ {errorMessage}` display wrapper, so the requested `"⚠️ A required custom field must have a default value."` renders exactly as asked without needing any frontend change.

No test changes needed -- `custom_fields_admin_and_values.test.ts`'s assertion was already the loose `toContain('default value')`, which still matches. `tsc --noEmit` clean on `apps/server`. Verified live: the Admin Panel shows exactly `⚠️ A required custom field must have a default value.` when creating a required field with no default.

## Confirmed already enforced: approve blocked on a missing required custom field; reworded the delete-in-use warning; suite click now shows a Suite Details pane (2026-09-29)

Three requests. The first needed investigation and verification rather than a code change; the other two are real changes.

- **"A test case should not be able to be approved if a required custom field is missing"**: investigated rather than assumed, and confirmed this is already fully implemented and enforced -- `POST .../test-case-versions/:versionId/approve` (`apps/server/src/routes/specEditing.ts`) has run `findUnsatisfiedRequiredFields` against the case's real recorded values since the "Added: required custom fields gate auto-approve and explicit approve" entry earlier this session, rejecting with `422 REQUIRED_CUSTOM_FIELDS_MISSING` (naming every missing field by label) if anything's unsatisfied, and the frontend (`handleApproveVersion` in `App.tsx`) already surfaces that message inline via `specEditError`. Re-verified the full route-level test for this still passes. Worth noting for context: since this same session separately re-enforced "a required field must always have a default value" (see the entries above), and a required field with a default is always treated as satisfied even before any explicit value is recorded (`findUnsatisfiedRequiredFields`'s deliberate `default_value !== null` bypass, from the original design), this gate is now closer to defense-in-depth for day-to-day use than something that fires in the ordinary create-a-field-then-approve-a-case flow -- it still fires for genuinely legacy/edge states (e.g. a definition somehow existing with `is_required: true` and no default, which every currently-reachable API path now refuses to create). No code changed here; flagged in case the distinction between "has a default" and "has been explicitly reviewed" matters to a future request.
- **Reworded the custom-field-delete-blocked message**: `sendCustomFieldInUseError` (`apps/server/src/errors.ts`) changed from *"...Pass force=true to delete it anyway and permanently discard that data."* to *"...Are you sure you want to delete them?"*, matching the phrasing already used for the equivalent Suite/Plan/Run in-use warnings. No frontend change needed -- `AdminPanelModal.tsx`'s two-step delete-confirmation banner already renders the server's `detail` string verbatim.
- **Suite click now shows a Suite Details pane in Pane 3, replacing the case-detail view**: `apps/web/src/App.tsx`'s Pane 3 (previously `specActiveCase ? <case detail> : <"Select a test case..." placeholder>`) gained a third branch, `specActiveSuite` (looked up from the nested spec-tree by `selectedSuiteId`, a new `findSuiteNode` helper generalizing the old name-only `findSuiteName`), shown whenever a suite is selected and no case is -- an always-editable Name field (same onBlur-save pattern as the case title editor, via a new `handleUpdateSuiteName`) plus the suite's custom field values, now editable inline instead of behind a separate button. Selecting a case still takes priority over a selected suite (unchanged: `onSelectSuite` already cleared `specSelectedCaseId`, and `onSelectCase` never touched `selectedSuiteId`, so the two ids were already mutually exclusive in practice -- this only changes what renders when a suite id is the one set). This makes the suite tree's old "✎ Fields" icon button (which opened a separate floating `SuiteCustomFieldsPanel`) redundant, per direct request -- removed the button, its `onOpenSuiteFields` prop from `VirtualizedSuiteTree.tsx`, and the now-fully-unused `SuiteCustomFieldsPanel.tsx` component file entirely (deleted, not left as dead code); its fetch/save logic (clear-before-fetch discipline, a `selectedSuiteIdRef`-guarded stale-response race check on save) was ported directly into `App.tsx` as `suiteCustomFieldValues`/`handleSuiteCustomFieldValueChange`, mirroring `specCaseCustomFieldValues`/`handleCustomFieldValueChange`'s existing shape exactly rather than inventing a new pattern.

No new automated tests for the suite-details UI (pure client-side view routing plus a straightforward reuse of already-tested fetch/save patterns, consistent with how this whole feature area has been verified live-only all session) -- `apps/web`'s existing test suite (33 tests, unrelated files) still passes untouched. `tsc --noEmit` clean on `apps/server`/`apps/web`. Verified live in a browser end-to-end: clicked a suite and confirmed Pane 3 switched to its name + "No custom fields defined for Test Suites yet."; created a TestSuite-entity custom field via the Admin Panel and confirmed it immediately appeared, editable, in the same pane; typed a value, blurred, and confirmed a real `PUT .../test-suites/:id/custom-field-values/:definitionId` saved it; renamed the suite via the new Name field and confirmed a real `PUT .../test-suites/:id` fired and the tree updated; clicked a case afterward and confirmed Pane 3 correctly switched back to case details while the suite stayed selected (still filtering the case list); confirmed the old "✎" icon button no longer appears anywhere in the tree; triggered the custom-field delete-in-use warning via curl and confirmed the new "Are you sure you want to delete them?" wording.

## Fixed: a required custom field's value never actually went blank, but the UI could LOOK blank after a rejected edit; closed a real MULTI_SELECT gap too (2026-09-29)

Elliot reported being able to approve a test case with a required field blank. The previous entry's investigation had concluded the server-side gate was already solid and left it there -- this time, reproduced live end-to-end (as a non-admin role, since only a role holding `PLAN_MANAGE` without `SPEC_AUTO_APPROVE` can actually exercise a DRAFT case with an editable required field -- no default role has that exact combination, so this needed a throwaway permission override to even set up) before writing any code, and found the real bug.

- **Root cause**: `CustomFieldEditor.tsx`'s TEXT/NUMBER/DATE inputs are uncontrolled (`defaultValue`-driven, committing on blur -- see the 2026-09-28 TEXT-field entry for why). Clearing a required field's value and blurring correctly gets rejected server-side (`422 REQUIRED_FIELD_MISSING` -- `setValue`'s existing `parseCustomFieldValue` call already throws on an empty required value, unchanged), but `handleCustomFieldValueChange`'s catch block only ever set an error message -- it never touched `specCaseCustomFieldValues` (which still correctly held the real, unchanged value) or forced the uncontrolled input to re-sync to it. The DOM kept showing whatever blank text the user had just typed, indefinitely, even though the actual stored value was never touched. A user who cleared the field, saw a small red error easy to miss, and then clicked Approve would see the box sitting empty and the approve succeed (correctly -- the real server-side value was still "Medium" the whole time) -- reading exactly like "the app let me approve with an empty required field," even though the field was never actually blank in the data.
- **Fix**: new `customFieldResetKeyById`/`suiteCustomFieldResetKeyById` state (`App.tsx`, one per entity type, mirroring every other per-definition state this pane already tracks), bumped in `handleCustomFieldValueChange`/`handleSuiteCustomFieldValueChange`'s catch blocks and folded into `CustomFieldEditor`'s `key` prop at both render sites -- a rejected save now forces the input to remount, snapping the display back to the last known-good value (which was never actually lost) instead of leaving a stale, misleading blank box on screen. The red error text was already there and unchanged; the fix is that the field visibly matches reality again once the user sees it.
- **A second, real, independent gap found via the same investigation**: `parseCustomFieldValue`'s `isEmpty()` check (`packages/core/src/custom-fields/customFieldValidator.ts`) only ever treated `null`/`undefined`/`''` as empty -- an empty array (`[]`) was not caught, so a required MULTI_SELECT field really could be saved with nothing selected (deselecting every pill in `CustomFieldEditor.tsx`'s MULTI_SELECT control submits exactly `[]`), with no rejection at all. Fixed by extending `isEmpty()` to also treat a zero-length array as empty. `findUnsatisfiedRequiredFields`'s own inline emptiness check has the identical blind spot (`value === null || value === undefined || value === ''`, same gap for `[]`) but was left alone -- fixing the write path means an empty selection can never be persisted for a required field in the first place, so the read-time check never needs to see one.

New tests: `packages/core/tests/customFieldValidator.test.ts` +1 (required MULTI_SELECT rejects `[]` with `REQUIRED_FIELD_MISSING`; a non-required field accepts it and reads back as `null`, matching every other "nothing here" value). No new tests for the frontend reset-key fix (pure client-side display-consistency behavior, consistent with how this whole feature area has been verified live-only all session). `npm test`: unchanged at 525/528 in this worktree (same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on `packages/core`/`apps/web`. Verified live end-to-end, as a real non-admin role: created a required TEXT field with a default, granted a Tester a `PLAN_MANAGE` override (no default role combines that with lacking `SPEC_AUTO_APPROVE`) to get a genuinely-editable DRAFT case, cleared the Severity field and blurred -- confirmed the box snapped back to "Medium" with the rejection error shown below it (not left blank), and confirmed via a direct API read that the case's real stored value was "Medium" throughout, never actually cleared.

## Fixed: a rejected custom-field save's error message leaked onto the next case/suite viewed (2026-09-29)

Elliot reported that the `REQUIRED_FIELD_MISSING` error from the entry immediately above stayed on screen after switching to a different test case, regardless of that case's own field state.

- **Root cause**: `customFieldErrorById`/`suiteCustomFieldErrorById` (`App.tsx`) are keyed only by `definitionId` -- the same field definition is shared across every case (or suite), so an error left over from a rejected edit on the *previous* entity kept showing against the *new* entity's field too, even though nothing was ever wrong with it there. Nothing cleared these dicts on an entity switch; only the fetched *values* were cleared/refetched, not the error state layered on top of them.
- **Fix**: both fetch effects (the one keyed on `specSelectedCaseId`, the one keyed on `selectedSuiteId`) now reset their respective error dict to `{}` at the very top, before anything else -- so a stale error can never survive past the entity it was raised on, matching the same "reassess per entity" discipline the values themselves already had.

No new automated tests (pure client-side state-scoping bug, consistent with how this whole feature area has been verified live-only all session). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 526/529 in this worktree (same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). Verified live end-to-end as a real non-admin role (same `PLAN_MANAGE`-override setup as the entry above, since no default role combines that with lacking `SPEC_AUTO_APPROVE`): cleared a required field on Case A, confirmed the `REQUIRED_FIELD_MISSING` error appeared; switched to Case B and confirmed no error was shown and its own Severity field correctly displayed its own default value, untouched by anything that happened on Case A.

## Fixed: clicking an already-selected suite deselected it (2026-09-29)

Per direct request. `onSelectSuite` (`App.tsx`, wired to `VirtualizedSuiteTree`) toggled `selectedSuiteId` to `null` when the clicked suite was already the selected one (`prev === suiteId ? null : suiteId`) -- a leftover from before Pane 3's Suite Details view existed (see the "Suite click now shows a Suite Details pane" entry above), when selecting a suite only ever filtered the case list and toggling it off had a real "clear the filter" use. Now that clicking a suite also drives what's shown in Pane 3, re-clicking the selected suite would blank that pane back to the empty placeholder for no reason. Changed to unconditionally set `selectedSuiteId(suiteId)` -- no longer a toggle, so a click on the already-selected suite is a no-op that leaves it selected. Every other path that clears `selectedSuiteId` (switching projects, deleting the selected suite) is untouched.

No new automated tests (pure client-side selection-state behavior). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 526/529 in this worktree (same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). Verified live in a browser: clicked a suite (Pane 3 switched to its details), clicked it two more times in a row and confirmed it stayed selected and Pane 3 kept showing the same suite's details throughout; clicked a different suite and confirmed selection still switches normally.

## Fixed: invisible date-picker calendar icon; DATE fields' Admin Panel default value is now a real date picker too (2026-09-29)

Three requests, all about DATE-type custom fields.

- **Invisible calendar icon**: every native `<input type="date">` in this app sits on a dark background, but the browser's built-in calendar glyph renders in black by default regardless of page theme -- nearly invisible against it. There's no way to recolor it via an inline `style` prop (it's not a regular pseudo-element reachable that way), so a global rule was added to `apps/web/index.html`'s existing `<style>` block (the only other place any non-inline CSS already lives in this app): `input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(1); cursor: pointer; }`, the standard fix for this exact problem. Applies everywhere a date input exists -- `CustomFieldEditor.tsx`'s DATE control, the Admin Panel's new DATE default-value picker below, and (previously unnoticed, fixed for free) the API Tokens tab's "Expires" date field.
- **DATE fields now get a real date picker for their Default Value, not a free-text box** -- `AdminPanelModal.tsx`'s field-editor form gained a third branch (alongside the existing CHECKBOX-gets-a-checkbox one) for `fieldType === "DATE"`: an `<input type="date">` bound to `fieldDefaultValue` instead of the shared plain-text input every other type still uses. This closes the loop with `CustomFieldEditor.tsx`'s own DATE control, which already used a native date input -- the admin-facing default-value editor was the one place still asking for a date as typed free text.
- **Placeholder/format guidance**: a native date input's `placeholder` attribute is defined by the HTML spec to be ignored for this input type (every browser shows its own locale-formatted `mm/dd/yyyy` hint instead, unconditionally) -- so literally setting one would have had no visible effect. Added a small caption below the input instead ("Pick a date, or type one as YYYY-MM-DD."), matching this form's existing small-grey-caption convention, which is what actually satisfies "tell the admin the expected format" now that a real picker means most admins won't need to type it at all.

No new automated tests (pure CSS + a form-control swap, no new backend surface). `tsc --noEmit` clean on `apps/web`. `npm test`: unchanged at 526/529 in this worktree (same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). Verified the calendar-icon fix in isolation first (a throwaway static HTML page, side-by-side before/after, confirming the icon is genuinely a barely-visible dark blob without the fix and a crisp white calendar glyph with it) before confirming the same CSS rule is loaded in the running app (`document.styleSheets`); created a real DATE field with a default via the Admin Panel's new picker and confirmed the create response's `seeded_count` matched the real pre-existing case count, exactly like the create-time freezing behavior from the entries above.

## Simplified the custom-field Options editor to one input per option; SINGLE_SELECT's Default Value is now a live dropdown (2026-09-29)

Two requests about the SINGLE_SELECT/MULTI_SELECT Options editor in the Admin Panel.

- **One "Option" input, not separate Label/Value ones.** `AdminPanelModal.tsx`'s Options list used to have two text inputs per row (`option_label`/`option_value`), even though nothing in this app ever displays them differently -- `CustomFieldEditor.tsx` always renders `option_label` and stores `option_value`. Collapsed to a single "Option" input whose `onChange` sets both fields to the same typed text. Frontend-only -- the two columns are unchanged in the DB/repository/backend; editing an older field whose label/value happened to differ will overwrite the value to match on next edit, which is the intended effect of collapsing the concept.
- **SINGLE_SELECT's Default Value is now a real `<select>`**, built directly from the Options list already in component state, instead of a free-text box asking the admin to retype an option string by hand with no guarantee it matched. It updates live as options are added/renamed/removed, with no extra wiring needed. (MULTI_SELECT's default is unchanged -- still the shared text input, since its default is a JSON array of multiple values, out of scope for this pass.)

No new automated tests (pure Admin Panel form UI, no new backend surface). `tsc --noEmit` clean on `apps/web`. Verified live in a browser: created a throwaway SINGLE_SELECT field, confirmed the Options list only ever shows one input per row, typed "High"/"Low" into two option rows and watched the Default Value dropdown list exactly those two choices live, saved (seeded onto pre-existing records as usual), then deleted the field to clean up.

## Focus the newly-added row when adding a custom field option (2026-09-29)

Per direct request: clicking "+ Add Option" for a SINGLE_SELECT/MULTI_SELECT field left focus on the button itself, needing an extra click into the new row before typing. `AdminPanelModal.tsx`'s `addFieldOption` now records the new row's index (mirroring `App.tsx`'s `stepActionRefs`/`pendingStepFocusIndexRef` pattern for the step editor's "+ Add Step"), and a new `useLayoutEffect` focuses that row's input once it exists in the DOM.

No new automated tests (pure client-side focus behavior). `tsc --noEmit` clean on `apps/web`. Verified live: clicked "+ Add Option" twice in a row and confirmed `document.activeElement` was the newly-added row each time, with the previously-typed option's value left untouched.

## Fixed: a custom field that's set required after being left blank now switches those blank values to the field's default (2026-09-30)

Elliot reported that clearing a SINGLE_SELECT custom field's value and then flipping the field to required (which per this session's rule always requires a usable default) left the already-cleared value sitting blank instead of picking up the new default.

- **Root cause**: `CustomFieldRepository.getValuesForEntity`/`getValuesForEntities` only fall back to the definition's `resolveDefaultValue()` when there's no `custom_field_values` row at all for that entity+definition. Clearing a field explicitly (selecting "—", or blanking a TEXT/NUMBER/DATE box) while the field was still optional writes a real row with every typed column `null` -- a genuinely different state from "never touched," and one the read-time fallback was never designed to see past. Once the field becomes required with a default, that blank row is no longer a valid state to leave sitting in the DB, but nothing ever revisited it.
- **Fix**: new `CustomFieldRepository.applyDefaultToBlankValues(definition)` (`packages/db`) -- finds every existing value row for the definition that's blank (every typed column `null`, or -- for MULTI_SELECT -- `json_value` of `'[]'`, matching `@testify/core`'s own `isEmpty()` semantics) and updates it to the definition's coerced default. An entity holding a real, non-blank value (including an explicit `false` on a CHECKBOX) is never touched -- this only replaces a blank, never a deliberate choice. A no-op with no default_value or one that doesn't coerce for the field's type, same as its create-time sibling `seedDefaultValueForAllEntities`. `PUT /api/v1/admin/custom-fields/:id` (`apps/server/src/routes/customFields.ts`) calls it right after `updateDefinition()` whenever the update leaves the field required (a usable default is already guaranteed at that point by the existing `requiredFieldDefaultError` check), and returns the count as `applied_default_count` in both the response body and the audit log diff -- an entity with no row at all is untouched by this method and needs no backend action, since it already reads as the default live via the existing read-time fallback.
- **Frontend**: `AdminPanelModal.tsx`'s save-success toast now shows "Default applied to N existing records." on the update path too (previously only ever shown for a brand-new field's `seeded_count`), reusing the exact same message with `applied_default_count` as the source on an update.

New tests: a new `describe('applyDefaultToBlankValues')` block in `packages/db/tests/custom_fields.repository.test.ts` (5 tests -- switches an explicit-blank value to the default once required; never touches an entity with a real value or overwrites a no-row entity; treats an explicit `false` CHECKBOX as non-blank; treats a MULTI_SELECT `[]` as blank too; no-op with no/unusable default). `apps/server/tests/custom_fields_admin_and_values.test.ts` gained an end-to-end route test (blank a SINGLE_SELECT value while optional, flip the field to required-with-default via `PUT`, confirm `applied_default_count: 1` and the value reads back as the default). `npm test`: 532/535 in this worktree (the usual 3 failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on `packages/db`/`apps/server`/`apps/web`. Verified live end-to-end against the real running dev server: created a SINGLE_SELECT field, set a real case's value to "High" then explicitly back to "—" (confirmed via a direct API read the stored value was a real `null` row, not "no row"), flipped the field to required with default "High" via the Admin Panel (toast read "✓ Custom field saved. Default applied to 1 existing record."), and confirmed via a direct API read the case's value was now "High".

## MULTI_SELECT custom fields: default value is now a pill toggle, matching the test-case editor; required now needs at least one option (2026-09-30)

Four related requests about MULTI_SELECT custom fields, following the same pattern already built for SINGLE_SELECT (see the two 2026-09-29 Options-editor entries and the required-switches-to-default entry above).

- **Default Value is now a pill toggle row**, `AdminPanelModal.tsx`, replacing the free-text JSON-array box MULTI_SELECT still used after the SINGLE_SELECT dropdown work -- styled identically to `CustomFieldEditor.tsx`'s own MULTI_SELECT control (same colors, same "✓ Label"/"— Label" pill shape), built live from the Options list already in component state, exactly like the SINGLE_SELECT dropdown's live-updates-with-`fieldOptions` approach. The underlying storage is unchanged -- still the same JSON-array string `custom_field_values.json_value` already uses -- so no backend or repository changes were needed for this part. A stale option value no longer present in `fieldOptions` (e.g. after a rename) simply isn't rendered as a pill. (This entry originally left removing an option's own default-selection unpruned until the next pill toggle -- fixed the same day, see the entry directly below.)
- **A required MULTI_SELECT field now needs at least one option toggled on as its default.** `resolveDefaultValue()` happily parses `'[]'` as a syntactically valid (but practically empty) array, so `requiredFieldDefaultError` (`apps/server/src/routes/customFields.ts`) gained an explicit extra check: a `MULTI_SELECT` default that resolves to a zero-length array is treated the same as no default at all, both on create and on update.
- **A case/suite with nothing toggled on for a MULTI_SELECT field already gets switched to the default once the field is made required** -- this was already covered by `CustomFieldRepository.applyDefaultToBlankValues` (added in the entry directly above this one), which already treated a MULTI_SELECT's blank state (`json_value` null, matching how `parseCustomFieldValue`'s `isEmpty()` check stores an explicitly-cleared selection) as blank and in need of the default. No additional backend code was needed for this part -- confirmed by a new end-to-end test rather than assumed.

New tests: `apps/server/tests/custom_fields_admin_and_values.test.ts` gained two tests -- one confirming a `'[]'` default is rejected (both create and update) the same way a blank string is, and one confirming making a MULTI_SELECT field required-with-default switches a case with nothing toggled on to that default (`applied_default_count: 1`), reusing the `applyDefaultToBlankValues` machinery from the entry above with no code changes needed to make it pass. `npm test`: unchanged at 532/535 in this worktree (14/14 in the custom-fields test file, same 3 unrelated failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on `apps/web`/`apps/server`. Verified live in a browser: created a MULTI_SELECT field, watched the Default Value area show "Add options below first." with zero options, added two options and watched matching pills appear live, tried to create it required with no pill toggled and got the "⚠️ A required custom field must have a default value." error, toggled one pill on and created successfully (toast: "Default applied to 15 existing records.").

## Fixed: deleting a selected default option left it silently stuck in the stored default, breaking Save (2026-09-30)

Elliot reported: create a MULTI_SELECT field with a couple of options toggled on as the default, delete one of those options, and Save fails with `The default value '["farts","fire"]' is not valid for a MULTI_SELECT field, so existing records would still have no value. Provide a valid default value.` -- a real gap in the entry directly above this one: its pill-toggle Default Value control filters `fieldOptions` at *render* time (so a removed option's pill correctly disappears from view) but never actually touched the underlying `fieldDefaultValue` JSON string on removal -- that stale value only ever got pruned the next time some *other* pill was clicked. Save therefore submitted a default still naming the deleted option, and `resolveDefaultValue`'s all-or-nothing validation (any element not in the current option set invalidates the whole default) rejected it outright.

- **Fix**: `removeFieldOption` (`AdminPanelModal.tsx`) now actively deselects the removed option from `fieldDefaultValue` at the moment it's deleted, not just visually hiding it -- for `MULTI_SELECT`, the option's value is filtered out of the JSON array (clearing it to `""` if that was the last selected value); for `SINGLE_SELECT`, if the removed option *was* the current default, it's cleared to `""` too, closing the identical latent gap there (same class of bug, same all-or-nothing `resolveDefaultValue` check, just never reported since a SINGLE_SELECT default is a single string rather than an array that's easy to leave partially valid).

No new automated tests (pure client-side form-state bug, no new backend surface -- the backend-side validation this surfaced was already covered by the previous entry's tests). `tsc --noEmit` clean on `apps/web`. Verified live against the exact field from Elliot's own report (`multi`, options `fire/water/air/earth/blood/farts`, default `["farts","fire"]`): deleted the `farts` option and confirmed its pill vanished from Default Value immediately, leaving `fire` still correctly selected -- then Saved successfully with no error (previously failed with the quoted message). Also verified the SINGLE_SELECT side: created a field with one option selected as its default, deleted that option, and confirmed the Default Value dropdown reset to "No default" immediately rather than silently holding the deleted option's value.

## Fixed: deleting an option a test case/suite had selected permanently blocked further edits to that field (2026-09-30)

Elliot reported the same underlying bug as the entry directly above, one layer deeper: the Default Value fix only covered a field's own definition-level default -- deleting an option that a *real test case or suite* had selected still left that entity's stored value naming the deleted option, and the next edit to that field on that entity (even one that never touches the stale selection -- e.g. toggling a *different* MULTI_SELECT pill, which resubmits the full current array) got rejected with `INVALID_FIELD_VALUE: '{option}' is not one of this field's configured options`, effectively locking the field on that entity until someone re-edited the definition.

- **Fix**: `CustomFieldRepository.updateDefinition` (`packages/db`) now prunes stale option references out of every existing `custom_field_values` row for the definition whenever `input.options` is provided, in the same transaction as the options replace -- `SINGLE_SELECT`: a value naming a removed option is cleared to `null`; `MULTI_SELECT`: a removed option is filtered out of the stored array, keeping whatever's still valid (a *partial* prune -- exactly mirroring the Default Value pill toggle's own "keep what's still selected" behavior, not an all-or-nothing wipe). A value unaffected by the removal (references only options that still exist) is left completely untouched. `apps/server/src/routes/customFields.ts`'s `PUT` handler needed no changes -- it already calls `applyDefaultToBlankValues()` right after `updateDefinition()` whenever the field is required, so a value pruned down to fully blank by this fix is immediately re-applied to the field's default in the same request, same as any other blank row.

New tests: 6 new cases in `packages/db/tests/custom_fields.repository.test.ts`'s new `describe('updateDefinition: removing a selected option deselects it from real entity values')` block (SINGLE_SELECT cleared to null / left untouched when unaffected; MULTI_SELECT partial prune / cleared to null when nothing valid remains; TestSuite values pruned the same way, other entities/definitions left alone; a no-op when the update doesn't touch `options` at all). `apps/server/tests/custom_fields_admin_and_values.test.ts` gained 2 end-to-end tests: one reproducing Elliot's exact regression (toggle a still-valid option alongside a since-removed one, confirm `200` instead of the quoted error) and one confirming the SINGLE_SELECT + required-with-default combination (pruning leaves the value blank, and `applied_default_count` in the same response confirms the default was immediately re-applied). `npm test`: 542/545 in this worktree (16/16 in the custom-fields route test file, 35/35 in the repository test file; the usual 3 failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on `packages/db`/`apps/server`. Verified live end-to-end against a real case: set a MULTI_SELECT case value to `["fire","water"]`, deleted the "water" option via the Admin Panel, confirmed a direct API read showed the value already pruned to `["fire"]`, then toggled "air" on for that same case and confirmed the save succeeded (`200`, value `["fire","air"]`) -- the exact edit that previously failed with the `INVALID_FIELD_VALUE` error.

## Added: resizable Suite Tree / Spec-Queue Grid panes (2026-09-30)

Panes 1 (Suite Tree, `280px`) and 2 (Spec/Execution Queue Grid, `420px`) were hardcoded pixel widths; Pane 3 was already fluid (`flex: 1`). Elliot asked how hard resizing would be to add -- investigation found the suite tree and grid components already size fluidly off their parent (`width: '100%'`/`flex: 1`) and their hand-rolled virtualization depends only on height/`scrollTop`, never width, so this was a self-contained `App.tsx`-only change with no other files touched.

- **Roll-your-own, no new dependency** (decided with Elliot over adding a resizable-panels library) -- two new 4px `<div>` dividers inserted as plain flex siblings between the panes (no `position: relative`/offset-math overlay needed). Dragging uses `window`-level `mousemove`/`mouseup` listeners added on `mousedown` and removed on `mouseup` (a fast drag outruns a thin element, so page-level tracking is required, not an `onMouseMove` on the divider itself), plus an unmount-safety `useEffect` cleanup.
- **Clamping**: Suite Tree 200-480px, Queue Grid 260-600px, plus a dynamic `window.innerWidth`-based floor so Pane 3 never drops below 360px even with both dividers dragged toward each other -- recomputed fresh on every `mousemove` tick, so it also adapts if the window itself is resized between drags.
- **Not persisted** -- widths reset to the 280px/420px defaults every session/reload, per direct request (no new localStorage key; this app's only existing localStorage usage is the auth token).
- Divider idle color matches the border it replaces (`#1f2937`, so the layout looks unchanged at rest); hover/drag color reuses the existing blue accent (`#3b82f6`) already used for the active `workspaceMode` toggle and selected-row borders elsewhere in this file, not the cyan reserved for the Execution-mode active-suite highlight.

No new automated tests (pure client-side layout/interaction, no new backend surface). `tsc --noEmit` clean on `apps/web`.

## Fixed: Suite Tree rows shifted on resize; Spec-mode version badge shrunk to a colored box (2026-09-30)

Two more requests from the same session as the resizable-panes feature above.

- **Suite Tree no longer reflows on resize.** Previously each row used `overflow: hidden`/`textOverflow: ellipsis` to shrink long names as the pane narrowed -- since sibling rows truncate at different points depending on their own name length, this made buttons/indicators land at inconsistent x-positions row to row as the divider was dragged (the reported "suites... not aligned"). `VirtualizedSuiteTree.tsx` now never truncates or wraps a name (`whiteSpace: nowrap`, no ellipsis, `flexShrink: 0` on the name/icon group) -- a name or a deep subtree that doesn't fit widens the row instead, and the container (`overflow: 'auto'`, was `overflowY` only) grows a horizontal scrollbar rather than reflowing anything. Each row is wrapped in an inner `width: 'fit-content'; minWidth: '100%'` sizer so every row's own box spans the full scrollable width (not just its own content's width) -- required for the next part to work correctly for short-named rows too, not just the widest one.
- **Action buttons/indicators (the plan-inclusion toggle, +/✏️/🗑️, and the Execution-mode pass/fail pill) are now pinned to the pane's right edge via `position: sticky; right: 8px`**, regardless of horizontal scroll position, per direct request ("buttons... should always remain visible"). `marginLeft: 'auto'` gives it its resting position at the end of the (now full-width) row; an opaque `backgroundColor` matching the pane's base color masks the row's own name text sliding underneath it as the tree scrolls horizontally.
- **Specification pane's version badge is now a small solid-colored box** (10x10px) instead of a wide text pill (`SpecCaseListGrid.tsx`) -- green for `APPROVED`, grey for `DRAFT` (plus blue for `IN_REVIEW`, red for `DEPRECATED`, an empty outlined box for no version yet), matching the exact ask; the full status is still available via the existing hover tooltip. Frees ~54px per row, which goes straight to the case title column.

No new automated tests (pure client-side layout/styling, no new backend surface). `tsc --noEmit` clean on `apps/web`.

## Removed: the "DB VERIFICATION STATS" footer from the Suite Tree pane (2026-10-01)

Elliot questioned whether this was still needed -- it wasn't. `App.tsx`'s Pane 1 footer showed a raw "Immutable Executions" / "Audit Logs" row count, fetched via `verifyDatabase()` (`GET /api/v1/executions/verify`, no auth, no pagination -- it returns every execution/step/audit-log row in the database) on mount, after every verdict submission, and after login. It was a debug/dev-verification leftover from an early slice with no real end-user purpose, and nothing else in the frontend read `dbVerification`.

Removed the footer JSX, the `dbVerification` state, `verifyDatabase()` itself, and all three call sites (mount effect, `submitVerdict`'s success path, login success) -- a verdict submission no longer fires an extra whole-database-dump fetch just to refresh a count nobody was looking at. The backend route itself (`GET /api/v1/executions/verify`, `apps/server/src/server.ts`) is untouched -- it's still exercised directly by `apps/server/tests/core_loop_e2e.test.ts` to assert the immutable audit trail end-to-end, which is a real, independent use of the same endpoint.

No new automated tests (pure UI removal, the one real consumer of the backend route is an existing test, unaffected). `tsc --noEmit` clean on `apps/web`.

## Added: search & filter for suites/cases in both modes, fully API-driven (2026-10-01)

Elliot asked for a search box plus filters you add one at a time (pick a property, then its value, e.g. a custom MULTI_SELECT field and the options to match), in both Spec and Execute mode, light on the system and fully usable over the API. Found along the way: `App.tsx` already had a `searchQuery` state and a `/` hotkey focusing `searchInputRef`, but no input was ever rendered, so both did nothing; and `TestCaseQueueGrid` filtered its rows internally while `selectedIndex` still indexed the *unfiltered* `workspace.cases` -- a latent wrong-row-selected bug the moment any filter applied.

- **One evaluator, on the server.** New `packages/core/src/case-filter/` (`validateCaseFilterRequest`, `matchesCase`, pure): field keys `priority`/`execution_type`/`version_status`/`in_plan`/`verdict`/`cf:<defId>`/`suite_cf:<defId>`; ops `any_of`, `all_of` (MULTI_SELECT), `contains` (TEXT), `eq`/`gte`/`lte`/`between` (NUMBER/DATE), `is` (CHECKBOX/`in_plan`), and `is_empty`/`is_not_empty` for anything. Filters AND together; `q` matches external id or title. A `suite_cf:` filter matches if the case's own suite **or any ancestor** satisfies it. Every validation error names its `filters[i]` index.
- **Routes**, `apps/server/src/routes/caseSearch.ts` (`SPEC_VIEW`-gated, nested under `:projectId`, so API tokens and project overrides work): `GET .../case-search/fields` (the catalog: built-ins plus visible TestCase/TestSuite custom fields with options) and `POST .../case-search` (`{q, filters, plan_id?, build_id?}` → `{case_ids, suite_ids, total_cases}`; `suite_ids` includes every ancestor of a match). Fixed query count per request -- custom-field values, plan links, and latest verdicts are each loaded only when a filter needs them. 400 `INVALID_FILTER` for bad filters / `in_plan` without `plan_id` / `verdict` without `build_id`; 404 for a plan/build from another project.
- **Frontend**: new `CaseFilterPanel.tsx` in Pane 1 under the Execute/Spec toggle -- search input (now wired to `/`), "+ Filter" rows (`[property ▾] [value] [×]`, value control per type: pills, an any/all switch for MULTI_SELECT, text, min–max range, yes/no), "N of M cases", "Clear". Session-only. A row with no value yet is not sent; a row not applicable in the current context (Verdict in Spec mode, no plan/run selected) stays on screen dimmed rather than being deleted. App sends a debounced (250ms) request guarded by `caseSearchRequestSeq`, re-evaluated when `specData`/`workspace` change or after a custom-field value save (`filterDataTick`), and **narrows its already-loaded data to the returned ids** -- the existing spec-tree/plan-cases fetches are untouched. The tree is pruned to `suite_ids`. Filtering was removed from both grids, so it lives in exactly one place: Execute mode maps between "visible position" and `workspace.cases` index (`visibleCaseIndices`) for the grid, `j/k`, verdict auto-advance, the Pass/Skip buttons, and Ctrl+Enter's next-folder jump. A selected case/suite that a filter hides stays selected (Pane 3 keeps showing it); only the lists narrow. The panel stops Ctrl/Cmd+Enter from propagating, since the hotkey engine would otherwise treat it in any input as "submit notes and record a verdict".

New tests: `packages/core/tests/caseFilter.test.ts` (12), `apps/server/tests/case_search.test.ts` (7). `npm test`: 561/564 (the usual 3 failures confined to `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on all four workspaces. Both routes smoke-tested with curl against the live dev server; UI verification handed to Elliot.

Follow-up the same day: every custom-field filter row (case or suite field) now has a "(no value)" pill that sends `is_empty` -- the only way to find cases where an optional field was never filled in (an option pill, a range or `contains` can't match a blank, and a CHECKBOX's "never set" is distinct from an explicit `false`). It's exclusive with the regular value: picking it clears the value (text/number/date/checkbox inputs are replaced by the pill), and picking an option pill switches back out. Not offered for built-ins, which always have a value, nor (per direct request) for CHECKBOX fields, whose filter is just Yes/No. `is_not_empty` stays API-only, and `is_empty` on a CHECKBOX still works via the API.

Second follow-up: dropped the "Suite: " label prefix from suite fields in `GET .../case-search/fields` (the picker already groups them under "Suite fields"; `source` says it for API callers). Fixed suite CHECKBOX filtering, reproduced against live data: a box that was never set has **no value** (null), not `false` -- and that's every case/suite created while the field's default is unchecked, since the Admin Panel saves an unchecked default as no default (`default_value: null`), so `seedDefaultValueForAllEntities` seeds nothing and `getValuesForEntities` reads null. (Explicitly unticking in `CustomFieldEditor` does send and store a real `false`; an earlier draft of this note wrongly said unticking stored null.) "No" only matched explicit `false`, so it missed every never-set box. A CHECKBOX `is` filter now treats null as "No" (it displays unticked), for case and suite fields alike; `is_empty` still distinguishes unset from explicit `false` via the API. Suite CHECKBOX filters also no longer inherit from ancestors -- every suite shows a definite ticked/unticked box, so inheriting made a child that visibly shows unticked still match "Yes" through a ticked parent; every other suite field type still inherits. And when **only** suite filters are active (no text search), a suite matching on its own values is included in `suite_ids` even if it has no cases, so an empty unticked suite still shows under "No".

Not built: no searching summary/preconditions/step text (decided: ID + title only; suite names were added 2026-10-06).

## Changed: DRAFT version indicator is an outline, not a fill (2026-10-01)

Per direct request: in `SpecCaseListGrid.tsx`'s case list, the grey solid DRAFT square was hard to tell apart from APPROVED's solid green at a glance. DRAFT now renders as a 1.5px grey (`#9ca3af`) outline; APPROVED/IN_REVIEW/DEPRECATED stay solid fills, and "no version" stays the dimmer `#374151` outline. Both outlined boxes gained `box-sizing: border-box` so every indicator is exactly 10x10px. `tsc --noEmit` clean on `apps/web`; visual check handed to Elliot.

## Changed: approving a draft re-pins ACTIVE plans to it, so Execute mode shows the last approved version (2026-10-01)

Elliot reported draft changes showing in Execute mode. Reproduced via the API rather than assumed: a plan's case content (summary/preconditions/steps) was already pinned per plan (`test_plan_cases.test_case_version_id`), and Execute mode kept showing approved v1 while v2 was a draft. What Elliot actually saw (confirmed on retest) were the **unversioned** fields -- the title (deliberately unversioned, editable any time) and custom field values -- not version content. The real gap found alongside: approving a draft never moved any plan's pin, so Execute mode kept showing v1 forever, never the new approved version (`TestPlanRepository.updateCaseVersionPin` existed but nothing called it).

- New `TestPlanRepository.repinCaseInActivePlans(caseId, versionId)`: one UPDATE moving every pin of that case in an **ACTIVE** plan onto the given version. LOCKED/ARCHIVED plans keep their pin. Executions are untouched -- they reference the plan-case row and the old version's steps, which are never deleted.
- `POST .../test-case-versions/:versionId/approve` (`specEditing.ts`) now runs the status change and the re-pin in one transaction, and returns `repinned_plan_count` (also in the `CASE_VERSION_APPROVED` audit diff). Auto-approve-on-create needs nothing (a brand-new case isn't in any plan yet).

**Decided with Elliot: custom fields stay as they are.** Custom field values are unversioned on the backend (by the original custom-fields design) while the Spec-mode UI only lets you edit them while the case is a DRAFT -- so an edit goes live in every plan immediately, survives an abandoned draft, and isn't recorded on executions. Raised explicitly with the alternatives (make them editable any time, or version them per case version); Elliot chose to leave the current behavior. Don't "fix" this unprompted.

New test: `apps/server/tests/spec_editing.test.ts` (+1 -- draft v2 doesn't leak into Execute mode, approving re-pins the ACTIVE plan to v2 with v2's summary/steps, a LOCKED plan stays on v1). `npm test`: 563/567 -- the usual 3 failures in `.claude/worktrees/vigilant-haslett-05b0d0/` plus a load-related timeout in `batch_and_xml.test.ts` that passes 22/22 in isolation. `tsc --noEmit` clean on `packages/db`/`apps/server`.

## Changed: case/suite title fields fill their row; case priority/type moved to their own line (2026-10-01)

Per direct request, `App.tsx`'s Spec-mode detail pane. The case header's left block is now two rows: row 1 is the external id plus the title input, which stretches (`flex: 1; minWidth: 0`) all the way to the right-hand action buttons (Edit/Delete) instead of sitting at a fixed `minWidth: 200px`; row 2 is always its own line, holding priority, execution type, the version badge, and Approve. The Suite Details name input likewise stretches across its whole row (was `minWidth: 240px`). Layout only. `tsc --noEmit` clean on `apps/web`; visual check handed to Elliot.

## Changed: version lifecycle is now DRAFT / APPROVED / DEPRECATED -- dropped IN_REVIEW, added Deprecate and Restore (2026-10-01)

Elliot asked how to set a case to "In Review" or "Deprecated"; there was no way (the status column accepted both, `SpecCaseListGrid` even colored them, but the only status-changing route was DRAFT -> APPROVED). Decided with him: **IN_REVIEW removed entirely** (never written anywhere, so no data migration) -- dropped from `TestCaseVersionRepository`'s status unions, `caseSearch.ts`'s `version_status` options, the grid colors, and the `types.ts`/export-types comments.

- **New routes** (`specEditing.ts`, `SPEC_APPROVE`-gated like approve): `POST .../test-case-versions/:versionId/deprecate` (APPROVED -> DEPRECATED) and `.../restore` (DEPRECATED -> APPROVED). Both act only on the case's latest version (422 `VERSION_NOT_LATEST` otherwise) and only from the right source status (422 `VERSION_NOT_APPROVED`/`VERSION_NOT_DEPRECATED`) -- a DRAFT can never be deprecated, or Restore would turn never-reviewed content into APPROVED. Restore runs `repinCaseInActivePlans` in the same transaction. Audit rows `CASE_VERSION_DEPRECATED`/`CASE_VERSION_RESTORED`.
- **Editing a deprecated case is blocked**: create-draft returns 409 ("restore it before editing"), and the Edit button only ever shows for APPROVED -- otherwise a new draft would silently un-deprecate it.
- **Plans**: fixed `resolveCaseLinkability`, which returned `allowDraft` for any non-APPROVED status -- with `allow_draft_plan_linking: true`, a DEPRECATED case would have been linkable. DEPRECATED is now never linkable (also covers `batchExecution.ts`'s auto-link). Plans already containing the case keep it, with its run history, and it executes normally.
- **Hidden by default**: `GET .../spec-tree` omits cases whose latest version is DEPRECATED -- from the case list *and* the tree's `total_case_count`/`in_plan_count` -- unless `?include_deprecated=true`. The frontend's new "Show deprecated" pill (`CaseFilterPanel` footer, Spec mode only, session-only `showDeprecated` state in `App.tsx`) feeds that param through `refreshSpecTree`. Shown deprecated rows have **no** status box (an invisible same-size placeholder keeps id/title aligned) and are dimmed. Deprecating with the toggle off shows a toast saying where the case went, since it leaves the list and the detail pane.
- **The lifecycle button**: Elliot picked a split button, but with IN_REVIEW gone every status has exactly one next step, so it's a single context button in the Approve slot: DRAFT "✓ Approve" (unchanged), APPROVED "Deprecate" (muted red outline), DEPRECATED "↺ Restore" (grey outline). `handleVersionTransition` mirrors `handleApproveVersion` (incl. `handleAuthExpiry`).

New tests: `apps/server/tests/spec_editing.test.ts` (+3 -- full round trip incl. 409 on editing while deprecated and spec-tree hiding/counts with and without `include_deprecated`; draft/non-latest 422s and a Tester's 403; not linkable even with draft linking allowed). `packages/db/tests/repositories.test.ts` switched its one `IN_REVIEW` fixture to `DEPRECATED`. `npm test`: 567/570 (the usual 3 failures in `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on all four workspaces; UI verification handed to Elliot.

## Added: selecting a suite in Execute mode narrows the queue to that suite (2026-10-01)

Per direct request, `apps/web/src/App.tsx`. New `execSuiteFilterId` state, deliberately separate from Spec mode's `selectedSuiteId` (which also drives Pane 3's Suite Details), so browsing suites in one mode never silently narrows the other. In Execute mode, clicking a suite lists only that suite's own cases (direct cases, same rule as Spec mode's list); clicking it again -- or the new "📁 <suite> ✕" chip in the queue header -- shows everything again. Selecting a suite whose cases don't include the active case jumps to that suite's first case. Reset on project switch.

- `queueCaseIndices` (search/filter result narrowed to the suite) is what the grid and `j/k` now work against; the search/filter-only `visibleCaseIndices` and suite-tree-order `executionCaseOrderByCaseIndex` are unchanged.
- **Finishing a suite flows into the next one**: new `advanceToCase(target)` moves the active case and, when the queue is narrowed and the target is in a different suite, moves the suite selection with it. Used by Ctrl+Enter (already suite-order), the Pass/Skip buttons (`nextVisibleCaseIndex` now falls back to `crossSuiteNextCaseIndex` -- the next case in suite-tree order outside the current suite), and the `p`/`s` hotkeys via a new `useHotkeyEngine` option `onAdvancePastEnd`, called instead of doing nothing when a rapid verdict lands on the list's last case.
- Empty-state message when a selected suite has none of its cases in the plan.

No new automated tests (client-side selection/navigation, consistent with how this area has been verified). `tsc --noEmit` clean on `apps/web`; web tests 56/56. Manual verification handed to Elliot.

## Added: Close Run / Open Run, auto-close when every case has a result; fixed verdicts going to the wrong run (2026-10-02)

Per direct request. The server already refused executions on a `CLOSED` build (`server.ts`'s single route and `batchExecution.ts`, 422 `BUILD_CLOSED`) and already had `PUT .../plans/:planId/builds/:buildId` (`BUILD_MANAGE`) to change a run's status -- what was missing was any way to close one from Execute mode, auto-closing, and honoring "closed" in the UI.

- **Auto-close**: new `BuildRepository.closeIfComplete(buildId)` closes the build once every case in its plan has at least one execution in it (no-op if already closed or the plan has no cases). New `apps/server/src/buildAutoClose.ts` (`autoCloseBuildIfComplete`) runs it after both execution routes record, writes a `BUILD_AUTO_CLOSED` audit row when it fires, and both responses now carry `build_status` (`BatchExecutionResponse.build_status` added in `packages/core`). Reopening an already-complete run and recording another result closes it again straight away -- that's the rule as stated ("when all the test cases have results, the run closes").
- **UI** (`App.tsx`, `CaseFilterPanel.tsx`): a "Close Run"/"Open Run" button next to "+ Filter", Execute mode only, gated on `BUILD_MANAGE` (`hasBuildManagePermission`; disabled with a tooltip otherwise), calling the existing PUT route. While the selected run is `CLOSED` (`isRunClosed`): `submitVerdict` refuses with a toast, the four verdict buttons are dimmed and guarded, the Notes field is disabled, and the hotkey engine blocks `p/f/b/s` and Ctrl+Enter via a new `useHotkeyEngine` option `blockVerdictsReason` (j/k still work). When a recorded result auto-closes the run, the dropdown entry flips to closed and a toast says so.
- **Run dropdown label**: no more `[OPEN]`; only a closed run gets a suffix, `[CLOSE]` (Elliot's exact wording).
- **Fixed a real bug found while wiring this**: `submitVerdict` posted `build_id: workspace.build.id`, but `refreshExecutionWorkspace` always sets `workspace.build` to `builds[0]` (the plan's newest run) regardless of the dropdown -- so with an older run selected, results were displayed for that run but **recorded against the newest one**. It now posts `selectedRunId` (falling back to `workspace.build.id`).
- **Noticed, fixed next**: `submitVerdict` sent a fabricated random `execution_duration_ms` -- see "Changed: manual test execution is no longer timed" below.

New tests: `apps/server/tests/run_close.test.ts` (2 -- batch-all-but-one stays OPEN, the last single result auto-closes with an audit row, further results 422, reopen allows recording again; a manually closed run blocks results and a Tester gets 403 opening/closing). `npm test`: 569/572 (the usual 3 failures in `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on all four workspaces; UI verification handed to Elliot.

## Changed: auto-close is once-only; "[CLOSED]" suffix; results blocked when there's no run (2026-10-02)

Follow-ups to the entry directly above, per direct request:

- **Auto-close fires only the first time a run becomes complete.** `autoCloseBuildIfComplete` (`apps/server/src/buildAutoClose.ts`) now skips if a `BUILD_AUTO_CLOSED` audit row already exists for the build -- a run that auto-closed and was then reopened to change a result is never auto-closed again. The immutable audit row doubles as the once-only marker, so no schema change was needed. (Supersedes the previous entry's "reopening a complete run and recording again closes it again" note.)
- **Dropdown suffix is `[CLOSED]`**, not `[CLOSE]`.
- **No run, no results**: in Execute mode with no run selected (the plan has none), a yellow warning banner (the same amber style as "No test plan set") reads "Create a test run to record test execution.", and recording is blocked the same way a closed run is -- `App.tsx`'s new `verdictBlockReason` (`NO_RUN_MESSAGE` or `RUN_CLOSED_MESSAGE`) now drives the verdict buttons, Notes, `submitVerdict`, and the hotkey engine's `blockVerdictsReason`. `submitVerdict` posts `selectedRunId` only, dropping the `workspace.build.id` fallback (which was a fake placeholder id when no run existed).
- **Removed the "run was closed" toast** on auto-close; the dropdown entry still flips to `[CLOSED]`.

`apps/server/tests/run_close.test.ts` extended: after reopening a run that already auto-closed, recording another result leaves it `OPEN` and no second audit row is written. `tsc --noEmit` clean on `apps/web`/`apps/server`.

## Changed: manual test execution is no longer timed (2026-10-02)

Per direct request ("get rid of the time tracking/reporting completely for manual test execution"), following the finding flagged in the Close Run entry above: `App.tsx`'s `submitVerdict` sent `execution_duration_ms: Math.floor(Math.random() * 800) + 200` on every UI verdict -- a fabricated duration that made Reports' "Slowest" table noise for manually executed cases.

- `submitVerdict` no longer sends any duration.
- `POST /api/v1/executions` (`server.ts`, the single-result route the UI uses) now always stores `execution_duration_ms: null`, ignoring any supplied value, and `execution_duration_ms` was dropped from its body type. Durations come only from automated results via the batch route (`batchExecution.ts`, unchanged), which is all the "Slowest" ranking now reflects.
- `ReportingModal.tsx`: the column is labeled "SLOWEST (AUTOMATED)" with a tooltip explaining manual execution isn't timed; empty state reads "No automated results with durations yet." Flakiness is unaffected (it's verdict-based, not time-based).

New test: `apps/server/tests/reports.test.ts` (+1 -- the manual route stores null even when a duration is sent). `core_loop_e2e.test.ts` still sends durations to the manual route; harmless now (ignored, never asserted). `tsc --noEmit` clean on `apps/server`/`apps/web`.

## Changed: no sample projects on startup; real Project create/edit/delete (2026-10-05)

Elliot no longer wants the sample suites/cases/projects/plans/runs. Removing them exposed that **projects couldn't really be created** -- `EntityManagementModal`/`handleSaveEntity`'s PROJECT branch was the last client-only mock (the long-flagged gap below), so an empty database would have had no way to add one. Decided with Elliot: build real Project CRUD, keep the dev test users.

- **Seeding** (`apps/server/src/server.ts`): the core-loop sample project (SHOP suite/10 cases/plan/run) is seeded only when `NODE_ENV=test` (the test suite builds on its fixed ids via `serverInstance.seed`) or `SEED_SAMPLE_DATA=true`; otherwise `seed` is `null` and a dev/real server starts with **no projects**. `seed_dev_fixtures.ts` no longer creates the BANK/ADMN projects -- only the six role users and `override_tester`'s permission override; `project_admin` lost its per-project Admin role (no project to attach it to; assign one in the Matrix tab). The legacy `GET /api/v1/workspace` (hardwired to the sample project) now 404s when it isn't seeded, and the execution route's `EXECUTION_RECORDED` audit row now uses the run's real project instead of the hardwired `seed.projectId`.
- **New routes** (`apps/server/src/routes/projects.ts`): `POST /api/v1/projects` (`PROJECT_CREATE`; name required; prefix required, normalized to uppercase, `^[A-Z][A-Z0-9]{0,9}$`, unique -> 409), `PUT /api/v1/projects/:projectId` (`PROJECT_CREATE` -- the registry has no edit key; name/prefix/description; the **prefix is locked once the project has cases**, since it's part of their external ids -> 409), `DELETE /api/v1/projects/:projectId[?force=true]` (`PROJECT_DELETE`). Each writes a `PROJECT_CREATED`/`UPDATED`/`DELETED` audit row.
- **Delete** follows the plan/run warn-then-confirm shape: new `ProjectRepository.getContentCounts`/`deleteWithForce` (`packages/db`). Without `force`, a project with any suites/cases/plans/runs is untouched and `sendProjectInUseError` (409 `PROJECT_IN_USE`, `errors.ts`) names the counts. With `force`, one transaction deletes, in RESTRICT-safe order: executions (steps cascade) -> runs -> plan links (incl. any link to this project's cases) -> plans -> custom field values on its cases/suites and its project-scoped field definitions -> cases (versions/steps cascade) -> suites (`parent_suite_id` is RESTRICT, so the tree is detached first) -> the project (role assignments, permission overrides, API tokens cascade). Audit rows stay.
- **Frontend** (`App.tsx`): `projectsList`/`plansList` start empty (they used to start from fake placeholder projects/plans that never existed); `loadProjects` applies the real list even when empty; with no project, plans and the spec tree clear. ➕/✏️ call the real routes; 🗑️ now deletes directly via `handleDeleteProjectClick`, showing the same yellow "Confirm Deletion" banner as plans/runs (`deleteProjectPrompt`) when the project has content. `EntityManagementModal` validates the prefix client-side and no longer defaults it to `TLS`.

New tests: `apps/server/tests/projects_crud.test.ts` (4 -- create/normalize/validate/unique prefix; rename + prefix lock once cases exist; blocked-then-forced delete of the seeded project including a recorded result, verifying every child table is emptied and the audit row written; empty project deletes immediately, Tester gets 403). `npm test`: 574/577 (the usual 3 failures in `.claude/worktrees/vigilant-haslett-05b0d0/`). `tsc --noEmit` clean on all four workspaces. Verified live: a fresh dev server lists zero projects, the fixture users still log in, and the app renders its empty state after login with no failing requests.

## Fixed: imports over ~750 KB failed with "Unexpected end of JSON input" (2026-10-05)

Elliot hit this importing TestLink suites. The import wizard sends the file base64-encoded inside a JSON body (~1.33x the file size), and Fastify's default 1 MB `bodyLimit` rejected it mid-upload. The Vite dev proxy logged `EPIPE` and returned an empty 500, and `ImportWizardModal.tsx` then called `res.json()` on the empty body. Fixed both ends: `POST /api/v1/imports/dry-run` and `/execute` (`apps/server/src/routes/ingestion.ts`) now set a route-level `bodyLimit` of 140 MB (`IMPORT_BODY_LIMIT_BYTES`, sized to the existing 100 MB multipart file limit plus base64 overhead), and the wizard parses replies via `readJsonResponse` (empty/non-JSON -> `{}`) with `describeFailedResponse` producing a readable message (413 -> "The file is too large to import.", 5xx -> the status). New test in `batch_and_xml.test.ts`: a ~2 MB auto-detected TestLink XML dry-run returns 200.

## Added: import can create new single-/multi-select fields, with options taken from the file (2026-10-05)

Per direct request: an unmapped import column (e.g. TestLink's `automationStatus`, samples "N/A, No, Done, To Do") can now be created as a `SINGLE_SELECT` or `MULTI_SELECT` field -- previously both were disabled under "Create New" for lack of an options editor.

- **Options come from the file.** New `packages/core/src/ingestion/importFieldValues.ts`: `collectImportFieldOptions(suites, key, type)` returns every distinct non-empty value for the column across the whole parsed tree (case-insensitive key, first-seen order, trimmed); `MULTI_SELECT` first splits each value on commas via `splitMultiSelectValue`. `ingestion.ts`'s execute `AUTO_CREATE` passes these as the new definition's options.
- **Values are converted to match.** At execute time a `fieldTypeByDefId` map (every visible definition, so this also covers routing to an *existing* field) splits a `MULTI_SELECT` column's text into an array and trims a `SINGLE_SELECT` value before `setValue` -- previously routing a text column to an existing multi-select failed validation for every value.
- **Preview**: dry-run's `UnmappedCustomField` gained `distinct_values` (up to `MAX_DISTINCT_IMPORT_VALUES` = 200) and `distinct_values_truncated`. `ImportWizardModal.tsx` now offers both select types under "Create New" and lists the options a new field would get (split for multi-select), noting when the preview is capped -- the server always uses every distinct value in the file.

New tests: `packages/core/tests/importFieldValues.test.ts` (3), `apps/server/tests/batch_and_xml.test.ts` (+1 -- dry-run reports the distinct values; execute creates a SINGLE_SELECT with options N/A/Done/To Do and a MULTI_SELECT with ui/api/slow from comma-separated cells, with no skipped values, and a case reads back `'To Do'` / `['slow','ui']`).

## Added: drag-and-drop moving of suites and cases, with Shift/Ctrl multi-select (Spec mode) (2026-10-05)

Per direct request; decided with Elliot: move only (drop *into* a suite, or suites to the top level -- no reordering, since cases have no position column), Shift = range and Ctrl/Cmd = toggle, Spec mode only (`SPEC_EDIT`).

- **Route** `POST /api/v1/projects/:projectId/spec-move` (`specEditing.ts`): `{ suite_ids?, case_ids?, target_suite_id: string | null }`, one transaction, all-or-nothing. 404 for any id outside the project, 400 for an unknown target, cases to the top level (`test_cases.test_suite_id` is NOT NULL), or a suite into itself/its own sub-suite. Normalizes before moving: a selected suite inside another selected suite travels with its ancestor; a selected case whose suite is moving stays in it; already-there items are no-ops. Returns `{moved_suite_count, moved_case_count}`; one `SPEC_ITEMS_MOVED` audit row.
- `TestSuiteRepository.move` now uses a `runInTransaction` helper (same as `CustomFieldRepository`'s) instead of always opening its own transaction, so the route can call it inside one.
- **UI** (`App.tsx`, `VirtualizedSuiteTree.tsx`, `SpecCaseListGrid.tsx`): `specSelectedSuiteIds`/`specSelectedCaseIds` sets with range anchors; a plain click behaves exactly as before and resets the selection to that row; Shift ranges follow visible order (the expanded tree / the case list); a selection lives in one list at a time; Escape, mode or project switch clears it. Native HTML5 drag: dragging a selected row drags the selection, otherwise just that row; suite rows are drop targets (dashed outline on hover), and a "⤒ Move to top level" zone appears at the top of the tree only while suites are dragged. Invalid targets don't `preventDefault`, so the browser shows no-drop. `setDragPayload` is deferred out of `dragstart` (changing the DOM there can cancel the drag), and a window `dragend` listener clears drag state if a virtualized source row unmounted mid-drag. Success toasts "Moved N cases to <suite>" and refreshes the spec tree.

New tests: `apps/server/tests/spec_editing.test.ts` (+3 -- multi-case move; nested parent+child selection moves only the parent and the child's path follows; move to top level; 400s for a cycle, cases to top level and an unknown target; a partly unknown id list moves nothing; Viewer 403). Verified live in the browser: Shift-click highlights a range; a dispatched drag of the selection onto another suite is accepted and sends the move request.

## Reports overhaul, phase 1: one report engine behind a catalog-driven API (2026-10-06)

Elliot expects execution and case writing to become mostly automated/agent-driven, with reports read by QA engineers troubleshooting, by stakeholders, and by agents over the API or MCP. The original reporting feature (2026-09-21 entry above) was four GET routes and four cards that couldn't answer what broke since the last run, since when, with what error, or whether it's flaky. Its "flakiness" counted every verdict change, so a real fix counted as flaky. Planned with Elliot as three phases:
1. Engine + REST (this entry).
2. A full Reports view in the web app, replacing `ReportingModal`.
3. An MCP endpoint built into the API server.

v1 covers run summary + diff, case history, test health, and breakdowns & trends.

- **Result capture.** The batch API accepted `stack_trace` and `runner_info` (commit SHA, CI run id) but threw them away. It also stuffed environment tags into `executions.custom_fields_snapshot`, and the manual route wrote a fabricated `{environment: 'STAGING'}` there.
  - New nullable columns on `executions` (`001_initial_schema.ts`, edited in place): `failure_message`, `stack_trace`, `environment` (JSON), `runner` (JSON: name/run_id/job_name/commit_sha/url) and `source` (`UI` | `API`).
  - New index `idx_executions_case_time`.
  - `BatchExecutionItem` gained `failure_message`; `runner_info` gained `url`. Only known runner keys are kept.
  - `custom_fields_snapshot` is now `'{}'` on both execution routes. The execution-results export reads `environment` instead.
- **Queries** (`ExecutionRepository`). These replace `getLatestExecutionsForPlanAcrossBuilds` (per-build loop), `getAverageDurationByPlanCase`, `getVerdictVolatility` and `TestSuiteRepository.getCoverageByPlan`, all removed:
  - `getFinalResultsForRuns(planId, runIds)`: one query. Window over (run, plan case): latest execution, plus `attempts`/`had_pass`/`had_fail`.
  - `getCaseHistory`: across all plans, keyset-paginated.
  - `getCaseVerdictTimeline`, `getLastExecutedAtByCase`, `getActivity`.
  - `findByProjectWithLatestVersion`'s `latest_version` also carries `updated_at`, used for the draft age.
- **Pure engine** (`packages/core/src/reporting/`, rewritten):
  - `verdicts.ts`: buckets incl. OTHER for RETEST_REQUIRED/KNOWN_ISSUE; pass rate = passed / (total − untested − skipped); completion.
  - `runDiff.ts`: new_failure / fixed / still_failing / not_run / added / removed, plus failing-since.
  - `health.ts`: flip score `(transitions − 1) / (outcomes − 2)`, so a single break or fix scores 0; pass-after-retry; median/slowdown; consecutive failures.
  - `caseHistory.ts`, `breakdown.ts`, `trend.ts`, `csv.ts`.
  - `markdown.ts`: run summary for PR/chat comments.
  - `catalog.ts`: `REPORT_CATALOG` (each report's id, description, params as JSON Schema, formats), `REPORT_DEFINITIONS` (how every number is computed) and `validateReportParams`. The catalog is the single definition that the REST API, the coming MCP tools and the coming UI are driven by.
- **Flaky threshold.** A case counts as flaky at flip score ≥ 0.3, or if it both passed and failed within one run. Decided after seeing demo data: a case that broke for three runs and was then fixed scored 0.17 and was noise in the flaky list.
- **Case filter extracted.** `routes/caseSearch.ts`'s evaluation moved into `apps/server/src/services/caseFilterService.ts` (`fieldCatalog`, `evaluate`). Every report takes the same optional `filter: {q, filters}` as case search. The verdict filter now uses `getFinalResultsForRuns`.
- **Routes** (`routes/reports.ts`, replacing the four old GET routes; `SPEC_VIEW`):
  - `GET /api/v1/projects/:projectId/reports`: the catalog plus definitions.
  - `POST /api/v1/projects/:projectId/reports/:reportId[?format=json|markdown|csv]`: body = params.
  - Errors: 400 `INVALID_PARAMS` names each bad param; 404 for unknown reports or ids from another project.
- **`apps/server/src/services/reportService.ts`.** One method per report, shared with the coming MCP tools:
  - `overview`
  - `run_summary`: compares with the previous run of the plan by default, `compare_to` for any run, `null` for none.
  - `case_history`: takes an id or external id.
  - `plan_trend`
  - `test_health`: flaky / slowest / slowing (≥ 1.2×) / always failing (3+ runs) / stale.
  - `breakdown`: coverage without a run, verdicts per group with one. Groups by suite / priority / execution type / status / tester / case or suite custom field. Multi-select values put a case in several groups. Suite fields inherit like the suite filter.
- **Known simplification.** Run totals use the plan's current case list, so a case added later shows as untested in earlier runs. This is documented in `REPORT_DEFINITIONS`.
- **Fixed a real security gap found while doing this.** A project-scoped API token passed `requirePermission` on *any* project's `/projects/:projectId/...` route (reports, case search, exports, spec editing, plan CRUD...). Only `batchExecution.ts` and `ingestion.ts` checked the token's project, by hand. `authenticateApiToken` (`middleware/auth.ts`) now refuses a token whose bound project differs from the route's `:projectId` / `?project_id` with `403 TOKEN_PROJECT_MISMATCH`, once, centrally.
- **Demo data.** New `apps/server/scripts/report-demo.ts` (`npx tsx apps/server/scripts/report-demo.ts`, `TESTIFY_URL` to override). Through the public API it builds a "Report Demo" project with 12 cases and 8 runs: a regression, a fix, flip-flopping, pass-after-retry, a slowing case, always failing, not run in the latest run, never run, and manual results. It prints the project id and a `SPEC_VIEW`+`EXECUTE_RUN` token. Verified against a throwaway server instance.
- **Docs.** New `docs/reports_api_and_mcp.md` covers the API, definitions, and how to send results that make good reports.

**Tests:**
- `packages/core/tests/reporting.test.ts`: rewritten, 18 tests.
- `packages/db/tests/execution_reporting.repository.test.ts`: rewritten, 5 tests (multi-run window, created_at tie-break, cross-plan pagination, staleness/activity).
- `apps/server/tests/reports.test.ts`: rewritten, 16 tests. A fixed 3-run fixture covers every report incl. Markdown/CSV, filter scoping, explicit/no comparison, 400/404/403/401, token own-project vs. other-project, and result capture. The 3 duration regression tests are kept.
- The `getCoverageByPlan` repository test was removed with the method.

**Results:**
- `npm test`: 594/597. The 3 failures are the usual ones in `.claude/worktrees/vigilant-haslett-05b0d0/`.
- `tsc --noEmit` is clean on all four workspaces.
- The old `ReportingModal` called the removed routes until phase 2 (below) replaced it.

## Reports overhaul, phase 2: a full Reports view replaces the modal (2026-10-06)

Per the plan agreed with Elliot (see phase 1 above), the 960px `ReportingModal` is deleted. **📊 Reports** in the header now switches the app into a full-width Reports view in place of the three panes (`appView: "WORKSPACE" | "REPORTS"` in `App.tsx`). Execute/Spec state is kept for when you come back ("← Back to workspace"), and the header's Project / Plan / Run pickers stay visible as the view's scope.

- **Components** (`apps/web/src/components/reports/`):
  - **Data.** `shared.tsx` has `runReport`, `downloadReportCsv`, the `useReport` hook (refetches on param change, ignores superseded responses), plus formatting and small UI pieces.
  - **`ReportsView.tsx`.** Sidebar with four tabs, a "Limit to cases" filter and "Copy link". Main area for the active tab.
  - **`OverviewTab`.** Active-plan cards (pass rate, verdict bar, new failures / fixed; click one to open its run), KPI tiles, an activity chart (automated vs. by people), and the drafts waiting longest.
  - **`RunTab`.** KPIs, verdict bar, commits/CI links, and a "Compare to" picker (previous run / nothing / any run of the plan). Clickable diff buckets with before → after verdicts. The failures table puts NEW first and shows flaky badges, failing-since, error, and who ran it. "Copy as Markdown" (`format=markdown`) and CSV.
  - **`TrendsTab`.** Plan trend as stacked bars plus a pass-rate line, with a per-run table (new failures / fixed). Breakdown: group by built-ins or any case/suite custom field from the case-search field catalog; "Results of the selected run" vs. "Plan coverage"; chart, table and CSV.
  - **`HealthTab`.** Run window and stale-days controls. Flaky / always failing / slowest / getting slower / stale tables, plus CSV.
  - **`CaseHistoryDrawer`.** Opens from any case in any tab. Stats, then a timeline: verdict, run, plan, version, 🤖/👤 tester, duration, commit + CI link, environment, error/notes, an expandable stack trace, and "Load older results". "Open in Spec" switches to Spec mode with the case selected. Escape closes it.
- **The case filter.** The existing `CaseFilterPanel` is reused as-is (it's controlled) for "Limit to cases". It feeds every report's `filter` param, debounced 300ms. The Overview ignores it, and says so.
- **Shareable links.** The view keeps the URL hash in sync (`#/reports/<tab>?project=&plan=&run=&case=&compare=`, `parseReportsHash` / `buildReportsHash`). Opening such a link starts the app in that view with that scope: `App.tsx` seeds `appView` / `selectedProjectId` / `selectedPlanId` / `selectedRunId` from a module-level `INITIAL_REPORTS_LINK`, and the loaders already keep a valid previous selection. Leaving the view clears the hash.
- **Hotkeys.** `useHotkeyEngine` gained a `disabled` option, set while Reports is open. Otherwise a stray `p` / `f` could record a verdict on a case that isn't even on screen.
- **Charts.** Recharts, dark tooltips (light label text), and the subtle bar-hover fill Elliot asked for earlier.

**Verification:**
- `tsc --noEmit` is clean on `apps/web`; web tests 56/56.
- Checked live against the running dev server (old API, so data calls 404 as expected): a `#/reports/overview` link opens the view after login; tabs switch and the hash follows; "← Back to workspace" returns to Spec mode and clears the hash; no render errors.
- The data-filled views need the API server restarted on the phase 1 code.

## Reports overhaul, phase 3: MCP endpoint built into the API server (2026-10-06)

The third phase of the reports plan (see phases 1 and 2 above): agents can read every report, and look up cases, over MCP, with nothing to install.

- **Transport.** New `apps/server/src/mcp/mcpServer.ts` mounts `POST /mcp`: Streamable HTTP, stateless (a fresh SDK `Server` + `StreamableHTTPServerTransport` per request, `enableJsonResponse`), via `reply.hijack()`. `GET` / `DELETE /mcp` return 405.
  - New dependency: `@modelcontextprotocol/sdk` (`apps/server`). It pulls in its own Express/Hono/zod.
  - The low-level `Server` is used deliberately rather than `McpServer`, so tool input schemas are plain JSON Schema taken straight from `REPORT_CATALOG`; nullable params become `type: [t, 'null']`.
  - The server sends `instructions` explaining the domain and the typical tool flow.
- **Auth.** The same `authenticateRequest` as REST (JWT or `tf_ci_` token; 401 otherwise). Each tool call then checks `SPEC_VIEW` on the project it's asked about:
  - A token must match its bound project.
  - A user goes through `RoleRepository.evaluatePermissions(user, projectId)` (project overrides apply; `SYSTEM_ADMIN` passes).
  - Failures come back as MCP tool errors (`isError`), not HTTP errors.
- **Tools** (all `readOnlyHint`):
  - `list_projects`: only projects the caller can read.
  - `list_plans_and_runs`: archived plans hidden unless asked for.
  - `search_cases`: `CaseFilterService`.
  - `get_case`: latest version, steps, custom fields.
  - `list_report_fields`: the field catalog plus an operator guide.
  - One `report_<id>` per catalog entry, run through the shared `ReportService`. List limits default to 25 for agents; `report_run_summary` also takes `format: "markdown"`.
  - Results are compact JSON text only. No duplicate `structuredContent`, to keep agent context small.
- **ReportService helpers.** `describeCases` and `findCase` (id or external id) were added for the case tools.
- **Docs.**
  - `docs/reports_api_and_mcp.md` gained an MCP section (connect command, tools, example question).
  - `docs/rfc_04_rbac_security_matrix.md` gained threat vector #7, "Aggregate Data Exposure via Reports & MCP". It records what's implemented (per-project `SPEC_VIEW`, central token binding, read-only tools) and the gaps (no rate limiting, report reads not audit-logged). This closes the "worth a 7th entry" note in the 2026-09-21 reporting entry.

**Tests.** New `apps/server/tests/mcp.test.ts` (5 tests):
- 401 without auth; 405 on GET.
- `initialize` returns the server info and instructions.
- `tools/list` has all 11 tools, schemas from the catalog, and every tool read-only.
- A token sees only its own project; `report_run_summary` matches the REST numbers, with Markdown; another project or bad params give tool errors.
- `search_cases` / `get_case` / `list_report_fields` work.
- A user whose role lacks `SPEC_VIEW` sees no projects and gets a tool error.

**Verification.** Also verified over a real HTTP socket with the SDK's own `Client` against a throwaway server instance filled by `report-demo.ts`: 11 tools, instructions, project listing, Markdown run summary.

## Changed: Reports explanations moved into hover bubbles (2026-10-06)

Per direct request, the explanatory text in the Reports view (tab descriptions, section subtitles like "Draft versions not yet approved...", KPI hints like "passed ÷ executed") no longer sits on screen. It appears in a small speech bubble after hovering a title for ~400ms.

- **`InfoTip`.** New component in `apps/web/src/components/reports/shared.tsx`: a bright panel with dark text and a tail pointing at its anchor, placed `bottom` or `right`.
  - It's positioned `fixed` from the anchor's bounding box, so the sidebar and scroll containers can't clip it.
  - Anchors get a faint dotted underline and a `help` cursor, so you can tell they have one.
- **`Section` and `Kpi`** gained an `info` prop. `subtitle` / `hint` are kept for data-bearing text, e.g. "Plan X · open" or "4 automated · 2 by people".
- **Sidebar.** The "Same numbers via the API" footer and the "overview always covers the whole project" note moved into bubbles on the "Reports" and "Limit to cases" labels.

## Fixed: "new failures" / "still failing" toggles in the Run report showed nothing (2026-10-06)

`RunTab.tsx` deliberately skipped those two buckets when expanded (their cases are also in the Failures table below), so clicking "1 still failing ▸" looked broken. Every diff bucket now expands. Failing cases also show their error message and flaky badge. The headings now read "Run: run4" / "Plan: plan2 · open" and "Changes since: run3", per direct request.

## Changed: search also matches suite names (2026-10-06)

Per direct request, the free-text search (`q`) now matches a case's external id, title, **or the name of its suite or any suite above it**. Searching "Login" finds every case anywhere under a Login suite.
- **Empty suites match too.** When every filter is a suite filter (or there are none), a suite whose own or ancestors' name matches is listed in `suite_ids` even with no cases, so an empty "Login / Lockout" still shows in the tree.
- **Case filters still apply.** A case-property filter narrows the suite-name match as usual.
- **Where it lives.** `CaseFilterRecord` gained optional `search_text` (`matchesCase` matches `q` against it). `CaseFilterService.evaluate` fills it with the suite chain's names, so the UI, every report's `filter`, and MCP `search_cases` all get it.
- **Custom field values are deliberately not searched.** Elliot asked for them first, then retracted.
- **Wording.** The placeholder reads "Search ID, title or suite". The catalog and MCP descriptions were updated to match.

Tests: `caseFilter.test.ts` +1; `case_search.test.ts` +1 (parent-name match, sibling excluded, empty sub-suite listed, case filter still applies).

## Added: emailing reports to stakeholders -- scheduled digests and "Email this report" (2026-10-06)

Per direct request. Decided with Elliot:
- Scheduled (daily/weekly) and manual sends; not on run close.
- SMTP settings configured in the Admin Panel.
- Any recipient address; stakeholders don't need an account.
- An outbox that captures every email for dev testing.

An email is one or more **sections**, each a catalog report plus params, produced by the same `ReportService` as the UI/REST/MCP.

- **Data** (`001_initial_schema.ts`, in place):
  - New `report_schedules` table: sections / recipients as JSON; DAILY/WEEKLY + weekday + `HH:MM` + IANA time zone; `only_when_new_run`; `enabled`; `next_run_at`; last status/error/sent-run ids. `project_id` cascades on project delete.
  - New `email_outbox` table: every email sent, captured or failed. `project_id` / `schedule_id` are set to null on delete, so the log survives.
  - SMTP settings live in the previously-unused `system_settings` table, under keys `email.smtp_*`, `email.from`, `app.public_url`. The password is stored as entered (no encryption-key infrastructure yet) and the API never returns it, only `has_password`.
  - Repositories: `SystemSettingsRepository`, `ReportScheduleRepository` (incl. `findDue` and a compare-and-set `claim`), `EmailOutboxRepository` (`packages/db/src/repositories/report_email.repository.ts`).
- **Core** (`packages/core/src/reporting/`):
  - `email.ts`: `renderReportEmail(sections, {projectName, title?, message?, sentBy?})` produces `{subject, html, text}`. Light, inline-styled, table-based HTML (no scripts or images); verdict bars as coloured cells.
    - Renderers for overview / run_summary / test_health / plan_trend / breakdown (`EMAILABLE_REPORTS`). Long lists are capped with "…and N more — see all in Testify".
    - Every user/CI string goes through `escapeHtml`.
  - `schedule.ts`: `nextRunAt` (wall-clock time in the schedule's zone via `Intl` offsets, so it's DST-correct) and `validateScheduleTiming`.
  - `emailAddress.ts`: `parseRecipients` (split, lower-case, dedupe, invalid list, 50 cap).
- **New permission `REPORT_EMAIL`** (registry 18 → 19 keys), held by Admin and Test Lead by default. It's separate from `SPEC_VIEW` because it sends project data outside Testify.
- **Server:**
  - `services/mailer.ts`: `loadEmailSettings`, plus `sendEmail`. With no SMTP host it only captures (`CAPTURED`); with one it sends via **nodemailer** (new dependency, `SENT` or `FAILED` plus the error). Every attempt goes to the outbox. `setTransportFactoryForTests`.
  - `services/reportEmailService.ts`:
    - `ReportEmailService.build` validates each section against the catalog. Links come from `app.public_url` plus the Reports hash format.
    - `resolveScheduleSections`: `latest_run` resolves to the plan's newest run at send time; overview = last 7 days; health / trend = last 10 runs.
    - `sendSchedule`: re-checks the creator is active and still has REPORT_EMAIL + SPEC_VIEW (or SYSTEM_ADMIN) on the project, otherwise FAILED; honors `only_when_new_run` (SKIPPED); writes a `REPORT_EMAILED` audit row.
    - `runDueSchedules(db, now)` claims each due schedule (`UPDATE … WHERE next_run_at = <old>`), so concurrent instances never double-send. `server.ts` runs it every 60s outside tests.
  - `routes/reportEmail.ts` (REPORT_EMAIL, nested under `:projectId`):
    - `POST .../report-emails` (`preview: true` returns `{subject, html}` without sending).
    - Schedule CRUD and `.../send-now`.
    - 400s name the field.
  - `routes/emailAdmin.ts` (SYSTEM_ADMIN): `GET` / `PUT` `/api/v1/admin/email-settings` (password: left out = keep, `""` = clear), `.../test`, `/api/v1/admin/email-outbox[/:id]`.
  - New audit actions were added to `admin.ts`'s `securityActions` allowlist in the same change: `REPORT_EMAILED`, `REPORT_SCHEDULE_CREATED` / `UPDATED` / `DELETED`, `EMAIL_SETTINGS_UPDATED`.
- **Web:**
  - Reports sidebar "✉ Email this report" opens `EmailReportDialog.tsx` (recipients, note, Preview, Send). It sends the current tab's report(s) with the exact params on screen; each tab reports them via `useEmailContext`, e.g. Trends sends plan_trend + breakdown with the chosen group-by.
  - New "Scheduled Emails" Reports tab, `SchedulesTab.tsx`: list with next/last status, Send now / Pause / Edit / Delete, and an editor (sections, plan, weekly/daily, time, time zone with an `Intl` list, recipients, note, "only when there's a new run").
  - New Admin Panel "✉ Email" tab, `EmailSettingsPanel.tsx` (SYSTEM_ADMIN only): SMTP form, app address (pre-filled with the browser's origin), "Send test email", and the outbox with previews.
  - Previews use `EmailPreviewModal`: a sandboxed iframe whose links open in a new tab.
  - App passes `canEmail` (REPORT_EMAIL or SYSTEM_ADMIN) and the plan list to `ReportsView`.
- **Bug found while verifying.** SchedulesTab's request helper sent `Content-Type: application/json` on body-less POST/DELETE, which Fastify 400s ("Body cannot be empty..."). This is the same class as the 2026-09-16 plan-toggle bug; the helper now only sets it with a body.
- **Not built** (documented in docs and the RFC 04 threat model):
  - Sending on run close.
  - Unsubscribe links.
  - Encrypting the SMTP password.
  - Rate limiting beyond the 50-recipient cap.
  - MCP stays read-only.

**Tests:**
- `packages/core/tests/reportEmail.test.ts` (10): DST in New York and London, weekly/daily, escaping of `<script>`/`<img onerror>`, subjects, recipients.
- `apps/server/tests/report_email.test.ts` (7):
  - The password is never returned.
  - Captured, sent and failed via test transports.
  - Preview writes nothing; a send writes the outbox and an audit row.
  - Validation, Tester/Viewer 403, cross-project token 403.
  - Due schedules are sent once and advanced; a stale claim loses.
  - `only_when_new_run` skips; a disabled creator gives FAILED.
- Permission-count tests bumped to 19.

**Verification.** Verified live in the browser: a rendered run-summary email, creating a schedule and Send now (captured), and the Admin Panel Email tab and outbox.

## Fixed: the scheduled-email time zone field only offered one zone (2026-10-07)

`SchedulesTab.tsx` used an `<input list>` + `<datalist>`. A datalist only suggests entries matching what's already typed, and the field was pre-filled with the browser's zone, so the list showed only that one. It's now a `<select>`:
- Your own zone first, then UTC.
- Every zone from `Intl.supportedValuesOf('timeZone')` grouped by region in `<optgroup>`s, with a short fallback list for older browsers.
- A saved zone this browser doesn't list still shows.

## Changed: the email outbox log became a single "Last email" (2026-10-07)

Per direct request (no outbox log):
- **Storage.** The `email_outbox` table is now `last_email` (`001_initial_schema.ts`, in place): one row, replaced by every send. `LastEmailRepository.record` inserts, then deletes every other row; `find()` reads it back.
- **API.** `GET /api/v1/admin/email-outbox[/:id]` became `GET /api/v1/admin/email-last` (`{ email | null }`, with HTML for preview). Send responses return `email` instead of `outbox`.
- **Admin Panel.** The Email tab shows a "Last email" section instead of the table: When / Subject / To / Status, plus Preview and Refresh.
- **Containing long errors** (as asked):
  - The section is a `max-content | minmax(0, 1fr)` grid, and values use `overflowWrap: anywhere`.
  - A failure message sits in its own box (`pre-wrap`, max 160px tall, scrolls).
  - The same wrapping applies to errors in the "Email this report" dialog and the schedules list.
- **Verified live** with a failed send whose 265-character error contained an unbroken 240-character host name: it wrapped within the section, and no horizontal overflow appeared in the modal or page.
- **Wording.** "Captured in the outbox" now reads "Captured, not sent -- no mail server is set up yet (Admin Panel → Email)".

Every send is still recorded in the Security Audit Log (`REPORT_EMAILED`).

## Added: removing an executed test case from a plan retires it -- old runs keep its results (2026-10-07)

Per direct request. Before this, a case with results couldn't be removed from a plan: `executions.test_plan_case_id` references the `test_plan_cases` link with `ON DELETE RESTRICT`, so you got a hard 422 `CASE_HAS_EXECUTIONS`. Now removal **retires** the link instead of deleting it.

Decided with Elliot:
- Old runs keep the case only where it has a result.
- It's read-only from then on.
- Anyone with `PLAN_MANAGE` can do it, after a confirmation.

**Data** (`001_initial_schema.ts`, in place):
- `test_plan_cases` gained `removed_at` / `removed_by`.
- The unique `(test_plan_id, test_case_id)` constraint became a partial unique index, `uq_plan_case_active ... WHERE removed_at IS NULL`. Re-adding a removed case creates a fresh link, a new version of its membership, while the retired link keeps its results.

**The one rule for what a run contains** lives in `ExecutionRepository.getFinalResultsForRuns`:
- Every active link, plus a retired link only in runs where it has a result.
- One row per case per run: if a case was removed and re-added, the link with a result in that run wins, otherwise the active one.
- Rows carry `removed_from_plan`.

The run summary, trend, diff, overview, breakdown-with-run, case-search `verdict` filter (now set for every case the run contains) and the Execute-mode queue all follow it.

**Repositories:**
- `TestPlanRepository.getPinnedCases` / `getPinnedCase` / `updateCaseVersionPin` / `repinCaseInActivePlans` only touch **active** links. Every "is it in the plan" check means current membership; a retired link keeps the version its results were recorded against.
- `removeCases(planId, caseIds, actorId, {force})`:
  - Cases with no results are deleted.
  - Without `force`, cases with results block, and their counts come back (`cases_with_results`, `result_count`, `run_count`).
  - With `force`, they're retired.
- `removeCasesBulk` only hard-deletes active links.
- `BuildRepository.closeIfComplete` counts active links only, so a retired case never holds a run open.

**Server:**
- **Single-case remove:** `DELETE /api/v1/test-plans/:planId/cases/:caseId[?force=true]` returns 409 `CASE_HAS_RESULTS` (`sendCaseHasResultsError`, e.g. "SHOP-12 has 14 results in 3 runs. Remove it from this plan anyway? Those results stay…") until forced. It then retires the link and writes a `PLAN_CASE_RETIRED` audit row, which is on the admin allowlist.
- **Suite cascade remove:** works the same way with `force: true` in the body, and returns `retired`. The old `HAS_EXECUTIONS` skip reason is gone.
- **Execution queue:** `GET /api/v1/test-plans/:planId/cases?build_id=` uses the run rule. It no longer issues a query per case for the latest result, and it adds `removed_from_plan`.
- **Recording is refused for retired links:**
  - `POST /api/v1/executions` returns 422 `CASE_REMOVED_FROM_PLAN`. It now also checks that the plan case belongs to the run's plan at all, which it never verified before.
  - The batch API resolves against active links only and returns a per-item 422 for a case retired from the plan, instead of auto-linking it back.
- The legacy `/api/v1/workspace` query filters retired links.

**Web:**
- Spec-mode case and suite toggles show an amber "⚠️ Confirm Removal" banner with the server's message and "Remove anyway", which retries with force. The banner clears if the plan changes.
- Execute mode: `TestCaseQueueGrid` shows a "REMOVED" tag. A per-case `verdictBlockReason` disables the verdict buttons, Notes and hotkeys, and Pane 3 shows "Removed from plan · read-only".

**Tests:**
- `execution_reporting.repository.test.ts` (+2): block / force / re-add, run membership, auto-close.
- `spec_and_plan_curation.test.ts`: the old 422 test was replaced by a full-lifecycle test (409, retire, audit, old vs. new run, manual and batch refusals, run summary, re-add) plus a cascade test.

**Results:**
- `npm test`: 620/624. All 4 failures are in `.claude/worktrees/vigilant-haslett-05b0d0/`, whose route code now also breaks on the removed `removeCase` method because it resolves `@testify/db` to this repo.
- Verified live: confirm banner → remove → DEMO-2 is "+ Add" in Spec, and still listed with its result, tagged and read-only, in run 1.0.7.

## Changed: Reports say "run", not "build"; no bubble on "Changes since" (2026-10-07)

Per direct request:
- **Run names.** Reports now show run names with the same rule as the header's Run picker: a name starting with "Build" displays as "Run …". The helper is `runLabel` in `reports/shared.tsx`, used in the Run tab title, "Changes since", failing-since, the Overview cards, the trend chart and table, test health and case history.
- **Demo data.** `report-demo.ts` now names its runs "Run 1.0.x".
- **Bubble removed.** The info bubble on the "Changes since" heading is gone.

Also answered (no code change): "Not run this time" only lists cases that **had a result in the compared run** and have none in this one. A brand-new case (untested in both runs) and a case skipped now but untested before both count as "unchanged", so they appear in no bucket.

## Changed: a re-added case can be tested again in older runs; clearer suite-removal toast (2026-10-07)

Per direct request, after testing the retire feature (entry above). A case removed from a plan and then added back used to stay "REMOVED" and read-only in older runs, because their results belonged to the retired link.

`ExecutionRepository.getFinalResultsForRuns` now builds one row per case per run:
- The row shows the case's **latest result in that run from any of its links**.
- It carries the case's **active** link whenever the case is in the plan, so new results are recorded against current membership, even in an old run.
- Only a case that's currently out of the plan is `removed_from_plan` (read-only).
- `attempts` / `had_pass` / `had_fail` combine across the case's links in that run.

`BuildRepository.closeIfComplete` likewise counts a case as covered if any of its links has a result in the run.

The suite-removal toast now reads e.g. "4 removed from the plan (3 keep their results in earlier runs)", or "(all keep their results…)", instead of "4 removed, results kept in earlier runs for 3".

**Tests:**
- The db test now asserts that the old run's row carries the fresh link with the earlier result, and that recording on it becomes the latest result (`attempts` 2, pass+fail).
- The server lifecycle test re-records in the old run after re-adding and checks case history shows both links' results.

**Verification.** Verified live: remove → re-add DEMO2-2. Run 1.0.7 showed it Passed with no REMOVED tag and active buttons; Skip recorded and replaced it as the latest result.

## Fixed: the schema can be applied more than once -- real migration tracking (2026-10-07)

Audit item 1 (`docs/audit_2026-10-07.md`). `createServer` used to call `migration001.up(db)` on every start. That is plain `createTable` with no record of what had run, so against any persistent database the second start crashed ("relation "projects" already exists", reproduced). Schema changes also had no way to reach an existing database, since every change was edited into 001.

- **New `packages/db/src/migrations/index.ts`** wraps Kysely's built-in `Migrator`:
  - `MIGRATIONS` is the ordered registry (today just `001_initial_schema`).
  - `migrateToLatest(db)` runs only migrations not yet recorded in `kysely_migration`, and returns the names it applied.
  - Concurrent starts are serialised by the Postgres advisory lock Kysely takes.
  - It throws a clear error naming any migration that failed.
  - It's exported from `@testify/db`; `server.ts` now calls it instead of `migration001.up`.
- **Adoption of older databases.** A database built by the old startup (all tables, no `kysely_migration`) has 001 recorded as applied, if it matches the current schema (spot-checks `last_email`, `report_schedules`, `test_plan_cases.removed_at`). Otherwise startup stops with "created by an older Testify build ... recreate it".
- **`createServer(connectionString?, { db? })`** can reuse an existing database, so tests can do a real restart. Every startup seed was already idempotent; the restart test now proves it.
- **New convention, replacing the old "edit 001 in place" precedent used by many entries above:** never edit a migration that has shipped. Add `packages/db/src/migrations/00N_<name>.ts` (with `up` and `down`) and register it in `MIGRATIONS`. 001 is frozen as of this entry.

**Tests:**
- `packages/db/tests/migrations.test.ts` (4): fresh build, then two no-op re-runs; adopting a pre-tracking database with its data kept; refusing an incomplete old one; registry order with up/down present.
- `apps/server/tests/server_restart.test.ts` (1): start, create a project, start a second server on the same database. No duplicated users or roles, the project survives, and login still works.

`npm test`: 625/629. The 4 failures are all in the stale `.claude/worktrees/vigilant-haslett-05b0d0/`.

## Fixed: a missing DATABASE_URL no longer silently uses a throwaway database (2026-10-07)

Audit item 2 (`docs/audit_2026-10-07.md`). With `DATABASE_URL` unset the server used to fall back to an in-memory PGlite database without a word, so a deployment that forgot to set it looked healthy and lost all its data on the first restart.

- New `apps/server/src/config.ts` (`resolveDatabaseConfig`, `ConfigError`): `postgres://`/`postgresql://` URLs connect to Postgres; the literal `memory` selects the in-memory database, and is refused when `NODE_ENV=production`; unset, blank or any other value (e.g. a typo) is a `ConfigError` naming what to set. The startup code at the bottom of `server.ts` prints `[testify] <message>` and exits with code 1, before opening any database; with `memory` it prints a warning that data is lost when the server stops.
- `npm run dev --workspace=apps/server` now runs `src/dev.ts`, which sets `DATABASE_URL=memory` only if it's unset and then loads `server.ts`. This keeps local dev zero-setup without an env-var prefix in the npm script, which wouldn't work on Windows. `npm start` (still `tsx src/server.ts`) requires `DATABASE_URL`. `.claude/launch.json` uses `npm run dev`, so it needed no change.
- `createServer(connectionString?)` and `createDbClient()` are unchanged: with no connection string they still use in-memory PGlite. That's the programmatic API the tests use; the strictness lives only in the startup path that reads the environment.

New tests: `apps/server/tests/database_config.test.ts` (5 -- unset/blank refused, Postgres URLs accepted and trimmed, `memory` allowed except in production, non-Postgres values rejected, and a real `tsx src/server.ts` child process with no `DATABASE_URL` exits 1 with the message). Verified: the dev server starts through `src/dev.ts` with the in-memory warning in its log.

## Fixed: no more well-known admin password; the first admin must change a generated one (2026-10-07)

Audit item 3 (`docs/audit_2026-10-07.md`), and item 25 along with it. Every database got an `admin` / `password` user, the login page printed those credentials twice (under the form and in the "Forgot password" dialog), and nothing made anyone change them. Login also called `seedInitialAdmin()` on every attempt.

- **Choosing the first admin's password** (`resolveInitialAdminPassword`, `apps/server/src/config.ts`), used only when the database has no users at all:
  - `ADMIN_PASSWORD` set: that password. It must meet the password policy, otherwise startup stops with a `ConfigError`. Not forced to change, since the operator chose it.
  - In-memory database (`npm run dev`, tests): still `admin` / `password` -- that data is thrown away, and every test logs in with it.
  - Otherwise (a real `DATABASE_URL`): a random 24-character password, printed once in a banner in the server log, and flagged so it must be changed at first sign-in.
- **`UserRepository.seedInitialAdmin({ password, mustChangePassword? })`** has no built-in default any more. New `hasAnyUser()` and `isCurrentPassword()`. Setting a new password through `updateCredentials` clears the flag.
- **Migration `002_password_change_required`** adds `users.must_change_password` (boolean, default false) -- the first migration added under the new tracking rule. The `packages/db` tests now build their schema with `migrateToLatest` instead of running 001 directly, so they get every migration.
- **Enforced on the server**, not just the UI: `authenticateRequest` (`middleware/auth.ts`) answers `403 PASSWORD_CHANGE_REQUIRED` for a user with the flag on every route except `GET /api/v1/auth/me` and `PUT /api/v1/auth/credentials` (this covers MCP and `requirePermission` too; API tokens are unaffected). On that PUT such a user must send a new password (`400 PASSWORD_CHANGE_REQUIRED` otherwise) that differs from the current one (`400 PASSWORD_UNCHANGED`). Login, `/auth/me` and the credentials response include `must_change_password`; the `CREDENTIALS_CHANGED` audit diff records `password_changed`.
- **Login no longer seeds an admin** (audit item 25).
- **Web**: `LoginPage.tsx` lost both credential hints; the form is pre-filled with `admin` / `password` only in the Vite dev build (`import.meta.env.DEV`; new `src/vite-env.d.ts`), never in a production build. New `ForcedPasswordChange.tsx` replaces the whole app while `currentUser.must_change_password` is set (new password + confirm, Sign out), and `App.tsx` doesn't load projects until it's done.

New tests: `apps/server/tests/initial_admin.test.ts` (6 -- the three password sources incl. a weak `ADMIN_PASSWORD`; a flagged user is blocked from `/projects` and MCP but can reach `/auth/me`, can't skip, reuse or weaken the password, then works with the new one and the old one stops working; login doesn't recreate an admin; and a "real database" start prints a generated password that logs in flagged, seeds no dev fixtures, and prints nothing on restart). `packages/db/tests/user_and_rbac.test.ts` +1, `migrations.test.ts` updated for 002. All of this repo's tests pass (`npx vitest run --exclude '.claude/**'`; an earlier draft of this note said 589, which wrongly counted the old worktree's passing tests too); the old `.claude/worktrees/vigilant-haslett-05b0d0` copy now fails 52 (its server calls `seedInitialAdmin()` the old way) -- audit item 35.

## Removed: the unauthenticated `GET /api/v1/executions/verify` route (2026-10-07)

Audit item 4 (`docs/audit_2026-10-07.md`). The route needed no login and returned every execution, step result and audit log row in the database. Nothing in the app used it since the "DB verification stats" footer was removed (2026-10-01); only `apps/server/tests/core_loop_e2e.test.ts` called it. Deleted from `server.ts` rather than put behind a permission -- audit logs are already available to admins through `GET /api/v1/admin/audit-logs`. The test now reads those tables directly (`readExecutionTables`), and a new case asserts the route returns 404. This also covers the `executions/verify` half of audit item 34; the other legacy route, `GET /api/v1/workspace`, is still there.

## Fixed: USER_MANAGE could be used to make yourself (or anyone) an admin (2026-10-07)

Audit item 5 (`docs/audit_2026-10-07.md`). Every admin route only checked `USER_MANAGE`, so anyone holding it could create a role containing `SYSTEM_ADMIN`, give themselves the Admin role, add a `SYSTEM_ADMIN` override, or demote/disable the real admins -- including the last one.

New `apps/server/src/services/adminGuard.ts` (`AdminGuard`, `AdminGuardError`) applies three rules to every change of who-can-do-what in `routes/admin.ts`:

1. **Ceiling** (`403 PERMISSION_CEILING`, lists the permissions): a change can't give anyone a permission the person making it doesn't hold at that scope (global, or the project involved) -- their own account included. Checked up front for the keys in a new/edited role, a role given to a new user, and granted overrides (`assertCanGrant`), and also by comparing every affected user's effective permissions before and after the change, so it holds however a permission arrives (e.g. clearing a deny override, or editing a role that others hold).
2. **Rank**: you can't change a user who has permissions you don't (`403 TARGET_OUTRANKS_ACTOR`) -- status, roles or overrides -- nor edit or delete a role that grants more than you have (`403 ROLE_OUTRANKS_ACTOR`). Your own account is exempt, so lowering your own access still works.
3. **Last admin** (`409 LAST_ADMIN`): no change may leave zero active users holding `SYSTEM_ADMIN` -- disabling or demoting yourself, a deny override, or removing `SYSTEM_ADMIN` from the Admin role.

`AdminGuard.run` does the before/after comparison and the last-admin check inside one transaction and rolls the change back on any violation. That needed `RoleRepository`/`UserRepository` to work on a transaction they're given: both gained the `runInTransaction` helper `CustomFieldRepository` already had (it runs directly on the caller's transaction instead of nesting). New `RoleRepository.getRoleHolders(roleName)` and `hasActiveSystemAdmin()`. A `SYSTEM_ADMIN` holder's ceiling is the whole registry, so admins can still grant anything. Unknown permission keys still get the existing 400 (the ceiling check skips them).

`AdminPanelModal.tsx`'s Activate/Disable toggle used to swallow every error; it now shows the server's message (e.g. the last-admin refusal) in the panel's error banner. The other save handlers already did.

New tests: `apps/server/tests/admin_privilege_guard.test.ts` (4 -- a user manager can't escalate through a SYSTEM_ADMIN role, the Admin role globally or per project, a SYSTEM_ADMIN override globally or per project, creating an admin account, adding keys to their own role, or clearing an admin's deny override on themselves; can't disable, demote or override an admin, or edit/delete the Admin role, but can manage users at their own level; the last admin can't be disabled, demoted, denied SYSTEM_ADMIN or have it removed from the Admin role, and every attempt is rolled back; with a second admin the first can step down; an admin can still grant SYSTEM_ADMIN). 486/486 tests in this repo pass.

## Fixed: project scoping could be bypassed on routes not nested under a project (2026-10-07)

Audit item 6 (`docs/audit_2026-10-07.md`). The API-token project check and per-project permission evaluation both read the project only from `:projectId` / `?project_id`. Routes without one -- `POST /api/v1/executions`, `GET`/`POST`/`DELETE /api/v1/test-plans/:planId/cases[/:caseId]`, the suite cascade, `GET /api/v1/test-cases/:caseId/latest-version`, and the case/suite custom-field-value routes -- therefore let a token for project B read and change project A, and evaluated users' permissions globally, ignoring per-project roles and overrides.

- New `resolveRequestProject(request, db)` (`middleware/auth.ts`), called once by `authenticateRequest` for every request. An explicit project (`:projectId`, `?project_id`, or an import's `target_project_id` in the query or JSON body, or `project_id` in a JSON body) wins; nested routes already check their other ids belong to it. Otherwise the project comes from the ids the route names: `:planId`, `:buildId`, `:caseId`, `:suiteId`, and `build_id`/`plan_id` in the query or JSON body. Ids that belong to different projects get `400 PROJECTS_DIFFER`; unknown ids are ignored (the route then 404s); a request naming no project (e.g. `GET /api/v1/projects`) behaves as before.
- That project now drives both the token binding (`403 TOKEN_PROJECT_MISMATCH`) and `evaluatePermissions(user, projectId)`, so `requirePermission` honours per-project roles/overrides on these routes too.
- Imports: a multipart upload's project field isn't read until the handler runs, so `ingestion.ts`'s dry-run/execute now check `IMPORT_DATA` after resolving the target project, via the new `permissionsInProject(user, projectId, db)` (an API token's capabilities as-is; a user re-evaluated in that project).

New tests: `apps/server/tests/project_scoping.test.ts` (3 -- a project-B token gets 403 on all eight project-A routes and changes nothing, while still working on its own project; a Tester gains plan curation through a per-project Test Lead role and loses result recording through a per-project deny override; a cascade naming a plan and a suite from different projects gets 400). All three fail on the previous middleware. 489/489 tests in this repo pass.

## Fixed: Admin Panel access for non-admin managers; Matrix tab saves as you go; louder "Not permitted" when recording a result (2026-10-07)

Reported: a user with a custom "User Manager" role (`USER_MANAGE`) couldn't manage users. Reproduced against the live dev database: the role existed, but the user had never actually been given it -- the audit log had no `ROLE_ASSIGNED` entry, only a save of that user's (empty) overrides. The Matrix tab had two save buttons in one panel ("Save Privilege Delegation" for the role dropdowns, "Save Overrides" for the grid below), so changing the role and clicking the lower button showed a green "saved" message and silently dropped the role change. A user who really holds `USER_MANAGE` did see and use the panel fine.

- **Matrix tab saves each change immediately** (`AdminPanelModal.tsx`): `saveRoleChange` sends only what changed (`{global_role}` or one `{project_id, role}`, where `""` removes the project role -- removing a project role was never actually sent before) and puts the dropdown back if the server refuses (e.g. an `AdminGuard` rule). Override toggles save the scope's full set on each click through a serialized queue (`overrideSaveQueue`), refetching on refusal. Both save buttons are gone; a line under the heading says changes save as you make them.
- **The panel is no longer `USER_MANAGE`-only**: Test Leads hold `API_TOKEN_MANAGE` by default but had no way to reach the API Tokens tab; same for `CUSTOM_FIELD_MANAGE`. `App.tsx`'s new `hasAdminPanelAccess` shows the button for any of `USER_MANAGE`/`CUSTOM_FIELD_MANAGE`/`API_TOKEN_MANAGE`/`SYSTEM_ADMIN`. Inside, each tab is shown only with its permission (Roster/Matrix/Role Templates/Audit Log: `USER_MANAGE`; Custom Fields: `CUSTOM_FIELD_MANAGE`; API Tokens: `API_TOKEN_MANAGE`; Email: `SYSTEM_ADMIN`), the panel opens on the first tab you can use, and only those lists are fetched. `GET /api/v1/admin/permissions` (just the permission names, used by the token-capability and override grids) now needs only a login instead of `USER_MANAGE`.
- **"Not permitted" is a yellow banner** (`executionDenied` in `App.tsx`, same amber style as "No test plan set", with OK), shown when the server refuses a result (403, e.g. a per-project deny override) or the app blocks a verdict because you lack `EXECUTE_RUN` at all. Cleared on a successful record or a project switch.
- **Fixed: a refused result still showed as recorded.** `submitVerdict` updates the grid before the server answers; on a 403, other error, or network failure it now puts the case's previous verdict and notes back (`revertOptimisticUpdate`), so the counts and the P/F letter match what was saved.

Test: `admin_roles_and_overrides.test.ts` now asserts the permission list is readable by any signed-in user (and not anonymously). 489/489 tests pass. Verified live in a separate browser origin: a Test Lead sees only API Tokens with a populated capability grid; a custom-field-only user sees only Custom Fields; changing a role in the Matrix saves immediately; a Viewer pressing `p` and a Tester with a project-scoped deny both get the yellow banner, and the case stays untested.

## Fixed: read routes only checked login, not SPEC_VIEW; removed the login-free legacy workspace route (2026-10-08)

Audit item 7 (`docs/audit_2026-10-07.md`). These reads accepted any signed-in user, whatever their access to the project: a project's plans, a plan's runs, the spec tree, a case's latest version, a plan's cases (the Execute queue), and case/suite custom-field values. `GET /api/v1/projects` listed every project to everyone.

- **The seven reads now use `requirePermission('SPEC_VIEW')`.** Since every request resolves its project (`resolveRequestProject`, see the 2026-10-07 project-scoping entry), that check is per project: per-project roles and overrides apply, and an API token only reads its own project.
- **`GET /api/v1/projects` lists only projects the caller can read**, via the new `canViewProject(user, projectId, db)` (`middleware/auth.ts`: SPEC_VIEW there or SYSTEM_ADMIN; a token only its own project). The MCP server's private `canView` now delegates to it, so `list_projects` and the REST list agree.
- **Two ownership checks the explicit `:projectId` was hiding:** `GET /projects/:projectId/plans/:planId/builds` never checked the plan belonged to the project (so a caller allowed on A could list B's runs by putting B's plan under A's path), and `GET .../spec-tree?plan_id=` didn't either. Both now 404 for a plan from another project.
- **Removed `GET /api/v1/workspace`**: it needed no login at all and only served the test-only sample project; the app hasn't used it since the per-plan routes existed. `core_loop_e2e.test.ts` now reads the spec tree and the plan's cases instead. This closes the rest of audit item 34's "legacy routes".

New tests: `apps/server/tests/read_permissions.test.ts` (4 -- a role without SPEC_VIEW gets 403 on all seven reads and an empty project list while a Viewer reads them all; a per-project SPEC_VIEW deny hides just that project; a token lists only its own project; another project's plan 404s through this project's path). All four fail on the previous code. `spec_and_plan_curation.test.ts`'s plan-cascade test now expects the 404 for a deleted plan's runs and checks the rows directly (its comment had flagged exactly this ownership gap). 493/493. Full-suite runs on this machine sometimes time out a different heavy test each run under load (they pass alone); the heaviest new test and the migrations test got 30s timeouts.

## Fixed: weak sessions -- real server-side sessions, sign-out ends them, a password change needs the current one (2026-10-08)

Audit item 8 (`docs/audit_2026-10-07.md`). A login token was valid until it expired no matter what: sign-out only cleared the browser (the web app didn't even send the token), nothing could revoke one, a password change left every other sign-in working, and changing the password didn't ask for the current one -- so a stolen token was enough to take the account over.

- **Migration `003_sessions`**: a `sessions` table (`id`, `user_id` → users cascade, `created_at`, `expires_at`, `revoked_at`). New `SessionRepository` (`create`, which also clears that user's expired/revoked rows; `findActive`; `revoke`; `revokeAllForUser(userId, exceptSessionId?)`).
- **Login** (`routes/auth.ts`) creates a session and signs its id into the token as `sid`; token and session share `SESSION_LIFETIME_SECONDS` (1 hour). **`authenticateRequest`** requires a live session matching the token's `sub` and `sid` -- otherwise `401 "this session has ended"` -- and exposes it as `request.user.session_id`. Tokens issued before this change have no `sid`, so everyone signs in once more.
- **Sign-out** (`POST /api/v1/auth/logout`) revokes the caller's session; it always answers 200 (no token or an already-dead one is still "signed out"). `App.tsx`'s `handleLogout` now sends the token.
- **Password change** (`PUT /api/v1/auth/credentials`) needs `currentPassword`: `400 CURRENT_PASSWORD_REQUIRED` / `403 CURRENT_PASSWORD_INCORRECT` (checked before anything changes). On success every *other* session of the account ends (the one making the change stays); the `CREDENTIALS_CHANGED` audit diff records `other_sessions_ended`. Changing only the email/username needs neither and ends nothing. The profile modal (`AuthModal.tsx`) shows a "Current password" field once a new password is typed and says other sessions were signed out; `ForcedPasswordChange.tsx` asks for the current password too. `AuthModal`'s unreachable login form also lost its `admin`/`password` defaults.
- **Disabling a user** (`PUT /admin/users/:id/status`) ends all their sessions, inside the AdminGuard transaction, so re-enabling them doesn't bring old tokens back.
- **Test cleanup**: the `packages/db` tests tore their schema down with 001's `down`, which can't drop `users` now that `sessions` references it. New `migrateDownAll(db)` (`migrations/index.ts`, exported from `@testify/db`) rolls back every applied migration newest-first via Kysely's `migrateTo(NO_MIGRATIONS)`; the tests use it, so every migration's `down` is now exercised.

New tests: `apps/server/tests/sessions.test.ts` (4 -- sign-out ends only that session and is idempotent; a password change needs the right current password, refusals change nothing, success ends the other session but not the caller's, email-only changes end nothing; a correctly signed token with no `sid`, an unknown `sid`, or another user's `sid` is refused; disabling then re-enabling a user leaves their old token dead). The two existing password-change tests now send `currentPassword`. 497/497.

Not done here: there's still no "sign out everywhere" button or a list of your active sessions (the table makes both easy to add), and nothing limits how often the current password can be guessed through this route -- that's audit item 9 (login rate limiting).

## Fixed: no limit on password guessing -- account lockout and a per-address limit (2026-10-08)

Audit item 9 (`docs/audit_2026-10-07.md`). Nothing limited sign-in attempts, so a password could be guessed at full speed; the same was true of the "current password" check added to the password-change form the same day.

- **Per account** (migration `004_login_lockout`: `users.failed_login_count`, `users.locked_until`; `UserRepository.recordFailedLogin`/`resetLoginFailures`): 20 wrong passwords in a row (`ACCOUNT_LOCK_THRESHOLD`; first shipped as 5, raised to 20 the same day per Elliot) lock the account for 15 minutes (`ACCOUNT_LOCK_SECONDS`). While locked, sign-in is refused before the password is even checked -- `429 ACCOUNT_LOCKED` with `Retry-After` and "Try again in N minutes, or ask an administrator to unlock it". The count isn't cleared by the lock expiring, so each further wrong password re-locks; a successful sign-in resets it. Wrong current passwords on `PUT /auth/credentials` count the same way, and a locked account can't change its password either. Each lock writes an `ACCOUNT_LOCKED` audit row (actor `SYSTEM`, with the real `request.ip`).
- **Per client address** (`IpFailureLimiter`, in memory per server process): 50 failed sign-ins in 15 minutes (`IP_FAILURE_LIMIT`/`IP_WINDOW_SECONDS`; raised from 20 alongside the account threshold, and kept above it on purpose -- otherwise someone locking their own account from one address hits the address block first, which an admin's Unlock can't clear), across any usernames, block further sign-in attempts from that address -- `429 TOO_MANY_ATTEMPTS` -- until the oldest failure leaves the window. Attempts against a locked account count too. New `TRUST_PROXY=true` (Fastify `trustProxy`) so this sees the real client behind a reverse proxy rather than limiting everyone behind it together. With several server instances each keeps its own count; the account lock is in the database and shared.
- All of it lives in `apps/server/src/services/loginThrottle.ts` and the login/credentials routes in `routes/auth.ts`.
- **Admin Panel**: `GET /admin/users` returns `locked_until` while a lock is active; the roster shows "🔒 LOCKED" (until-time in the tooltip) and an **Unlock** button. Unlock is `PUT /admin/users/:id/status {status: 'ACTIVE'}`, which now always clears the failure count and lock, logging `ACCOUNT_UNLOCKED` instead of `USER_ACTIVATED` when there was a lock. `ACCOUNT_LOCKED`/`ACCOUNT_UNLOCKED` are on the Security Audit Log allowlist.
- **Login page**: shows the server's message for a 429 instead of the generic "email and/or password are not correct".

New tests: `apps/server/tests/login_throttle.test.ts` (5 -- the limiter's window arithmetic; 20 wrong passwords lock even the right one, the admin sees and clears the lock, both audit rows appear; a success resets the count and an expired lock lets the right password in and resets; wrong current passwords lock the account; 50 failed usernames block the address, even for a correct admin sign-in; the reset test uses a separate `remoteAddress` per phase so the address limit stays out of the way). 502/502.

Known trade-off: an account lock can be triggered deliberately by anyone who knows a username (that's inherent to lockouts); the per-address limit and the 15-minute expiry keep it bounded, and an admin can unlock at once.

## Fixed: server errors exposed internals (2026-10-08)

Audit item 10 (`docs/audit_2026-10-07.md`). Fastify's default 500 reply carried the error message -- for a database failure that's SQL, table and constraint names -- and six routes returned `err.message` in their own 500s (`admin.ts` create user / create role / update role, `customFields.ts` create / update, `auth.ts` credentials). A few catch-all 400s did the same (spec moves, import dry-run/execute, custom-field value saves, import value warnings).

- **The rule** (`errors.ts`): `isPublicError(err)` is true only for a plain `Error` -- what this code throws on purpose with a readable message ("PASSWORD_POLICY_VIOLATION: ...", "Cannot move a suite into itself", a parser's line error). Database driver errors, `TypeError`s and every other subclass are unexpected, and their messages stay in the server log. `publicErrorMessage(err, fallback, request?)` applies it and logs what it hides; `logServerError` writes `[testify] Unexpected error <method> <url> (request <id>): ...` (silent under `NODE_ENV=test`).
- **Global handler** (`server.ts`, `app.setErrorHandler`): an error with a 4xx `statusCode` (Fastify's own -- bad JSON, body too large, ...) keeps its status and message; anything else is logged and answered `500 {error: INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR', request_id}`. The request id matches the log line, so a user's report can be traced.
- **Routes**: the six `err.message` 500s now `throw err` to the handler. The catch-alls keep a message only when `isPublicError`, otherwise rethrow (spec moves in `specEditing.ts`, both import routes, both custom-field value routes); import value warnings use `publicErrorMessage(..., 'Could not save this value')`. Scheduled report emails record a `ReportError`'s message ("run not found" etc.) or a public one, otherwise "Could not build the email (see the server log)" -- that text shows in the schedules list.
- Deliberately kept: SMTP errors stored in "Last email" (visible only to `SYSTEM_ADMIN`, and needed to fix mail settings), `ReportError`s in the reports and report-email routes, and MCP tool errors (only `ToolError`/`ReportError` are returned; anything else already propagated).

New tests: `apps/server/tests/error_handling.test.ts` (4 -- the public/hidden rule; a test-only route hitting a missing table and one throwing a TypeError both get the generic 500 with a request id and none of the details; a real route (`GET .../report-schedules`) after its table is dropped hides the table name and SQL; bad JSON and a password-policy error still explain themselves). The two leak tests fail without the handler. 506/506.

## Fixed: CORS allowed any origin (2026-10-08)

Audit item 11 (`docs/audit_2026-10-07.md`). `createServer` registered `@fastify/cors` with `origin: '*'`, so any web page could read API responses with a token it obtained. Nothing needed it: the web app calls `/api` on its own address (Vite's proxy in development), and API tokens, CI, MCP clients and curl aren't browsers.

- **Default: no cross-origin access** -- the CORS plugin is only registered when `CORS_ORIGINS` lists origins, so a request from another origin gets no `Access-Control-Allow-*` headers and the browser blocks it.
- **`CORS_ORIGINS`** (`resolveCorsOrigins`, `config.ts`): a comma-separated list of exact origins for a deployment that serves the web app from a different address than the API. Entries are trimmed, a trailing slash is dropped, duplicates removed. `*`, a value with a path, a non-http(s) scheme, or something that isn't a URL is a `ConfigError`, so the server won't start with it.
- In development the browser-facing CORS headers you may see on `localhost:3000/api/...` come from Vite's dev server, not Testify.

New tests: `apps/server/tests/cors.test.ts` (3 -- parsing and refusals; by default a foreign origin gets no allow header on a request or a preflight; with `CORS_ORIGINS` set, exactly that origin is allowed and others still aren't). 509/509.

## Fixed: API tokens outlived their issuer's access (2026-10-08)

Audit item 12 (`docs/audit_2026-10-07.md`). A token kept its mint-time capabilities forever (no expiry by default) and kept working after the admin who issued it was disabled or demoted. Decided with Elliot: rather than forcing every token to expire, a token lasts as long as its issuer could still issue it.

- **Bound to the issuer, checked on every use** (`apiTokenIssuerAccess`, `middleware/auth.ts`, called from `authenticateApiToken`): the issuer (`api_tokens.created_by`) must be active and still hold `API_TOKEN_MANAGE` (or `SYSTEM_ADMIN`) on the token's project -- per-project roles and overrides included -- otherwise `401 TOKEN_ISSUER_INACTIVE` (`sendTokenIssuerInactiveError`, reason disabled vs. lost access). The token's permissions are its capabilities **intersected with the issuer's current permissions** there, so narrowing the issuer narrows their tokens immediately. A demotion only suspends: give the permission back and the token works again.
- **Disabling the issuer revokes their tokens for good** (`ApiTokenRepository.revokeAllIssuedBy`, in the same AdminGuard transaction that ends their sessions; the `USER_DISABLED` audit diff records `api_tokens_revoked`), since disabling is usually offboarding and re-enabling shouldn't revive them.
- **No expiry stays the default**; the optional expiry date still works. That's acceptable now because a token can never exceed what an active, authorised person currently has, and it can be revoked in one click with its last-used time visible.
- **List/UI**: `GET .../api-tokens` adds `issued_by`, `issuer_active`, `inactive_reason`, `effective_capabilities`. The API Tokens tab shows "INACTIVE · issuer disabled / issuer lost access" and "EXPIRED" badges (dimmed like revoked), "Created … by <user>", strikes through capabilities the issuer no longer has, and explains under the expiry field what leaving it empty means.

New tests: `apps/server/tests/api_token_issuer.test.ts` (3 -- a demoted issuer's token gets 401 and is listed inactive, works again when the role is restored, and a per-project `API_TOKEN_MANAGE` deny also stops it; an issuer losing `EXECUTE_RUN` leaves the token able to read but not record, with `effective_capabilities` showing it; disabling the issuer revokes the token, which stays revoked after re-enabling, and the audit row counts it). 512/512.

## Changed: execute-only users can find their plan and run; BUILD_MANAGE renamed RUN_MANAGE (2026-10-08)

Two requests.

**1. A user with only `EXECUTE_RUN` could do nothing** -- since the read-permission fix earlier the same day, every read needed `SPEC_VIEW`, so they saw no projects, plans or runs. Now the reads that executing tests needs accept either:
- New `requireAnyPermission(keys)` and `EXECUTION_READ_PERMISSIONS = ['SPEC_VIEW', 'EXECUTE_RUN']` (`middleware/auth.ts`), used by a project's plans, a plan's runs, a plan's cases (the queue), a case's custom-field values (shown read-only in Execute mode), and case search plus its field catalog (the queue's search/filters). `canViewProject` takes an `anyOf` list; `GET /api/v1/projects` lists projects you can view **or** execute in (the MCP server still requires `SPEC_VIEW`).
- `GET .../spec-tree` (which also drives Execute mode's suite tree) accepts them too, but without `SPEC_VIEW` returns only the selected plan's cases and the folders containing them (empty with no `plan_id`), so the rest of the spec stays hidden.
- Still `SPEC_VIEW`-only: a case's full content (`latest-version`), suite custom-field values (Suite Details), and Reports. Changing plans, runs and projects still needs `PLAN_MANAGE`/`RUN_MANAGE`/`PROJECT_*`.
- **Web**: without `SPEC_VIEW` the app switches to Execute mode and the Spec toggle is disabled (tooltip "Your role can't view test specifications"). The ➕/✏️/🗑️ buttons beside Project, Plan and Run were shown to everyone (the server refused the change); they now show only with `PROJECT_CREATE` (add/edit) / `PROJECT_DELETE`, `PLAN_MANAGE`, and `RUN_MANAGE` respectively.

**2. `BUILD_MANAGE` is now `RUN_MANAGE`**, matching the app's "test run" wording, with the description "Create, edit, close and delete test runs in a test plan." Migration `005_rename_build_manage` renames the stored permission (role bundles and overrides reference its id, so they follow) and rewrites `BUILD_MANAGE` inside `api_tokens.capabilities`. Code, tests, `docs/rfc_04_rbac_security_matrix.md` and `docs/MASTER_ARCHITECTURE_BLUEPRINT.md` use the new key; `App.tsx`'s flag is `hasRunManagePermission`. Older entries in this file still say `BUILD_MANAGE`.

New tests: `apps/server/tests/execute_only_access.test.ts` (3 -- an `EXECUTE_RUN`-only user sees the project, plans, runs and queue and records a result; their spec tree holds only the plan's 9 cases (one was taken out of the plan) and nothing without a plan, while an admin sees all 10; they get 403 on case content, suite fields, reports, and every plan/run/project change). `migrations.test.ts` +1 (005 renames the key and a token's capability in a database built up to 004). `read_permissions.test.ts` and `case_search.test.ts` now use an export-only role as their "no access" example. 516/516. Verified live as an `EXECUTE_RUN`-only user: the app opens in Execute mode with project/plan/run selected and the queue loaded, no add/edit/delete buttons.

## Fixed: CSV exports didn't neutralise spreadsheet formulas (2026-10-08)

Audit item 13 (`docs/audit_2026-10-07.md`). A CSV cell starting with `=`, `+`, `-` or `@` runs as a formula when the file is opened in Excel, LibreOffice or Google Sheets, so a case titled `=HYPERLINK("http://evil.example","Click")` (or a CI failure message) became live in whoever opened the export.

- New `packages/core/src/export/spreadsheetFormula.ts` (exported from `@testify/core`): `neutralizeSpreadsheetFormula` prefixes an apostrophe to text starting with `=`, `+`, `-`, `@`, tab or carriage return -- spreadsheets then show it as text -- but leaves plain numbers (`-5`, `+3.2`, `1e5`) alone. `restoreNeutralizedFormula` undoes exactly that.
- Used by both CSV writers: `CsvExportSerializer` (definitions and execution-results exports) and `reporting/csv.ts`'s `toCsv` (every report CSV; numeric cells are written as-is).
- The native CSV importer (`CsvParser`) restores each cell, so a definitions export still re-imports exactly (the existing export-then-import test in `exports.test.ts` still passes). The TestRail CSV parser is untouched -- those files come from TestRail.
- Edge case, accepted: a value that genuinely starts with an apostrophe followed by a formula character (e.g. `'=x`) loses that apostrophe on import from a CSV.

New tests: `packages/core/tests/spreadsheetFormula.test.ts` (4 -- which values get prefixed and which don't; restore is the exact inverse; a report CSV neutralizes text but not numbers; a definitions export with formula-like suite name, title, summary, preconditions and step text contains no live formula and re-imports unchanged). 520/520.

## Fixed: the SMTP password was stored in plaintext (2026-10-08)

Audit item 14 (`docs/audit_2026-10-07.md`). The Admin Panel's SMTP password sat in `system_settings` as entered, so anyone with a database dump or backup had the mail account.

- **Encrypted at rest** with AES-256-GCM (`apps/server/src/services/secrets.ts`, `SecretBox`), keyed by HKDF-SHA256 of a new **`SECRETS_KEY`** setting that never touches the database. Stored as `enc:v1:<iv>:<tag>:<ciphertext>`; a fresh IV per save. The box is set once at startup (`setSecretBox`, in `createServer`) because the scheduler sends mail outside any request.
- **`resolveSecretsKey`** (`config.ts`): `SECRETS_KEY` (32+ characters, else a `ConfigError` stops startup) is used when set. Unset on the in-memory database: a random per-process key (that data is thrown away anyway). Unset on a real database: no key -- `PUT /admin/email-settings` refuses a password with `400 SECRETS_KEY_REQUIRED` ("set SECRETS_KEY ... and restart it"); the server still starts, since many installs never send email.
- **Mailer** (`loadEmailSettings`) decrypts when sending. A password that can't be decrypted (key missing or changed) isn't used: `sendEmail` records the send as FAILED with `SMTP_PASSWORD_UNREADABLE_MESSAGE` ("... Re-enter the password in Admin Panel -> Email") instead of authenticating with garbage.
- **Existing plaintext passwords** (saved before this) are encrypted at startup by `encryptStoredSmtpPassword` once a key is available; without one they're left as they were and a warning is logged.
- **API/UI**: the settings response adds `password_unreadable` and `can_store_password` (the password itself is still never returned). The Email tab shows a yellow note when the server has no `SECRETS_KEY`, or when the saved password can't be read and must be entered again; the password placeholder says "saved, encrypted".
- **Key rotation isn't built**: changing `SECRETS_KEY` makes the stored password unreadable, and an admin enters it again (the UI says so).

New tests: `apps/server/tests/secrets.test.ts` (6 -- `SecretBox` round-trip, fresh IVs, wrong key and tampering refused; `resolveSecretsKey`'s three cases and the length check; a saved password is stored encrypted, never returned, and decrypted only for the SMTP transport; a legacy plaintext password is encrypted on restart; after the key changes the settings say "unreadable" and a send fails without touching the transport; a real database without `SECRETS_KEY` refuses to store one). 526/526.

## Fixed: the web app's sign-in token no longer lives in localStorage (2026-10-09)

Audit item 15 (`docs/audit_2026-10-07.md`). The web app stored its login JWT in `localStorage["auth_token"]` and sent it as a Bearer header, so any script running on the page (an injected one included) could read and copy it.

- **Sign-in is an HttpOnly cookie** (`apps/server/src/sessionCookie.ts`): `testify_session`, `HttpOnly; SameSite=Strict; Path=/api; Max-Age=3600`, plus `Secure` when the request came over HTTPS (behind a proxy, `TRUST_PROXY=true` makes `request.protocol` see that). The web app asks for it with `POST /api/v1/auth/login {..., session: "cookie"}`; the token is then left out of the response. Without `session: "cookie"` (curl, scripts, tests) login returns the token as before and sets no cookie.
- **`authenticateRequest`** (`middleware/auth.ts`) takes `Authorization: Bearer` first and falls back to the cookie (`requestCredential`). The cookie must hold a sign-in JWT -- an API token (`tf_ci_...`) in it is refused -- and still goes through the same session/must-change-password checks.
- **CSRF**: a cookie-authenticated request that changes something (anything but GET/HEAD/OPTIONS) must carry `X-Testify-Client: web`, else `403 CSRF_HEADER_MISSING`; cookie-mode login needs it too (so another site can't sign a browser into an account). Another origin can't add a custom header without a CORS preflight, which fails unless it's in `CORS_ORIGINS` -- so this holds even for sibling subdomains that SameSite treats as "same site". Bearer requests don't need it.
- **Sign-out** (`POST /auth/logout`) reads the session from the header or the cookie, ends it, and clears the cookie (`Max-Age=0`).
- **CORS**: `CORS_ORIGINS` now registers with `credentials: true`, so a listed origin on the same site can use the cookie.
- **Web**: new `apps/web/src/utils/session.ts` (`authHeaders()` returns `{ "X-Testify-Client": "web" }`); every former `localStorage.getItem("auth_token")` helper in `App.tsx` and 11 components now uses it, and the browser sends the cookie itself. `fetchCurrentUser` just calls `/auth/me` (no stored-token check) and removes any `auth_token`/`user_id` left by older builds. `onLoginSuccess` no longer takes a token. Nothing in the web app reads or writes a token any more.
- `apps/web/src/tests/auth_flow.test.ts` lost its two tests that only exercised a mocked `localStorage`.

New tests: `apps/server/tests/session_cookie.test.ts` (4 -- cookie attributes incl. `Secure` over https, token absent from a cookie login but present for a plain one; cookie reads work, a cookie change without (or with a wrong) client header is refused and creates nothing, with it succeeds, a Bearer header wins over a bad cookie; cookie login without the header is refused, an API token or garbage in the cookie gets 401; sign-out clears the cookie and the old value stops working). `secrets.test.ts`'s server-starting tests got 30s timeouts (one timed out under full-suite load). 528/528. Verified live in a separate browser origin: sign in, `document.cookie` is empty and `localStorage` holds nothing, `/auth/me` works and survives a reload, a header-less POST gets 403, recording a result in Execute mode works, sign-out returns to the login screen and `/auth/me` then 401s. Everyone is signed out once by this change (old localStorage tokens are discarded).

## Fixed: imports accepted 140 MB JSON bodies held in memory (2026-10-09)

Audit item 16 (`docs/audit_2026-10-07.md`). The import wizard sent the file base64-encoded inside a JSON body, so both import routes accepted bodies up to 140 MB. Fastify buffers such a body as one string, `JSON.parse` copies it, and base64-decoding copies it again -- several times the file's size in memory per request, sent twice per import (preview, then execute), with no limit on how many ran at once.

- **The wizard uploads multipart/form-data** (`ImportWizardModal.tsx`): it keeps the chosen `File` (no more `FileReader`/base64) and sends `format`, `target_project_id`, `configuration` (JSON) and `file` via `FormData`. Fastify reads that as a stream. Files over 50 MB are refused in the browser before uploading (`MAX_IMPORT_FILE_BYTES`); 413 and 429 replies get readable messages.
- **Limits** (`apps/server/src/routes/ingestion.ts`, exported):
  - `IMPORT_JSON_BODY_LIMIT_BYTES` = 5 MB: a JSON body with `file_content` (scripts, tests) still works, but only for small files. Over it, `413 IMPORT_TOO_LARGE` says to use multipart (a route-level `errorHandler`, since the body is refused before the handler runs).
  - `IMPORT_MAX_FILE_BYTES` = 50 MB (was 100 MB), one file, at most 20 fields of up to 1 MB each (`IMPORT_FIELD_LIMIT_BYTES`), set on the multipart registration in `server.ts` (only imports use multipart). Over the size, `413 IMPORT_TOO_LARGE` naming the limit; a second file, `413 "Send one file per import."`.
  - `MAX_CONCURRENT_IMPORTS` = 2 per server process, shared by dry-run and execute: more get `429 IMPORT_BUSY` with `Retry-After`. The slot is taken in an `onRequest` hook -- before the body is read, so a refused request never buffers its file -- and only after authenticating, so anonymous requests can't hold slots. It's given back on `onResponse` or `onRequestAbort`.
- **Still true:** the uploaded file and its parsed tree are held in memory while importing (the parsers take a stream, but the routes buffer the file to sniff its format and parse it twice). That's what the caps bound. `docs/rfc_03_api_and_xml_contracts.md` §6.3 and the blueprint's requirement #13 describe streaming 100 MB+ TestLink exports in bounded memory; that isn't built, and files over 50 MB are refused.
- **Tests:** new root `vitest.config.ts` sets a 30s test/hook timeout. Server tests each start a server on a fresh in-memory database, and under a full parallel run some exceeded the 5s default at random (this pass it was `cors.test.ts`).

New tests: `apps/server/tests/import_limits.test.ts` (3 -- a multipart dry-run and execute import a case, and a file larger than the JSON limit imports fine as multipart; an oversized JSON body, a file over 50 MB and two files each get the 413; two held-open uploads fill the slots so a third gets 429, three anonymous requests before them took none, and a later upload succeeds once they finish). 531/531. Verified live in a separate browser origin: the wizard's preview and import go up as multipart and import the case, and a 51 MB file is refused in the browser with "huge.xml is too large to import (the limit is 50 MB)."

## Fixed: an ended sign-in showed "Unauthorized: Invalid signature" instead of the login screen (2026-10-09)

Reported: importing a TestLink file that used to work failed with "Unauthorized: Invalid signature". The file was fine (preview: 179 suites, 724 cases; import: 723 cases plus a second version of one case the file lists twice). The sign-in wasn't. The dev API server signs with a random key per start, so after a restart the browser's session cookie no longer verifies. But the app only checks the sign-in on load, so it still looked signed in, and the import dialog showed the server's raw 401.

- **Server** (`middleware/auth.ts`): a JWT that fails to verify (wrong key, expired, malformed) and a token whose session has ended both answer `401 {error: "Unauthorized: your sign-in has ended -- please sign in again", code: "SESSION_ENDED"}`; the verify failure keeps the detail in `reason` (e.g. `Invalid signature`).
- **Web**: `watchForEndedSession(onEnded)` (`utils/session.ts`) wraps `window.fetch` while someone is signed in. Any `/api/...` reply of 401, other than login, logout and `/auth/me` (handled where they're called), triggers `handleAuthExpiry`, which signs out locally. `App.tsx` installs it in an effect keyed on the user. So every screen and dialog (import, admin panel, reports, ...) goes back to the login screen instead of showing the error. `LoginPage` gained a `notice` prop: "Your sign-in has ended. Please sign in again." in an amber box, cleared on sign-in. `handleAuthExpiry` used to toast "Session expired", but toasts don't show on the login screen; it now sets the notice instead.

Test: `session_cookie.test.ts` +1 (a cookie signed with another key gets 401 `SESSION_ENDED` with `reason: "Invalid signature"`). 532/532. Reproduced live and confirmed fixed: signed in, restarted the API server, clicked Preview Import, and the app returned to the login screen with the notice instead of the raw error.

## Fixed: custom-field validation patterns could freeze the server (2026-10-09)

Audit item 17 (`docs/audit_2026-10-07.md`). A TEXT custom field's validation pattern is a regular expression an admin types in, and `parseCustomFieldValue` ran it with `new RegExp(pattern).test(value)`. A catastrophically backtracking pattern (`^(a+)+$`, `^(a|a)*$`) on the right value runs for minutes or longer, and a JavaScript regex can't be interrupted, so one value save (or import row) would freeze the whole server. Patterns also weren't checked when saved: one that didn't compile was stored, and then every value save for that field threw a `SyntaxError` -- a 500.

- **New `packages/core/src/custom-fields/validationPattern.ts`**:
  - `checkValidationPattern(pattern)`: refuses a pattern that doesn't compile, or is over `MAX_VALIDATION_PATTERN_LENGTH` (500 characters).
  - `matchesValidationPattern(pattern, value)`: runs the match in a `node:vm` context with a `VALIDATION_PATTERN_TIME_LIMIT_MS` (50 ms) timeout. A vm timeout does stop a running regex (verified); a normal match costs about 0.06 ms. Running out of time throws `VALIDATION_PATTERN_TIMEOUT_MESSAGE` ("INVALID_FIELD_VALUE: checking this value ... took too long, so it was refused. Ask an administrator to simplify the pattern."), a plain `Error` on purpose so the routes show it (`isPublicError`) as a 422. A stored pattern from before this fix that doesn't compile is refused with a clear `INVALID_FIELD_VALUE` instead of a 500.
  - `parseCustomFieldValue` uses it, which covers every path that saves values: Spec-mode case/suite values, imports, and defaults seeded or applied.
- **Checked on save**: `CustomFieldRepository.createDefinition`/`updateDefinition` throw `INVALID_VALIDATION_PATTERN: ...`, which `POST`/`PUT /api/v1/admin/custom-fields` answer as `400 {code: 'INVALID_VALIDATION_PATTERN'}` (message without the code prefix, shown by the Admin Panel).
- **Admin Panel**: the "Validation Regex" input is capped at 500 characters, with a caption saying it's a JavaScript regex and that values whose check takes too long are refused.
- **Deliberately not used**: a "safe regex" heuristic. `safe-regex2` (already installed via Fastify) was tried: it misses `^(a|a)*$` and rejects the safe, useful `^([a-z0-9]+\.)*[a-z]+$`. The time limit is what actually holds, so a slow-but-compiling pattern can still be saved; it just can't hang anything.

New tests: `packages/core/tests/validationPattern.test.ts` (4 -- save-time checks incl. the length boundary; normal matches; `^(a+)+$` is stopped well under 2s and the next check still works; `parseCustomFieldValue` uses it, incl. a stored pattern that doesn't compile). `custom_fields_admin_and_values.test.ts` +1 (a pattern that doesn't compile, or is too long, gets 400 on create and update; a catastrophic pattern can be saved but a value that would hang it gets 422 "took too long" in under 3s, and ordinary values still save). 537/537.

## Fixed: Execute mode showed two fake test cases (2026-10-09)

Audit item 18 (`docs/audit_2026-10-07.md`). `App.tsx`'s `DEFAULT_FALLBACK_WORKSPACE` held two made-up cases (TFY-101 "Verify initial superuser admin login...", TFY-102) under a fake project/plan/build. It was the workspace's initial value and what `refreshExecutionWorkspace` fell back to whenever no plan was selected or the plan's cases failed to load. So Execute mode could show cases that don't exist, and pressing a verdict key on one posted against ids the server didn't know.

- Replaced by `EMPTY_WORKSPACE` (no cases, blank project/plan/build -- only `workspace.cases` is read anywhere).
- New `execWorkspaceStatus` state (`NO_PLAN | LOADING | READY | ERROR`), set by `refreshExecutionWorkspace`. Switching to a different plan shows `LOADING`; refreshing the same plan keeps its cases on screen (compared through a `workspaceRef`).
- Pane 3 in Execute mode used to render nothing when there was no active case. It now says why:
  - "There are no projects yet."
  - "Select or create a test plan to start executing tests."
  - "Loading test cases…"
  - "Couldn't load this test plan's cases." with a Retry button.
  - "This test plan has no test cases yet. Add some in Spec mode." (the second sentence only with SPEC_VIEW)
  - "No test case selected."

No new automated tests (client-side state). Web tests 54/54; `tsc --noEmit` clean. Verified live in a separate browser origin: a project with no plans, an empty plan, and the demo plan (its 12 real cases, no TFY-10x anywhere) each show the right thing. A simulated failed load of the plan's cases shows the error with Retry, and Retry loads the 12 cases.

## Fixed: the single-result route stored any verdict string, and an unknown step id was a 500 (2026-10-09)

Audit item 19 (`docs/audit_2026-10-07.md`). `POST /api/v1/executions` (what Execute mode's verdict buttons and hotkeys call) took its body as-is. Any `verdict`/`status` string was stored, and reports then counted the result as "OTHER" or not at all. Step results were inserted unchecked, so an unknown `test_step_id` hit a foreign key and came back as a 500. A step from another case, or a wrong `step_number`, was stored silently. The result, its steps and its audit row were separate inserts, so a failure part-way left a partial result.

- **New `packages/core/src/execution/results.ts`** (exported from `@testify/core`): `EXECUTION_VERDICTS` (PASSED, FAILED, BLOCKED, SKIPPED, RETEST_REQUIRED, KNOWN_ISSUE), `EXECUTION_STATUSES` (COMPLETED, IN_PROGRESS, ABORTED), `STEP_VERDICTS` (PASSED, FAILED, BLOCKED, SKIPPED, UNTESTED), `MAX_RESULT_NOTES_LENGTH` (20,000), and `is...` guards. These are the values the DB columns' comments already listed; the batch route (audit item 21) can reuse them.
- **New `apps/server/src/services/resultValidation.ts`** (`validateManualResult`): checks every field at once:
  - `build_id` and `test_plan_case_id` are present.
  - `verdict` and `status` (status defaults to COMPLETED) are known values, exact case.
  - `notes` is text within the limit.
  - `step_results` is a list of objects, each with a unique `test_step_id`, an optional positive whole `step_number`, a known step `verdict`, and text `actual_result`.

  Failures answer `400 INVALID_RESULT` (problem details) with every problem in `invalid_params`.
- **The route** (`server.ts`) then checks each step id against the steps of the version the case is pinned to in the plan (`test_plan_cases.test_case_version_id`): `400` "isn't a step of this test case", or "is N for this step" for a mismatched `step_number`. A step's stored number now always comes from the step itself, so `step_number` is optional. The execution, its step results (one multi-row insert) and the audit row are written in one transaction.

New tests: `apps/server/tests/execution_validation.test.ts` (3 -- unknown verdict/status, non-text notes, a bad step verdict and a non-object step all named in one 400, missing ids, a lowercase verdict refused; an unknown step id, another case's step, a wrong step number and a duplicate step each get 400 and nothing is stored; a valid KNOWN_ISSUE result with steps sent out of order stores the right numbers, and status defaults to COMPLETED). 540/540.

## Fixed: EXECUTE_OVERWRITE was only checked by the verdict hotkeys (2026-10-09)

Audit item 20 (`docs/audit_2026-10-07.md`). Elliot couldn't reproduce "anyone with `EXECUTE_RUN` can overwrite results", and re-checking explained why: the web app's verdict hotkeys (`p/f/b/s`, `useHotkeyEngine` via `useFocusFSM.canOverwrite`) do refuse a user without `EXECUTE_OVERWRITE` once a case has a result. Two other paths didn't check it at all:
- The Pass/Fail/Block/Skip buttons only checked `EXECUTE_RUN`.
- The server never checked it, for `POST /api/v1/executions` or the batch route.

Reproduced against the dev server: the fixture `tester` (Tester role, no `EXECUTE_OVERWRITE`) re-recorded DEMO-1 in an open run and got 201.

- **The rule** (new `apps/server/src/services/resultOverwrite.ts`): recording a result for a test case that already has one in the run needs `EXECUTE_OVERWRITE` (or `SYSTEM_ADMIN`). Results are never edited -- a new row becomes the case's verdict -- so that's what overwriting means.
  - **Exception:** re-recording your own latest result with the same verdict (adding notes). That's the web app's Ctrl+Enter "submit notes" after picking a verdict, which `useHotkeyEngine` deliberately allows Testers.
  - **Which result counts:** `latestResultsInRun` takes the latest result per test case across all of the case's links to the plan, by `execution_timestamp` then `created_at` -- the same order reports use.
- **Single-result route** (`server.ts`): refused with `403 RESULT_OVERWRITE_NOT_PERMITTED` (problem details); nothing is stored.
- **Batch route** (`batchExecution.ts`): the check is against results recorded before the request, and several results for one case within a request are retries, not overwrites. A refused item gets a per-item 403; in all-or-nothing mode the whole batch is refused with a 403 and nothing is recorded. The Automation Service role doesn't hold `EXECUTE_OVERWRITE` by default, matching RFC 04's matrix: a CI token that should change earlier results in the same run needs the capability.
- **Batch ordering fix, found by the tests:** items without `executed_at` all got the same `execution_timestamp` and `created_at`, so which of a failure and its retry was "latest" was arbitrary -- for this check and for reports alike. Each item's `created_at`/`updated_at` is now the request time plus its index in milliseconds, so later items are later.
- **Web** (`App.tsx`): the four verdict buttons now refuse like the hotkeys (`!fsm.canOverwrite`). `executionDenied` became a message (`string | null`), so the yellow "Not permitted" banner says which permission is missing: `RUN_DENIED_MESSAGE`, or `OVERWRITE_DENIED_MESSAGE` for the buttons, the hotkeys' refusal, or a server `RESULT_OVERWRITE_NOT_PERMITTED`.

New tests: `apps/server/tests/result_overwrite.test.ts` (2):
- A Tester records a first result and adds notes to it, but can't change it. A Test Lead and an admin can, after which the Tester can't re-record even the same verdict, since the latest result is no longer theirs. Refusals store nothing.
- A batch token with only `EXECUTE_RUN` records a failure and its retry in one request, gets a per-item 403 for changing it in a later request while other items still record, may resend the same verdict, and in atomic mode gets a whole-batch 403 with nothing recorded. A token with `EXECUTE_OVERWRITE` may change it.

542/542. The demo script still loads fully: test health shows the same flaky, slowing and always-failing cases and SSO login's passed-on-retry run.

## Fixed: batch results -- no transaction, leftover auto-links, guessed steps, unchecked verdicts (2026-10-09)

Audit item 21 (`docs/audit_2026-10-07.md`). `POST /api/v1/test-plans/:planId/builds/:buildId/executions/batch` (CI and API tokens):
- inserted results and step results one row at a time with no transaction, so a failure part-way left a partial batch, and a big batch was slow -- the 1,000-item test was the suite's usual timeout;
- in all-or-nothing mode it returned the rejection after it had already linked cases to the plan;
- recorded a step result with an unknown `step_number` against step 1, and stored the request's `step_number` rather than the step's;
- stored any verdict or status string.

- **Every item is validated up front** (`validateBatchItem`, `apps/server/src/services/resultValidation.ts`):
  - a case identifier (`external_id`, `by_uuid` or `by_path_title.title`);
  - verdict and status from `@testify/core`'s `EXECUTION_VERDICTS`/`EXECUTION_STATUSES` (status defaults to COMPLETED);
  - `duration_ms` a whole number ≥ 0, `executed_at` a date-time (stored normalised to ISO);
  - `notes`, `failure_message` and `stack_trace` text within limits;
  - `environment_tags` an object of up to 50 text values;
  - each step result with a `test_step_id` or `step_number` and a `STEP_VERDICTS` verdict.

  `executions` must be a list of 1 to `MAX_BATCH_RESULTS` (5,000) items, else `400 INVALID_RESULT`. Not atomic: an invalid item gets a per-item 400 with `code` and `invalid_params`. Atomic: every invalid item is reported in one 400, before anything touches the database.
- **Steps are matched exactly**: by `test_step_id` or `step_number` against the version the case runs at in the plan. An unknown step, a mismatched number, or a step repeated within an item refuses the item with `422 UNKNOWN_STEP`. The stored step number is the step's own.
- **One transaction** for the whole request: auto-links, results, step results and the audit row. Results and step results go in as multi-row inserts in chunks of 500. Not atomic: accepted items are saved together and refused ones reported. Atomic: a refused item throws `AtomicRejection` inside the transaction, so everything rolls back, auto-links included, and the error is returned as problem details.
- **A case is linked to the plan only once its item has passed every check** (resolved, overwrite rule, steps), so even outside atomic mode a refused item never leaves a link behind; the link is then reused by later items in the same request.
- **Per-item results** gained `code` (`INVALID_RESULT`, `CASE_NOT_FOUND`, `CASE_REMOVED_FROM_PLAN`, `RESULT_OVERWRITE_NOT_PERMITTED`, `UNKNOWN_STEP`) and `invalid_params` (`BatchExecutionSingleResult` in `@testify/core`). An unresolvable case is now coded `CASE_NOT_FOUND` (was `VALIDATION_FAILED` in atomic mode); `batch_and_xml.test.ts` was updated. `BatchExecutionItem.status` no longer lists `UNTESTED`.

New tests: `apps/server/tests/batch_results.test.ts` (4):
- Invalid verdict, status, duration/date, step verdict and a missing case identifier each get a per-item 400 naming the field. In atomic mode all problems come back in one 400 with nothing stored. An empty, non-list or missing `executions` gets a 400.
- Steps by number and by id are stored with the right ids and numbers. An unknown step number, another case's step, a mismatched number and a repeated step each get 422 `UNKNOWN_STEP`.
- A rejected atomic batch leaves no link, result or audit row. A non-atomic item refused for its steps doesn't link its case. An accepted case appearing twice is linked once.
- 2,000 results are recorded in one request (about 1.5 s; the old 1,000-item test now takes about 2 s).

546/546. The demo script reloads with identical report results (flaky, slowing, always failing, stale).

Found while testing: creating a case whose step has no `step_number` failed with a 500 -- fixed right after, see the next entry.

## Fixed: creating a case with an unnumbered step was a 500 (2026-10-09)

Found while testing batch results (above). `POST /api/v1/projects/:projectId/test-cases` and `PUT .../test-case-versions/:versionId` (saving a draft) passed `steps` straight to `TestCaseVersionRepository`. A step without `step_number` hit the column's NOT NULL constraint, and the request failed with a generic 500. The same happened with:
- a missing `action`/`expected_result`;
- a duplicate `step_number` (the `uq_step_order` constraint);
- a client-supplied step `id` that collided.

The web app always sends numbered steps, so this only affected API callers. Imports were already safe (they number by position).

- **New `apps/server/src/services/stepValidation.ts`** (`validateStepsInput`):
  - `steps` must be a list of at most 500 objects.
  - `step_number` is optional and defaults to the step's position; given, it must be a positive whole number, unique within the list.
  - `action`/`expected_result` must be text up to 20,000 characters (missing means empty).
  - `execution_type` must be MANUAL or AUTOMATED if given.
  - Step ids are always assigned by the server; a client `id` is ignored.
- **Both routes** check steps before changing anything, answering `400 INVALID_STEPS` (problem details, every problem in `invalid_params`). Creating a case no longer leaves a case with no version behind, and a refused draft save changes neither its steps nor its summary/preconditions.

New test: `spec_editing.test.ts` +1:
- unnumbered steps are numbered 1, 2 and a missing expected result is empty;
- a non-list, a non-object, non-text action, a 0 or fractional number, a clash between a positional number and an explicit one, and an unknown execution type each get 400 naming the field, and no case is created;
- a draft save with a duplicate number is refused with "2 is already used by steps[0]" and leaves the draft untouched;
- an unnumbered step saves as step 1.

547/547.

## Added: administrators can reset another user's password (2026-10-09)

Audit item 22 (`docs/audit_2026-10-07.md`). The login page's "Forgot password?" dialog tells people to ask an administrator, but there was no way for one to help: `USER_MANAGE` could create, disable and re-role users, not reset a password.

- **`POST /api/v1/admin/users/:userId/reset-password`** (`USER_MANAGE`, `routes/admin.ts`):
  - Sets a temporary password, generated (24 characters, `randomBytes(18)` base64url) unless the body gives one, which must pass the password policy (`400 PASSWORD_POLICY_VIOLATION`).
  - The user must change it at next sign-in: `must_change_password`, the same flow as the first admin's generated password.
  - All of their sessions end, and any sign-in lock is cleared (`UserRepository.resetPassword`).
  - The response includes `temporary_password` only when it was generated; it's never stored anywhere else.
  - Writes a `PASSWORD_RESET` audit row (`generated`, `sessions_ended`; never the password), shown in the Security Audit Log.
- **Guards**:
  - Not for your own account: `400 CANNOT_RESET_OWN_PASSWORD`, since the profile form asks for the current password.
  - Not for someone with permissions you don't have: `AdminGuard`'s rank rule, `403 TARGET_OUTRANKS_ACTOR`, checked globally and in every project where the user has a role or override. Otherwise `USER_MANAGE` could take over an admin's account, even one that's only an admin in one project.
  - API tokens the user issued are untouched (they follow access, not the password).
- **Admin Panel → User Roster**: a "Reset Password" button on every row but your own. It asks for confirmation in an amber banner ("Reset X's password? They'll be signed out everywhere..."), then shows the temporary password once in a green panel with Copy and Dismiss, styled like a new API token. It's cleared when you leave the tab or close the panel. A refusal shows the server's message in the panel's error banner.

New tests: `apps/server/tests/password_reset.test.ts` (3):
- A locked-out Tester's reset gives a 24-character temporary password, ends their old session, refuses the old password, and lets the temporary one in (lock cleared). Until they choose their own password they get 403 elsewhere; afterwards they're in. The audit row has no password and shows in the Security Audit Log.
- A chosen password is checked against the policy and not echoed.
- Your own account gets 400 and an unknown user 404. A user manager holding a Tester's permissions can reset a Tester, but gets 403 for the admin and for a Viewer who is Admin in one project, both of whom keep their passwords. A Tester without `USER_MANAGE` gets 403.

550/550. Verified live in a separate browser origin: the roster shows Reset Password on other users but not your own row, the confirmation and the once-only password appear, and signing in as that user with it lands on "Choose a new password".

## Fixed: case ids could collide -- concurrent creation, and random ids in imports (2026-10-09)

Audit item 23 (`docs/audit_2026-10-07.md`).
- **Creating a case**: `POST /api/v1/projects/:projectId/test-cases` read the highest PREFIX-n (`getNextExternalId`) and inserted separately. Two cases created at once against a real Postgres (connection pool) could pick the same id, and one failed on `uq_test_case_external` with a 500. The case and its first version were also separate transactions, so a failure in between left a case with no version.
- **Imports, worse**: a case without an id got a random `PREFIX-1000..9999`. In a file of a few hundred unnumbered cases two are very likely to clash (birthday problem), failing the whole import with a 500. A random id could also hit an existing one. A duplicate imported with "create new" reused the original's id, which collided every time.

The fix:
- **`TestCaseRepository.lockExternalIds(projectId)`**: takes `pg_advisory_xact_lock(0x7e57, hashtext(projectId))` until the transaction ends. Being a Postgres advisory lock, it serializes id assignment per project across server instances too. It must be called inside a transaction.
- **Creating a case** now locks, picks the id, and inserts the case and its first version in one transaction. `TestCaseVersionRepository` gained `runInTransaction` (as other repositories have), so `create`/`updateSteps` run inside a caller's transaction instead of opening a nested one.
- **Imports** (`routes/ingestion.ts` execute) hold the lock for the whole import transaction. A new case keeps the file's id unless it's already taken; otherwise -- no id, or a "create new" copy -- it gets the next PREFIX-n after the highest in the project, skipping ids taken in the project and ids the file itself uses later.

Numbering stays "highest + 1". In the core-loop seed (SHOP-101…109, SHOP-1010) new cases start at SHOP-1011.

New tests: `apps/server/tests/external_ids.test.ts` (2):
- 12 cases created at once all succeed with consecutive ids, each with its version. This test can't reproduce the race itself: the in-memory database has one connection, so the transactions run one after another, and it passes without the lock too. A real Postgres wasn't available to show the overlap.
- An import of 300 unnumbered cases, plus one using SHOP-1012 and a "create new" copy of SHOP-101, imports all 302 with no duplicates and no gaps. The file's SHOP-1012 is kept, and the copy gets a fresh id. This test fails with a 500 on the old code.

552/552.

## Fixed: audit log entries recorded a fake address and made-up client names (2026-10-09)

Audit item 24 (`docs/audit_2026-10-07.md`). Nearly every `audit_logs` insert hard-coded `ip_address: '127.0.0.1'` and a `user_agent` such as `'TestifyAdminService'`, so the Security Audit Log couldn't say where any action came from. A few report-email entries used `null`, and the sign-in lockout recorded the real address but a made-up agent. 30 inserts in 15 files.

- **New `apps/server/src/audit.ts`**: `requestOrigin(request)` returns `{ ip_address, user_agent }` -- `request.ip` (which follows `TRUST_PROXY`, so behind a reverse proxy it's the forwarded client) capped at 45 characters (the column, the longest textual IPv6), and the `User-Agent` header trimmed and capped at 500. `NO_ORIGIN` (both null) is for actions with no request behind them.
- **Every audit insert** now spreads `...requestOrigin(request)`. Helpers that write audit rows take the origin from their caller:
  - `insertAuditLog` (spec editing) and `audit()` (report emails) take it as a parameter;
  - `writeProjectAudit` now takes the request;
  - `recordAccountFailure` (sign-in lockout) takes an origin instead of an ip;
  - `autoCloseBuildIfComplete(db, buildId, actor, origin = NO_ORIGIN)` records the request whose result completed the run;
  - `ReportEmailService.sendSchedule(schedule, trigger, origin = NO_ORIGIN)` records the request for "Send now", and nothing for scheduled sends.
- **Admin Panel → Security Audit Log** gained a "From" column: the address, with the User-Agent in a hover tooltip, or "scheduled" when there was no request.
- Older rows keep the values they were written with.

New tests: `apps/server/tests/audit_origin.test.ts` (2):
- Project, custom field and case creation, a data export, a single result, a batch, and an account lock -- all sent from one address with one User-Agent -- each write audit rows carrying exactly that address and agent.
- With `TRUST_PROXY=true` the `X-Forwarded-For` client is recorded instead of the proxy, and a 2,000-character User-Agent is stored as 500.

554/554. Verified live: an action from the browser records the browser's User-Agent, and the demo script's actions record `node`. Behind Vite's dev proxy the address is genuinely 127.0.0.1.

Noticed, not changed: creating, editing and deleting test plans and runs writes no audit entry at all (projects, cases, plan membership, results and admin changes do).

## Fixed: the Security Audit Log cut resource ids to 8 characters (2026-10-09)

Per direct request. The Resource ID column showed `resource_id.substring(0, 8)...`, so the id couldn't be read or copied, and there's no way to widen columns. `AdminPanelModal.tsx`'s audit table now shows the full id on one line, selectable as a whole (`userSelect: all`), with its `resource_type` in small text above it. The Diff Payload column wraps (`wordBreak: break-all`, min 160px) instead of squeezing the other columns. The table fits the panel (774px in 788px) with no sideways scroll.

## Fixed: an open case kept showing old custom-field values after an admin changed the field (2026-10-09)

Audit item 26 (`docs/audit_2026-10-07.md`, first flagged in the 2026-09-18 custom-fields entry). The custom-field value fetches in `App.tsx` re-ran only when the selected case, suite or mode changed. After an admin created, edited or deleted a field in the Admin Panel, the case or suite already open kept its old values and labels -- a deleted field stayed editable, and a renamed one kept its old name -- until something else was selected or the page reloaded. Field changes can also rewrite stored values (a removed option is deselected, a required field fills blanks with its default), so the values themselves could be out of date too.

- `AdminPanelModal` gained an `onCustomFieldsChanged` prop, called after a field is created or saved, deleted, or force-deleted with its data.
- `App.tsx` counts these in `customFieldDefsVersion`, which is now a dependency of the three value fetches: the Spec-mode case, the Execute-mode case (read-only), and the selected suite. The open case's or suite's values reload as soon as the change is saved. The editors are uncontrolled and keyed by field, and the fetch clears values first, so they remount with the new labels and values.
- The same signal reloads the search filter's field list (a deleted field's filter row drops out) and re-runs the current search.
- Limitation: this covers changes made in the same browser tab. A change by another admin elsewhere still shows after the next case or suite switch or a reload; nothing pushes changes from the server.

No new automated tests (client-side state; web tests 54/54, `tsc` clean). Verified live in a separate browser origin: with DEMO-1 open in Spec mode, renaming its custom field in the Admin Panel showed the new label on the open case at once, and deleting the field (and its data) removed it from the open case at once.

## Removed: unused repository methods and stale comments (2026-10-09)

Audit item 34 (`docs/audit_2026-10-07.md`). Its legacy routes were already gone (`/executions/verify` with item 4, `/workspace` with item 7). What remained:

- **Repository methods nothing in the app called**, removed along with their doc comments:
  - the audit's six: `TestPlanRepository.removeCasesBulk`/`updateCaseVersionPin`, `ExecutionRepository.findByTestPlanCase`/`getLatestExecutionForPlanCase`/`findByBuildAndPlanCase`, and `TestCaseVersionRepository.findVersionByNumber`;
  - five more found by scanning every repository method for callers outside its own file: `TestCaseRepository.findByExternalId`/`findBySuite`, `TestCaseVersionRepository.findByTestCase`, `TestSuiteRepository.findChildren`, `ExecutionRepository.createBatch`.

  That's 215 lines. The routes insert directly or use the newer batched methods (`getFinalResultsForRuns`, `removeCases`, `repinCaseInActivePlans`, ...). Two unused type imports in `user.repository.ts` went too.
- **Tests that only exercised removed methods** now use the real ones: `repositories.test.ts` checks `removeCases` instead of `removeCasesBulk` and records retries with `create` instead of `createBatch`; the suite test keeps `findDescendants`; the draft test compares against the v1 it created.
- **Stale comments**: `App.tsx` no longer describes a "fake-seed -> real-id bootstrap" (projects and plans start empty since 2026-10-05) or "PROJECT's still-mock CREATE path"; it and `testPlanCases.ts` no longer refer to the removed `/api/v1/workspace`.
- **Kept on purpose**: `AuditLogRepository`. The app never uses it -- it writes audit rows directly in 30 places -- but the database tests use it to check the audit table is append-only. Whether the routes should use it is a design question, not dead code.
- `packages/*/dist` and `apps/server/dist` are git-ignored build output, not part of the repo; nothing to remove there.

554/554; `tsc --noEmit` clean.

## Fixed: an old worktree's tests ran in `npm test` (2026-10-09)

Audit item 35 (`docs/audit_2026-10-07.md`). `npm test` (root `vitest run`) also collected the tests in `.claude/worktrees/vigilant-haslett-05b0d0`, a Claude Code worktree last touched 2026-09-18. Those are old copies of the tests, run against this checkout's shared packages, so they always failed: the "usual 3/4 failures" mentioned in many entries above, and 52 by the end. Every session worked around it with `--exclude '.claude/**'`.

- **Root `vitest.config.ts`** now excludes `.claude/**` (on top of vitest's default excludes), so no worktree there is ever picked up again.
- **The worktree was removed** with `git worktree remove`, which refuses if there are uncommitted changes. It had none, no stashes, and no files changed since 2026-09-18.
- **Its branch `claude/vigilant-haslett-05b0d0` was kept.** It holds one commit not on `main` (3b00f47, "Fix stale custom field values in open Spec-mode case detail after Admin Panel edits"), an earlier attempt at what audit item 26 fixed on `main` the same day. It can be deleted (`git branch -D claude/vigilant-haslett-05b0d0`) once nobody wants it.

Plain `npm test`: 554/554, no flags needed.

## Removed: duplicated auth-header helpers and unused web code; fixed blank titles (2026-10-09)

Audit item 36 (`docs/audit_2026-10-07.md`), minus its first part: splitting the 5,580-line `App.tsx` is a restructuring job, left open.

- **One header helper.** Since the cookie sign-in (audit item 15), every component imported `authHeaders` from `utils/session.ts` as `sessionHeaders` and re-wrapped it in its own local `authHeaders`/`getAuthHeaders` -- eight copies, plus an alias in `App.tsx`. `utils/session.ts` now also exports `jsonHeaders()` (the client header plus `Content-Type: application/json`). Every component imports `authHeaders`/`jsonHeaders` directly, and the ~35 hand-built `{ "Content-Type": "application/json", ...authHeaders() }` objects became `jsonHeaders()`. 13 files, 105 lines removed and 73 added; no request changes what it sends.
- **Typo**: `useHotkeyEngine`'s `targetTargetWindow` option is now `targetWindow`.
- **Unused code**, found with `tsc --noUnusedLocals --noUnusedParameters`, which now reports nothing for `apps/web`:
  - removed: the `FocusZone` import in `App.tsx`; `AdminPanelModal`'s `isLoading` (set, never read); the `currentUser` prop on `ExportModal` and `ImportWizardModal` (and the `UserProfile` imports it needed); three unused test imports;
  - `App.tsx`'s `savingCaseFieldError` was set when saving a case's title, priority or execution type failed, and never shown -- so a failed save went unnoticed. The error now goes to `specEditError`, which the case pane shows, like the other case edits.
- **Found while checking that path live -- blank titles were saved.** `PUT .../test-cases/:caseId` stored an empty title (it did, on DEMO-3), and the suite rename the same for names. Both create routes only checked truthiness, and a name over 255 characters (the `varchar(255)` columns) failed with a 500. New `nameProblem` in `specEditing.ts`: suite create/edit and case create/edit refuse a name/title that's not text, blank after trimming, or over 255 characters, with `400 INVALID_NAME` ("title can't be blank", "name can be at most 255 characters"), and store it trimmed.
- **The title and suite-name boxes revert on a refused save.** `handleUpdateCaseField` and `handleUpdateSuiteName` now return whether the save worked. The uncontrolled inputs put the stored value back when it didn't (and a blank suite name is reverted without a request), instead of showing a name the case or suite doesn't have.

New test: `spec_editing.test.ts` +1 (blank, whitespace-only, non-text and 256-character names and titles each get 400 on suite/case create and edit; valid ones are trimmed; a 255-character name is accepted; other case fields still edit on their own). 555/555; `tsc --noEmit` clean. Verified live in a separate browser origin: sign-in, a title rename (PUT 200), recording a result, the Admin Panel roster and Reports all work with the shared helpers. Clearing a case's title shows "title can't be blank" in the case pane, and the box goes back to the saved title.

## Added: smoke tests for the whole web app (2026-10-09)

The first stage of splitting `App.tsx` (audit item 36). The web app had no component tests -- only pure logic (`hotkeys`, `executionCaseOrder`, `auth_flow`) -- so a safety net came first.

- **New dev dependencies** (`apps/web`, approved by Elliot): `@testing-library/react` 16.3.3, its peer `@testing-library/dom` 10.4.2, and `jsdom` 25.0.1. The new file runs in jsdom via a `// @vitest-environment jsdom` header; every other test stays on node.
- **`apps/web/src/tests/app.smoke.test.tsx`** (7 tests) renders `<App />` against a fake API: one project, plan and run; two suites; three cases. The response shapes were copied from the real server's. The fake records every request. The tests check what a person sees and which requests go out, not internal state, so they survive code moving around:
  - signed out shows the login page;
  - the header shows the project, plan and run;
  - Spec mode shows the suites and cases;
  - selecting a case loads its details and steps;
  - Execute mode shows the queue, and Pass posts `{build_id, test_plan_case_id, verdict}` for the selected run;
  - a Viewer gets no Admin Panel, Import, + Suite or + Case;
  - a 403 on recording shows the "Not permitted" banner.
- **Corrected counts**: there are 31 pure-logic web tests (38 with these). The "web tests 54/54" in several entries above also counted the old worktree's copies (see the worktree entry).

562/562. The tests run in under a second.

## Split `App.tsx` into hooks and components (2026-10-09)

Audit item 36 (`docs/audit_2026-10-07.md`). `App.tsx` was one 5,592-line component: 82 `useState`, 26 effects, 45 `fetch` calls and a 2,600-line render. Planned with Elliot as a pure restructuring in stages, each its own commit and tested by him before the next. No behaviour, style or wording changes; code moved verbatim, comments and dependency lists included.

- **Stage 0**: smoke tests first (the entry above).
- **Stage 1**: pure pieces out:
  - `types.ts` (`CustomFieldEditor` imports its types from there now, not from `App`);
  - `app/messages.ts`;
  - `utils/permissions.ts` (`permissionFlags`) and `utils/suiteTree.ts`, both with unit tests;
  - `utils/autoGrowTextarea.ts` and `hooks/useStepsScrollPreserved.ts`.
- **Stage 2**: `hooks/useToast.ts`, `hooks/usePaneLayout.ts`, `hooks/useSession.ts`.
- **Stage 3**:
  - `hooks/useScope.ts`: the Project/Plan/Run lists and selection, their loaders and request guards, the entity modal, the delete prompts, Close/Open Run.
  - `app/AppContext.tsx`: `useApp()` gives `{ currentUser, handleLogout, handleAuthExpiry, showToast, can, scope }`.
  - `components/layout/AppHeader.tsx` and `StatusBanners.tsx`.
- **Stage 4**:
  - `hooks/useExecutionWorkspace.ts`: the plan's cases for Execute mode.
  - `hooks/useCaseSearch.ts`: the search, filter rows and field catalog.
  - `hooks/useExecution.ts`: the active case, notes, recording results with the optimistic revert, block reasons, queue order.
  - `components/execute/ExecutionPane.tsx`.
  - Loading the cases is its own hook because the search needs the cases and the queue needs the search results.
  - The workspace is typed non-null (it never was null), so the unreachable "Loading High-Density Workspace" gate went.
- **Stage 5**:
  - `hooks/useSpecTree.ts`: the tree, expand state, Show deprecated, plan membership.
  - `hooks/useSpecSelection.ts`: selection, multi-select, the selected suite's case list, drag-and-drop.
  - `hooks/useCaseEditor.ts`: case detail, custom fields, field and step editing, the version lifecycle, case create/delete.
  - `hooks/useSuiteEditor.ts`.
  - `components/spec/CaseDetailPane.tsx` and `SuiteDetailsPane.tsx`.
- **Stage 6**: `components/workspace/SuiteTreePane.tsx` (Pane 1, which took over the Expand-all/Collapse-all values) and `CaseListPane.tsx` (Pane 2).

**How the pieces fit:**
- **Context holds only app-wide state**: the user, permissions, scope, toast and sign-in-ended handler.
- **Every feature hook owns its state and returns one object** (`type X = ReturnType<typeof useX>`), and panes take those objects as props.
- **`App.tsx` keeps** the mode, `execSuiteFilterId`, the suite tree (`suiteNodes`), the main refresh effect, the hotkey wiring (it spans several hooks), the modals and the layout.
- **No requests are made from `App.tsx` itself** any more.
- **Hook order is significant**: `useScope` → `useExecutionWorkspace` → `useSpecTree` → `useCaseSearch` → `suiteNodes` → `useExecution` → the refresh effect → `useSpecSelection` → `useCaseEditor` → `useSuiteEditor` → the hotkeys. Each needs values from the ones before it.
- **One forward reference, on purpose**: `useScope`'s `onProjectSwitched` clears selections owned by `useSpecSelection`, which is called later. That's safe because it only runs from the project picker's change handler, never during render.

**Result:** `App.tsx` 5,592 → 664 lines. `tsc --noEmit --noUnusedLocals --noUnusedParameters` is clean on `apps/web`, the production build works, and `npm test` gives 571/571 (47 in `apps/web`). After every stage the smoke tests passed and the app was checked live in a separate browser origin:
- sign-in;
- the header's create/edit/delete and their banners;
- Close/Open Run;
- Execute: `j`/`k`, `f` + note + Ctrl+Enter recorded and jumped to the next folder, the suite filter, search;
- Spec: a case created → Edit → step added and saved on blur → Approve → deleted; Shift-range and Escape; Collapse all; the New Suite form.

## Removed: the Execute-mode "step drawer" (2026-10-09)

Per direct request. The "Show Drawer (e)" button and the `e` hotkey in Execute mode opened a box that only said step-level logs, artifacts and attachments would go there; nothing behind it was ever built. Removed:
- the button and the box (`components/execute/ExecutionPane.tsx`; the heading now reads "Ordered Step Verification Table");
- `showStepDrawer` (`hooks/useExecution.ts`);
- the `e` key and its `onToggleStepDrawer` option (`hooks/useHotkeyEngine.ts`);
- the `e` rows in the hotkey tables of `docs/rfc_02_ux_density_and_hotkeys.md` and `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`, and the roadmap's never-built `StepExecutionDrawer.tsx`.

Step-level results themselves still work through the API (`step_results` on both result routes); the web app records a verdict for the whole case only.

## Removed: the unused `custom_fields_snapshot` and `assigned_user_id` columns (2026-10-09)

Audit item 33 (`docs/audit_2026-10-07.md`). From the very first schema, `test_plan_cases.custom_fields_snapshot`, `executions.custom_fields_snapshot` and `test_plan_cases.assigned_user_id` (with its index `idx_plan_cases_assigned`) were written as `'{}'` / `null` and never read. Decided with Elliot on 2026-10-01 that results don't record custom field values, so the snapshot was never going to be built.

- **Migration `006_drop_unused_columns`** drops all three columns and the index. Its `down` adds them back with the old defaults.
- **Code**: the two result routes and the batch auto-link stop writing them. `ExecutionRepository.create` and `TestPlanRepository.addCase` lost the `custom_fields_snapshot`/`assigned_user_id` inputs, and `addCasesBulk`, the core-loop seed and `types.ts` lost the columns.
- **Tests**: the inserts in the db and server tests no longer set them. `verification_matrix_acceptance.test.ts`'s "[Req 5] Version Freezing" test used to check a snapshot that only existed because the test itself wrote one; it now checks what the requirement actually guarantees -- the old result is kept, and its plan link stays pinned to version 1. New test in `migrations.test.ts`: after 006 the columns are gone, and rolling back to 005 restores them.
- **Docs**: `docs/rfc_01_domain_model.md` (§2.3 point 4 and the custom-field storage notes), `docs/MASTER_ARCHITECTURE_BLUEPRINT.md` and `docs/01_vertical_slices_roadmap.md` no longer describe freezing custom fields into results or list the columns.

`npm test`: 572/572. `tsc --noEmit` clean on all four workspaces.

## Added: generous rate limits on API tokens, exports and report emails (2026-10-09)

Audit item 32 (`docs/audit_2026-10-07.md`). Nothing limited how often an API token could be used, how often anyone could export a project, or how many report emails they could send. Elliot asked for generous limits, since CI and MCP agents make many more calls than people.

- **New `apps/server/src/services/rateLimits.ts`**:
  - `RateLimiter` is a token bucket per caller: the whole allowance can be used at once, and it refills evenly over the window. Memory is bounded by pruning callers whose allowance has fully refilled.
  - `createServer` decorates each server with its own set (`app.rateLimits`), so counts are per server process, like the per-address sign-in limit.
  - `withinRateLimit(request, reply, limiter, what)` counts one call for `token:<id>` or `user:<id>` and answers `429 RATE_LIMITED` (problem details) with `Retry-After` and a message such as "Too many exports: the limit is 120 per hour. Try again in 30 seconds."
- **The limits:**
  - `API_TOKEN_REQUESTS_PER_MINUTE` = 1,200 per token, for every request made with a token, MCP included. It's checked in `authenticateApiToken` after the token is found valid, once per request (a `WeakSet`), since imports authenticate twice.
  - `EXPORTS_PER_HOUR` = 120 per caller, shared by both export routes.
  - `REPORT_EMAILS_PER_HOUR` = 60 per caller: "Email this report" sends (previews don't count), a schedule's Send now, and the admin's test email. Scheduled sends aren't counted (at most daily each), and the 50-recipient cap per email still applies.
- **Not limited**: requests by signed-in users other than exports and emails. That includes their report reads and MCP calls made with a sign-in rather than a token.
- **Web**: the email dialog, the Scheduled Emails tab and the admin's test email now show a problem-details `detail`, so the 429 message appears instead of "Request failed (429)". The Export dialog already did.
- **Docs**:
  - `docs/reports_api_and_mcp.md` gained a "Rate limits" note for API and MCP users, and its "expires after 15 minutes" is now an hour.
  - `docs/rfc_03_api_and_xml_contracts.md` §7.2 and `docs/rfc_04_rbac_security_matrix.md` (threat vectors 3, 6, 7 and report emails) describe what's built instead of the planned 5-exports-an-hour, Redis and `X-RateLimit-*` designs. The latter also no longer calls the SMTP password unencrypted.

New tests: `apps/server/tests/rate_limits.test.ts` (4):
- the limiter's burst, refill and per-caller separation, and that the defaults stay generous;
- a token at its limit gets 429 on REST and MCP, an import counts once, and another token and a signed-in user are unaffected;
- exports share one allowance, and a token is its own caller;
- previews are never counted, while sends, Send now and the test email share the email limit.

Each test sets a small limiter on its server. `npm test`: 576/576.

## Changed: sign-ins renew while in use -- 8 hours idle, 7 days at most (2026-10-09)

Audit item 31 (`docs/audit_2026-10-07.md`). A sign-in ended exactly 1 hour after signing in, however actively it was being used. The limits were decided with Elliot: 8 hours idle, 7 days at most.

- **New `apps/server/src/sessionLifetime.ts`**: `SESSION_IDLE_SECONDS` (8 h) and `SESSION_MAX_SECONDS` (7 d).
- **Login** (`routes/auth.ts`): the session row starts with 8 hours. The JWT's `exp` and the web cookie's `Max-Age` are the 7-day maximum, so nothing needs re-issuing: the server-side session decides when the sign-in really ends. `SESSION_LIFETIME_SECONDS` is gone.
- **Every request** (`authenticateRequest`) extends the session via the new `SessionRepository.extend`: its end moves to 8 hours from now, capped at 7 days after sign-in. The write is skipped unless it moves the end by more than a minute, so a busy session costs at most one update a minute, and a failed write never fails the request. A session older than 7 days is refused even if its stored end is ahead.
- **Unchanged**: sign-out, a password change, an admin's reset and disabling a user still end sessions at once. An ended sign-in still sends the web app back to the login page with "Your sign-in has ended". Scripts that sign in with a login JWT get the same renewal; API tokens are unaffected.
- **Docs**: `docs/rfc_04_rbac_security_matrix.md` §4.1 now describes the real design (no refresh tokens, RSA keys or Redis), and `docs/reports_api_and_mcp.md` the new lifetime.

New tests: `apps/server/tests/session_lifetime.test.ts` (5):
- the limits are 8 h / 7 d;
- sign-in gives a 7-day token and cookie and an 8-hour session;
- a request extends a nearly-idle session to 8 hours, and an idle-expired one gets 401 `SESSION_ENDED`;
- extension stops at the 7-day mark, and a session past 7 days is refused;
- `extend` skips writes under a minute.

`npm test`: 581/581.

## Added: limiting users to some projects -- a "No Access" role, and the web app uses each project's permissions (2026-10-09)

Audit item 30 (`docs/audit_2026-10-07.md`). Checked first what was still true:
- **The server already handled access per project.** A project role replaces the global role in that project, overrides can be per project, and the project list and every route respect it (items 6 and 7).
- **The gaps:**
  - There was no way to say "only these projects": a global role applies to every project, including later ones, and there was no empty role to use instead.
  - The web app decided its buttons and modes from the user's *global* permissions. A user who was a Tester only inside one project was forced into Execute mode and shown nothing to edit, though the server allowed it.

Decided with Elliot: a built-in No Access role, used as a global role plus project roles. New users still default to Tester.

- **`No Access` role** (`packages/core/src/rbac/registry.ts`):
  - an empty bundle, appended last in `DEFAULT_ROLE_PERMISSIONS` (the seed derives role ids from position, so the others keep theirs);
  - new `NO_ACCESS_ROLE` and `DEFAULT_ROLE_DESCRIPTIONS`; it's the only built-in with a description.
  - `seed_rbac_registry.ts` runs on every start, so existing databases get the role too. Its role insert now uses `onConflict(doNothing)` for any conflict, so an admin's own role with that name doesn't stop startup.
- **`GET /api/v1/projects`** (`routes/projects.ts`) returns each visible project with `permissions`: the caller's effective permissions there (via `permissionsInProject`). The rule for which projects are visible is unchanged.
- **Web**:
  - `useScope` keeps each project's `permissions` (`EntityItem.permissions`) and exposes `selectedProjectPermissions`. It reloads the list after creating a project, and an edit keeps the permissions.
  - `App.tsx` computes `can` from the selected project's permissions (falling back to the global ones until a project is selected) and `globalCan` from the global ones. Both are in `AppContext`.
  - Everything follows the project's permissions -- panes, Execute mode (`useExecution`'s option is now `permissions`), Reports, Import/Export, editing or deleting the project, plans and runs -- except the Admin Panel button and "Create project", which use `globalCan`.
  - Execute-only mode is only forced once the selected project's permissions are known, so a project-only user isn't moved off Spec mode by their empty global ones.
  - When admins change their own access, the project list reloads too.
- **Admin Panel**:
  - The roster and the Matrix's user list show "+N project roles", or "sees no projects" for a No Access user with none; the No Access badge is grey.
  - In the Matrix, the project role dropdown's empty choice said "(No Explicit Access)" but meant the opposite; it now reads "Same as global role (X)". New text under the global role and the project roles says how they combine and how to limit someone with No Access.
- **Docs**: `docs/rfc_04_rbac_security_matrix.md` lists the role and gains "Limiting a user to some projects".
- **Not changed**: a user who has `PROJECT_CREATE` only through an override, with No Access globally, can create a project they then can't see. The Admin Panel's tabs still go by global permissions, so a Test Lead who's one only in a project doesn't get the API Tokens tab.

New tests:
- `apps/server/tests/project_access.test.ts` (3):
  - No Access exists, grants nothing, and such a user sees no projects;
  - a project role gives access to just that project, and a project created later stays hidden;
  - the list carries per-project permissions that differ from the global role, and an admin's carries the full set.
- `apps/web/src/tests/app.smoke.test.tsx` (+1): a No Access user with Tester permissions in the project gets Spec mode, "+ Suite" and Export, but no Admin Panel or Create project.
- Updated for 6 built-in roles: `rbac.test.ts`, `role_templates.test.ts`, `admin_roles_and_overrides.test.ts`.

`npm test`: 585/585. Checked live: a No Access user with a Tester role in the demo project sees only that project, with the Tester's controls; the admin's roster shows "No Access · +1 project role".

## Added: a production build -- one bundled server that also serves the web app (2026-10-11)

Audit item 29 (`docs/audit_2026-10-07.md`). The server only ran under `tsx` (a development runtime that compiles TypeScript on the fly), and nothing served the built web app: only Vite's dev proxy put the app and the API on one address.

- **`npm run build`** (root) builds the web app (`apps/web/dist`, Vite) and then the server (`apps/server/scripts/build.mjs`, esbuild): `apps/server/dist/server.js` plus a source map. Our workspace packages (`@testify/core`, `@testify/db`) are TypeScript source, so they're bundled in; every other dependency stays external and loads from `node_modules`. The build clears `dist/` first (it used to hold stale `tsc` output). New dev dependency `esbuild` (already in `node_modules` via Vite; installed offline). `apps/server` also gained `npm run typecheck` (`tsc --noEmit`), which the old `build: tsc` effectively was.
- **`npm start`** (root, or `--workspace=apps/server`) runs `node dist/server.js` -- plain Node 22+ (root `engines`), no tsx. `DATABASE_URL` is still required (unchanged rules, see "Running things").
- **The server serves the web app** (`apps/server/src/webApp.ts`, `registerWebApp`), via Fastify's not-found handler, so every API route keeps priority:
  - a file in the build is served with its type and `X-Content-Type-Options: nosniff`; `/assets/...` (content-hashed names) are cached for a year (`immutable`), everything else `no-cache`;
  - any other address without a file extension gets `index.html` (`no-cache`), so reloads and `#/reports/...` links work and a new build is picked up on the next load;
  - `/api/...` and `/mcp/...`, methods other than GET/HEAD, and missing files with an extension keep Fastify's usual JSON 404;
  - a path that resolves outside the build folder (`..`, encoded or not, or a NUL) is a 404.
- **Where the build is** (`resolveWebDistDir`, `config.ts`): `WEB_DIST_DIR` if set (it must contain an `index.html`, else a `ConfigError` stops startup), otherwise `apps/web/dist` if it has been built, otherwise none -- then only the API is served and startup says so. `createServer(connectionString?, { webDistDir })` takes it as an option; tests and `npm run dev` don't pass one, so development is unchanged (Vite on :3000).

New tests: `apps/server/tests/production_build.test.ts` (6 -- index.html for `/` and app addresses, never cached; files with their types and the asset cache header, HEAD; JSON 404s for missing files, unknown API routes and POSTs while real routes still answer, and traversal refused; API-only without a build; `WEB_DIST_DIR` rules; and a real `scripts/build.mjs` then `node dist/server.js` child process serving the app, `/auth/me` 401 and a working login). 591/591. Verified live: `npm run build`, then the built server with plain Node served the app; signing in and using it in a separate browser tab worked; `/mcp` still answered.

Not done here (items 27/28): no README/deployment guide, Dockerfile or CI; no health endpoint or request logging.

## Added: a health endpoint and request logging; JWT_SECRET is required on a real database (2026-10-11)

Audit item 28 (`docs/audit_2026-10-07.md`). There was no way for a load balancer or monitor to check the server, nothing was logged per request (`logger: false`), and with a real database a missing `JWT_SECRET` only printed a warning -- the server then signed with a random secret, so every restart signed everyone out and several instances rejected each other's sign-ins.

- **`GET /api/v1/health`** (`apps/server/src/observability.ts`, `registerHealthRoute`), no sign-in: runs `select 1` against the database with a 3-second limit (`HEALTH_DB_TIMEOUT_MS`) and answers `200 {status: 'ok', database: 'ok', uptime_seconds}`, or `503 {status: 'unavailable', database: 'unreachable', ...}` when the query fails or times out (the failure is logged). `Cache-Control: no-store`; HEAD works. It reports nothing about data or the version.
- **Request logging** (Fastify's built-in pino logger, no new dependency): one JSON line per finished request on stdout -- `reqId`, `method`, `url`, `status_code`, `response_time_ms`, and `user_id` or `api_token_id` when known (`registerRequestLogging`). Fastify's own two-lines-per-request logging is off (`LogController({ disableRequestLogging: true })`). Headers and bodies are never logged, so cookies, tokens and passwords stay out. Successful health checks log at `debug` only. Request ids are UUIDs (were `req-1`, `req-2`... restarting each start) and every reply carries `X-Request-Id`, the same id a 500 reply's `request_id` shows. `logServerError` now writes through the request's logger (a JSON line with the error and its stack), so an unexpected error's log line carries that id.
- **`LOG_LEVEL`** (`resolveLogLevel`, `config.ts`): `fatal|error|warn|info|debug|trace|silent`, default `info`; anything else stops startup with a `ConfigError`. The test suite is silent unless `LOG_LEVEL` is set. Startup banners (in-memory warning, generated admin password, "listening on") are still plain console lines.
- **`JWT_SECRET`** (`resolveJwtSecret`, `config.ts`): set, it must be at least 32 characters. Unset, the in-memory database gets a random per-process secret as before; a real database stops startup with a message saying how to generate one. It's checked before migrations run, so nothing touches the database first. Two tests that start a "real database" server (`initial_admin`, `secrets`) now set one; `sessions.test.ts`'s secret was lengthened to 32+.
- `createServer` takes a test-only `logStream` option to read the log.

New tests: `apps/server/tests/observability.test.ts` (5 -- the `JWT_SECRET` and `LOG_LEVEL` rules; a real-database server without `JWT_SECRET` refuses to start; health is 200 without sign-in and 503 once the database is gone; one log line per request with the user id and response time, matching `X-Request-Id`, health not logged at info, an unexpected error logged with its request id, and no token, password, cookie or `Bearer` anywhere in the log). Verified live on a throwaway server: health 200 with `X-Request-Id`; a failed sign-in and an unauthenticated request each logged one line; `DATABASE_URL=postgres://...` without `JWT_SECRET` stops with the message.

Not done (item 27): no README/deployment guide, Dockerfile or CI. The roadmap's `/health` and `/api/v1/system/info` examples (`docs/01_vertical_slices_roadmap.md`) still differ from what's built -- item 38's stale docs.

## Added: README, deployment guide, Docker image and CI (2026-10-11)

Audit item 27 (`docs/audit_2026-10-07.md`). Nothing told a newcomer how to run Testify, there was no way to deploy it beyond reading the code, and nothing ran the tests on a change. Decided with Elliot: GitHub Actions for CI, and the Docker setup was built and run here (the base images and packages were downloaded with his go-ahead).

- **`README.md`**: what Testify does, development quick start (incl. the dev fixture users and `report-demo.ts`), running it for real (Compose or `npm run build` + `npm start`), development commands, the workspace layout, the API/MCP pointers, license.
- **`docs/deployment.md`**: Compose and plain-Node setups, every environment variable, HTTPS/reverse proxies (`TRUST_PROXY`, `client_max_body_size` for 50 MB imports, the email link address), health and logs, backups (`pg_dump`; keep `JWT_SECRET`/`SECRETS_KEY` too), upgrades (migrations forward-only), several instances (which limits are per instance), and a security checklist.
- **`Dockerfile`** (multi-stage, `node:22-slim`): the build stage runs `npm ci` and `npm run build`; the runtime stage installs only the server's production dependencies (`npm ci --omit=dev --workspace=apps/server`) and copies `apps/server/dist` and `apps/web/dist`, keeping the repo layout so the server finds the web build. `NODE_ENV=production`, runs as `node`, port 3001, a `HEALTHCHECK` on `/api/v1/health`, `--enable-source-maps`. 426 MB. `.dockerignore` keeps `node_modules`, `dist`, `.git`, `.claude` and `.env` out.
- **`docker-compose.yml`** + **`.env.example`**: Testify and `postgres:17-alpine` (data in a named volume, `pg_isready` health check, Testify waits for it). `POSTGRES_PASSWORD` and `JWT_SECRET` are required (Compose refuses to start without them); `SECRETS_KEY`, `ADMIN_PASSWORD`, `TRUST_PROXY`, `LOG_LEVEL`, `TESTIFY_PORT` optional.
- **`.github/workflows/ci.yml`**, on every push and pull request:
  - typecheck, `npm test`, `npm run build`;
  - the production build on a real PostgreSQL service: start it, load `report-demo.ts` through the API, restart, and check the web app is served and the data and admin sign-in survived;
  - `docker build`.
- Root `npm run typecheck` (all four workspaces). The startup line is now `[testify] Listening on <address>` (was "Core Loop Fastify Server listening on"); `production_build.test.ts` waits for it.

**First run on real PostgreSQL.** Until now every test and dev session used in-memory PGlite. Through Compose, against `postgres:17`, this all worked with no code changes:
- first start with a generated admin password, the forced password change, `report-demo.ts` (8 runs, batches, manual results);
- all reports incl. Markdown, case search, a CSV export, a multipart TestLink import, and MCP `list_projects`;
- a restart keeping data and existing sign-ins.

Twelve cases created at once got twelve distinct consecutive ids (DEMO-14..25). That's the concurrent case-creation race of item 23, which couldn't be shown on PGlite's single connection. The CI job's Postgres steps were also run locally against a Postgres container. The workflow itself hasn't run on GitHub (no remote yet).

## Changed: CLAUDE.md is a guide again; this change log moved out of it (2026-10-11)

Audit item 37 (`docs/audit_2026-10-07.md`). `CLAUDE.md`/`AGENTS.md` had grown to 1,825 lines, nearly all dated entries. That made current facts hard to find and left stale ones in place: "fresh seeded DB on every restart", "15-minute JWT", a `packages/core` description saying the RBAC and custom-field modules don't exist, "slices 3-4 not started", and a "Notable gaps" entry for `PUT /api/v1/test-case-versions/:versionId`, a route removed on 2026-09-18.

Decided with Elliot: a guide plus a separate log.
- **The log:** every dated entry moved here unchanged (120 entries), under a header explaining that entries describe the code as it was at the time.
- **`CLAUDE.md`** (~270 lines, `AGENTS.md` identical) is rewritten to describe the present:
  - what Testify is and what isn't built;
  - how to run it;
  - the repo layout;
  - domain rules (versions, plans and retirement, results, custom fields, search and ids, deleting);
  - auth and permissions;
  - server and web conventions;
  - the decisions to keep;
  - known gaps;
  - testing and the workflow.
- **Fact checks:** facts were checked against the code while writing. Found and recorded as gaps: plan and run create/edit/delete write no audit entry; `AuditLogRepository` is used only by tests; Recharts 2 is deprecated upstream. An initial "no native checkboxes" claim was wrong (the email settings and schedule forms use them) and was corrected.
- **New workflow:** each change adds an entry at the end of this file; `CLAUDE.md` changes only when a fact, convention, decision or gap changes.

Docs only; no code changed.

## Changed: the design documents now match the code (2026-10-11)

Audit item 38 (`docs/audit_2026-10-07.md`), the last open audit item. The design documents in `docs/` and `.antigravity/` described a system that differed from the code in dozens of places, not only the four the audit listed:
- token prefixes `tl_`/`tk_` and Argon2 hashing;
- Redis sessions and refresh tokens;
- a SQLite schema;
- `IN_REVIEW`;
- routes and npm scripts that don't exist, and libraries that aren't used;
- broken `file:///` links.

Decided with Elliot: correct every design doc against the code, except RFC 03's API contract (§1-4). That part gets a note saying it's the original design, because the API and MCP are about to be revisited.

Facts were checked against the code as each doc was written, including a schema dump from a fresh database built by the real migrations.

**What changed, document by document:**
- **RFC 04 (security):** rewritten to the code:
  - the 19 permission keys and six roles;
  - per-project evaluation with overrides, and the AdminGuard rules;
  - sessions, cookies and CSRF;
  - `tf_ci_` tokens, stored as a SHA-256 digest and capped by the issuer;
  - the real `audit_logs` schema and the actions actually written;
  - the threat model with its real mitigations (in-memory token buckets and lockouts, not Redis or Argon2);
  - verification pointing at the real test files.
- **RFC 03:** a note on §1-4. §5-9 rewritten:
  - batch-write patterns as built;
  - attachments, retention and webhooks marked not built;
  - the five import formats with their real mappings, limits, field mapping and duplicate rules;
  - authentication as built;
  - corrected sequence diagrams, and a status table.
- **RFC 02:**
  - real pane sizes, and the Spec/Execute/Reports modes;
  - the real hotkey table: `f`/`b` record at once, `Ctrl+Enter` re-records with notes and jumps to the next suite, no `e`, no defect modal;
  - permission gating as built, and the optimistic rollback (no store, queue or retry);
  - responsive layouts and the light theme marked not built;
  - the TREE and LIST focus zones are noted as unused.
- **RFC 01:**
  - **§3:** rebuilt from the real schema as a table-by-table data dictionary instead of hand-written DDL, adding the missing tables: users, `user_roles`, sessions, API tokens, report schedules, `last_email`.
  - **Conventions:** no CHECK constraints (values checked in code); mixed integer and boolean flags; UUIDv7 and v4 ids.
  - **Version pinning:** re-pinning on approve, and retired plan links.
  - **State machines:** corrected; results described as append-only rows, with no optimistic-concurrency versions.
- **Blueprint:** rewritten as a short overview that links to the RFCs instead of copying their schema, hotkeys and permission tables (the copies had drifted). Its requirement matrix now gives each requirement's real status.
- **Roadmap:** rewritten to record, per slice, what was planned, what was built (with real routes and modules), how it's verified (real test files), and what differs.
- **Requirements alignment** (`docs/00_...` and its `.antigravity` copy, now identical): the locked decisions kept, with "As built" notes. These cover the purge and attachments, unfrozen custom fields (decided 2026-10-01), hotkey scope, extra formats, and the duplicate toggle and progress bar.
- **Planning briefs** (`.antigravity/agents/*.md`): a note on each saying it records what was asked for, not what was built, and where to look. Old token prefixes and `BUILD_MANAGE` corrected.
- **`CLAUDE.md`:**
  - the doc map describes the updated docs;
  - the "design docs are stale" gap is replaced by the RFC 03 §1-4 note;
  - a new workflow rule: fix a design doc in the same change that makes it wrong.

Every item of the 2026-10-07 audit is now fixed. Docs only; no code changed.

## Removed the audit list; added the API & MCP roadmap (2026-10-11)

- **Audit list removed:** `docs/audit_2026-10-07.md` is deleted, since every item is fixed. Each fix has its own entry in this log, and "Audit item N" in older entries refers to that file, which is still in git history. One fix remains open from it, as a known gap in `CLAUDE.md`: plan and run changes write no audit entry.
- **New `docs/api_roadmap.md`:** where the API stands (what's good and what's weak, with concrete examples), what an OpenAPI spec and "try it" docs page are and how they'd fit Fastify, and seven next steps:
  1. consistency;
  2. versioning;
  3. the OpenAPI spec and docs page;
  4. paging;
  5. CI integration;
  6. MCP write tools;
  7. webhooks.

  Each step has a recommendation, open questions and a status line. The file also gives a recommended order and has a Decisions table.
- **`CLAUDE.md`:** points to it in the doc map and the workflow, in place of the audit file.

## Changed: database tables renamed to test runs and results (API consistency, stage 1 of 4) (2026-10-11)

The first stage of making the API consistent (`docs/api_roadmap.md` step 1).

**Decided with Elliot:**
- shallow addresses;
- short path names;
- rename in the database too;
- no aliases for the old addresses.

The decisions and the four stages are recorded in the roadmap's Decisions table. This stage renames the database and the code that talks to it; the API itself is unchanged until stage 3.

- **Migration `007_rename_runs_and_results`:**
  - `builds` → `test_runs`;
  - `executions` → `test_results`, with `build_id` → `test_run_id`, `execution_duration_ms` → `duration_ms` and `execution_timestamp` → `executed_at` (the names the batch API already used for those fields);
  - `execution_steps` → `test_step_results`, with `execution_id` → `test_result_id`;
  - their primary keys, foreign keys, unique constraint and indexes renamed to match.

  `down` reverses it all.
- **What isn't renamed:**
  - Audit-log rows that say "build" or "execution" stay as they are, since the table is append-only.
  - `execution_type` (manual/automated) and the permission keys `EXECUTE_RUN`/`EXECUTE_OVERWRITE` are a different concept and stay.
- **Code** (`packages/db`):
  - `BuildRepository` → `TestRunRepository` (`test_run.repository.ts`), `ExecutionRepository` → `TestResultRepository` (`test_result.repository.ts`), with their types and methods: `findByBuild` → `findByRun`, `getExecutionSteps` → `getStepResults`, `getExecutionStepsForExecutions` → `getStepResultsForResults`;
  - internal row fields: `test_result_id`, `executed_at`, `duration_ms`;
  - `blockedExecutionCount`/`blockedBuildCount` → `blockedResultCount`/`blockedRunCount`;
  - every query, the seeds and the comments.

  The server's queries, inserts (the single-result and batch routes), services and `packages/core`'s case-history input follow. Responses keep their current field names (`latest_execution_id`, the export file's `execution_timestamp`, ...) until stage 3.
- **Tests:**
  - `migrations.test.ts` +1: a database at 006 holding a run, a result and a step result migrates to 007 with everything under the new names. The foreign keys still hold, with their new names, and rolling back restores the old tables and data.
  - The 006 test is adjusted for the renamed table, and `execution_reporting.repository.test.ts` is renamed `test_result_reporting.repository.test.ts`.
- **Docs:** RFC 01's table dictionary and diagrams, the blueprint, RFC 03 §3.2 and CLAUDE.md use the new table names.

597/597 tests pass and typecheck is clean. Verified live against a production build on an in-memory database:
- the demo data loads;
- Spec and Execute modes load;
- a hotkey verdict records;
- Reports count it.

Not yet run against real PostgreSQL (the Docker images were removed); CI's PostgreSQL job covers it once pushed.

## Changed: one error format for the whole API (API consistency, stage 2 of 4) (2026-10-12)

Stage 2 of making the API consistent (`docs/api_roadmap.md` step 1). Errors came in two shapes:
- a plain `{ error, code }` from about 185 places in the server;
- problem details from the shared helpers in `errors.ts`.

Some routes even put a code in `error` and the message in `message`. The web app read messages in about 70 different ways (`data.error || data.detail || …`).

- **One format** (`apps/server/src/errors.ts`): every error is RFC 7807 problem details, sent as `application/problem+json`. The fields are `type`, `title` (the standard HTTP status name), `status`, `code`, `detail` (the human message), `instance` (the request path), `timestamp`, optional `invalid_params: [{ name, reason }]`, and extension fields such as `required_permission` (was camelCase `requiredPermission`), `project_ids` and `retry_after_seconds`.
- **The new `sendError(reply, status, detail, { code?, invalid_params?, ...extensions })`** sends it. `code` defaults from the status (`404` → `NOT_FOUND`, `403` → `FORBIDDEN`, …), and validators' `{ param, reason }` lists are normalized to `{ name, reason }` (`reportErrorParams`). `sendProblemDetails` and every `send*Error` helper now go through it.
- **Converted:**
  - All 186 old-format sends in 17 files, by a script that parses each error object. Where `error` held a code (`INVALID_PARAMS`, `SECRETS_KEY_REQUIRED`, …), it became `code`, and `message` became `detail`.
  - Case search and the report routes now return their validation problems as `invalid_params`.
  - The two hand-built 422s in the single-result route use the helper.
- **Server-wide:**
  - The global error handler answers Fastify's own errors (bad JSON, body too large) in the format with the standard code for the status, keeping Fastify's message.
  - Unexpected errors keep the generic message and `request_id`.
  - Unknown addresses get a problem-details 404, with or without a web build.
- **Kept as they are:**
  - The MCP endpoint's errors, which the JSON-RPC protocol defines.
  - The health check's 503 body.
  - A batch request's per-item results, which are data inside a normal response.
- **Web:**
  - New `apps/web/src/api/errors.ts` with `errorMessage(body)` (reads `detail`, then the old fields, so it also copes with anything unconverted) and `errorCode(body)`.
  - The ~70 message reads in 15 files use it. Four components already had a state variable named `errorMessage`, so they import it as `apiErrorMessage`.
  - The smoke test's fake API answers in the new format.
- **Stage 1 fix:** stage 1's rename script had also changed a field name in one error message (`'executions'` → `'test_results'`, in the batch route) and a test title. Both are restored.

New test: `apps/server/tests/api_conventions.test.ts` (8). It checks every kind of error for the full problem-details shape and that the old `error`/`message` fields are gone:
- 400: invalid body, bad JSON, ids from different projects with `project_ids`;
- 401, including an ended sign-in;
- 403, with `required_permission`;
- 404: an unknown item and an unknown address;
- 409;
- 422: a closed run;
- 400 with `invalid_params`;
- 413;
- 429, with `Retry-After`;
- 500, with a request id and no internals.

About 25 existing assertions moved from `error` to `detail` or `code`.

605/605 tests pass and typecheck is clean (incl. no unused code in `apps/web`). Verified live on a production build:
- a wrong password still shows the sign-in page's own message;
- creating a project with a taken prefix shows the server's message, "Prefix 'DEMO' is already used by another project".

## Changed: one address style, verbs and names across the API (API consistency, stage 3) (2026-10-12)

Stage 3 of `docs/api_roadmap.md` step 1, as planned with Elliot. Nothing outside Testify used the API, so the old addresses were changed outright, with no aliases.

- **Addresses:** lists and creation sit under the parent, and each item has its own address. The full route map is in `docs/api_roadmap.md`. Examples:
  - `/projects/:projectId/plans/:planId` became `/plans/:planId`; `.../plans/:planId/builds` became `/plans/:planId/runs`; a run is `/runs/:runId`.
  - `POST /executions` became `POST /runs/:runId/results` (the run id is no longer in the body); the CI batch route became `POST /runs/:runId/results/batch`, with the list under `results`.
  - Suites, cases and versions: `/projects/:id/suites`, `/suites/:id`, `/projects/:id/cases`, `/cases/:id`, `/cases/:id/versions` (new draft), `/cases/:id/versions/latest`, `/versions/:id` and its `/approve`, `/deprecate` and `/restore`.
  - Custom-field values: `/cases/:id/custom-fields[/:definitionId]`, the same under `/suites/:id`.
  - Plan membership of a whole suite: `POST`/`DELETE /plans/:id/suites/:suiteId/cases` (replacing `cascade` with an `action` in the body).
  - `spec-move` became `/projects/:id/move`. Imports moved under `/projects/:id/imports/...`, so `target_project_id` is gone. `exports/execution-results` became `exports/results`. API tokens are deleted at `/api-tokens/:id`, report schedules changed at `/report-schedules/:id`, and `admin/email-last` became `admin/last-email`.
  - `PUT /auth/credentials` became `PATCH /auth/me`, with snake_case fields `username`, `email`, `password`, `current_password`.
  - The single-result route moved out of `server.ts` into `routes/results.ts`.
- **Working out the project:** `resolveRequestProject` (`middleware/auth.ts`) now collects the project of every id the request names, in the path, query and JSON body, and stores it as `request.projectId`. A request naming ids from two projects gets `400 PROJECTS_DIFFER`; before, an explicit project id won and the other ids were only checked by some routes. Several tests that expected a 404 for "an id from another project" now expect this 400.
- **Verbs and status codes:**
  - Partial updates are `PATCH`. `PUT` stays only where the body replaces the whole thing: custom-field values, a user's override set, a report schedule and the email settings (the last two decided while converting, since a missing field in those bodies clears it).
  - Create answers 201 with the item wrapped in its name; update 200 the same way; delete 204 with no body. Newly wrapped: adding a case to a plan (`{ plan_case }`), changing a user's status (`{ user }`), and a password reset (`{ user, sessions_ended, temporary_password? }`).
  - Removing a whole suite from a plan still answers 200, with the counts the web app shows.
  - "Delete anyway" is always `?force=true`.
- **Names:** ids are named after their database columns everywhere (`test_plan_id`, `test_run_id`, `test_case_id`, `test_suite_id`, `test_plan_case_id`, `test_case_version_id`, `test_result_id`), including report parameters, case-search bodies and export scopes. No response says "build" or "execution" any more:
  - the Execute queue returns `runs` and `latest_test_result_id`;
  - a recorded result returns `{ result, run_status }`;
  - the case-history report returns `results` (`test_result_id`) and `total_results`;
  - batch per-item results use `detail` and `code`;
  - "in use" errors count `results` and `runs`, and name `test_plan_id` etc. in `invalid_params`;
  - error codes `RUN_CLOSED`, `RUN_IN_USE`; new audit rows `RESULT_RECORDED`, `RESULTS_BATCH_RECORDED`, `RUN_AUTO_CLOSED` (old rows keep their names; auto-close accepts both).
  - The CI runner's own `runner_info.run_id` (the CI system's run id) keeps its name; an earlier rename had wrongly changed it in a test.
- **Migration `008_rename_report_schedule_fields`** rewrites `plan_id` to `test_plan_id` inside stored report schedule sections (unreadable JSON is left alone); `down` reverses it.
- **Server internals:** `build*` variables in routes and services became `run*`, and comments naming old addresses were updated.
- **Web:**
  - New `apps/web/src/api/routes.ts` holds every API address as a function (`api.planRuns(planId)`, `api.run(runId, force)`, ...), with `withQuery` for query strings. All ~80 `fetch` calls use it.
  - The app's types use the API names (`test_plan_case_id`, `test_case_id`, `latest_test_result_id`, `workspace.run`).
  - The Export dialog says "Run" instead of "Build".
  - Removing a whole suite from a plan is a `DELETE` with no body.
- **Demo script** (`apps/server/scripts/report-demo.ts`) uses the new addresses.

Tests:
- Every server test moved to the new addresses and fields (a script did most of it, then the rest by hand). The import test for "no project given" was removed, since the project is now part of the address.
- `api_conventions.test.ts` gained 4 tests: creates answer 201 with a wrapped item and deletes 204 with no body, across ten kinds of item; partial updates are `PATCH` and the old `PUT` is gone; no field in nine kinds of response is called build or execution; fifteen old addresses answer 404.
- `migrations.test.ts` +1 for 008, including rollback.
- The web smoke test's fake API uses the new addresses and checks that a recorded result no longer sends `build_id`.

609 tests pass and typecheck is clean. Verified on a production build in a separate origin, with the demo data loaded: Spec mode loads; removing a suite with results from the plan asks first and then removes it, and adding it back works; Edit, adding a step, and Approve; recording a result with `p`; Close Run and Open Run; creating and deleting a plan and a run; the Reports overview, run summary and case history; and in the Admin Panel adding a user, disabling them and resetting their password. MCP `list_plans_and_runs` works with a token, and `POST /api/v1/executions` now answers 404.

Still to do (stage 4): RFC 03 §1-4 and `docs/reports_api_and_mcp.md` still show the old addresses.

## Docs: RFC 03 now describes the API as built (API consistency, stage 4) (2026-10-12)

The last stage of `docs/api_roadmap.md` step 1, which is now Done.

- **`docs/rfc_03_api_and_xml_contracts.md` §1-4 rewritten.** They used to be the original design (cursor paging, `/test-suites`, `/builds`, `/executions`, an OpenAPI router), with a note saying none of it was built. They now describe the API as it works:
  - §1: who uses the API, and the conventions: addresses, verbs, status codes, bodies, id names, how the project is worked out from the ids, authentication, paging (none yet, except case history), validation.
  - §2: the full route map, plus two examples (creating a case, recording one result). It's the one place the map is kept; the roadmap links to it instead of repeating it.
  - §3: the CI batch request and response as they really are (`results`, `test_result_id`, per-item `code`/`detail`/`invalid_params`, `run_status`, 207 vs. 201, `all_or_nothing`).
  - §4: the problem-details format field by field, the closed-run example, and the error codes by status.
  - §5-9: import, rate-limit, webhook and diagram addresses updated; the summary table marks the conventions and error format as built.
  - Checked by script: every route registered in `apps/server/src/routes/` appears in the §2 map.
- **`docs/reports_api_and_mcp.md`:** report parameters are `test_run_id`, `test_plan_id`, `test_case_id`; case history returns `results`; the CI and schedule addresses are the new ones; schedule sections use `test_plan_id`; an id from another project is `400 PROJECTS_DIFFER`.
- **Other docs:** RFC 01 (table names, `RUN_CLOSED`, the batch address), RFC 02 (the result address), RFC 04 (token and result addresses, `PATCH` for roles, new audit action names with the old ones noted), the blueprint, the slices roadmap, `00_requirements_alignment.md` (both copies; "as built" notes beside the original codes and dry-run address), and the README (new CI address and a pointer to the API reference). The `.antigravity/agents/` briefs were left alone: they record what was asked for.
- **`docs/api_roadmap.md`:** step 1 marked Done; "Where the API stands" updated (consistent now; documented by hand; still no OpenAPI spec or paging).
- **`CLAUDE.md` / `AGENTS.md`:** the route conventions point to RFC 03 §1-4 (to be kept current when a route changes); the known gap about RFC 03 is removed.
- **Code:** two report-parameter descriptions in the catalog said "executions"/"executed" (`case_history.limit`, `test_health.stale_days`); they now say "results".

609 tests pass and typecheck is clean.

## Added: an OpenAPI spec and a docs page at /docs (API roadmap step 3, stage 1) (2026-10-12)

The first stage of `docs/api_roadmap.md` step 3. Decided with Elliot: Swagger UI for the page (it serves all its files from Testify, so it works without internet access), and the page and spec open to anyone (they describe the API, not data). New packages, installed with his OK: `@fastify/swagger` 9 and `@fastify/swagger-ui` 5 (about 3.4 MB); `ajv`, already installed as a Fastify dependency, became a direct dependency of `apps/server`.

- **The page:** Swagger UI at `/docs` titled "Testify API", without the Swagger top bar; the spec at `/docs/json` and `/docs/yaml` (OpenAPI 3.1). "Try it out" sends real requests: with the browser's session cookie (the page adds the `X-Testify-Client: web` header that cookie changes need), or with a token under "Authorize". The spec's introduction explains the three ways to authenticate and the API conventions. Routes without a schema yet are left out.
- **Where the schemas live:** `apps/server/src/openapi/`:
  - `index.ts`: registers the spec, the page, request validation and the test-time response check.
  - `schemas.ts`: shared schemas (`Problem`, `User`, `Project`, `Plan`, `Run`, `RecordedResult`) that become `#/components/schemas/...`, and helpers for wrapped items, lists, error responses, `?force=true` and `handlerValidated`.
  - `areas/auth.ts`, `areas/projects.ts`: the route schemas for this stage.
- **Documented in this stage (18 routes):** sign-in (login, logout, `GET`/`PATCH /auth/me`), projects, plans, runs, recording one result, and CI batches. Each has a summary, a description (permission needed, what `force` does, which errors to expect), its parameters and body, and every response.
- **Requests are validated against the schemas.** Bodies are taken exactly as sent (a number isn't accepted for a string); query strings and path parameters are coerced, since they're always text. A mismatch answers `400 INVALID_REQUEST` with `invalid_params` naming each field in plain words ("name is required", "status must be one of: ACTIVE, LOCKED, ARCHIVED"); the global error handler formats it. The single-result and batch routes keep their own checks (codes `INVALID_RESULT`, `UNKNOWN_STEP`...), so their body schemas are documentation only (`handlerValidated`). Validation runs before the sign-in check, so a malformed request without a sign-in gets 400 rather than 401.
- **Responses are never changed by schemas:** they're serialized with plain `JSON.stringify`, so a schema can't drop a field.
- **Tests keep the spec honest:** `createServer({ checkResponses })`, on whenever `NODE_ENV=test`, checks every JSON response against its route's schema, counting undocumented fields as mismatches. A mismatch answers 500 and prints `[openapi] <route> <status>: response doesn't match the spec: <field> <reason>`, so every existing server test is now also a contract test. An error status a route doesn't list is checked against the general `Problem` shape. The whole suite passes with no mismatch.
- **Production:** the bundled server serves the page's files from `node_modules`; the production-build test now checks `/docs`, a Swagger UI file and `/docs/json`.

New tests: `apps/server/tests/openapi.test.ts` (4): the page and spec need no sign-in, and the page sends the CSRF header; the spec is OpenAPI 3.1, every `$ref` resolves, every operation has a summary, a tag and a success response, the 18 routes are all there, and login needs no credential; a malformed request gets `INVALID_REQUEST` naming each field (no body coercion), while the results route keeps `INVALID_RESULT`; a route whose response doesn't match its schema fails with the field named. `production_build.test.ts` +3 assertions.

613 tests pass and typecheck is clean. Verified on a production build in a separate origin: the docs page loads with the demo data present; signed in through the web app, "Try it out" on `GET /api/v1/projects` returned 200 and on `POST /api/v1/projects` created a project (201) through the session cookie; the demo script (which uses the batch route) ran unchanged.

## Docs: recorded the API-token admin-route gap and a "missing reads" step (2026-10-12)

Found while answering Elliot's question about whether the API is enough for automation; nothing in the code changed.

- **API tokens on global admin routes.** A token's project binding is only checked when the request names a project, and the admin routes don't. A probe with a token made for one project holding `USER_MANAGE` and `CUSTOM_FIELD_MANAGE` could list every user, read the whole Security Audit Log, create a No Access user (the admin guard stopped anything more) and create a global custom field. Since a token's ceiling is its issuer's permissions in that project, someone who is an admin in one project only can make such a token. Recorded as "Fix first" in `docs/api_roadmap.md`, with a gap note in RFC 04 §4.2 (which said the binding was checked for every route) and in CLAUDE.md's known gaps.
- **Step 8, "Fill the read gaps":** single items by id, a run's results, readable ids (SHOP-12), version history, and changing one report-schedule recipient.
- **Step 3:** a note to list each field's allowed values in its description, since Swagger UI's "Example Value" view shows only one.
- **Recommended order:** the token fix, then step 3, then steps 8 and 4 together.

## Fixed: API tokens could use the system-wide admin routes (2026-10-12)

The "Fix first" item recorded earlier the same day in `docs/api_roadmap.md`. A token's project binding was only checked when the request named a project, and the admin routes don't, so a token holding an admin permission worked system-wide: it could list every user, read the whole Security Audit Log, create users and create global custom fields. Since a token's ceiling is its issuer's permissions in that project, someone who is an admin in one project only could make such a token. Decided with Elliot: fix both ways.

- **Tokens are refused on routes outside a project** (`tokenMayUseRoute`, checked in `authenticateApiToken`, `apps/server/src/middleware/auth.ts`). A route counts as inside a project when its address has a project item parameter (`:projectId`, `:planId`, `:runId`, `:caseId`, `:suiteId`, `:versionId`, `:scheduleId`, `:tokenId`). Every other route refuses tokens with `403 TOKEN_NOT_ALLOWED` ("Sign in as a user to use it"), except three that stay inside the token's project anyway: `GET /api/v1/auth/me`, `GET /api/v1/projects` (lists only its own project) and `POST /mcp` (checks each tool call). This is deny by default, so a route of this kind added later is closed to tokens automatically. Now refused: all of `/api/v1/admin/...`, `POST /api/v1/projects` and `PATCH /api/v1/auth/me`. An unknown id on a route inside a project still answers 404.
- **Permissions a token can never hold:** new `TOKEN_EXCLUDED_PERMISSIONS` and `isTokenGrantable` (`packages/core/src/rbac/registry.ts`), each permission with the reason:
  - `SYSTEM_ADMIN` (as before);
  - `USER_MANAGE`, `CUSTOM_FIELD_MANAGE`, `PROJECT_CREATE`: their routes reach the whole system;
  - `API_TOKEN_MANAGE`: tokens made by a token would never work, because their issuer isn't a user.
  Creating a token with one is `400 CAPABILITY_NOT_GRANTABLE`, with the reason in `invalid_params`. The API Tokens tab no longer offers them (the server leaves them out of `issuer_capability_ceiling`) and says why in one line under "Capabilities". Existing tokens lose them on every use: `apiTokenIssuerAccess` drops them, so `effective_capabilities` shows them struck through.
- **Smaller fixes:** `TOKEN_PROJECT_MISMATCH` named a field that no longer exists (`target_project_id`); it's now `project_id`. The spec's 403 descriptions, `POST /projects` and `PATCH /auth/me` mention `TOKEN_NOT_ALLOWED`.
- **Docs:** RFC 04 §4.2 points 3 and 5 rewritten (and the gap note removed), RFC 03 error codes and §7.1, `reports_api_and_mcp.md`, CLAUDE.md (auth rules; the known gap removed), and the roadmap (done).

New tests: `apps/server/tests/api_token_scope.test.ts` (4):
- which route addresses count as inside a project;
- every excluded permission is refused with its reason, and none appears in the grantable list;
- a token gets `TOKEN_NOT_ALLOWED` on eleven system-wide routes and changes nothing there (no user, custom field or project created), while still working on `/auth/me`, `GET /projects`, its project's routes and `/mcp`, with an unknown id still 404;
- a token stored with `API_TOKEN_MANAGE` and `USER_MANAGE` (as if made before this change) is left with only `SPEC_VIEW`.

`api_tokens.test.ts`: the "capability the Test Lead lacks" example is now `PROJECT_DELETE`, since `USER_MANAGE` is refused earlier for a different reason.

## Added: the specification and plans to the OpenAPI spec (API roadmap step 3, stage 2) (2026-10-12)

- **27 more routes on `/docs`** (45 in all), in four new groups (Specification, Versions, Custom field values, Search) and the existing Plans group:
  - the spec tree, suites, cases and moving them;
  - versions (latest, new draft, edit, approve, deprecate, restore);
  - custom-field values on cases and suites;
  - search and its field catalog;
  - plan membership (one case or a whole suite) and the Execute queue (`GET /plans/{planId}/cases`).
  Each says what permission it needs, what each field means and which errors to expect. New shared schemas: `Suite`, `SuiteNode` (the recursive tree with case counts), `TestCase`, `Step`, `Version`, `PlanCase`, `CustomFieldDefinition`, `CustomFieldValue` (`apps/server/src/openapi/areas/spec.ts`, `schemas.ts`).
- **Allowed values in descriptions.** Elliot noticed that Swagger UI's "Example Value" view shows only one value (`"verdict": "PASSED"`). Every field limited to a set of values now lists them in its description too ("One of: PASSED, FAILED, …"), stage 1's fields included, through a new `oneOf()` helper. The value lists (`VERDICTS`, `PRIORITIES`, ...) are shared constants.
- **Request validation:** these routes check their bodies themselves with specific codes (`INVALID_NAME`, `INVALID_STEPS`, `INVALID_FILTER`, `INVALID_FIELD_VALUE`), so their body schemas are documentation only (`handlerValidated`). Adding a case to a plan (`{ test_case_id }`) and the query strings are enforced.
- **Fixed while documenting:**
  - A case's `priority` and `execution_type` were stored exactly as sent (any text). Creating or changing a case now accepts only `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` and `MANUAL`, `AUTOMATED` (the values the app, the filters and the importers use). Anything else is `400 INVALID_REQUEST` naming the field. Existing values aren't touched.
  - Adding a whole suite to a plan listed skipped cases with `case_id`; it's now `test_case_id`, like every other id. (The web app only counts them.)
  - Deprecate and restore named `version_id` in `invalid_params`; now `test_case_version_id`.
- No response in the whole test suite disagrees with the spec, so the new schemas match what the server actually sends.

Tests: `apps/server/tests/openapi.test.ts` +2 (the 45 routes are all in the spec; `verdict` and `priority` list their values in the description; an unknown priority or execution type is refused on create and change, and a known one accepted). 619 tests pass and typecheck is clean. Verified on a production build with the demo data: the docs page shows the new groups.

## Added: every remaining route to the OpenAPI spec (API roadmap step 3, stage 3) (2026-10-12)

- **39 more routes on `/docs`** (84 in all, every route the server has), in ten new groups:
  - Reports (the catalog, and running a report, with each report's parameters listed);
  - Report email (sending now, preview, schedules and send-now);
  - Import (preview and import, as a multipart upload or JSON, and the fields an import can map to);
  - Export (definitions or a run's results, as JSON or CSV downloads);
  - API tokens;
  - Admin: users and roles (users, status, roles, project roles, password resets, permission overrides, the permission list), Admin: custom fields, Admin: email, Admin: audit log;
  - Operations (the health check, and `/mcp` described as JSON-RPC).
  New shared schemas: `AdminUser`, `PermissionOverride`, `Role`, `ApiToken`, `ReportSchedule`, `ScheduleSection`, `EmailSettings`, `ImportPreviewNode` (`apps/server/src/openapi/areas/admin.ts`, `other.ts`).
- **Nothing can be left out by accident:** the OpenAPI setup records every route as it's registered (`app.openApiRoutes`), and `openapi.test.ts` fails if any `/api` or `/mcp` route isn't in the spec. Only `GET` and `DELETE /mcp`, which just answer 405, are hidden on purpose.
- **Report outputs are described only at the top level** (`report`, `generated_at`, `project`); each report's full shape is in the catalog and `reports_api_and_mcp.md`. Recorded in the roadmap's Decisions table as a possible follow-up.
- **Request validation:** bodies are enforced where the route has no checks of its own (creating a user, a user's status and roles, roles, overrides). Routes with their own specific checks keep them (`handlerValidated`): custom field definitions, email settings, tokens, reports, report email, import, export.
- **Fixed while documenting:** creating a user whose username or email was already taken answered a generic 500 (the database's duplicate error). It's now `409 USER_EXISTS` ("That username or email is already used by another user"), added to RFC 03's error codes.
- **Docs:** the RFC 03 header and summary, the blueprint and the README say every route is on `/docs`; CLAUDE.md's "not built" now names only the report-output schemas; roadmap stage 3 done.

Tests: `openapi.test.ts` +2 (every registered `/api` and `/mcp` route is in the spec, with exactly two hidden, 84 operations, and the import's two body types; a taken username or email gets 409 three ways). The whole suite's responses still match the spec. 621 tests pass and typecheck is clean. Verified on a production build with the demo data: the page shows all 18 groups with the report ids and parameters listed, and a multipart import preview through the new schema works.

## Added: a getting-started guide for the API (API roadmap step 3, stage 4) (2026-10-12)

The last stage of step 3, which is now Done.

- **New `docs/api_getting_started.md`**, from nothing to a CI pipeline that records its results:
  1. what you need;
  2. making an API token, with which capabilities each job needs;
  3. the first call;
  4. finding the ids you need;
  5. creating or reusing a run for each build, sending results, checking what was saved (201 vs. 207, the reasons a result is refused, `all_or_nothing`), and a GitHub Actions step;
  6. reading results back (a Markdown run summary for a PR comment, the queue, case history, test health, exports);
  7. errors, with the codes you're most likely to meet;
  8. limits;
  9. going further (generated clients from `/docs/json`, MCP).
- **Every command was run** against a production build with the demo data, and the outputs shown are real ones. Running the GitHub Actions step's script locally caught a bug in the draft: it treated a 207 (some results refused) as success, because 207 is below 300. It now requires 201.
- **The top of `/docs`** has a four-step "Getting started" (make a token and Authorize, first calls, create a run and send results, read the summary back) and names the full guide.
- **Batch error wording:** an all-or-nothing batch that's refused said "Batch execution failed in atomic mode: item at index 2: ..."; it now says "Nothing was recorded (all_or_nothing): results[2]: ...", naming the field the way `invalid_params` does.
- **Links:** the README, RFC 03, `reports_api_and_mcp.md` and CLAUDE.md's doc map point to the guide. In the roadmap, step 3 is Done and the "mostly undocumented" weakness is struck through.

621 tests pass and typecheck is clean (no test asserted the old batch wording).

## Added: reading single items, version history, and readable case ids everywhere (API roadmap steps 8 and 4, part 1) (2026-10-12)

Steps 8 ("fill the read gaps") and 4 (paging) are being done together, in three commits. Decided with Elliot:
- readable case ids work everywhere a case id does, not only through a lookup route;
- paging only for lists that grow;
- bulk changes become their own roadmap step.

This is the first commit.

- **Single items by id** (7 new routes, all on `/docs`):
  - `GET /projects/{id}` (with the caller's `permissions` there), `GET /plans/{id}`, `GET /runs/{id}`: for anyone who can view or execute in the project;
  - `GET /suites/{id}`, `GET /cases/{id}` (the case and its latest version with steps), `GET /cases/{id}/versions` (every version, newest first, with steps; new `TestCaseVersionRepository.findAllForCase`) and `GET /versions/{id}`: need `SPEC_VIEW`.
- **Readable case ids everywhere** (`apps/server/src/caseRefs.ts`):
  - Wherever a case id is taken (the `:caseId` path parameter, `test_case_id` in the query or body, `case_ids` in a body), the readable id works too: `GET /cases/SHOP-12`, `DELETE /plans/{id}/cases/SHOP-12`, `{"test_case_id": "SHOP-12"}`, a move's `case_ids`, the `case_history` report.
  - `authenticateRequest` swaps them for internal ids once the caller is identified, so routes only see internal ids, and nothing about readable ids is revealed before sign-in.
  - Project resolution understands them, so permissions are checked in the right project.
- **Shared readable ids:** imported cases keep the ids from their file, so two projects can share one (normally they can't, since ids start with the project's unique prefix). Then the request's project decides: the project its other ids name, or an API token's own project. Without one, the answer is `400 AMBIGUOUS_CASE_ID` naming the field. A value matching nothing is left alone, so the route answers its usual 404.
- **Migration `009_index_case_external_id`:** an index on `test_cases.external_id`, since lookups by readable id don't know the project.
- **Docs:** RFC 03's conventions, route map and error codes; the roadmap (status and four decisions); CLAUDE.md.

Tests:
- `apps/server/tests/api_reads.test.ts` (4):
  - every new read, with 404s for unknown ids;
  - readable ids on the case routes, plan membership (path and body), a move and a report;
  - a readable id shared by two projects: refused alone, settled by a plan or by an API token's project, never mentioned without a sign-in;
  - a token of another project gets `TOKEN_PROJECT_MISMATCH` on all five items, readable id included.
- `migrations.test.ts` +1 (009 and its rollback). `openapi.test.ts` now expects 91 routes.

626 tests pass and typecheck is clean.

## Added: paged lists of a project's cases, a run's results and the audit log (API roadmap steps 8 and 4, part 2) (2026-10-12)

Scripts could only read a run's results through the Execute queue (latest verdict only), the reports or an export, and could only list cases by loading the whole spec tree. The audit log stopped at the latest 100 entries. Elliot chose paging only for the lists that grow; short lists stay whole and the web app is unchanged.

- **Paging convention:** `limit` (a default and a maximum per list) and `cursor` in; `next_cursor` out, null on the last page. Cursors are keyset positions (time and id), so a page never skips or repeats an item when new ones arrive. A cursor the server didn't give out gets `400 INVALID_CURSOR`, including on the case-history report, which used to ignore it.
  - `packages/db/src/paging.ts`: `encodeCursor`, `decodeCursor`, `toPage` (moved out of the result repository, now shared).
  - `apps/server/src/paging.ts`: `readPage` (reads `limit` and `cursor`, answers the 400) and `commaList`.
- **`GET /api/v1/projects/{projectId}/cases`** (`SPEC_VIEW`): every case, oldest first, 100 a page (at most 500), each with a summary of its latest version. Filters: `external_id` (comma list), `test_suite_id` with `include_sub_suites`, `version_status`, `priority`.
- **`GET /api/v1/runs/{runId}/results`** (`SPEC_VIEW` or `EXECUTE_RUN`): every result in the run, newest first, 100 a page (at most 1,000), with its case, version, duration, notes, failure message, stack trace, environment, runner, source, who recorded it (`tested_by`) and step results. Filters: `verdict` (comma list), `test_case_id` (readable ids work), `source` (UI or API), `latest_only` (each case's latest result, what reports count).
- **`GET /api/v1/results/{resultId}`**: one result in the same shape. Project resolution and the API-token route check now know `:resultId`.
- **`GET /api/v1/admin/audit-logs`** is paged (100, at most 500) and filters by `action` (comma list; any action, not only the security ones), `actor_id` and `since`. The Admin Panel reads the first page as before.
- **Shared:** `services/actorNames.ts` (user and token names) is used by the reports and the result list. A `RunResult` schema in the OpenAPI spec.
- **Docs:** RFC 03 (paging convention, route map, `INVALID_CURSOR`), the roadmap (step 4 done, step 8 parts 1-2; also removed four Decisions rows that the last commit had added twice), CLAUDE.md/AGENTS.md.

Tests:
- `apps/server/tests/api_lists.test.ts` (4):
  - cases: four pages of 3 cover all 10 exactly once; each filter; a bad status, limit and cursor;
  - results: four pages of 1; UI and CI fields; each filter and `latest_only`; one result by id; 404s; a token reads its own project's results and is refused another's;
  - audit log: pages of 2, newest first; `action`, `actor_id`, `since`; a bad `since` and cursor;
  - the case-history report refuses a made-up cursor.
- `openapi.test.ts` now expects 94 routes; the response check covers every new response.

## Added: adding and removing one report-email recipient; steps 8 and 4 done (API roadmap steps 8 and 4, part 3) (2026-10-12)

Changing who gets a scheduled report meant resending the whole schedule with `PUT`. Now one address can be added or removed on its own.

- **`POST /api/v1/report-schedules/{scheduleId}/recipients`** with `{ "email": "..." }` (`REPORT_EMAIL`): adds it, lower-cased, and answers 200 with the schedule. Adding an address already there changes nothing and writes no audit row. More than 50 recipients, or anything other than one address, is a `400` naming the field.
- **`DELETE /api/v1/report-schedules/{scheduleId}/recipients/{email}`**: removes it (any letter case) and answers 204. An address that isn't a recipient gets 404. The last recipient can't be removed (`409 LAST_RECIPIENT`): add another first, or delete the schedule.
- Both write a `REPORT_SCHEDULE_UPDATED` audit row (name, recipient count, which change; no addresses, as before). The change happens under a row lock (`ReportScheduleRepository.changeRecipients`), so two changes at once can't lose one. Nothing else about the schedule changes, including when it next goes out.
- **Fix to part 2:** a run's result list now orders by `executed_at`, then `created_at`, then id. Results from one CI batch share `executed_at`, and the random id put them in no particular order, so a case sent twice in one batch could list its earlier result as the newer one, unlike `latest_only` and the reports. The cursor carries the second time (`<ts>|<ts2>|<id>`; `decodeCursor` reads both forms). `api_lists.test.ts` now checks the order.
- **Decided with Elliot:** bulk changes (e.g. deprecating many cases at once) are their own roadmap step, step 9.
- **Docs:**
  - the getting-started guide: readable ids anywhere, one case by readable id, the case list, a paging loop, and a run's results;
  - RFC 03's route map and `LAST_RECIPIENT`;
  - reports_api_and_mcp.md's report-email table;
  - the roadmap: steps 8 and 4 Done, new step 9, the recommended order, the endpoint count, and a decision on the recipient routes.

Tests: `report_email.test.ts` +1, covering adding (letter case, spaces, adding twice), a bad address, removing, removing an unknown address, the last recipient, an unknown schedule, and that the rest of the schedule is untouched. `openapi.test.ts` now expects 96 routes.

631 tests pass and typecheck is clean. Checked live on a production build: case-list paging and a bad cursor, the paged audit log, a run's results (filters, latest_only, one result, three results from one batch paged in order), and adding and removing recipients down to the last; `/docs/json` lists 96 operations.

## Added: CI integration: JUnit XML uploads, runs by name, CI examples (API roadmap step 5) (2026-10-12)

Sending results from CI meant converting the test runner's output to Testify's JSON, and looking up or creating the run with a jq script first. Now a build uploads the JUnit XML report its tests already write, in one `curl`.

**Decided with Elliot:**
- The server takes the JUnit file itself. There's no command-line uploader to install.
- A test matches a case by readable id first, otherwise by suite and title. Unmatched tests are reported, not created.
- One call creates or reuses the build's run by name.
- The guide has examples for GitHub Actions, GitLab CI, Jenkins and Azure DevOps.
- **CI results never auto-close a run** (asked after the live check below). `close_run=true` closes it on purpose. Manual results still auto-close, once.

**What changed:**
- **`POST /api/v1/runs/{runId}/results/junit`** (`EXECUTE_RUN`):
  - The body is the JUnit file, any content type, up to 20,000 tests and 50 MB. It's parsed by `parseJUnitResults` (new, `packages/core/src/ingestion/junitResults.ts`).
  - Verdicts: failure and error are FAILED (an error gets a note), skipped is SKIPPED (its message as the note), everything else PASSED. Surefire's `flakyFailure`/`rerunFailure` are ignored.
  - `time` becomes the duration; the failure message and text become `failure_message` and `stack_trace`.
  - Matching: a `testify_id` property, or a readable id in the test's name (`SHOP-101 …`, `[SHOP-101] …`), else the suite a JUnit import would have created (the last part of `classname`) plus the title.
  - Query: `environment`, `ci_name`, `ci_run_id`, `ci_job_name`, `ci_url`, `commit_sha`, `all_or_nothing`, `close_run`.
  - The response is the batch response, with each item's `test_name`. `400 INVALID_JUNIT` for anything unusable.
- **Runs by name:** `POST /api/v1/plans/{planId}/results/junit?run_name=` and `POST /api/v1/plans/{planId}/results/batch?run_name=` record into the plan's run with that name (`services/runByName.ts`).
  - Creating the run needs `RUN_MANAGE`; reusing it needs only `EXECUTE_RUN`.
  - Concurrent requests end up with one run (`ON CONFLICT DO NOTHING`).
  - The response adds `run: { id, name, created }`.
  - Nothing is created for a locked plan or an unusable request.
- **CI results don't auto-close runs:**
  - **Found live:** with an empty plan, the first upload linked its cases, filled the plan and closed the run. A re-run of the job, or the build's next file (Surefire writes one per class), then got `422 RUN_CLOSED`. The JSON batch already behaved this way.
  - **Now:** batches and JUnit uploads leave the run open. `close_run=true` (needs `RUN_MANAGE`) closes it after recording, and `run_status` says which.
  - **Unchanged:** results recorded one at a time (the web app) still auto-close the run the first time every case has a result.
- **Shared batch core:** the JSON batch's logic moved from `routes/batchExecution.ts` into `services/batchResults.ts` (`recordResultsBatch`), which all four routes use.
  - Cases of the project that aren't in the plan yet are now looked up in a few queries for the whole batch, not one query per item (a JUnit file can name thousands of untracked tests).
  - When several match by title, the one in the named suite is preferred.
  - The batch route now checks `EXECUTE_RUN` with `requirePermission`, like other routes.
- **Docs:**
  - `api_getting_started.md` §5 is rewritten around the JUnit upload: matching, "import the JUnit file once", reading the response, examples for the four CI systems, and JSON as the alternative.
  - RFC 03: route map, §3 intro, new §3.3 (JUnit) and §3.4 (runs by name, no auto-close for CI), `INVALID_JUNIT`, limits.
  - RFC 01's auto-close rule and RFC 04's `RUN_MANAGE` row.
  - Blueprint, README, reports_api_and_mcp.md.
  - Roadmap: step 5 Done, five decisions, the endpoint count.
  - CLAUDE.md/AGENTS.md: results, layout, decisions.

Tests:
- `packages/core/tests/junitResults.test.ts` (5):
  - outcomes, durations, messages and stack traces;
  - nested suites, test properties and reruns;
  - refusing non-JUnit input;
  - readable ids in names and properties;
  - suite names.
- `apps/server/tests/junit_results.test.ts` (6):
  - matching by name, property, and suite and title, with an unmatched test, every stored field, and all-or-nothing;
  - unusable files, and any content type;
  - runs by name: create, reuse, three parallel uploads ending in one run, a token without `RUN_MANAGE`, a missing `run_name`, a closed run;
  - no auto-close across two files and a re-run; `close_run` and its permission;
  - the JSON batch by run name, where an empty batch creates no run;
  - a JUnit file imported as cases matches the same file uploaded as results.
- `openapi.test.ts` now expects 99 routes.

Verified live on a production build:
- Imported a pytest-style JUnit file.
- Ran the guide's GitHub Actions script twice for one build: 207 listing the untracked test, the same run reused, and it stayed open.
- Ran a Jenkins-style loop over two Surefire-style files into one new run, with `close_run` on the last: stored verdicts, durations and CI links, and the run closed.
- `/docs/json` shows `application/xml` bodies.
- The guide's four YAML/Groovy examples parse, and their shell passes `bash -n`.

## Added: bulk changes and MCP write tools (API roadmap steps 9 and 6) (2026-10-12)

Scripts had to loop to change many cases, and agents could only read. Done together, since what agents are typically asked to do ("deprecate these 30 cases", "add everything for checkout to the plan") is a bulk change.

**Decided with Elliot:**
- Steps 9 and 6 are done together.
- Agents get: create suites and cases, edit cases (one or many), create runs, record results, add and remove plan cases. They get no tools to approve, deprecate, restore or delete.
- Cases an agent creates always start as DRAFT, even with `SPEC_AUTO_APPROVE`, for a person to approve.

**Bulk changes (step 9):**
- **`POST /api/v1/projects/{projectId}/cases/bulk`**, with up to 500 `case_ids` (readable ids work):
  - `update`: `changes` sets `priority`, `execution_type`, `test_suite_id` (moves them) and `custom_fields` (by id, name or label; null clears). Needs `SPEC_EDIT`, and `PLAN_MANAGE` for custom fields, as in the single routes.
  - `approve`, `deprecate`, `restore`: act on each case's latest version. Needs `SPEC_APPROVE`.
- **`POST /api/v1/plans/{planId}/cases/bulk`**: `add` or `remove`. A case with results is refused (`CASE_HAS_RESULTS`) unless `retire_if_has_results` is true. Needs `PLAN_MANAGE`.
- **How it works:** each case goes through its single-item route in-process (`innerRequest` in the new `apps/server/src/internalRequests.ts`), as the caller. Rules, errors and audit rows are therefore exactly the single routes'. The answer is 200 or 207, with `bulk_results`: a summary, and per case its `status`, `code` and `detail`.
  - **Refused up front:** a repeated case, nothing to change, an unknown custom field (`400 UNKNOWN_FIELD`), a missing permission (403), a locked plan.
  - **Other projects:** a case from another project is "not found" here.
  - **No all-or-nothing mode:** each case is its own change, as one at a time.
  - **Rate limits:** in-process requests carry a per-process secret header, so they aren't counted again against a token's rate limit.

**MCP write tools (step 6), `apps/server/src/mcp/writeTools.ts`:**
- **The tools:**
  - `create_suite`, `create_case` (always DRAFT).
  - `update_case`: unversioned fields at once; summary, preconditions and steps on the DRAFT, where an approved case first gets a new DRAFT version and a deprecated one is refused; custom fields.
  - `update_cases`, via the bulk route.
  - `create_run`, `record_results` (via the CI batch, up to 500).
  - `update_plan_cases`, via the bulk plan route.
  - Also a read tool, `list_suites` (the tree with paths and case counts).
- **They act as the caller:** each one calls the REST routes with the caller's credential. An API token is offered only the tools its capabilities allow. Tools carry `readOnlyHint: false`, and `destructiveHint` for `update_plan_cases`. Ids from another project are refused.
- **Audit:**
  - Changes keep their usual audit rows, with "(via Testify MCP)" added to the User-Agent.
  - Every write-tool call (success or error) writes an `MCP_WRITE` row, which is in the Admin Panel's Security Audit Log.
- **The server's instructions to agents** describe the write tools and the DRAFT rule, and ask the agent to tell the user what it created.

**Fixed along the way:** audit rows for spec edits (`CASE_CREATED`, `CASE_UPDATED`, versions, moves...), plan membership (`PLAN_CASE_ADDED`/`REMOVED`/`RETIRED`/cascades) and single results (`RESULT_RECORDED`) said `actor_type: USER` even when an API token made the change. They now use `actorType()` (new, `audit.ts`), like projects, exports and imports already did. Found by the live check below.

**Docs:**
- `reports_api_and_mcp.md`: the write tools, what keeps them safe, example asks.
- RFC 03: bulk-change convention, route map, `UNKNOWN_FIELD`.
- RFC 04: threat vector 7 (MCP writes, prompt injection limits, traceability).
- The getting-started guide: bulk examples and agent tokens.
- Blueprint, slices roadmap, README.
- Roadmap: steps 6 and 9 Done, five decisions, open questions answered.
- CLAUDE.md/AGENTS.md: layout, conventions, the agent decision.

Tests:
- `apps/server/tests/bulk_changes.test.ts` (4):
  - update with priority, suite and custom fields, including an unknown case, one audit row per change, and refusals;
  - deprecate, restore and approve, with wrong states failing per case;
  - permissions per action, and another project's case;
  - plan add and remove, including DRAFTs, re-adding, a case with results refused then retired, and a locked plan.
- `apps/server/tests/mcp_write.test.ts` (3):
  - DRAFTs despite `SPEC_AUTO_APPROVE`, editing a DRAFT in place versus a new DRAFT for an approved case, tool errors, User-Agent and `SERVICE_ACCOUNT` attribution, and `MCP_WRITE` rows for successes and failures;
  - runs, results, `update_cases` and plan changes with retiring;
  - which tools a read-only, an editor and a signed-in user are offered.
- `mcp.test.ts`: the tool list check now expects the write tools to say `readOnlyHint: false`.
- `openapi.test.ts` now expects 101 routes.

Verified live on a production build, with the MCP SDK's HTTP client (as Claude Code connects):
- The bulk routes over HTTP: add to a plan, and a priority change including an unknown case.
- A token with write capabilities: the instructions, the 7 write tools listed, `list_suites`.
- `create_case`: DRAFT despite `SPEC_AUTO_APPROVE`.
- `update_case` on an approved case: a new DRAFT version 2.
- `create_run`, then `record_results`: a DRAFT case was correctly refused.
- `update_plan_cases`: a DRAFT can't join a plan.
- A duplicate run name came back as a tool error.
- The `MCP_WRITE` rows and the marked `CASE_CREATED` row were checked; this is where the `actor_type` bug showed.

## Added: webhooks, the server (API roadmap step 7, part 1) (2026-10-12)

Testify pushed nothing out but report emails. Now a project's events go to other systems as they happen: Slack when a run finishes or tests fail, CI or a bug tracker reacting to results, reviewers told about an agent's draft cases. Part 2 is the Admin Panel tab.

**Decided with Elliot:**
- **Who and where:** a new per-project permission `WEBHOOK_MANAGE`, Admin and Test Lead by default, never grantable to API tokens. It'll be managed in an Admin Panel tab (part 2).
- **Targets:** public and private networks, but not loopback or link-local (cloud metadata), unless `WEBHOOK_ALLOW_LOCAL=true`.
- **Formats:** signed JSON, or a Slack-style message.
- **Events:** all four groups.

**What changed:**
- **Events** (`packages/core/src/webhooks/`, `WEBHOOK_EVENTS`):
  - `run.created`;
  - `run.closed`, with a summary from the run_summary report: counts, pass rate, new failures and fixes against the previous run, up to 20 failures;
  - `results.recorded` and `results.failed`, one per request: a hotkey, a CI batch or a JUnit file;
  - `test_case.created` (with `via: mcp` for an agent), `.approved`, `.deprecated`, `.restored`;
  - `import.completed`;
  - `ping`.
  - Each comes from where the change happens, after it commits: the helpers in `services/webhookEvents.ts`, called from the run, result, batch, version, case and import routes. So bulk changes, JUnit uploads and MCP tools send them too.
- **Envelope and signing:** `{ id, event, created_at, project, actor, url, data }`. `url` links into the web app when the public URL is set.
  - Headers: `X-Testify-Event`, `-Event-Id`, `-Delivery`, `X-Signature-Timestamp`, and `X-Signature-SHA256`, the hex HMAC-SHA256 of `{timestamp}.{body}`.
  - The secret (`whsec_…`) is shown once and stored encrypted with `SECRETS_KEY`. Without `SECRETS_KEY` on a real database, creating a webhook is refused (`SECRETS_KEY_REQUIRED`), as SMTP passwords are.
- **Slack format:** `renderSlackMessage`. Its `text` has everything (for Mattermost, Rocket.Chat and Discord's `/slack`), and `blocks` lay it out for Slack. Test content is escaped, so it can't mention `@channel`.
- **Delivery** (`services/webhooks.ts`): an outbox (`webhook_deliveries`, migration `010_webhooks`), sent at once and retried after 1 min, 5 min, 30 min, 2 h and 8 h, then `FAILED`.
  - Each delivery is claimed with a compare-and-set lease, so several instances never send one twice.
  - One sender per webhook per process sends in order; webhooks are sent to in parallel.
  - A receiver that can't be reached gets one attempt per pass, so it holds up only itself.
  - The answer must be 2xx within 10 s; redirects aren't followed.
  - A 15-second poller (`startServer`) picks up retries. Deliveries are kept 30 days.
- **Addresses** (`services/webhookTargets.ts`, `isBlockedAddress` in core):
  - Loopback, unspecified, link-local and multicast are refused, IPv6 and IPv4-mapped forms included.
  - The check happens when saving (literal addresses and `localhost`) and on every connection after DNS (a custom `lookup`), so DNS rebinding doesn't get around it.
  - `WEBHOOK_ALLOW_LOCAL=true` lifts it. `npm run dev` sets it.
- **API** (`routes/webhooks.ts`, a new "Webhooks" tag on `/docs`, 11 routes):
  - `GET /webhook-events`;
  - `GET`/`POST /projects/{id}/webhooks` (at most 20 per project);
  - `GET`/`PATCH`/`DELETE /webhooks/{id}`, `rotate-secret`, `ping`;
  - the paged delivery log, one delivery in full, `redeliver`.
  - Project resolution and the token route check know `:webhookId` and `:deliveryId`.
  - Audit rows `WEBHOOK_CREATED`/`UPDATED`/`DELETED`/`SECRET_ROTATED` show in the Security Audit Log.
- **Permission:** `WEBHOOK_MANAGE` (registry 19 → 20 keys), added to `TOKEN_EXCLUDED_PERMISSIONS`. The seed adds it to existing databases' Admin and Test Lead roles.
- **Docs:**
  - RFC 03 §7.3 rewritten as built, with a test vector for signatures; the route map, error codes and summary table;
  - RFC 04: the permission, the role matrix, token exclusions, audit actions, and a threat-model entry (exfiltration, server-side request forgery);
  - `deployment.md`, `.env.example` and `docker-compose.yml`: `WEBHOOK_ALLOW_LOCAL`, and `SECRETS_KEY` for webhooks;
  - the getting-started guide: a new §9 with Slack setup and signature checks in Node and Python (both run against the test vector and fresh signatures);
  - README, blueprint, slices roadmap;
  - roadmap: step 7 in progress, five decisions;
  - CLAUDE.md/AGENTS.md.

Found and fixed during the live check:
- **One dead receiver delayed every webhook.** Deliveries went out one after another, so a webhook pointing at an unreachable address held up everything queued behind it, for up to 10 s per attempt. Now each webhook has its own sender and webhooks are sent to in parallel.
- **Two timing bugs left deliveries for the poller** (up to 15 s late):
  - A sender looked for deliveries due when its pass started, so it missed ones queued while it ran.
  - A delivery queued just as a sender finished was skipped by the other passes.
  - Senders now use the current time and check once more before letting go.

Tests:
- `packages/core/tests/webhooks.test.ts` (5): the signature (with the test vector), blocked and allowed addresses, the Slack message for every event, escaping, and failure lists.
- `apps/server/tests/webhooks.test.ts` (6), against a local HTTP receiver:
  - CRUD, validation, rotation; permissions, including that a token can't hold `WEBHOOK_MANAGE`; audit rows;
  - a signed delivery checked at the receiver; the envelope; ping and redeliver; the Slack format; the paged log; a turned-off webhook;
  - every event from its route (single results until auto-close, a JUnit upload with `close_run`, a manual close, case create, approve, deprecate, restore, an MCP agent's case, an import), only to subscribed webhooks of the project;
  - retries with backoff to `FAILED`; two concurrent workers sending once; a redirect; a timeout;
  - a dead receiver not holding up a healthy one;
  - local addresses refused on save and after DNS; a project's force-delete removing its webhooks and deliveries.
- `migrations.test.ts` +1 (010, its cascade and rollback). Permission counts and token exclusions updated in `rbac.test.ts`, `admin_roles_and_overrides.test.ts` and `api_token_scope.test.ts`. `openapi.test.ts` now expects 112 routes.

Verified live on a production build (port 3995, `WEBHOOK_ALLOW_LOCAL=true`), with a receiver script checking every signature:
- **Real events:** a JUnit upload with `close_run`, results recorded by hand until the run auto-closed, an approval, an MCP agent's case (its `<!channel>` escaped in Slack), and an import.
- **Two webhooks** (JSON and Slack format) got all 15 deliveries within about 0.35 s, each signature valid and fresh. This was with a third webhook pointing at an unreachable address.
- **Retries:** the receiver's first answer was a 500, and the delivery came again by itself about 71 s later.
- **Default settings** (another instance without the flag): 169.254.169.254, 127.0.0.1, `localhost` and `[::ffff:127.0.0.1]` were refused; a 10.x address was accepted.
