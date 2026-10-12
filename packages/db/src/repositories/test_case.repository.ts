import { sql, type Kysely, type Selectable, type Insertable, type Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestCasesTable } from '../types.js';
import { decodeCursor, toPage, type Page } from '../paging.js';

export type TestCase = Selectable<TestCasesTable>;

/** A case in a case list (listPage), with a summary of its latest version. */
export interface CaseListRow extends TestCase {
  latest_version: { id: string; version_number: number; status: string; updated_at: string } | null;
}

/** First key of the advisory lock that serializes external id assignment (second: the project). */
const EXTERNAL_ID_LOCK_NAMESPACE = 0x7e57;
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
  /** Last change to this version -- reports use it for how long a draft has been waiting. */
  updated_at: string;
}

export interface TestCaseWithLatestVersion extends TestCase {
  latest_version: TestCaseLatestVersionSummary | null;
}

export type DeleteTestCaseResult =
  | { deleted: true }
  | { deleted: false; blockedPlanLinkCount: number; blockedResultCount: number };

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
      priority: input.priority ?? 'MEDIUM',
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
      .select(['id', 'test_case_id', 'version_number', 'status', 'summary', 'preconditions', 'updated_at'])
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
              updated_at: v.updated_at,
            }
          : null,
      };
    });
  }

  /**
   * A project's cases, oldest first, a page at a time, each with a summary of its latest version.
   * Filters: readable ids, suites, latest-version status, priority. Keyset paging on (created_at, id).
   */
  async listPage(
    projectId: string,
    filters: { externalIds?: string[]; suiteIds?: string[]; versionStatuses?: string[]; priorities?: string[] },
    page: { limit: number; cursor?: string | null }
  ): Promise<Page<CaseListRow>> {
    const latest = this.db
      .selectFrom('test_case_versions')
      .select(['test_case_id', sql<number>`max(version_number)`.as('vn')])
      .groupBy('test_case_id');
    let query = this.db
      .selectFrom('test_cases as c')
      .leftJoin(latest.as('lv'), 'lv.test_case_id', 'c.id')
      .leftJoin('test_case_versions as v', (j) => j.onRef('v.test_case_id', '=', 'c.id').onRef('v.version_number', '=', 'lv.vn'))
      .selectAll('c')
      .select(['v.id as lv_id', 'v.version_number as lv_number', 'v.status as lv_status', 'v.updated_at as lv_updated_at'])
      .where('c.project_id', '=', projectId);
    if (filters.externalIds?.length) query = query.where('c.external_id', 'in', filters.externalIds);
    if (filters.suiteIds?.length) query = query.where('c.test_suite_id', 'in', filters.suiteIds);
    if (filters.versionStatuses?.length) query = query.where('v.status', 'in', filters.versionStatuses);
    if (filters.priorities?.length) query = query.where('c.priority', 'in', filters.priorities);
    const cursor = decodeCursor(page.cursor);
    if (cursor) {
      query = query.where((eb) => eb.or([eb('c.created_at', '>', cursor.ts), eb.and([eb('c.created_at', '=', cursor.ts), eb('c.id', '>', cursor.id)])]));
    }
    const rows = await query.orderBy('c.created_at', 'asc').orderBy('c.id', 'asc').limit(page.limit + 1).execute();
    const paged = toPage(rows, page.limit, (r) => ({ ts: r.created_at, id: r.id }));
    return {
      next_cursor: paged.next_cursor,
      rows: paged.rows.map(({ lv_id, lv_number, lv_status, lv_updated_at, ...c }) => ({
        ...c,
        latest_version: lv_id ? { id: lv_id, version_number: lv_number as number, status: lv_status as string, updated_at: lv_updated_at as string } : null,
      })),
    };
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

  /** Next sequential `<prefix>-<n>` external_id for a project -- 1-indexed, based on the
   * highest existing numeric suffix among that project's cases already using this prefix.
   * Non-numeric-suffix ids (e.g. from legacy imports) are simply ignored rather than
   * breaking the scan. */
  /**
   * Takes this project's external id lock until the surrounding transaction ends, so that
   * picking the next id (getNextExternalId) and inserting the case can't interleave with
   * another request doing the same -- otherwise two people creating cases at once both got
   * PREFIX-n and one failed on the unique constraint. A Postgres advisory lock, so it holds
   * across server instances too. Must be called inside a transaction (outside one it's
   * released as soon as the statement ends).
   */
  async lockExternalIds(projectId: string): Promise<void> {
    await sql`select pg_advisory_xact_lock(${EXTERNAL_ID_LOCK_NAMESPACE}, hashtext(${projectId}))`.execute(this.db);
  }

  /** The next PREFIX-n after the highest one in the project. Hold lockExternalIds while using it. */
  async getNextExternalId(projectId: string, prefix: string): Promise<string> {
    const rows = await this.db
      .selectFrom('test_cases')
      .select('external_id')
      .where('project_id', '=', projectId)
      .where('external_id', 'like', `${prefix}-%`)
      .execute();

    const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escapedPrefix}-(\\d+)$`);
    let max = 0;
    for (const row of rows) {
      const match = row.external_id.match(pattern);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
    }

    return `${prefix}-${max + 1}`;
  }

  /**
   * Deletes a case. Unlike the plain `delete()` above (which relies purely on the DB's
   * ON DELETE RESTRICT FKs on test_plan_cases/results and would surface a raw
   * constraint-violation error), this checks usage first and, without `force`, leaves
   * everything untouched and reports the blocking counts -- the same warn-then-confirm
   * shape as CustomFieldRepository.deleteDefinition. With `force` (or no usage at all),
   * it cascades: delete every result referencing this case's plan-links (their
   * test_step_results cascade away automatically), then the plan-links themselves, then
   * the case -- whose own versions/steps then cascade cleanly. Results must be deleted
   * before the case's version/step cascade runs, since test_step_results.test_step_id is
   * ON DELETE RESTRICT and would otherwise block it.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteTestCaseResult> {
    const existing = await this.findById(id);
    if (!existing) {
      return { deleted: false, blockedPlanLinkCount: 0, blockedResultCount: 0 };
    }

    const planCases = await this.db
      .selectFrom('test_plan_cases')
      .select('id')
      .where('test_case_id', '=', id)
      .execute();
    const planCaseIds = planCases.map((pc) => pc.id);

    let blockedResultCount = 0;
    if (planCaseIds.length > 0) {
      const execRows = await this.db
        .selectFrom('test_results')
        .select('id')
        .where('test_plan_case_id', 'in', planCaseIds)
        .execute();
      blockedResultCount = execRows.length;
    }
    const blockedPlanLinkCount = planCaseIds.length;

    if ((blockedPlanLinkCount > 0 || blockedResultCount > 0) && !opts.force) {
      return { deleted: false, blockedPlanLinkCount, blockedResultCount };
    }

    await this.db.transaction().execute(async (trx) => {
      if (planCaseIds.length > 0) {
        await trx.deleteFrom('test_results').where('test_plan_case_id', 'in', planCaseIds).execute();
        await trx.deleteFrom('test_plan_cases').where('id', 'in', planCaseIds).execute();
      }
      await trx.deleteFrom('test_cases').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
