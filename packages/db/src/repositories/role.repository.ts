import type { Kysely, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, RolesTable } from '../types.js';
import {
  PERMISSION_REGISTRY,
  PERMISSION_KEYS,
  applyPermissionOverrides,
  type PermissionDefinition,
  type PermissionOverride,
} from '@testify/core';

/** Role names are now arbitrary strings backed by the `roles` table, not a closed set --
 * admins can create/rename/delete templates freely. Kept as a named type (rather than
 * inlining `string` everywhere) so call sites read the same as before this became dynamic. */
export type RoleName = string;

export interface RoleTemplate {
  id: string;
  name: string;
  description: string | null;
  is_system_role: boolean;
  permission_keys: string[];
}

export interface CreateRoleInput {
  id?: string;
  name: string;
  description?: string | null;
  permission_keys: string[];
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
  permission_keys?: string[];
}

export type DeleteRoleResult =
  | { deleted: true }
  | { deleted: false; blockedByUserCount: number; roleName?: string };

export class RoleRepository {
  constructor(private db: Kysely<Database>) {}

  async getUserGlobalRole(userId: string): Promise<RoleName> {
    const roleRow = await this.db
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return roleRow?.role || 'Viewer';
  }

  async roleExists(name: string): Promise<boolean> {
    const row = await this.db.selectFrom('roles').select('id').where('name', '=', name).executeTakeFirst();
    return Boolean(row);
  }

