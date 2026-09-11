import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.ts';
import type { Kysely } from 'kysely';
import type { Database } from '@testlink/db';

describe('Core Operational Loop E2E Integration Test', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  it('hydrates 10 seeded test cases and records optimistic + immutable verdict transitions', async () => {
    const { app, db, seed } = serverInstance;

    // 1. Hydrate Workspace - Verify 10 test cases are seeded
    const workspaceRes = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
    });

    expect(workspaceRes.statusCode).toBe(200);
    const workspace = JSON.parse(workspaceRes.body);

    expect(workspace.project.prefix).toBe('SHOP');
    expect(workspace.suites.length).toBe(1);
    expect(workspace.cases.length).toBe(10);
    expect(workspace.cases[0].external_id).toBe('SHOP-101');
    expect(workspace.cases[0].latest_verdict).toBe('UNTESTED');

    // 2. Simulate Single-Key Hotkey 'p' (Pass) on Case 1 (SHOP-101)
    const case1 = workspace.cases[0];
    const passRes = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      payload: {
        build_id: seed.buildId,
        test_plan_case_id: case1.plan_case_id,
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
    expect(passData.verdict).toBe('PASSED');

    // 3. Simulate Single-Key Hotkey 'f' (Fail) on Case 2 (SHOP-102)
    const case2 = workspace.cases[1];
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      payload: {
        build_id: seed.buildId,
        test_plan_case_id: case2.plan_case_id,
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
    expect(failData.verdict).toBe('FAILED');

    // 4. Verify Immutable Database Snapshots & Audit Trail
    const verifyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/executions/verify',
    });

    expect(verifyRes.statusCode).toBe(200);
    const verification = JSON.parse(verifyRes.body);

    expect(verification.total_executions).toBe(2);

    const exec1 = verification.executions.find((e: any) => e.id === passData.id);
    expect(exec1).toBeDefined();
    expect(exec1.verdict).toBe('PASSED');
    expect(exec1.status).toBe('COMPLETED');
    expect(exec1.build_id).toBe(seed.buildId);
    expect(exec1.test_plan_case_id).toBe(case1.plan_case_id);

    const exec2 = verification.executions.find((e: any) => e.id === failData.id);
    expect(exec2).toBeDefined();
    expect(exec2.verdict).toBe('FAILED');
    expect(exec2.notes).toBe('Regressed token secret assertion - step 2 failed');

    // Verify step verdicts recorded
    expect(verification.steps.length).toBe(4);
    const failedStep = verification.steps.find((s: any) => s.verdict === 'FAILED');
    expect(failedStep).toBeDefined();
    expect(failedStep.actual_result).toBe('HTTP 500 Internal Error');

    // Verify append-only audit trail entries
    expect(verification.auditLogs.length).toBe(2);
    expect(verification.auditLogs[0].action).toBe('EXECUTION_RECORDED');

    // 5. Re-fetch workspace to confirm updated verdicts in queue list
    const updatedWorkspaceRes = await app.inject({
      method: 'GET',
      url: '/api/v1/workspace',
    });

    const updatedWorkspace = JSON.parse(updatedWorkspaceRes.body);
    expect(updatedWorkspace.cases[0].latest_verdict).toBe('PASSED');
    expect(updatedWorkspace.cases[1].latest_verdict).toBe('FAILED');
    expect(updatedWorkspace.cases[2].latest_verdict).toBe('UNTESTED');
  });
});
