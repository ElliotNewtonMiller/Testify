import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { createServer } from '../src/server.js';
import { ProjectRepository, TestPlanRepository } from '@testify/db';

describe('Reports: catalog-driven report API', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<{ token: string; userId: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    return { token: body.token as string, userId: body.user.id as string };
  }

  async function createAndLoginAs(app: any, adminToken: string, globalRole: string): Promise<{ token: string; userId: string }> {
    const username = `${globalRole.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole },
    });
    expect(createRes.statusCode).toBe(201);
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId: JSON.parse(createRes.payload).user.id };
  }

  /** Adds a run to the seeded plan with a pinned created_at, so run order is deterministic. */
  async function addRun(db: any, planId: string, name: string, createdAt: string): Promise<string> {
    const id = uuidv4();
    await db.insertInto('test_runs').values({ id, test_plan_id: planId, name, status: 'OPEN', created_at: createdAt, updated_at: createdAt }).execute();
    return id;
  }

  async function batch(app: any, token: string, planId: string, runId: string, executions: any[], extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${planId}/builds/${runId}/executions/batch`,
      headers: { authorization: `Bearer ${token}` },
      payload: { executions, ...extra },
    });
    expect([201, 207]).toContain(res.statusCode);
  }

  /**
   * Three runs of the seeded plan (10 cases, SHOP-101..110):
   *   SHOP-101  P  P  F   new failure in R3 ('boom'), 1000ms
   *   SHOP-102  F  F  F   still failing since R1, 500ms
   *   SHOP-103  F  P  P
   *   SHOP-104  P  F  P   flip-flopping -> flaky; fixed in R3
   *   SHOP-105  P  P  F->P  passed on retry in R3 -> flaky
   *   SHOP-106  -  P  -   not run in R3
   *   SHOP-107..109, SHOP-1010 never executed
   */
  async function seedThreeRuns() {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const r1 = seed.buildId;
    const r2 = await addRun(db, seed.planId, 'R2', '2099-01-01T00:00:00.000Z');
    const r3 = await addRun(db, seed.planId, 'R3', '2099-01-02T00:00:00.000Z');
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const item = (id: string, verdict: string, minutesAgo: number, more: Record<string, unknown> = {}) => ({
      case_identifier: { external_id: id },
      verdict,
      executed_at: at(minutesAgo),
      ...more,
    });

    await batch(app, token, seed.planId, r1, [
      item('SHOP-101', 'PASSED', 300, { duration_ms: 1000 }),
      item('SHOP-102', 'FAILED', 300, { duration_ms: 500 }),
      item('SHOP-103', 'FAILED', 300),
      item('SHOP-104', 'PASSED', 300),
      item('SHOP-105', 'PASSED', 300),
    ]);
    await batch(app, token, seed.planId, r2, [
      item('SHOP-101', 'PASSED', 200, { duration_ms: 1000 }),
      item('SHOP-102', 'FAILED', 200, { duration_ms: 500 }),
      item('SHOP-103', 'PASSED', 200),
      item('SHOP-104', 'FAILED', 200),
      item('SHOP-105', 'PASSED', 200),
      item('SHOP-106', 'PASSED', 200),
    ]);
    await batch(
      app,
      token,
      seed.planId,
      r3,
      [
        item('SHOP-101', 'FAILED', 100, { duration_ms: 1000, failure_message: 'boom', stack_trace: 'at line 1' }),
        item('SHOP-102', 'FAILED', 100, { duration_ms: 500 }),
        item('SHOP-103', 'PASSED', 100),
        item('SHOP-104', 'PASSED', 100),
        item('SHOP-105', 'FAILED', 101),
        item('SHOP-105', 'PASSED', 100),
      ],
      { environment: 'staging', runner_info: { name: 'GitHub Actions', run_id: '42', commit_sha: 'abc123def456789', bogus: 'dropped' } }
    );
    return { app, db, seed, token, r1, r2, r3 };
  }

  async function report(app: any, token: string, projectId: string, reportId: string, body: unknown, format?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/reports/${reportId}${format ? `?format=${format}` : ''}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body as any,
    });
  }

  const ids = (list: Array<{ external_id: string }>) => list.map((c) => c.external_id);

  describe('catalog and access', () => {
    it('lists every report with JSON-Schema params and the metric definitions', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${seed.projectId}/reports`, headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.reports.map((r: any) => r.id)).toEqual(['overview', 'run_summary', 'case_history', 'plan_trend', 'test_health', 'breakdown']);
      expect(body.reports.find((r: any) => r.id === 'run_summary').params.required).toEqual(['run_id']);
      expect(body.definitions.pass_rate).toContain('passed / (total - untested - skipped)');
    });

    it('a Viewer gets 200; a custom role without SPEC_VIEW gets 403; no token gets 401', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const url = `/api/v1/projects/${seed.projectId}/reports`;

      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);

      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');
      expect((await report(app, viewerToken, seed.projectId, 'overview', {})).statusCode).toBe(200);

      const createRoleRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/roles',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: `No Spec View ${Date.now()}`, description: null, permission_keys: ['EXECUTE_RUN'] },
      });
      expect(createRoleRes.statusCode).toBe(201);
      const { token: restrictedToken } = await createAndLoginAs(app, adminToken, JSON.parse(createRoleRes.payload).role.name);
      const restrictedRes = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${restrictedToken}` } });
      expect(restrictedRes.statusCode).toBe(403);
      expect(JSON.parse(restrictedRes.payload).required_permission).toBe('SPEC_VIEW');
    });

    it('an API token can read its own project\'s reports but is refused on any other project', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const mint = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/api-tokens`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Agent', capabilities: ['SPEC_VIEW'] },
      });
      expect(mint.statusCode).toBe(201);
      const apiToken = JSON.parse(mint.payload).plaintext;

      expect((await report(app, apiToken, seed.projectId, 'overview', {})).statusCode).toBe(200);

      const other = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTH' });
      const crossRes = await report(app, apiToken, other.id, 'overview', {});
      expect(crossRes.statusCode).toBe(403);
      expect(JSON.parse(crossRes.payload).code).toBe('TOKEN_PROJECT_MISMATCH');
      // The same scoping now applies to every project-nested route, not only reports.
      const searchRes = await app.inject({ method: 'GET', url: `/api/v1/projects/${other.id}/case-search/fields`, headers: { authorization: `Bearer ${apiToken}` } });
      expect(searchRes.statusCode).toBe(403);
    });
  });

  describe('validation errors', () => {
    it('400 names bad params; 404 for an unknown report or an id from another project; 400 for an unsupported format', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const missing = await report(app, token, seed.projectId, 'run_summary', { limit: 0, extra: true });
      expect(missing.statusCode).toBe(400);
      expect(JSON.parse(missing.payload).invalid_params).toEqual(
        expect.arrayContaining([
          { name: 'run_id', reason: 'is required' },
          { name: 'extra', reason: 'unknown parameter' },
          { name: 'limit', reason: 'must be at least 1' },
        ])
      );

      expect((await report(app, token, seed.projectId, 'nope', {})).statusCode).toBe(404);

      const other = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTH' });
      const otherPlan = await new TestPlanRepository(db).create({ project_id: other.id, name: 'Other plan' });
      const otherRun = await addRun(db, otherPlan.id, 'X', '2099-01-01T00:00:00.000Z');
      const cross = await report(app, token, seed.projectId, 'run_summary', { run_id: otherRun });
      expect(cross.statusCode).toBe(404);
      expect(JSON.parse(cross.payload).code).toBe('RUN_NOT_FOUND');
      expect((await report(app, token, seed.projectId, 'test_health', { plan_id: otherPlan.id })).statusCode).toBe(404);

      expect((await report(app, token, seed.projectId, 'case_history', { case_id: 'SHOP-101' }, 'markdown')).statusCode).toBe(400);

      const badFilter = await report(app, token, seed.projectId, 'run_summary', { run_id: seed.buildId, filter: { filters: [{ field: 'nope', op: 'is', value: 1 }] } });
      expect(badFilter.statusCode).toBe(400);
      expect(JSON.parse(badFilter.payload).code).toBe('INVALID_FILTER');
    });
  });

  describe('run_summary', () => {
    it('summarizes the run and diffs it against the previous run of the plan', async () => {
      const { app, seed, token, r1, r2, r3 } = await seedThreeRuns();
      const res = await report(app, token, seed.projectId, 'run_summary', { run_id: r3 });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);

      expect(body.run).toMatchObject({ id: r3, name: 'R3', plan_id: seed.planId });
      expect(body.compared_to).toMatchObject({ id: r2, name: 'R2' });
      expect(body.summary).toMatchObject({ total: 10, passed: 3, failed: 2, untested: 5, pass_rate: 0.6, completion: 0.5, attempts: 6, automated_duration_ms: 1500 });
      expect(body.diff.counts).toMatchObject({ new_failure: 1, still_failing: 1, fixed: 1, not_run: 1, added: 0, removed: 0 });
      expect(ids(body.diff.cases.new_failure)).toEqual(['SHOP-101']);
      expect(ids(body.diff.cases.fixed)).toEqual(['SHOP-104']);
      expect(ids(body.diff.cases.not_run)).toEqual(['SHOP-106']);
      expect(body.diff.cases.not_run[0]).toMatchObject({ verdict: null, previous_verdict: 'PASSED' });

      // New failures first, with their error and how long they've been failing.
      expect(ids(body.failures)).toEqual(['SHOP-101', 'SHOP-102']);
      expect(body.failures[0]).toMatchObject({
        failure_message: 'boom',
        source: 'API',
        failing_since: { run_id: r3, run_name: 'R3', runs: 1 },
        flaky: false,
        runner: { name: 'GitHub Actions', run_id: '42', commit_sha: 'abc123def456789' },
      });
      expect(body.failures[1].failing_since).toMatchObject({ run_id: r1, runs: 3 });
      expect(body.runners).toEqual([{ name: 'GitHub Actions', run_id: '42', commit_sha: 'abc123def456789' }]);
    });

    it('compares against an explicit run, or nothing; and a filter narrows everything', async () => {
      const { app, seed, token, r1, r3 } = await seedThreeRuns();

      const vsR1 = JSON.parse((await report(app, token, seed.projectId, 'run_summary', { run_id: r3, compare_to: r1 })).payload);
      expect(vsR1.compared_to.id).toBe(r1);
      expect(ids(vsR1.diff.cases.fixed)).toEqual(['SHOP-103']);
      expect(vsR1.diff.counts.not_run).toBe(0);

      const none = JSON.parse((await report(app, token, seed.projectId, 'run_summary', { run_id: r3, compare_to: null })).payload);
      expect(none.compared_to).toBeNull();
      expect(none.diff.counts.new_failure).toBe(0);

      const same = await report(app, token, seed.projectId, 'run_summary', { run_id: r3, compare_to: r3 });
      expect(same.statusCode).toBe(400);

      const filtered = JSON.parse((await report(app, token, seed.projectId, 'run_summary', { run_id: r3, filter: { q: 'SHOP-102' } })).payload);
      expect(filtered.filter_applied).toBe(true);
      expect(filtered.summary.total).toBe(1);
      expect(filtered.diff.counts).toMatchObject({ fixed: 0, new_failure: 0, still_failing: 1 });
      expect(ids(filtered.failures)).toEqual(['SHOP-102']);
    });

    it('renders Markdown and CSV', async () => {
      const { app, seed, token, r3 } = await seedThreeRuns();
      const md = await report(app, token, seed.projectId, 'run_summary', { run_id: r3 }, 'markdown');
      expect(md.statusCode).toBe(200);
      expect(md.headers['content-type']).toContain('text/markdown');
      expect(md.payload).toContain('## Test run "R3"');
      expect(md.payload).toContain('### New failures');
      expect(md.payload).toContain('| SHOP-101 |');
      expect(md.payload).toContain('boom');

      const csv = await report(app, token, seed.projectId, 'run_summary', { run_id: r3 }, 'csv');
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      const lines = csv.payload.trim().split('\r\n');
      expect(lines[0]).toBe('external_id,title,suite_path,verdict,previous_verdict,change,failure_message,notes,failing_since,flaky,attempts,executed_at,tested_by,test_case_id');
      expect(lines).toHaveLength(11);
      expect(lines.find((l: string) => l.startsWith('SHOP-101,'))).toContain(',FAILED,PASSED,new_failure,boom,');
    });
  });

  describe('case_history, plan_trend, test_health, breakdown, overview', () => {
    it('case_history: every result across runs, by id or external id, paginated, with stats', async () => {
      const { app, seed, token } = await seedThreeRuns();
      const page1 = JSON.parse((await report(app, token, seed.projectId, 'case_history', { case_id: 'shop-102', limit: 2 })).payload);
      expect(page1.case).toMatchObject({ external_id: 'SHOP-102' });
      expect(page1.stats).toMatchObject({ total_executions: 3, runs: 3, pass_rate: 0, current_streak: { verdict: 'FAILED', runs: 3 }, last_passed_at: null });
      expect(page1.executions.map((e: any) => e.run.name)).toEqual(['R3', 'R2']);
      expect(page1.executions[0]).toMatchObject({ verdict: 'FAILED', duration_ms: 500, source: 'API', environment: { environment: 'staging' } });
      const page2 = JSON.parse((await report(app, token, seed.projectId, 'case_history', { case_id: 'SHOP-102', limit: 2, cursor: page1.next_cursor })).payload);
      expect(page2.executions).toHaveLength(1);
      expect(page2.next_cursor).toBeNull();

      const failing = JSON.parse((await report(app, token, seed.projectId, 'case_history', { case_id: 'SHOP-101' })).payload);
      expect(failing.executions[0]).toMatchObject({ failure_message: 'boom', stack_trace: 'at line 1' });
      expect((await report(app, token, seed.projectId, 'case_history', { case_id: 'NOPE-1' })).statusCode).toBe(404);
    });

    it('plan_trend: one point per run, oldest first, with new failures versus the run before', async () => {
      const { app, seed, token, r1, r2, r3 } = await seedThreeRuns();
      const body = JSON.parse((await report(app, token, seed.projectId, 'plan_trend', { plan_id: seed.planId })).payload);
      expect(body.points.map((p: any) => p.run_id)).toEqual([r1, r2, r3]);
      expect(body.points[0]).toMatchObject({ passed: 3, failed: 2, untested: 5, pass_rate: 0.6, new_failures: null });
      expect(body.points[1]).toMatchObject({ passed: 4, failed: 2, new_failures: 1, fixed: 1 });
      expect(body.points[2]).toMatchObject({ new_failures: 1, fixed: 1 });

      const lastTwo = JSON.parse((await report(app, token, seed.projectId, 'plan_trend', { plan_id: seed.planId, runs: 2 })).payload);
      expect(lastTwo.points.map((p: any) => p.run_id)).toEqual([r2, r3]);
      expect(lastTwo.points[0].new_failures).toBe(1); // still compared with R1, outside the window
    });

    it('test_health: flaky, slowest, always failing and stale', async () => {
      const { app, seed, token } = await seedThreeRuns();
      const body = JSON.parse((await report(app, token, seed.projectId, 'test_health', { plan_id: seed.planId, runs: 3 })).payload);
      expect(ids(body.flaky)).toEqual(['SHOP-104', 'SHOP-105']);
      expect(body.flaky[0]).toMatchObject({ flip_score: 1, flips: 2 });
      expect(body.flaky[1]).toMatchObject({ flip_score: 0, passed_on_retry_runs: 1 });
      expect(ids(body.slowest)).toEqual(['SHOP-101', 'SHOP-102']);
      expect(body.slowest[0]).toMatchObject({ median_ms: 1000, samples: 3 });
      expect(ids(body.always_failing)).toEqual(['SHOP-102']);
      expect(body.always_failing[0]).toMatchObject({ consecutive_failures: 3 });
      expect(ids(body.stale).sort()).toEqual(['SHOP-1010', 'SHOP-107', 'SHOP-108', 'SHOP-109']);
      expect(body.stale[0].days_since).toBeNull();
      expect(body.counts).toMatchObject({ flaky: 2, slowest: 2, always_failing: 1, stale: 4, slowing: 0 });

      const csv = await report(app, token, seed.projectId, 'test_health', { plan_id: seed.planId, runs: 3 }, 'csv');
      expect(csv.payload.split('\r\n')[1]).toMatch(/^flaky,SHOP-104,/);
    });

    it('breakdown: coverage without a run, verdicts per group with one; rejects unknown or run-only groupings', async () => {
      const { app, db, seed, token, r3 } = await seedThreeRuns();
      const coverage = JSON.parse((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, group_by: 'execution_type' })).payload);
      expect(coverage.mode).toBe('coverage');
      const totalCases = coverage.groups.reduce((n: number, g: any) => n + g.total_cases, 0);
      expect(totalCases).toBe(10);
      expect(coverage.groups.every((g: any) => g.coverage === 1)).toBe(true);

      const verdicts = JSON.parse((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, run_id: r3, group_by: 'suite' })).payload);
      expect(verdicts.mode).toBe('verdicts');
      expect(verdicts.groups).toHaveLength(1);
      expect(verdicts.groups[0]).toMatchObject({ total: 10, passed: 3, failed: 2, pass_rate: 0.6 });

      const byTester = JSON.parse((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, run_id: r3, group_by: 'tester' })).payload);
      expect(byTester.groups.map((g: any) => g.key)).toEqual(['admin', '(not run)']);

      expect((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, group_by: 'tester' })).statusCode).toBe(400);
      expect((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, group_by: 'cf:nope' })).statusCode).toBe(400);

      // A custom MULTI_SELECT field: a case lands in every group it has a value for.
      const defRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/custom-fields',
        headers: { authorization: `Bearer ${token}` },
        payload: { entity_type: 'TestCase', name: 'area', field_label: 'Area', field_type: 'MULTI_SELECT', options: [{ option_label: 'UI', option_value: 'ui' }, { option_label: 'API', option_value: 'api' }] },
      });
      expect(defRes.statusCode).toBe(201);
      const defId = JSON.parse(defRes.payload).definition.id;
      const case101 = await db.selectFrom('test_cases').select('id').where('external_id', '=', 'SHOP-101').executeTakeFirstOrThrow();
      const setRes = await app.inject({
        method: 'PUT',
        url: `/api/v1/test-cases/${case101.id}/custom-field-values/${defId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { value: ['ui', 'api'] },
      });
      expect(setRes.statusCode).toBe(200);
      const byArea = JSON.parse((await report(app, token, seed.projectId, 'breakdown', { plan_id: seed.planId, run_id: r3, group_by: `cf:${defId}` })).payload);
      expect(byArea.group_by.label).toBe('Area');
      expect(byArea.groups.map((g: any) => [g.key, g.total])).toEqual([['UI', 1], ['API', 1], ['(no value)', 9]]);
    });

    it('overview: latest run per active plan, spec stats and activity', async () => {
      const { app, seed, token, r3 } = await seedThreeRuns();
      const body = JSON.parse((await report(app, token, seed.projectId, 'overview', { days: 7 })).payload);
      expect(body.plans).toHaveLength(1);
      expect(body.plans[0]).toMatchObject({ latest_run: { id: r3 }, new_failures: 1, fixed: 1 });
      expect(body.plans[0].summary).toMatchObject({ pass_rate: 0.6 });
      expect(body.spec).toMatchObject({ total_cases: 10, never_executed: 4 });
      expect(body.activity.by_day).toHaveLength(7);
      expect(body.activity).toMatchObject({ total: 17, api: 17, ui: 0 });
    });
  });

  describe('result capture', () => {
    it('the batch API stores failure message, stack trace, environment and runner; the UI route marks source UI', async () => {
      const { app, db, seed, token } = await seedThreeRuns();
      const case101 = await db.selectFrom('test_cases').select('id').where('external_id', '=', 'SHOP-101').executeTakeFirstOrThrow();
      const row = await db
        .selectFrom('test_results as e')
        .innerJoin('test_plan_cases as tpc', 'tpc.id', 'e.test_plan_case_id')
        .selectAll('e')
        .where('tpc.test_case_id', '=', case101.id)
        .where('e.verdict', '=', 'FAILED')
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ failure_message: 'boom', stack_trace: 'at line 1', source: 'API' });
      expect(JSON.parse(row.environment)).toEqual({ environment: 'staging' });
      expect(JSON.parse(row.runner)).toEqual({ name: 'GitHub Actions', run_id: '42', commit_sha: 'abc123def456789' });

      const planCase = await db.selectFrom('test_plan_cases').selectAll().where('test_plan_id', '=', seed.planId).executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/executions',
        headers: { authorization: `Bearer ${token}` },
        payload: { build_id: seed.buildId, test_plan_case_id: planCase.id, verdict: 'PASSED' },
      });
      expect(res.statusCode).toBe(201);
      const uiRow = await db.selectFrom('test_results').selectAll().where('id', '=', JSON.parse(res.payload).id).executeTakeFirstOrThrow();
      expect(uiRow).toMatchObject({ source: 'UI', environment: null, runner: null });
    });
  });

  describe('execution_duration_ms nullable-duration regression', () => {
    it('POST /api/v1/executions with no execution_duration_ms stores null, not a fabricated 450', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const planCaseRow = await db
        .selectFrom('test_plan_cases')
        .selectAll()
        .where('test_plan_id', '=', seed.planId)
        .executeTakeFirstOrThrow();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/executions',
        headers: { authorization: `Bearer ${token}` },
        payload: { build_id: seed.buildId, test_plan_case_id: planCaseRow.id, verdict: 'PASSED' },
      });
      expect(res.statusCode).toBe(201);

      const execId = JSON.parse(res.payload).id ?? JSON.parse(res.payload).execution?.id;
      const row = await db.selectFrom('test_results').selectAll().where('id', '=', execId).executeTakeFirstOrThrow();
      expect(row.duration_ms).toBeNull();
      expect(row.duration_ms).not.toBe(450);
    });

    it('POST /api/v1/executions (manual) ignores a supplied duration -- manual execution is never timed', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const planCaseRow = await db
        .selectFrom('test_plan_cases')
        .selectAll()
        .where('test_plan_id', '=', seed.planId)
        .executeTakeFirstOrThrow();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/executions',
        headers: { authorization: `Bearer ${token}` },
        payload: { build_id: seed.buildId, test_plan_case_id: planCaseRow.id, verdict: 'PASSED', execution_duration_ms: 777 },
      });
      expect(res.statusCode).toBe(201);
      const row = await db.selectFrom('test_results').selectAll().where('id', '=', JSON.parse(res.payload).id).executeTakeFirstOrThrow();
      expect(row.duration_ms).toBeNull();
    });

    it('batchExecution.ts stores null, not a fabricated 0, when duration_ms is omitted', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-104' }, verdict: 'PASSED' }] },
      });

      const caseRow = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'SHOP-104').executeTakeFirstOrThrow();
      const planCaseRow = await db
        .selectFrom('test_plan_cases')
        .selectAll()
        .where('test_case_id', '=', caseRow.id)
        .executeTakeFirstOrThrow();
      const execRow = await db
        .selectFrom('test_results')
        .selectAll()
        .where('test_plan_case_id', '=', planCaseRow.id)
        .where('test_run_id', '=', seed.buildId)
        .executeTakeFirstOrThrow();
      expect(execRow.duration_ms).toBeNull();
      expect(execRow.duration_ms).not.toBe(0);
    });
  });
});
