import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  createDbClient,
  migrateToLatest,
  seedCoreLoopData,
  seedRbacRegistry,
  seedDevFixtures,
  type Database,
} from '@testify/db';
import type { Kysely } from 'kysely';
import { registerIngestionRoutes, IMPORT_FIELD_LIMIT_BYTES, IMPORT_MAX_FILE_BYTES } from './routes/ingestion.js';
import { registerBatchExecutionRoutes } from './routes/batchExecution.js';
import { registerResultRoutes } from './routes/results.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerTestPlanCaseRoutes } from './routes/testPlanCases.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerCustomFieldRoutes } from './routes/customFields.js';
import { registerSpecEditingRoutes } from './routes/specEditing.js';
import { registerApiTokenRoutes } from './routes/apiTokens.js';
import { registerExportRoutes } from './routes/exports.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerCaseSearchRoutes } from './routes/caseSearch.js';
import { registerMcpRoutes } from './mcp/mcpServer.js';
import { INTERNAL_ERROR_MESSAGE, logServerError, sendError } from './errors.js';
import { registerReportEmailRoutes } from './routes/reportEmail.js';
import { registerEmailAdminRoutes } from './routes/emailAdmin.js';
import { createRateLimits } from './services/rateLimits.js';
import { runDueSchedules } from './services/reportEmailService.js';
import { resolveDatabaseConfig, resolveInitialAdminPassword, resolveCorsOrigins, resolveSecretsKey, resolveWebDistDir, resolveJwtSecret, resolveLogLevel, ConfigError } from './config.js';
import { loggerOptions, registerRequestLogging, registerHealthRoute } from './observability.js';
import { registerWebApp } from './webApp.js';
import { registerOpenApi, validationProblem } from './openapi/index.js';
import { setSecretBox } from './services/secrets.js';
import { encryptStoredSmtpPassword } from './services/mailer.js';
import { UserRepository } from '@testify/db';

