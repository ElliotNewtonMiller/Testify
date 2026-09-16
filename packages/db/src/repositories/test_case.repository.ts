import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestCasesTable } from '../types.js';

export type TestCase = Selectable<TestCasesTable>;
export type NewTestCase = Insertable<TestCasesTable>;
export type TestCaseUpdate = Updateable<TestCasesTable>;

export interface CreateTestCaseInput {
  id?: string;
  project_id: string;
  test_suite_id: string;
  external_id: string;
  title: string;
  priority?: string;
  execution_type?: string;
}

export interface UpdateTestCaseInput {
  test_suite_id?: string;
  title?: string;
  priority?: string;
  execution_type?: string;
}

export interface TestCaseLatestVersionSummary {
  id: string;
  version_number: number;
  status: string;
  summary: string | null;
  preconditions: string | null;
}

export interface TestCaseWithLatestVersion extends TestCase {
  latest_version: TestCaseLatestVersionSummary | null;
}

export class TestCaseRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateTestCaseInput): Promise<TestCase> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    const testCase: NewTestCase = {
      id,
      project_id: input.project_id,
      test_suite_id: input.test_suite_id,
      external_id: input.external_id,
      title: input.title,
      priority: input.priority ?? 'HIGH',
      execution_type: input.execution_type ?? 'MANUAL',
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_cases').values(testCase).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<TestCase | undefined> {
    return await this.db
      .selectFrom('test_cases')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByExternalId(projectId: string, externalId: string): Promise<TestCase | undefined> {
    return await this.db
      .selectFrom('test_cases')
      .selectAll()
      .where('project_id', '=', projectId)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
  }

  async findBySuite(testSuiteId: string): Promise<TestCase[]> {
    return await this.db
      .selectFrom('test_cases')
      .selectAll()
      .where('test_suite_id', '=', testSuiteId)
      .orderBy('external_id', 'asc')
      .execute();
  }

  async findByProject(projectId: string): Promise<TestCase[]> {
    return await this.db
      .selectFrom('test_cases')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('external_id', 'asc')
      .execute();
  }

  async findBySuiteIds(testSuiteIds: string[]): Promise<TestCase[]> {
    if (testSuiteIds.length === 0) return [];

    return await this.db
      .selectFrom('test_cases')
      .selectAll()
      .where('test_suite_id', 'in', testSuiteIds)
      .orderBy('external_id', 'asc')
      .execute();
  }

  /**
   * All cases in a project, each paired with its latest version's summary status.
   * Fetches versions for the whole project in one query (not per-case) to avoid N+1.
   */
  async findByProjectWithLatestVersion(projectId: string): Promise<TestCaseWithLatestVersion[]> {
    const cases = await this.findByProject(projectId);
    if (cases.length === 0) return [];

    const caseIds = cases.map((c) => c.id);
    const versions = await this.db
      .selectFrom('test_case_versions')
      .select(['id', 'test_case_id', 'version_number', 'status', 'summary', 'preconditions'])
      .where('test_case_id', 'in', caseIds)
      .orderBy('version_number', 'desc')
      .execute();

    const latestByCase = new Map<string, (typeof versions)[number]>();
    for (const v of versions) {
      if (!latestByCase.has(v.test_case_id)) {
        latestByCase.set(v.test_case_id, v);
      }
    }

    return cases.map((c) => {
      const v = latestByCase.get(c.id);
      return {
        ...c,
        latest_version: v
          ? {
              id: v.id,
              version_number: v.version_number,
              status: v.status,
              summary: v.summary,
              preconditions: v.preconditions,
            }
          : null,
      };
    });
  }

  async update(id: string, input: UpdateTestCaseInput): Promise<TestCase | undefined> {
    const now = new Date().toISOString();
    const updateData: TestCaseUpdate = {
      updated_at: now,
    };

    if (input.test_suite_id !== undefined) updateData.test_suite_id = input.test_suite_id;
    if (input.title !== undefined) updateData.title = input.title;
    if (input.priority !== undefined) updateData.priority = input.priority;
    if (input.execution_type !== undefined) updateData.execution_type = input.execution_type;

    await this.db
      .updateTable('test_cases')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_cases')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }
}
