import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database } from '../types.js';

export type RoleName = 'Admin' | 'Test Lead' | 'Tester' | 'Viewer' | 'Automation Service';

export const ROLE_PERMISSIONS: Record<RoleName, string[]> = {
  Admin: [
    'SYSTEM_ADMIN',
    'PROJECT_CREATE',
    'PROJECT_DELETE',
    'USER_MANAGE',
    'SPEC_VIEW',
    'SPEC_CREATE',
    'SPEC_EDIT',
    'SPEC_APPROVE',
    'SPEC_DELETE',
    'PLAN_MANAGE',
    'BUILD_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
  ],
  'Test Lead': [
    'SPEC_VIEW',
    'SPEC_CREATE',
    'SPEC_EDIT',
    'SPEC_APPROVE',
    'SPEC_DELETE',
    'PLAN_MANAGE',
    'BUILD_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
  ],
  Tester: ['SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT', 'EXECUTE_RUN', 'EXPORT_DATA'],
  Viewer: ['SPEC_VIEW', 'EXPORT_DATA'],
  'Automation Service': ['SPEC_VIEW', 'BUILD_MANAGE', 'EXECUTE_RUN'],
};

export class RoleRepository {
  constructor(private db: Kysely<Database>) {}

  async getUserGlobalRole(userId: string): Promise<RoleName> {
    const roleRow = await this.db
      .selectFrom('user_roles')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirst();

    return (roleRow?.role as RoleName) || 'Viewer';
  }

  async assignGlobalRole(userId: string, role: RoleName): Promise<void> {
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
      role: r.role as RoleName,
    }));
  }

  async assignProjectRole(userId: string, projectId: string, role: RoleName): Promise<void> {
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

  /**
   * Evaluates effective permissions using RFC 04 2-tier resolution:
   * SYSTEM_ADMIN > Explicit Project Role Override > Global System Role > Default Deny
   */
  async evaluatePermissions(userId: string, projectId?: string | null): Promise<string[]> {
    const globalRole = await this.getUserGlobalRole(userId);
    const globalPerms = ROLE_PERMISSIONS[globalRole] || [];

    // System Admin unconditionally holds all permission keys
    if (globalPerms.includes('SYSTEM_ADMIN')) {
      return ROLE_PERMISSIONS['Admin'];
    }

    if (projectId) {
      const projectRoleRow = await this.db
        .selectFrom('user_project_roles')
        .selectAll()
        .where('user_id', '=', userId)
        .where('project_id', '=', projectId)
        .executeTakeFirst();

      // Enforce locked rule: Project access is explicit per user
      if (projectRoleRow) {
        const projectRole = projectRoleRow.role as RoleName;
        return ROLE_PERMISSIONS[projectRole] || [];
      }
    }

    return globalPerms;
  }
}
