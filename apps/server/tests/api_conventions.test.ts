import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../src/server.js';
import { RateLimiter } from '../src/services/rateLimits.js';

/**
 * API conventions that hold across every route (docs/api_roadmap.md step 1). Every error is
 * RFC 7807 problem details: `application/problem+json`, with `type`, `title`, `status` (the
 * HTTP status), a machine-readable `code`, a human-readable `detail`, the request path as
 * `instance`, and a `timestamp`.
 */
describe('API conventions: one error format', () => {
  let app: any;
  let seed: any;
  let admin: string;
  let viewer: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(payload !== undefined ? { payload } : {}),
    });

  beforeAll(async () => {
    ({ app, seed } = await createServer());
    // A test-only route that fails the way a bug would (routes can't be added once the server runs).
    app.get('/api/v1/__conventions/bug', async () => (undefined as any).id);
    const login = async (username: string, password: string) =>
      body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } })).token;
    admin = await login('admin', 'password');
    await call(admin, 'POST', '/api/v1/admin/users', { username: 'conv_viewer', email: 'conv_viewer@testify.local', password: 'SecurePass123!', global_role: 'Viewer' });
    viewer = await login('conv_viewer', 'SecurePass123!');
  });
  afterAll(async () => {
    await app.close();
  });

  const expectProblem = (res: any, status: number, code?: string) => {
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
    const b = body(res);
    expect(b).toMatchObject({ status, type: expect.stringMatching(/^https:\/\/api\.testify\.dev\/errors\/[A-Z_]+$/), title: expect.any(String) });
    expect(b.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    if (code) expect(b.code).toBe(code);
    expect(typeof b.detail).toBe('string');
    expect(b.detail.length).toBeGreaterThan(0);
    expect(b.instance).toMatch(/^\//);
    expect(b.timestamp).toEqual(expect.any(String));
    // The old shape is gone.
    expect(b).not.toHaveProperty('error');
    expect(b).not.toHaveProperty('message');
    return b;
  };

  it('400 (with extension members): an invalid request, bad JSON, and ids from different projects', async () => {
    expectProblem(await call(admin, 'POST', '/api/v1/projects', { prefix: 'NONAME' }), 400);
    expectProblem(await call(null, 'POST', '/api/v1/auth/login', '{"username": ', { 'content-type': 'application/json' }), 400);
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Conventions other', prefix: 'CONV' })).project;
    const otherSuite = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/suites`, { name: 'Elsewhere' })).suite;
    const mixed = expectProblem(await call(admin, 'POST', `/api/v1/plans/${seed.planId}/suites/${otherSuite.id}/cases`), 400, 'PROJECTS_DIFFER');
    expect(mixed.project_ids).toHaveLength(2);
  });

  it('401 and 403: no sign-in, an ended sign-in, and a missing permission', async () => {
    expectProblem(await call(null, 'GET', '/api/v1/projects'), 401);
    expectProblem(await call('not-a-real-token', 'GET', '/api/v1/projects'), 401, 'SESSION_ENDED');
    const b = expectProblem(await call(viewer, 'POST', '/api/v1/projects', { name: 'Nope', prefix: 'NOPE' }), 403);
    expect(b.required_permission).toBe('PROJECT_CREATE');
  });

  it('404: an unknown item and an unknown address', async () => {
    expectProblem(await call(admin, 'PATCH', '/api/v1/projects/00000000-0000-0000-0000-000000000000', { name: 'x' }), 404);
    expectProblem(await call(admin, 'GET', '/api/v1/no-such-route'), 404, 'NOT_FOUND');
  });

  it('409: a duplicate prefix, and deleting content without force', async () => {
    expectProblem(await call(admin, 'POST', '/api/v1/projects', { name: 'Dup', prefix: 'SHOP' }), 409);
    const b = expectProblem(await call(admin, 'DELETE', `/api/v1/projects/${seed.projectId}`), 409, 'PROJECT_IN_USE');
    expect(b.detail).toMatch(/contains/);
  });

  it('422: recording a result in a closed run', async () => {
    await call(admin, 'PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'CLOSED' });
    const planCase = body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`)).cases[0];
    expectProblem(
      await call(admin, 'POST', `/api/v1/runs/${seed.buildId}/results`, { test_plan_case_id: planCase.test_plan_case_id, verdict: 'PASSED' }),
      422,
      'RUN_CLOSED'
    );
    await call(admin, 'PATCH', `/api/v1/runs/${seed.buildId}`, { status: 'OPEN' });
  });

  it('400 with invalid_params as { name, reason }: a report with bad parameters', async () => {
    const b = expectProblem(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/reports/run_summary`, { limit: 0 }), 400, 'INVALID_PARAMS');
    expect(b.invalid_params).toEqual(expect.arrayContaining([{ name: 'test_run_id', reason: 'is required' }]));
  });

  it('413 and 429: a body too large, and a rate limit', async () => {
    expectProblem(
      await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/imports/dry-run`, { file_content: 'x'.repeat(6 * 1024 * 1024) }),
      413
    );
    app.rateLimits.exports = new RateLimiter(1, 60 * 60_000);
    const exportBody = { format: 'JSON', scope: { type: 'PROJECT' } };
    await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/exports/definitions`, exportBody);
    const limited = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/exports/definitions`, exportBody);
    expectProblem(limited, 429, 'RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  it('500: an unexpected error hides its details but carries a request id', async () => {
    const b = expectProblem(await call(null, 'GET', '/api/v1/__conventions/bug'), 500, 'INTERNAL_ERROR');
    expect(b.request_id).toEqual(expect.any(String));
    expect(JSON.stringify(b)).not.toContain('Cannot read');
  });
});

