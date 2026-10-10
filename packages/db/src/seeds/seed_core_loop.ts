import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

export async function seedCoreLoopData(db: Kysely<Database>): Promise<{
  projectId: string;
  suiteId: string;
  planId: string;
  buildId: string;
  caseIds: string[];
}> {
  const now = new Date().toISOString();
  const projectId = '0191c4d0-0000-7000-8000-000000000001';
  const suiteId = '0191c4d0-7a1a-7b3c-8e4d-1a2b3c4d5e6f';
  const planId = '0191c4d0-1111-7000-8000-000000000005';
  const buildId = '0191c4d0-2222-7000-8000-000000000006';

  // 1. Seed Project
  await db
    .insertInto('projects')
    .values({
      id: projectId,
      name: 'E-Commerce Core Platform',
      prefix: 'SHOP',
      description: 'Primary web & mobile store backend',
      settings: JSON.stringify({ allow_draft_plan_linking: false }),
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // 2. Seed Recursive Test Suite
  await db
    .insertInto('test_suites')
    .values({
      id: suiteId,
      project_id: projectId,
      parent_suite_id: null,
      name: 'Authentication & OAuth2 Engine',
      description: 'Security, token refresh, and PKCE exchange suites',
      position: 1,
      path: `/${suiteId}`,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // 3. Seed 10 Test Cases with Approved Versions & Test Steps
  const caseTitles = [
    'OAuth2 PKCE Code Exchange Flow',
    'JWT Refresh Token Rotation & Invalidation',
    'User Password Login with Rate Limiting',
    'SAML2 Enterprise Single Sign-On',
    'Multi-Factor SMS Auth Code Delivery',
    'Session Inactivity Timeout Enforcement',
    'Password Reset Token One-Time Usage',
    'API Token Capability Scope Authorization',
    'User Registration Email Verification',
    'OAuth2 Revocation Endpoint Verification',
  ];

  const caseIds: string[] = [];

  for (let i = 0; i < 10; i++) {
    const caseIndex = i + 1;
    const caseUuid = `0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e${caseIndex.toString(16).padStart(4, '0')}`;
    const versionUuid = `0191c4d0-9c3c-7d5e-0f6f-3c4d5e${caseIndex.toString(16).padStart(4, '0')}`;
    const planCaseUuid = `0191c4d0-3333-7000-8000-00000000${caseIndex.toString(16).padStart(4, '0')}`;
    const externalCode = `SHOP-10${caseIndex}`;

    caseIds.push(caseUuid);

    // Insert Case
    await db
      .insertInto('test_cases')
      .values({
        id: caseUuid,
        project_id: projectId,
        test_suite_id: suiteId,
        external_id: externalCode,
        title: caseTitles[i],
        priority: caseIndex <= 3 ? 'HIGH' : caseIndex <= 7 ? 'MEDIUM' : 'LOW',
        execution_type: caseIndex % 2 === 0 ? 'AUTOMATED' : 'MANUAL',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Insert Approved Case Version
    await db
      .insertInto('test_case_versions')
      .values({
        id: versionUuid,
        test_case_id: caseUuid,
        version_number: 1,
        status: 'APPROVED',
        summary: `Verifies ${caseTitles[i]} under production load.`,
        preconditions: 'User has valid active credentials in test vault.',
        author_id: 'usr_qa_lead_01',
        reviewer_id: 'usr_qa_lead_02',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    // Insert 2 Test Steps per case
    await db
      .insertInto('test_steps')
      .values({
        id: `0191c4d0-step-1000-8000-${caseIndex.toString(16).padStart(12, '0')}`,
        test_case_version_id: versionUuid,
        step_number: 1,
        action: `Execute step 1 for ${caseTitles[i]}`,
        expected_result: 'Step 1 completes with HTTP 200 OK.',
        execution_type: 'MANUAL',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await db
      .insertInto('test_steps')
      .values({
        id: `0191c4d0-step-2000-8000-${caseIndex.toString(16).padStart(12, '0')}`,
        test_case_version_id: versionUuid,
        step_number: 2,
        action: `Execute step 2 for ${caseTitles[i]}`,
        expected_result: 'Step 2 validates state assertion.',
        execution_type: 'MANUAL',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  // 4. Seed Test Plan
  await db
    .insertInto('test_plans')
    .values({
      id: planId,
      project_id: projectId,
      name: 'Sprint 42 Regression Plan',
      description: 'Core security & auth testing cycle',
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // 5. Seed Build
  await db
    .insertInto('builds')
    .values({
      id: buildId,
      test_plan_id: planId,
      name: 'v1.0.0-rc1',
      description: 'Release Build Candidate 1',
      status: 'OPEN',
      release_date: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  // 6. Link 10 Test Cases to Test Plan
  for (let i = 0; i < 10; i++) {
    const caseIndex = i + 1;
    const caseUuid = caseIds[i];
    const versionUuid = `0191c4d0-9c3c-7d5e-0f6f-3c4d5e${caseIndex.toString(16).padStart(4, '0')}`;
    const planCaseUuid = `0191c4d0-3333-7000-8000-00000000${caseIndex.toString(16).padStart(4, '0')}`;

    await db
      .insertInto('test_plan_cases')
      .values({
        id: planCaseUuid,
        test_plan_id: planId,
        test_case_id: caseUuid,
        test_case_version_id: versionUuid,
        position: caseIndex,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }

  return { projectId, suiteId, planId, buildId, caseIds };
}
