import type { Kysely } from 'kysely';
import type { Database } from '../types.js';
import { hashPassword } from '../repositories/user.repository.js';

/**
 * Local-dev-only convenience fixtures: a couple more projects (beyond the single one
 * seed_core_loop.ts creates) and a handful of users covering every built-in role plus a
 * per-project role override and a permission override -- so starting the server gives you
 * something to immediately click around and test against instead of an empty admin panel.
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

  const projects = [
    {
      id: devId('p', 1),
      name: 'Mobile Banking Platform',
      prefix: 'BANK',
      description: 'iOS/Android banking app -- accounts, transfers, payments',
      suiteId: devId('s', 1),
      suiteName: 'Accounts & Transfers',
      planId: devId('l', 1),
      planName: 'Sprint Regression Plan',
      buildId: devId('b', 1),
      cases: [
        { n: 1, externalId: 'BANK-101', title: 'View Account Balance', action: 'Open the Accounts tab and select an account', expected: 'Current balance and recent transactions load within 2s' },
        { n: 2, externalId: 'BANK-102', title: 'Transfer Funds Between Accounts', action: 'Initiate a transfer from Checking to Savings', expected: 'Transfer completes and both balances update immediately' },
        { n: 3, externalId: 'BANK-103', title: 'Set Up Recurring Payment', action: 'Create a monthly recurring payment to a saved payee', expected: 'Payment schedule is saved and shown in Upcoming Payments' },
      ],
    },
    {
      id: devId('p', 2),
      name: 'Internal Admin Console',
      prefix: 'ADMN',
      description: 'Internal tooling for support staff to manage customer accounts',
      suiteId: devId('s', 2),
      suiteName: 'User Management',
      planId: devId('l', 2),
      planName: 'Release Candidate Plan',
      buildId: devId('b', 2),
      cases: [
        { n: 4, externalId: 'ADMN-101', title: 'Deactivate a User Account', action: 'Search for a user by email and click Deactivate', expected: 'Account status changes to DISABLED and the user is logged out' },
        { n: 5, externalId: 'ADMN-102', title: 'Export Audit Log to CSV', action: 'Filter the audit log by date range and click Export', expected: 'A CSV download starts containing only the filtered rows' },
      ],
    },
  ];

  for (const project of projects) {
    await db
      .insertInto('projects')
      .values({
        id: project.id,
        name: project.name,
        prefix: project.prefix,
        description: project.description,
        settings: JSON.stringify({ allow_draft_plan_linking: false }),
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('test_suites')
      .values({
        id: project.suiteId,
        project_id: project.id,
        parent_suite_id: null,
        name: project.suiteName,
        description: null,
        position: 1,
        path: `/${project.suiteId}`,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('test_plans')
      .values({
        id: project.planId,
        project_id: project.id,
        name: project.planName,
        description: null,
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('builds')
      .values({
        id: project.buildId,
        test_plan_id: project.planId,
        name: 'v1.0-rc1',
        description: null,
        status: 'OPEN',
        release_date: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    for (const c of project.cases) {
      const caseId = devId('c', c.n);
      const versionId = devId('v', c.n);
      const stepId = devId('t', c.n);
      const planCaseId = devId('k', c.n);

      await db
        .insertInto('test_cases')
        .values({
          id: caseId,
          project_id: project.id,
          test_suite_id: project.suiteId,
          external_id: c.externalId,
          title: c.title,
          priority: 'HIGH',
          execution_type: 'MANUAL',
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await db
        .insertInto('test_case_versions')
        .values({
          id: versionId,
          test_case_id: caseId,
          version_number: 1,
          status: 'APPROVED',
          summary: c.title,
          preconditions: 'User has valid active credentials in test vault.',
          author_id: 'usr_qa_lead_01',
          reviewer_id: 'usr_qa_lead_02',
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await db
        .insertInto('test_steps')
        .values({
          id: stepId,
          test_case_version_id: versionId,
          step_number: 1,
          action: c.action,
          expected_result: c.expected,
          execution_type: 'MANUAL',
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      await db
        .insertInto('test_plan_cases')
        .values({
          id: planCaseId,
          test_plan_id: project.planId,
          test_case_id: caseId,
          test_case_version_id: versionId,
          assigned_user_id: null,
          position: c.n,
          custom_fields_snapshot: '{}',
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
  }

  // Users covering every built-in role, plus one per-project role override and one
  // permission override, so the Admin Panel's Matrix/Templates/override UI all have
  // something real to look at immediately.
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

  // project_admin: globally Tester, but an explicit Admin override on the Banking project --
  // exercises the "Explicit Per-Project Role Overrides" section of the Matrix tab.
  await db
    .insertInto('user_project_roles')
    .values({
      id: devId('j', 1),
      user_id: devId('u', 5),
      project_id: projects[0].id,
      role: 'Admin',
      created_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

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