/**
 * Addresses, verbs and names (docs/api_roadmap.md step 1, stage 3): lists and creation sit under
 * the parent, each item has its own address; creating answers 201 with the item wrapped in its
 * name, deleting answers 204 with no body; runs and results are never called builds or executions.
 */
describe('API conventions: addresses, verbs and names', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });

  beforeAll(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterAll(async () => {
    await app.close();
  });

  const created = async (res: any, key: string) => {
    expect(res.statusCode).toBe(201);
    const item = body(res)[key];
    expect(item?.id).toEqual(expect.any(String));
    return item;
  };
  const deleted = (res: any) => {
    expect(res.statusCode).toBe(204);
    expect(res.payload).toBe('');
  };

  it('creating answers 201 with the item wrapped; deleting answers 204 with no body', async () => {
    const project = await created(await call('POST', '/api/v1/projects', { name: 'Shape', prefix: 'SHAPE' }), 'project');
    const plan = await created(await call('POST', `/api/v1/projects/${project.id}/plans`, { name: 'P' }), 'plan');
    const run = await created(await call('POST', `/api/v1/plans/${plan.id}/runs`, { name: 'R' }), 'run');
    const suite = await created(await call('POST', `/api/v1/projects/${project.id}/suites`, { name: 'S' }), 'suite');
    const testCase = await created(await call('POST', `/api/v1/projects/${project.id}/cases`, { test_suite_id: suite.id, title: 'C' }), 'test_case');
    const planCase = await created(await call('POST', `/api/v1/plans/${plan.id}/cases`, { test_case_id: testCase.id }), 'plan_case');
    expect(planCase.test_case_id).toBe(testCase.id);
    const field = await created(await call('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'shape_f', field_label: 'F', field_type: 'TEXT' }), 'definition');
    const role = await created(await call('POST', '/api/v1/admin/roles', { name: 'Shape role', permission_keys: ['SPEC_VIEW'] }), 'role');
    const token = await created(await call('POST', `/api/v1/projects/${project.id}/api-tokens`, { name: 't', capabilities: ['SPEC_VIEW'] }), 'token');
    const schedule = await created(
      await call('POST', `/api/v1/projects/${project.id}/report-schedules`, {
        name: 'Daily', sections: [{ kind: 'overview' }], recipients: 'a@example.com', frequency: 'DAILY', time_of_day: '09:00', timezone: 'UTC',
      }),
      'schedule'
    );
    await created(await call('POST', '/api/v1/admin/users', { username: 'shape_u', email: 'shape_u@testify.local', password: 'SecurePass123!', global_role: 'Viewer' }), 'user');

    deleted(await call('DELETE', `/api/v1/report-schedules/${schedule.id}`));
    deleted(await call('DELETE', `/api/v1/api-tokens/${token.id}`));
    deleted(await call('DELETE', `/api/v1/admin/roles/${role.id}`));
    deleted(await call('DELETE', `/api/v1/admin/custom-fields/${field.id}`));
    deleted(await call('DELETE', `/api/v1/plans/${plan.id}/cases/${testCase.id}`));
    deleted(await call('DELETE', `/api/v1/runs/${run.id}`));
    deleted(await call('DELETE', `/api/v1/plans/${plan.id}`));
    deleted(await call('DELETE', `/api/v1/cases/${testCase.id}`));
    deleted(await call('DELETE', `/api/v1/suites/${suite.id}`));
    deleted(await call('DELETE', `/api/v1/projects/${project.id}`));
  });

  it('partial updates are PATCH; the old PUT updates are gone', async () => {
    expect((await call('PATCH', `/api/v1/plans/${seed.planId}`, { name: 'Renamed' })).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/plans/${seed.planId}`, { name: 'Renamed' })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/v1/runs/${seed.buildId}`, { name: 'Run renamed' })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/v1/cases/${seed.caseIds[0]}`, { priority: 'LOW' })).statusCode).toBe(200);
    expect((await call('PATCH', `/api/v1/suites/${seed.suiteId}`, { description: 'd' })).statusCode).toBe(200);
  });

  it('no response calls a run a build or a result an execution', async () => {
    const queue = body(await call('GET', `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`));
    const one = body(await call('POST', `/api/v1/runs/${seed.buildId}/results`, { test_plan_case_id: queue.cases[0].test_plan_case_id, verdict: 'FAILED' }));
    const batch = body(await call('POST', `/api/v1/runs/${seed.buildId}/results/batch`, { results: [{ case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED' }] }));
    const responses = {
      queue,
      one,
      batch,
      runs: body(await call('GET', `/api/v1/plans/${seed.planId}/runs`)),
      specTree: body(await call('GET', `/api/v1/projects/${seed.projectId}/spec-tree?test_plan_id=${seed.planId}`)),
      export: body(await call('POST', `/api/v1/projects/${seed.projectId}/exports/results`, { format: 'NATIVE_JSON', test_run_id: seed.buildId })),
      summary: body(await call('POST', `/api/v1/projects/${seed.projectId}/reports/run_summary`, { test_run_id: seed.buildId })),
      history: body(await call('POST', `/api/v1/projects/${seed.projectId}/reports/case_history`, { test_case_id: seed.caseIds[0] })),
      catalog: body(await call('GET', `/api/v1/projects/${seed.projectId}/reports`)),
    };
    expect(one.run_status).toBe('OPEN');
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
    };
    walk(responses);
    const bad = [...keys].filter((k) => /build|execution/i.test(k) && k !== 'execution_type');
    expect(bad).toEqual([]);
  });

  it('the old addresses are gone (404)', async () => {
    const old: Array<[string, string]> = [
      ['GET', `/api/v1/test-plans/${seed.planId}/cases`],
      ['POST', '/api/v1/executions'],
      ['POST', `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`],
      ['GET', `/api/v1/projects/${seed.projectId}/plans/${seed.planId}/builds`],
      ['PUT', `/api/v1/projects/${seed.projectId}/plans/${seed.planId}`],
      ['POST', `/api/v1/projects/${seed.projectId}/test-cases`],
      ['POST', `/api/v1/projects/${seed.projectId}/test-suites`],
      ['GET', `/api/v1/test-cases/${seed.caseIds[0]}/latest-version`],
      ['GET', `/api/v1/test-cases/${seed.caseIds[0]}/custom-field-values`],
      ['POST', `/api/v1/test-plans/${seed.planId}/suites/${seed.suiteId}/cascade`],
      ['POST', `/api/v1/projects/${seed.projectId}/spec-move`],
      ['POST', '/api/v1/imports/dry-run'],
      ['POST', `/api/v1/projects/${seed.projectId}/exports/execution-results`],
      ['PUT', '/api/v1/auth/credentials'],
      ['GET', '/api/v1/admin/email-last'],
    ];
    for (const [method, url] of old) {
      const res = await call(method, url, method === 'GET' ? undefined : {});
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
  });
});
