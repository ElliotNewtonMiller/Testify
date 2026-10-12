import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from '../src/server.js';

/**
 * The OpenAPI spec and docs page (docs/api_roadmap.md step 3). Every other server test also
 * checks its responses against the spec (createServer's `checkResponses`, on in tests).
 */
describe('OpenAPI spec and docs page', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${admin}` }, ...(payload !== undefined ? { payload } : {}) });

  beforeAll(async () => {
    ({ app, seed } = await createServer());
    // Test-only routes (routes can't be added once the server runs).
    app.get(
      '/api/v1/__openapi/wrong',
      { schema: { response: { 200: { type: 'object', properties: { a: { type: 'string' } } } } } },
      async () => ({ a: 1, extra: true })
    );
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterAll(async () => {
    await app.close();
  });

  it('serves the docs page and the spec without a sign-in', async () => {
    const page = await app.inject({ url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    const initializer = await app.inject({ url: '/docs/static/swagger-initializer.js' });
    expect(initializer.statusCode).toBe(200);
    // "Try it out" with the session cookie needs the CSRF header.
    expect(initializer.payload).toContain('X-Testify-Client');
    expect((await app.inject({ url: '/docs/json' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/docs/yaml' })).statusCode).toBe(200);
  });

  it('is an OpenAPI 3.1 document whose references all resolve, and documents the first area completely', async () => {
    const spec = body(await app.inject({ url: '/docs/json' }));
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Testify API');
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['bearerAuth', 'sessionCookie']);

    const refs = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === '$ref' ? refs.add(String(x)) : walk(x);
    };
    walk(spec);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\//);
      expect(spec.components.schemas[ref.split('/').pop()!], ref).toBeDefined();
    }

    const operations: string[] = [];
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const [method, op] of Object.entries<any>(item)) {
        operations.push(`${method.toUpperCase()} ${path}`);
        expect(op.summary, `${method} ${path}`).toEqual(expect.any(String));
        expect(op.tags?.length, `${method} ${path}`).toBeGreaterThan(0);
        expect(Object.keys(op.responses).some((s) => /^2/.test(s)), `${method} ${path}`).toBe(true);
      }
    }
    expect(operations).toEqual(
      expect.arrayContaining([
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'GET /api/v1/auth/me',
        'PATCH /api/v1/auth/me',
        'GET /api/v1/projects',
        'POST /api/v1/projects',
        'PATCH /api/v1/projects/{projectId}',
        'DELETE /api/v1/projects/{projectId}',
        'GET /api/v1/projects/{projectId}/plans',
        'POST /api/v1/projects/{projectId}/plans',
        'PATCH /api/v1/plans/{planId}',
        'DELETE /api/v1/plans/{planId}',
        'GET /api/v1/plans/{planId}/runs',
        'POST /api/v1/plans/{planId}/runs',
        'PATCH /api/v1/runs/{runId}',
        'DELETE /api/v1/runs/{runId}',
        'POST /api/v1/runs/{runId}/results',
        'POST /api/v1/runs/{runId}/results/batch',
      ])
    );
    // Sign-in needs no credential; everything else does.
    expect(spec.paths['/api/v1/auth/login'].post.security).toEqual([]);
    expect(spec.security).toEqual([{ bearerAuth: [] }, { sessionCookie: [] }]);
  });

  it('refuses a request that does not match its schema with problem details naming each field', async () => {
    const res = await call('POST', '/api/v1/projects', { prefix: 42, description: 7 });
    expect(res.statusCode).toBe(400);
    expect(body(res)).toMatchObject({
      code: 'INVALID_REQUEST',
      invalid_params: expect.arrayContaining([
        { name: 'name', reason: 'is required' },
        { name: 'prefix', reason: 'must be a string' },
        { name: 'description', reason: 'must be a string or null' },
      ]),
    });
    const status = await call('PATCH', `/api/v1/plans/${seed.planId}`, { status: 'DONE' });
    expect(body(status).invalid_params).toEqual([{ name: 'status', reason: 'must be one of: ACTIVE, LOCKED, ARCHIVED' }]);
    // Bodies aren't coerced: a number isn't a string.
    expect((await call('POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 5 })).statusCode).toBe(400);
    // A body the route checks itself keeps its own, more specific error.
    const result = await call('POST', `/api/v1/runs/${seed.buildId}/results`, { verdict: 'MAYBE' });
    expect(body(result).code).toBe('INVALID_RESULT');
  });

  it('fails loudly when a response does not match its documented schema', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await app.inject({ url: '/api/v1/__openapi/wrong' });
    expect(res.statusCode).toBe(500);
    expect(logged.mock.calls.flat().join(' ')).toMatch(/extra isn't a known field; a must be a string/);
    logged.mockRestore();
  });
});
