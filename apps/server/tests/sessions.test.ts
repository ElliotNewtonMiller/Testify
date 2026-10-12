import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signJwt } from '@testify/core';
import { createServer } from '../src/server.js';

/** Sign-ins are server-side sessions: sign-out ends one, a password change ends the others. */
describe('Sessions', () => {
  const SECRET = 'sessions-test-secret-0123456789abcdef';
  let app: any;
  let db: any;
  let previousSecret: string | undefined;

  const body = (res: any) => JSON.parse(res.payload || '{}');
  const login = async (username: string, password: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return body(res).token as string;
  };
  const me = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode;
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

  beforeEach(async () => {
    previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    ({ app, db } = await createServer());
  });
  afterEach(async () => {
    await app.close();
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  it('signing out ends that session only', async () => {
    const laptop = await login('admin', 'password');
    const phone = await login('admin', 'password');
    expect(await me(laptop)).toBe(200);

    expect((await call(laptop, 'POST', '/api/v1/auth/logout')).statusCode).toBe(200);
    expect(await me(laptop)).toBe(401);
    expect(await me(phone)).toBe(200);

    // Signing out again, or with no token, is still a clean 200.
    expect((await call(laptop, 'POST', '/api/v1/auth/logout')).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout' })).statusCode).toBe(200);
  });

  it('a password change needs the current password and ends every other session', async () => {
    const laptop = await login('admin', 'password');
    const phone = await login('admin', 'password');

    let res = await call(laptop, 'PUT', '/api/v1/auth/credentials', { newPassword: 'a-brand-new-passphrase' });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe('CURRENT_PASSWORD_REQUIRED');
    res = await call(laptop, 'PUT', '/api/v1/auth/credentials', { newPassword: 'a-brand-new-passphrase', currentPassword: 'wrong' });
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('CURRENT_PASSWORD_INCORRECT');
    expect(await me(phone)).toBe(200); // refused attempts change nothing

    res = await call(laptop, 'PUT', '/api/v1/auth/credentials', { newPassword: 'a-brand-new-passphrase', currentPassword: 'password' });
    expect(res.statusCode).toBe(200);
    expect(await me(laptop)).toBe(200); // the session that made the change stays
    expect(await me(phone)).toBe(401);

    const audit = await db.selectFrom('audit_logs').select('diff').where('action', '=', 'CREDENTIALS_CHANGED').executeTakeFirst();
    expect(JSON.parse(audit.diff).other_sessions_ended).toBe(1);

    // Changing only the email doesn't need the password, and ends nothing.
    const tablet = await login('admin', 'a-brand-new-passphrase');
    expect((await call(laptop, 'PUT', '/api/v1/auth/credentials', { newEmail: 'root@testify.local' })).statusCode).toBe(200);
    expect(await me(tablet)).toBe(200);
  });

  it('refuses a validly signed token that names no live session', async () => {
    const admin = await db.selectFrom('users').select('id').where('username', '=', 'admin').executeTakeFirstOrThrow();
    // Signed with the real secret, but from before sessions existed (no sid) or with a made-up one.
    expect(await me(signJwt({ sub: admin.id }, SECRET))).toBe(401);
    expect(await me(signJwt({ sub: admin.id, sid: '00000000-0000-7000-8000-000000000000' }, SECRET))).toBe(401);
    // A real session id can't be reused for another user.
    const token = await login('admin', 'password');
    const sid = (await db.selectFrom('sessions').select('id').executeTakeFirstOrThrow()).id;
    const created = await call(token, 'POST', '/api/v1/admin/users', {
      username: 'other', email: 'other@testify.local', password: 'Other-Pass-123', global_role: 'Viewer',
    });
    expect(await me(signJwt({ sub: body(created).user.id, sid }, SECRET))).toBe(401);
  });

  it('disabling a user ends their sessions, and re-enabling does not revive them', async () => {
    const adminToken = await login('admin', 'password');
    const created = await call(adminToken, 'POST', '/api/v1/admin/users', {
      username: 'reader', email: 'reader@testify.local', password: 'Reader-Pass-123', global_role: 'Viewer',
    });
    const userId = body(created).user.id;
    const readerToken = await login('reader', 'Reader-Pass-123');
    expect(await me(readerToken)).toBe(200);

    await call(adminToken, 'PUT', `/api/v1/admin/users/${userId}/status`, { status: 'DISABLED' });
    await call(adminToken, 'PUT', `/api/v1/admin/users/${userId}/status`, { status: 'ACTIVE' });
    expect(await me(readerToken)).toBe(401);
    expect(await me(await login('reader', 'Reader-Pass-123'))).toBe(200);
  });
});
