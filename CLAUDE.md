# Testify — Agent / Contributor Guide

This file orients any AI coding agent (Claude, Gemini/Antigravity, etc.) or human contributor working in this repo. Read this before making changes.

## What this project is

Testify is an open-source, self-hostable test case management platform meant as a modern, faster, more extensible replacement for TestLink. Core entities: Projects → Test Suites (recursive tree) → Test Cases → Test Case Versions → Test Steps, plus Test Plans → Builds → Executions, dynamic Custom Fields, and a granular RBAC/permission system.

The product direction was defined by an Antigravity (Gemini) multi-agent planning session — see **Doc map** below — before implementation started. Slices 0–2 (infra, read spine, execution loop) are substantially implemented; slices 3–4 (admin/RBAC UI, custom fields engine, import/export, storage) are partial or not yet started. See "Implementation status" below for specifics.

## Doc map (read in this order)

1. `.antigravity/requirements_alignment.md` — locked product decisions from intake (retention, versioning, hotkeys, ingestion).
2. `.antigravity/agents/*.md` — the 5 role prompts (lead_architect, api_integration, qa_specialist, security_rbac, ux_ergonomics) used to generate the RFCs below. Useful for understanding *why* a decision was made.
3. `docs/rfc_01_domain_model.md`, `rfc_02_ux_density_and_hotkeys.md`, `rfc_03_api_and_xml_contracts.md`, `rfc_04_rbac_security_matrix.md` — detailed specs per domain.
4. `docs/MASTER_ARCHITECTURE_BLUEPRINT.md` — synthesis of the RFCs into one architecture doc.
5. `docs/01_vertical_slices_roadmap.md` — the build plan, sliced into Slice 0–4 with target file structures, API contracts, and verification commands per slice. All commands already use `npm run Y --workspace=X` syntax (rewritten 2026-09-14, see "Docs updated to match" below) — the repo uses plain `npm` workspaces, no Turborepo/pnpm.

These docs are design artifacts, not always ground truth for what's built — cross-check against the code before assuming a described feature exists.

## Repo layout

```
apps/
  server/    Fastify API (TypeScript, ESM). Entry: src/server.ts
  web/       React + Vite frontend. Entry: src/main.tsx, src/App.tsx (currently one large ~1.6k line component)
packages/
  core/      Domain logic: ingestion parsers (XML/CSV/JSON), password policy. (No state-machine/RBAC/custom-field modules yet despite roadmap calling for them here.)
  db/        Kysely-based DB layer targeting Postgres-compatible SQL only: migrations, repositories, seeds. `createDbClient()` with no connection string uses an ephemeral, zero-config `@electric-sql/pglite` (WASM Postgres) instance; pass a `connectionString` to connect to a real Postgres server instead. There is no SQLite driver (see below).
docs/        Planning/spec docs (see Doc map).
.antigravity/  Antigravity agent role prompts + locked requirements doc.
```

Workspaces are declared via npm (`package.json` → `"workspaces": ["packages/*", "apps/*"]`), not pnpm/Turborepo.

## Running things

```bash
npm install                              # root install, hoists workspace deps
npm test                                 # runs vitest across all workspaces (root script)
npm run test --workspace=packages/db     # single workspace
npm run dev --workspace=apps/server      # Fastify API on :3001 (tsx, no build step)
npm run dev --workspace=apps/web         # Vite dev server on :3000, proxies /api -> :3001
```

There's no root `dev` script that runs both server and web together — start them in two terminals.

The server reads `process.env.DATABASE_URL` for its connection string; unset (the common local case), it falls back to an ephemeral in-memory PGlite instance, so every server restart starts from a fresh seeded DB unless `DATABASE_URL` points at a real Postgres server. There's still no broader `.env` / config loader (the roadmap's Slice 0 called for one under `apps/server/src/config/`; it doesn't exist) — `DATABASE_URL` is the only env var currently read.

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

## Implementation status vs. the roadmap

