import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { resolveCorsOrigins, ConfigError } from '../src/config.js';

describe('resolveCorsOrigins (CORS_ORIGINS)', () => {
  it('is empty by default, normalizes listed origins, and refuses "*" and anything that is not an origin', () => {
    expect(resolveCorsOrigins({})).toEqual([]);
    expect(resolveCorsOrigins({ CORS_ORIGINS: ' https://a.example.com , http://localhost:5173/ ,https://a.example.com' })).toEqual([
      'https://a.example.com',
      'http://localhost:5173',
    ]);
    for (const bad of ['*', 'a.example.com', 'https://a.example.com/app', 'ftp://a.example.com']) {
      expect(() => resolveCorsOrigins({ CORS_ORIGINS: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe('CORS headers', () => {
  let app: any;
  const previous = process.env.CORS_ORIGINS;
  afterEach(async () => {
    await app?.close();
    if (previous === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = previous;
  });

  const preflight = () =>
    app.inject({
      method: 'OPTIONS',
      url: '/api/v1/projects',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });

  it('allows no other origin by default', async () => {
    delete process.env.CORS_ORIGINS;
    ({ app } = await createServer());
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect((await preflight()).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows exactly the listed origins', async () => {
    process.env.CORS_ORIGINS = 'https://testify.example.com';
    ({ app } = await createServer());
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { origin: 'https://testify.example.com' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://testify.example.com');
    const other = await app.inject({ method: 'GET', url: '/api/v1/projects', headers: { origin: 'https://evil.example' } });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect((await preflight()).headers['access-control-allow-origin']).toBeUndefined();
  });
});
