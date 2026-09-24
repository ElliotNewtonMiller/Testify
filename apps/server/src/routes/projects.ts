import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository, TestPlanRepository, BuildRepository } from '@testify/db';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendPlanInUseError, sendBuildInUseError } from '../errors.js';

const VALID_PLAN_STATUSES = new Set(['ACTIVE', 'LOCKED', 'ARCHIVED']);
const VALID_BUILD_STATUSES = new Set(['OPEN', 'CLOSED']);

/**
 * Real project/test-plan listings, replacing the hardcoded fake dropdown data that used to
 * live in apps/web/src/App.tsx (prj_01/02/03, pln_01/02/03 -- none of which exist in the DB).
 *
 * The test-plan mutation routes (POST/PUT/DELETE below) resurrect TestPlanRepository's
 * create/update/delete methods -- present since the very first migration but never called by
 * any route (the Plan create/edit/delete toolbar in App.tsx was 100% client-side mock state
 * with zero fetch calls, the same "designed but never wired up" pattern this session has
 * already fixed for RBAC, custom fields, and Suite/Case editing). Gated on PLAN_MANAGE, whose
 * registry description ("Create test plans and manage which test cases are in one") already
 * named this exact capability -- matches testPlanCases.ts's existing case-inclusion gate.
 */
export async function registerProjectRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const planRepo = new TestPlanRepository(db);
  const buildRepo = new BuildRepository(db);

  app.get('/api/v1/projects', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const projects = await projectRepo.findAll();
    return { projects };
  });

  app.get('/api/v1/projects/:projectId/plans', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { projectId } = request.params as { projectId: string };
    const project = await projectRepo.findById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const plans = await planRepo.findByProject(projectId);
    return { plans };
  });

  app.post(
    '/api/v1/projects/:projectId/plans',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = await projectRepo.findById(projectId);
      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const { name, description, status } = (request.body as any) || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({ error: 'name (string) is required' });
      }
      if (status !== undefined && !VALID_PLAN_STATUSES.has(status)) {
        return reply.status(400).send({ error: `status must be one of ${Array.from(VALID_PLAN_STATUSES).join(', ')}` });
      }

      const plan = await planRepo.create({ project_id: projectId, name: name.trim(), description: description ?? null, status });
      return reply.status(201).send({ plan });
    }
  );

  app.put(
    '/api/v1/projects/:projectId/plans/:planId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, planId } = request.params as { projectId: string; planId: string };
      const existing = await planRepo.findById(planId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test plan not found in this project' });
      }

      const { name, description, status } = (request.body as any) || {};
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return reply.status(400).send({ error: 'name must be a non-empty string' });
      }
      if (status !== undefined && !VALID_PLAN_STATUSES.has(status)) {
        return reply.status(400).send({ error: `status must be one of ${Array.from(VALID_PLAN_STATUSES).join(', ')}` });
      }

      const plan = await planRepo.update(planId, {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(status !== undefined ? { status } : {}),
      });
      return reply.status(200).send({ plan });
    }
  );

  app.delete(
    '/api/v1/projects/:projectId/plans/:planId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, planId } = request.params as { projectId: string; planId: string };
      const { force } = request.query as { force?: string };

      const existing = await planRepo.findById(planId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test plan not found in this project' });
      }

      const result = await planRepo.deleteWithForce(planId, { force: force === 'true' });
      if (!result.deleted) {
        return sendPlanInUseError(
          reply,
          planId,
          { builds: result.blockedBuildCount, caseLinks: result.blockedCaseLinkCount, executions: result.blockedExecutionCount },
          request.url,
          existing.name
        );
      }

      return reply.status(200).send({ deleted: true });
    }
  );

  // Test Run (Build) mutation routes, nested one level deeper than Plans (a build only ever
  // exists under one plan -- see BuildRepository/migration's uq_build_plan_name constraint,
  // already enforcing unique run names per plan at the DB layer). Same resurrection story as
  // the Plan routes above: BuildRepository.create/update/deleteWithForce existed since the
  // first migration, never called by any route -- the Run create/edit/delete toolbar was
  // 100% client-side mock state. Gated on BUILD_MANAGE (already registered/seeded, held by
  // Admin/Test Lead/Automation Service, just never had a route to gate until now).
  app.post(
    '/api/v1/projects/:projectId/plans/:planId/builds',
    { preHandler: requirePermission('BUILD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, planId } = request.params as { projectId: string; planId: string };
      const plan = await planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test plan not found in this project' });
      }

      const { name, description, status, release_date } = (request.body as any) || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return reply.status(400).send({ error: 'name (string) is required' });
      }
      if (status !== undefined && !VALID_BUILD_STATUSES.has(status)) {
        return reply.status(400).send({ error: `status must be one of ${Array.from(VALID_BUILD_STATUSES).join(', ')}` });
      }

      try {
        const build = await buildRepo.create({
          test_plan_id: planId,
          name: name.trim(),
          description: description ?? null,
          status,
          release_date: release_date ?? null,
        });
        return reply.status(201).send({ build });
      } catch (err: any) {
        // uq_build_plan_name -- a Postgres unique_violation surfaces as a raw 500 otherwise.
        if (err?.code === '23505') {
          return reply.status(409).send({ error: `A test run named "${name.trim()}" already exists in this test plan` });
        }
        throw err;
      }
    }
  );

  app.put(
    '/api/v1/projects/:projectId/plans/:planId/builds/:buildId',
    { preHandler: requirePermission('BUILD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, planId, buildId } = request.params as { projectId: string; planId: string; buildId: string };
      const plan = await planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test plan not found in this project' });
      }
      const existing = await buildRepo.findById(buildId);
      if (!existing || existing.test_plan_id !== planId) {
        return reply.status(404).send({ error: 'Test run not found in this test plan' });
      }

      const { name, description, status, release_date } = (request.body as any) || {};
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return reply.status(400).send({ error: 'name must be a non-empty string' });
      }
      if (status !== undefined && !VALID_BUILD_STATUSES.has(status)) {
        return reply.status(400).send({ error: `status must be one of ${Array.from(VALID_BUILD_STATUSES).join(', ')}` });
      }

      try {
        const build = await buildRepo.update(buildId, {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(release_date !== undefined ? { release_date } : {}),
        });
        return reply.status(200).send({ build });
      } catch (err: any) {
        if (err?.code === '23505') {
          return reply.status(409).send({ error: `A test run named "${name?.trim()}" already exists in this test plan` });
        }
        throw err;
      }
    }
  );

  app.delete(
    '/api/v1/projects/:projectId/plans/:planId/builds/:buildId',
    { preHandler: requirePermission('BUILD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId, planId, buildId } = request.params as { projectId: string; planId: string; buildId: string };
      const { force } = request.query as { force?: string };

      const plan = await planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test plan not found in this project' });
      }
      const existing = await buildRepo.findById(buildId);
      if (!existing || existing.test_plan_id !== planId) {
        return reply.status(404).send({ error: 'Test run not found in this test plan' });
      }

      const result = await buildRepo.deleteWithForce(buildId, { force: force === 'true' });
      if (!result.deleted) {
        return sendBuildInUseError(reply, buildId, { executions: result.blockedExecutionCount }, request.url, existing.name);
      }

      return reply.status(200).send({ deleted: true });
    }
  );
}
