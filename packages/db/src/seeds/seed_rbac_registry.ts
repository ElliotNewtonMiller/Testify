import type { Kysely } from 'kysely';
import type { Database } from '../types.js';
import { PERMISSION_REGISTRY, DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_NAMES, DEFAULT_ROLE_DESCRIPTIONS } from '@testify/core';

/**
 * Seeds the `permissions`, `roles`, and `role_permissions` tables: every permission key in
 * packages/core's PERMISSION_REGISTRY, and the built-in role templates (DEFAULT_ROLE_PERMISSIONS:
 * Admin, Test Lead, Tester, Viewer, Automation Service, No Access) marked `is_system_role`, with
 * their permission bundles. Runs on every start and is idempotent (fixed ids + onConflict
 * doNothing), so a built-in added later also reaches existing databases.
 */
export async function seedRbacRegistry(db: Kysely<Database>): Promise<void> {
  const now = new Date().toISOString();

  const permissionIdByKey = new Map<string, string>();
  PERMISSION_REGISTRY.forEach((p, i) => {
    permissionIdByKey.set(p.key, `0191c4d0-perm-0000-8000-${(i + 1).toString().padStart(12, '0')}`);
  });

  for (const p of PERMISSION_REGISTRY) {
    await db
      .insertInto('permissions')
      .values({
        id: permissionIdByKey.get(p.key)!,
        permission_key: p.key,
        description: p.description,
        module: p.module,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  const roleIdByName = new Map<string, string>();
  DEFAULT_ROLE_NAMES.forEach((name, i) => {
    roleIdByName.set(name, `0191c4d0-role-0000-8000-${(i + 1).toString().padStart(12, '0')}`);
  });

  for (const roleName of DEFAULT_ROLE_NAMES) {
    await db
      .insertInto('roles')
      .values({
        id: roleIdByName.get(roleName)!,
        name: roleName,
        description: DEFAULT_ROLE_DESCRIPTIONS[roleName] ?? null,
        is_system_role: 1,
        created_at: now,
        updated_at: now,
      })
      // Any conflict: already seeded, or an admin already made a role with that name.
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  for (const roleName of DEFAULT_ROLE_NAMES) {
    const roleId = roleIdByName.get(roleName)!;
    for (const key of DEFAULT_ROLE_PERMISSIONS[roleName]) {
      const permissionId = permissionIdByKey.get(key);
      if (!permissionId) continue;
      await db
        .insertInto('role_permissions')
        .values({ role_id: roleId, permission_id: permissionId })
        .onConflict((oc) => oc.columns(['role_id', 'permission_id']).doNothing())
        .execute();
    }
  }
}
