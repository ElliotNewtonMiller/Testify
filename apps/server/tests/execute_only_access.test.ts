import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Someone who may only record results (EXECUTE_RUN) can find their plan and run and work through
 * it, but can't browse the rest of the spec or change plans and runs. */
describe('EXECUTE_RUN without SPEC_VIEW', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;
  let runnerToken: string;
  let removedCaseId: string;

  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) =>
    body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })).token as string;

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    adminToken = await login('admin', 'password');
    expect((await call(adminToken, 'POST', '/api/v1/admin/roles', { name: 'Runner', permission_keys: ['EXECUTE_RUN'] })).statusCode).toBe(201);
    expect((await call(adminToken, 'POST', '/api/v1/admin/users', {
      username: 'runner', email: 'runner@testify.local', password: 'Runner-Pass-123', global_role: 'Runner',
    })).statusCode).toBe(201);
    runnerToken = await login('runner', 'Runner-Pass-123');
    // One case of the project that isn't in the plan.
    removedCaseId = seed.caseIds[9];
    expect((await call(adminToken, 'DELETE', `/api/v1/plans/${seed.planId}/cases/${removedCaseId}`)).statusCode).toBe(204);
  });
  afterEach(async () => {
    await app.close();
  });

  it('can see the project, its plans and runs, and the run queue, and record a result', async () => {
    expect(body(await call(runnerToken, 'GET', '/api/v1/projects')).projects.map((p: any) => p.id)).toContain(seed.projectId);
    expect(body(await call(runnerToken, 'GET', `/api/v1/projects/${seed.projectId}/plans`)).plans.map((p: any) => p.id)).toContain(seed.planId);
    expect(body(await call(runnerToken, 'GET', `/api/v1/plans/${seed.planId}/runs`)).runs.map((b: any) => b.id)).toContain(seed.buildId);
    const queue = body(await call(runnerToken, 'GET', `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`)).cases;
    expect(queue).toHaveLength(9);
    expect((await call(runnerToken, 'GET', `/api/v1/cases/${queue[0].test_case_id}/custom-fields`)).statusCode).toBe(200);
    expect((await call(runnerToken, 'GET', `/api/v1/projects/${seed.projectId}/case-search/fields`)).statusCode).toBe(200);

    const recorded = await call(runnerToken, 'POST', `/api/v1/runs/${seed.buildId}/results`, { test_plan_case_id: queue[0].test_plan_case_id, verdict: 'PASSED' });
    expect(recorded.statusCode).toBe(201);
  });

  it("sees only the plan's cases and their folders in the suite tree", async () => {
    const tree = body(await call(runnerToken, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree?test_plan_id=${seed.planId}`));
    expect(tree.cases).toHaveLength(9);
    expect(tree.cases.map((c: any) => c.id)).not.toContain(removedCaseId);
    expect(tree.suites).toHaveLength(1);
    // With no plan selected there's nothing to show; a spec viewer still sees everything.
    expect(body(await call(runnerToken, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree`)).cases).toEqual([]);
    expect(body(await call(adminToken, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree`)).cases).toHaveLength(10);
  });

  it("can't browse the full spec or reports, or change projects, plans or runs", async () => {
    for (const url of [
      `/api/v1/cases/${seed.caseIds[0]}/versions/latest`,
      `/api/v1/suites/${seed.suiteId}/custom-fields`,
      `/api/v1/projects/${seed.projectId}/reports`,
    ]) {
      expect((await call(runnerToken, 'GET', url)).statusCode, url).toBe(403);
    }
    const changes: Array<[string, string, unknown?]> = [
      ['POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'Mine' }],
      ['PATCH', `/api/v1/plans/${seed.planId}`, { name: 'Renamed' }],
      ['DELETE', `/api/v1/plans/${seed.planId}`],
      ['POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Run 9' }],
      ['PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' }],
      ['DELETE', `/api/v1/runs/${seed.buildId}`],
      ['POST', `/api/v1/plans/${seed.planId}/cases`, { test_case_id: removedCaseId }],
      ['POST', '/api/v1/projects', { name: 'X', prefix: 'XX' }],
    ];
    for (const [method, url, payload] of changes) {
      expect((await call(runnerToken, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);
    }
  });
});
