import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { sendCaseRemovedFromPlanError, sendProblemDetails, sendError, sendRunClosedError } from '../errors.js';
import { validateManualResult } from '../services/resultValidation.js';
import { RESULT_OVERWRITE_MESSAGE, canOverwriteResults, isOverwrite, latestResultsInRun } from '../services/resultOverwrite.js';
import { requirePermission } from '../middleware/auth.js';
import { autoCloseRunIfComplete } from '../runAutoClose.js';
import { requestOrigin } from '../audit.js';
import { recordResultSchema } from '../openapi/areas/projects.js';

/**
 * POST /api/v1/runs/:runId/results -- records one result for a case in a run (what Execute
 * mode's verdict buttons and hotkeys call). Needs EXECUTE_RUN; recording over an existing result
 * needs EXECUTE_OVERWRITE too. CI sends many at once to POST /api/v1/runs/:runId/results/batch
 * (routes/batchExecution.ts).
 */
export async function registerResultRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  app.post('/api/v1/runs/:runId/results', { schema: recordResultSchema, preHandler: requirePermission('EXECUTE_RUN', db, jwtSecret) }, async (request, reply) => {
    const actorId = request.user!.id;
    const { runId } = request.params as { runId: string };
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

    // 1. Verify run and plan lock state
    const run = await db
      .selectFrom('test_runs')
      .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
      .select(['test_runs.status as run_status', 'test_runs.test_plan_id', 'test_plans.status as plan_status', 'test_plans.project_id'])
      .where('test_runs.id', '=', runId)
      .executeTakeFirst();

    if (!run) {
      return sendError(reply, 404, 'Run not found');
    }

    // The case must be in this run's plan -- and not removed from it (a removed case keeps the
    // results it already has, read-only).
    const planCase = await db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select(['tpc.test_plan_id', 'tpc.removed_at', 'tpc.test_case_version_id', 'tpc.test_case_id', 'tc.external_id'])
      .where('tpc.id', '=', body.test_plan_case_id)
      .executeTakeFirst();
    if (!planCase || planCase.test_plan_id !== run.test_plan_id) {
      return sendError(reply, 404, 'Test case not found in this run\'s plan');
    }
    if (planCase.removed_at) {
      return sendCaseRemovedFromPlanError(reply, planCase.external_id, request.url);
    }

    if (run.run_status === 'CLOSED') {
      return sendRunClosedError(reply, runId, request.url);
    }

    if (run.plan_status === 'LOCKED' || run.plan_status === 'ARCHIVED') {
      return sendError(reply, 422, 'Test plan is locked. Executions are frozen.', { code: 'PLAN_LOCKED' });
    }

    // Changing a case's existing result in this run needs EXECUTE_OVERWRITE (adding notes to
    // your own result with the same verdict doesn't) -- see services/resultOverwrite.ts.
    if (!canOverwriteResults(request.user!.permissions)) {
      const existing = (await latestResultsInRun(db, runId, [planCase.test_case_id])).get(planCase.test_case_id);
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
        .insertInto('test_results')
        .values({
          id: execId,
          test_run_id: runId,
          test_plan_case_id: body.test_plan_case_id,
          tester_id: actorId,
          status: body.status,
          verdict: body.verdict,
          // Manual execution isn't timed: this is the single-result route the UI uses, so it
          // never stores a duration, even if one is sent. Durations come only from automated
          // results via the batch route (routes/batchExecution.ts), which is all Reports'
          // "Slowest" table ranks.
          duration_ms: null,
          notes: body.notes,
          source: 'UI',
          executed_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (body.step_results.length > 0) {
        await trx
          .insertInto('test_step_results')
          .values(
            body.step_results.map((sr) => ({
              id: uuidv4(),
              test_result_id: execId,
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
          action: 'RESULT_RECORDED',
          resource_type: 'result',
          resource_id: execId,
          // The run's real project (this used to be hardwired to the sample project's id).
          project_id: run.project_id,
          diff: JSON.stringify({ verdict: body.verdict, test_plan_case_id: body.test_plan_case_id }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();
    });

    // 5. Auto-close the run once every case in its plan has a result.
    const runStatus = await autoCloseRunIfComplete(db, runId, {
      id: actorId,
      type: request.user!.api_token ? 'SERVICE_ACCOUNT' : 'USER',
    }, requestOrigin(request));

    return reply.status(201).send({
      result: { id: execId, test_run_id: runId, test_plan_case_id: body.test_plan_case_id, verdict: body.verdict, status: body.status, created_at: now },
      run_status: runStatus,
    });
  });
}
