import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { v4 as uuidv4 } from 'uuid';
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
import { sendCaseRemovedFromPlanError, sendProblemDetails, INTERNAL_ERROR_MESSAGE, logServerError } from './errors.js';
import { validateManualResult } from './services/resultValidation.js';
import { RESULT_OVERWRITE_MESSAGE, canOverwriteResults, isOverwrite, latestResultsInRun } from './services/resultOverwrite.js';
import { registerReportEmailRoutes } from './routes/reportEmail.js';
import { registerEmailAdminRoutes } from './routes/emailAdmin.js';
import { createRateLimits } from './services/rateLimits.js';
import { runDueSchedules } from './services/reportEmailService.js';
import { requirePermission } from './middleware/auth.js';
import { autoCloseBuildIfComplete } from './buildAutoClose.js';
import { resolveDatabaseConfig, resolveInitialAdminPassword, resolveCorsOrigins, resolveSecretsKey, ConfigError } from './config.js';
import { setSecretBox } from './services/secrets.js';
import { encryptStoredSmtpPassword } from './services/mailer.js';
import { UserRepository } from '@testify/db';
import { requestOrigin } from './audit.js';

// Testify only targets Postgres-compatible SQL. With no connectionString this routes to an
// ephemeral, zero-config PGlite (WASM Postgres) instance -- no server, no native bindings,
// works identically on every machine; tests rely on that. Pass a real connectionString to
// connect to a real Postgres server. The startup code at the bottom of this file decides which
// from DATABASE_URL, and never falls back to the in-memory database silently (config.ts).
export async function createServer(connectionString?: string, options: { db?: Kysely<Database> } = {}) {
  // TRUST_PROXY=true behind a reverse proxy, so request.ip (used by the sign-in limits) is the
  // real client address rather than the proxy's.
  const app = Fastify({ logger: false, trustProxy: process.env.TRUST_PROXY === 'true' });
  // Per-process rate limits for API tokens, exports and report emails (services/rateLimits.ts).
  app.decorate('rateLimits', createRateLimits());
  // Unexpected errors (database errors, bugs) are logged here and answered with a generic
  // message: their details -- SQL, table and constraint names, stack traces -- never reach the
  // client. Fastify's own request errors (bad JSON, body too large, ...) are about the request,
  // so they keep their status and message.
  app.setErrorHandler((error: any, request, reply) => {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: error.message, code: error.code });
    }
    logServerError(error, request);
    return reply.status(500).send({ error: INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR', request_id: request.id });
  });

  // Browser access from other origins only for those listed in CORS_ORIGINS (none by default);
  // see resolveCorsOrigins in config.ts. `credentials` lets a listed origin use the web app's
  // session cookie (only when it's the same site too -- the cookie is SameSite=Strict).
  const corsOrigins = resolveCorsOrigins();
  if (corsOrigins.length > 0) {
    await app.register(cors, { origin: corsOrigins, credentials: true });
  }
  // Multipart is only used for import uploads; see the limits in routes/ingestion.ts.
  await app.register(multipart, {
    limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1, fields: 20, fieldSize: IMPORT_FIELD_LIMIT_BYTES },
  });

  // `options.db` lets tests start a second server against the same database -- a restart.
  const db: Kysely<Database> = options.db ?? createDbClient({ connectionString });

  // Signing secret for session JWTs (see packages/core/src/security/jwt.ts). Set JWT_SECRET in
  // production -- every server process serving the same sessions must share it, and it must not
  // change across restarts or all existing tokens are invalidated. With no JWT_SECRET set, a
  // random secret is generated for this process only; fine for local dev/tests (tokens just don't
  // survive a restart), not for a real deployment.
  const jwtSecret = process.env.JWT_SECRET || randomBytes(32).toString('hex');
  if (!process.env.JWT_SECRET && process.env.NODE_ENV !== 'test') {
    console.warn(
      '[testify] JWT_SECRET is not set -- generated a random secret for this process only. ' +
        'Set JWT_SECRET in your environment for production so sessions survive restarts and all server instances agree.'
    );
  }

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

  // POST /api/v1/executions - Execution logging endpoint (Gated by EXECUTE_RUN)
  app.post('/api/v1/executions', { preHandler: requirePermission('EXECUTE_RUN', db, jwtSecret) }, async (request, reply) => {
    const actorId = request.user!.id;
    // Verdict, status and step verdicts must be known values (they're stored as plain strings).
    const validated = validateManualResult(request.body);
    if ('invalid' in validated) {
      return sendProblemDetails(reply, {
        status: 400,
        title: 'Bad Request',
        code: 'INVALID_RESULT',
        detail: validated.invalid.map((p) => `${p.name} ${p.reason}`).join('; '),
        invalid_params: validated.invalid,
        instance: request.url,
      });
    }
    const body = validated.result;

    // 1. Verify build and plan lock state
    const build = await db
      .selectFrom('builds')
      .innerJoin('test_plans', 'test_plans.id', 'builds.test_plan_id')
      .select(['builds.status as build_status', 'builds.test_plan_id', 'test_plans.status as plan_status', 'test_plans.project_id'])
      .where('builds.id', '=', body.build_id)
      .executeTakeFirst();

    if (!build) {
      return reply.status(404).send({ error: 'Build not found' });
    }

    // The case must be in this run's plan -- and not removed from it (a removed case keeps the
    // results it already has, read-only).
    const planCase = await db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select(['tpc.test_plan_id', 'tpc.removed_at', 'tpc.test_case_version_id', 'tpc.test_case_id', 'tc.external_id'])
      .where('tpc.id', '=', body.test_plan_case_id)
      .executeTakeFirst();
    if (!planCase || planCase.test_plan_id !== build.test_plan_id) {
      return reply.status(404).send({ error: 'Test case not found in this run\'s plan' });
    }
    if (planCase.removed_at) {
      return sendCaseRemovedFromPlanError(reply, planCase.external_id, request.url);
    }

    if (build.build_status === 'CLOSED') {
      return reply.header('content-type', 'application/problem+json').status(422).send({
        type: 'https://api.testify.dev/errors/BUILD_CLOSED',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'BUILD_CLOSED',
        detail: 'Build is closed. Executions cannot be added or modified on a closed build.',
        instance: request.url,
      });
    }

    if (build.plan_status === 'LOCKED' || build.plan_status === 'ARCHIVED') {
      return reply.header('content-type', 'application/problem+json').status(422).send({
        type: 'https://api.testify.dev/errors/PLAN_LOCKED',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'PLAN_LOCKED',
        detail: 'Test plan is locked. Executions are frozen.',
        instance: request.url,
      });
    }

    // Changing a case's existing result in this run needs EXECUTE_OVERWRITE (adding notes to
    // your own result with the same verdict doesn't) -- see services/resultOverwrite.ts.
    if (!canOverwriteResults(request.user!.permissions)) {
      const existing = (await latestResultsInRun(db, body.build_id, [planCase.test_case_id])).get(planCase.test_case_id);
      if (isOverwrite(existing, actorId, body.verdict)) {
        return sendProblemDetails(reply, {
          status: 403,
          title: 'Forbidden',
          code: 'RESULT_OVERWRITE_NOT_PERMITTED',
          detail: RESULT_OVERWRITE_MESSAGE,
          instance: request.url,
        });
      }
    }

    // Step results must be steps of the version this case runs at in the plan (its pinned
    // version); an unknown step id used to fail the insert with a 500.
    const stepNumberById = new Map<string, number>();
    if (body.step_results.length > 0) {
      const steps = await db
        .selectFrom('test_steps')
        .select(['id', 'step_number'])
        .where('test_case_version_id', '=', planCase.test_case_version_id)
        .execute();
      for (const st of steps) stepNumberById.set(st.id, st.step_number);
      const invalidSteps = body.step_results.flatMap((sr, i) => {
        const actual = stepNumberById.get(sr.test_step_id);
        if (actual === undefined) return [{ name: `step_results[${i}].test_step_id`, reason: "isn't a step of this test case" }];
        if (sr.step_number !== undefined && sr.step_number !== actual) {
          return [{ name: `step_results[${i}].step_number`, reason: `is ${actual} for this step` }];
        }
        return [];
      });
      if (invalidSteps.length > 0) {
        return sendProblemDetails(reply, {
          status: 400,
          title: 'Bad Request',
          code: 'INVALID_RESULT',
          detail: invalidSteps.map((p) => `${p.name} ${p.reason}`).join('; '),
          invalid_params: invalidSteps,
          instance: request.url,
        });
      }
    }

    const now = new Date().toISOString();
    const execId = uuidv4();

    // The result, its step results and the audit row are saved together or not at all.
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('executions')
        .values({
          id: execId,
          build_id: body.build_id,
          test_plan_case_id: body.test_plan_case_id,
          tester_id: actorId,
          status: body.status,
          verdict: body.verdict,
          // Manual execution isn't timed: this is the single-result route the UI uses, so it
          // never stores a duration, even if one is sent. Durations come only from automated
          // results via the batch route (routes/batchExecution.ts), which is all Reports'
          // "Slowest" table ranks.
          execution_duration_ms: null,
          notes: body.notes,
          source: 'UI',
          execution_timestamp: now,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (body.step_results.length > 0) {
        await trx
          .insertInto('execution_steps')
          .values(
            body.step_results.map((sr) => ({
              id: uuidv4(),
              execution_id: execId,
              test_step_id: sr.test_step_id,
              step_number: stepNumberById.get(sr.test_step_id)!,
              verdict: sr.verdict,
              actual_result: sr.actual_result,
              created_at: now,
            }))
          )
          .execute();
      }

      await trx
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actorId,
          actor_type: 'USER',
          action: 'EXECUTION_RECORDED',
          resource_type: 'execution',
          resource_id: execId,
          // The run's real project (this used to be hardwired to the sample project's id).
          project_id: build.project_id,
          diff: JSON.stringify({ verdict: body.verdict, plan_case_id: body.test_plan_case_id }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();
    });

    // 5. Auto-close the run once every case in its plan has a result.
    const buildStatus = await autoCloseBuildIfComplete(db, body.build_id, {
      id: actorId,
      type: request.user!.api_token ? 'SERVICE_ACCOUNT' : 'USER',
    }, requestOrigin(request));

    return reply.status(201).send({
      id: execId,
      verdict: body.verdict,
      status: body.status,
      created_at: now,
      build_status: buildStatus,
    });
  });

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
  const { app, db } = await createServer(dbConfig.connectionString).catch(exitOnConfigError);
  const port = Number(process.env.PORT) || 3001;
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Core Loop Fastify Server listening on ${address}`);
  });

  // Scheduled report emails: check for due schedules once a minute. (Tests call
  // runDueSchedules directly instead.) Claims are compare-and-set, so several instances
  // polling the same database never send a schedule twice.
  setInterval(() => {
    runDueSchedules(db).catch((err) => console.error('Report email scheduler failed:', err));
  }, 60_000);
}
