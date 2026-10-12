import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestRunsTable } from '../types.js';

export type TestRun = Selectable<TestRunsTable>;
export type NewTestRun = Insertable<TestRunsTable>;
export type TestRunUpdate = Updateable<TestRunsTable>;

export interface CreateTestRunInput {
  id?: string;
  test_plan_id: string;
  name: string;
  description?: string | null;
  status?: 'OPEN' | 'CLOSED';
  release_date?: string | null;
}

export interface UpdateTestRunInput {
  name?: string;
  description?: string | null;
  status?: 'OPEN' | 'CLOSED';
  release_date?: string | null;
}

export type DeleteTestRunResult =
  | { deleted: true }
  | { deleted: false; blockedResultCount: number };

export class TestRunRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateTestRunInput): Promise<TestRun> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    const run: NewTestRun = {
      id,
      test_plan_id: input.test_plan_id,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'OPEN',
      release_date: input.release_date ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_runs').values(run).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<TestRun | undefined> {
    return await this.db
      .selectFrom('test_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByTestPlan(testPlanId: string): Promise<TestRun[]> {
    return await this.db
      .selectFrom('test_runs')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async updateStatus(id: string, status: 'OPEN' | 'CLOSED'): Promise<TestRun | undefined> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('test_runs')
      .set({ status, updated_at: now })
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  /**
   * Closes the run if every case in its plan now has at least one recorded result in
   * it ("all test cases have results"). Returns true only when this call closed it -- false
   * if it was already CLOSED, the plan has no cases, or some case is still untested.
   */
  async closeIfComplete(id: string): Promise<boolean> {
    const run = await this.findById(id);
    if (!run || run.status === 'CLOSED') return false;

    const total = await this.db
      .selectFrom('test_plan_cases')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('test_plan_id', '=', run.test_plan_id)
      .where('removed_at', 'is', null) // cases removed from the plan never hold a run open
      .executeTakeFirst();
    const totalCases = Number(total?.n ?? 0);
    if (totalCases === 0) return false;

    // Cases in the plan that have a result in this run -- through any of their links, so a
    // case removed and re-added still counts the result its earlier link recorded here.
    const covered = await this.db
      .selectFrom('test_plan_cases as active')
      .select((eb) => eb.fn.count('active.test_case_id').distinct().as('n'))
      .where('active.test_plan_id', '=', run.test_plan_id)
      .where('active.removed_at', 'is', null)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('test_results as e')
            .innerJoin('test_plan_cases as link', 'link.id', 'e.test_plan_case_id')
            .select('e.id')
            .where('e.test_run_id', '=', id)
            .where('link.test_plan_id', '=', run.test_plan_id)
            .whereRef('link.test_case_id', '=', 'active.test_case_id')
        )
      )
      .executeTakeFirst();
    if (Number(covered?.n ?? 0) < totalCases) return false;

    await this.updateStatus(id, 'CLOSED');
    return true;
  }

  async update(id: string, input: UpdateTestRunInput): Promise<TestRun | undefined> {
    const now = new Date().toISOString();
    const updateData: TestRunUpdate = {
      updated_at: now,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.release_date !== undefined) updateData.release_date = input.release_date;

    await this.db
      .updateTable('test_runs')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_runs')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Deletes a run and its recorded results. Unlike the plain `delete()` above (which
   * relies purely on the DB's ON DELETE RESTRICT FK on test_results.test_run_id), this checks
   * usage first and, without `force`, leaves everything untouched and reports the blocked
   * result count -- the same warn-then-confirm shape as
   * TestPlanRepository/TestSuiteRepository/TestCaseRepository's deleteWithForce. With `force`
   * (or a run with zero results), it deletes every result under this run (their
   * test_step_results cascade away automatically) before deleting the run itself.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteTestRunResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { deleted: false, blockedResultCount: 0 };
    }

    const execRows = await this.db.selectFrom('test_results').select('id').where('test_run_id', '=', id).execute();
    const blockedResultCount = execRows.length;

    if (blockedResultCount > 0 && !opts.force) {
      return { deleted: false, blockedResultCount };
    }

    await this.db.transaction().execute(async (trx) => {
      if (blockedResultCount > 0) {
        await trx.deleteFrom('test_results').where('test_run_id', '=', id).execute();
      }
      await trx.deleteFrom('test_runs').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
