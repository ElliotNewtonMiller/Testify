import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { v4 as uuidv4 } from 'uuid';
import {
  createDbClient,
  migration001,
  seedCoreLoopData,
  type Database,
} from '@testlink/db';
import type { Kysely } from 'kysely';
import { registerIngestionRoutes } from './routes/ingestion.js';
import { registerBatchExecutionRoutes } from './routes/batchExecution.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { sendCaseVersionLockedError } from './errors.js';
import { UserRepository } from '@testlink/db';

// Testify only targets Postgres-compatible SQL. With no connectionString this routes to an
// ephemeral, zero-config PGlite (WASM Postgres) instance -- no server, no native bindings,
// works identically on every machine. Pass a real connectionString (e.g. from DATABASE_URL)
// to connect to a real Postgres server for production/team deployments. See AGENTS.md.
export async function createServer(connectionString?: string) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: '*' });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB max file size

  const db: Kysely<Database> = createDbClient({ connectionString });

  // Run migrations & seed core loop data & initial omnipotent admin user
  await migration001.up(db);
  const seed = await seedCoreLoopData(db);
  const userRepo = new UserRepository(db);
  await userRepo.seedInitialAdmin();

  // Register Ingestion, Batch Execution, Auth, & Admin Routes
  await registerIngestionRoutes(app, db);
  await registerBatchExecutionRoutes(app, db);
  await registerAuthRoutes(app, db);
  await registerAdminRoutes(app, db);

  // GET /api/v1/workspace - Hydrates high-density 3-pane layout
  app.get('/api/v1/workspace', async () => {
    const project = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', seed.projectId)
      .executeTakeFirstOrThrow();

    const suites = await db
      .selectFrom('test_suites')
      .selectAll()
      .where('project_id', '=', seed.projectId)
      .execute();

    const plan = await db
      .selectFrom('test_plans')
      .selectAll()
      .where('id', '=', seed.planId)
      .executeTakeFirstOrThrow();

    const build = await db
      .selectFrom('builds')
      .selectAll()
      .where('id', '=', seed.buildId)
      .executeTakeFirstOrThrow();

    // Query test plan cases joined with test_cases, test_case_versions, and latest executions
    const rawCases = await db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .innerJoin('test_case_versions as tcv', 'tcv.id', 'tpc.test_case_version_id')
      .select([
        'tpc.id as plan_case_id',
        'tpc.position',
        'tc.id as case_id',
        'tc.external_id',
        'tc.title',
        'tc.priority',
        'tc.execution_type',
        'tcv.id as version_id',
        'tcv.version_number',
        'tcv.status as version_status',
        'tcv.summary',
        'tcv.preconditions',
      ])
      .where('tpc.test_plan_id', '=', seed.planId)
      .orderBy('tpc.position', 'asc')
      .execute();

    // Fetch steps and latest executions for each case
    const cases = await Promise.all(
      rawCases.map(async (c) => {
        const steps = await db
          .selectFrom('test_steps')
          .selectAll()
          .where('test_case_version_id', '=', c.version_id)
          .orderBy('step_number', 'asc')
          .execute();

        const latestExec = await db
          .selectFrom('executions')
          .selectAll()
          .where('test_plan_case_id', '=', c.plan_case_id)
          .where('build_id', '=', seed.buildId)
          .orderBy('created_at', 'desc')
          .executeTakeFirst();

        return {
          ...c,
          steps,
          latest_verdict: latestExec?.verdict || 'UNTESTED',
          latest_execution_id: latestExec?.id || null,
        };
      })
    );

    return {
      project,
      suites,
      plan,
      build,
      cases,
    };
  });

  // POST /api/v1/executions - Execution logging endpoint
  app.post('/api/v1/executions', async (request, reply) => {
    const body = request.body as {
      build_id: string;
      test_plan_case_id: string;
      verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
      status?: 'COMPLETED' | 'IN_PROGRESS';
      notes?: string;
      execution_duration_ms?: number;
      step_results?: Array<{ test_step_id: string; step_number: number; verdict: string; actual_result?: string }>;
    };

    // 1. Verify build and plan lock state
    const build = await db
      .selectFrom('builds')
      .innerJoin('test_plans', 'test_plans.id', 'builds.test_plan_id')
      .select(['builds.status as build_status', 'test_plans.status as plan_status'])
      .where('builds.id', '=', body.build_id)
      .executeTakeFirst();

    if (!build) {
      return reply.status(404).send({ error: 'Build not found' });
    }

    if (build.build_status === 'CLOSED') {
      return reply.header('content-type', 'application/problem+json').status(422).send({
        type: 'https://api.testlink-next.io/errors/BUILD_CLOSED',
        title: 'Unprocessable Entity',
        status: 422,
        code: 'BUILD_CLOSED',
        detail: 'Build is closed. Executions cannot be added or modified on a closed build.',
        instance: request.url,
      });
    }

    if (build.plan_status === 'LOCKED' || build.plan_status === 'ARCHIVED') {
      return reply.header('content-type', 'application/problem+json').status(422).send({
        type: 'https://api.testlink-next.io/errors/PLAN_LOCKED',
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
        tester_id: 'usr_tester_01',
        status: body.status || 'COMPLETED',
        verdict: body.verdict,
        execution_duration_ms: body.execution_duration_ms || 450,
        notes: body.notes || null,
        custom_fields_snapshot: JSON.stringify({ environment: 'STAGING' }),
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
        actor_id: 'usr_tester_01',
        actor_type: 'USER',
        action: 'EXECUTION_RECORDED',
        resource_type: 'execution',
        resource_id: execId,
        project_id: seed.projectId,
        diff: JSON.stringify({ verdict: body.verdict, plan_case_id: body.test_plan_case_id }),
        ip_address: '127.0.0.1',
        user_agent: 'FastifyCoreLoopServer',
        created_at: now,
      })
      .execute();

    return reply.status(201).send({
      id: execId,
      verdict: body.verdict,
      status: body.status || 'COMPLETED',
      created_at: now,
    });
  });

  // PUT /api/v1/test-case-versions/:versionId - Edit Test Case Version (Enforces CASE_VERSION_LOCKED)
  app.put('/api/v1/test-case-versions/:versionId', async (request, reply) => {
    const { versionId } = request.params as { versionId: string };
    const version = await db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('id', '=', versionId)
      .executeTakeFirst();

    if (!version) {
      return reply.status(404).send({ error: 'Test case version not found' });
    }

    if (version.status === 'APPROVED') {
      return sendCaseVersionLockedError(reply, versionId, request.url);
    }

    const body = (request.body as any) || {};
    const now = new Date().toISOString();
    await db
      .updateTable('test_case_versions')
      .set({
        summary: body.summary ?? version.summary,
        preconditions: body.preconditions ?? version.preconditions,
        updated_at: now,
      })
      .where('id', '=', versionId)
      .execute();

    return reply.status(200).send({ id: versionId, status: version.status, updated_at: now });
  });

  // GET /api/v1/executions/verify - Verification endpoint for database assertions
  app.get('/api/v1/executions/verify', async () => {
    const executions = await db.selectFrom('executions').selectAll().orderBy('created_at', 'desc').execute();
    const steps = await db.selectFrom('execution_steps').selectAll().execute();
    const auditLogs = await db.selectFrom('audit_logs').selectAll().execute();

    return {
      total_executions: executions.length,
      executions,
      steps,
      auditLogs,
    };
  });

  return { app, db, seed };
}

if (process.env.NODE_ENV !== 'test') {
  const { app } = await createServer(process.env.DATABASE_URL);
  const port = Number(process.env.PORT) || 3001;
  app.listen({ port, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Core Loop Fastify Server listening on ${address}`);
  });
}