- **Slice 0 (infra/DB):** Done — Kysely client (PGlite locally / real Postgres via `connectionString`, single dialect — see "SQLite support was dropped" above), migration `001_initial_schema.ts` (14+ tables), seeds.
- **Slice 1 (read spine):** Largely done — `VirtualizedSuiteTree`, `TestCaseQueueGrid`, workspace hydration route in `server.ts`.
- **Slice 2 (execution loop):** Largely done — `useHotkeyEngine`, `useFocusFSM`, `FocusIndicatorBadge`, batch execution route (`routes/batchExecution.ts`), plan/build lock checks.
- **Slice 3 (admin & customization):** Partial. `routes/admin.ts`, `RoleRepository`, `AdminPanelModal.tsx`, `EntityManagementModal.tsx` exist, but the roadmap's dedicated `packages/core/src/rbac/` (permission registry + evaluator as a standalone module) and `packages/core/src/custom-fields/` (dynamic custom field engine + snapshot builder) are **not present** — custom fields aren't implemented yet, and RBAC logic lives inline in the db/server layers rather than as an independent, testable core module.
- **Slice 4 (integrations/migrations):** Partial. XML/CSV/JSON ingestion parsers exist in `packages/core/src/ingestion/` and `routes/ingestion.ts`, but machine API tokens (`tl_live_...`/`tl_ci_...`), `IStorageProvider` (S3/local attachment storage), and the import dry-run reconciliation UI are not yet built.
- No OpenAPI 3.1 spec file exists anywhere in the repo despite RFC 03 requiring one — the API contract currently lives only in route code + the RFC doc.

## Notable gaps / risks worth flagging before building on top of this

- **Auth tokens are now real, but two routes still bypass auth entirely.** `apps/server/src/routes/ingestion.ts` and `apps/server/src/routes/batchExecution.ts` never call `authenticateRequest`/`requirePermission` at all -- anyone can hit them with no token. (The inline `POST /api/v1/executions` route in `server.ts` was fixed 2026-09-14 -- see "Fixed: execution-submission route had no auth" below -- it's no longer in this category.) See "Auth: unsigned tokens replaced with signed JWTs" above.
- **No README or CI config.** Nothing tells a new contributor how to get started or runs tests automatically on changes. (A `LICENSE` — MIT — was added 2026-09-11; still no README.)

## Git

Initialized 2026-09-11 (`git init`, branch `main`), with a `.gitignore` (excludes `node_modules/`, `dist/`, `.env*`, etc.), an MIT `LICENSE`, and one root commit importing everything that existed at that point. **No remote is configured yet** — this repo only exists locally on this machine so far. Claude sessions running in a sandboxed cloud/device shell generally can't push to a remote themselves (no network egress to GitHub-like hosts, no SSH keys/`gh` auth in that environment) — pushing, and setting up the remote in the first place, needs to happen from your own terminal.

As of 2026-09-11, Elliot has authorized Claude sessions to commit directly to this local repo and manage it (logical, clearly-messaged commits per change) without asking first each time. The repo stays local/off GitHub for now, by choice — don't add a remote or attempt to push unless asked.

## Working conventions going forward

- Treat `docs/` as the source of intent, but verify against code before relying on a described behavior — the docs describe a fuller system than what's built.
- When a roadmap slice's core-package module (e.g. `rbac/`, `custom-fields/`, `state-machines/`) doesn't exist yet but the roadmap calls for it, prefer building it as its own testable module under `packages/core/src/...` rather than inlining more logic into routes/repositories, to match the intended architecture.
- Don't reintroduce a second SQL dialect (e.g. real SQLite) — see "SQLite support was dropped" above. Postgres-compatible SQL only, everywhere.
- Keep using `npm run <script> --workspace=<path>` (not `pnpm --filter`) for workspace-scoped commands — this repo is npm workspaces, not pnpm/Turborepo. `docs/01_vertical_slices_roadmap.md` now shows this syntax consistently too (rewritten 2026-09-14).
- Update this file when you fix one of the "Notable gaps" above or materially change the implementation status of a slice, so it stays a reliable map for the next session.
- Git now has real history (see "Git" above) — commit logical chunks of work with clear messages instead of letting changes pile up uncommitted, so `git log`/`git diff` are actually useful going forward.
