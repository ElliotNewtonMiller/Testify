import type { Kysely } from 'kysely';
import type { Database } from '../types.js';
import { PERMISSION_REGISTRY, DEFAULT_ROLE_PERMISSIONS, DEFAULT_ROLE_NAMES } from '@testify/core';

/**
 * Seeds the `permissions`, `roles`, and `role_permissions` tables on a fresh install:
 * the 16 permission keys from packages/core's PERMISSION_REGISTRY, the 5 built-in role
 * templates (Admin, Test Lead, Tester, Viewer, Automation Service) marked
 * `is_system_role`, and the role<->permission bundle matching what used to be the
 * hardcoded ROLE_PERMISSIONS map -- so behavior is unchanged the moment this seed runs.
 * Idempotent (fixed ids + onConflict doNothing), same convention as seed_core_loop.ts.
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
        description: null,
        is_system_role: 1,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
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
