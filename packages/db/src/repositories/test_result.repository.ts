import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestResultsTable, TestStepResultsTable } from '../types.js';
import { decodeCursor, toPage, type Page } from '../paging.js';

export type TestResult = Selectable<TestResultsTable>;
export type NewTestResult = Insertable<TestResultsTable>;
export type TestResultUpdate = Updateable<TestResultsTable>;

export type StepResult = Selectable<TestStepResultsTable>;
export type NewStepResult = Insertable<TestStepResultsTable>;
export type StepResultUpdate = Updateable<TestStepResultsTable>;

export interface CreateStepResultInput {
  id?: string;
  test_step_id: string;
  step_number: number;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'UNTESTED' | string;
  actual_result?: string | null;
}

export interface CreateTestResultInput {
  id?: string;
  test_run_id: string;
  test_plan_case_id: string;
  tester_id: string;
  status?: 'UNTESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED' | string;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'RETEST_REQUIRED' | 'KNOWN_ISSUE' | string;
  duration_ms?: number;
  notes?: string | null;
  failure_message?: string | null;
  stack_trace?: string | null;
  environment?: Record<string, unknown> | null;
  runner?: Record<string, unknown> | null;
  source?: 'UI' | 'API' | null;
  executed_at?: string;
  steps?: CreateStepResultInput[];
}

function jsonOrNull(v: Record<string, unknown> | null | undefined): string | null {
  return v && Object.keys(v).length > 0 ? JSON.stringify(v) : null;
}

/** One result in a run's result list (listForRun), with its case and step results. */
export interface RunResultRow {
  test_result_id: string;
  test_run_id: string;
  test_plan_case_id: string;
  test_case_id: string;
  external_id: string;
  title: string;
  test_case_version_id: string;
  version_number: number | null;
  verdict: string;
  status: string;
  duration_ms: number | null;
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment: string | null;
  runner: string | null;
  source: string | null;
  tester_id: string;
  executed_at: string;
  created_at: string;
  steps: StepResult[];
}

export interface TestResultWithSteps extends TestResult {
  steps: StepResult[];
}

/** The final result (latest result) of one plan case in one run, plus what happened
 * across all of that case's attempts in the run. Every plan case gets a row for every
 * requested run; `verdict: null` (and every other result field null) means it has no
 * result in that run yet (UNTESTED). See getFinalResultsForRuns. */
export interface FinalResultRow {
  test_run_id: string;
  plan_case_id: string;
  test_case_id: string;
  test_result_id: string | null;
  verdict: string | null;
  duration_ms: number | null;
  failure_message: string | null;
  notes: string | null;
  tester_id: string | null;
  source: string | null;
  runner: string | null; // JSON
  executed_at: string | null;
  /** The case was removed from the plan after it had results; it only appears in runs that
   * recorded one. */
  removed_from_plan: boolean;
  /** Results recorded for this case in this run (re-runs/retries add rows). 0 = untested. */
  attempts: number;
  had_pass: boolean;
  had_fail: boolean; // any FAILED or BLOCKED attempt
}

/** One result in a case's history, with the run/plan it belongs to. */
export interface CaseHistoryRow {
  test_result_id: string;
  test_run_id: string;
  run_name: string;
  test_plan_id: string;
  plan_name: string;
  version_number: number | null;
  verdict: string;
  status: string;
  duration_ms: number | null;
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment: string | null; // JSON
  runner: string | null; // JSON
  source: string | null;
  tester_id: string;
  executed_at: string;
}

/** Minimal per-result row for a case's whole history (stats are computed from these). */
export interface CaseVerdictTimelineRow {
  test_run_id: string;
  verdict: string;
  executed_at: string;
}

export interface ActivityRow {
  day: string; // YYYY-MM-DD
  source: string | null;
  count: number;
}

