import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import type { RunSummaryReport } from '@testify/core';
import { actorType } from '../audit.js';
import { ReportService } from './reportService.js';
import { emitWebhookEvent, type WebhookActor } from './webhooks.js';

/**
 * The events each part of Testify sends to webhooks (the catalog is WEBHOOK_EVENTS in
 * @testify/core). Each helper builds the event's `data` and queues it; none of them throws.
 */

const MAX_FAILURES = 20;

export const webhookActor = (user: { id: string; api_token?: unknown } | null | undefined): WebhookActor =>
  user ? { id: user.id, type: actorType(user) } : null;

async function runAndPlan(db: Kysely<Database>, runId: string) {
  return db
    .selectFrom('test_runs')
    .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
    .select(['test_runs.id as run_id', 'test_runs.name as run_name', 'test_runs.status as run_status', 'test_plans.id as plan_id', 'test_plans.name as plan_name', 'test_plans.project_id'])
    .where('test_runs.id', '=', runId)
    .executeTakeFirst();
}

export async function emitRunCreated(db: Kysely<Database>, actor: WebhookActor, runId: string): Promise<void> {
  const r = await runAndPlan(db, runId);
  if (!r) return;
  await emitWebhookEvent(db, {
    projectId: r.project_id,
    event: 'run.created',
    actor,
    data: { run: { id: r.run_id, name: r.run_name, status: r.run_status }, plan: { id: r.plan_id, name: r.plan_name } },
    link: { tab: 'run', plan: r.plan_id, run: r.run_id },
  });
}

/** run.closed, with the run's summary (the run_summary report, compared with the plan's previous run). */
export async function emitRunClosed(db: Kysely<Database>, actor: WebhookActor, runId: string, closedBy: 'auto' | 'person' | 'ci'): Promise<void> {
  const r = await runAndPlan(db, runId);
  if (!r) return;
  await emitWebhookEvent(db, {
    projectId: r.project_id,
    event: 'run.closed',
    actor,
    link: { tab: 'run', plan: r.plan_id, run: r.run_id },
    data: async () => {
      const report = (await new ReportService(db).run(r.project_id, 'run_summary', { test_run_id: runId, limit: MAX_FAILURES })).data as RunSummaryReport;
      const s = report.summary;
      const compared = report.compared_to;
      return {
        run: { id: r.run_id, name: r.run_name, status: 'CLOSED' },
        plan: { id: r.plan_id, name: r.plan_name },
        closed_by: closedBy,
        summary: {
          total: s.total,
          passed: s.passed,
          failed: s.failed,
          blocked: s.blocked,
          skipped: s.skipped,
          untested: s.untested,
          other: s.other,
          pass_rate: s.pass_rate,
          completion: s.completion,
          compared_to: compared ? { id: compared.id, name: compared.name } : null,
          new_failures: compared ? report.diff.counts.new_failure : null,
          fixed: compared ? report.diff.counts.fixed : null,
          still_failing: compared ? report.diff.counts.still_failing : null,
          failure_count: s.failed + s.blocked,
          failures: report.failures.slice(0, MAX_FAILURES).map((f) => ({
            test_case_id: f.test_case_id,
            external_id: f.external_id,
            title: f.title,
            verdict: f.verdict,
            failure_message: f.failure_message,
            failing_since: f.failing_since ? { test_run_id: f.failing_since.test_run_id, run_name: f.failing_since.run_name, runs: f.failing_since.runs } : null,
          })),
          failures_truncated: report.failures_truncated || report.failures.length > MAX_FAILURES,
        },
      };
    },
  });
}

/**
 * results.recorded (always) and results.failed (when any is FAILED or BLOCKED), once per request
 * that recorded results: one result from the web app, or a whole CI batch.
 */
export async function emitResultsRecorded(
  db: Kysely<Database>,
  actor: WebhookActor,
  runId: string,
  source: 'UI' | 'API',
  results: Array<{ test_case_id: string; verdict: string; failure_message?: string | null }>
): Promise<void> {
  if (!results.length) return;
  const r = await runAndPlan(db, runId);
  if (!r) return;
  const failing = results.filter((x) => x.verdict === 'FAILED' || x.verdict === 'BLOCKED');

  // Built once for both events, and only if a webhook is listening.
  let built: Promise<Record<string, unknown>> | null = null;
  const buildData = async () => {
    const counts: Record<string, number> = {};
    for (const x of results) counts[x.verdict.toLowerCase()] = (counts[x.verdict.toLowerCase()] ?? 0) + 1;
    const ids = [...new Set(failing.slice(0, MAX_FAILURES).map((f) => f.test_case_id))];
    const cases = ids.length ? await db.selectFrom('test_cases').select(['id', 'external_id', 'title']).where('id', 'in', ids).execute() : [];
    const byId = new Map(cases.map((c) => [c.id, c]));
    return {
      run: { id: r.run_id, name: r.run_name, status: r.run_status },
      plan: { id: r.plan_id, name: r.plan_name },
      source,
      recorded: results.length,
      counts,
      failed_count: failing.length,
      failures: failing.slice(0, MAX_FAILURES).map((f) => ({
        test_case_id: f.test_case_id,
        external_id: byId.get(f.test_case_id)?.external_id ?? null,
        title: byId.get(f.test_case_id)?.title ?? null,
        verdict: f.verdict,
        failure_message: f.failure_message ?? null,
      })),
      failures_truncated: failing.length > MAX_FAILURES,
    };
  };
  const data = () => (built ??= buildData());

  const link = { tab: 'run' as const, plan: r.plan_id, run: r.run_id };
  await emitWebhookEvent(db, { projectId: r.project_id, event: 'results.recorded', actor, data, link });
  if (failing.length) await emitWebhookEvent(db, { projectId: r.project_id, event: 'results.failed', actor, data, link });
}

/** test_case.created / approved / deprecated / restored. */
export async function emitTestCaseEvent(
  db: Kysely<Database>,
  actor: WebhookActor,
  event: 'test_case.created' | 'test_case.approved' | 'test_case.deprecated' | 'test_case.restored',
  caseId: string,
  extra: { via?: 'mcp' | null } = {}
): Promise<void> {
  const c = await db
    .selectFrom('test_cases as c')
    .innerJoin('test_suites as s', 's.id', 'c.test_suite_id')
    .select(['c.id', 'c.external_id', 'c.title', 'c.project_id', 'c.priority', 's.name as suite_name'])
    .where('c.id', '=', caseId)
    .executeTakeFirst();
  if (!c) return;
  await emitWebhookEvent(db, {
    projectId: c.project_id,
    event,
    actor,
    data: async () => {
      const version = await db
        .selectFrom('test_case_versions')
        .select(['id', 'version_number', 'status'])
        .where('test_case_id', '=', caseId)
        .orderBy('version_number', 'desc')
        .limit(1)
        .executeTakeFirst();
      return {
        test_case: { id: c.id, external_id: c.external_id, title: c.title, priority: c.priority, suite: c.suite_name },
        version: version ? { id: version.id, version_number: version.version_number, status: version.status } : null,
        ...(event === 'test_case.created' ? { via: extra.via ?? null } : {}),
      };
    },
    link: { tab: 'overview', case: c.id },
  });
}

export async function emitImportCompleted(db: Kysely<Database>, actor: WebhookActor, projectId: string, format: string, counts: Record<string, unknown>): Promise<void> {
  await emitWebhookEvent(db, { projectId, event: 'import.completed', actor, data: { format, counts }, link: { tab: 'overview' } });
}
