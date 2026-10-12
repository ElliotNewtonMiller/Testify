import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestPlansTable, TestPlanCasesTable } from '../types.js';

export type TestPlan = Selectable<TestPlansTable>;
export type NewTestPlan = Insertable<TestPlansTable>;
export type TestPlanUpdate = Updateable<TestPlansTable>;

export type TestPlanCase = Selectable<TestPlanCasesTable>;
export type NewTestPlanCase = Insertable<TestPlanCasesTable>;
export type TestPlanCaseUpdate = Updateable<TestPlanCasesTable>;

export interface CreateTestPlanInput {
  id?: string;
  project_id: string;
  name: string;
  description?: string | null;
  status?: 'ACTIVE' | 'LOCKED' | 'ARCHIVED';
}

export interface UpdateTestPlanInput {
  name?: string;
  description?: string | null;
  status?: 'ACTIVE' | 'LOCKED' | 'ARCHIVED';
}

export interface AddCaseToPlanInput {
  id?: string;
  test_plan_id: string;
  test_case_id: string;
  test_case_version_id: string;
  position?: number;
}

export interface BulkAddCaseEntry {
  test_case_id: string;
  test_case_version_id: string;
  position?: number;
}

export type DeleteTestPlanResult =
  | { deleted: true }
  | { deleted: false; blockedRunCount: number; blockedCaseLinkCount: number; blockedResultCount: number };

export class TestPlanRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateTestPlanInput): Promise<TestPlan> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    const testPlan: NewTestPlan = {
      id,
      project_id: input.project_id,
      name: input.name,
      description: input.description ?? null,
      status: input.status ?? 'ACTIVE',
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_plans').values(testPlan).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<TestPlan | undefined> {
    return await this.db
      .selectFrom('test_plans')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByProject(projectId: string): Promise<TestPlan[]> {
    return await this.db
      .selectFrom('test_plans')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('name', 'asc')
      .execute();
  }

