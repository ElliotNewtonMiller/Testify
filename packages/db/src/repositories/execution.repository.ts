import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { sql } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, ExecutionsTable, ExecutionStepsTable } from '../types.js';

export type Execution = Selectable<ExecutionsTable>;
export type NewExecution = Insertable<ExecutionsTable>;
export type ExecutionUpdate = Updateable<ExecutionsTable>;

export type ExecutionStep = Selectable<ExecutionStepsTable>;
export type NewExecutionStep = Insertable<ExecutionStepsTable>;
export type ExecutionStepUpdate = Updateable<ExecutionStepsTable>;

export interface CreateExecutionStepInput {
  id?: string;
  test_step_id: string;
  step_number: number;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'UNTESTED' | string;
  actual_result?: string | null;
}

export interface CreateExecutionInput {
  id?: string;
  build_id: string;
  test_plan_case_id: string;
  tester_id: string;
  status?: 'UNTESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED' | string;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'RETEST_REQUIRED' | 'KNOWN_ISSUE' | string;
  execution_duration_ms?: number;
  notes?: string | null;
  custom_fields_snapshot?: Record<string, any> | string;
  failure_message?: string | null;
  stack_trace?: string | null;
  environment?: Record<string, unknown> | null;
  runner?: Record<string, unknown> | null;
  source?: 'UI' | 'API' | null;
  execution_timestamp?: string;
  steps?: CreateExecutionStepInput[];
}

