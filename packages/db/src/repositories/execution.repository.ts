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
  execution_timestamp?: string;
  steps?: CreateExecutionStepInput[];
}

export interface ExecutionWithSteps extends Execution {
  steps: ExecutionStep[];
}

/** One row per (build, test_plan_case) pair -- the shared "latest execution" building
 * block for the reporting feature's verdict-breakdown and trend reports. `verdict: null`
 * (and every other execution field null) means the case has no execution recorded in
 * that build yet (UNTESTED), not that the row is missing. */
export interface LatestExecutionRow {
  build_id: string;
  plan_case_id: string;
  test_case_id: string;
  execution_id: string | null;
  verdict: string | null;
  execution_duration_ms: number | null;
  execution_timestamp: string | null;
}

export interface AverageDurationRow {
  plan_case_id: string;
  test_case_id: string;
  avg_duration_ms: number;
  sample_count: number;
}

/** Verdict-volatility building block for the flakiest-tests report -- see
 * packages/core/src/reporting/flakiness.ts for how this is turned into a ranked,
 * thresholded result. */
export interface FlakinessRow {
  plan_case_id: string;
  test_case_id: string;
  total_executions: number;
  verdict_changes: number;
}

export type VerdictVolatilityScope = { type: 'BUILD'; buildId: string } | { type: 'PLAN'; planId: string };

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
   * For every test_plan_case in `planId`, its latest execution (by execution_timestamp
   * desc, created_at desc tie-break) within each of `buildIds` -- one row per (build,
   * plan_case) pair, with UNTESTED (all-null) rows for cases with no execution yet in
   * that build. Built for the reporting feature's verdict-breakdown (buildIds = [one id])
   * and trend-across-builds (buildIds = last N builds) reports -- deliberately does not
   * call the single-row getLatestExecutionForPlanCase() in a loop for either; `buildIds`
   * is always small (bounded by the caller's own `limit`), so one small query per build
   * (each using a ROW_NUMBER() window function, verified to compile and run correctly
   * against this repo's PGlite via Kysely's query builder) is simpler and more legible
   * than one raw-SQL cross-join across every build at once.
   */
  async getLatestExecutionsForPlanAcrossBuilds(planId: string, buildIds: string[]): Promise<LatestExecutionRow[]> {
    if (buildIds.length === 0) return [];

    const planCases = await this.db
      .selectFrom('test_plan_cases')
      .select(['id as plan_case_id', 'test_case_id'])
      .where('test_plan_id', '=', planId)
      .execute();

    const results: LatestExecutionRow[] = [];

    for (const buildId of buildIds) {
      const ranked = await this.db
        .with('ranked', (db) =>
          db
            .selectFrom('executions')
            .select((eb) => [
              'id',
              'test_plan_case_id',
              'verdict',
              'execution_duration_ms',
              'execution_timestamp',
              eb.fn
                .agg<number>('row_number')
                .over((ob) => ob.partitionBy('test_plan_case_id').orderBy('execution_timestamp', 'desc').orderBy('created_at', 'desc'))
                .as('rn'),
            ])
            .where('build_id', '=', buildId)
        )
        .selectFrom('ranked')
        .selectAll()
        .where('rn', '=', 1)
        .execute();

      const latestByPlanCase = new Map(ranked.map((r) => [r.test_plan_case_id, r]));

      for (const pc of planCases) {
        const latest = latestByPlanCase.get(pc.plan_case_id);
        results.push({
          build_id: buildId,
          plan_case_id: pc.plan_case_id,
          test_case_id: pc.test_case_id,
          execution_id: latest?.id ?? null,
          verdict: latest?.verdict ?? null,
          execution_duration_ms: latest?.execution_duration_ms ?? null,
          execution_timestamp: latest?.execution_timestamp ?? null,
        });
      }
    }

    return results;
  }

  /** Average execution_duration_ms per test_plan_case across every execution recorded
   * under `planId` (all builds), excluding executions with no measured duration --
   * fabricated/default durations must never be able to skew this, which is exactly why
   * execution_duration_ms is nullable with no default (see the migration/routes that
   * write it). Plain aggregate, no window function needed. */
  async getAverageDurationByPlanCase(planId: string): Promise<AverageDurationRow[]> {
    const rows = await this.db
      .selectFrom('executions as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .select((eb) => [
        'tpc.id as plan_case_id',
        'tpc.test_case_id as test_case_id',
        eb.fn.avg<number>('e.execution_duration_ms').as('avg_duration_ms'),
        eb.fn.count<number>('e.id').as('sample_count'),
      ])
      .where('tpc.test_plan_id', '=', planId)
      .where('e.execution_duration_ms', 'is not', null)
      .groupBy(['tpc.id', 'tpc.test_case_id'])
      .execute();

    return rows.map((r) => ({
      plan_case_id: r.plan_case_id,
      test_case_id: r.test_case_id,
      avg_duration_ms: Number(r.avg_duration_ms),
      sample_count: Number(r.sample_count),
    }));
  }

  /** Verdict-volatility per test_plan_case, scoped either to one build's repeated
   * re-runs or a whole plan's execution history. Uses LAG(verdict) OVER (PARTITION BY
   * test_plan_case_id ORDER BY execution_timestamp) in a CTE (verified against this
   * repo's PGlite), then counts how many consecutive-execution verdict changes occurred
   * per case. The raw `sql` CASE WHEN fragment (comparing a row's verdict to its LAG) is
   * the one narrow, justified use of the raw-SQL escape hatch here -- everything else is
   * plain Kysely, matching this file's other new aggregate methods. */
  async getVerdictVolatility(scope: VerdictVolatilityScope): Promise<FlakinessRow[]> {
    const withChanges = await this.db
      .with('with_prev', (db) => {
        let base = db
          .selectFrom('executions as e')
          .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
          .select((eb) => [
            'tpc.id as plan_case_id',
            'tpc.test_case_id as test_case_id',
            'e.verdict as verdict',
            eb.fn
              .agg<string | null>('lag', ['e.verdict'])
              .over((ob) => ob.partitionBy('e.test_plan_case_id').orderBy('e.execution_timestamp', 'asc'))
              .as('prev_verdict'),
          ]);
        base = scope.type === 'BUILD' ? base.where('e.build_id', '=', scope.buildId) : base.where('tpc.test_plan_id', '=', scope.planId);
        return base;
      })
      .selectFrom('with_prev')
      .select((eb) => [
        'plan_case_id',
        'test_case_id',
        eb.fn.count<number>('plan_case_id').as('total_executions'),
        eb.fn
          .sum<number>(sql<number>`case when "prev_verdict" is not null and "prev_verdict" != "verdict" then 1 else 0 end`)
          .as('verdict_changes'),
      ])
      .groupBy(['plan_case_id', 'test_case_id'])
      .execute();

    return withChanges.map((r) => ({
      plan_case_id: r.plan_case_id,
      test_case_id: r.test_case_id,
      total_executions: Number(r.total_executions),
      verdict_changes: Number(r.verdict_changes),
    }));
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
