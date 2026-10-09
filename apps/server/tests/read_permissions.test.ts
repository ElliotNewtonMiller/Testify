import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Read routes need SPEC_VIEW on the project they read, not just a login. */
describe('Read routes require SPEC_VIEW', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;

  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) =>
    body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } }));
  const createUser = async (username: string, role: string) => {
    const res = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username, email: `${username}@testify.local`, password: 'Reader-Pass-123', global_role: role,
    });
    expect(res.statusCode).toBe(201);
    return { id: body(res).user.id as string, token: (await login(username, 'Reader-Pass-123')).token as string };
  };

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    adminToken = (await login('admin', 'password')).token;
  });
  afterEach(async () => {
    await app.close();
  });

  const readRoutes = () => {
    const caseId = seed.caseIds[0];
    return [
      `/api/v1/projects/${seed.projectId}/plans`,
      `/api/v1/projects/${seed.projectId}/plans/${seed.planId}/builds`,
      `/api/v1/projects/${seed.projectId}/spec-tree`,
      `/api/v1/test-cases/${caseId}/latest-version`,
      `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`,
      `/api/v1/test-cases/${caseId}/custom-field-values`,
      `/api/v1/test-suites/${seed.suiteId}/custom-field-values`,
    ];
  };

  it('a user without SPEC_VIEW gets 403 on every read, and sees no projects', async () => {
    // Can export but neither view the spec nor execute (EXECUTE_RUN alone may read what running
    // tests needs -- see execute_only_access.test.ts).
    expect((await call(adminToken, 'POST', '/api/v1/admin/roles', { name: 'Exporter Only', permission_keys: ['EXPORT_DATA'] })).statusCode).toBe(201);
    const runner = await createUser('runner', 'Exporter Only');
    for (const url of readRoutes()) {
      expect((await call(runner.token, 'GET', url)).statusCode, url).toBe(403);
    }
    expect(body(await call(runner.token, 'GET', '/api/v1/projects')).projects).toEqual([]);

    // A Viewer reads all of them.
    const viewer = await createUser('reader', 'Viewer');
    for (const url of readRoutes()) {
      expect((await call(viewer.token, 'GET', url)).statusCode, url).toBe(200);
    }
    expect(body(await call(viewer.token, 'GET', '/api/v1/projects')).projects.map((p: any) => p.id)).toContain(seed.projectId);
  }, 30_000); // many requests; slow under full-suite load

  it('a per-project deny hides that project only', async () => {
    const other = body(await call(adminToken, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const viewer = await createUser('reader', 'Viewer');
    await call(adminToken, 'PUT', `/api/v1/admin/users/${viewer.id}/permission-overrides`, {
      project_id: seed.projectId, overrides: [{ permission_key: 'SPEC_VIEW', is_granted: false }],
    });
    const token = (await login('reader', 'Reader-Pass-123')).token;
    expect(body(await call(token, 'GET', '/api/v1/projects')).projects.map((p: any) => p.id)).toEqual([other.id]);
    for (const url of readRoutes()) {
      expect((await call(token, 'GET', url)).statusCode, url).toBe(403);
    }
    expect((await call(token, 'GET', `/api/v1/projects/${other.id}/spec-tree`)).statusCode).toBe(200);
  });

  it('an API token lists only its own project', async () => {
    const other = body(await call(adminToken, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const minted = await call(adminToken, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW'] });
    const token = body(minted).plaintext;
    expect(body(await call(token, 'GET', '/api/v1/projects')).projects.map((p: any) => p.id)).toEqual([other.id]);
  });

  it("a plan from another project can't be read through this project's path", async () => {
    const other = body(await call(adminToken, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    expect((await call(adminToken, 'GET', `/api/v1/projects/${other.id}/plans/${seed.planId}/builds`)).statusCode).toBe(404);
    expect((await call(adminToken, 'GET', `/api/v1/projects/${other.id}/spec-tree?plan_id=${seed.planId}`)).statusCode).toBe(404);
  });
});
