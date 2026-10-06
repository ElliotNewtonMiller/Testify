import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository } from '@testify/db';
import { requirePermission } from '../middleware/auth.js';
import { CaseFilterService } from '../services/caseFilterService.js';

/**
 * Case search & filter routes. The evaluation itself lives in CaseFilterService (shared with
 * the reports, which accept the same `filter`). The web UI calls exactly these routes (it
 * narrows its already-loaded spec-tree / plan-cases data to the returned ids), so anything
 * the UI can filter, an API caller can too.
 *
 * GET  /api/v1/projects/:projectId/case-search/fields -- catalog of filterable properties.
 * POST /api/v1/projects/:projectId/case-search        -- { q?, filters?, plan_id?, build_id? }
 *      -> { case_ids, suite_ids, total_cases }.
 *
 * Nested under :projectId and gated on SPEC_VIEW, same as reports.ts, so project-scoped
 * overrides and machine API tokens resolve correctly.
 */
export async function registerCaseSearchRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const caseFilter = new CaseFilterService(db);

  app.get(
    '/api/v1/projects/:projectId/case-search/fields',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await projectRepo.findById(projectId))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      return { fields: await caseFilter.fieldCatalog(projectId) };
    }
  );

  app.post(
    '/api/v1/projects/:projectId/case-search',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await projectRepo.findById(projectId))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      const outcome = await caseFilter.evaluate(projectId, (request.body ?? {}) as Record<string, unknown>);
      if (!outcome.ok) {
        return reply.status(outcome.status).send(outcome.details !== undefined ? { error: outcome.error, details: outcome.details } : { error: outcome.error });
      }
      return { case_ids: outcome.case_ids, suite_ids: outcome.suite_ids, total_cases: outcome.total_cases };
    }
  );
}
