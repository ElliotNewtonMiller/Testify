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
    const otherSuite = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/test-suites`, { name: 'Elsewhere' })).suite;
    const mixed = expectProblem(await call(admin, 'POST', `/api/v1/test-plans/${seed.planId}/suites/${otherSuite.id}/cascade`, { action: 'ADD' }), 400, 'PROJECTS_DIFFER');
    expect(mixed.project_ids).toHaveLength(2);
  });

  it('401 and 403: no sign-in, an ended sign-in, and a missing permission', async () => {
    expectProblem(await call(null, 'GET', '/api/v1/projects'), 401);
    expectProblem(await call('not-a-real-token', 'GET', '/api/v1/projects'), 401, 'SESSION_ENDED');
    const b = expectProblem(await call(viewer, 'POST', '/api/v1/projects', { name: 'Nope', prefix: 'NOPE' }), 403);
    expect(b.required_permission).toBe('PROJECT_CREATE');
  });

  it('404: an unknown item and an unknown address', async () => {
    expectProblem(await call(admin, 'PUT', '/api/v1/projects/00000000-0000-0000-0000-000000000000', { name: 'x' }), 404);
    expectProblem(await call(admin, 'GET', '/api/v1/no-such-route'), 404, 'NOT_FOUND');
  });

  it('409: a duplicate prefix, and deleting content without force', async () => {
    expectProblem(await call(admin, 'POST', '/api/v1/projects', { name: 'Dup', prefix: 'SHOP' }), 409);
    const b = expectProblem(await call(admin, 'DELETE', `/api/v1/projects/${seed.projectId}`), 409, 'PROJECT_IN_USE');
    expect(b.detail).toMatch(/contains/);
  });

  it('422: recording a result in a closed run', async () => {
    await call(admin, 'PUT', `/api/v1/projects/${seed.projectId}/plans/${seed.planId}/builds/${seed.buildId}`, { status: 'CLOSED' });
    const planCase = body(await call(admin, 'GET', `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`)).cases[0];
    expectProblem(
      await call(admin, 'POST', '/api/v1/executions', { build_id: seed.buildId, test_plan_case_id: planCase.plan_case_id, verdict: 'PASSED' }),
      422,
      'BUILD_CLOSED'
    );
    await call(admin, 'PUT', `/api/v1/projects/${seed.projectId}/plans/${seed.planId}/builds/${seed.buildId}`, { status: 'OPEN' });
  });

  it('400 with invalid_params as { name, reason }: a report with bad parameters', async () => {
    const b = expectProblem(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/reports/run_summary`, { limit: 0 }), 400, 'INVALID_PARAMS');
    expect(b.invalid_params).toEqual(expect.arrayContaining([{ name: 'run_id', reason: 'is required' }]));
  });

  it('413 and 429: a body too large, and a rate limit', async () => {
    expectProblem(
      await call(admin, 'POST', '/api/v1/imports/dry-run', { target_project_id: seed.projectId, file_content: 'x'.repeat(6 * 1024 * 1024) }),
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
