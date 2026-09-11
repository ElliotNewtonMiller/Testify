import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
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
      execution_duration_ms: input.execution_duration_ms ?? 0,
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
        execution_duration_ms: input.execution_duration_ms ?? 0,
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
