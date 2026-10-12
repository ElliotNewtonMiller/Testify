import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { CustomFieldRepository, TestCaseVersionRepository, TestPlanRepository } from '@testify/db';
import { requireAnyPermission, requirePermission } from '../middleware/auth.js';
import { sendError, sendPlanLockedError } from '../errors.js';
import { innerRequest, internalVia, type InnerResponse, type InternalVia } from '../internalRequests.js';
import * as S from '../openapi/areas/spec.js';

/**
 * Bulk changes (API roadmap step 9): one call that changes many cases, where a script would
 * otherwise loop. Each item goes through the ordinary single-item route (internalRequests.ts), so
 * the rules, errors and audit rows are those of the single route; each item succeeds or fails on
 * its own, and the answer lists every item (200, or 207 when some failed). The MCP tools use these
 * too.
 *
 *   POST /api/v1/projects/:projectId/cases/bulk  { action: update | approve | deprecate | restore, case_ids, changes? }
 *   POST /api/v1/plans/:planId/cases/bulk        { action: add | remove, case_ids, retire_if_has_results? }
 */

export const BULK_MAX_CASES = 500;

export interface BulkItemResult {
  index: number;
  test_case_id: string;
  external_id: string | null;
  status: number;
  code?: string;
  detail?: string;
  test_case_version_id?: string;
  test_plan_case_id?: string;
}

export interface BulkResponse {
  object: 'bulk_results';
  summary: { total: number; succeeded: number; failed: number };
  results: BulkItemResult[];
}

const has = (request: FastifyRequest, key: string) => request.user!.permissions.includes(key) || request.user!.permissions.includes('SYSTEM_ADMIN');

/** 403 for the first permission the caller lacks; true when they hold them all. */
function holds(request: FastifyRequest, reply: FastifyReply, keys: string[], what: string): boolean {
  const missing = keys.find((k) => !has(request, k));
  if (!missing) return true;
  sendError(reply, 403, `${what} needs ${missing}`, { required_permission: missing });
  return false;
}

/** 400 when an id is listed twice (the second would only fail, or undo the first). */
function refuseRepeats(reply: FastifyReply, ids: string[]): boolean {
  const seen = new Set<string>();
  const repeats = ids.flatMap((id, i) => (seen.has(id) ? [i] : (seen.add(id), [])));
  if (!repeats.length) return false;
  sendError(reply, 400, 'case_ids lists a case more than once', {
    invalid_params: repeats.map((i) => ({ name: `case_ids[${i}]`, reason: 'repeats an earlier case' })),
  });
  return true;
}

/** An item's outcome from its inner response. */
function itemOutcome(index: number, testCaseId: string, externalId: string | null, res: InnerResponse, extra: Partial<BulkItemResult> = {}): BulkItemResult {
  if (res.status < 400) return { index, test_case_id: testCaseId, external_id: externalId, status: res.status, ...extra };
  return {
    index,
    test_case_id: testCaseId,
    external_id: externalId,
    status: res.status,
    code: res.body?.code ?? 'ERROR',
    detail: res.body?.detail ?? `Failed with HTTP ${res.status}`,
  };
}

export function bulkResponse(results: BulkItemResult[]): { status: 200 | 207; body: BulkResponse } {
  const failed = results.filter((r) => r.status >= 400).length;
  return {
    status: failed ? 207 : 200,
    body: { object: 'bulk_results', summary: { total: results.length, succeeded: results.length - failed, failed }, results },
  };
}

/** Each lifecycle action applies to the case's latest version: approve a DRAFT, deprecate an APPROVED one, restore a DEPRECATED one. */
const TRANSITIONS = { approve: { path: 'approve' }, deprecate: { path: 'deprecate' }, restore: { path: 'restore' } } as const;

interface CaseBulkBody {
  action: 'update' | 'approve' | 'deprecate' | 'restore';
  case_ids: string[];
  changes?: { priority?: string; execution_type?: string; test_suite_id?: string; custom_fields?: Record<string, unknown> };
}

interface PlanBulkBody {
  action: 'add' | 'remove';
  case_ids: string[];
  retire_if_has_results?: boolean;
}

