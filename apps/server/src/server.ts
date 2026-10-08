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
import { registerIngestionRoutes } from './routes/ingestion.js';
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
import { sendCaseRemovedFromPlanError } from './errors.js';
import { registerReportEmailRoutes } from './routes/reportEmail.js';
import { registerEmailAdminRoutes } from './routes/emailAdmin.js';
import { runDueSchedules } from './services/reportEmailService.js';
import { requirePermission } from './middleware/auth.js';
import { autoCloseBuildIfComplete } from './buildAutoClose.js';
import { resolveDatabaseConfig, resolveInitialAdminPassword, ConfigError } from './config.js';
import { UserRepository } from '@testify/db';

// Testify only targets Postgres-compatible SQL. With no connectionString this routes to an
// ephemeral, zero-config PGlite (WASM Postgres) instance -- no server, no native bindings,
// works identically on every machine; tests rely on that. Pass a real connectionString to
// connect to a real Postgres server. The startup code at the bottom of this file decides which
// from DATABASE_URL, and never falls back to the in-memory database silently (config.ts).
export async function createServer(connectionString?: string, options: { db?: Kysely<Database> } = {}) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: '*' });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max file size

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
    const body = request.body as {
      build_id: string;
      test_plan_case_id: string;
      verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
      status?: 'COMPLETED' | 'IN_PROGRESS';
      notes?: string;
      step_results?: Array<{ test_step_id: string; step_number: number; verdict: string; actual_result?: string }>;
    };

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
      .select(['tpc.test_plan_id', 'tpc.removed_at', 'tc.external_id'])
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

    const now = new Date().toISOString();
    const execId = uuidv4();

    // 2. Insert immutable execution snapshot
    await db
      .insertInto('executions')
      .values({
        id: execId,
        build_id: body.build_id,
        test_plan_case_id: body.test_plan_case_id,
        tester_id: actorId,
        status: body.status || 'COMPLETED',
        verdict: body.verdict,
        // Manual execution isn't timed: this is the single-result route the UI uses, so it
        // never stores a duration, even if one is sent. Durations come only from automated
        // results via the batch route (routes/batchExecution.ts), which is all Reports'
        // "Slowest" table ranks.
        execution_duration_ms: null,
        notes: body.notes || null,
        custom_fields_snapshot: '{}',
        source: 'UI',
        execution_timestamp: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 3. Insert step verdicts if provided
    if (body.step_results && body.step_results.length > 0) {
      for (const s of body.step_results) {
        await db
          .insertInto('execution_steps')
          .values({
            id: uuidv4(),
            execution_id: execId,
            test_step_id: s.test_step_id,
            step_number: s.step_number,
            verdict: s.verdict,
            actual_result: s.actual_result || null,
            created_at: now,
          })
          .execute();
      }
    }

    // 4. Emit Audit Event
    await db
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
        ip_address: '127.0.0.1',
        user_agent: 'FastifyCoreLoopServer',
        created_at: now,
      })
      .execute();

    // 5. Auto-close the run once every case in its plan has a result.
    const buildStatus = await autoCloseBuildIfComplete(db, body.build_id, {
      id: actorId,
      type: request.user!.api_token ? 'SERVICE_ACCOUNT' : 'USER',
    });

    return reply.status(201).send({
      id: execId,
      verdict: body.verdict,
      status: body.status || 'COMPLETED',
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
