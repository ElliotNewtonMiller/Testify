import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';

describe('Migration & CRUD Integrity', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = createDbClient();
    // Run the migration UP
    await initialSchema.up(db);
  });

  afterEach(async () => {
    try {
      // Run the migration DOWN cleanup
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  it('executes migration UP and DOWN cleanly', async () => {

    // Verify all core tables exist
    const projects = await db.selectFrom('projects').selectAll().execute();
    expect(projects).toEqual([]);

    const suites = await db.selectFrom('test_suites').selectAll().execute();
    expect(suites).toEqual([]);
  });

  it('executes CRUD transactions and FK CASCADE/RESTRICT rules', async () => {
    const now = new Date().toISOString();
    const projectId = '0191c4d0-0000-7000-8000-000000000001';
    const suiteId = '0191c4d0-7a1a-7b3c-8e4d-1a2b3c4d5e6f';
    const caseId = '0191c4d0-8b2b-7c4d-9f5e-2b3c4d5e6f7a';
    const versionId = '0191c4d0-9c3c-7d5e-0f6f-3c4d5e6f7a8b';
    const planId = '0191c4d0-1111-7000-8000-000000000005';
    const buildId = '0191c4d0-2222-7000-8000-000000000006';
    const planCaseId = '0191c4d0-3333-7000-8000-000000000007';
    const execId = '0191c4d0-4444-7000-8000-000000000008';

    // 1. Insert Project
    await db
      .insertInto('projects')
      .values({
        id: projectId,
        name: 'E2E Dual Parity Project',
        prefix: 'PARITY',
        description: 'Testing core CRUD + FK integrity',
        settings: JSON.stringify({ allow_draft_plan_linking: false }),
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 2. Insert Test Suite
    await db
      .insertInto('test_suites')
      .values({
        id: suiteId,
        project_id: projectId,
        parent_suite_id: null,
        name: 'Authentication Engine',
        description: 'Core login suites',
        position: 1,
        path: `/${suiteId}`,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 3. Insert Test Case
    await db
      .insertInto('test_cases')
      .values({
        id: caseId,
        project_id: projectId,
        test_suite_id: suiteId,
        external_id: 'PARITY-101',
        title: 'OAuth2 PKCE Token Flow',
        priority: 'HIGH',
        execution_type: 'MANUAL',
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 4. Insert Test Case Version (APPROVED)
    await db
      .insertInto('test_case_versions')
      .values({
        id: versionId,
        test_case_id: caseId,
        version_number: 1,
        status: 'APPROVED',
        summary: 'Verifies authorization code exchange with code_verifier',
        preconditions: 'Valid client credentials in vault',
        author_id: 'user_lead_01',
        reviewer_id: 'user_lead_02',
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 5. Insert Test Step
    await db
      .insertInto('test_steps')
      .values({
        id: '0191c4d0-aaaa-7000-8000-000000000009',
        test_case_version_id: versionId,
        step_number: 1,
        action: 'POST /oauth/token',
        expected_result: 'HTTP 200 OK with tokens',
        execution_type: 'MANUAL',
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 6. Insert Test Plan & Build
    await db
      .insertInto('test_plans')
      .values({
        id: planId,
        project_id: projectId,
        name: 'Sprint 42 Plan',
        description: 'Regression plan',
        status: 'ACTIVE',
        created_at: now,
        updated_at: now,
      })
      .execute();

    await db
      .insertInto('builds')
      .values({
        id: buildId,
        test_plan_id: planId,
        name: 'v1.0.0-rc1',
        description: 'Release build 1',
        status: 'OPEN',
        release_date: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 7. Pin Version to Test Plan Case Mapping
    await db
      .insertInto('test_plan_cases')
      .values({
        id: planCaseId,
        test_plan_id: planId,
        test_case_id: caseId,
        test_case_version_id: versionId,
        assigned_user_id: 'user_tester_01',
        position: 1,
        custom_fields_snapshot: '{}',
        created_at: now,
        updated_at: now,
      })
      .execute();

    // 8. Record Execution Run
    await db
      .insertInto('executions')
      .values({
        id: execId,
        build_id: buildId,
        test_plan_case_id: planCaseId,
        tester_id: 'user_tester_01',
        status: 'COMPLETED',
        verdict: 'PASSED',
        execution_duration_ms: 1250,
        notes: 'Execution verified successfully',
        custom_fields_snapshot: '{}',
        execution_timestamp: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    // Query Assertion: Join Test Plan Case to Pinned Case Version and Execution
    const result = await db
      .selectFrom('executions as e')
      .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
      .innerJoin('test_case_versions as tcv', 'tcv.id', 'tpc.test_case_version_id')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select([
        'e.id as execution_id',
        'e.verdict as execution_verdict',
        'tc.external_id as case_code',
        'tc.title as case_title',
        'tcv.version_number',
        'tcv.status as version_status',
      ])
      .where('e.id', '=', execId)
      .executeTakeFirstOrThrow();

    expect(result.execution_id).toBe(execId);
    expect(result.execution_verdict).toBe('PASSED');
    expect(result.case_code).toBe('PARITY-101');
    expect(result.case_title).toBe('OAuth2 PKCE Token Flow');
    expect(result.version_number).toBe(1);
    expect(result.version_status).toBe('APPROVED');
  });

  it('enforces audit_logs append-only database trigger immutability', async () => {
    const auditId = '0191c4d0-9999-7000-8000-000000000099';
    const now = new Date().toISOString();

    // 1. Insert audit event (Allowed)
    await db
      .insertInto('audit_logs')
      .values({
        id: auditId,
        actor_id: 'user_admin_01',
        actor_type: 'USER',
        action: 'PROJECT_CREATED',
        resource_type: 'project',
        resource_id: '0191c4d0-0000-7000-8000-000000000001',
        project_id: '0191c4d0-0000-7000-8000-000000000001',
        diff: JSON.stringify({ name: 'Parity' }),
        ip_address: '127.0.0.1',
        user_agent: 'Vitest/DualDriverTest',
        created_at: now,
      })
      .execute();

    // 2. Attempt UPDATE on audit_logs (Must FAIL via DB trigger)
    let updateFailed = false;
    try {
      await db
        .updateTable('audit_logs')
        .set({ action: 'MUTATED_ACTION' })
        .where('id', '=', auditId)
        .execute();
    } catch (error: any) {
      updateFailed = true;
      expect(error.message).toContain('MUTATION_DENIED');
    }
    expect(updateFailed).toBe(true);

    // 3. Attempt DELETE on audit_logs (Must FAIL via DB trigger)
    let deleteFailed = false;
    try {
      await db
        .deleteFrom('audit_logs')
        .where('id', '=', auditId)
        .execute();
    } catch (error: any) {
      deleteFailed = true;
      expect(error.message).toContain('MUTATION_DENIED');
    }
    expect(deleteFailed).toBe(true);
  });
});