  async assignGlobalRole(userId: string, role: RoleName): Promise<void> {
    if (!(await this.roleExists(role))) {
      throw new Error(`UNKNOWN_ROLE: '${role}' is not a valid role name`);
    }

    const now = new Date().toISOString();
    const existing = await this.db
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('user_roles')
        .set({ role })
        .where('user_id', '=', userId)
        .execute();
    } else {
      await this.db
        .insertInto('user_roles')
        .values({
          id: uuidv7(),
          user_id: userId,
          role,
          created_at: now,
        })
        .execute();
    }
  }

  async getUserProjectRoles(userId: string): Promise<Array<{ project_id: string; role: RoleName }>> {
    const rows = await this.db
      .selectFrom('user_project_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();

    return rows.map((r) => ({
      project_id: r.project_id,
      role: r.role,
    }));
  }

  async assignProjectRole(userId: string, projectId: string, role: RoleName): Promise<void> {
    if (!(await this.roleExists(role))) {
      throw new Error(`UNKNOWN_ROLE: '${role}' is not a valid role name`);
    }

    const now = new Date().toISOString();
    const existing = await this.db
      .selectFrom('user_project_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();

    if (existing) {
      await this.db
        .updateTable('user_project_roles')
        .set({ role })
        .where('user_id', '=', userId)
        .where('project_id', '=', projectId)
        .execute();
    } else {
      await this.db
        .insertInto('user_project_roles')
        .values({
          id: uuidv7(),
          user_id: userId,
          project_id: projectId,
          role,
          created_at: now,
        })
        .execute();
    }
  }

  async revokeProjectRole(userId: string, projectId: string): Promise<void> {
    await this.db
      .deleteFrom('user_project_roles')
      .where('user_id', '=', userId)
      .where('project_id', '=', projectId)
      .execute();
  }

  /** The permission-key bundle a role template grants, via `roles`->`role_permissions`->`permissions`. */
  async getRolePermissions(roleName: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('roles')
      .innerJoin('role_permissions', 'role_permissions.role_id', 'roles.id')
      .innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
      .select('permissions.permission_key')
      .where('roles.name', '=', roleName)
      .execute();

    return rows.map((r) => r.permission_key);
  }

  /** A user's permission overrides at a given scope: global (project_id IS NULL) when
   * `projectId` is omitted/null, or a specific project's overrides otherwise. */
  async getUserOverrides(userId: string, projectId?: string | null): Promise<PermissionOverride[]> {
    let query = this.db
      .selectFrom('user_permission_overrides')
      .innerJoin('permissions', 'permissions.id', 'user_permission_overrides.permission_id')
      .select(['permissions.permission_key', 'user_permission_overrides.is_granted'])
      .where('user_permission_overrides.user_id', '=', userId);

    query = projectId
      ? query.where('user_permission_overrides.project_id', '=', projectId)
      : query.where('user_permission_overrides.project_id', 'is', null);

    const rows = await query.execute();
    return rows.map((r) => ({ permission_key: r.permission_key, is_granted: r.is_granted === 1 }));
  }

  /** Replace-all: fully replaces the override set at this scope (global or one project),
   * not additive -- callers always send the complete desired list for that scope. */
  async setUserOverrides(
    userId: string,
    projectId: string | null,
    overrides: PermissionOverride[]
  ): Promise<void> {
    for (const o of overrides) {
      if (!PERMISSION_KEYS.includes(o.permission_key)) {
        throw new Error(`UNKNOWN_PERMISSION_KEY: '${o.permission_key}' is not a registered permission`);
      }
    }

    const permissionRows = await this.db.selectFrom('permissions').select(['id', 'permission_key']).execute();
    const permissionIdByKey = new Map(permissionRows.map((p) => [p.permission_key, p.id]));
    const now = new Date().toISOString();

    await this.db.transaction().execute(async (trx) => {
      let deleteQuery = trx.deleteFrom('user_permission_overrides').where('user_id', '=', userId);
      deleteQuery = projectId
        ? deleteQuery.where('project_id', '=', projectId)
        : deleteQuery.where('project_id', 'is', null);
      await deleteQuery.execute();

      if (overrides.length > 0) {
        await trx
          .insertInto('user_permission_overrides')
          .values(
            overrides.map((o) => ({
              id: uuidv7(),
              user_id: userId,
              project_id: projectId,
              permission_id: permissionIdByKey.get(o.permission_key)!,
              is_granted: o.is_granted ? 1 : 0,
              created_at: now,
            }))
          )
          .execute();
      }
    });
  }

  /**
   * Evaluates effective permissions per RFC 04's 2-tier resolution (SYSTEM_ADMIN >
   * explicit project role override > global role > default deny), now backed by the
   * dynamic `roles`/`role_permissions` tables instead of a hardcoded map, with per-user
   * overrides layered on top. Overrides always have final say -- applied after resolving
   * the base set (including the SYSTEM_ADMIN case), so an override can even revoke a key
   * from an otherwise-full-admin user. Global overrides apply first, then project-scoped
   * ones (when `projectId` is given), so a project-specific override wins any conflict
   * with a global one.
   */
  async evaluatePermissions(userId: string, projectId?: string | null): Promise<string[]> {
    const globalRole = await this.getUserGlobalRole(userId);
    const globalPerms = await this.getRolePermissions(globalRole);

    let basePermissions: string[];
    if (globalPerms.includes('SYSTEM_ADMIN')) {
      basePermissions = PERMISSION_KEYS;
    } else if (projectId) {
      const projectRoleRow = await this.db
        .selectFrom('user_project_roles')
        .selectAll()
        .where('user_id', '=', userId)
        .where('project_id', '=', projectId)
        .executeTakeFirst();

      basePermissions = projectRoleRow ? await this.getRolePermissions(projectRoleRow.role) : globalPerms;
    } else {
      basePermissions = globalPerms;
    }

    const globalOverrides = await this.getUserOverrides(userId, null);
    const projectOverrides = projectId ? await this.getUserOverrides(userId, projectId) : [];

    return applyPermissionOverrides(basePermissions, [...globalOverrides, ...projectOverrides]);
  }

  listPermissionRegistry(): PermissionDefinition[] {
    return PERMISSION_REGISTRY;
  }

  async listRoles(): Promise<RoleTemplate[]> {
    const roleRows = await this.db.selectFrom('roles').selectAll().orderBy('name', 'asc').execute();
    const permissionRows = await this.db
      .selectFrom('role_permissions')
      .innerJoin('permissions', 'permissions.id', 'role_permissions.permission_id')
      .select(['role_permissions.role_id', 'permissions.permission_key'])
      .execute();

    const permsByRoleId = new Map<string, string[]>();
    for (const row of permissionRows) {
      const list = permsByRoleId.get(row.role_id) ?? [];
      list.push(row.permission_key);
      permsByRoleId.set(row.role_id, list);
    }

    return roleRows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      is_system_role: r.is_system_role === 1,
      permission_keys: permsByRoleId.get(r.id) ?? [],
    }));
  }

  async getRole(id: string): Promise<RoleTemplate | undefined> {
    const roles = await this.listRoles();
    return roles.find((r) => r.id === id);
  }

  async createRole(input: CreateRoleInput): Promise<RoleTemplate> {
    for (const key of input.permission_keys) {
      if (!PERMISSION_KEYS.includes(key)) {
        throw new Error(`UNKNOWN_PERMISSION_KEY: '${key}' is not a registered permission`);
      }
    }

    const nameTaken = await this.roleExists(input.name);
    if (nameTaken) {
      throw new Error(`ROLE_NAME_TAKEN: a role named '${input.name}' already exists`);
    }

    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const permissionRows = await this.db.selectFrom('permissions').select(['id', 'permission_key']).execute();
    const permissionIdByKey = new Map(permissionRows.map((p) => [p.permission_key, p.id]));

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('roles')
        .values({
          id,
          name: input.name,
          description: input.description ?? null,
          is_system_role: 0,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (input.permission_keys.length > 0) {
        await trx
          .insertInto('role_permissions')
          .values(input.permission_keys.map((key) => ({ role_id: id, permission_id: permissionIdByKey.get(key)! })))
          .execute();
      }
    });

    return (await this.getRole(id))!;
  }

  async updateRole(id: string, input: UpdateRoleInput): Promise<RoleTemplate | undefined> {
    const existing = await this.db.selectFrom('roles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!existing) return undefined;

    if (input.permission_keys) {
      for (const key of input.permission_keys) {
        if (!PERMISSION_KEYS.includes(key)) {
          throw new Error(`UNKNOWN_PERMISSION_KEY: '${key}' is not a registered permission`);
        }
      }
    }

    if (input.name !== undefined && input.name !== existing.name) {
      const nameTaken = await this.db
        .selectFrom('roles')
        .select('id')
        .where('name', '=', input.name)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (nameTaken) {
        throw new Error(`ROLE_NAME_TAKEN: a role named '${input.name}' already exists`);
      }
    }

    const now = new Date().toISOString();

    await this.db.transaction().execute(async (trx) => {
      const updateData: Updateable<RolesTable> = { updated_at: now };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;

      await trx.updateTable('roles').set(updateData).where('id', '=', id).execute();

      if (input.permission_keys) {
        const permissionRows = await trx.selectFrom('permissions').select(['id', 'permission_key']).execute();
        const permissionIdByKey = new Map(permissionRows.map((p) => [p.permission_key, p.id]));

        await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
        if (input.permission_keys.length > 0) {
          await trx
            .insertInto('role_permissions')
            .values(
              input.permission_keys.map((key) => ({ role_id: id, permission_id: permissionIdByKey.get(key)! }))
            )
            .execute();
        }
      }
    });

    return this.getRole(id);
  }

  /**
   * Deletes a role template. `is_system_role` is informational only, never a deletion
   * guard -- but a role currently assigned to any user (globally or per-project) is
   * blocked, returning how many distinct users would be affected, so an admin can
   * reassign them first rather than a role silently disappearing out from under someone.
   */
  async deleteRole(id: string): Promise<DeleteRoleResult> {
    const role = await this.db.selectFrom('roles').selectAll().where('id', '=', id).executeTakeFirst();
    if (!role) {
      return { deleted: false, blockedByUserCount: 0 };
    }

    const globalUsers = await this.db
      .selectFrom('user_roles')
      .select('user_id')
      .where('role', '=', role.name)
      .execute();
    const projectUsers = await this.db
      .selectFrom('user_project_roles')
      .select('user_id')
      .where('role', '=', role.name)
      .execute();

    const blockedByUserCount = new Set([
      ...globalUsers.map((r) => r.user_id),
      ...projectUsers.map((r) => r.user_id),
    ]).size;

    if (blockedByUserCount > 0) {
      return { deleted: false, blockedByUserCount, roleName: role.name };
    }

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('role_permissions').where('role_id', '=', id).execute();
      await trx.deleteFrom('roles').where('id', '=', id).execute();
    });

    return { deleted: true };
  }
}
