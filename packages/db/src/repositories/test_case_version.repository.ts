import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestCaseVersionsTable, TestStepsTable } from '../types.js';

export type TestCaseVersion = Selectable<TestCaseVersionsTable>;
export type NewTestCaseVersion = Insertable<TestCaseVersionsTable>;
export type TestCaseVersionUpdate = Updateable<TestCaseVersionsTable>;

export type TestStep = Selectable<TestStepsTable>;
export type NewTestStep = Insertable<TestStepsTable>;
export type TestStepUpdate = Updateable<TestStepsTable>;

export interface CreateTestStepInput {
  id?: string;
  step_number: number;
  action: string;
  expected_result: string;
  execution_type?: string;
}

export interface CreateTestCaseVersionInput {
  id?: string;
  test_case_id: string;
  version_number: number;
  status?: 'DRAFT' | 'APPROVED' | 'DEPRECATED';
  summary?: string | null;
  preconditions?: string | null;
  author_id: string;
  reviewer_id?: string | null;
  steps?: CreateTestStepInput[];
}

export interface UpdateTestCaseVersionInput {
  status?: 'DRAFT' | 'APPROVED' | 'DEPRECATED';
  summary?: string | null;
  preconditions?: string | null;
  reviewer_id?: string | null;
}

export interface TestCaseVersionWithSteps extends TestCaseVersion {
  steps: TestStep[];
}

export class TestCaseVersionRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateTestCaseVersionInput): Promise<TestCaseVersionWithSteps> {
    const now = new Date().toISOString();
    const versionId = input.id || uuidv7();

    const versionRow: NewTestCaseVersion = {
      id: versionId,
      test_case_id: input.test_case_id,
      version_number: input.version_number,
      status: input.status ?? 'DRAFT',
      summary: input.summary ?? null,
      preconditions: input.preconditions ?? null,
      author_id: input.author_id,
      reviewer_id: input.reviewer_id ?? null,
      created_at: now,
      updated_at: now,
    };

    const stepRows: NewTestStep[] = (input.steps ?? []).map((step) => ({
      id: step.id || uuidv7(),
      test_case_version_id: versionId,
      step_number: step.step_number,
      action: step.action,
      expected_result: step.expected_result,
      execution_type: step.execution_type ?? 'MANUAL',
      created_at: now,
      updated_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('test_case_versions').values(versionRow).execute();
      if (stepRows.length > 0) {
        await trx.insertInto('test_steps').values(stepRows).execute();
      }
    });

    return (await this.findById(versionId))!;
  }

  /** Creates a new DRAFT version copying the latest version's summary/preconditions and
   * steps 1:1 (new step ids, same step_number/action/expected_result) -- the only way to
   * make an APPROVED case's content editable again, since editing in place is blocked
   * once a version is APPROVED. Throws if the case has no versions at all. */
  async createDraftFromLatest(testCaseId: string, authorId: string): Promise<TestCaseVersionWithSteps> {
    const latest = await this.findLatestVersion(testCaseId);
    if (!latest) {
      throw new Error(`NO_EXISTING_VERSION: test case '${testCaseId}' has no versions to draft from`);
    }

    return this.create({
      test_case_id: testCaseId,
      version_number: latest.version_number + 1,
      status: 'DRAFT',
      summary: latest.summary,
      preconditions: latest.preconditions,
      author_id: authorId,
      steps: latest.steps.map((s) => ({
        step_number: s.step_number,
        action: s.action,
        expected_result: s.expected_result,
        execution_type: s.execution_type,
      })),
    });
  }

  /** Updates a DRAFT version's summary/preconditions in place. Kept separate from
   * updateStatus (which only ever touches status/reviewer_id) so the approve
   * transition's validation stays isolated from plain content edits -- callers are
   * responsible for checking status === 'DRAFT' before calling this (see
   * sendCaseVersionLockedError's usage in the route layer). */
  async updateContent(
    id: string,
    input: { summary?: string | null; preconditions?: string | null }
  ): Promise<TestCaseVersionWithSteps | undefined> {
    const now = new Date().toISOString();
    const updateData: TestCaseVersionUpdate = { updated_at: now };
    if (input.summary !== undefined) updateData.summary = input.summary;
    if (input.preconditions !== undefined) updateData.preconditions = input.preconditions;

    await this.db.updateTable('test_case_versions').set(updateData).where('id', '=', id).execute();

    return this.findById(id);
  }