export class TestResultRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateTestResultInput): Promise<TestResultWithSteps> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const executionRow: NewTestResult = {
      id,
      test_run_id: input.test_run_id,
      test_plan_case_id: input.test_plan_case_id,
      tester_id: input.tester_id,
      status: input.status ?? 'COMPLETED',
      verdict: input.verdict,
      duration_ms: input.duration_ms ?? null,
      notes: input.notes ?? null,
      failure_message: input.failure_message ?? null,
      stack_trace: input.stack_trace ?? null,
      environment: jsonOrNull(input.environment),
      runner: jsonOrNull(input.runner),
      source: input.source ?? null,
      executed_at: input.executed_at ?? now,
      created_at: now,
      updated_at: now,
    };

    const stepRows: NewStepResult[] = (input.steps ?? []).map((step) => ({
      id: step.id || uuidv7(),
      test_result_id: id,
      test_step_id: step.test_step_id,
      step_number: step.step_number,
      verdict: step.verdict,
      actual_result: step.actual_result ?? null,
      created_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('test_results').values(executionRow).execute();
      if (stepRows.length > 0) {
        await trx.insertInto('test_step_results').values(stepRows).execute();
      }
    });

    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<TestResultWithSteps | undefined> {
    const row = await this.db
      .selectFrom('test_results')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!row) return undefined;

    const steps = await this.getStepResults(id);
    return {
      ...row,
      steps,
    };
  }

  async findByRun(buildId: string): Promise<TestResult[]> {
    return await this.db
      .selectFrom('test_results')
      .selectAll()
      .where('test_run_id', '=', buildId)
      .orderBy('executed_at', 'desc')
      .execute();
  }

  async getStepResults(executionId: string): Promise<StepResult[]> {
    return await this.db
      .selectFrom('test_step_results')
      .selectAll()
      .where('test_result_id', '=', executionId)
      .orderBy('step_number', 'asc')
      .execute();
  }

  /** Batched sibling of getStepResults() -- one query for every result's steps
   * instead of one getStepResults() call per result. Built for export, which needs
   * step results across every result in a run in a single request. */
  async getStepResultsForResults(executionIds: string[]): Promise<Map<string, StepResult[]>> {
    if (executionIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('test_step_results')
      .selectAll()
      .where('test_result_id', 'in', executionIds)
      .orderBy('step_number', 'asc')
      .execute();
    const map = new Map<string, StepResult[]>();
    for (const row of rows) {
      const list = map.get(row.test_result_id) ?? [];
      list.push(row);
      map.set(row.test_result_id, list);
    }
    return map;
  }

  /**
   * The final result of every plan case in `planId` for each of `runIds`, in ONE query: a
   * window over (run, plan case) picks the latest result (executed_at desc,
   * created_at desc tie-break) and also counts the attempts and whether any attempt passed
   * or failed (pass-after-retry flakiness needs those). Plan cases with no result in a run
   * get an all-null UNTESTED row, so totals reflect the plan's current case list.
   *
   * Which cases a run contains: every case with an active link, plus a case removed from the
   * plan (only retired links) if it has a result in that run -- so old runs keep the results
   * they recorded and later runs don't list it. One row per case per run, showing its latest
   * result in that run from any of its links. While the case is in the plan the row carries
   * its **active** link (so new results are recorded against current membership, even in an
   * old run); only a case that's out of the plan is `removed_from_plan` (read-only). Rows
   * are returned in `runIds` order.
   */
  async getFinalResultsForRuns(planId: string, runIds: string[]): Promise<FinalResultRow[]> {
    if (runIds.length === 0) return [];

    const planCases = await this.db
      .selectFrom('test_plan_cases')
      .select(['id as plan_case_id', 'test_case_id', 'removed_at'])
      .where('test_plan_id', '=', planId)
      .orderBy('position', 'asc')
      .orderBy('created_at', 'asc')
      .execute();
    if (planCases.length === 0) return [];

    const partition = ['e.test_run_id', 'e.test_plan_case_id'] as const;
    const ranked = await this.db
      .with('ranked', (db) =>
        db
          .selectFrom('test_results as e')
          .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
          .select((eb) => [
            'e.id as test_result_id',
            'e.test_run_id as test_run_id',
            'e.test_plan_case_id as plan_case_id',
            'e.verdict as verdict',
            'e.duration_ms as duration_ms',
            'e.failure_message as failure_message',
            'e.notes as notes',
            'e.tester_id as tester_id',
            'e.source as source',
            'e.runner as runner',
            'e.executed_at as executed_at',
            eb.fn
              .agg<number>('row_number')
              .over((ob) => ob.partitionBy([...partition]).orderBy('e.executed_at', 'desc').orderBy('e.created_at', 'desc'))
              .as('rn'),
            eb.fn.count<number>('e.id').over((ob) => ob.partitionBy([...partition])).as('attempts'),
            eb.fn
              .agg<boolean>('bool_or', [sql<boolean>`${sql.ref('e.verdict')} = 'PASSED'`])
              .over((ob) => ob.partitionBy([...partition]))
              .as('had_pass'),
            eb.fn
              .agg<boolean>('bool_or', [sql<boolean>`${sql.ref('e.verdict')} in ('FAILED', 'BLOCKED')`])
              .over((ob) => ob.partitionBy([...partition]))
              .as('had_fail'),
          ])
          .where('tpc.test_plan_id', '=', planId)
          .where('e.test_run_id', 'in', runIds)
      )
      .selectFrom('ranked')
      .selectAll()
      .where('rn', '=', 1)
      .execute();

    const byKey = new Map(ranked.map((r) => [`${r.test_run_id}|${r.plan_case_id}`, r]));
    const results: FinalResultRow[] = [];
    for (const runId of runIds) {
      // One row per case (see the doc comment above): its latest result in this run from any
      // of its links, recorded against its active link when it has one.
      const byCase = new Map<string, Array<(typeof planCases)[number]>>();
      for (const pc of planCases) byCase.set(pc.test_case_id, [...(byCase.get(pc.test_case_id) ?? []), pc]);
      for (const [testCaseId, links] of byCase) {
        const active = links.find((l) => !l.removed_at);
        const withResults = links.map((l) => byKey.get(`${runId}|${l.plan_case_id}`)).filter((r): r is NonNullable<typeof r> => Boolean(r));
        if (!active && withResults.length === 0) continue; // removed, and never run here
        const r = withResults.sort((x, y) => (y.executed_at ?? '').localeCompare(x.executed_at ?? ''))[0];
        results.push({
          removed_from_plan: !active,
          test_run_id: runId,
          plan_case_id: active ? active.plan_case_id : r!.plan_case_id,
          test_case_id: testCaseId,
          test_result_id: r?.test_result_id ?? null,
          verdict: r?.verdict ?? null,
          duration_ms: r?.duration_ms ?? null,
          failure_message: r?.failure_message ?? null,
          notes: r?.notes ?? null,
          tester_id: r?.tester_id ?? null,
          source: r?.source ?? null,
          runner: r?.runner ?? null,
          executed_at: r?.executed_at ?? null,
          attempts: withResults.reduce((n, x) => n + Number(x.attempts), 0),
          had_pass: withResults.some((x) => Boolean(x.had_pass)),
          had_fail: withResults.some((x) => Boolean(x.had_fail)),
        });
      }
    }
    return results;
  }

  /**
   * One page of every result a test case ever got, across all plans and runs, newest
   * first. Keyset-paginated on (executed_at, id): pass the `next_cursor` from the
   * previous page as `cursor`.
   */
  async getCaseHistory(
    testCaseId: string,
    opts: { limit: number; cursor?: string | null }
  ): Promise<{ rows: CaseHistoryRow[]; next_cursor: string | null }> {
    let query = this.db
      .selectFrom('test_results as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('test_runs as b', 'b.id', 'e.test_run_id')
      .innerJoin('test_plans as p', 'p.id', 'b.test_plan_id')
      .leftJoin('test_case_versions as v', 'v.id', 'tpc.test_case_version_id')
      .select([
        'e.id as test_result_id',
        'b.id as test_run_id',
        'b.name as run_name',
        'p.id as test_plan_id',
        'p.name as plan_name',
        'v.version_number as version_number',
        'e.verdict as verdict',
        'e.status as status',
        'e.duration_ms as duration_ms',
        'e.notes as notes',
        'e.failure_message as failure_message',
        'e.stack_trace as stack_trace',
        'e.environment as environment',
        'e.runner as runner',
        'e.source as source',
        'e.tester_id as tester_id',
        'e.executed_at as executed_at',
      ])
      .where('tpc.test_case_id', '=', testCaseId);

    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('e.executed_at', '<', cursor.ts),
          eb.and([eb('e.executed_at', '=', cursor.ts), eb('e.id', '<', cursor.id)]),
        ])
      );
    }

    const rows = await query
      .orderBy('e.executed_at', 'desc')
      .orderBy('e.id', 'desc')
      .limit(opts.limit + 1)
      .execute();

    return toPage(rows as CaseHistoryRow[], opts.limit, (r) => ({ ts: r.executed_at, id: r.test_result_id }));
  }

  /** Every result of a case (verdict + run + time only), oldest first -- the input for a
   * case's whole-history stats, independent of which history page is being shown. */
  /**
   * A run's results, newest first, a page at a time, each with its step results and its case.
   * Filters: verdicts, one case, the source (UI / API), and `latestOnly` (each case's latest result
   * in the run, i.e. what reports count). Keyset paging on (executed_at, created_at, id), the order
   * `rn` uses.
   */
  async listForRun(
    runId: string,
    filters: { verdicts?: string[]; testCaseId?: string; source?: string; latestOnly?: boolean },
    page: { limit: number; cursor?: string | null }
  ): Promise<Page<RunResultRow>> {
    const base = this.runResultsQuery().where('e.test_run_id', '=', runId);

    let query = this.db.selectFrom(base.as('r')).selectAll();
    if (filters.latestOnly) query = query.where('r.rn', '=', 1);
    if (filters.verdicts?.length) query = query.where('r.verdict', 'in', filters.verdicts);
    if (filters.testCaseId) query = query.where('r.test_case_id', '=', filters.testCaseId);
    if (filters.source) query = query.where('r.source', '=', filters.source);
    // Results sent in one CI batch share executed_at; created_at keeps them in the order sent.
    const cursor = decodeCursor(page.cursor);
    if (cursor) {
      query = query.where(sql<boolean>`(r.executed_at, r.created_at, r.test_result_id) < (${cursor.ts}, ${cursor.ts2 ?? ''}, ${cursor.id})`);
    }
    const rows = await query
      .orderBy('r.executed_at', 'desc')
      .orderBy('r.created_at', 'desc')
      .orderBy('r.test_result_id', 'desc')
      .limit(page.limit + 1)
      .execute();
    const paged = toPage(rows, page.limit, (r) => ({ ts: r.executed_at, ts2: r.created_at, id: r.test_result_id }));
    return { next_cursor: paged.next_cursor, rows: await this.withSteps(paged.rows) };
  }

  /** One result in the same shape as listForRun's rows. */
  async getRunResult(resultId: string): Promise<RunResultRow | undefined> {
    const row = await this.runResultsQuery().where('e.id', '=', resultId).executeTakeFirst();
    return row ? (await this.withSteps([row]))[0] : undefined;
  }

  private async withSteps<T extends { test_result_id: string; rn: number }>(rows: T[]): Promise<RunResultRow[]> {
    const steps = await this.getStepResultsForResults(rows.map((r) => r.test_result_id));
    return rows.map(({ rn: _rn, ...r }) => ({ ...(r as unknown as Omit<RunResultRow, 'steps'>), steps: steps.get(r.test_result_id) ?? [] }));
  }

  /** Results with their case and pinned version; `rn` = 1 for each case's latest result in its run. */
  private runResultsQuery() {
    return this.db
      .selectFrom('test_results as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('test_cases as c', 'c.id', 'tpc.test_case_id')
      .leftJoin('test_case_versions as v', 'v.id', 'tpc.test_case_version_id')
      .select([
        'e.id as test_result_id',
        'e.test_run_id as test_run_id',
        'e.test_plan_case_id as test_plan_case_id',
        'c.id as test_case_id',
        'c.external_id as external_id',
        'c.title as title',
        'tpc.test_case_version_id as test_case_version_id',
        'v.version_number as version_number',
        'e.verdict as verdict',
        'e.status as status',
        'e.duration_ms as duration_ms',
        'e.notes as notes',
        'e.failure_message as failure_message',
        'e.stack_trace as stack_trace',
        'e.environment as environment',
        'e.runner as runner',
        'e.source as source',
        'e.tester_id as tester_id',
        'e.executed_at as executed_at',
        'e.created_at as created_at',
        sql<number>`row_number() over (partition by e.test_run_id, c.id order by e.executed_at desc, e.created_at desc, e.id desc)`.as('rn'),
      ]);
  }

  async getCaseVerdictTimeline(testCaseId: string): Promise<CaseVerdictTimelineRow[]> {
    return await this.db
      .selectFrom('test_results as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .select(['e.test_run_id as test_run_id', 'e.verdict as verdict', 'e.executed_at as executed_at'])
      .where('tpc.test_case_id', '=', testCaseId)
      .orderBy('e.executed_at', 'asc')
      .orderBy('e.created_at', 'asc')
      .execute();
  }

  /** Latest result time per test case in a project, in any plan/run. Cases never
   * executed are simply absent. */
  async getLastExecutedAtByCase(projectId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('test_results as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select((eb) => ['tpc.test_case_id as test_case_id', eb.fn.max('e.executed_at').as('last_executed_at')])
      .where('tc.project_id', '=', projectId)
      .groupBy('tpc.test_case_id')
      .execute();
    return new Map(rows.map((r) => [r.test_case_id, String(r.last_executed_at)]));
  }

  /** Results recorded per day (UTC, from executed_at) and source in a project,
   * since `sinceIso`. */
  async getActivity(projectId: string, sinceIso: string): Promise<ActivityRow[]> {
    const day = sql<string>`left(${sql.ref('e.executed_at')}, 10)`;
    const rows = await this.db
      .selectFrom('test_results as e')
      .innerJoin('test_runs as b', 'b.id', 'e.test_run_id')
      .innerJoin('test_plans as p', 'p.id', 'b.test_plan_id')
      .select((eb) => [day.as('day'), 'e.source as source', eb.fn.count<number>('e.id').as('count')])
      .where('p.project_id', '=', projectId)
      .where('e.executed_at', '>=', sinceIso)
      .groupBy([day, 'e.source'])
      .orderBy('day', 'asc')
      .execute();
    return rows.map((r) => ({ day: r.day, source: r.source, count: Number(r.count) }));
  }

}
