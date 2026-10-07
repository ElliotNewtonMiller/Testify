import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { sendPlanLockedError, sendBuildClosedError, sendTokenProjectMismatchError } from '../errors.js';
import { resolveCaseLinkability } from './testPlanCases.js';
import { authenticateRequest } from '../middleware/auth.js';
import { autoCloseBuildIfComplete } from '../buildAutoClose.js';
import type {
  BatchExecutionRequest,
  BatchExecutionResponse,
  BatchExecutionSingleResult,
} from '@testify/core';

export async function registerBatchExecutionRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
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
      const user = await authenticateRequest(req, reply, db, jwtSecret);
      if (!user) return;
      if (!user.permissions.includes('EXECUTE_RUN') && !user.permissions.includes('SYSTEM_ADMIN')) {
        return reply.status(403).send({ error: 'Forbidden: Insufficient privileges', requiredPermission: 'EXECUTE_RUN' });
      }

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

      if (user.api_token && user.api_token.project_id !== projectId) {
        return sendTokenProjectMismatchError(reply, user.api_token.project_id, projectId, req.url);
      }

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
        .where('tpc.removed_at', 'is', null)
        .execute();

      // Cases deliberately removed from this plan (after they had results). Results for them
      // are refused -- CI auto-linking must not quietly put them back.
      const removedCaseIds = new Set(
        (
          await db
            .selectFrom('test_plan_cases')
            .select('test_case_id')
            .where('test_plan_id', '=', planId)
            .where('removed_at', 'is not', null)
            .execute()
        ).map((r) => r.test_case_id)
      );

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

      // CI runner metadata applies to every result in this submission. Only known string
      // fields are kept, so arbitrary payloads can't bloat the column.
      const runnerInfo: Record<string, string> = {};
      for (const key of ['name', 'run_id', 'job_name', 'commit_sha', 'url'] as const) {
        const v = (body.runner_info as Record<string, unknown> | undefined)?.[key];
        if (typeof v === 'string' && v.trim()) runnerInfo[key] = v.trim().slice(0, 500);
      }
      const runnerJson = Object.keys(runnerInfo).length > 0 ? JSON.stringify(runnerInfo) : null;

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
        let removedFromPlan: string | null = null;
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

          if (tcCandidate && removedCaseIds.has(tcCandidate.id)) {
            removedFromPlan = tcCandidate.external_id;
          } else if (tcCandidate) {
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
          const reason = removedFromPlan
            ? `${removedFromPlan} was removed from this test plan; no new results can be recorded for it`
            : 'Case identifier not found in test plan';
          if (allOrNothing) {
            return reply.status(422).send({
              type: `https://api.testify.dev/errors/${removedFromPlan ? 'CASE_REMOVED_FROM_PLAN' : 'VALIDATION_FAILED'}`,
              title: 'Unprocessable Entity',
              status: 422,
              code: removedFromPlan ? 'CASE_REMOVED_FROM_PLAN' : 'VALIDATION_FAILED',
              detail: `Batch execution failed in atomic mode: item at index ${i}: ${reason}.`,
              invalid_params: [
                {
                  name: `executions[${i}].case_identifier`,
                  reason,
                },
              ],
            });
          } else {
            results.push({
              index: i,
              status: 422,
              error: removedFromPlan ? reason : 'Case identifier could not be resolved',
            });
            continue;
          }
        }

        const execId = uuidv4();
        const execTimestamp = item.executed_at || now;
        const envTags = item.environment_tags || (body.environment ? { environment: body.environment } : null);

        executionsToInsert.push({
          id: execId,
          build_id: buildId,
          test_plan_case_id: resolvedPlanCase.plan_case_id,
          tester_id: user.id,
          status: item.status || 'COMPLETED',
          verdict: item.verdict,
          // null (not a fabricated 0) when the CI caller doesn't report a real duration --
          // see server.ts's single-execution route for the matching fix and rationale.
          execution_duration_ms: item.duration_ms ?? null,
          notes: item.notes || null,
          failure_message: item.failure_message || null,
          stack_trace: item.stack_trace || null,
          environment: envTags && Object.keys(envTags).length > 0 ? JSON.stringify(envTags) : null,
          runner: runnerJson,
          source: 'API',
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

      // One summary row per batch call, not per execution item, to avoid flooding
      // audit_logs on a large batch.
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: user.id,
          actor_type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
          action: 'BATCH_EXECUTION_RECORDED',
          resource_type: 'build',
          resource_id: buildId,
          project_id: projectId,
          diff: JSON.stringify({ successful: successCount, failed: failedCount, plan_id: planId }),
          ip_address: '127.0.0.1',
          user_agent: 'TestifyBatchExecutionService',
          created_at: now,
        })
        .execute();

      // Auto-close the run once every case in its plan has a result.
      responsePayload.build_status = await autoCloseBuildIfComplete(db, buildId, {
        id: user.id,
        type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
      });

      const httpStatus = failedCount > 0 && !allOrNothing ? 207 : 201;
      return reply.status(httpStatus).send(responsePayload);
    }
  );
}
