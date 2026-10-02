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
  assigned_user_id?: string | null;
  position?: number;
  custom_fields_snapshot?: Record<string, any> | string;
}

export interface BulkAddCaseEntry {
  test_case_id: string;
  test_case_version_id: string;
  position?: number;
}

export type DeleteTestPlanResult =
  | { deleted: true }
  | { deleted: false; blockedBuildCount: number; blockedCaseLinkCount: number; blockedExecutionCount: number };

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
    const snapshotStr =
      typeof input.custom_fields_snapshot === 'object'
        ? JSON.stringify(input.custom_fields_snapshot)
        : input.custom_fields_snapshot || '{}';

    const planCase: NewTestPlanCase = {
      id,
      test_plan_id: input.test_plan_id,
      test_case_id: input.test_case_id,
      test_case_version_id: input.test_case_version_id,
      assigned_user_id: input.assigned_user_id ?? null,
      position: input.position ?? 0,
      custom_fields_snapshot: snapshotStr,
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
        assigned_user_id: null,
        position: e.position ?? 0,
        custom_fields_snapshot: '{}',
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
   * Delete many test_plan_cases rows (by test_case_id) in one call.
   */
  async removeCasesBulk(testPlanId: string, testCaseIds: string[]): Promise<number> {
    if (testCaseIds.length === 0) return 0;

    const result = await this.db
      .deleteFrom('test_plan_cases')
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', 'in', testCaseIds)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n);
  }

  async removeCase(testPlanId: string, testCaseId: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_plan_cases')
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', '=', testCaseId)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  async getPinnedCases(testPlanId: string): Promise<TestPlanCase[]> {
    return await this.db
      .selectFrom('test_plan_cases')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .orderBy('position', 'asc')
      .execute();
  }

  async getPinnedCase(testPlanId: string, testCaseId: string): Promise<TestPlanCase | undefined> {
    return await this.db
      .selectFrom('test_plan_cases')
      .selectAll()
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', '=', testCaseId)
      .executeTakeFirst();
  }

  /**
   * Moves every ACTIVE plan that contains `testCaseId` onto `newTestCaseVersionId` -- called
   * when a version is approved, so Execute mode always shows the case's last approved
   * version. LOCKED/ARCHIVED plans keep whatever version they had (a frozen plan must not
   * change underneath its recorded results). Existing executions are untouched: they
   * reference the plan-case row and the old version's steps, which are never deleted.
   * Returns the number of plans re-pinned.
   */
  async repinCaseInActivePlans(testCaseId: string, newTestCaseVersionId: string): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.db
      .updateTable('test_plan_cases')
      .set({ test_case_version_id: newTestCaseVersionId, updated_at: now })
      .where('test_case_id', '=', testCaseId)
      .where('test_case_version_id', '!=', newTestCaseVersionId)
      .where('test_plan_id', 'in', (eb) =>
        eb.selectFrom('test_plans').select('id').where('status', '=', 'ACTIVE')
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  async updateCaseVersionPin(
    testPlanId: string,
    testCaseId: string,
    newTestCaseVersionId: string
  ): Promise<TestPlanCase | undefined> {
    const now = new Date().toISOString();
    await this.db
      .updateTable('test_plan_cases')
      .set({
        test_case_version_id: newTestCaseVersionId,
        updated_at: now,
      })
      .where('test_plan_id', '=', testPlanId)
      .where('test_case_id', '=', testCaseId)
      .execute();

    return this.getPinnedCase(testPlanId, testCaseId);
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
   * purely on the DB's ON DELETE RESTRICT FKs on builds.test_plan_id and
   * test_plan_cases.test_plan_id), this checks usage first and, without `force`, leaves
   * everything untouched and reports the blocking counts -- the same warn-then-confirm shape
   * as TestSuiteRepository.deleteWithForce/TestCaseRepository.deleteWithForce. With `force`
   * (or an already-empty plan), it deletes every execution under this plan's builds (their
   * execution_steps cascade away automatically), then the builds themselves, then the plan's
   * test_plan_cases links, then the plan. Executions must go before builds since
   * executions.build_id is ON DELETE RESTRICT, and builds/plan-case-links must both go before
   * the plan itself for the same reason.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteTestPlanResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { deleted: false, blockedBuildCount: 0, blockedCaseLinkCount: 0, blockedExecutionCount: 0 };
    }

    const builds = await this.db.selectFrom('builds').select('id').where('test_plan_id', '=', id).execute();
    const buildIds = builds.map((b) => b.id);

    let blockedExecutionCount = 0;
    if (buildIds.length > 0) {
      const execRows = await this.db.selectFrom('executions').select('id').where('build_id', 'in', buildIds).execute();
      blockedExecutionCount = execRows.length;
    }
    const blockedBuildCount = buildIds.length;

    const planCases = await this.db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', id).execute();
    const blockedCaseLinkCount = planCases.length;

    if ((blockedBuildCount > 0 || blockedCaseLinkCount > 0) && !opts.force) {
      return { deleted: false, blockedBuildCount, blockedCaseLinkCount, blockedExecutionCount };
    }

    await this.db.transaction().execute(async (trx) => {
      if (buildIds.length > 0) {
        await trx.deleteFrom('executions').where('build_id', 'in', buildIds).execute();
        await trx.deleteFrom('builds').where('id', 'in', buildIds).execute();
      }
      await trx.deleteFrom('test_plan_cases').where('test_plan_id', '=', id).execute();
      await trx.deleteFrom('test_plans').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
