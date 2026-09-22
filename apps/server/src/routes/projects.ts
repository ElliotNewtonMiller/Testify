import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository, TestPlanRepository } from '@testify/db';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendPlanInUseError } from '../errors.js';

const VALID_PLAN_STATUSES = new Set(['ACTIVE', 'LOCKED', 'ARCHIVED']);

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
}
