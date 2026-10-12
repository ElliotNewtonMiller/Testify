import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** The batch results route validates every item, matches steps exactly, and saves in one transaction. */
describe('Batch results: validation, steps and transactions', () => {
  let app: any;
  let db: any;
  let seed: any;
  let headers: Record<string, string>;
  const body = (res: any) => JSON.parse(res.payload || '{}');

  const batch = (executions: unknown, atomic = false) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch${atomic ? '?all_or_nothing=true' : ''}`,
      headers,
      payload: { executions },
    });
  const count = async (table: string) => Number((await db.selectFrom(table).select(db.fn.countAll().as('n')).executeTakeFirst()).n);
  const item = (verdict: string, extra: Record<string, unknown> = {}, id = 'SHOP-101') => ({ case_identifier: { external_id: id }, verdict, ...extra });

  /** A new approved case in the project, not in the plan (batch results may link it). */
  async function caseOutsidePlan(title: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers,
      payload: { test_suite_id: seed.suiteId, title, steps: [{ step_number: 1, action: 'Do it', expected_result: 'Done' }] },
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).version.status).toBe('APPROVED'); // admin holds SPEC_AUTO_APPROVE
    return body(res).test_case;
  }
  const linkCount = async (caseId: string) =>
    Number(
      (
        await db
          .selectFrom('test_plan_cases')
          .select(db.fn.countAll().as('n'))
          .where('test_case_id', '=', caseId)
          .where('test_plan_id', '=', seed.planId)
          .executeTakeFirst()
      ).n
    );

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    headers = { authorization: `Bearer ${token}` };
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses unknown verdicts, statuses and malformed fields per item, or the whole batch in atomic mode', async () => {
    const mixed = await batch([
      item('PASSED'),
      item('GREAT'),
      item('PASSED', { status: 'DONE' }, 'SHOP-102'),
      item('PASSED', { duration_ms: -5, executed_at: 'yesterday' }, 'SHOP-103'),
      item('FAILED', { step_results: [{ step_number: 1, verdict: 'MEH' }] }, 'SHOP-104'),
      { verdict: 'PASSED' },
    ]);
    expect(mixed.statusCode).toBe(207);
    const r = body(mixed).results;
    expect(r.map((x: any) => x.status)).toEqual([201, 400, 400, 400, 400, 400]);
    expect(r[1].code).toBe('INVALID_RESULT');
    expect(r[1].invalid_params[0].name).toBe('executions[1].verdict');
    expect(r[3].invalid_params.map((p: any) => p.name).sort()).toEqual(['executions[3].duration_ms', 'executions[3].executed_at']);
    expect(r[4].invalid_params[0].name).toBe('executions[4].step_results[0].verdict');
    expect(r[5].invalid_params[0].name).toBe('executions[5].case_identifier');
    expect(await count('test_results')).toBe(1);

    const atomic = await batch([item('PASSED', {}, 'SHOP-105'), item('nope'), item('PASSED', { status: 'x' })], true);
    expect(atomic.statusCode).toBe(400);
    expect(body(atomic).code).toBe('INVALID_RESULT');
    expect(body(atomic).invalid_params.map((p: any) => p.name)).toEqual(['executions[1].verdict', 'executions[2].status']);
    expect(await count('test_results')).toBe(1);

    for (const executions of [[], 'all of them', null]) {
      const res = await batch(executions);
      expect(res.statusCode).toBe(400);
      expect(body(res).invalid_params[0].name).toBe('executions');
    }
  });

  it('records step results against the step they name, and refuses unknown steps instead of using step 1', async () => {
    const queue = body(
      await app.inject({ method: 'GET', url: `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`, headers })
    ).cases;
    const shop101 = queue.find((c: any) => c.external_id === 'SHOP-101');
    const shop102 = queue.find((c: any) => c.external_id === 'SHOP-102');

    const res = await batch([
      item('FAILED', { step_results: [{ step_number: 2, verdict: 'FAILED', actual_result: 'boom' }, { test_step_id: shop101.steps[0].id, verdict: 'PASSED' }] }),
      item('FAILED', { step_results: [{ step_number: 99, verdict: 'FAILED' }] }, 'SHOP-102'),
      item('FAILED', { step_results: [{ test_step_id: shop101.steps[0].id, verdict: 'FAILED' }] }, 'SHOP-102'),
      item('FAILED', { step_results: [{ test_step_id: shop102.steps[0].id, step_number: 2, verdict: 'FAILED' }] }, 'SHOP-102'),
      item('FAILED', { step_results: [{ step_number: 1, verdict: 'FAILED' }, { step_number: 1, verdict: 'PASSED' }] }, 'SHOP-102'),
    ]);
    const r = body(res).results;
    expect(r.map((x: any) => x.status)).toEqual([201, 422, 422, 422, 422]);
    expect(r[1].code).toBe('UNKNOWN_STEP');
    expect(r[1].invalid_params[0].reason).toBe('this test case has no step 99');
    expect(r[2].invalid_params[0].reason).toBe("test_step_id isn't a step of this test case");
    expect(r[3].invalid_params[0].reason).toBe('is 1 for this step');
    expect(r[4].invalid_params[0].reason).toBe('repeats a step already given');

    const steps = await db
      .selectFrom('test_step_results')
      .select(['test_step_id', 'step_number', 'verdict', 'actual_result'])
      .where('test_result_id', '=', r[0].execution_id)
      .orderBy('step_number')
      .execute();
    expect(steps).toEqual([
      { test_step_id: shop101.steps[0].id, step_number: 1, verdict: 'PASSED', actual_result: null },
      { test_step_id: shop101.steps[1].id, step_number: 2, verdict: 'FAILED', actual_result: 'boom' },
    ]);
    expect(await count('test_step_results')).toBe(2);
  });

  it('a refused batch in atomic mode leaves nothing behind, auto-linked cases included', async () => {
    const outside = await caseOutsidePlan('Batch atomic link');
    const before = { executions: await count('test_results'), audit: await count('audit_logs') };

    const rejected = await batch([item('PASSED', {}, outside.external_id), item('PASSED', {}, 'NOPE-404')], true);
    expect(rejected.statusCode).toBe(422);
    expect(body(rejected).code).toBe('CASE_NOT_FOUND');
    expect(await linkCount(outside.id)).toBe(0);
    expect(await count('test_results')).toBe(before.executions);
    expect(await count('audit_logs')).toBe(before.audit);

    // Not atomic: an item refused for its steps doesn't link its case either...
    const badSteps = await batch([item('PASSED', { step_results: [{ step_number: 7, verdict: 'PASSED' }] }, outside.external_id)]);
    expect(body(badSteps).results[0].status).toBe(422);
    expect(await linkCount(outside.id)).toBe(0);

    // ...and an accepted one links it once, even when it appears twice.
    const ok = await batch([item('FAILED', {}, outside.external_id), item('PASSED', {}, outside.external_id)]);
    expect(body(ok).results.map((x: any) => x.status)).toEqual([201, 201]);
    expect(await linkCount(outside.id)).toBe(1);
  });

  it('records a large batch in one go', async () => {
    // SHOP-101..109 are in the seeded plan (SHOP-110 isn't).
    const big = Array.from({ length: 2000 }, (_, i) =>
      item(i % 7 === 0 ? 'FAILED' : 'PASSED', { duration_ms: i, notes: `run ${i}`, step_results: [{ step_number: 1, verdict: 'PASSED' }] }, `SHOP-${101 + (i % 9)}`)
    );
    const started = Date.now();
    const res = await batch(big);
    expect(res.statusCode).toBe(201);
    expect(body(res).summary).toMatchObject({ successful: 2000, failed: 0 });
    expect(await count('test_results')).toBe(2000);
    expect(await count('test_step_results')).toBe(2000);
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