export async function registerBulkChangeRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const versionRepo = new TestCaseVersionRepository(db);
  const fieldRepo = new CustomFieldRepository(db);
  const planRepo = new TestPlanRepository(db);

  /** The listed cases of the project, by id: { id → external_id }. */
  async function casesInProject(projectId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await db.selectFrom('test_cases').select(['id', 'external_id']).where('project_id', '=', projectId).where('id', 'in', ids).execute();
    return new Map(rows.map((r) => [r.id, r.external_id]));
  }

  const notInProject = (index: number, ref: string): BulkItemResult => ({
    index,
    test_case_id: ref,
    external_id: null,
    status: 404,
    code: 'NOT_FOUND',
    detail: `Test case '${ref}' not found in this project`,
  });

  /** Runs the case changes through the single-item routes, as the caller. */
  async function changeCases(request: FastifyRequest, via: InternalVia, projectId: string, body: CaseBulkBody, fieldIds: Array<[string, unknown]>) {
    const known = await casesInProject(projectId, body.case_ids);
    const results: BulkItemResult[] = [];
    for (const [index, id] of body.case_ids.entries()) {
      const externalId = known.get(id);
      if (externalId === undefined) {
        results.push(notInProject(index, id));
        continue;
      }
      if (body.action === 'update') {
        const { custom_fields: _cf, ...fields } = body.changes ?? {};
        let res: InnerResponse = { status: 200, body: null };
        if (Object.keys(fields).length) res = await innerRequest(request, via, 'PATCH', `/api/v1/cases/${id}`, fields);
        for (const [definitionId, value] of fieldIds) {
          if (res.status >= 400) break;
          res = await innerRequest(request, via, 'PUT', `/api/v1/cases/${id}/custom-fields/${definitionId}`, { value });
        }
        results.push(itemOutcome(index, id, externalId, res.status < 400 ? { status: 200, body: null } : res));
      } else {
        const transition = TRANSITIONS[body.action];
        const latest = await versionRepo.findLatestVersion(id);
        if (!latest) {
          results.push(itemOutcome(index, id, externalId, { status: 422, body: { code: 'NO_VERSION', detail: 'The case has no version' } }));
          continue;
        }
        const res = await innerRequest(request, via, 'POST', `/api/v1/versions/${latest.id}/${transition.path}`);
        results.push(itemOutcome(index, id, externalId, res, { test_case_version_id: latest.id }));
      }
    }
    return bulkResponse(results);
  }

  /** Adds or removes cases in a plan through the single-item routes, as the caller. */
  async function changePlanCases(request: FastifyRequest, via: InternalVia, planId: string, projectId: string, body: PlanBulkBody) {
    const known = await casesInProject(projectId, body.case_ids);
    const results: BulkItemResult[] = [];
    for (const [index, id] of body.case_ids.entries()) {
      const externalId = known.get(id);
      if (externalId === undefined) {
        results.push(notInProject(index, id));
        continue;
      }
      if (body.action === 'add') {
        const res = await innerRequest(request, via, 'POST', `/api/v1/plans/${planId}/cases`, { test_case_id: id });
        results.push(itemOutcome(index, id, externalId, res, { test_plan_case_id: res.body?.plan_case?.id }));
      } else {
        const res = await innerRequest(request, via, 'DELETE', `/api/v1/plans/${planId}/cases/${id}${body.retire_if_has_results ? '?force=true' : ''}`);
        results.push(itemOutcome(index, id, externalId, res));
      }
    }
    return bulkResponse(results);
  }

  app.post(
    '/api/v1/projects/:projectId/cases/bulk',
    { schema: S.bulkCasesSchema, preHandler: requireAnyPermission(['SPEC_EDIT', 'SPEC_APPROVE'], db, jwtSecret) },
    async (request, reply) => {
      const body = request.body as CaseBulkBody;
      const projectId = request.projectId!;
      if (refuseRepeats(reply, body.case_ids)) return reply;

      const fieldIds: Array<[string, unknown]> = [];
      if (body.action === 'update') {
        const changes = body.changes ?? {};
        const { custom_fields: customFields = {}, ...fields } = changes;
        if (Object.keys(fields).length + Object.keys(customFields).length === 0) {
          return sendError(reply, 400, 'changes needs at least one of priority, execution_type, test_suite_id or custom_fields', {
            invalid_params: [{ name: 'changes', reason: 'is empty' }],
          });
        }
        const needs = [...(Object.keys(fields).length ? ['SPEC_EDIT'] : []), ...(Object.keys(customFields).length ? ['PLAN_MANAGE'] : [])];
        if (!holds(request, reply, needs, 'Changing cases')) return reply;
        // Custom fields may be named by id, name or label; every one must exist before anything changes.
        const definitions = await fieldRepo.listVisibleToProject(projectId, 'TestCase');
        const unknown: string[] = [];
        for (const [key, value] of Object.entries(customFields)) {
          const k = key.toLowerCase();
          const def = definitions.find((d) => d.id === key) ?? definitions.find((d) => d.name.toLowerCase() === k) ?? definitions.find((d) => d.field_label.toLowerCase() === k);
          if (def) fieldIds.push([def.id, value]);
          else unknown.push(key);
        }
        if (unknown.length) {
          return sendError(reply, 400, `Unknown custom field: ${unknown.join(', ')}`, {
            code: 'UNKNOWN_FIELD',
            invalid_params: unknown.map((k) => ({ name: `changes.custom_fields.${k}`, reason: 'is not a custom field for test cases in this project' })),
          });
        }
      } else if (!holds(request, reply, ['SPEC_APPROVE'], `${body.action[0].toUpperCase()}${body.action.slice(1)}`)) {
        return reply;
      }
      const out = await changeCases(request, internalVia(request) ?? 'bulk', projectId, body, fieldIds);
      return reply.status(out.status).send(out.body);
    }
  );

  app.post('/api/v1/plans/:planId/cases/bulk', { schema: S.bulkPlanCasesSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) }, async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const body = request.body as PlanBulkBody;
    if (refuseRepeats(reply, body.case_ids)) return reply;
    const plan = await planRepo.findById(planId);
    if (!plan || plan.project_id !== request.projectId) return sendError(reply, 404, 'Test plan not found');
    if (plan.status === 'LOCKED' || plan.status === 'ARCHIVED') return sendPlanLockedError(reply, planId, request.url);
    const out = await changePlanCases(request, internalVia(request) ?? 'bulk', planId, plan.project_id, body);
    return reply.status(out.status).send(out.body);
  });
}
