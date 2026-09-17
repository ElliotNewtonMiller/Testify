import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';
import { seedRbacRegistry } from '../src/seeds/seed_rbac_registry.js';
import { UserRepository, RoleRepository, ProjectRepository } from '../src/repositories/index.js';
import { DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_NAMES, PERMISSION_KEYS } from '../../core/src/index.js';

describe('Role templates & permission overrides', () => {
  let db: Kysely<Database>;
  let roleRepo: RoleRepository;
  let userRepo: UserRepository;
  let projectRepo: ProjectRepository;

  beforeEach(async () => {
    db = createDbClient();
    await initialSchema.up(db);
    await seedRbacRegistry(db);

    roleRepo = new RoleRepository(db);
    userRepo = new UserRepository(db);
    projectRepo = new ProjectRepository(db);
  });

  afterEach(async () => {
    try {
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  it('seeds the 5 default roles, matching DEFAULT_ROLE_PERMISSIONS exactly', async () => {
    const roles = await roleRepo.listRoles();
    expect(roles.map((r) => r.name).sort()).toEqual([...DEFAULT_ROLE_NAMES].sort());

    for (const role of roles) {
      expect(role.is_system_role).toBe(true);
      expect(role.permission_keys.sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS[role.name]].sort());
    }
  });

  it('createRole / updateRole / deleteRole happy paths', async () => {
    const created = await roleRepo.createRole({
      name: 'Regression Auditor',
      description: 'Read-only, plus export',
      permission_keys: ['SPEC_VIEW', 'EXPORT_DATA'],
    });
    expect(created.is_system_role).toBe(false);
    expect(created.permission_keys.sort()).toEqual(['EXPORT_DATA', 'SPEC_VIEW']);

    const updated = await roleRepo.updateRole(created.id, {
      description: 'Read-only, export, and plan visibility',
      permission_keys: ['SPEC_VIEW', 'EXPORT_DATA', 'PLAN_MANAGE'],
    });
    expect(updated?.permission_keys.sort()).toEqual(['EXPORT_DATA', 'PLAN_MANAGE', 'SPEC_VIEW']);

    const deleteResult = await roleRepo.deleteRole(created.id);
    expect(deleteResult).toEqual({ deleted: true });
    expect(await roleRepo.getRole(created.id)).toBeUndefined();
  });

  it('createRole rejects an unknown permission key and a duplicate name', async () => {
    await expect(
      roleRepo.createRole({ name: 'Bad Role', permission_keys: ['NOT_A_REAL_KEY'] })
    ).rejects.toThrow(/UNKNOWN_PERMISSION_KEY/);

    await expect(roleRepo.createRole({ name: 'Tester', permission_keys: [] })).rejects.toThrow(
      /ROLE_NAME_TAKEN/
    );
  });

  it('deleteRole blocks deletion of a role currently assigned to a user, with a count', async () => {
    const user = await userRepo.create({
      username: 'auditor_1',
      email: 'auditor_1@testify.local',
      password: 'AuditPass123!',
      global_role: 'Automation Service',
    });

    const roles = await roleRepo.listRoles();
    const automationRole = roles.find((r) => r.name === 'Automation Service')!;

    const blocked = await roleRepo.deleteRole(automationRole.id);
    expect(blocked).toEqual({ deleted: false, blockedByUserCount: 1 });

    // Confirmed still present
    expect(await roleRepo.getRole(automationRole.id)).toBeDefined();
    void user;
  });

  it('deleting an unused DEFAULT role succeeds -- is_system_role is informational, not a deletion guard', async () => {
    const roles = await roleRepo.listRoles();
    const unusedDefault = roles.find((r) => r.name === 'Automation Service')!;

    const result = await roleRepo.deleteRole(unusedDefault.id);
    expect(result).toEqual({ deleted: true });
  });

  it('assignGlobalRole / assignProjectRole reject an unknown role name', async () => {
    const user = await userRepo.create({
      username: 'someone',
      email: 'someone@testify.local',
      password: 'SomePass123!',
      global_role: 'Tester',
    });

    await expect(roleRepo.assignGlobalRole(user.id, 'NotARealRole')).rejects.toThrow(/UNKNOWN_ROLE/);

    const project = await projectRepo.create({ name: 'Proj', prefix: 'PRJ' });
    await expect(roleRepo.assignProjectRole(user.id, project.id, 'NotARealRole')).rejects.toThrow(
      /UNKNOWN_ROLE/
    );
  });

  it('setUserOverrides / getUserOverrides: replace-all semantics, scoped independently per project', async () => {
    const user = await userRepo.create({
      username: 'override_user',
      email: 'override_user@testify.local',
      password: 'OverridePass123!',
      global_role: 'Viewer',
    });
    const project = await projectRepo.create({ name: 'Override Proj', prefix: 'OVR' });

    await roleRepo.setUserOverrides(user.id, null, [{ permission_key: 'PLAN_MANAGE', is_granted: true }]);
    expect(await roleRepo.getUserOverrides(user.id, null)).toEqual([
      { permission_key: 'PLAN_MANAGE', is_granted: true },
    ]);
    // Project-scoped is empty until set -- independent of global
    expect(await roleRepo.getUserOverrides(user.id, project.id)).toEqual([]);

    await roleRepo.setUserOverrides(user.id, project.id, [
      { permission_key: 'EXECUTE_RUN', is_granted: true },
    ]);
    expect(await roleRepo.getUserOverrides(user.id, project.id)).toEqual([
      { permission_key: 'EXECUTE_RUN', is_granted: true },
    ]);
    // Global untouched by the project-scoped write
    expect(await roleRepo.getUserOverrides(user.id, null)).toEqual([
      { permission_key: 'PLAN_MANAGE', is_granted: true },
    ]);

    // Second call to the same scope fully replaces the first, not additive
    await roleRepo.setUserOverrides(user.id, null, [{ permission_key: 'EXPORT_DATA', is_granted: false }]);
    expect(await roleRepo.getUserOverrides(user.id, null)).toEqual([
      { permission_key: 'EXPORT_DATA', is_granted: false },
    ]);
  });

  it('setUserOverrides rejects an unknown permission key', async () => {
    const user = await userRepo.create({
      username: 'bad_override_user',
      email: 'bad_override_user@testify.local',
      password: 'BadOverride123!',
      global_role: 'Viewer',
    });
    await expect(
      roleRepo.setUserOverrides(user.id, null, [{ permission_key: 'NOT_REAL', is_granted: true }])
    ).rejects.toThrow(/UNKNOWN_PERMISSION_KEY/);
  });

  it('evaluatePermissions: a custom role grants exactly its own bundle', async () => {
    const custom = await roleRepo.createRole({
      name: 'Custom Reviewer',
      permission_keys: ['SPEC_VIEW', 'SPEC_APPROVE'],
    });
    const user = await userRepo.create({
      username: 'custom_role_user',
      email: 'custom_role_user@testify.local',
      password: 'CustomPass123!',
      global_role: custom.name,
    });

    const perms = await roleRepo.evaluatePermissions(user.id);
    expect(perms.sort()).toEqual(['SPEC_APPROVE', 'SPEC_VIEW']);
  });

  it('evaluatePermissions: global overrides apply, and a project override wins a conflict with a global one', async () => {
    const user = await userRepo.create({
      username: 'layered_user',
      email: 'layered_user@testify.local',
      password: 'LayeredPass123!',
      global_role: 'Viewer', // SPEC_VIEW, EXPORT_DATA only
    });
    const project = await projectRepo.create({ name: 'Layered Proj', prefix: 'LYR' });

    // Global override grants PLAN_MANAGE everywhere
    await roleRepo.setUserOverrides(user.id, null, [{ permission_key: 'PLAN_MANAGE', is_granted: true }]);

    const globalPerms = await roleRepo.evaluatePermissions(user.id);
    expect(globalPerms).toContain('PLAN_MANAGE');

    // Project-scoped override revokes it specifically on this project
    await roleRepo.setUserOverrides(user.id, project.id, [
      { permission_key: 'PLAN_MANAGE', is_granted: false },
    ]);

    const projectPerms = await roleRepo.evaluatePermissions(user.id, project.id);
    expect(projectPerms).not.toContain('PLAN_MANAGE');
    // But the global evaluation (no projectId) is unaffected
    expect(await roleRepo.evaluatePermissions(user.id)).toContain('PLAN_MANAGE');
  });

  it('evaluatePermissions: an override can revoke a key from an otherwise-SYSTEM_ADMIN user', async () => {
    const admin = await userRepo.seedInitialAdmin();

    const fullPerms = await roleRepo.evaluatePermissions(admin.id);
    expect(fullPerms.sort()).toEqual([...PERMISSION_KEYS].sort());

    await roleRepo.setUserOverrides(admin.id, null, [
      { permission_key: 'API_TOKEN_MANAGE', is_granted: false },
    ]);

    const restrictedPerms = await roleRepo.evaluatePermissions(admin.id);
    expect(restrictedPerms).not.toContain('API_TOKEN_MANAGE');
    expect(restrictedPerms).toContain('SYSTEM_ADMIN');
    expect(restrictedPerms).toHaveLength(PERMISSION_KEYS.length - 1);
  });
});
