import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { IpFailureLimiter, ACCOUNT_LOCK_THRESHOLD, IP_FAILURE_LIMIT } from '../src/services/loginThrottle.js';

describe('IpFailureLimiter', () => {
  it('blocks after the limit within the window, and frees up as failures age out', () => {
    const limiter = new IpFailureLimiter(3, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) limiter.recordFailure('1.2.3.4', t0 + i * 1000);
    expect(limiter.retryAfterSeconds('1.2.3.4', t0 + 3000)).toBe(57); // the oldest failure (t0) leaves the window at t0+60s
    expect(limiter.retryAfterSeconds('5.6.7.8', t0 + 3000)).toBe(0); // other addresses unaffected
    expect(limiter.retryAfterSeconds('1.2.3.4', t0 + 60_001)).toBe(0);
  });
});

describe('Sign-in limits', () => {
  let app: any;
  let db: any;

  const login = (username: string, password: string, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password }, remoteAddress });
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    ({ app, db } = await createServer());
  });
  afterEach(async () => {
    await app.close();
  });

  async function createUser(adminToken: string, username: string) {
    const res = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username, email: `${username}@testify.local`, password: 'Right-Pass-123', global_role: 'Viewer',
    });
    expect(res.statusCode).toBe(201);
    return body(res).user.id as string;
  }

  it('locks an account after repeated wrong passwords, even against the right one, until an admin unlocks it', { timeout: 60_000 }, async () => {
    const adminToken = body(await login('admin', 'password')).token;
    const userId = await createUser(adminToken, 'alice');

    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i++) {
      expect((await login('alice', 'wrong')).statusCode).toBe(401);
    }
    const locked = await login('alice', 'Right-Pass-123');
    expect(locked.statusCode).toBe(429);
    expect(body(locked).code).toBe('ACCOUNT_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(14 * 60);
    expect(body(locked).detail).toMatch(/locked/);

    // The admin sees the lock, and the lock is in the Security Audit Log.
    const listed = body(await call(adminToken, 'GET', '/api/v1/admin/users')).users.find((u: any) => u.id === userId);
    expect(listed.locked_until).toBeTruthy();
    const unlock = await call(adminToken, 'PUT', `/api/v1/admin/users/${userId}/status`, { status: 'ACTIVE' });
    expect(unlock.statusCode).toBe(200);
    const actions = body(await call(adminToken, 'GET', '/api/v1/admin/audit-logs')).audit_logs.map((l: any) => l.action);
    expect(actions).toContain('ACCOUNT_LOCKED');
    expect(actions).toContain('ACCOUNT_UNLOCKED');

    expect((await login('alice', 'Right-Pass-123')).statusCode).toBe(200);
  });

  it('a successful sign-in resets the count, and the lock expires on its own', { timeout: 60_000 }, async () => {
    const adminToken = body(await login('admin', 'password')).token;
    const userId = await createUser(adminToken, 'bob');
    // Each phase from its own address, so the per-address limit doesn't get in the way.
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD - 1; i++) await login('bob', 'wrong', '10.0.0.1');
    expect((await login('bob', 'Right-Pass-123', '10.0.0.1')).statusCode).toBe(200);
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD - 1; i++) await login('bob', 'wrong', '10.0.0.2');
    expect((await login('bob', 'Right-Pass-123', '10.0.0.2')).statusCode).toBe(200); // never reached the limit in a row

    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i++) await login('bob', 'wrong', '10.0.0.3');
    const locked = await login('bob', 'Right-Pass-123', '10.0.0.3');
    expect(locked.statusCode).toBe(429);
    expect(JSON.parse(locked.payload).code).toBe('ACCOUNT_LOCKED'); // the account lock, not the address limit
    await db.updateTable('users').set({ locked_until: new Date(Date.now() - 1000).toISOString() }).where('id', '=', userId).execute();
    expect((await login('bob', 'Right-Pass-123')).statusCode).toBe(200);
    const row = await db.selectFrom('users').select(['failed_login_count', 'locked_until']).where('id', '=', userId).executeTakeFirst();
    expect(row).toEqual({ failed_login_count: 0, locked_until: null });
  });

  it('wrong current passwords on the password-change form count toward the lock', { timeout: 60_000 }, async () => {
    const adminToken = body(await login('admin', 'password')).token;
    await createUser(adminToken, 'carol');
    const token = body(await login('carol', 'Right-Pass-123')).token;
    for (let i = 0; i < ACCOUNT_LOCK_THRESHOLD; i++) {
      const res = await call(token, 'PUT', '/api/v1/auth/credentials', { newPassword: 'a-new-long-passphrase', currentPassword: `guess-${i}` });
      expect(res.statusCode).toBe(403);
    }
    // Locked now: even the right current password is refused, and so is signing in.
    const res = await call(token, 'PUT', '/api/v1/auth/credentials', { newPassword: 'a-new-long-passphrase', currentPassword: 'Right-Pass-123' });
    expect(res.statusCode).toBe(429);
    expect(body(res).code).toBe('ACCOUNT_LOCKED');
    expect((await login('carol', 'Right-Pass-123')).statusCode).toBe(429);
  });

  it('blocks an address after too many failed sign-ins across any usernames', async () => {
    for (let i = 0; i < IP_FAILURE_LIMIT; i++) {
      expect((await login(`nobody-${i}`, 'wrong')).statusCode).toBe(401);
    }
    const blocked = await login('admin', 'password');
    expect(blocked.statusCode).toBe(429);
    expect(body(blocked).code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  }, 60_000);
});
