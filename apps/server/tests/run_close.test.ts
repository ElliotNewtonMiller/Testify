import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Closing a run: manual close/reopen and auto-close when every case has a result', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function login(app: any, username = 'admin', password = 'password'): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  async function planCaseRows(db: any, planId: string) {
    return db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .select(['tpc.id as test_plan_case_id', 'tc.external_id'])
      .where('tpc.test_plan_id', '=', planId)
      .execute();
  }

  it('auto-closes the first time every case has a result, refuses results until reopened, and never auto-closes again after a reopen', async () => {
    const { app, seed, db } = serverInstance;
    const token = await login(app);
    const h = { authorization: `Bearer ${token}` };
    const rows = await planCaseRows(db, seed.planId);
    expect(rows.length).toBeGreaterThan(1);

    // Every case but the last via batch: run stays open.
    const batch = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results/batch`,
      headers: h,
      payload: { results: rows.slice(0, -1).map((r: any) => ({ case_identifier: { external_id: r.external_id }, verdict: 'PASSED' })) },
    });
    expect(batch.statusCode).toBe(201);
    expect(JSON.parse(batch.payload).run_status).toBe('OPEN');

    // Last case via the single route: run auto-closes.
    const last = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[rows.length - 1].test_plan_case_id, verdict: 'FAILED' },
    });
    expect(last.statusCode).toBe(201);
    expect(JSON.parse(last.payload).run_status).toBe('CLOSED');

    const audit = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'RUN_AUTO_CLOSED').execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].resource_id).toBe(seed.buildId);

    // Closed: no more results.
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'FAILED' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(JSON.parse(blocked.payload).code).toBe('RUN_CLOSED');

    // Reopen (RUN_MANAGE) and a result can be recorded again.
    const reopen = await app.inject({
      method: 'PATCH',
      url: `/api/v1/runs/${seed.buildId}`,
      headers: h,
      payload: { status: 'OPEN' },
    });
    expect(reopen.statusCode).toBe(200);
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'BLOCKED' },
    });
    expect(again.statusCode).toBe(201);
    // Every case still has a result, but the run already auto-closed once -- it stays open.
    expect(JSON.parse(again.payload).run_status).toBe('OPEN');
    const auditAfter = await db.selectFrom('audit_logs').selectAll().where('action', '=', 'RUN_AUTO_CLOSED').execute();
    expect(auditAfter).toHaveLength(1);
  });

  it('a manually closed run blocks results; a Tester (no RUN_MANAGE) cannot open or close it', async () => {
    const { app, seed, db } = serverInstance;
    const token = await login(app);
    const h = { authorization: `Bearer ${token}` };
    const url = `/api/v1/runs/${seed.buildId}`;

    const close = await app.inject({ method: 'PATCH', url, headers: h, payload: { status: 'CLOSED' } });
    expect(close.statusCode).toBe(200);
    const rows = await planCaseRows(db, seed.planId);
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: h,
      payload: { test_plan_case_id: rows[0].test_plan_case_id, verdict: 'PASSED' },
    });
    expect(blocked.statusCode).toBe(422);

    const username = `tester_${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: h,
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: 'Tester' },
    });
    const testerToken = await login(app, username, 'SecurePass123!');
    const denied = await app.inject({ method: 'PATCH', url, headers: { authorization: `Bearer ${testerToken}` }, payload: { status: 'OPEN' } });
    expect(denied.statusCode).toBe(403);
  });
});
