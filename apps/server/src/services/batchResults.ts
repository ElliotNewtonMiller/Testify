import type { FastifyReply, FastifyRequest } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import type { BatchResultsRequest, BatchResultsResponse, BatchResultOutcome } from '@testify/core';
import { sendPlanLockedError, sendRunClosedError, sendTokenProjectMismatchError, sendProblemDetails, sendError } from '../errors.js';
import { MAX_BATCH_RESULTS, validateBatchItem, type InvalidParam, type BatchItemShape } from './resultValidation.js';
import { resolveCaseLinkability } from '../routes/testPlanCases.js';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { RESULT_OVERWRITE_MESSAGE, canOverwriteResults, isOverwrite, latestResultsInRun } from './resultOverwrite.js';
import { requestOrigin } from '../audit.js';
import { emitResultsRecorded, emitRunClosed, webhookActor } from './webhookEvents.js';

/**
 * Recording many results in a run at once: the CI batch (routes/batchExecution.ts, JSON) and JUnit
 * uploads (routes/junitResults.ts) both come here. RFC 03 §3.
 */

const INSERT_CHUNK = 500;
const LOOKUP_CHUNK = 1000;

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

/** What a batch saved: the caller sends it (201, or 207 when some results were refused). */
export class BatchRecorded {
  constructor(
    public httpStatus: 201 | 207,
    public payload: BatchResultsResponse
  ) {}
}

type CaseIdentifier = BatchItemShape['case_identifier'];
type ProjectCase = { id: string; external_id: string; title: string; test_suite_id: string; suite_name: string };

/**
 * Looks up, in a few queries, the project's cases that any item could mean, and returns a finder:
 * by readable id, then by case id, then by title (preferring the case whose suite has the named
 * suite name).
 */
