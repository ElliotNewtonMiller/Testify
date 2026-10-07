import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * Routes that aren't nested under /projects/:projectId used to skip the API-token project
 * check and evaluate a user's permissions globally (ignoring per-project roles and overrides).
 * The project is now resolved from the ids they name (resolveRequestProject).
 */
describe('Project scoping on routes not nested under /projects/:projectId', () => {
  let app: any;
  let db: any;
  let seed: any; // project A: the seeded sample project
  let adminToken: string;
  let projectB: string;
  let suiteB: string;

  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) =>
    body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }));

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    adminToken = (await login('admin', 'password')).token;
    const project = await call(adminToken, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' });
    projectB = body(project).project.id;
    suiteB = body(await call(adminToken, 'POST', `/api/v1/projects/${projectB}/test-suites`, { name: 'B suite' })).suite.id;
  });
  afterEach(async () => {
    await app.close();
  });

  async function planCaseA() {
    return db
      .selectFrom('test_plan_cases')
      .select(['id', 'test_case_id'])
      .where('test_plan_id', '=', seed.planId)
      .where('removed_at', 'is', null)
      .executeTakeFirstOrThrow();
  }

  it("a token for project B can't read or change project A through them", async () => {
    const minted = await call(adminToken, 'POST', `/api/v1/projects/${projectB}/api-tokens`, {
      name: 'ci-b', capabilities: ['SPEC_VIEW', 'EXECUTE_RUN', 'PLAN_MANAGE'],
    });
    expect(minted.statusCode).toBe(201);
    const tokenB = body(minted).plaintext;
    const pc = await planCaseA();
    const caseA = pc.test_case_id;

    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/api/v1/executions', { build_id: seed.buildId, test_plan_case_id: pc.id, verdict: 'PASSED' }],
      ['GET', `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`],
      ['POST', `/api/v1/test-plans/${seed.planId}/cases`, { test_case_id: caseA }],
      ['DELETE', `/api/v1/test-plans/${seed.planId}/cases/${caseA}?force=true`],
      ['POST', `/api/v1/test-plans/${seed.planId}/suites/${seed.suiteId}/cascade`, { action: 'REMOVE', force: true }],
      ['GET', `/api/v1/test-cases/${caseA}/latest-version`],
      ['GET', `/api/v1/test-cases/${caseA}/custom-field-values`],
      ['GET', `/api/v1/test-suites/${seed.suiteId}/custom-field-values`],
    ];
    for (const [method, url, payload] of attempts) {
      const res = await call(tokenB, method, url, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(body(res).type ?? body(res).code ?? '', `${method} ${url}`).toMatch(/TOKEN_PROJECT_MISMATCH|token-project-mismatch/i);
    }

    // Nothing changed in project A.
    expect(await db.selectFrom('executions').select('id').execute()).toEqual([]);
    expect((await db.selectFrom('test_plan_cases').select('id').where('test_plan_id', '=', seed.planId).execute()).length).toBe(10);

    // The token still works on its own project.
    expect((await call(tokenB, 'GET', `/api/v1/test-suites/${suiteB}/custom-field-values`)).statusCode).toBe(200);
  });

  it("a user's per-project role and overrides now apply on these routes", async () => {
    const created = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username: 'scoped', email: 'scoped@testify.local', password: 'Scoped-Pass-123', global_role: 'Tester',
    });
    const userId = body(created).user.id;
    const pc = await planCaseA();

    // Tester has no PLAN_MANAGE globally...
    let token = (await login('scoped', 'Scoped-Pass-123')).token;
    expect((await call(token, 'DELETE', `/api/v1/test-plans/${seed.planId}/cases/${pc.test_case_id}`)).statusCode).toBe(403);

    // ...but as Test Lead in project A they can curate A's plan.
    await call(adminToken, 'PUT', `/api/v1/admin/users/${userId}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Test Lead' }] });
    token = (await login('scoped', 'Scoped-Pass-123')).token;
    expect((await call(token, 'DELETE', `/api/v1/test-plans/${seed.planId}/cases/${pc.test_case_id}`)).statusCode).toBe(204);
    expect((await call(token, 'POST', `/api/v1/test-plans/${seed.planId}/cases`, { test_case_id: pc.test_case_id })).statusCode).toBe(201);

    // A deny override in project A blocks recording results there, though the role allows it.
    await call(adminToken, 'PUT', `/api/v1/admin/users/${userId}/permission-overrides`, {
      project_id: seed.projectId, overrides: [{ permission_key: 'EXECUTE_RUN', is_granted: false }],
    });
    const pcNow = await planCaseA();
    const rec = await call(token, 'POST', '/api/v1/executions', { build_id: seed.buildId, test_plan_case_id: pcNow.id, verdict: 'PASSED' });
    expect(rec.statusCode).toBe(403);
    expect(await db.selectFrom('executions').select('id').execute()).toEqual([]);
  });

  it('refuses a request whose ids belong to different projects', async () => {
    const res = await call(adminToken, 'POST', `/api/v1/test-plans/${seed.planId}/suites/${suiteB}/cascade`, { action: 'ADD' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('PROJECTS_DIFFER');
  });
});
