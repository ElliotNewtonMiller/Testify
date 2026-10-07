import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Admin: template roles & per-user permission overrides', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

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

  async function createAndLoginViewer(app: any, adminToken: string): Promise<{ token: string; userId: string }> {
    const username = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username,
        email: `${username}@testify.local`,
        password: 'SecurePass123!',
        global_role: 'Viewer',
      },
    });
    expect(createRes.statusCode).toBe(201);
    const userId = JSON.parse(createRes.payload).user.id as string;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId };
  }

  it('every new route requires USER_MANAGE -- a Viewer gets 403 on all of them', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginViewer(app, adminToken);

    // Except the permission-name list, which any signed-in user may read (the API Tokens and
    // Custom Fields tabs need it without USER_MANAGE) -- but not anonymously.
    const registry = await app.inject({ method: 'GET', url: '/api/v1/admin/permissions', headers: { authorization: `Bearer ${viewerToken}` } });
    expect(registry.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/permissions' })).statusCode).toBe(401);

    const attempts = [
      { method: 'GET', url: '/api/v1/admin/roles' },
      { method: 'POST', url: '/api/v1/admin/roles', payload: { name: 'X', permission_keys: [] } },
      { method: 'PUT', url: '/api/v1/admin/roles/nonexistent', payload: { name: 'X' } },
      { method: 'DELETE', url: '/api/v1/admin/roles/nonexistent' },
      { method: 'GET', url: '/api/v1/admin/users/nonexistent/permission-overrides' },
      { method: 'PUT', url: '/api/v1/admin/users/nonexistent/permission-overrides', payload: { overrides: [] } },
    ] as const;

    for (const attempt of attempts) {
      const res = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: 'payload' in attempt ? attempt.payload : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('GET /api/v1/admin/permissions returns the 19-key registry', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/permissions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const permissions = JSON.parse(res.payload).permissions;
    expect(permissions).toHaveLength(19);
    expect(permissions.map((p: any) => p.key)).toContain('SYSTEM_ADMIN');
  });

  it('GET /api/v1/admin/roles lists the 5 seeded defaults, each marked is_system_role', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const roles = JSON.parse(res.payload).roles;
    expect(roles).toHaveLength(5);
    expect(roles.every((r: any) => r.is_system_role === true)).toBe(true);
  });

  it('POST/PUT/DELETE role CRUD happy path', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Regression Auditor', description: 'Read + export only', permission_keys: ['SPEC_VIEW', 'EXPORT_DATA'] },
    });
    expect(createRes.statusCode).toBe(201);
    const role = JSON.parse(createRes.payload).role;
    expect(role.is_system_role).toBe(false);
    expect(role.permission_keys.sort()).toEqual(['EXPORT_DATA', 'SPEC_VIEW']);

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/roles/${role.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { permission_keys: ['SPEC_VIEW', 'EXPORT_DATA', 'PLAN_MANAGE'] },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.payload).role.permission_keys.sort()).toEqual([
      'EXPORT_DATA',
      'PLAN_MANAGE',
      'SPEC_VIEW',
    ]);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/roles/${role.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);
  });

  it('POST /api/v1/admin/roles rejects an unknown permission key (400) and a duplicate name (409)', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const badKeyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Bad Role', permission_keys: ['NOT_A_REAL_KEY'] },
    });
    expect(badKeyRes.statusCode).toBe(400);

    const dupNameRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Tester', permission_keys: [] },
    });
    expect(dupNameRes.statusCode).toBe(409);
  });

  it('DELETE a role currently assigned to a user returns 409 ROLE_IN_USE with the affected count', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const rolesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${token}` },
    });
    const viewerRole = JSON.parse(rolesRes.payload).roles.find((r: any) => r.name === 'Viewer');

    // Assign the Viewer role to a real user (the admin-created viewer already holds it)
    await createAndLoginViewer(app, token);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/roles/${viewerRole.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(409);
    const body = JSON.parse(deleteRes.payload);
    expect(body.code).toBe('ROLE_IN_USE');
    expect(body.invalid_params[0].reason).toContain('1 user');
  });

  it('PUT /api/v1/admin/users/:id/roles rejects an unknown role name with 400', async () => {
    const { app } = serverInstance;
    const { token, userId: adminId } = await loginAsAdmin(app);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${adminId}/roles`,
      headers: { authorization: `Bearer ${token}` },
      payload: { global_role: 'NotARealRole' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('permission-overrides GET/PUT round-trip at global scope, and immediately reflects in the returned permissions', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { userId: viewerId } = await createAndLoginViewer(app, adminToken);

    const emptyRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(JSON.parse(emptyRes.payload).overrides).toEqual([]);

    const putRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { overrides: [{ permission_key: 'PLAN_MANAGE', is_granted: true }] },
    });
    expect(putRes.statusCode).toBe(200);
    const putBody = JSON.parse(putRes.payload);
    expect(putBody.overrides).toEqual([{ permission_key: 'PLAN_MANAGE', is_granted: true }]);
    expect(putBody.permissions).toContain('PLAN_MANAGE');

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(JSON.parse(getRes.payload).overrides).toEqual([{ permission_key: 'PLAN_MANAGE', is_granted: true }]);
  });

  it('a project-scoped override wins a conflict with a global override for the same user/key', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { userId: viewerId } = await createAndLoginViewer(app, adminToken);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { overrides: [{ permission_key: 'PLAN_MANAGE', is_granted: true }] },
    });

    const projectPutRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        project_id: seed.projectId,
        overrides: [{ permission_key: 'PLAN_MANAGE', is_granted: false }],
      },
    });
    expect(projectPutRes.statusCode).toBe(200);
    expect(JSON.parse(projectPutRes.payload).permissions).not.toContain('PLAN_MANAGE');

    // Global scope (no project_id) is unaffected by the project-scoped write
    const globalGetRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(JSON.parse(globalGetRes.payload).overrides).toEqual([
      { permission_key: 'PLAN_MANAGE', is_granted: true },
    ]);

    // Project-scoped GET returns the project-specific row
    const projectGetRes = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides?project_id=${seed.projectId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(JSON.parse(projectGetRes.payload).overrides).toEqual([
      { permission_key: 'PLAN_MANAGE', is_granted: false },
    ]);
  });

  it('PUT permission-overrides rejects an unknown permission key with 400', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { userId: viewerId } = await createAndLoginViewer(app, adminToken);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { overrides: [{ permission_key: 'NOT_REAL', is_granted: true }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/v1/admin/users includes each user\'s global overrides alongside resolved permissions', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { userId: viewerId } = await createAndLoginViewer(app, adminToken);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${viewerId}/permission-overrides`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { overrides: [{ permission_key: 'PLAN_MANAGE', is_granted: true }] },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const users = JSON.parse(res.payload).users;
    const viewer = users.find((u: any) => u.id === viewerId);
    expect(viewer.overrides).toEqual([{ permission_key: 'PLAN_MANAGE', is_granted: true }]);
    expect(viewer.permissions).toContain('PLAN_MANAGE');
  });
});
