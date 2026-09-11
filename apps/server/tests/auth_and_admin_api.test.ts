import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

describe('Auth & Admin API Integration Tests', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const serverObj = await createServer();
    app = serverObj.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  /** Logs in as the seeded initial admin and returns a real, signed Bearer token. */
  async function loginAsAdmin(password = 'password'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  it('allows initial superuser (admin / password) login and returns admin profile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'admin',
        password: 'password',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(typeof body.token).toBe('string');
    // A real JWT is three base64url segments, not the old unsigned base64 blob.
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.user.username).toBe('admin');
    expect(body.user.global_role).toBe('Admin');
    expect(body.user.permissions).toContain('SYSTEM_ADMIN');
    expect(body.user.permissions).toContain('USER_MANAGE');
  });

  it('rejects login with invalid credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'admin',
        password: 'wrongpassword',
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.payload);
    expect(body.error).toBe('Invalid credentials or user account disabled');
  });

  it('handles logout request cleanly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).message).toContain('logged out');
  });

  it('rejects requests to authenticated routes with no token, a malformed token, or the old unsigned-blob format', async () => {
    const noAuthRes = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(noAuthRes.statusCode).toBe(401);

    const malformedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(malformedRes.statusCode).toBe(401);

    // The previous scheme's "token" was just base64(JSON) with no signature -- anyone could forge
    // one. It must no longer be accepted.
    const forgedLegacyToken = Buffer.from(
      JSON.stringify({ userId: 'usr_admin_seed', username: 'admin', exp: Date.now() + 15 * 60 * 1000 })
    ).toString('base64');
    const legacyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${forgedLegacyToken}` },
    });
    expect(legacyRes.statusCode).toBe(401);

    // The old X-User-Id impersonation header must no longer grant access either.
    const impersonationRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { 'x-user-id': 'usr_admin_seed' },
    });
    expect(impersonationRes.statusCode).toBe(401);
  });

  it('allows self-service password updates with password policy validation', async () => {
    const token = await loginAsAdmin();
    const authHeaders = { authorization: `Bearer ${token}` };

    // 1. Attempt update with weak password (<8 chars)
    const weakRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
      headers: authHeaders,
      payload: {
        newPassword: 'weak',
      },
    });

    expect(weakRes.statusCode).toBe(400);
    expect(JSON.parse(weakRes.payload).error).toContain('PASSWORD_POLICY_VIOLATION');

    // 2. Update with valid password (>=16 chars)
    const validRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
      headers: authHeaders,
      payload: {
        newPassword: 'correct horse battery staple 2026',
      },
    });

    expect(validRes.statusCode).toBe(200);

    // 3. Verify login with new password
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'admin',
        password: 'correct horse battery staple 2026',
      },
    });

    expect(loginRes.statusCode).toBe(200);
  });

  it('restricts username changes to administrators only', async () => {
    const adminToken = await loginAsAdmin();

    // 1. Provision a non-admin Tester user
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'regular_tester',
        email: 'tester@testlink.local',
        password: 'TesterPassword1!',
        global_role: 'Tester',
      },
    });

    expect(createRes.statusCode).toBe(201);

    // 2. Log in as that Tester user to get a real token for them (no more x-user-id backdoor).
    const testerLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: 'regular_tester',
        password: 'TesterPassword1!',
      },
    });
    expect(testerLoginRes.statusCode).toBe(200);
    const testerToken = JSON.parse(testerLoginRes.payload).token as string;

    // 3. Attempt username change as regular non-admin user -> 403 Forbidden
    const forbiddenRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
      headers: {
        authorization: `Bearer ${testerToken}`,
      },
      payload: {
        newUsername: 'hacker_username',
      },
    });

    expect(forbiddenRes.statusCode).toBe(403);
    expect(JSON.parse(forbiddenRes.payload).error).toContain('Only administrators can change usernames');
  });

  it('allows Admin to provision users, delegate permissions, and view security audit logs', async () => {
    const adminToken = await loginAsAdmin();
    const authHeaders = { authorization: `Bearer ${adminToken}` };

    // 1. Provision new user
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: authHeaders,
      payload: {
        username: 'qa_alice',
        email: 'alice@testlink.local',
        password: 'AlicePassword1!',
        global_role: 'Tester',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const newUserId = JSON.parse(createRes.payload).user.id;

    // 2. Get user roster
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: authHeaders,
    });

    expect(listRes.statusCode).toBe(200);
    const users = JSON.parse(listRes.payload).users;
    expect(users.length).toBeGreaterThanOrEqual(2);

    // 3. Delegate Admin role & USER_MANAGE to qa_alice
    const roleRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${newUserId}/roles`,
      headers: authHeaders,
      payload: {
        global_role: 'Admin',
      },
    });

    expect(roleRes.statusCode).toBe(200);
    expect(JSON.parse(roleRes.payload).user.permissions).toContain('USER_MANAGE');

    // 4. Inspect filtered security audit logs
    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs',
      headers: authHeaders,
    });

    expect(auditRes.statusCode).toBe(200);
    const auditLogs = JSON.parse(auditRes.payload).audit_logs;
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs.some((l: any) => l.action === 'USER_CREATED')).toBe(true);
    expect(auditLogs.some((l: any) => l.action === 'ROLE_ASSIGNED')).toBe(true);
  });

  it('rejects admin routes for an authenticated user without USER_MANAGE permission', async () => {
    const adminToken = await loginAsAdmin();

    // Provision a plain Tester (no USER_MANAGE) and log in as them.
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username: 'plain_tester',
        email: 'plain_tester@testlink.local',
        password: 'PlainTester1!',
        global_role: 'Tester',
      },
    });

    const testerLoginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'plain_tester', password: 'PlainTester1!' },
    });
    const testerToken = JSON.parse(testerLoginRes.payload).token as string;

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${testerToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});
