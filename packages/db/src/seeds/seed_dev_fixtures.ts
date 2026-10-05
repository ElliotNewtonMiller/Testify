import type { Kysely } from 'kysely';
import type { Database } from '../types.js';
import { hashPassword } from '../repositories/user.repository.js';

/**
 * Local-dev-only convenience fixtures: a handful of users covering every built-in role plus a
 * permission override, so the Admin Panel has real users to test against. Deliberately NO
 * sample projects/suites/cases/plans/runs (removed 2026-10-05, per Elliot) -- a dev server
 * starts with no projects at all; create them in the UI.
 *
 * NOT run in tests and NOT run against a real DATABASE_URL -- see the gate in
 * apps/server/src/server.ts. Idempotent (fixed ids + onConflict doNothing), same
 * convention as seed_core_loop.ts/seed_rbac_registry.ts, so restarting the dev server
 * (a fresh ephemeral PGlite instance every time) or re-running against a persistent
 * Postgres both just no-op past the first run.
 */

export const DEV_FIXTURE_PASSWORD = 'DevTest123!';

function devId(scope: string, n: number): string {
  if (scope.length !== 1) {
    // id columns are varchar(36); this template is exactly 36 chars only for a 1-char scope.
    throw new Error(`devId scope must be exactly 1 character, got '${scope}'`);
  }
  return `0191c4d0-dev${scope}-0000-8000-${n.toString().padStart(12, '0')}`;
}

export async function seedDevFixtures(db: Kysely<Database>): Promise<void> {
  const now = new Date().toISOString();

  // Users covering every built-in role, plus one permission override, so the Admin Panel's
  // Matrix/Templates/override UI have something real to look at immediately.
  const { hash, salt } = hashPassword(DEV_FIXTURE_PASSWORD);
  const passwordHash = `${salt}:${hash}`;

  const users = [
    { id: devId('u', 1), username: 'test_lead', email: 'test_lead@testify.local', role: 'Test Lead' },
    { id: devId('u', 2), username: 'tester', email: 'tester@testify.local', role: 'Tester' },
    { id: devId('u', 3), username: 'viewer', email: 'viewer@testify.local', role: 'Viewer' },
    { id: devId('u', 4), username: 'automation_bot', email: 'automation_bot@testify.local', role: 'Automation Service' },
    { id: devId('u', 5), username: 'project_admin', email: 'project_admin@testify.local', role: 'Tester' },
    { id: devId('u', 6), username: 'override_tester', email: 'override_tester@testify.local', role: 'Tester' },
  ];

  for (const u of users) {
    await db
      .insertInto('users')
      .values({
        id: u.id,
        username: u.username,
        email: u.email,
        password_hash: passwordHash,
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('user_roles')
      .values({
        id: devId('r', users.indexOf(u) + 1),
        user_id: u.id,
        role: u.role,
        created_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  // project_admin: globally Tester. It used to get an Admin override on a sample project, but
  // no sample projects are seeded any more (2026-10-05) -- assign one per project in the
  // Admin Panel's Matrix tab once a project exists.

  // override_tester: globally Tester (no PLAN_MANAGE), but a global permission override
  // force-granting PLAN_MANAGE -- exercises the "Individual Permission Overrides" section.
  const planManagePermission = await db
    .selectFrom('permissions')
    .select('id')
    .where('permission_key', '=', 'PLAN_MANAGE')
    .executeTakeFirst();

  if (planManagePermission) {
    await db
      .insertInto('user_permission_overrides')
      .values({
        id: devId('o', 1),
        user_id: devId('u', 6),
        project_id: null,
        permission_id: planManagePermission.id,
        is_granted: 1,
        created_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
}
