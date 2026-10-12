import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Admin routes: no privilege escalation, and never zero admins', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;
  let adminId: string;
  let managerToken: string;
  let managerId: string;

  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return body(res);
  };
  const roleId = async (name: string) =>
    body(await call(adminToken, 'GET', '/api/v1/admin/roles')).roles.find((r: any) => r.name === name).id;

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const admin = await login('admin', 'password');
    adminToken = admin.token;
    adminId = admin.user.id;

    // A user manager: can manage users, but is no admin.
    expect((await call(adminToken, 'POST', '/api/v1/admin/roles', { name: 'User Manager', permission_keys: ['USER_MANAGE', 'SPEC_VIEW'] })).statusCode).toBe(201);
    const created = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username: 'manager', email: 'manager@testify.local', password: 'Manager-Pass-123', global_role: 'User Manager',
    });
    expect(created.statusCode).toBe(201);
    managerId = body(created).user.id;
    managerToken = (await login('manager', 'Manager-Pass-123')).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it("a user manager can't make themselves or anyone else an admin, by any route", async () => {
    // 1. A role containing SYSTEM_ADMIN (or anything else they lack).
    let res = await call(managerToken, 'POST', '/api/v1/admin/roles', { name: 'Sneaky', permission_keys: ['SYSTEM_ADMIN'] });
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('PERMISSION_CEILING');
    expect(body(res).permissions).toEqual(['SYSTEM_ADMIN']);
    expect((await call(managerToken, 'POST', '/api/v1/admin/roles', { name: 'Readers', permission_keys: ['SPEC_VIEW'] })).statusCode).toBe(201);

    // 2. Giving themselves the Admin role, globally or in a project.
    res = await call(managerToken, 'PATCH', `/api/v1/admin/users/${managerId}/roles`, { global_role: 'Admin' });
    expect(body(res).code).toBe('PERMISSION_CEILING');
    res = await call(managerToken, 'PATCH', `/api/v1/admin/users/${managerId}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Admin' }] });
    expect(body(res).code).toBe('PERMISSION_CEILING');

    // 3. A SYSTEM_ADMIN override, globally or in a project.
    for (const project_id of [undefined, seed.projectId]) {
      res = await call(managerToken, 'PUT', `/api/v1/admin/users/${managerId}/permission-overrides`, {
        project_id, overrides: [{ permission_key: 'SYSTEM_ADMIN', is_granted: true }],
      });
      expect(res.statusCode).toBe(403);
    }

    // 4. Creating a new admin account.
    res = await call(managerToken, 'POST', '/api/v1/admin/users', {
      username: 'puppet', email: 'puppet@testify.local', password: 'Puppet-Pass-123', global_role: 'Admin',
    });
    expect(body(res).code).toBe('PERMISSION_CEILING');

    // 5. Adding permissions to their own role.
    res = await call(managerToken, 'PATCH', `/api/v1/admin/roles/${await roleId('User Manager')}`, { permission_keys: ['USER_MANAGE', 'SPEC_VIEW', 'PLAN_MANAGE'] });
    expect(body(res).code).toBe('PERMISSION_CEILING');

    // 6. Clearing a deny override to get back something an admin took away.
    await call(adminToken, 'PUT', `/api/v1/admin/users/${managerId}/permission-overrides`, { overrides: [{ permission_key: 'SPEC_VIEW', is_granted: false }] });
    managerToken = (await login('manager', 'Manager-Pass-123')).token;
    res = await call(managerToken, 'PUT', `/api/v1/admin/users/${managerId}/permission-overrides`, { overrides: [] });
    expect(body(res).code).toBe('PERMISSION_CEILING');
    expect(body(res).permissions).toEqual(['SPEC_VIEW']);

    // Nothing stuck: still no admin rights.
    const perms = body(await call(adminToken, 'GET', '/api/v1/admin/users')).users.find((u: any) => u.id === managerId).permissions;
    expect(perms).not.toContain('SYSTEM_ADMIN');
    expect(perms).not.toContain('SPEC_VIEW');
    expect(await db.selectFrom('users').select('username').where('username', '=', 'puppet').execute()).toEqual([]);
  });

  it("a user manager can't change admins or the roles that make them admins", async () => {
    let res = await call(managerToken, 'PATCH', `/api/v1/admin/users/${adminId}`, { status: 'DISABLED' });
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('TARGET_OUTRANKS_ACTOR');
    res = await call(managerToken, 'PATCH', `/api/v1/admin/users/${adminId}/roles`, { global_role: 'Viewer' });
    expect(body(res).code).toBe('TARGET_OUTRANKS_ACTOR');
    res = await call(managerToken, 'PUT', `/api/v1/admin/users/${adminId}/permission-overrides`, { overrides: [{ permission_key: 'SPEC_VIEW', is_granted: false }] });
    expect(body(res).code).toBe('TARGET_OUTRANKS_ACTOR');
    res = await call(managerToken, 'PATCH', `/api/v1/admin/roles/${await roleId('Admin')}`, { description: 'mine now' });
    expect(body(res).code).toBe('ROLE_OUTRANKS_ACTOR');
    res = await call(managerToken, 'DELETE', `/api/v1/admin/roles/${await roleId('Admin')}`);
    expect(body(res).code).toBe('ROLE_OUTRANKS_ACTOR');

    // Users with no more than the manager has are fine to manage.
    const viewer = await call(managerToken, 'POST', '/api/v1/admin/users', {
      username: 'reader', email: 'reader@testify.local', password: 'Reader-Pass-123', global_role: 'User Manager',
    });
    expect(viewer.statusCode).toBe(201);
    expect((await call(managerToken, 'PATCH', `/api/v1/admin/users/${body(viewer).user.id}`, { status: 'DISABLED' })).statusCode).toBe(200);
  });

  it('never leaves the system without an active admin', async () => {
    const lastAdmin = async (res: any) => {
      expect(res.statusCode).toBe(409);
      expect(body(res).code).toBe('LAST_ADMIN');
    };
    await lastAdmin(await call(adminToken, 'PATCH', `/api/v1/admin/users/${adminId}`, { status: 'DISABLED' }));
    await lastAdmin(await call(adminToken, 'PATCH', `/api/v1/admin/users/${adminId}/roles`, { global_role: 'Tester' }));
    await lastAdmin(await call(adminToken, 'PUT', `/api/v1/admin/users/${adminId}/permission-overrides`, { overrides: [{ permission_key: 'SYSTEM_ADMIN', is_granted: false }] }));
    await lastAdmin(await call(adminToken, 'PATCH', `/api/v1/admin/roles/${await roleId('Admin')}`, { permission_keys: ['USER_MANAGE'] }));

    // Every attempt was rolled back.
    const me = body(await call(adminToken, 'GET', '/api/v1/auth/me')).user;
    expect(me.global_role).toBe('Admin');
    expect(me.permissions).toContain('SYSTEM_ADMIN');
    const adminRole = body(await call(adminToken, 'GET', '/api/v1/admin/roles')).roles.find((r: any) => r.name === 'Admin');
    expect(adminRole.permission_keys).toContain('SYSTEM_ADMIN');

    // With a second admin, the first can step down.
    expect((await call(adminToken, 'PATCH', `/api/v1/admin/users/${managerId}/roles`, { global_role: 'Admin' })).statusCode).toBe(200);
    expect((await call(adminToken, 'PATCH', `/api/v1/admin/users/${adminId}/roles`, { global_role: 'Tester' })).statusCode).toBe(200);
  });

  it('an admin can still grant anything, including SYSTEM_ADMIN', async () => {
    expect((await call(adminToken, 'POST', '/api/v1/admin/roles', { name: 'Co-admin', permission_keys: ['SYSTEM_ADMIN'] })).statusCode).toBe(201);
    expect((await call(adminToken, 'PUT', `/api/v1/admin/users/${managerId}/permission-overrides`, { overrides: [{ permission_key: 'SYSTEM_ADMIN', is_granted: true }] })).statusCode).toBe(200);
  });
});
