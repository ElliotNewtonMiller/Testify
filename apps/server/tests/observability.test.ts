import { describe, it, expect, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { createDbClient } from '@testify/db';
import { createServer } from '../src/server.js';
import { ConfigError, resolveJwtSecret, resolveLogLevel } from '../src/config.js';

/** A log stream that keeps every JSON line written to it. */
function captureLog() {
  const lines: any[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(line));
      done();
    },
  });
  return { stream, lines, raw: () => lines.map((l) => JSON.stringify(l)).join('\n') };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}

describe('Startup configuration', () => {
  it('JWT_SECRET: required on a real database, at least 32 characters, random only for the in-memory one', () => {
    const secret = 'a'.repeat(32);
    expect(resolveJwtSecret({ inMemory: false }, { JWT_SECRET: secret })).toBe(secret);
    expect(resolveJwtSecret({ inMemory: true }, { JWT_SECRET: secret })).toBe(secret);
    expect(() => resolveJwtSecret({ inMemory: false }, {})).toThrow(/JWT_SECRET is not set/);
    expect(() => resolveJwtSecret({ inMemory: true }, { JWT_SECRET: 'short' })).toThrow(ConfigError);
    const a = resolveJwtSecret({ inMemory: true }, {});
    expect(a).toHaveLength(64);
    expect(resolveJwtSecret({ inMemory: true }, {})).not.toBe(a);
  });

  it('LOG_LEVEL: info by default, silent in tests, refused when unknown', () => {
    expect(resolveLogLevel({})).toBe('info');
    expect(resolveLogLevel({ NODE_ENV: 'test' })).toBe('silent');
    expect(resolveLogLevel({ NODE_ENV: 'test', LOG_LEVEL: 'debug' })).toBe('debug');
    expect(resolveLogLevel({ LOG_LEVEL: ' WARN ' })).toBe('warn');
    expect(() => resolveLogLevel({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL must be one of/);
  });

  it('a server on a real database without JWT_SECRET refuses to start', async () => {
    const db = createDbClient();
    try {
      await withEnv({ JWT_SECRET: undefined }, async () => {
        await expect(createServer('postgres://unused/testify', { db })).rejects.toThrow(ConfigError);
      });
    } finally {
      await db.destroy();
    }
  });
});

describe('Health check and request logging', () => {
  let app: any;
  afterEach(async () => {
    await app?.close();
  });

  it('GET /api/v1/health needs no sign-in, says ok while the database answers and 503 once it does not', async () => {
    ({ app } = await createServer());
    const ok = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(ok.payload)).toEqual({ status: 'ok', database: 'ok', uptime_seconds: expect.any(Number) });
    expect((await app.inject({ method: 'HEAD', url: '/api/v1/health' })).statusCode).toBe(200);

    // A database that has gone away: the health check reports it rather than hanging or erroring.
    const { app: second, db: secondDb } = await createServer();
    await secondDb.destroy();
    const down = await second.inject({ method: 'GET', url: '/api/v1/health' });
    expect(down.statusCode).toBe(503);
    expect(JSON.parse(down.payload)).toMatchObject({ status: 'unavailable', database: 'unreachable' });
    await second.close();
  });

  it('logs one line per request with who made it, never headers or bodies; replies carry the request id', async () => {
    const log = captureLog();
    ({ app } = await withEnv({ LOG_LEVEL: 'info' }, () => createServer(undefined, { logStream: log.stream })));
    app.get('/api/v1/test-only/boom', async () => {
      throw new TypeError('secret internals');
    });

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    const token = JSON.parse(login.payload).token;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${token}`, cookie: 'testify_session=abc' } });
    await app.inject({ method: 'GET', url: '/api/v1/health' });
    const boom = await app.inject({ method: 'GET', url: '/api/v1/test-only/boom' });

    const requests = log.lines.filter((l) => l.msg === 'request');
    expect(requests.map((l) => [l.method, l.url, l.status_code])).toEqual([
      ['POST', '/api/v1/auth/login', 200],
      ['GET', '/api/v1/auth/me', 200],
      ['GET', '/api/v1/test-only/boom', 500],
    ]); // the successful health check isn't logged at info
    const meLine = requests[1];
    expect(meLine.user_id).toEqual(expect.any(String));
    expect(meLine.response_time_ms).toEqual(expect.any(Number));
    expect(meLine.reqId).toMatch(/^[0-9a-f-]{36}$/);
    expect(me.headers['x-request-id']).toBe(meLine.reqId);

    // The unexpected error is logged with its request id, which the reply also gives.
    const errorLine = log.lines.find((l) => l.msg === 'Unexpected error');
    expect(errorLine).toMatchObject({ level: 50, reqId: JSON.parse(boom.payload).request_id });
    expect(errorLine.err.message).toBe('secret internals');
    expect(boom.payload).not.toContain('secret internals');

    // No credentials anywhere in the log.
    for (const secret of [token, 'password', 'testify_session=abc', 'Bearer']) expect(log.raw()).not.toContain(secret);
  });
});
