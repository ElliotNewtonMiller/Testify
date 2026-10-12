import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createDbClient } from '@testify/db';
import { resolveInitialAdminPassword, ConfigError } from '../src/config.js';
import { createServer } from '../src/server.js';

describe('resolveInitialAdminPassword', () => {
  it('uses ADMIN_PASSWORD when set, and refuses one that fails the password policy', () => {
    expect(resolveInitialAdminPassword({ inMemory: false }, { ADMIN_PASSWORD: 'Correct-Horse-Battery-1' })).toEqual({
      password: 'Correct-Horse-Battery-1',
      mustChangePassword: false,
      source: 'env',
    });
    expect(() => resolveInitialAdminPassword({ inMemory: false }, { ADMIN_PASSWORD: 'password' })).toThrow(ConfigError);
  });

  it('keeps admin/password only for the throwaway in-memory database', () => {
    expect(resolveInitialAdminPassword({ inMemory: true }, {})).toMatchObject({ password: 'password', mustChangePassword: false });
  });

  it('generates a random password that must be changed for a real database', () => {
    const a = resolveInitialAdminPassword({ inMemory: false }, {});
    const b = resolveInitialAdminPassword({ inMemory: false }, {});
    expect(a.source).toBe('generated');
    expect(a.mustChangePassword).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(16);
    expect(a.password).not.toBe(b.password);
    expect(a.password).not.toBe('password');
  });
});

describe('A user who must change their password', () => {
  let app: any;
  let db: any;

  beforeAll(async () => {
    ({ app, db } = await createServer());
    await db.updateTable('users').set({ must_change_password: true }).where('username', '=', 'admin').execute();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (method: string, url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  it('can only see who they are and change their password until they do', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(login.statusCode).toBe(200);
    const { token, user } = JSON.parse(login.payload);
    expect(user.must_change_password).toBe(true);

    const blocked = await call('GET', '/api/v1/projects', token);
    expect(blocked.statusCode).toBe(403);
    expect(JSON.parse(blocked.payload).code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await call('POST', '/mcp', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).statusCode).toBe(403);

    const me = await call('GET', '/api/v1/auth/me', token);
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.payload).user.must_change_password).toBe(true);

    // Has to actually pick a new, different, policy-compliant password.
    expect(JSON.parse((await call('PUT', '/api/v1/auth/credentials', token, { newEmail: 'a@b.c' })).payload).code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(JSON.parse((await call('PUT', '/api/v1/auth/credentials', token, { newPassword: 'password', currentPassword: 'password' })).payload).code).toBe('PASSWORD_UNCHANGED');
    expect((await call('PUT', '/api/v1/auth/credentials', token, { newPassword: 'short', currentPassword: 'password' })).statusCode).toBe(400);

    const changed = await call('PUT', '/api/v1/auth/credentials', token, { newPassword: 'a-long-new-admin-passphrase', currentPassword: 'password' });
    expect(changed.statusCode).toBe(200);
    expect(JSON.parse(changed.payload).user.must_change_password).toBe(false);

    // The same session now works, and only the new password signs in.
    expect((await call('GET', '/api/v1/projects', token)).statusCode).toBe(200);
    const old = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(old.statusCode).toBe(401);
  });

  it('login no longer re-creates an admin when there are no users', async () => {
    await db.deleteFrom('user_roles').execute();
    await db.deleteFrom('users').execute();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(res.statusCode).toBe(401);
    expect(await db.selectFrom('users').select('id').execute()).toEqual([]);
  });
});

describe('First start against a real database', () => {
  it('creates the admin with a generated password, printed once, that must be changed', async () => {
    const db = createDbClient(); // stands in for a real Postgres; the connection string marks it as one
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'initial-admin-test-secret-0123456789'; // a real database requires one
    try {
      const { app } = await createServer('postgres://unused/testify', { db });
      const printed = warn.mock.calls.map((c) => String(c[0])).join('\n');
      const password = /password: (\S+)/.exec(printed)?.[1];
      expect(password).toBeTruthy();
      expect(password).not.toBe('password');

      const weak = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
      expect(weak.statusCode).toBe(401);
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password } });
      expect(login.statusCode).toBe(200);
      expect(JSON.parse(login.payload).user.must_change_password).toBe(true);
      // No dev fixture users on a real database.
      expect((await db.selectFrom('users').select('username').execute()).map((u: any) => u.username)).toEqual(['admin']);
      await app.close();

      // A restart doesn't print (or change) anything.
      warn.mockClear();
      const second = await createServer('postgres://unused/testify', { db });
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Created the first admin'))).toBe(false);
      await second.app.close();
    } finally {
      warn.mockRestore();
      if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousJwtSecret;
      await db.destroy();
    }
  }, 30_000);
});
