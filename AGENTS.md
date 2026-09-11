# Testify — Agent / Contributor Guide

This file orients any AI coding agent (Claude, Gemini/Antigravity, etc.) or human contributor working in this repo. Read this before making changes.

## What this project is

Testify (internal codename in the docs/config: **"TestLink Sequel"** / `testlink-sequel`) is an open-source, self-hostable test case management platform meant as a modern, faster, more extensible replacement for TestLink. Core entities: Projects → Test Suites (recursive tree) → Test Cases → Test Case Versions → Test Steps, plus Test Plans → Builds → Executions, dynamic Custom Fields, and a granular RBAC/permission system.

The product direction was defined by an Antigravity (Gemini) multi-agent planning session — see **Doc map** below — before implementation started. Slices 0–2 (infra, read spine, execution loop) are substantially implemented; slices 3–4 (admin/RBAC UI, custom fields engine, import/export, storage) are partial or not yet started. See "Implementation status" below for specifics.

## Doc map (read in this order)

1. `.antigravity/requirements_alignment.md` — locked product decisions from intake (retention, versioning, hotkeys, ingestion).
2. `.antigravity/agents/*.md` — the 5 role prompts (lead_architect, api_integration, qa_specialist, security_rbac, ux_ergonomics) used to generate the RFCs below. Useful for understanding *why* a decision was made.
3. `docs/rfc_01_domain_model.md`, `rfc_02_ux_density_and_hotkeys.md`, `rfc_03_api_and_xml_contracts.md`, `rfc_04_rbac_security_matrix.md` — detailed specs per domain.
4. `docs/MASTER_ARCHITECTURE_BLUEPRINT.md` — synthesis of the RFCs into one architecture doc.
5. `docs/01_vertical_slices_roadmap.md` — the build plan, sliced into Slice 0–4 with target file structures, API contracts, and verification commands per slice. **Note:** this doc assumes `pnpm` + Turborepo; the actual repo uses plain `npm` workspaces (no Turborepo, no `pnpm-workspace.yaml`). Translate any `pnpm --filter X run Y` command in that doc to `npm run Y --workspace=X`.

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

Other docs that still describe a literal dual-SQLite-and-Postgres architecture as a requirement (`.antigravity/agents/lead_architect.md`'s "Dual-Driver Database Layer (SQLite + PostgreSQL)" section, `docs/MASTER_ARCHITECTURE_BLUEPRINT.md`, `docs/01_vertical_slices_roadmap.md`) have **not** been rewritten to match — they're historical planning artifacts now, not current architecture. Don't use them as a reason to reintroduce a second dialect; check this file, `docs/rfc_01_domain_model.md`, and the actual code first.

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

## Implementation status vs. the roadmap

- **Slice 0 (infra/DB):** Done — Kysely client (PGlite locally / real Postgres via `connectionString`, single dialect — see "SQLite support was dropped" above), migration `001_initial_schema.ts` (14+ tables), seeds.
- **Slice 1 (read spine):** Largely done — `VirtualizedSuiteTree`, `TestCaseQueueGrid`, workspace hydration route in `server.ts`.
- **Slice 2 (execution loop):** Largely done — `useHotkeyEngine`, `useFocusFSM`, `FocusIndicatorBadge`, batch execution route (`routes/batchExecution.ts`), plan/build lock checks.
- **Slice 3 (admin & customization):** Partial. `routes/admin.ts`, `RoleRepository`, `AdminPanelModal.tsx`, `EntityManagementModal.tsx` exist, but the roadmap's dedicated `packages/core/src/rbac/` (permission registry + evaluator as a standalone module) and `packages/core/src/custom-fields/` (dynamic custom field engine + snapshot builder) are **not present** — custom fields aren't implemented yet, and RBAC logic lives inline in the db/server layers rather than as an independent, testable core module.
- **Slice 4 (integrations/migrations):** Partial. XML/CSV/JSON ingestion parsers exist in `packages/core/src/ingestion/` and `routes/ingestion.ts`, but machine API tokens (`tl_live_...`/`tl_ci_...`), `IStorageProvider` (S3/local attachment storage), and the import dry-run reconciliation UI are not yet built.
- No OpenAPI 3.1 spec file exists anywhere in the repo despite RFC 03 requiring one — the API contract currently lives only in route code + the RFC doc.

## Notable gaps / risks worth flagging before building on top of this

- **Auth tokens are now real, but three routes still bypass auth entirely.** `apps/server/src/routes/ingestion.ts`, `apps/server/src/routes/batchExecution.ts`, and the inline `POST /api/v1/executions` route in `server.ts` never call `authenticateRequest`/`requirePermission` at all -- anyone can hit them with no token. See "Auth: unsigned tokens replaced with signed JWTs" above.
- **No README or CI config.** Nothing tells a new contributor how to get started or runs tests automatically on changes. (A `LICENSE` — MIT — was added 2026-09-11; still no README.)
- **Project naming is inconsistent**: the folder is `Testify`, `package.json`'s `name` is `testlink-sequel`, and the docs call the product "TestLink Sequel" throughout. Worth picking one name and updating `package.json`/docs/UI copy to match if "Testify" is the real name going forward.

## Git

Initialized 2026-09-11 (`git init`, branch `main`), with a `.gitignore` (excludes `node_modules/`, `dist/`, `.env*`, etc.), an MIT `LICENSE`, and one root commit importing everything that existed at that point. **No remote is configured yet** — this repo only exists locally on this machine so far. Claude sessions running in a sandboxed cloud/device shell generally can't push to a remote themselves (no network egress to GitHub-like hosts, no SSH keys/`gh` auth in that environment) — pushing, and setting up the remote in the first place, needs to happen from your own terminal.

As of 2026-09-11, Elliot has authorized Claude sessions to commit directly to this local repo and manage it (logical, clearly-messaged commits per change) without asking first each time. The repo stays local/off GitHub for now, by choice — don't add a remote or attempt to push unless asked.

## Working conventions going forward

- Treat `docs/` as the source of intent, but verify against code before relying on a described behavior — the docs describe a fuller system than what's built.
- When a roadmap slice's core-package module (e.g. `rbac/`, `custom-fields/`, `state-machines/`) doesn't exist yet but the roadmap calls for it, prefer building it as its own testable module under `packages/core/src/...` rather than inlining more logic into routes/repositories, to match the intended architecture.
- Don't reintroduce a second SQL dialect (e.g. real SQLite) — see "SQLite support was dropped" above. Postgres-compatible SQL only, everywhere.
- Keep using `npm run <script> --workspace=<path>` (not `pnpm --filter`) for workspace-scoped commands — this repo is npm workspaces, not pnpm/Turborepo, regardless of what `docs/01_vertical_slices_roadmap.md` shows.
- Update this file when you fix one of the "Notable gaps" above or materially change the implementation status of a slice, so it stays a reliable map for the next session.
- Git now has real history (see "Git" above) — commit logical chunks of work with clear messages instead of letting changes pile up uncommitted, so `git log`/`git diff` are actually useful going forward.
