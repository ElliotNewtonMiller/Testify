import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.ts';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';

describe('Core Operational Loop E2E Integration Test', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  /** Reads every result, step result and audit row straight from the database. (This used to be a
   * public GET /api/v1/executions/verify route -- removed: it needed no login and dumped everything.) */
  async function readExecutionTables(db: Kysely<Database>) {
    const executions = await db.selectFrom('test_results').selectAll().orderBy('created_at', 'desc').execute();
    const steps = await db.selectFrom('test_step_results').selectAll().execute();
    const auditLogs = await db.selectFrom('audit_logs').selectAll().execute();
    return { total_executions: executions.length, executions, steps, auditLogs };
  }

  /** The seeded plan's execution queue for the seeded run, as Execute mode loads it. */
  async function planQueue(app: any, token: string, seed: any): Promise<any[]> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).cases;
  }

  /** Logs in as the seeded initial admin and returns a real, signed Bearer token + user id. */
  async function loginAsAdmin(app: any): Promise<{ token: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    return { token: body.token as string, userId: body.user.id as string };
  }

  it('hydrates 10 seeded test cases and records optimistic + immutable verdict transitions', async () => {
    const { app, db, seed } = serverInstance;
    const { token, userId: adminId } = await loginAsAdmin(app);
    const authHeaders = { authorization: `Bearer ${token}` };

    // 1. Hydrate the workspace - verify the seeded project, suite and 10 test cases
    const specRes = await app.inject({ method: 'GET', url: `/api/v1/projects/${seed.projectId}/spec-tree`, headers: authHeaders });
    expect(specRes.statusCode).toBe(200);
    const spec = JSON.parse(specRes.body);
    expect(spec.project.prefix).toBe('SHOP');
    expect(spec.suites.length).toBe(1);

    const workspace = { cases: await planQueue(app, token, seed) };
    expect(workspace.cases.length).toBe(10);
    expect(workspace.cases[0].external_id).toBe('SHOP-101');
    expect(workspace.cases[0].latest_verdict).toBe('UNTESTED');

    // 2. Simulate Single-Key Hotkey 'p' (Pass) on Case 1 (SHOP-101)
    const case1 = workspace.cases[0];
    const passRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: authHeaders,
      payload: {
        test_plan_case_id: case1.test_plan_case_id,
        verdict: 'PASSED',
        status: 'COMPLETED',
        notes: 'Rapid single-key hotkey [p] pass submission',
        execution_duration_ms: 320,
        step_results: [
          { test_step_id: case1.steps[0].id, step_number: 1, verdict: 'PASSED' },
          { test_step_id: case1.steps[1].id, step_number: 2, verdict: 'PASSED' },
        ],
      },
    });

    expect(passRes.statusCode).toBe(201);
    const passData = JSON.parse(passRes.body);
    expect(passData.result.verdict).toBe('PASSED');

    // 3. Simulate Single-Key Hotkey 'f' (Fail) on Case 2 (SHOP-102)
    const case2 = workspace.cases[1];
    const failRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: authHeaders,
      payload: {
        test_plan_case_id: case2.test_plan_case_id,
        verdict: 'FAILED',
        status: 'COMPLETED',
        notes: 'Regressed token secret assertion - step 2 failed',
        execution_duration_ms: 1100,
        step_results: [
          { test_step_id: case2.steps[0].id, step_number: 1, verdict: 'PASSED' },
          { test_step_id: case2.steps[1].id, step_number: 2, verdict: 'FAILED', actual_result: 'HTTP 500 Internal Error' },
        ],
      },
    });

    expect(failRes.statusCode).toBe(201);
    const failData = JSON.parse(failRes.body);
    expect(failData.result.verdict).toBe('FAILED');

    // 4. Verify Immutable Database Snapshots & Audit Trail
    const verification: any = await readExecutionTables(db);

    expect(verification.total_executions).toBe(2);

    const exec1 = verification.executions.find((e: any) => e.id === passData.result.id);
    expect(exec1).toBeDefined();
    expect(exec1.verdict).toBe('PASSED');
    expect(exec1.status).toBe('COMPLETED');
    expect(exec1.test_run_id).toBe(seed.buildId);
    expect(exec1.test_plan_case_id).toBe(case1.test_plan_case_id);
    // tester_id is the real authenticated caller now, not the old hardcoded 'usr_tester_01' stub.
    expect(exec1.tester_id).toBe(adminId);

    const exec2 = verification.executions.find((e: any) => e.id === failData.result.id);
    expect(exec2).toBeDefined();
    expect(exec2.verdict).toBe('FAILED');
    expect(exec2.notes).toBe('Regressed token secret assertion - step 2 failed');
    expect(exec2.tester_id).toBe(adminId);

    // Verify step verdicts recorded
    expect(verification.steps.length).toBe(4);
    const failedStep = verification.steps.find((s: any) => s.verdict === 'FAILED');
    expect(failedStep).toBeDefined();
    expect(failedStep.actual_result).toBe('HTTP 500 Internal Error');

    // Verify append-only audit trail entries
    expect(verification.auditLogs.length).toBe(2);
    expect(verification.auditLogs[0].action).toBe('RESULT_RECORDED');
    // actor_id is the real authenticated caller now, not the old hardcoded 'usr_tester_01' stub.
    expect(verification.auditLogs[0].actor_id).toBe(adminId);

    // 5. Re-fetch workspace to confirm updated verdicts in queue list
    const updatedWorkspace = { cases: await planQueue(app, token, seed) };
    expect(updatedWorkspace.cases[0].latest_verdict).toBe('PASSED');
    expect(updatedWorkspace.cases[1].latest_verdict).toBe('FAILED');
    expect(updatedWorkspace.cases[2].latest_verdict).toBe('UNTESTED');
  });

  it('rejects execution recording with no token, and for an authenticated user without EXECUTE_RUN', async () => {
    const { app, db, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);

    const targetCase = (await planQueue(app, adminToken, seed))[0];

    const payload = {
      test_plan_case_id: targetCase.test_plan_case_id,
      verdict: 'PASSED',
    };

    // No token at all.
    const noAuthRes = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results`, payload });
    expect(noAuthRes.statusCode).toBe(401);

    // Provision a Viewer (the one role without EXECUTE_RUN) and log in as them.
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'readonly_viewer',
        email: 'readonly_viewer@testify.local',
        password: 'ReadonlyViewer1!',
        global_role: 'Viewer',
      },
    });
    const viewerLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'readonly_viewer', password: 'ReadonlyViewer1!' },
    });
    const viewerToken = JSON.parse(viewerLoginRes.payload).token as string;

    const forbiddenRes = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload,
    });
    expect(forbiddenRes.statusCode).toBe(403);

    // Neither attempt should have recorded an execution.
    expect((await readExecutionTables(db)).total_executions).toBe(0);
  });

  it('has no unauthenticated route that dumps results and audit logs', async () => {
    const res = await serverInstance.app.inject({ method: 'GET', url: '/api/v1/executions/verify' });
    expect(res.statusCode).toBe(404);
    // Nor the legacy, login-free GET /api/v1/workspace (removed 2026-10-08).
    expect((await serverInstance.app.inject({ method: 'GET', url: '/api/v1/workspace' })).statusCode).toBe(404);
  });
});
