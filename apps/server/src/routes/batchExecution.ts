import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { sendPlanLockedError, sendBuildClosedError } from '../errors.js';
import { resolveCaseLinkability } from './testPlanCases.js';
import type {
  BatchExecutionRequest,
  BatchExecutionResponse,
  BatchExecutionSingleResult,
} from '@testify/core';

export async function registerBatchExecutionRoutes(app: FastifyInstance, db: Kysely<Database>) {
  app.post(
    '/api/v1/test-plans/:planId/builds/:buildId/executions/batch',
    async (
      req: FastifyRequest<{
        Params: { planId: string; buildId: string };
        Querystring: { all_or_nothing?: string | boolean };
        Body: BatchExecutionRequest;
      }>,
      reply: FastifyReply
    ) => {
      const startTime = Date.now();
      const { planId, buildId } = req.params;
      const allOrNothing =
        req.query.all_or_nothing === true ||
        req.query.all_or_nothing === 'true' ||
        req.query.all_or_nothing === '1';

      const body = req.body || { executions: [] };
      const executions = body.executions || [];

      // 1. Verify build and test plan lock state
      const buildPlanInfo = await db
        .selectFrom('builds')
        .innerJoin('test_plans', 'test_plans.id', 'builds.test_plan_id')
        .select([
          'builds.id as build_id',
          'builds.status as build_status',
          'test_plans.id as plan_id',
          'test_plans.status as plan_status',
          'test_plans.project_id',
        ])
        .where('builds.id', '=', buildId)
        .where('builds.test_plan_id', '=', planId)
        .executeTakeFirst();

      if (!buildPlanInfo) {
        return reply.status(404).send({ error: `Build ID ${buildId} not found under Test Plan ${planId}` });
      }

      if (buildPlanInfo.plan_status === 'LOCKED' || buildPlanInfo.plan_status === 'ARCHIVED') {
        return sendPlanLockedError(reply, planId, req.url);
      }

      if (buildPlanInfo.build_status === 'CLOSED') {
        return sendBuildClosedError(reply, buildId, req.url);
      }

      const projectId = buildPlanInfo.project_id;
      const now = new Date().toISOString();

      // 2. Pre-fetched key resolution cache
      const existingPlanCases = await db
        .selectFrom('test_plan_cases as tpc')
        .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
        .innerJoin('test_suites as ts', 'ts.id', 'tc.test_suite_id')
        .select([
          'tpc.id as plan_case_id',
          'tpc.test_case_id',
          'tpc.test_case_version_id',
          'tc.external_id',
          'tc.title',
          'ts.name as suite_name',
          'ts.path as suite_path',
        ])
        .where('tpc.test_plan_id', '=', planId)
        .execute();

      const planCasesByExternalId = new Map<string, typeof existingPlanCases[0]>();
      const planCasesByUuid = new Map<string, typeof existingPlanCases[0]>();
      const planCasesByPathTitle = new Map<string, typeof existingPlanCases[0]>();

      for (const tpc of existingPlanCases) {
        if (tpc.external_id) planCasesByExternalId.set(tpc.external_id.toLowerCase(), tpc);
        planCasesByUuid.set(tpc.plan_case_id, tpc);
        planCasesByUuid.set(tpc.test_case_id, tpc);

        const pathTitleKey = `${tpc.suite_name.toLowerCase()} / ${tpc.title.toLowerCase()}`;
        planCasesByPathTitle.set(pathTitleKey, tpc);
      }

      // Pre-fetch steps for version resolution
      const stepLookupMap = new Map<string, Array<{ id: string; step_number: number }>>();

      async function getStepsForVersion(versionId: string) {
        if (stepLookupMap.has(versionId)) return stepLookupMap.get(versionId)!;
        const steps = await db
          .selectFrom('test_steps')
          .select(['id', 'step_number'])
          .where('test_case_version_id', '=', versionId)
          .execute();
        stepLookupMap.set(versionId, steps);
        return steps;
      }

      // 3. Process execution items
      const results: BatchExecutionSingleResult[] = [];
      const executionsToInsert: any[] = [];
      const stepResultsToInsert: any[] = [];

      let successCount = 0;
      let failedCount = 0;

      for (let i = 0; i < executions.length; i++) {
        const item = executions[i];
        const cid = item.case_identifier || {};

        let resolvedPlanCase: typeof existingPlanCases[0] | undefined;

        if (cid.external_id) {
          resolvedPlanCase = planCasesByExternalId.get(cid.external_id.toLowerCase());
        }
        if (!resolvedPlanCase && cid.by_uuid) {
          resolvedPlanCase = planCasesByUuid.get(cid.by_uuid);
        }
        if (!resolvedPlanCase && cid.by_path_title) {
          const ptKey = `${cid.by_path_title.suite_path.toLowerCase()} / ${cid.by_path_title.title.toLowerCase()}`;
          resolvedPlanCase = planCasesByPathTitle.get(ptKey);
          if (!resolvedPlanCase) {
            // Also try title matching
            resolvedPlanCase = existingPlanCases.find(
              (c) => c.title.toLowerCase() === cid.by_path_title!.title.toLowerCase()
            );
          }
        }

        // If not found in test_plan_cases, check if test_cases exists in project to auto-link
        if (!resolvedPlanCase) {
          let tcCandidate = await db
            .selectFrom('test_cases')
            .selectAll()
            .where('project_id', '=', projectId)
            .where((eb) => {
              const conds = [];
              if (cid.external_id) conds.push(eb('external_id', '=', cid.external_id));
              if (cid.by_uuid) conds.push(eb('id', '=', cid.by_uuid));
              if (cid.by_path_title?.title) conds.push(eb('title', '=', cid.by_path_title.title));
              return eb.or(conds);
            })
            .executeTakeFirst();

          if (tcCandidate) {
            // Same Approved-only-unless-allow_draft_plan_linking rule the explicit
            // Specification-mode toggle UI enforces (see routes/testPlanCases.ts) -- a case
            // that can't be linked via the UI shouldn't be silently auto-linkable via batch
            // execution ingestion either. If it's not linkable, resolvedPlanCase stays
            // undefined and this item falls through to the existing "case not found" failure
            // path below, same as any other unresolvable case identifier.
            const { linkable, latestVersion: latestVer } = await resolveCaseLinkability(
              db,
              projectId,
              tcCandidate.id
            );

            if (latestVer && linkable) {
              const newPlanCaseId = uuidv4();
              await db
                .insertInto('test_plan_cases')
                .values({
                  id: newPlanCaseId,
                  test_plan_id: planId,
                  test_case_id: tcCandidate.id,
                  test_case_version_id: latestVer.id,
                  assigned_user_id: null,
                  position: existingPlanCases.length + 1,
                  custom_fields_snapshot: '{}',
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              const suiteRow = await db
                .selectFrom('test_suites')
                .select(['name', 'path'])
                .where('id', '=', tcCandidate.test_suite_id)
                .executeTakeFirst();

              resolvedPlanCase = {
                plan_case_id: newPlanCaseId,
                test_case_id: tcCandidate.id,
                test_case_version_id: latestVer.id,
                external_id: tcCandidate.external_id,
                title: tcCandidate.title,
                suite_name: suiteRow?.name || 'Suite',
                suite_path: suiteRow?.path || '/suite',
              };

              existingPlanCases.push(resolvedPlanCase);
              if (tcCandidate.external_id) planCasesByExternalId.set(tcCandidate.external_id.toLowerCase(), resolvedPlanCase);
              planCasesByUuid.set(newPlanCaseId, resolvedPlanCase);
              planCasesByUuid.set(tcCandidate.id, resolvedPlanCase);
            }
          }
        }

        if (!resolvedPlanCase) {
          failedCount++;
          if (allOrNothing) {
            return reply.status(422).send({
              type: 'https://api.testify.dev/errors/VALIDATION_FAILED',
              title: 'Unprocessable Entity',
              status: 422,
              code: 'VALIDATION_FAILED',
              detail: `Batch execution failed in atomic mode: item at index ${i} could not resolve case identifier.`,
              invalid_params: [
                {
                  name: `executions[${i}].case_identifier`,
                  reason: 'Case identifier not found in test plan',
                },
              ],
            });
          } else {
            results.push({
              index: i,
              status: 422,
              error: 'Case identifier could not be resolved',
            });
            continue;
          }
        }

        const execId = uuidv4();
        const execTimestamp = item.executed_at || now;
        const envTags = item.environment_tags || (body.environment ? { environment: body.environment } : {});

        executionsToInsert.push({
          id: execId,
          build_id: buildId,
          test_plan_case_id: resolvedPlanCase.plan_case_id,
          tester_id: body.runner_info?.name || 'usr_ci_runner',
          status: item.status || 'COMPLETED',
          verdict: item.verdict,
          execution_duration_ms: item.duration_ms || 0,
          notes: item.notes || null,
          custom_fields_snapshot: JSON.stringify(envTags),
          execution_timestamp: execTimestamp,
          created_at: now,
          updated_at: now,
        });

        // Step results
        if (item.step_results && item.step_results.length > 0) {
          const tcSteps = await getStepsForVersion(resolvedPlanCase.test_case_version_id);
          for (const sRes of item.step_results) {
            let stepId = sRes.test_step_id;
            if (!stepId && sRes.step_number) {
              const matchedStep = tcSteps.find((st) => st.step_number === sRes.step_number);
              if (matchedStep) stepId = matchedStep.id;
            }
            if (!stepId && tcSteps.length > 0) {
              stepId = tcSteps[0].id;
            }

            if (stepId) {
              stepResultsToInsert.push({
                id: uuidv4(),
                execution_id: execId,
                test_step_id: stepId,
                step_number: sRes.step_number || 1,
                verdict: sRes.verdict,
                actual_result: sRes.actual_result || null,
                created_at: now,
              });
            }
          }
        }

        successCount++;
        results.push({
          index: i,
          status: 201,
          execution_id: execId,
          case_id: resolvedPlanCase.test_case_id,
          verdict: item.verdict,
        });
      }

      // Perform bulk database inserts
      if (executionsToInsert.length > 0) {
        for (const execRow of executionsToInsert) {
          await db.insertInto('executions').values(execRow).execute();
        }
      }

      if (stepResultsToInsert.length > 0) {
        for (const stepRow of stepResultsToInsert) {
          await db.insertInto('execution_steps').values(stepRow).execute();
        }
      }

      const durationMs = Date.now() - startTime;
      const responsePayload: BatchExecutionResponse = {
        object: 'batch_execution_result',
        summary: {
          total_submitted: executions.length,
          successful: successCount,
          failed: failedCount,
          duration_ms: durationMs,
        },
        results,
      };

      const httpStatus = failedCount > 0 && !allOrNothing ? 207 : 201;
      return reply.status(httpStatus).send(responsePayload);
    }
  );
}