// Testify only targets Postgres-compatible SQL. With no connectionString this routes to an
// ephemeral, zero-config PGlite (WASM Postgres) instance -- no server, no native bindings,
// works identically on every machine; tests rely on that. Pass a real connectionString to
// connect to a real Postgres server. The startup code at the bottom of this file decides which
// from DATABASE_URL, and never falls back to the in-memory database silently (config.ts).
export async function createServer(
  connectionString?: string,
  options: { db?: Kysely<Database>; webDistDir?: string | null; logStream?: NodeJS.WritableStream; checkResponses?: boolean } = {}
) {
  // TRUST_PROXY=true behind a reverse proxy, so request.ip (used by the sign-in limits) is the
  // real client address rather than the proxy's.
  // Logging: one JSON line per request on stdout at LOG_LEVEL (observability.ts). Tests pass
  // `logStream` to read the log.
  const app = Fastify({ ...loggerOptions(resolveLogLevel(), options.logStream), trustProxy: process.env.TRUST_PROXY === 'true' });
  registerRequestLogging(app);
  // Per-process rate limits for API tokens, exports and report emails (services/rateLimits.ts).
  app.decorate('rateLimits', createRateLimits());
  // Unexpected errors (database errors, bugs) are logged here and answered with a generic
  // message: their details -- SQL, table and constraint names, stack traces -- never reach the
  // client. Fastify's own request errors (bad JSON, body too large, ...) are about the request,
  // so they keep their status and message.
  app.setErrorHandler((error: any, request, reply) => {
    // A request that doesn't match its route's schema (openapi/index.ts): name each field.
    if (Array.isArray(error?.validation)) {
      const invalid = validationProblem(error.validation, error.validationContext);
      return sendError(reply, 400, invalid.map((p) => `${p.name} ${p.reason}`).join('; ') || 'Invalid request', {
        code: 'INVALID_REQUEST',
        invalid_params: invalid,
      });
    }
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      // Fastify's own codes (FST_...) are internal names; callers get the standard code for the status.
      const code = typeof error.code === 'string' && !error.code.startsWith('FST_') ? error.code : undefined;
      return sendError(reply, status, error.message, { code });
    }
    logServerError(error, request);
    return sendError(reply, 500, INTERNAL_ERROR_MESSAGE, { code: 'INTERNAL_ERROR', request_id: request.id });
  });

  // Browser access from other origins only for those listed in CORS_ORIGINS (none by default);
  // see resolveCorsOrigins in config.ts. `credentials` lets a listed origin use the web app's
  // session cookie (only when it's the same site too -- the cookie is SameSite=Strict).
  const corsOrigins = resolveCorsOrigins();
  if (corsOrigins.length > 0) {
    await app.register(cors, { origin: corsOrigins, credentials: true });
  }
  // The OpenAPI spec (/docs/json), the docs page (/docs), request validation from route
  // schemas, and -- in tests -- checking every response against the spec. Before any route.
  await registerOpenApi(app, { checkResponses: options.checkResponses ?? process.env.NODE_ENV === 'test' });

  // Multipart is only used for import uploads; see the limits in routes/ingestion.ts.
  await app.register(multipart, {
    limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: IMPORT_FIELD_LIMIT_BYTES },
  });

  // `options.db` lets tests start a second server against the same database -- a restart.
  const db: Kysely<Database> = options.db ?? createDbClient({ connectionString });

  // Signing secret for session JWTs (see packages/core/src/security/jwt.ts): JWT_SECRET, which
  // a real database requires (resolveJwtSecret in config.ts). Only the in-memory database falls
  // back to a random secret for this process.
  const jwtSecret = resolveJwtSecret({ inMemory: !connectionString });

  // Bring the schema up to date (only migrations that haven't run yet -- safe on every start,
  // including against a database that's already current), then seed the RBAC registry
  // (roles/permissions/bundles) before any user or role row gets written, then the initial
  // omnipotent admin user. Every seed below is idempotent too, so restarting against the same
  // database is a no-op. The core-loop sample project (SHOP suite/cases/plan/run) is seeded
  // ONLY for the test suite, which builds on its fixed ids (`seed`); a dev or real server starts
  // with no projects at all, and SEED_SAMPLE_DATA=true brings the sample back locally if wanted.
  await migrateToLatest(db);
  // Key for secrets stored in the database (SECRETS_KEY), then encrypt an SMTP password saved
  // in plaintext by an older version.
  setSecretBox(resolveSecretsKey({ inMemory: !connectionString }));
  await encryptStoredSmtpPassword(db);
  await seedRbacRegistry(db);
  const seedSampleData = process.env.NODE_ENV === 'test' || process.env.SEED_SAMPLE_DATA === 'true';
  const seed = seedSampleData ? await seedCoreLoopData(db) : null;
  // The first admin, only when there are no users yet. Its password comes from ADMIN_PASSWORD,
  // or is generated and printed once (see config.ts) -- never a well-known default on a real database.
  const userRepo = new UserRepository(db);
  if (!(await userRepo.hasAnyUser())) {
    const initialAdmin = resolveInitialAdminPassword({ inMemory: !connectionString });
    await userRepo.seedInitialAdmin(initialAdmin);
    if (initialAdmin.source === 'generated') {
      console.warn(
        [
          '',
          '[testify] ============================================================',
          '[testify] Created the first admin user. Sign in with:',
          '[testify]   username: admin',
          `[testify]   password: ${initialAdmin.password}`,
          '[testify] This is shown only once. You will be asked to choose a new',
          '[testify] password at first sign-in. (Set ADMIN_PASSWORD to choose it yourself.)',
          '[testify] ============================================================',
          '',
        ].join('\n')
      );
    }
  }

  // Extra local-dev-only fixtures (users covering every role plus a permission override; no
  // sample projects) -- gives you real users to test roles with instead of only the admin. Never runs in tests
  // (vitest sets NODE_ENV=test) or against a real DATABASE_URL (a real/shared database
  // shouldn't get fake test users seeded into it); set SEED_DEV_FIXTURES=false to opt out
  // locally too.
  if (!connectionString && process.env.NODE_ENV !== 'test' && process.env.SEED_DEV_FIXTURES !== 'false') {
    await seedDevFixtures(db);
  }

  // Register Ingestion, Batch Execution, Auth, Admin, Spec/Plan-Curation, Project, Custom Field, Spec-Editing, & API Token Routes
  await registerIngestionRoutes(app, db, jwtSecret);
  await registerBatchExecutionRoutes(app, db, jwtSecret);
  await registerAuthRoutes(app, db, jwtSecret);
  await registerAdminRoutes(app, db, jwtSecret);
  await registerTestPlanCaseRoutes(app, db, jwtSecret);
  await registerProjectRoutes(app, db, jwtSecret);
  await registerCustomFieldRoutes(app, db, jwtSecret);
  await registerSpecEditingRoutes(app, db, jwtSecret);
  await registerApiTokenRoutes(app, db, jwtSecret);
  await registerExportRoutes(app, db, jwtSecret);
  await registerReportRoutes(app, db, jwtSecret);
  await registerCaseSearchRoutes(app, db, jwtSecret);
  await registerMcpRoutes(app, db, jwtSecret);
  await registerReportEmailRoutes(app, db, jwtSecret);
  await registerEmailAdminRoutes(app, db, jwtSecret);
  await registerResultRoutes(app, db, jwtSecret);


  // GET /api/v1/health, for load balancers and uptime monitors (observability.ts).
  registerHealthRoute(app, db);

  // The built web app, served for every address the API doesn't handle (webApp.ts).
  if (options.webDistDir) registerWebApp(app, options.webDistDir);
  // Without a web build, any unknown address gets a problem-details 404 too (registerWebApp
  // answers unknown /api and /mcp addresses the same way).
  else app.setNotFoundHandler((request, reply) => sendError(reply, 404, `Route ${request.method}:${request.url} not found`));

  return { app, db, seed };
}

