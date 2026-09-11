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
}
