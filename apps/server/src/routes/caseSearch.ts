import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository } from '@testify/db';
import { requirePermission, requireAnyPermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { CaseFilterService } from '../services/caseFilterService.js';

import { sendError, reportErrorParams } from '../errors.js';
import { searchFieldsSchema, searchSchema } from '../openapi/areas/spec.js';
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
    { schema: searchFieldsSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await projectRepo.findById(projectId))) {
        return sendError(reply, 404, 'Project not found');
      }
      return { fields: await caseFilter.fieldCatalog(projectId) };
    }
  );

  app.post(
    '/api/v1/projects/:projectId/case-search',
    { schema: searchSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await projectRepo.findById(projectId))) {
        return sendError(reply, 404, 'Project not found');
      }
      const outcome = await caseFilter.evaluate(projectId, (request.body ?? {}) as Record<string, unknown>);
      if (!outcome.ok) {
        // Validation failures carry a code (INVALID_FILTER) and a list of problems; lookups a message.
        const isCode = /^[A-Z_]+$/.test(outcome.error);
        const params = reportErrorParams(outcome.details);
        const detail = isCode ? params.invalid_params?.map((p) => p.reason).join('; ') || outcome.error : outcome.error;
        return sendError(reply, outcome.status, detail, { ...(isCode ? { code: outcome.error } : {}), ...params });
      }
      return { case_ids: outcome.case_ids, suite_ids: outcome.suite_ids, total_cases: outcome.total_cases };
    }
  );
}
