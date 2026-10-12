import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository, TestPlanRepository, TestRunRepository } from '@testify/db';
import { authenticateRequest, requirePermission, permissionsInProject, requireAnyPermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import { sendPlanInUseError, sendRunInUseError, sendProjectInUseError, sendError } from '../errors.js';
import { requestOrigin } from '../audit.js';
import * as S from '../openapi/areas/projects.js';

const VALID_PLAN_STATUSES = new Set(['ACTIVE', 'LOCKED', 'ARCHIVED']);
const VALID_BUILD_STATUSES = new Set(['OPEN', 'CLOSED']);
// A project's prefix becomes every case's external id (e.g. SHOP-101), so keep it short and
// URL/ID-safe: a letter, then letters/digits, up to 10 chars, stored uppercase.
const PROJECT_PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/;

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
  const runRepo = new TestRunRepository(db);

  app.get('/api/v1/projects', { schema: S.listProjectsSchema }, async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    // Only the projects the caller may read or execute in (SPEC_VIEW or EXECUTE_RUN there,
    // per-project roles and overrides included), each with what the caller may do in it -- the
    // web app shows its buttons from these, since a project role can differ from the global one.
    const projects = [];
    for (const project of await projectRepo.findAll()) {
      if (user.api_token && user.api_token.project_id !== project.id) continue;
      const permissions = await permissionsInProject(user, project.id, db);
      const canSee = permissions.includes('SYSTEM_ADMIN') || EXECUTION_READ_PERMISSIONS.some((k) => permissions.includes(k));
      if (canSee) projects.push({ ...project, permissions });
    }
    return { projects };
  });

  // ---- Projects: create/edit/delete ----

  app.post(
    '/api/v1/projects',
    { schema: S.createProjectSchema, preHandler: requirePermission('PROJECT_CREATE', db, jwtSecret) },
    async (request, reply) => {
      const { name, prefix, description } = (request.body as any) || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return sendError(reply, 400, 'name (string) is required');
      }
      const normalizedPrefix = typeof prefix === 'string' ? prefix.trim().toUpperCase() : '';
      if (!PROJECT_PREFIX_RE.test(normalizedPrefix)) {
        return sendError(reply, 400, 'prefix is required: a letter followed by letters or digits, at most 10 characters (e.g. SHOP)');
      }
      if (await projectRepo.findByPrefix(normalizedPrefix)) {
        return sendError(reply, 409, `Prefix '${normalizedPrefix}' is already used by another project`);
      }
      const project = await projectRepo.create({
        name: name.trim(),
        prefix: normalizedPrefix,
        description: typeof description === 'string' && description.trim() ? description.trim() : null,
        settings: { allow_draft_plan_linking: false },
      });
      await writeProjectAudit(request, 'PROJECT_CREATED', project.id, { name: project.name, prefix: project.prefix });
      return reply.status(201).send({ project });
    }
  );

  // Editing uses PROJECT_CREATE -- the registry has no separate "edit project" key, and
  // whoever can create projects is the natural owner of renaming them.
  app.patch(
    '/api/v1/projects/:projectId',
    { schema: S.updateProjectSchema, preHandler: requirePermission('PROJECT_CREATE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const existing = await projectRepo.findById(projectId);
      if (!existing) return sendError(reply, 404, 'Project not found');

      const { name, prefix, description } = (request.body as any) || {};
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return sendError(reply, 400, 'name must be a non-empty string');
      }
      let nextPrefix: string | undefined;
      if (prefix !== undefined) {
        nextPrefix = typeof prefix === 'string' ? prefix.trim().toUpperCase() : '';
        if (!PROJECT_PREFIX_RE.test(nextPrefix)) {
          return sendError(reply, 400, 'prefix must be a letter followed by letters or digits, at most 10 characters');
        }
        if (nextPrefix !== existing.prefix) {
          const taken = await projectRepo.findByPrefix(nextPrefix);
          if (taken && taken.id !== projectId) {
            return sendError(reply, 409, `Prefix '${nextPrefix}' is already used by another project`);
          }
          // Existing cases' external ids were built from the old prefix -- changing it would
          // leave them mismatched, so it's only allowed while the project has no cases.
          const { caseCount } = await projectRepo.getContentCounts(projectId);
          if (caseCount > 0) {
            return sendError(reply, 409, `The prefix can't change once the project has test cases (it's part of their IDs, e.g. ${existing.prefix}-1).`);
          }
        } else {
          nextPrefix = undefined;
        }
      }

      const project = await projectRepo.update(projectId, {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(nextPrefix !== undefined ? { prefix: nextPrefix } : {}),
        ...(description !== undefined ? { description: typeof description === 'string' && description.trim() ? description.trim() : null } : {}),
      });
      await writeProjectAudit(request, 'PROJECT_UPDATED', projectId, {
        ...(name !== undefined ? { name: name.trim() } : {}),
        ...(nextPrefix !== undefined ? { prefix: nextPrefix } : {}),
      });
      return reply.status(200).send({ project });
    }
  );

  app.delete(
    '/api/v1/projects/:projectId',
    { schema: S.deleteProjectSchema, preHandler: requirePermission('PROJECT_DELETE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { force } = request.query as { force?: string };
      const existing = await projectRepo.findById(projectId);
      if (!existing) return sendError(reply, 404, 'Project not found');

      const result = await projectRepo.deleteWithForce(projectId, { force: force === 'true' });
      if (!result.deleted && 'blocked' in result) {
        const c = result.blocked;
        return sendProjectInUseError(
          reply,
          projectId,
          { suites: c.suiteCount, cases: c.caseCount, plans: c.planCount, runs: c.runCount, results: c.resultCount },
          request.url,
          existing.name
        );
      }
      if (!result.deleted) return sendError(reply, 404, 'Project not found');
      await writeProjectAudit(request, 'PROJECT_DELETED', projectId, {
        name: existing.name,
        prefix: existing.prefix,
        forced: force === 'true',
      });
      return reply.status(204).send();
    }
  );

  async function writeProjectAudit(
    request: FastifyRequest,
    action: string,
    projectId: string,
    diff: Record<string, unknown>
  ) {
    const actor = request.user!;
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: actor.id,
        actor_type: actor.api_token ? 'SERVICE_ACCOUNT' : 'USER',
        action,
        resource_type: 'project',
        resource_id: projectId,
        project_id: projectId,
        diff: JSON.stringify(diff),
        ...requestOrigin(request),
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  app.get('/api/v1/projects/:projectId/plans', { schema: S.listPlansSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) }, async (request, reply) => {

    const { projectId } = request.params as { projectId: string };
    const project = await projectRepo.findById(projectId);
    if (!project) {
      return sendError(reply, 404, 'Project not found');
    }

    const plans = await planRepo.findByProject(projectId);
    return { plans };
  });

  app.post(
    '/api/v1/projects/:projectId/plans',
    { schema: S.createPlanSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = await projectRepo.findById(projectId);
      if (!project) {
        return sendError(reply, 404, 'Project not found');
      }

      const { name, description, status } = (request.body as any) || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return sendError(reply, 400, 'name (string) is required');
      }
      if (status !== undefined && !VALID_PLAN_STATUSES.has(status)) {
        return sendError(reply, 400, `status must be one of ${Array.from(VALID_PLAN_STATUSES).join(', ')}`);
      }

      const plan = await planRepo.create({ project_id: projectId, name: name.trim(), description: description ?? null, status });
      return reply.status(201).send({ plan });
    }
  );

  app.patch(
    '/api/v1/plans/:planId',
    { schema: S.updatePlanSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const projectId = request.projectId ?? '';
      const existing = await planRepo.findById(planId);
      if (!existing || existing.project_id !== projectId) {
        return sendError(reply, 404, 'Test plan not found in this project');
      }

      const { name, description, status } = (request.body as any) || {};
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return sendError(reply, 400, 'name must be a non-empty string');
      }
      if (status !== undefined && !VALID_PLAN_STATUSES.has(status)) {
        return sendError(reply, 400, `status must be one of ${Array.from(VALID_PLAN_STATUSES).join(', ')}`);
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
    '/api/v1/plans/:planId',
    { schema: S.deletePlanSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const projectId = request.projectId ?? '';
      const { force } = request.query as { force?: string };

      const existing = await planRepo.findById(planId);
      if (!existing || existing.project_id !== projectId) {
        return sendError(reply, 404, 'Test plan not found in this project');
      }

      const result = await planRepo.deleteWithForce(planId, { force: force === 'true' });
      if (!result.deleted) {
        return sendPlanInUseError(
          reply,
          planId,
          { runs: result.blockedRunCount, caseLinks: result.blockedCaseLinkCount, results: result.blockedResultCount },
          request.url,
          existing.name
        );
      }

      return reply.status(204).send();
    }
  );

  // Test Run (Run) mutation routes, nested one level deeper than Plans (a run only ever
  // exists under one plan -- see TestRunRepository/migration's uq_test_run_plan_name constraint,
  // already enforcing unique run names per plan at the DB layer). Same resurrection story as
  // the Plan routes above: TestRunRepository.create/update/deleteWithForce existed since the
  // first migration, never called by any route -- the Run create/edit/delete toolbar was
  // 100% client-side mock state. Gated on RUN_MANAGE (already registered/seeded, held by
  // Admin/Test Lead/Automation Service, just never had a route to gate until now).
  app.post(
    '/api/v1/plans/:planId/runs',
    { schema: S.createRunSchema, preHandler: requirePermission('RUN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { planId } = request.params as { planId: string };
      const projectId = request.projectId ?? '';
      const plan = await planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return sendError(reply, 404, 'Test plan not found in this project');
      }

      const { name, description, status, release_date } = (request.body as any) || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return sendError(reply, 400, 'name (string) is required');
      }
      if (status !== undefined && !VALID_BUILD_STATUSES.has(status)) {
        return sendError(reply, 400, `status must be one of ${Array.from(VALID_BUILD_STATUSES).join(', ')}`);
      }

      try {
        const run = await runRepo.create({
          test_plan_id: planId,
          name: name.trim(),
          description: description ?? null,
          status,
          release_date: release_date ?? null,
        });
        return reply.status(201).send({ run });
      } catch (err: any) {
        // uq_test_run_plan_name -- a Postgres unique_violation surfaces as a raw 500 otherwise.
        if (err?.code === '23505') {
          return sendError(reply, 409, `A test run named "${name.trim()}" already exists in this test plan`);
        }
        throw err;
      }
    }
  );

  // The run, with its plan, if it belongs to the request's project (null otherwise).
  async function findRunInProject(runId: string, projectId: string) {
    const run = await runRepo.findById(runId);
    if (!run) return null;
    const plan = await planRepo.findById(run.test_plan_id);
    return plan && plan.project_id === projectId ? { run, plan } : null;
  }

  app.patch(
    '/api/v1/runs/:runId',
    { schema: S.updateRunSchema, preHandler: requirePermission('RUN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const found = await findRunInProject(runId, request.projectId ?? '');
      if (!found) {
        return sendError(reply, 404, 'Test run not found');
      }

      const { name, description, status, release_date } = (request.body as any) || {};
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
        return sendError(reply, 400, 'name must be a non-empty string');
      }
      if (status !== undefined && !VALID_BUILD_STATUSES.has(status)) {
        return sendError(reply, 400, `status must be one of ${Array.from(VALID_BUILD_STATUSES).join(', ')}`);
      }

      try {
        const run = await runRepo.update(runId, {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(status !== undefined ? { status } : {}),
          ...(release_date !== undefined ? { release_date } : {}),
        });
        return reply.status(200).send({ run });
      } catch (err: any) {
        if (err?.code === '23505') {
          return sendError(reply, 409, `A test run named "${name?.trim()}" already exists in this test plan`);
        }
        throw err;
      }
    }
  );

  app.delete(
    '/api/v1/runs/:runId',
    { schema: S.deleteRunSchema, preHandler: requirePermission('RUN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const { force } = request.query as { force?: string };

      const found = await findRunInProject(runId, request.projectId ?? '');
      if (!found) {
        return sendError(reply, 404, 'Test run not found');
      }
      const existing = found.run;

      const result = await runRepo.deleteWithForce(runId, { force: force === 'true' });
      if (!result.deleted) {
        return sendRunInUseError(reply, runId, { results: result.blockedResultCount }, request.url, existing.name);
      }

      return reply.status(204).send();
    }
  );
}