async function projectCaseFinder(db: Kysely<Database>, projectId: string, identifiers: CaseIdentifier[]) {
  const externalIds = [...new Set(identifiers.map((c) => c.external_id).filter((v): v is string => Boolean(v)))];
  const ids = [...new Set(identifiers.map((c) => c.by_uuid).filter((v): v is string => Boolean(v)))];
  const titles = [...new Set(identifiers.map((c) => c.by_path_title?.title).filter((v): v is string => Boolean(v)))];
  const rows: ProjectCase[] = [];
  const fetch = async (column: 'tc.external_id' | 'tc.id' | 'tc.title', values: string[]) => {
    for (let k = 0; k < values.length; k += LOOKUP_CHUNK) {
      rows.push(
        ...(await db
          .selectFrom('test_cases as tc')
          .innerJoin('test_suites as ts', 'ts.id', 'tc.test_suite_id')
          .select(['tc.id', 'tc.external_id', 'tc.title', 'tc.test_suite_id', 'ts.name as suite_name'])
          .where('tc.project_id', '=', projectId)
          .where(column, 'in', values.slice(k, k + LOOKUP_CHUNK))
          .execute())
      );
    }
  };
  await fetch('tc.external_id', externalIds);
  await fetch('tc.id', ids);
  await fetch('tc.title', titles);
  const byExternalId = new Map(rows.map((r) => [r.external_id, r]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byTitle = new Map<string, ProjectCase[]>();
  for (const r of rows) {
    const list = byTitle.get(r.title) ?? [];
    if (!list.some((x) => x.id === r.id)) list.push(r);
    byTitle.set(r.title, list);
  }
  return (cid: CaseIdentifier): ProjectCase | undefined => {
    if (cid.external_id && byExternalId.has(cid.external_id)) return byExternalId.get(cid.external_id);
    if (cid.by_uuid && byId.has(cid.by_uuid)) return byId.get(cid.by_uuid);
    const titled = cid.by_path_title?.title ? byTitle.get(cid.by_path_title.title) : undefined;
    if (!titled?.length) return undefined;
    const suite = (cid.by_path_title?.suite_path ?? '').toLowerCase();
    return titled.find((c) => c.suite_name.toLowerCase() === suite) ?? titled[0];
  };
}

/**
 * Records a batch of results in a run, all in one transaction. Answers the error itself (and
 * returns the reply) when the whole request is refused; otherwise returns what was saved.
 */
export async function recordResultsBatch(
  db: Kysely<Database>,
  req: FastifyRequest,
  reply: FastifyReply,
  user: AuthenticatedUser,
  runId: string,
  rawBody: BatchResultsRequest | undefined,
  options: {
    allOrNothing: boolean;
    maxResults?: number;
    /** Close the run after recording (the caller checks RUN_MANAGE). */
    closeRun?: boolean;
  }
): Promise<FastifyReply | BatchRecorded> {
  const startTime = Date.now();
  const allOrNothing = options.allOrNothing;
  const maxResults = options.maxResults ?? MAX_BATCH_RESULTS;
  const body = rawBody || { results: [] };
  const executions = body.results || [];

  // 1. Verify run and test plan lock state
  const runPlanInfo = await db
    .selectFrom('test_runs')
    .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
    .select([
      'test_runs.id as test_run_id',
      'test_runs.status as run_status',
      'test_plans.id as plan_id',
      'test_plans.status as plan_status',
      'test_plans.project_id',
    ])
    .where('test_runs.id', '=', runId)
    .executeTakeFirst();

  if (!runPlanInfo) {
    return sendError(reply, 404, 'Test run not found');
  }
  const planId = runPlanInfo.plan_id;

  if (runPlanInfo.plan_status === 'LOCKED' || runPlanInfo.plan_status === 'ARCHIVED') {
    return sendPlanLockedError(reply, planId, req.url);
  }

  if (runPlanInfo.run_status === 'CLOSED') {
    return sendRunClosedError(reply, runId, req.url);
  }

  const projectId = runPlanInfo.project_id;

  if (user.api_token && user.api_token.project_id !== projectId) {
    return sendTokenProjectMismatchError(reply, user.api_token.project_id, projectId, req.url);
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  // Every item is checked up front (shape, verdict, status, steps given as numbers or ids);
  // whether its case and steps exist is checked against the plan below.
  if (!Array.isArray(body.results) || body.results.length === 0 || body.results.length > maxResults) {
    return sendProblemDetails(reply, {
      status: 400,
      title: 'Bad Request',
      code: 'INVALID_RESULT',
      detail: `results must be a list of 1 to ${maxResults} results`,
      invalid_params: [{ name: 'results', reason: `must be a list of 1 to ${maxResults} results` }],
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
        detail: `Nothing was recorded (all_or_nothing): ${invalid.map((p) => `${p.name} ${p.reason}`).join('; ')}`,
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
  let outcome: { results: BatchResultOutcome[]; successCount: number; failedCount: number };
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
      const priorResults = mayOverwrite ? new Map() : await latestResultsInRun(trx, runId);
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

      // Cases of the project that items name but the plan doesn't have yet (to link them),
      // fetched up front in a few queries rather than one per item: a JUnit file can name
      // thousands of tests that aren't in the plan.
      const findProjectCase = await projectCaseFinder(trx, projectId, checked.flatMap((c) => ('item' in c ? [c.item.case_identifier] : [])));

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

      const results: BatchResultOutcome[] = [];
      const executionRows: any[] = [];
      const stepRows: any[] = [];
      let successCount = 0;
      let failedCount = 0;

      /** Refuses item i: the whole batch in all-or-nothing mode, otherwise just this item. */
      const refuse = (i: number, status: number, code: string, reason: string, invalid_params: InvalidParam[]) => {
        if (allOrNothing) {
          throw new AtomicRejection(status, code, `Nothing was recorded (all_or_nothing): results[${i}]: ${reason}`, invalid_params);
        }
        failedCount++;
        results.push({ index: i, status, code, detail: reason, invalid_params });
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
          const candidate = findProjectCase(cid);

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
            { name: `results[${i}].case_identifier`, reason },
          ]);
          continue;
        }

        if (
          !mayOverwrite &&
          !casesInThisRequest.has(resolvedPlanCase.test_case_id) &&
          isOverwrite(priorResults.get(resolvedPlanCase.test_case_id), user.id, item.verdict)
        ) {
          refuse(i, 403, 'RESULT_OVERWRITE_NOT_PERMITTED', RESULT_OVERWRITE_MESSAGE, [
            { name: `results[${i}].case_identifier`, reason: RESULT_OVERWRITE_MESSAGE },
          ]);
          continue;
        }

        // Step results must name steps of the version this case runs at in the plan, by id
        // or number. (An unknown step used to be recorded against step 1.)
        const versionSteps = await getStepsForVersion(resolvedPlanCase.test_case_version_id);
        const resolvedSteps: Array<{ id: string; step_number: number }> = [];
        const stepProblems: InvalidParam[] = [];
        item.step_results.forEach((sr, j) => {
          const name = `results[${i}].step_results[${j}]`;
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
              position: existingPlanCases.length + 1,
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
          test_run_id: runId,
          test_plan_case_id: resolvedPlanCase.plan_case_id,
          tester_id: user.id,
          status: item.status,
          verdict: item.verdict,
          // null (not a fabricated 0) when the caller doesn't report a real duration.
          duration_ms: item.duration_ms,
          notes: item.notes,
          failure_message: item.failure_message,
          stack_trace: item.stack_trace,
          environment: envTags ? JSON.stringify(envTags) : null,
          runner: runnerJson,
          source: 'API',
          executed_at: item.executed_at ?? now,
          created_at: itemCreatedAt,
          updated_at: itemCreatedAt,
        });
        item.step_results.forEach((sr, j) => {
          stepRows.push({
            id: uuidv4(),
            test_result_id: execId,
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
          test_result_id: execId,
          test_case_id: resolvedPlanCase.test_case_id,
          verdict: item.verdict,
        });
      }

      // Multi-row inserts, in chunks that stay well under Postgres's parameter limit.
      for (let k = 0; k < executionRows.length; k += INSERT_CHUNK) {
        await trx.insertInto('test_results').values(executionRows.slice(k, k + INSERT_CHUNK)).execute();
      }
      for (let k = 0; k < stepRows.length; k += INSERT_CHUNK) {
        await trx.insertInto('test_step_results').values(stepRows.slice(k, k + INSERT_CHUNK)).execute();
      }

      // One summary row per batch call, not per execution item, to avoid flooding
      // audit_logs on a large batch.
      await trx
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: user.id,
          actor_type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
          action: 'RESULTS_BATCH_RECORDED',
          resource_type: 'run',
          resource_id: runId,
          project_id: projectId,
          diff: JSON.stringify({ successful: successCount, failed: failedCount, test_plan_id: planId }),
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

  const responsePayload: BatchResultsResponse = {
    object: 'batch_results',
    summary: {
      total_submitted: executions.length,
      successful: successCount,
      failed: failedCount,
      duration_ms: Date.now() - startTime,
    },
    results,
  };

  // CI results never auto-close the run: a build may send several files, or be re-run, and only
  // the CI knows when it's done (decided with Elliot, 2026-10-12). `close_run` closes it on purpose.
  if (options.closeRun) {
    await db.updateTable('test_runs').set({ status: 'CLOSED', updated_at: new Date().toISOString() }).where('id', '=', runId).execute();
  }
  responsePayload.run_status = options.closeRun ? 'CLOSED' : 'OPEN';

  // Webhooks: what this batch recorded, then (with close_run) the closed run.
  const actor = webhookActor(user);
  await emitResultsRecorded(
    db,
    actor,
    runId,
    'API',
    results.flatMap((r) => (r.status === 201 && r.test_case_id ? [{ test_case_id: r.test_case_id, verdict: r.verdict!, failure_message: executions[r.index]?.failure_message ?? null }] : []))
  );
  if (options.closeRun) await emitRunClosed(db, actor, runId, 'ci');

  const httpStatus = failedCount > 0 && !allOrNothing ? 207 : 201;
  return new BatchRecorded(httpStatus, responsePayload);
}
