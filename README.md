# Testify

Testify is an open-source, self-hosted test case management app: a faster, more modern replacement for TestLink.

- **Specification**: projects, nested test suites and versioned test cases with steps. Each case goes through draft, approved and deprecated, and you can add custom fields of six types.
- **Execution**: test plans and test runs, with a keyboard-driven queue (`j`/`k` to move, `p`/`f`/`b`/`s` to record a verdict). CI systems send results in batches through the API.
- **Reports**: run summaries compared with the previous run, plan trends, flaky and slow tests, case history and breakdowns. They're available in the app, over the REST API, by email and over MCP for AI agents.
- **Import and export**: TestLink XML, JUnit XML, TestRail CSV, CSV and JSON.
- **Access control**: roles you can edit, per-project roles and overrides, and project-scoped API tokens for CI.

## Quick start (development)

Needs Node.js 22 or newer.

```bash
npm install
npm run dev --workspace=apps/server   # API on http://localhost:3001
npm run dev --workspace=apps/web      # web app on http://localhost:3000 (in a second terminal)
```

Open http://localhost:3000 and sign in as `admin` / `password`.

The development server uses a throwaway in-memory database, so every restart starts empty. It also creates test users for each built-in role, all with the password `DevTest123!`: `test_lead`, `tester`, `viewer`, `automation_bot`, `project_admin` and `override_tester`. To load a demo project with eight runs of results, run:

```bash
npx tsx apps/server/scripts/report-demo.ts
```

## Running it for real

Testify runs as one process that serves both the API and the web app, on top of PostgreSQL. The quickest way to get both is Docker Compose:

```bash
cp .env.example .env    # then fill in POSTGRES_PASSWORD and JWT_SECRET (openssl rand -hex 32)
docker compose up -d
docker compose logs testify   # shows the first admin's generated password, once
```

Then open http://localhost:3001.

Without Docker:

```bash
npm ci
npm run build
DATABASE_URL=postgres://user:pass@host:5432/testify JWT_SECRET=$(openssl rand -hex 32) npm start
```

[docs/deployment.md](docs/deployment.md) covers configuration, HTTPS and reverse proxies, backups, upgrades and running more than one instance.

## Development

```bash
npm test             # every test, in all workspaces (Vitest)
npm run typecheck    # TypeScript, in all workspaces
npm run build        # production build: apps/web/dist and apps/server/dist/server.js
```

The code is split into npm workspaces:

| Path | What's in it |
| --- | --- |
| `apps/server` | The Fastify API server, which also serves the built web app, plus the MCP endpoint at `/mcp`. |
| `apps/web` | The React and Vite web app. |
| `packages/core` | Domain logic with no database: import parsers, report calculations, permissions, custom-field validation. |
| `packages/db` | The Kysely database layer: migrations, repositories and seeds. PostgreSQL in production; in-memory PGlite in development and tests. |

Schema changes always go in a new migration in `packages/db/src/migrations/`; never edit one that has shipped. CI (`.github/workflows/ci.yml`) typechecks, tests and builds every push. It also starts the production build on a real PostgreSQL and checks that the Docker image builds.

`CLAUDE.md` is the detailed guide for contributors and AI agents: what's built, why, and the conventions to follow. The design documents are in `docs/`.

## API and integrations

- **REST API**: sign in with `POST /api/v1/auth/login`, or use an API token from Admin Panel → API Tokens (`Authorization: Bearer tf_ci_...`).
- **Results from CI**: `POST /api/v1/test-plans/:planId/builds/:buildId/executions/batch`.
- **Reports and MCP**: [docs/reports_api_and_mcp.md](docs/reports_api_and_mcp.md) describes every report, how to send results that make good reports, and how to connect an AI agent to `/mcp`.
- **Health check**: `GET /api/v1/health`.

## License

MIT; see [LICENSE](LICENSE).