  async updateStatus(
    id: string,
    status: 'ACTIVE' | 'LOCKED' | 'ARCHIVED'
  ): Promise<TestPlan | undefined> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('test_plans')
      .set({ status, updated_at: now })
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async update(id: string, input: UpdateTestPlanInput): Promise<TestPlan | undefined> {
    const now = new Date().toISOString();
    const updateData: TestPlanUpdate = {
      updated_at: now,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.status !== undefined) updateData.status = input.status;

    await this.db
      .updateTable('test_plans')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async addCase(input: AddCaseToPlanInput): Promise<TestPlanCase> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const planCase: NewTestPlanCase = {
      id,
      test_plan_id: input.test_plan_id,
      test_case_id: input.test_case_id,
      test_case_version_id: input.test_case_version_id,
      position: input.position ?? 0,
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_plan_cases').values(planCase).execute();
    return (await this.getPinnedCase(input.test_plan_id, input.test_case_id))!;
  }

  /**
   * Insert many test_plan_cases rows in one call (e.g. a suite cascade toggle).
   * Skips entries that are already pinned to this plan (idempotent, like addCase).
   */
  async addCasesBulk(testPlanId: string, entries: BulkAddCaseEntry[]): Promise<TestPlanCase[]> {
    if (entries.length === 0) return [];

    const existing = await this.getPinnedCases(testPlanId);
    const existingCaseIds = new Set(existing.map((pc) => pc.test_case_id));
    const toInsert = entries.filter((e) => !existingCaseIds.has(e.test_case_id));

    if (toInsert.length > 0) {
      const now = new Date().toISOString();
      const rows: NewTestPlanCase[] = toInsert.map((e) => ({
        id: uuidv7(),
        test_plan_id: testPlanId,
        test_case_id: e.test_case_id,
        test_case_version_id: e.test_case_version_id,
        position: e.position ?? 0,
        created_at: now,
        updated_at: now,
      }));

      await this.db.insertInto('test_plan_cases').values(rows).execute();
    }

    const allCaseIds = new Set(entries.map((e) => e.test_case_id));
    const updated = await this.getPinnedCases(testPlanId);
    return updated.filter((pc) => allCaseIds.has(pc.test_case_id));
  }

  /**
   * Removes cases from a plan. A case with no results is simply unlinked. A case that has
   * results is **retired** instead: its link gets removed_at/removed_by and stays, so its
   * results keep showing in the runs that recorded them while it's gone from the plan and
   * every future run. Without `force`, if any of the cases has results nothing changes and
   * the counts come back so the caller can ask for confirmation.
   */
  async removeCases(
    testPlanId: string,
    testCaseIds: string[],
    actorId: string,
    opts: { force?: boolean } = {}
  ): Promise<
    | { blocked: true; cases_with_results: number; result_count: number; run_count: number }
    | { blocked: false; removed: number; retired: number }
  > {
    if (testCaseIds.length === 0) return { blocked: false, removed: 0, retired: 0 };
    const links = await this.db
      .selectFrom('test_plan_cases')
      .select(['id', 'test_case_id'])
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', 'in', testCaseIds)
      .where('removed_at', 'is', null)
      .execute();
    if (links.length === 0) return { blocked: false, removed: 0, retired: 0 };

    const usage = await this.db
      .selectFrom('test_results')
      .select((eb) => ['test_plan_case_id', eb.fn.countAll<number>().as('results')])
      .where('test_plan_case_id', 'in', links.map((l) => l.id))
      .groupBy('test_plan_case_id')
      .execute();
    const executedIds = new Set(usage.map((u) => u.test_plan_case_id));

    if (executedIds.size > 0 && !opts.force) {
      return {
        blocked: true,
        cases_with_results: executedIds.size,
        result_count: usage.reduce((n, u) => n + Number(u.results), 0),
        run_count: await this.distinctRunCount([...executedIds]),
      };
    }

    const now = new Date().toISOString();
    const toDelete = links.filter((l) => !executedIds.has(l.id)).map((l) => l.id);
    const toRetire = links.filter((l) => executedIds.has(l.id)).map((l) => l.id);
    if (toDelete.length) await this.db.deleteFrom('test_plan_cases').where('id', 'in', toDelete).execute();
    if (toRetire.length) {
      await this.db.updateTable('test_plan_cases').set({ removed_at: now, removed_by: actorId, updated_at: now }).where('id', 'in', toRetire).execute();
    }
    return { blocked: false, removed: toDelete.length, retired: toRetire.length };
  }

  private async distinctRunCount(planCaseIds: string[]): Promise<number> {
    const row = await this.db
      .selectFrom('test_results')
      .select((eb) => eb.fn.count<number>('test_run_id').distinct().as('n'))
      .where('test_plan_case_id', 'in', planCaseIds)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /** The plan's current cases (active links only -- retired links are history). */
  async getPinnedCases(testPlanId: string): Promise<TestPlanCase[]> {
    return await this.db
      .selectFrom('test_plan_cases')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .where('removed_at', 'is', null)
      .orderBy('position', 'asc')
      .execute();
  }

  async getPinnedCase(testPlanId: string, testCaseId: string): Promise<TestPlanCase | undefined> {
    return await this.db
      .selectFrom('test_plan_cases')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', '=', testCaseId)
      .where('removed_at', 'is', null)
      .executeTakeFirst();
  }

  /**
   * Moves every ACTIVE plan that contains `testCaseId` onto `newTestCaseVersionId` -- called
   * when a version is approved, so Execute mode always shows the case's last approved
   * version. LOCKED/ARCHIVED plans keep whatever version they had (a frozen plan must not
   * change underneath its recorded results). Existing results are untouched: they
   * reference the plan-case row and the old version's steps, which are never deleted.
   * Returns the number of plans re-pinned.
   */
  async repinCaseInActivePlans(testCaseId: string, newTestCaseVersionId: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db
      .updateTable('test_plan_cases')
      .set({ test_case_version_id: newTestCaseVersionId, updated_at: now })
      .where('test_case_id', '=', testCaseId)
      .where('removed_at', 'is', null) // a retired link keeps the version its results were recorded against
      .where('test_case_version_id', '!=', newTestCaseVersionId)
      .where('test_plan_id', 'in', (eb) =>
        eb.selectFrom('test_plans').select('id').where('status', '=', 'ACTIVE')
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_plans')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Deletes a plan and everything under it. Unlike the plain `delete()` above (which relies
   * purely on the DB's ON DELETE RESTRICT FKs on test_runs.test_plan_id and
   * test_plan_cases.test_plan_id), this checks usage first and, without `force`, leaves
   * everything untouched and reports the blocking counts -- the same warn-then-confirm shape
   * as TestSuiteRepository.deleteWithForce/TestCaseRepository.deleteWithForce. With `force`
   * (or an already-empty plan), it deletes every result under this plan's runs (their
   * test_step_results cascade away automatically), then the runs themselves, then the plan's
   * test_plan_cases links, then the plan. Results must go before runs since
   * test_results.test_run_id is ON DELETE RESTRICT, and runs/plan-case-links must both go before
   * the plan itself for the same reason.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteTestPlanResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { deleted: false, blockedRunCount: 0, blockedCaseLinkCount: 0, blockedResultCount: 0 };
    }

    const runs = await this.db.selectFrom('test_runs').select('id').where('test_plan_id', '=', id).execute();
    const runIds = runs.map((r) => r.id);

    let blockedResultCount = 0;
    if (runIds.length > 0) {
      const execRows = await this.db.selectFrom('test_results').select('id').where('test_run_id', 'in', runIds).execute();
      blockedResultCount = execRows.length;
    }
    const blockedRunCount = runIds.length;

    const planCases = await this.db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', id).execute();
    const blockedCaseLinkCount = planCases.length;

    if ((blockedRunCount > 0 || blockedCaseLinkCount > 0) && !opts.force) {
      return { deleted: false, blockedRunCount, blockedCaseLinkCount, blockedResultCount };
    }

    await this.db.transaction().execute(async (trx) => {
      if (runIds.length > 0) {
        await trx.deleteFrom('test_results').where('test_run_id', 'in', runIds).execute();
        await trx.deleteFrom('test_runs').where('id', 'in', runIds).execute();
      }
      await trx.deleteFrom('test_plan_cases').where('test_plan_id', '=', id).execute();
      await trx.deleteFrom('test_plans').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
