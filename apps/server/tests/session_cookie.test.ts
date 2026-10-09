import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** The web app signs in with an HttpOnly cookie instead of keeping a token in localStorage. */
describe('Session cookie (web sign-in)', () => {
  let app: any;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const CLIENT = { 'x-testify-client': 'web' };

  const cookieLogin = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: CLIENT,
      payload: { username: 'admin', password: 'password', session: 'cookie' },
    });
    expect(res.statusCode).toBe(200);
    return res;
  };
  const cookiePair = (res: any) => String(res.headers['set-cookie']).split(';')[0];

  beforeEach(async () => {
    ({ app } = await createServer());
  });
  afterEach(async () => {
    await app.close();
  });

  it('sets an HttpOnly, SameSite=Strict cookie and leaves the token out of the response', async () => {
    const res = await cookieLogin();
    expect(body(res).token).toBeUndefined();
    expect(body(res).user.username).toBe('admin');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^testify_session=[^;]+;/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/api');
    expect(setCookie).toMatch(/Max-Age=\d+/);
    expect(setCookie).not.toContain('Secure'); // plain http in tests; added over https

    // Over https (as seen through a trusted proxy) the cookie is Secure.
    const secureApp = (await createServer()).app;
    try {
      // inject has no TLS; simulate the protocol Fastify reports.
      secureApp.addHook('onRequest', async (request: any) => {
        Object.defineProperty(request, 'protocol', { value: 'https' });
      });
      const secureRes = await secureApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: CLIENT,
        payload: { username: 'admin', password: 'password', session: 'cookie' },
      });
      expect(String(secureRes.headers['set-cookie'])).toContain('; Secure');
    } finally {
      await secureApp.close();
    }

    // Without `session: "cookie"` (API clients, scripts) the token is returned as before, no cookie.
    const plain = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(typeof body(plain).token).toBe('string');
    expect(plain.headers['set-cookie']).toBeUndefined();
  });

  it('authenticates reads with the cookie, and changes only with the client header', async () => {
    const cookie = cookiePair(await cookieLogin());

    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie } })).statusCode).toBe(200);

    // A change with the cookie but no header (what a cross-site form could send) is refused,
    // and nothing is created.
    const forged = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie }, payload: { name: 'Forged', prefix: 'FRG' } });
    expect(forged.statusCode).toBe(403);
    expect(body(forged).code).toBe('CSRF_HEADER_MISSING');
    const wrongValue = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { cookie, 'x-testify-client': 'other' },
      payload: { name: 'Forged', prefix: 'FRG' },
    });
    expect(wrongValue.statusCode).toBe(403);

    const ok = await app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie, ...CLIENT }, payload: { name: 'Real', prefix: 'REAL' } });
    expect(ok.statusCode).toBe(201);
    const projects = body(await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { cookie } })).projects;
    expect(projects.map((p: any) => p.prefix)).toContain('REAL');
    expect(projects.map((p: any) => p.prefix)).not.toContain('FRG');

    // A Bearer header needs no client header, and wins over a cookie.
    const adminToken = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    const bearer = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${adminToken}`, cookie: 'testify_session=garbage' },
      payload: { name: 'Via token', prefix: 'TOK' },
    });
    expect(bearer.statusCode).toBe(201);
  });

  it('refuses a cookie login without the client header, and an API token placed in the cookie', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password', session: 'cookie' } });
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('CSRF_HEADER_MISSING');
    expect(res.headers['set-cookie']).toBeUndefined();

    const viaCookie = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: 'testify_session=tf_ci_abc' } });
    expect(viaCookie.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: 'testify_session=not-a-jwt' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: 'other=1' } })).statusCode).toBe(401);
  });

  it('signing out ends the session and clears the cookie', async () => {
    const cookie = cookiePair(await cookieLogin());
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, ...CLIENT } });
    expect(out.statusCode).toBe(200);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/^testify_session=;/);
    expect(cleared).toContain('Max-Age=0');

    // The old cookie value no longer works even if a copy was kept.
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
});