  async findById(id: string): Promise<TestCaseVersionWithSteps | undefined> {
    const version = await this.db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();

    if (!version) return undefined;

    const steps = await this.getSteps(id);
    return {
      ...version,
      steps,
    };
  }

  async findByTestCase(testCaseId: string): Promise<TestCaseVersion[]> {
    return await this.db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('test_case_id', '=', testCaseId)
      .orderBy('version_number', 'asc')
      .execute();
  }

  async findLatestVersion(testCaseId: string): Promise<TestCaseVersionWithSteps | undefined> {
    const version = await this.db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('test_case_id', '=', testCaseId)
      .orderBy('version_number', 'desc')
      .executeTakeFirst();

    if (!version) return undefined;

    const steps = await this.getSteps(version.id);
    return {
      ...version,
      steps,
    };
  }

  async findVersionByNumber(
    testCaseId: string,
    versionNumber: number
  ): Promise<TestCaseVersionWithSteps | undefined> {
    const version = await this.db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('test_case_id', '=', testCaseId)
      .where('version_number', '=', versionNumber)
      .executeTakeFirst();

    if (!version) return undefined;

    const steps = await this.getSteps(version.id);
    return {
      ...version,
      steps,
    };
  }

  /** Batched lookup of version rows by id (metadata only, no steps) -- for scopes (e.g. a
   * Plan's pinned versions) that need a specific, possibly-non-latest set of version ids in
   * one round-trip instead of N findById calls. */
  async findByIds(versionIds: string[]): Promise<TestCaseVersion[]> {
    if (versionIds.length === 0) return [];
    return this.db.selectFrom('test_case_versions').selectAll().where('id', 'in', versionIds).execute();
  }

  /** Batched sibling of getSteps() -- one query for every version's steps instead of one
   * getSteps() call per version. Built for export, which needs steps across every case
   * version in a project/suite/plan scope in a single request. */
  async getStepsForVersions(versionIds: string[]): Promise<Map<string, TestStep[]>> {
    if (versionIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom('test_steps')
      .selectAll()
      .where('test_case_version_id', 'in', versionIds)
      .orderBy('step_number', 'asc')
      .execute();
    const map = new Map<string, TestStep[]>();
    for (const row of rows) {
      const list = map.get(row.test_case_version_id) ?? [];
      list.push(row);
      map.set(row.test_case_version_id, list);
    }
    return map;
  }

  async updateStatus(
    id: string,
    status: 'DRAFT' | 'APPROVED' | 'DEPRECATED',
    reviewerId?: string | null
  ): Promise<TestCaseVersionWithSteps | undefined> {
    const now = new Date().toISOString();
    const updateData: TestCaseVersionUpdate = {
      status,
      updated_at: now,
    };
    if (reviewerId !== undefined) {
      updateData.reviewer_id = reviewerId;
    }

    await this.db
      .updateTable('test_case_versions')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async getSteps(versionId: string): Promise<TestStep[]> {
    return await this.db
      .selectFrom('test_steps')
      .selectAll()
      .where('test_case_version_id', '=', versionId)
      .orderBy('step_number', 'asc')
      .execute();
  }

  async addStep(versionId: string, input: CreateTestStepInput): Promise<TestStep> {
    const now = new Date().toISOString();
    const stepId = input.id || uuidv7();
    const step: NewTestStep = {
      id: stepId,
      test_case_version_id: versionId,
      step_number: input.step_number,
      action: input.action,
      expected_result: input.expected_result,
      execution_type: input.execution_type ?? 'MANUAL',
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_steps').values(step).execute();
    return (await this.db.selectFrom('test_steps').selectAll().where('id', '=', stepId).executeTakeFirst())!;
  }

  async updateSteps(versionId: string, stepsInput: CreateTestStepInput[]): Promise<TestStep[]> {
    const now = new Date().toISOString();
    const newStepRows: NewTestStep[] = stepsInput.map((step) => ({
      id: step.id || uuidv7(),
      test_case_version_id: versionId,
      step_number: step.step_number,
      action: step.action,
      expected_result: step.expected_result,
      execution_type: step.execution_type ?? 'MANUAL',
      created_at: now,
      updated_at: now,
    }));

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('test_steps').where('test_case_version_id', '=', versionId).execute();
      if (newStepRows.length > 0) {
        await trx.insertInto('test_steps').values(newStepRows).execute();
      }
    });

    return this.getSteps(versionId);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_case_versions')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
