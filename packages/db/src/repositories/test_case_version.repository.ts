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
  status?: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'DEPRECATED';
  summary?: string | null;
  preconditions?: string | null;
  author_id: string;
  reviewer_id?: string | null;
  steps?: CreateTestStepInput[];
}

export interface UpdateTestCaseVersionInput {
  status?: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'DEPRECATED';
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

  async updateStatus(
    id: string,
    status: 'DRAFT' | 'IN_REVIEW' | 'APPROVED' | 'DEPRECATED',
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
