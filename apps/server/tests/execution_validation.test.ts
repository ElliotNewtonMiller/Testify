import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** POST /api/v1/executions only stores known verdicts, statuses and steps of the case. */
describe('Recording a single result: validation', () => {
  let app: any;
  let db: any;
  let seed: any;
  let headers: Record<string, string>;
  const body = (res: any) => JSON.parse(res.payload || '{}');

  const queue = async () =>
    body(await app.inject({ method: 'GET', url: `/api/v1/test-plans/${seed.planId}/cases?build_id=${seed.buildId}`, headers })).cases;
  const record = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/executions', headers, payload });
  const executionCount = async () => Number((await db.selectFrom('test_results').select(db.fn.countAll().as('n')).executeTakeFirst()).n);

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    const token = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    headers = { authorization: `Bearer ${token}` };
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses unknown verdicts, statuses and malformed fields, naming each, and stores nothing', async () => {
    const [c] = await queue();
    const bad = await record({
      build_id: seed.buildId,
      test_plan_case_id: c.plan_case_id,
      verdict: 'TOTALLY_FINE',
      status: 'DONE',
      notes: 42,
      step_results: [{ test_step_id: c.steps[0].id, verdict: 'MAYBE' }, 'nope'],
    });
    expect(bad.statusCode).toBe(400);
    expect(body(bad).code).toBe('INVALID_RESULT');
    expect(body(bad).invalid_params.map((p: any) => p.name).sort()).toEqual(
      ['notes', 'status', 'step_results[0].verdict', 'step_results[1]', 'verdict'].sort()
    );

    const missing = await record({ verdict: 'PASSED' });
    expect(missing.statusCode).toBe(400);
    expect(body(missing).invalid_params.map((p: any) => p.name).sort()).toEqual(['build_id', 'test_plan_case_id']);

    const lowercase = await record({ build_id: seed.buildId, test_plan_case_id: c.plan_case_id, verdict: 'passed' });
    expect(lowercase.statusCode).toBe(400);

    expect(await executionCount()).toBe(0);
  });

  it("refuses step results that aren't steps of this case (400, not 500), and nothing is half-saved", async () => {
    const [c1, c2] = await queue();

    const unknown = await record({
      build_id: seed.buildId,
      test_plan_case_id: c1.plan_case_id,
      verdict: 'FAILED',
      step_results: [
        { test_step_id: c1.steps[0].id, verdict: 'PASSED' },
        { test_step_id: 'no-such-step', verdict: 'FAILED' },
      ],
    });
    expect(unknown.statusCode).toBe(400);
    expect(body(unknown).invalid_params).toEqual([{ name: 'step_results[1].test_step_id', reason: "isn't a step of this test case" }]);

    const otherCase = await record({
      build_id: seed.buildId,
      test_plan_case_id: c1.plan_case_id,
      verdict: 'PASSED',
      step_results: [{ test_step_id: c2.steps[0].id, verdict: 'PASSED' }],
    });
    expect(otherCase.statusCode).toBe(400);

    const wrongNumber = await record({
      build_id: seed.buildId,
      test_plan_case_id: c1.plan_case_id,
      verdict: 'PASSED',
      step_results: [{ test_step_id: c1.steps[0].id, step_number: 2, verdict: 'PASSED' }],
    });
    expect(wrongNumber.statusCode).toBe(400);
    expect(body(wrongNumber).invalid_params[0].reason).toBe('is 1 for this step');

    const duplicate = await record({
      build_id: seed.buildId,
      test_plan_case_id: c1.plan_case_id,
      verdict: 'PASSED',
      step_results: [
        { test_step_id: c1.steps[0].id, verdict: 'PASSED' },
        { test_step_id: c1.steps[0].id, verdict: 'FAILED' },
      ],
    });
    expect(duplicate.statusCode).toBe(400);

    expect(await executionCount()).toBe(0);
  });

  it('records a valid result, taking step numbers from the case itself', async () => {
    const [c] = await queue();
    const ok = await record({
      build_id: seed.buildId,
      test_plan_case_id: c.plan_case_id,
      verdict: 'KNOWN_ISSUE',
      status: 'COMPLETED',
      notes: 'flaky upstream',
      step_results: [
        { test_step_id: c.steps[1].id, verdict: 'FAILED', actual_result: 'timeout' },
        { test_step_id: c.steps[0].id, step_number: 1, verdict: 'PASSED' },
      ],
    });
    expect(ok.statusCode).toBe(201);
    const steps = await db
      .selectFrom('test_step_results')
      .select(['test_step_id', 'step_number', 'verdict', 'actual_result'])
      .where('test_result_id', '=', body(ok).id)
      .orderBy('step_number')
      .execute();
    expect(steps).toEqual([
      { test_step_id: c.steps[0].id, step_number: 1, verdict: 'PASSED', actual_result: null },
      { test_step_id: c.steps[1].id, step_number: 2, verdict: 'FAILED', actual_result: 'timeout' },
    ]);

    // Status defaults to COMPLETED when left out.
    const plain = await record({ build_id: seed.buildId, test_plan_case_id: c.plan_case_id, verdict: 'PASSED' });
    expect(plain.statusCode).toBe(201);
    expect(body(plain).status).toBe('COMPLETED');
  });
});
