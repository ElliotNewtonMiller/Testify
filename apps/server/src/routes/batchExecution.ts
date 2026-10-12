import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import type { BatchResultsRequest } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import { sendError } from '../errors.js';
import { BatchRecorded, recordResultsBatch } from '../services/batchResults.js';
import { findOrCreateRun } from '../services/runByName.js';
import { batchResultsSchema, planBatchResultsSchema } from '../openapi/areas/projects.js';

const flag = (query: unknown, name: string) => {
  const v = (query as Record<string, unknown> | undefined)?.[name];
  return v === true || v === 'true' || v === '1';
};

/**
 * The batch options from the query: `all_or_nothing` (one refused result saves nothing) and
 * `close_run` (close the run afterwards; needs RUN_MANAGE). Null after answering 403.
 */
export function batchOptions(req: FastifyRequest, reply: FastifyReply): { allOrNothing: boolean; closeRun: boolean } | null {
  const closeRun = flag(req.query, 'close_run');
  if (closeRun && !req.user!.permissions.includes('RUN_MANAGE') && !req.user!.permissions.includes('SYSTEM_ADMIN')) {
    sendError(reply, 403, 'close_run needs RUN_MANAGE: leave it out to record the results and keep the run open', { required_permission: 'RUN_MANAGE' });
    return null;
  }
  return { allOrNothing: flag(req.query, 'all_or_nothing'), closeRun };
}

/**
 * CI results as JSON (RFC 03 §3): POST /api/v1/runs/:runId/results/batch into a run, or
 * POST /api/v1/plans/:planId/results/batch?run_name= into the plan's run with that name (created
 * if needed). JUnit XML uploads are in routes/junitResults.ts; both record through
 * services/batchResults.ts.
 */
export async function registerBatchExecutionRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const executeRun = requirePermission('EXECUTE_RUN', db, jwtSecret);

  app.post('/api/v1/runs/:runId/results/batch', { schema: batchResultsSchema, preHandler: executeRun }, async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const options = batchOptions(req, reply);
    if (!options) return reply;
    const outcome = await recordResultsBatch(db, req, reply, req.user!, runId, req.body as BatchResultsRequest, options);
    if (!(outcome instanceof BatchRecorded)) return outcome;
    return reply.status(outcome.httpStatus).send(outcome.payload);
  });

  app.post('/api/v1/plans/:planId/results/batch', { schema: planBatchResultsSchema, preHandler: executeRun }, async (req, reply) => {
    const { planId } = req.params as { planId: string };
    const body = req.body as BatchResultsRequest | undefined;
    // A malformed request mustn't leave an empty run behind.
    if (!Array.isArray(body?.results) || body!.results.length === 0) {
      return sendError(reply, 400, 'results must be a list of at least one result', {
        code: 'INVALID_RESULT',
        invalid_params: [{ name: 'results', reason: 'must be a list of at least one result' }],
      });
    }
    const options = batchOptions(req, reply);
    if (!options) return reply;
    const run = await findOrCreateRun(db, req, reply, req.user!, planId, (req.query as { run_name?: unknown }).run_name);
    if (!run) return reply;
    const outcome = await recordResultsBatch(db, req, reply, req.user!, run.id, body, options);
    if (!(outcome instanceof BatchRecorded)) return outcome;
    return reply.status(outcome.httpStatus).send({ ...outcome.payload, run });
  });
}
