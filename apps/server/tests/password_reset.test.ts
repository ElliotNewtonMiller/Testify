import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** An administrator resets another user's forgotten password. */
describe('Admin password reset', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;
  let adminId: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });
  const login = (username: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
  const reset = (token: string, userId: string, payload: unknown = {}) =>
    call(token, 'POST', `/api/v1/admin/users/${userId}/reset-password`, payload);

  async function createUser(username: string, global_role: string) {
    const res = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username,
      email: `${username}@testify.local`,
      password: 'SecurePass123!',
      global_role,
    });
    expect(res.statusCode).toBe(201);
    return body(res).user.id as string;
  }

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const res = body(await login('admin', 'password'));
    adminToken = res.token;
    adminId = res.user.id;
  });
  afterEach(async () => {
    await app.close();
  });

  it('gives a temporary password, signs the user out, clears a lock, and makes them choose a new one', async () => {
    const userId = await createUser('forgetful', 'Tester');
    const oldSession = body(await login('forgetful', 'SecurePass123!')).token;
    for (let i = 0; i < 20; i++) await login('forgetful', 'wrong-password'); // now locked
    expect((await login('forgetful', 'SecurePass123!')).statusCode).toBe(429);

    const res = await reset(adminToken, userId);
    expect(res.statusCode).toBe(200);
    const temp = body(res).temporary_password;
    expect(temp).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(body(res)).toMatchObject({ must_change_password: true, sessions_ended: 1 });

    expect((await call(oldSession, 'GET', '/api/v1/auth/me')).statusCode).toBe(401);
    expect((await login('forgetful', 'SecurePass123!')).statusCode).toBe(401);

    const signedIn = await login('forgetful', temp);
    expect(signedIn.statusCode).toBe(200); // the lock was cleared
    const token = body(signedIn).token;
    expect(body(signedIn).user.must_change_password).toBe(true);
    expect((await call(token, 'GET', '/api/v1/projects')).statusCode).toBe(403);

    const changed = await call(token, 'PUT', '/api/v1/auth/credentials', { currentPassword: temp, newPassword: 'MyOwnPass456!' });
    expect(changed.statusCode).toBe(200);
    expect((await call(token, 'GET', '/api/v1/projects')).statusCode).toBe(200);

    // Audited, without the password.
    const audit = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'PASSWORD_RESET').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: adminId, resource_id: userId });
    expect(audit[0].diff).not.toContain(temp);
    // ...and shown in the Admin Panel's Security Audit Log.
    expect((await call(adminToken, 'GET', '/api/v1/admin/audit-logs')).payload).toContain('PASSWORD_RESET');
  });

  it('can set a chosen password (checked against the policy, never echoed)', async () => {
    const userId = await createUser('chosen', 'Viewer');
    const weak = await reset(adminToken, userId, { password: 'short' });
    expect(weak.statusCode).toBe(400);
    expect(body(weak).code).toBe('PASSWORD_POLICY_VIOLATION');
    expect((await login('chosen', 'SecurePass123!')).statusCode).toBe(200); // unchanged

    const ok = await reset(adminToken, userId, { password: 'TempPass789!' });
    expect(ok.statusCode).toBe(200);
    expect(body(ok).temporary_password).toBeUndefined();
    expect(body(await login('chosen', 'TempPass789!')).user.must_change_password).toBe(true);
  });

  it("isn't for your own account, someone with more access, or anyone without USER_MANAGE", async () => {
    expect(body(await reset(adminToken, adminId)).code).toBe('CANNOT_RESET_OWN_PASSWORD');
    expect((await reset(adminToken, 'no-such-user')).statusCode).toBe(404);

    // A user manager holding a Tester's permissions can reset a Tester (the rank rule: you can
    // only reset someone whose permissions you also have), but not an admin, nor someone who
    // is an admin in just one project -- that would hand them that person's access.
    const managerKeys = ['USER_MANAGE', 'SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT', 'EXECUTE_RUN', 'EXPORT_DATA'];
    expect((await call(adminToken, 'POST', '/api/v1/admin/roles', { name: 'User Manager', permission_keys: managerKeys })).statusCode).toBe(201);
    await createUser('manager', 'User Manager');
    const managerToken = body(await login('manager', 'SecurePass123!')).token;
    const testerId = await createUser('plain_tester', 'Tester');
    const projectAdminId = await createUser('project_admin_x', 'Viewer');
    expect(
      (await call(adminToken, 'PUT', `/api/v1/admin/users/${projectAdminId}/roles`, { project_roles: [{ project_id: seed.projectId, role: 'Admin' }] })).statusCode
    ).toBe(200);

    expect((await reset(managerToken, testerId)).statusCode).toBe(200);
    for (const target of [adminId, projectAdminId]) {
      const res = await reset(managerToken, target);
      expect(res.statusCode).toBe(403);
      expect(body(res).code).toBe('TARGET_OUTRANKS_ACTOR');
    }
    expect((await login('admin', 'password')).statusCode).toBe(200); // untouched
    expect((await login('project_admin_x', 'SecurePass123!')).statusCode).toBe(200);

    // A Tester has no USER_MANAGE at all.
    await createUser('other_tester', 'Tester');
    const testerToken = body(await login('other_tester', 'SecurePass123!')).token;
    const viewerId = await createUser('some_viewer', 'Viewer');
    expect((await reset(testerToken, viewerId)).statusCode).toBe(403);
  });
});
