import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Limiting a user to some projects: the No Access global role plus project roles. */
describe('Per-project access', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });

  async function createUser(globalRole: string): Promise<{ id: string; token: string }> {
    const username = `u_${Math.random().toString(36).slice(2)}`;
    const created = await call(admin, 'POST', '/api/v1/admin/users', { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } });
    return { id: body(created).user.id, token: body(login).token };
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('No Access is a built-in role that grants nothing; such a user sees no projects', async () => {
    const roles = body(await call(admin, 'GET', '/api/v1/admin/roles')).roles;
    const noAccess = roles.find((r: any) => r.name === 'No Access');
    expect(noAccess).toMatchObject({ is_system_role: true, permission_keys: [] });
    expect(noAccess.description).toMatch(/project role/);

    const user = await createUser('No Access');
    expect(body(await call(user.token, 'GET', '/api/v1/auth/me')).user.permissions).toEqual([]);
    expect(body(await call(user.token, 'GET', '/api/v1/projects')).projects).toEqual([]);
    expect((await call(user.token, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree`)).statusCode).toBe(403);
  });

  it('a project role gives access to just that project, including projects created later staying hidden', async () => {
    const user = await createUser('No Access');
    const assigned = await call(admin, 'PATCH', `/api/v1/admin/users/${user.id}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Tester' }] });
    expect(assigned.statusCode).toBe(200);

    const later = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Later', prefix: 'LTR' })).project;

    // The list shows only their project, with what they may do there.
    const projects = body(await call(user.token, 'GET', '/api/v1/projects')).projects;
    expect(projects.map((p: any) => p.id)).toEqual([seed.projectId]);
    expect([...projects[0].permissions].sort()).toEqual(['EXECUTE_RUN', 'EXPORT_DATA', 'SPEC_CREATE', 'SPEC_EDIT', 'SPEC_VIEW']);

    // They work in it as a Tester...
    expect((await call(user.token, 'GET', `/api/v1/projects/${seed.projectId}/spec-tree`)).statusCode).toBe(200);
    const suite = await call(user.token, 'POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Mine' });
    expect(suite.statusCode).toBe(201);
    // ...and nowhere else.
    expect((await call(user.token, 'GET', `/api/v1/projects/${later.id}/plans`)).statusCode).toBe(403);
    expect((await call(user.token, 'POST', `/api/v1/projects/${later.id}/suites`, { name: 'Nope' })).statusCode).toBe(403);
  });

  it('the project list carries each project\'s own permissions, which can differ from the global role', async () => {
    const user = await createUser('Viewer');
    await call(admin, 'PATCH', `/api/v1/admin/users/${user.id}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Test Lead' }] });
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;

    const projects = body(await call(user.token, 'GET', '/api/v1/projects')).projects;
    const byId = Object.fromEntries(projects.map((p: any) => [p.id, p.permissions]));
    expect(byId[seed.projectId]).toContain('PLAN_MANAGE'); // Test Lead here
    expect(byId[other.id]).toEqual(['SPEC_VIEW', 'EXPORT_DATA']); // Viewer elsewhere

    // An admin's list carries the full set.
    const adminProjects = body(await call(admin, 'GET', '/api/v1/projects')).projects;
    expect(adminProjects.every((p: any) => p.permissions.includes('SYSTEM_ADMIN'))).toBe(true);
  });
});
