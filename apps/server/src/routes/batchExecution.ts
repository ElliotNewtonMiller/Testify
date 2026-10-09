import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { sendPlanLockedError, sendBuildClosedError, sendTokenProjectMismatchError, sendProblemDetails } from '../errors.js';
import { MAX_BATCH_RESULTS, validateBatchItem, type InvalidParam } from '../services/resultValidation.js';
import { resolveCaseLinkability } from './testPlanCases.js';
import { authenticateRequest } from '../middleware/auth.js';
import { autoCloseBuildIfComplete } from '../buildAutoClose.js';
import type {
  BatchExecutionRequest,
  BatchExecutionResponse,
  BatchExecutionSingleResult,
} from '@testify/core';
import { RESULT_OVERWRITE_MESSAGE, canOverwriteResults, isOverwrite, latestResultsInRun } from '../services/resultOverwrite.js';
import { requestOrigin } from '../audit.js';

const INSERT_CHUNK = 500;

/** Thrown inside the transaction to refuse the whole batch in all-or-nothing mode (rolls back). */
class AtomicRejection extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public invalidParams: InvalidParam[]
  ) {
    super(message);
  }
}

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

      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();

      // Every item is checked up front (shape, verdict, status, steps given as numbers or ids);
      // whether its case and steps exist is checked against the plan below.
      if (!Array.isArray(body.executions) || body.executions.length === 0 || body.executions.length > MAX_BATCH_RESULTS) {
        return sendProblemDetails(reply, {
          status: 400,
          title: 'Bad Request',
          code: 'INVALID_RESULT',
          detail: `executions must be a list of 1 to ${MAX_BATCH_RESULTS} results`,
          invalid_params: [{ name: 'executions', reason: `must be a list of 1 to ${MAX_BATCH_RESULTS} results` }],
          instance: req.url,
        });
      }
      const checked = executions.map((raw, i) => validateBatchItem(raw, i));
      if (allOrNothing) {
        const invalid = checked.flatMap((c) => ('invalid' in c ? c.invalid : []));
        if (invalid.length > 0) {
          return sendProblemDetails(reply, {
            status: 400,
            title: 'Bad Request',
            code: 'INVALID_RESULT',
            detail: `Batch execution failed in atomic mode: ${invalid.map((p) => `${p.name} ${p.reason}`).join('; ')}`,
            invalid_params: invalid,
            instance: req.url,
          });
        }
      }

      // CI runner metadata applies to every result in this submission. Only known string
      // fields are kept, so arbitrary payloads can't bloat the column.
      const runnerInfo: Record<string, string> = {};
      for (const key of ['name', 'run_id', 'job_name', 'commit_sha', 'url'] as const) {
        const v = (body.runner_info as Record<string, unknown> | undefined)?.[key];
        if (typeof v === 'string' && v.trim()) runnerInfo[key] = v.trim().slice(0, 500);
      }
      const runnerJson = Object.keys(runnerInfo).length > 0 ? JSON.stringify(runnerInfo) : null;
      const defaultEnvironment = typeof body.environment === 'string' && body.environment.trim() ? body.environment.trim().slice(0, 500) : null;

      // Everything below -- cases auto-linked to the plan, the results, their step results and
      // the audit row -- is written in one transaction. In all-or-nothing mode a refused item
      // throws AtomicRejection, which rolls all of it back (auto-links included). Otherwise
      // the accepted items are saved together and the refused ones are reported per item.
      let outcome: { results: BatchExecutionSingleResult[]; successCount: number; failedCount: number };
      try {
        outcome = await db.transaction().execute(async (trx) => {
          const existingPlanCases = await trx
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
          type PlanCase = (typeof existingPlanCases)[number];

          // Cases deliberately removed from this plan (after they had results). Results for
          // them are refused -- CI auto-linking must not quietly put them back.
          const removedCaseIds = new Set(
            (
              await trx
                .selectFrom('test_plan_cases')
                .select('test_case_id')
                .where('test_plan_id', '=', planId)
                .where('removed_at', 'is not', null)
                .execute()
            ).map((r) => r.test_case_id)
          );

          // EXECUTE_OVERWRITE (services/resultOverwrite.ts): a case that already had a result
          // in this run before this request can only get a different one with the permission.
          // Several results for one case within this request are retries, not overwrites.
          const mayOverwrite = canOverwriteResults(user.permissions);
          const priorResults = mayOverwrite ? new Map() : await latestResultsInRun(trx, buildId);
          const casesInThisRequest = new Set<string>();

          const planCasesByExternalId = new Map<string, PlanCase>();
          const planCasesByUuid = new Map<string, PlanCase>();
          const planCasesByPathTitle = new Map<string, PlanCase>();
          const remember = (tpc: PlanCase) => {
            if (tpc.external_id) planCasesByExternalId.set(tpc.external_id.toLowerCase(), tpc);
            planCasesByUuid.set(tpc.plan_case_id, tpc);
            planCasesByUuid.set(tpc.test_case_id, tpc);
            planCasesByPathTitle.set(`${tpc.suite_name.toLowerCase()} / ${tpc.title.toLowerCase()}`, tpc);
          };
          existingPlanCases.forEach(remember);

          const stepsByVersion = new Map<string, Array<{ id: string; step_number: number }>>();
          const getStepsForVersion = async (versionId: string) => {
            if (!stepsByVersion.has(versionId)) {
              stepsByVersion.set(
                versionId,
                await trx.selectFrom('test_steps').select(['id', 'step_number']).where('test_case_version_id', '=', versionId).execute()
              );
            }
            return stepsByVersion.get(versionId)!;
          };

          const results: BatchExecutionSingleResult[] = [];
          const executionRows: any[] = [];
          const stepRows: any[] = [];
          let successCount = 0;
          let failedCount = 0;

          /** Refuses item i: the whole batch in all-or-nothing mode, otherwise just this item. */
          const refuse = (i: number, status: number, code: string, reason: string, invalid_params: InvalidParam[]) => {
            if (allOrNothing) {
              throw new AtomicRejection(status, code, `Batch execution failed in atomic mode: item at index ${i}: ${reason}`, invalid_params);
            }
            failedCount++;
            results.push({ index: i, status, code, error: reason, invalid_params });
          };

          for (let i = 0; i < executions.length; i++) {
            const check = checked[i];
            if ('invalid' in check) {
              refuse(i, 400, 'INVALID_RESULT', check.invalid.map((p) => `${p.name} ${p.reason}`).join('; '), check.invalid);
              continue;
            }
            const item = check.item;
            const cid = item.case_identifier;

            let resolvedPlanCase: PlanCase | undefined;
            if (cid.external_id) resolvedPlanCase = planCasesByExternalId.get(cid.external_id.toLowerCase());
            if (!resolvedPlanCase && cid.by_uuid) resolvedPlanCase = planCasesByUuid.get(cid.by_uuid);
            if (!resolvedPlanCase && cid.by_path_title?.title) {
              const title = cid.by_path_title.title.toLowerCase();
              resolvedPlanCase =
                planCasesByPathTitle.get(`${(cid.by_path_title.suite_path || '').toLowerCase()} / ${title}`) ??
                existingPlanCases.find((c) => c.title.toLowerCase() === title);
            }

            // Not in the plan yet: a case of this project may be linked to it -- but only once
            // the whole item has checked out, so a refused item never leaves a link behind.
            let pendingLink: PlanCase | null = null;
            let removedFromPlan: string | null = null;
            if (!resolvedPlanCase) {
              const candidate = await trx
                .selectFrom('test_cases')
                .select(['id', 'external_id', 'title', 'test_suite_id'])
                .where('project_id', '=', projectId)
                .where((eb) => {
                  const conds = [];
                  if (cid.external_id) conds.push(eb('external_id', '=', cid.external_id));
                  if (cid.by_uuid) conds.push(eb('id', '=', cid.by_uuid));
                  if (cid.by_path_title?.title) conds.push(eb('title', '=', cid.by_path_title.title));
                  return eb.or(conds);
                })
                .executeTakeFirst();

              if (candidate && removedCaseIds.has(candidate.id)) {
                removedFromPlan = candidate.external_id;
              } else if (candidate) {
                // Same Approved-only-unless-allow_draft_plan_linking rule the Specification-mode
                // toggle enforces (routes/testPlanCases.ts).
                const { linkable, latestVersion } = await resolveCaseLinkability(trx, projectId, candidate.id);
                if (latestVersion && linkable) {
                  const suiteRow = await trx
                    .selectFrom('test_suites')
                    .select(['name', 'path'])
                    .where('id', '=', candidate.test_suite_id)
                    .executeTakeFirst();
                  pendingLink = {
                    plan_case_id: uuidv4(),
                    test_case_id: candidate.id,
                    test_case_version_id: latestVersion.id,
                    external_id: candidate.external_id,
                    title: candidate.title,
                    suite_name: suiteRow?.name || 'Suite',
                    suite_path: suiteRow?.path || '/suite',
                  };
                  resolvedPlanCase = pendingLink;
                }
              }
            }

            if (!resolvedPlanCase) {
              const reason = removedFromPlan
                ? `${removedFromPlan} was removed from this test plan; no new results can be recorded for it`
                : 'Case identifier not found in test plan';
              refuse(i, 422, removedFromPlan ? 'CASE_REMOVED_FROM_PLAN' : 'CASE_NOT_FOUND', reason, [
                { name: `executions[${i}].case_identifier`, reason },
              ]);
              continue;
            }

            if (
              !mayOverwrite &&
              !casesInThisRequest.has(resolvedPlanCase.test_case_id) &&
              isOverwrite(priorResults.get(resolvedPlanCase.test_case_id), user.id, item.verdict)
            ) {
              refuse(i, 403, 'RESULT_OVERWRITE_NOT_PERMITTED', RESULT_OVERWRITE_MESSAGE, [
                { name: `executions[${i}].case_identifier`, reason: RESULT_OVERWRITE_MESSAGE },
              ]);
              continue;
            }

            // Step results must name steps of the version this case runs at in the plan, by id
            // or number. (An unknown step used to be recorded against step 1.)
            const versionSteps = await getStepsForVersion(resolvedPlanCase.test_case_version_id);
            const resolvedSteps: Array<{ id: string; step_number: number }> = [];
            const stepProblems: InvalidParam[] = [];
            item.step_results.forEach((sr, j) => {
              const name = `executions[${i}].step_results[${j}]`;
              const step = sr.test_step_id
                ? versionSteps.find((st) => st.id === sr.test_step_id)
                : versionSteps.find((st) => st.step_number === sr.step_number);
              if (!step) {
                stepProblems.push({
                  name,
                  reason: sr.test_step_id ? "test_step_id isn't a step of this test case" : `this test case has no step ${sr.step_number}`,
                });
              } else if (sr.test_step_id && sr.step_number !== undefined && sr.step_number !== step.step_number) {
                stepProblems.push({ name: `${name}.step_number`, reason: `is ${step.step_number} for this step` });
              } else if (resolvedSteps.some((r) => r.id === step.id)) {
                stepProblems.push({ name, reason: 'repeats a step already given' });
              } else {
                resolvedSteps.push(step);
              }
            });
            if (stepProblems.length > 0) {
              refuse(i, 422, 'UNKNOWN_STEP', stepProblems.map((p) => `${p.name}: ${p.reason}`).join('; '), stepProblems);
              continue;
            }

            if (pendingLink) {
              await trx
                .insertInto('test_plan_cases')
                .values({
                  id: pendingLink.plan_case_id,
                  test_plan_id: planId,
                  test_case_id: pendingLink.test_case_id,
                  test_case_version_id: pendingLink.test_case_version_id,
                  assigned_user_id: null,
                  position: existingPlanCases.length + 1,
                  custom_fields_snapshot: '{}',
                  created_at: now,
                  updated_at: now,
                })
                .execute();
              existingPlanCases.push(pendingLink);
              remember(pendingLink);
            }
            casesInThisRequest.add(resolvedPlanCase.test_case_id);

            const execId = uuidv4();
            // Each later item is recorded a millisecond later, so results with the same
            // execution time (e.g. a failure and its retry, neither sending executed_at) have
            // a definite order: reports and the overwrite check take the newest as the verdict.
            const itemCreatedAt = new Date(nowMs + i).toISOString();
            const envTags = item.environment_tags ?? (defaultEnvironment ? { environment: defaultEnvironment } : null);
            executionRows.push({
              id: execId,
              build_id: buildId,
              test_plan_case_id: resolvedPlanCase.plan_case_id,
              tester_id: user.id,
              status: item.status,
              verdict: item.verdict,
              // null (not a fabricated 0) when the caller doesn't report a real duration.
              execution_duration_ms: item.duration_ms,
              notes: item.notes,
              failure_message: item.failure_message,
              stack_trace: item.stack_trace,
              environment: envTags ? JSON.stringify(envTags) : null,
              runner: runnerJson,
              source: 'API',
              execution_timestamp: item.executed_at ?? now,
              created_at: itemCreatedAt,
              updated_at: itemCreatedAt,
            });
            item.step_results.forEach((sr, j) => {
              stepRows.push({
                id: uuidv4(),
                execution_id: execId,
                test_step_id: resolvedSteps[j].id,
                step_number: resolvedSteps[j].step_number,
                verdict: sr.verdict,
                actual_result: sr.actual_result,
                created_at: itemCreatedAt,
              });
            });

            successCount++;
            results.push({
              index: i,
              status: 201,
              execution_id: execId,
              case_id: resolvedPlanCase.test_case_id,
              verdict: item.verdict,
            });
          }

          // Multi-row inserts, in chunks that stay well under Postgres's parameter limit.
          for (let k = 0; k < executionRows.length; k += INSERT_CHUNK) {
            await trx.insertInto('executions').values(executionRows.slice(k, k + INSERT_CHUNK)).execute();
          }
          for (let k = 0; k < stepRows.length; k += INSERT_CHUNK) {
            await trx.insertInto('execution_steps').values(stepRows.slice(k, k + INSERT_CHUNK)).execute();
          }

          // One summary row per batch call, not per execution item, to avoid flooding
          // audit_logs on a large batch.
          await trx
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
              ...requestOrigin(req),
              created_at: now,
            })
            .execute();

          return { results, successCount, failedCount };
        });
      } catch (err) {
        if (!(err instanceof AtomicRejection)) throw err;
        return sendProblemDetails(reply, {
          status: err.status,
          title: err.status === 400 ? 'Bad Request' : err.status === 403 ? 'Forbidden' : 'Unprocessable Entity',
          code: err.code,
          detail: err.message,
          invalid_params: err.invalidParams,
          instance: req.url,
        });
      }
      const { results, successCount, failedCount } = outcome;

      const responsePayload: BatchExecutionResponse = {
        object: 'batch_execution_result',
        summary: {
          total_submitted: executions.length,
          successful: successCount,
          failed: failedCount,
          duration_ms: Date.now() - startTime,
        },
        results,
      };

      // Auto-close the run once every case in its plan has a result (after the commit).
      responsePayload.build_status = await autoCloseBuildIfComplete(db, buildId, {
        id: user.id,
        type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
      }, requestOrigin(req));

      const httpStatus = failedCount > 0 && !allOrNothing ? 207 : 201;
      return reply.status(httpStatus).send(responsePayload);
    }
  );
}
