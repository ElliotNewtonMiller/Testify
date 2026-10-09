import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Audit entries record the real client address and User-Agent, not made-up values. */
describe('Audit log origin', () => {
  let app: any;
  let db: any;
  let previousTrustProxy: string | undefined;
  const body = (res: any) => JSON.parse(res.payload || '{}');

  afterEach(async () => {
    await app?.close();
    if (previousTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = previousTrustProxy;
  });

  it('every audited action records where it came from', async () => {
    let seed: any;
    ({ app, db, seed } = await createServer());
    const client = { remoteAddress: '203.0.113.7' };
    const agent = 'TestClient/1.0 (audit test)';
    const send = (method: string, url: string, payload?: unknown, token?: string) =>
      app.inject({
        method,
        url,
        ...client,
        headers: { 'user-agent': agent, ...(token ? { authorization: `Bearer ${token}` } : {}) },
        payload,
      });

    const token = body(await send('POST', '/api/v1/auth/login', { username: 'admin', password: 'password' })).token;
    const before = new Set((await db.selectFrom('audit_logs').select('id').execute()).map((r: any) => r.id));

    // A spread of audited actions across different routes and helpers.
    const project = body(await send('POST', '/api/v1/projects', { name: 'Audited', prefix: 'AUD' }, token)).project;
    const plan = body(await send('POST', `/api/v1/projects/${project.id}/plans`, { name: 'P' }, token)).plan;
    expect((await send('POST', `/api/v1/projects/${project.id}/plans/${plan.id}/builds`, { name: 'R' }, token)).statusCode).toBe(201);
    expect((await send('POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'aud_f', field_label: 'F', field_type: 'TEXT' }, token)).statusCode).toBe(201);
    expect((await send('POST', `/api/v1/projects/${seed.projectId}/test-cases`, { test_suite_id: seed.suiteId, title: 'Audited case' }, token)).statusCode).toBe(201);
    expect((await send('POST', `/api/v1/projects/${seed.projectId}/exports/definitions`, { format: 'JSON', scope: { type: 'PROJECT' } }, token)).statusCode).toBe(200);
    const queue = body(await send('GET', `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`, undefined, token)).cases;
    expect((await send('POST', '/api/v1/executions', { build_id: seed.buildId, test_plan_case_id: queue[0].plan_case_id, verdict: 'PASSED' }, token)).statusCode).toBe(201);
    expect(
      (await send('POST', `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`, { executions: [{ case_identifier: { external_id: queue[1].external_id }, verdict: 'FAILED' }] }, token)).statusCode
    ).toBe(201);
    for (let i = 0; i < 20; i++) await send('POST', '/api/v1/auth/login', { username: 'admin', password: 'wrong' }); // locks the account

    const rows = (await db.selectFrom('audit_logs').select(['id', 'action', 'ip_address', 'user_agent']).execute()).filter((r: any) => !before.has(r.id));
    const actions = rows.map((r: any) => r.action);
    // (Creating plans and runs isn't audited at all yet.)
    for (const a of ['PROJECT_CREATED', 'CUSTOM_FIELD_DEFINITION_CREATED', 'CASE_CREATED', 'DATA_EXPORTED', 'EXECUTION_RECORDED', 'BATCH_EXECUTION_RECORDED', 'ACCOUNT_LOCKED']) {
      expect(actions).toContain(a);
    }
    for (const row of rows) {
      expect({ action: row.action, ip: row.ip_address, agent: row.user_agent }).toEqual({ action: row.action, ip: '203.0.113.7', agent });
    }
  });

  it('behind a trusted proxy records the forwarded client, and caps a long User-Agent', async () => {
    previousTrustProxy = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = 'true';
    ({ app, db } = await createServer());
    const token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      remoteAddress: '10.0.0.2', // the proxy
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.9', 'user-agent': 'x'.repeat(2000) },
      payload: { name: 'Proxied', prefix: 'PRX' },
    });
    expect(res.statusCode).toBe(201);
    const row = await db.selectFrom('audit_logs').select(['ip_address', 'user_agent']).where('action', '=', 'PROJECT_CREATED').executeTakeFirst();
    expect(row.ip_address).toBe('198.51.100.9');
    expect(row.user_agent).toHaveLength(500);
  });
});
