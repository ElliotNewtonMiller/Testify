import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Changing a case's existing result in a run needs EXECUTE_OVERWRITE -- on both result routes. */
describe('EXECUTE_OVERWRITE', () => {
  let app: any;
  let db: any;
  let seed: any;
  let adminToken: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function loginAs(globalRole: string): Promise<string> {
    const username = `${globalRole.replace(/\s+/g, '_').toLowerCase()}_${Math.random().toString(36).slice(2)}`;
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: auth(adminToken),
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole },
    });
    expect(created.statusCode).toBe(201);
    return body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } })).token;
  }

  const planCaseId = async (externalId: string) =>
    body(await app.inject({ method: 'GET', url: `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`, headers: auth(adminToken) })).cases.find(
      (c: any) => c.external_id === externalId
    ).plan_case_id;
  const record = (token: string, test_plan_case_id: string, verdict: string, notes?: string) =>
    app.inject({ method: 'POST', url: '/api/v1/executions', headers: auth(token), payload: { build_id: seed.buildId, test_plan_case_id, verdict, notes } });
  const batch = (token: string, executions: unknown[], atomic = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch${atomic ? '?all_or_nothing=true' : ''}`,
      headers: auth(token),
      payload: { executions },
    });
  const resultCount = async () => Number((await db.selectFrom('executions').select(db.fn.countAll().as('n')).executeTakeFirst()).n);

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    adminToken = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('a Tester records a first result and adds notes to it, but cannot change it or anyone else\'s', async () => {
    const tester = await loginAs('Tester');
    const lead = await loginAs('Test Lead');
    const pc = await planCaseId('SHOP-101');

    expect((await record(tester, pc, 'FAILED')).statusCode).toBe(201);
    // Ctrl+Enter after picking a verdict: notes on your own result, same verdict.
    expect((await record(tester, pc, 'FAILED', 'step 2 timed out')).statusCode).toBe(201);

    const change = await record(tester, pc, 'PASSED');
    expect(change.statusCode).toBe(403);
    expect(body(change).code).toBe('RESULT_OVERWRITE_NOT_PERMITTED');
    expect(body(change).detail).toContain('EXECUTE_OVERWRITE');

    // A Test Lead (has EXECUTE_OVERWRITE) can change it; then it's no longer the Tester's own.
    expect((await record(lead, pc, 'PASSED')).statusCode).toBe(201);
    expect((await record(tester, pc, 'PASSED', 'agree')).statusCode).toBe(403);
    expect((await record(adminToken, pc, 'BLOCKED')).statusCode).toBe(201);

    // The refusals stored nothing: 2 by the Tester, 1 by the lead, 1 by the admin.
    expect(await resultCount()).toBe(4);

    // Another case, and the same case in a different run, are first results again.
    expect((await record(tester, await planCaseId('SHOP-102'), 'PASSED')).statusCode).toBe(201);
  });

  it('the batch route applies the same rule; repeats within one request are retries', async () => {
    const tokenFor = async (capabilities: string[]) =>
      body(
        await app.inject({
          method: 'POST',
          url: `/api/v1/projects/${seed.projectId}/api-tokens`,
          headers: auth(adminToken),
          payload: { name: `ci ${capabilities.join(' ')}`, capabilities },
        })
      ).plaintext;
    const ci = await tokenFor(['EXECUTE_RUN']);
    const ciOverwrite = await tokenFor(['EXECUTE_RUN', 'EXECUTE_OVERWRITE']);
    const item = (verdict: string, id = 'SHOP-103') => ({ case_identifier: { external_id: id }, verdict });

    // First run of the pipeline: a failure then a passing retry, both recorded.
    const first = await batch(ci, [item('FAILED'), item('PASSED')]);
    expect(first.statusCode).toBe(201);
    expect(body(first).results.map((r: any) => r.status)).toEqual([201, 201]);

    // A later request changing that result is refused per item; others still record.
    const second = await batch(ci, [item('FAILED'), item('PASSED', 'SHOP-104')]);
    expect(body(second).results.map((r: any) => r.status)).toEqual([403, 201]);
    expect(body(second).results[0].error).toContain('EXECUTE_OVERWRITE');
    // The same verdict again from the same token is allowed (nothing changes).
    expect(body(await batch(ci, [item('PASSED')])).results[0].status).toBe(201);

    // Atomic mode refuses the whole batch and records nothing.
    const before = await resultCount();
    const atomic = await batch(ci, [item('PASSED', 'SHOP-105'), item('BLOCKED')], true);
    expect(atomic.statusCode).toBe(403);
    expect(body(atomic).code).toBe('RESULT_OVERWRITE_NOT_PERMITTED');
    expect(await resultCount()).toBe(before);

    // A token with EXECUTE_OVERWRITE may change it.
    expect(body(await batch(ciOverwrite, [item('BLOCKED')])).results[0].status).toBe(201);
  });
});
