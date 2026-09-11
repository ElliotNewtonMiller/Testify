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
