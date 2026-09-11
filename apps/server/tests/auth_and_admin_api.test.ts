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

  it('allows self-service password updates with password policy validation', async () => {
    // 1. Attempt update with weak password (<8 chars)
    const weakRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
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
    // 1. Provision a non-admin Tester user
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: {
        username: 'regular_tester',
        email: 'tester@testlink.local',
        password: 'TesterPassword1!',
        global_role: 'Tester',
      },
    });

    expect(createRes.statusCode).toBe(201);
    const testerId = JSON.parse(createRes.payload).user.id;

    // 2. Attempt username change as regular non-admin user -> 403 Forbidden
    const forbiddenRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/credentials',
      headers: {
        'x-user-id': testerId,
      },
      payload: {
        newUsername: 'hacker_username',
      },
    });

    expect(forbiddenRes.statusCode).toBe(403);
    expect(JSON.parse(forbiddenRes.payload).error).toContain('Only administrators can change usernames');
  });

  it('allows Admin to provision users, delegate permissions, and view security audit logs', async () => {
    // 1. Provision new user
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
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
    });

    expect(listRes.statusCode).toBe(200);
    const users = JSON.parse(listRes.payload).users;
    expect(users.length).toBeGreaterThanOrEqual(2);

    // 3. Delegate Admin role & USER_MANAGE to qa_alice
    const roleRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/users/${newUserId}/roles`,
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
    });

    expect(auditRes.statusCode).toBe(200);
    const auditLogs = JSON.parse(auditRes.payload).audit_logs;
    expect(auditLogs.length).toBeGreaterThan(0);
    expect(auditLogs.some((l: any) => l.action === 'USER_CREATED')).toBe(true);
    expect(auditLogs.some((l: any) => l.action === 'ROLE_ASSIGNED')).toBe(true);
  });
});
