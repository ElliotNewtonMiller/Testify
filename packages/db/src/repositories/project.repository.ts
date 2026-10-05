import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, ProjectsTable } from '../types.js';

export type Project = Selectable<ProjectsTable>;
export type NewProject = Insertable<ProjectsTable>;
export type ProjectUpdate = Updateable<ProjectsTable>;

export interface CreateProjectInput {
  id?: string;
  name: string;
  prefix: string;
  description?: string | null;
  settings?: Record<string, any> | string;
}

export interface UpdateProjectInput {
  name?: string;
  prefix?: string;
  description?: string | null;
  settings?: Record<string, any> | string;
}

export class ProjectRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const settingsStr =
      typeof input.settings === 'object'
        ? JSON.stringify(input.settings)
        : input.settings || '{}';

    const project: NewProject = {
      id,
      name: input.name,
      prefix: input.prefix,
      description: input.description ?? null,
      settings: settingsStr,
      created_at: now,
      updated_at: now,
    };

    await this.db.insertInto('projects').values(project).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<Project | undefined> {
    return await this.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByPrefix(prefix: string): Promise<Project | undefined> {
    return await this.db
      .selectFrom('projects')
      .selectAll()
      .where('prefix', '=', prefix)
      .executeTakeFirst();
  }

  async findAll(): Promise<Project[]> {
    return await this.db
      .selectFrom('projects')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
  }

  async update(id: string, input: UpdateProjectInput): Promise<Project | undefined> {
    const now = new Date().toISOString();
    const updateData: ProjectUpdate = {
      updated_at: now,
    };

    if (input.name !== undefined) updateData.name = input.name;
    if (input.prefix !== undefined) updateData.prefix = input.prefix;
    if (input.description !== undefined) updateData.description = input.description;
    if (input.settings !== undefined) {
      updateData.settings =
        typeof input.settings === 'object'
          ? JSON.stringify(input.settings)
          : input.settings;
    }

    await this.db
      .updateTable('projects')
      .set(updateData)
      .where('id', '=', id)
      .execute();

    return this.findById(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('projects')
      .where('id', '=', id)
      .executeTakeFirst();

    return (result.numDeletedRows ?? 0n) > 0n;
  }

  /** How much content a project holds -- what a delete would discard. */
  async getContentCounts(id: string): Promise<ProjectContentCounts> {
    const count = async (q: Promise<{ n: string | number | bigint } | undefined>) => Number((await q)?.n ?? 0);
    const planIds = (await this.db.selectFrom('test_plans').select('id').where('project_id', '=', id).execute()).map((r) => r.id);
    const [suiteCount, caseCount, runCount, executionCount] = await Promise.all([
      count(this.db.selectFrom('test_suites').select((eb) => eb.fn.countAll().as('n')).where('project_id', '=', id).executeTakeFirst()),
      count(this.db.selectFrom('test_cases').select((eb) => eb.fn.countAll().as('n')).where('project_id', '=', id).executeTakeFirst()),
      planIds.length
        ? count(this.db.selectFrom('builds').select((eb) => eb.fn.countAll().as('n')).where('test_plan_id', 'in', planIds).executeTakeFirst())
        : Promise.resolve(0),
      planIds.length
        ? count(
            this.db
              .selectFrom('executions')
              .innerJoin('builds', 'builds.id', 'executions.build_id')
              .select((eb) => eb.fn.countAll().as('n'))
              .where('builds.test_plan_id', 'in', planIds)
              .executeTakeFirst()
          )
        : Promise.resolve(0),
    ]);
    return { suiteCount, caseCount, planCount: planIds.length, runCount, executionCount };
  }

  /**
   * Deletes a project. Without `force`, a project that still holds any suites, cases, plans
   * or runs is left untouched and its counts are reported (same warn-then-confirm shape as
   * the suite/case/plan/run deletes). With `force`, everything in it goes, in an order that
   * respects every ON DELETE RESTRICT: executions (their steps cascade) -> runs -> plan links
   * -> plans -> custom field values on its cases/suites and its project-scoped fields -> cases
   * (versions/steps cascade) -> suites -> the project (its role assignments, permission
   * overrides and API tokens cascade). Audit log rows are kept -- they're immutable history.
   */
  async deleteWithForce(id: string, opts: { force?: boolean } = {}): Promise<DeleteProjectResult> {
    const project = await this.findById(id);
    if (!project) return { deleted: false, notFound: true };

    const counts = await this.getContentCounts(id);
    const hasContent = counts.suiteCount + counts.caseCount + counts.planCount + counts.runCount > 0;
    if (hasContent && !opts.force) return { deleted: false, blocked: counts };

    await this.db.transaction().execute(async (trx) => {
      const ids = async (q: Promise<Array<{ id: string }>>) => (await q).map((r) => r.id);
      const planIds = await ids(trx.selectFrom('test_plans').select('id').where('project_id', '=', id).execute());
      const caseIds = await ids(trx.selectFrom('test_cases').select('id').where('project_id', '=', id).execute());
      const suiteIds = await ids(trx.selectFrom('test_suites').select('id').where('project_id', '=', id).execute());
      const buildIds = planIds.length
        ? await ids(trx.selectFrom('builds').select('id').where('test_plan_id', 'in', planIds).execute())
        : [];
      // Plan links for this project's plans, plus any link to this project's cases.
      const planCaseIds =
        planIds.length || caseIds.length
          ? await ids(
              trx
                .selectFrom('test_plan_cases')
                .select('id')
                .where((eb) =>
                  eb.or([
                    ...(planIds.length ? [eb('test_plan_id', 'in', planIds)] : []),
                    ...(caseIds.length ? [eb('test_case_id', 'in', caseIds)] : []),
                  ])
                )
                .execute()
            )
          : [];

      if (buildIds.length) await trx.deleteFrom('executions').where('build_id', 'in', buildIds).execute();
      if (planCaseIds.length) await trx.deleteFrom('executions').where('test_plan_case_id', 'in', planCaseIds).execute();
      if (buildIds.length) await trx.deleteFrom('builds').where('id', 'in', buildIds).execute();
      if (planCaseIds.length) await trx.deleteFrom('test_plan_cases').where('id', 'in', planCaseIds).execute();
      if (planIds.length) await trx.deleteFrom('test_plans').where('id', 'in', planIds).execute();

      const entityIds = [...caseIds, ...suiteIds];
      if (entityIds.length) await trx.deleteFrom('custom_field_values').where('entity_id', 'in', entityIds).execute();
      const projectDefIds = await ids(
        trx.selectFrom('custom_field_definitions').select('id').where('project_id', '=', id).execute()
      );
      if (projectDefIds.length) {
        await trx.deleteFrom('custom_field_values').where('custom_field_definition_id', 'in', projectDefIds).execute();
        await trx.deleteFrom('custom_field_definitions').where('id', 'in', projectDefIds).execute();
      }

      if (caseIds.length) await trx.deleteFrom('test_cases').where('id', 'in', caseIds).execute();
      if (suiteIds.length) {
        // parent_suite_id is ON DELETE RESTRICT -- detach the tree first, then delete it whole.
        await trx.updateTable('test_suites').set({ parent_suite_id: null }).where('id', 'in', suiteIds).execute();
        await trx.deleteFrom('test_suites').where('id', 'in', suiteIds).execute();
      }
      await trx.deleteFrom('projects').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}

export interface ProjectContentCounts {
  suiteCount: number;
  caseCount: number;
  planCount: number;
  runCount: number;
  executionCount: number;
}

export type DeleteProjectResult =
  | { deleted: true }
  | { deleted: false; notFound: true }
  | { deleted: false; blocked: ProjectContentCounts };