function jsonOrNull(v: Record<string, unknown> | null | undefined): string | null {
  return v && Object.keys(v).length > 0 ? JSON.stringify(v) : null;
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.indexOf('|');
  if (sep <= 0) return null;
  return { ts: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
}

export interface ExecutionWithSteps extends Execution {
  steps: ExecutionStep[];
}

/** The final result (latest execution) of one plan case in one run, plus what happened
 * across all of that case's attempts in the run. Every plan case gets a row for every
 * requested run; `verdict: null` (and every other execution field null) means it has no
 * result in that run yet (UNTESTED). See getFinalResultsForRuns. */
export interface FinalResultRow {
  run_id: string;
  plan_case_id: string;
  test_case_id: string;
  execution_id: string | null;
  verdict: string | null;
  execution_duration_ms: number | null;
  failure_message: string | null;
  notes: string | null;
  tester_id: string | null;
  source: string | null;
  runner: string | null; // JSON
  execution_timestamp: string | null;
  /** The case was removed from the plan after it had results; it only appears in runs that
   * recorded one. */
  removed_from_plan: boolean;
  /** Executions recorded for this case in this run (re-runs/retries add rows). 0 = untested. */
  attempts: number;
  had_pass: boolean;
  had_fail: boolean; // any FAILED or BLOCKED attempt
}

/** One execution in a case's history, with the run/plan it belongs to. */
export interface CaseHistoryRow {
  execution_id: string;
  run_id: string;
  run_name: string;
  plan_id: string;
  plan_name: string;
  version_number: number | null;
  verdict: string;
  status: string;
  execution_duration_ms: number | null;
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment: string | null; // JSON
  runner: string | null; // JSON
  source: string | null;
  tester_id: string;
  execution_timestamp: string;
}

/** Minimal per-execution row for a case's whole history (stats are computed from these). */
export interface CaseVerdictTimelineRow {
  run_id: string;
  verdict: string;
  execution_timestamp: string;
}

export interface ActivityRow {
  day: string; // YYYY-MM-DD
  source: string | null;
  count: number;
}

export class ExecutionRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateExecutionInput): Promise<ExecutionWithSteps> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const snapshotStr =
      typeof input.custom_fields_snapshot === 'object'
        ? JSON.stringify(input.custom_fields_snapshot)
        : input.custom_fields_snapshot || '{}';

    const executionRow: NewExecution = {
      id,
      build_id: input.build_id,
      test_plan_case_id: input.test_plan_case_id,
      tester_id: input.tester_id,
      status: input.status ?? 'COMPLETED',
      verdict: input.verdict,
      execution_duration_ms: input.execution_duration_ms ?? null,
      notes: input.notes ?? null,
      custom_fields_snapshot: snapshotStr,
      failure_message: input.failure_message ?? null,
      stack_trace: input.stack_trace ?? null,
      environment: jsonOrNull(input.environment),
      runner: jsonOrNull(input.runner),
      source: input.source ?? null,
      execution_timestamp: input.execution_timestamp ?? now,
      created_at: now,
      updated_at: now,
    };

    const stepRows: NewExecutionStep[] = (input.steps ?? []).map((step) => ({
      id: step.id || uuidv7(),
      execution_id: id,
      test_step_id: step.test_step_id,
      step_number: step.step_number,
      verdict: step.verdict,
      actual_result: step.actual_result ?? null,
      created_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('executions').values(executionRow).execute();
      if (stepRows.length > 0) {
        await trx.insertInto('execution_steps').values(stepRows).execute();
      }
    });

    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<ExecutionWithSteps | undefined> {
    const execution = await this.db
      .selectFrom('executions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!execution) return undefined;

    const steps = await this.getExecutionSteps(id);
    return {
      ...execution,
      steps,
    };
  }

  async findByBuildAndPlanCase(
    buildId: string,
    testPlanCaseId: string
  ): Promise<Execution[]> {
    return await this.db
      .selectFrom('executions')
      .selectAll()
      .where('build_id', '=', buildId)
      .where('test_plan_case_id', '=', testPlanCaseId)
      .orderBy('execution_timestamp', 'desc')
      .execute();
  }

  async getLatestExecutionForPlanCase(
    buildId: string,
    testPlanCaseId: string
  ): Promise<ExecutionWithSteps | undefined> {
    const execution = await this.db
      .selectFrom('executions')
      .selectAll()
      .where('build_id', '=', buildId)
      .where('test_plan_case_id', '=', testPlanCaseId)
      .orderBy('execution_timestamp', 'desc')
      .executeTakeFirst();

    if (!execution) return undefined;

    const steps = await this.getExecutionSteps(execution.id);
    return {
      ...execution,
      steps,
    };
  }

  async findByBuild(buildId: string): Promise<Execution[]> {
    return await this.db
      .selectFrom('executions')
      .selectAll()
      .where('build_id', '=', buildId)
      .orderBy('execution_timestamp', 'desc')
      .execute();
  }

  async findByTestPlanCase(testPlanCaseId: string): Promise<Execution[]> {
    return await this.db
      .selectFrom('executions')
      .selectAll()
      .where('test_plan_case_id', '=', testPlanCaseId)
      .orderBy('execution_timestamp', 'desc')
      .execute();
  }

  async getExecutionSteps(executionId: string): Promise<ExecutionStep[]> {
    return await this.db
      .selectFrom('execution_steps')
      .selectAll()
      .where('execution_id', '=', executionId)
      .orderBy('step_number', 'asc')
      .execute();
  }

  /** Batched sibling of getExecutionSteps() -- one query for every execution's steps
   * instead of one getExecutionSteps() call per execution. Built for export, which needs
   * step results across every execution in a build in a single request. */
  async getExecutionStepsForExecutions(executionIds: string[]): Promise<Map<string, ExecutionStep[]>> {
    if (executionIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('execution_steps')
      .selectAll()
      .where('execution_id', 'in', executionIds)
      .orderBy('step_number', 'asc')
      .execute();
    const map = new Map<string, ExecutionStep[]>();
    for (const row of rows) {
      const list = map.get(row.execution_id) ?? [];
      list.push(row);
      map.set(row.execution_id, list);
    }
    return map;
  }

  /**
   * The final result of every plan case in `planId` for each of `runIds`, in ONE query: a
   * window over (run, plan case) picks the latest execution (execution_timestamp desc,
   * created_at desc tie-break) and also counts the attempts and whether any attempt passed
   * or failed (pass-after-retry flakiness needs those). Plan cases with no execution in a run
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

    const partition = ['e.build_id', 'e.test_plan_case_id'] as const;
    const ranked = await this.db
      .with('ranked', (db) =>
        db
          .selectFrom('executions as e')
          .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
          .select((eb) => [
            'e.id as execution_id',
            'e.build_id as run_id',
            'e.test_plan_case_id as plan_case_id',
            'e.verdict as verdict',
            'e.execution_duration_ms as execution_duration_ms',
            'e.failure_message as failure_message',
            'e.notes as notes',
            'e.tester_id as tester_id',
            'e.source as source',
            'e.runner as runner',
            'e.execution_timestamp as execution_timestamp',
            eb.fn
              .agg<number>('row_number')
              .over((ob) => ob.partitionBy([...partition]).orderBy('e.execution_timestamp', 'desc').orderBy('e.created_at', 'desc'))
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
          .where('e.build_id', 'in', runIds)
      )
      .selectFrom('ranked')
      .selectAll()
      .where('rn', '=', 1)
      .execute();

    const byKey = new Map(ranked.map((r) => [`${r.run_id}|${r.plan_case_id}`, r]));
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
        const r = withResults.sort((x, y) => (y.execution_timestamp ?? '').localeCompare(x.execution_timestamp ?? ''))[0];
        results.push({
          removed_from_plan: !active,
          run_id: runId,
          plan_case_id: active ? active.plan_case_id : r!.plan_case_id,
          test_case_id: testCaseId,
          execution_id: r?.execution_id ?? null,
          verdict: r?.verdict ?? null,
          execution_duration_ms: r?.execution_duration_ms ?? null,
          failure_message: r?.failure_message ?? null,
          notes: r?.notes ?? null,
          tester_id: r?.tester_id ?? null,
          source: r?.source ?? null,
          runner: r?.runner ?? null,
          execution_timestamp: r?.execution_timestamp ?? null,
          attempts: withResults.reduce((n, x) => n + Number(x.attempts), 0),
          had_pass: withResults.some((x) => Boolean(x.had_pass)),
          had_fail: withResults.some((x) => Boolean(x.had_fail)),
        });
      }
    }
    return results;
  }

  /**
   * One page of every execution a test case ever got, across all plans and runs, newest
   * first. Keyset-paginated on (execution_timestamp, id): pass the `next_cursor` from the
   * previous page as `cursor`.
   */
  async getCaseHistory(
    testCaseId: string,
    opts: { limit: number; cursor?: string | null }
  ): Promise<{ rows: CaseHistoryRow[]; next_cursor: string | null }> {
    let query = this.db
      .selectFrom('executions as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('builds as b', 'b.id', 'e.build_id')
      .innerJoin('test_plans as p', 'p.id', 'b.test_plan_id')
      .leftJoin('test_case_versions as v', 'v.id', 'tpc.test_case_version_id')
      .select([
        'e.id as execution_id',
        'b.id as run_id',
        'b.name as run_name',
        'p.id as plan_id',
        'p.name as plan_name',
        'v.version_number as version_number',
        'e.verdict as verdict',
        'e.status as status',
        'e.execution_duration_ms as execution_duration_ms',
        'e.notes as notes',
        'e.failure_message as failure_message',
        'e.stack_trace as stack_trace',
        'e.environment as environment',
        'e.runner as runner',
        'e.source as source',
        'e.tester_id as tester_id',
        'e.execution_timestamp as execution_timestamp',
      ])
      .where('tpc.test_case_id', '=', testCaseId);

    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      query = query.where((eb) =>
        eb.or([
          eb('e.execution_timestamp', '<', cursor.ts),
          eb.and([eb('e.execution_timestamp', '=', cursor.ts), eb('e.id', '<', cursor.id)]),
        ])
      );
    }

    const rows = await query
      .orderBy('e.execution_timestamp', 'desc')
      .orderBy('e.id', 'desc')
      .limit(opts.limit + 1)
      .execute();

    const page = rows.slice(0, opts.limit) as CaseHistoryRow[];
    const last = page[page.length - 1];
    return {
      rows: page,
      next_cursor: rows.length > opts.limit && last ? encodeCursor(last.execution_timestamp, last.execution_id) : null,
    };
  }

  /** Every execution of a case (verdict + run + time only), oldest first -- the input for a
   * case's whole-history stats, independent of which history page is being shown. */
  async getCaseVerdictTimeline(testCaseId: string): Promise<CaseVerdictTimelineRow[]> {
    return await this.db
      .selectFrom('executions as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .select(['e.build_id as run_id', 'e.verdict as verdict', 'e.execution_timestamp as execution_timestamp'])
      .where('tpc.test_case_id', '=', testCaseId)
      .orderBy('e.execution_timestamp', 'asc')
      .orderBy('e.created_at', 'asc')
      .execute();
  }

  /** Latest execution time per test case in a project, in any plan/run. Cases never
   * executed are simply absent. */
  async getLastExecutedAtByCase(projectId: string): Promise<Map<string, string>> {
    const rows = await this.db
      .selectFrom('executions as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select((eb) => ['tpc.test_case_id as test_case_id', eb.fn.max('e.execution_timestamp').as('last_executed_at')])
      .where('tc.project_id', '=', projectId)
      .groupBy('tpc.test_case_id')
      .execute();
    return new Map(rows.map((r) => [r.test_case_id, String(r.last_executed_at)]));
  }

  /** Results recorded per day (UTC, from execution_timestamp) and source in a project,
   * since `sinceIso`. */
  async getActivity(projectId: string, sinceIso: string): Promise<ActivityRow[]> {
    const day = sql<string>`left(${sql.ref('e.execution_timestamp')}, 10)`;
    const rows = await this.db
      .selectFrom('executions as e')
      .innerJoin('builds as b', 'b.id', 'e.build_id')
      .innerJoin('test_plans as p', 'p.id', 'b.test_plan_id')
      .select((eb) => [day.as('day'), 'e.source as source', eb.fn.count<number>('e.id').as('count')])
      .where('p.project_id', '=', projectId)
      .where('e.execution_timestamp', '>=', sinceIso)
      .groupBy([day, 'e.source'])
      .orderBy('day', 'asc')
      .execute();
    return rows.map((r) => ({ day: r.day, source: r.source, count: Number(r.count) }));
  }

  async createBatch(inputs: CreateExecutionInput[]): Promise<ExecutionWithSteps[]> {
    if (inputs.length === 0) return [];

    const now = new Date().toISOString();
    const executionRows: NewExecution[] = [];
    const allStepRows: NewExecutionStep[] = [];
    const executionIds: string[] = [];

    for (const input of inputs) {
      const id = input.id || uuidv7();
      executionIds.push(id);
      const snapshotStr =
        typeof input.custom_fields_snapshot === 'object'
          ? JSON.stringify(input.custom_fields_snapshot)
          : input.custom_fields_snapshot || '{}';

      const executionRow: NewExecution = {
        id,
        build_id: input.build_id,
        test_plan_case_id: input.test_plan_case_id,
        tester_id: input.tester_id,
        status: input.status ?? 'COMPLETED',
        verdict: input.verdict,
        execution_duration_ms: input.execution_duration_ms ?? null,
        notes: input.notes ?? null,
        custom_fields_snapshot: snapshotStr,
        failure_message: input.failure_message ?? null,
        stack_trace: input.stack_trace ?? null,
        environment: jsonOrNull(input.environment),
        runner: jsonOrNull(input.runner),
        source: input.source ?? null,
        execution_timestamp: input.execution_timestamp ?? now,
        created_at: now,
        updated_at: now,
      };

      const stepRows: NewExecutionStep[] = (input.steps ?? []).map((step) => ({
        id: step.id || uuidv7(),
        execution_id: id,
        test_step_id: step.test_step_id,
        step_number: step.step_number,
        verdict: step.verdict,
        actual_result: step.actual_result ?? null,
        created_at: now,
      }));

      executionRows.push(executionRow);
      allStepRows.push(...stepRows);
    }

    await this.db.transaction().execute(async (trx) => {
      const BATCH_SIZE = 500;
      for (let i = 0; i < executionRows.length; i += BATCH_SIZE) {
        const chunk = executionRows.slice(i, i + BATCH_SIZE);
        await trx.insertInto('executions').values(chunk).execute();
      }

      for (let i = 0; i < allStepRows.length; i += BATCH_SIZE) {
        const chunk = allStepRows.slice(i, i + BATCH_SIZE);
        await trx.insertInto('execution_steps').values(chunk).execute();
      }
    });

    const results: ExecutionWithSteps[] = [];
    for (const id of executionIds) {
      const exec = await this.findById(id);
      if (exec) results.push(exec);
    }

    return results;
  }
}
