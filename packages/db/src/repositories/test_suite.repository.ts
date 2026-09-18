import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, TestSuitesTable } from '../types.js';
import type { TestCaseRepository } from './test_case.repository.js';

export type TestSuite = Selectable<TestSuitesTable>;
export type NewTestSuite = Insertable<TestSuitesTable>;
export type TestSuiteUpdate = Updateable<TestSuitesTable>;

export interface CreateTestSuiteInput {
  id?: string;
  project_id: string;
  parent_suite_id?: string | null;
  name: string;
  description?: string | null;
  position?: number;
}

export interface UpdateTestSuiteInput {
  name?: string;
  description?: string | null;
  position?: number;
}

export interface TestSuiteNode extends TestSuite {
  children: TestSuiteNode[];
}

export type DeleteTestSuiteResult =
  | { deleted: true }
  | {
      deleted: false;
      blockedSubSuiteCount: number;
      blockedCaseCount: number;
      blockedPlanLinkCount: number;
      blockedExecutionCount: number;
    };

export class TestSuiteRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * Helper method to calculate materialized path for a new or moved suite.
   */
  static calculatePath(parentPath: string | null, suiteId: string): string {
    if (!parentPath || parentPath === '/') {
      return `/${suiteId}`;
    }
    return `${parentPath}/${suiteId}`;
  }

  async create(input: CreateTestSuiteInput): Promise<TestSuite> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    let path = `/${id}`;
    if (input.parent_suite_id) {
      const parent = await this.findById(input.parent_suite_id);
      if (!parent) {
        throw new Error(`Parent test suite with ID '${input.parent_suite_id}' not found`);
      }
      path = TestSuiteRepository.calculatePath(parent.path, id);
    }

    const suite: NewTestSuite = {
      id,
      project_id: input.project_id,
      parent_suite_id: input.parent_suite_id ?? null,
      name: input.name,
      description: input.description ?? null,
      position: input.position ?? 0,
      path,
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('test_suites').values(suite).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<TestSuite | undefined> {
    return await this.db
      .selectFrom('test_suites')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByProject(projectId: string): Promise<TestSuite[]> {
    return await this.db
      .selectFrom('test_suites')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('position', 'asc')
      .orderBy('name', 'asc')
      .execute();
  }

  async findChildren(parentSuiteId: string | null, projectId?: string): Promise<TestSuite[]> {
    let query = this.db.selectFrom('test_suites').selectAll();

    if (parentSuiteId === null) {
      query = query.where('parent_suite_id', 'is', null);
    } else {
      query = query.where('parent_suite_id', '=', parentSuiteId);
    }

    if (projectId) {
      query = query.where('project_id', '=', projectId);
    }

    return await query.orderBy('position', 'asc').orderBy('name', 'asc').execute();
  }

  async findDescendants(suiteId: string): Promise<TestSuite[]> {
    const target = await this.findById(suiteId);
    if (!target) return [];

    return await this.db
      .selectFrom('test_suites')
      .selectAll()
      .where('path', 'like', `${target.path}/%`)
      .orderBy('path', 'asc')
      .execute();
  }

  /**
   * Recursive tree retrieval helper for a project (or subtree under rootSuiteId).
   */
  async getTree(projectId: string, rootSuiteId?: string | null): Promise<TestSuiteNode[]> {
    let allSuites: TestSuite[];

    if (rootSuiteId) {
      const rootSuite = await this.findById(rootSuiteId);
      if (!rootSuite) return [];
      const descendants = await this.findDescendants(rootSuiteId);
      allSuites = [rootSuite, ...descendants];
    } else {
      allSuites = await this.findByProject(projectId);
    }

    const map = new Map<string, TestSuiteNode>();
    allSuites.forEach((s) => {
      map.set(s.id, { ...s, children: [] });
    });

    const roots: TestSuiteNode[] = [];

    allSuites.forEach((s) => {
      const node = map.get(s.id)!;
      if (rootSuiteId && s.id === rootSuiteId) {
        roots.push(node);
      } else if (!s.parent_suite_id || (rootSuiteId && !map.has(s.parent_suite_id))) {
        roots.push(node);
      } else {
        const parentNode = map.get(s.parent_suite_id);
        if (parentNode) {
          parentNode.children.push(node);
        } else {
          roots.push(node);
        }
      }
    });

    // Helper to sort tree children by position and name
    const sortNodes = (nodes: TestSuiteNode[]) => {
      nodes.sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name);
      });
      nodes.forEach((n) => sortNodes(n.children));
    };

    sortNodes(roots);
    return roots;
  }

  /**
   * Move a suite to a new parent, updating materialized paths for the suite and all its descendants.
   */
  async move(suiteId: string, newParentSuiteId: string | null): Promise<TestSuite> {
    const suite = await this.findById(suiteId);
    if (!suite) {
      throw new Error(`Test suite with ID '${suiteId}' not found`);
    }

    if (suite.parent_suite_id === newParentSuiteId) {
      return suite;
    }

    let newParentPath: string | null = null;
    if (newParentSuiteId) {
      if (newParentSuiteId === suiteId) {
        throw new Error(`Cannot set suite '${suiteId}' as its own parent`);
      }
      const newParent = await this.findById(newParentSuiteId);
      if (!newParent) {
        throw new Error(`New parent test suite '${newParentSuiteId}' not found`);
      }
      // Check for cycle: new parent cannot be a descendant of suite
      if (newParent.path.startsWith(`${suite.path}/`)) {
        throw new Error(`Cannot move suite '${suiteId}' under its own descendant`);
      }
      newParentPath = newParent.path;
    }

    const oldPath = suite.path;
    const newPath = TestSuiteRepository.calculatePath(newParentPath, suiteId);
    const descendants = await this.findDescendants(suiteId);
    const now = new Date().toISOString();

    await this.db.transaction().execute(async (trx) => {
      // Update target suite
      await trx
        .updateTable('test_suites')
        .set({
          parent_suite_id: newParentSuiteId,
          path: newPath,
          updated_at: now,
        })
        .where('id', '=', suiteId)
        .execute();

      // Update descendant paths
      for (const desc of descendants) {
        const descNewPath = newPath + desc.path.substring(oldPath.length);
        await trx
          .updateTable('test_suites')
          .set({
            path: descNewPath,
            updated_at: now,
          })
          .where('id', '=', desc.id)
          .execute();
      }
    });

    return (await this.findById(suiteId))!;
  }

  async update(id: string, input: UpdateTestSuiteInput): Promise<TestSuite | undefined> {
    const now = new Date().toISOString();
    const updateData: TestSuiteUpdate = {
      updated_at: now,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.position !== undefined) updateData.position = input.position;

    await this.db
      .updateTable('test_suites')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('test_suites')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /**
   * Deletes a suite and its whole subtree. Unlike the plain `delete()` above (which
   * relies purely on the DB's ON DELETE RESTRICT FKs on test_suites.parent_suite_id and
   * test_cases.test_suite_id), this checks usage first and, without `force`, leaves
   * everything untouched and reports the blocking counts across the entire subtree --
   * the same warn-then-confirm shape as CustomFieldRepository.deleteDefinition. With
   * `force` (or an already-empty subtree), it force-deletes every case in every
   * descendant suite (via caseRepo.deleteWithForce, which itself handles that case's own
   * plan-link/execution cascade), then deletes descendant suites leaf-to-root (deepest
   * path first, so a child suite is always gone before its parent is deleted), then this
   * suite itself. `caseRepo` is accepted as a parameter rather than imported and
   * instantiated internally, matching how repositories in this codebase are always
   * composed by their callers rather than by each other.
   */
  async deleteWithForce(
    id: string,
    opts: { force?: boolean } = {},
    caseRepo: TestCaseRepository
  ): Promise<DeleteTestSuiteResult> {
    const suite = await this.findById(id);
    if (!suite) {
      return { deleted: false, blockedSubSuiteCount: 0, blockedCaseCount: 0, blockedPlanLinkCount: 0, blockedExecutionCount: 0 };
    }

    const descendants = await this.findDescendants(id);
    const suiteIds = [id, ...descendants.map((d) => d.id)];
    const cases = await caseRepo.findBySuiteIds(suiteIds);

    let blockedPlanLinkCount = 0;
    let blockedExecutionCount = 0;
    for (const c of cases) {
      const planCases = await this.db
        .selectFrom('test_plan_cases')
        .select('id')
        .where('test_case_id', '=', c.id)
        .execute();
      blockedPlanLinkCount += planCases.length;
      if (planCases.length > 0) {
        const planCaseIds = planCases.map((pc) => pc.id);
        const execRows = await this.db
          .selectFrom('executions')
          .select('id')
          .where('test_plan_case_id', 'in', planCaseIds)
          .execute();
        blockedExecutionCount += execRows.length;
      }
    }

    const blockedSubSuiteCount = descendants.length;
    const blockedCaseCount = cases.length;
    const hasContent = blockedSubSuiteCount > 0 || blockedCaseCount > 0;

    if (hasContent && !opts.force) {
      return { deleted: false, blockedSubSuiteCount, blockedCaseCount, blockedPlanLinkCount, blockedExecutionCount };
    }

    for (const c of cases) {
      await caseRepo.deleteWithForce(c.id, { force: true });
    }

    // Deepest path first, so every child suite is gone before its parent is deleted --
    // parent_suite_id is ON DELETE RESTRICT, so a shallower-first order would fail.
    const descendantsDeepestFirst = [...descendants].sort(
      (a, b) => b.path.split('/').length - a.path.split('/').length
    );

    await this.db.transaction().execute(async (trx) => {
      for (const desc of descendantsDeepestFirst) {
        await trx.deleteFrom('test_suites').where('id', '=', desc.id).execute();
      }
      await trx.deleteFrom('test_suites').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
