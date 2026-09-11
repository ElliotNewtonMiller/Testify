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
}