if (process.env.NODE_ENV !== 'test') {
  // Refuse to start without an explicit database (see config.ts) rather than quietly using a
  // throwaway one.
  const exitOnConfigError = (err: unknown): never => {
    if (!(err instanceof ConfigError)) throw err;
    console.error(`[testify] ${err.message}`);
    process.exit(1);
  };
  let dbConfig: ReturnType<typeof resolveDatabaseConfig>;
  try {
    dbConfig = resolveDatabaseConfig();
  } catch (err) {
    dbConfig = exitOnConfigError(err);
  }
  if (dbConfig.inMemory) {
    console.warn(
      '[testify] Using a throwaway in-memory database (DATABASE_URL=memory). All data is lost when the server stops. ' +
        'Set DATABASE_URL to a PostgreSQL connection string to keep your data.'
    );
  }
  let webDistDir: string | null;
  try {
    webDistDir = resolveWebDistDir();
  } catch (err) {
    webDistDir = exitOnConfigError(err);
  }
  const { app, db } = await createServer(dbConfig.connectionString, { webDistDir }).catch(exitOnConfigError);
  const port = Number(process.env.PORT) || 3001;
  console.log(
    webDistDir
      ? `[testify] Serving the web app from ${webDistDir}`
      : '[testify] No built web app found (run `npm run build`), so only the API is served.'
  );
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`[testify] Listening on ${address}`);
  });

  // Scheduled report emails: check for due schedules once a minute. (Tests call
  // runDueSchedules directly instead.) Claims are compare-and-set, so several instances
  // polling the same database never send a schedule twice.
  setInterval(() => {
    runDueSchedules(db).catch((err) => console.error('Report email scheduler failed:', err));
  }, 60_000);
}
