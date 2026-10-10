import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRepository } from '@testify/db';
import { createServer } from '../src/server.js';
import { SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS } from '../src/sessionLifetime.js';

/** A sign-in lasts while it's used: 8 hours idle at most, 7 days after sign-in at most. */
describe('Session lifetime', () => {
  let app: any;
  let db: any;
  const HOUR = 3600_000;

  const login = (payload: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password', ...payload } });
  const me = (token: string) => app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}` } });
  const sessionOf = async (token: string) => {
    const sid = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sid;
    return db.selectFrom('sessions').selectAll().where('id', '=', sid).executeTakeFirstOrThrow();
  };
  const setSession = (id: string, values: Record<string, string>) => db.updateTable('sessions').set(values).where('id', '=', id).execute();

  beforeEach(async () => {
    ({ app, db } = await createServer());
  });
  afterEach(async () => {
    await app.close();
  });

  it('is 8 hours idle and 7 days at most', () => {
    expect(SESSION_IDLE_SECONDS).toBe(8 * 3600);
    expect(SESSION_MAX_SECONDS).toBe(7 * 24 * 3600);
  });

  it('signs in with a 7-day token and cookie, and an 8-hour session', async () => {
    const before = Date.now();
    const plain = JSON.parse((await login()).payload).token;
    const exp = JSON.parse(Buffer.from(plain.split('.')[1], 'base64url').toString()).exp * 1000;
    expect(exp - before).toBeGreaterThan(7 * 24 * HOUR - 60_000);
    const session = await sessionOf(plain);
    expect(new Date(session.expires_at).getTime() - before).toBeGreaterThan(8 * HOUR - 60_000);
    expect(new Date(session.expires_at).getTime() - before).toBeLessThan(8 * HOUR + 60_000);

    const cookieLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-testify-client': 'web' },
      payload: { username: 'admin', password: 'password', session: 'cookie' },
    });
    expect(String(cookieLogin.headers['set-cookie'])).toContain(`Max-Age=${SESSION_MAX_SECONDS}`);
  });

  it('each request extends the session; 8 hours unused ends it', async () => {
    const token = JSON.parse((await login()).payload).token;
    const session = await sessionOf(token);

    // Nearly idle for 8 hours: 10 minutes left. A request pushes the end back to 8 hours away.
    await setSession(session.id, { expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
    expect((await me(token)).statusCode).toBe(200);
    const extended = new Date((await sessionOf(token)).expires_at).getTime() - Date.now();
    expect(extended).toBeGreaterThan(8 * HOUR - 60_000);

    // Unused past the idle limit: ended.
    await setSession(session.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const ended = await me(token);
    expect(ended.statusCode).toBe(401);
    expect(JSON.parse(ended.payload).code).toBe('SESSION_ENDED');
  });

  it('never lasts more than 7 days after sign-in, however much it is used', async () => {
    const token = JSON.parse((await login()).payload).token;
    const session = await sessionOf(token);

    // Signed in 7 days ago minus 5 minutes: a request extends it only to the 7-day mark.
    const createdAt = Date.now() - 7 * 24 * HOUR + 5 * 60_000;
    await setSession(session.id, { created_at: new Date(createdAt).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect((await me(token)).statusCode).toBe(200);
    expect(new Date((await sessionOf(token)).expires_at).getTime()).toBe(createdAt + 7 * 24 * HOUR);

    // Past 7 days: refused, even though its stored end is still ahead.
    await setSession(session.id, {
      created_at: new Date(Date.now() - 7 * 24 * HOUR - 60_000).toISOString(),
      expires_at: new Date(Date.now() + HOUR).toISOString(),
    });
    expect((await me(token)).statusCode).toBe(401);
  });

  it('writes at most once a minute per session', async () => {
    const repo = new SessionRepository(db);
    const token = JSON.parse((await login()).payload).token;
    const session = await sessionOf(token);
    const now = new Date(new Date(session.created_at).getTime() + 30_000);
    // 30 s later the end would move by 30 s: no write.
    expect(await repo.extend(session, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS, now)).toBe(session.expires_at);
    // 2 minutes later it moves.
    const later = new Date(new Date(session.created_at).getTime() + 2 * 60_000);
    expect(await repo.extend(session, SESSION_IDLE_SECONDS, SESSION_MAX_SECONDS, later)).not.toBe(session.expires_at);
  });
});
