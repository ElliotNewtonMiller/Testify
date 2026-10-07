import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, BuildsTable } from '../types.js';

export type Build = Selectable<BuildsTable>;
export type NewBuild = Insertable<BuildsTable>;
export type BuildUpdate = Updateable<BuildsTable>;

export interface CreateBuildInput {
  id?: string;
  test_plan_id: string;
  name: string;
  description?: string | null;
  status?: 'OPEN' | 'CLOSED';
  release_date?: string | null;
}

export interface UpdateBuildInput {
  name?: string;
  description?: string | null;
  status?: 'OPEN' | 'CLOSED';
  release_date?: string | null;
}

export type DeleteBuildResult =
  | { deleted: true }
  | { deleted: false; blockedExecutionCount: number };

export class BuildRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateBuildInput): Promise<Build> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    const build: NewBuild = {
      id,
      test_plan_id: input.test_plan_id,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'OPEN',
      release_date: input.release_date ?? null,
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('builds').values(build).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<Build | undefined> {
    return await this.db
      .selectFrom('builds')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByTestPlan(testPlanId: string): Promise<Build[]> {
    return await this.db
      .selectFrom('builds')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async updateStatus(id: string, status: 'OPEN' | 'CLOSED'): Promise<Build | undefined> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('builds')
      .set({ status, updated_at: now })
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  /**
   * Closes the build if every case in its plan now has at least one recorded execution in
   * it ("all test cases have results"). Returns true only when this call closed it -- false
   * if it was already CLOSED, the plan has no cases, or some case is still untested.
   */
  async closeIfComplete(id: string): Promise<boolean> {
    const build = await this.findById(id);
    if (!build || build.status === 'CLOSED') return false;

    const total = await this.db
      .selectFrom('test_plan_cases')
      .select((eb) => eb.fn.countAll().as('n'))
      .where('test_plan_id', '=', build.test_plan_id)
      .where('removed_at', 'is', null) // cases removed from the plan never hold a run open
      .executeTakeFirst();
    const totalCases = Number(total?.n ?? 0);
    if (totalCases === 0) return false;

    const covered = await this.db
      .selectFrom('executions')
      .innerJoin('test_plan_cases', 'test_plan_cases.id', 'executions.test_plan_case_id')
      .select((eb) => eb.fn.count('executions.test_plan_case_id').distinct().as('n'))
      .where('executions.build_id', '=', id)
      .where('test_plan_cases.test_plan_id', '=', build.test_plan_id)
      .where('test_plan_cases.removed_at', 'is', null)
      .executeTakeFirst();
    if (Number(covered?.n ?? 0) < totalCases) return false;

    await this.updateStatus(id, 'CLOSED');
    return true;
  }

  async update(id: string, input: UpdateBuildInput): Promise<Build | undefined> {
    const now = new Date().toISOString();
    const updateData: BuildUpdate = {
      updated_at: now,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.status !== undefined) updateData.status = input.status;
    if (input.release_date !== undefined) updateData.release_date = input.release_date;

    await this.db
      .updateTable('builds')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('builds')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Deletes a build and its recorded executions. Unlike the plain `delete()` above (which
   * relies purely on the DB's ON DELETE RESTRICT FK on executions.build_id), this checks
   * usage first and, without `force`, leaves everything untouched and reports the blocked
   * execution count -- the same warn-then-confirm shape as
   * TestPlanRepository/TestSuiteRepository/TestCaseRepository's deleteWithForce. With `force`
   * (or a build with zero executions), it deletes every execution under this build (their
   * execution_steps cascade away automatically) before deleting the build itself.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteBuildResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { deleted: false, blockedExecutionCount: 0 };
    }

    const execRows = await this.db.selectFrom('executions').select('id').where('build_id', '=', id).execute();
    const blockedExecutionCount = execRows.length;

    if (blockedExecutionCount > 0 && !opts.force) {
      return { deleted: false, blockedExecutionCount };
    }

    await this.db.transaction().execute(async (trx) => {
      if (blockedExecutionCount > 0) {
        await trx.deleteFrom('executions').where('build_id', '=', id).execute();
      }
      await trx.deleteFrom('builds').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
