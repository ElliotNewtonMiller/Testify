import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** The lists that grow, a page at a time: a project's cases, a run's results, the audit log. */
describe('API lists: paging and filters', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string | null, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload } : {}) });

  /** Every item of a paged list, following next_cursor. */
  async function all(url: string, key: string, limit: number) {
    const items: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const sep = url.includes('?') ? '&' : '?';
      const res = await call(admin, 'GET', `${url}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode, res.payload).toBe(200);
      const page = body(res);
      expect(page[key].length).toBeLessThanOrEqual(limit);
      items.push(...page[key]);
      cursor = page.next_cursor;
      pages++;
    } while (cursor);
    return { items, pages };
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it("pages through a project's cases, each with its latest version, and filters them", async () => {
    const cases = `/api/v1/projects/${seed.projectId}/cases`;
    const { items, pages } = await all(cases, 'cases', 3);
    expect(pages).toBe(4);
    expect(items.map((c) => c.id).sort()).toEqual([...seed.caseIds].sort());
    expect(new Set(items.map((c) => c.id)).size).toBe(10);
    expect(items[0].latest_version).toMatchObject({ version_number: 1, status: 'APPROVED' });

    // One page holds everything: no next page.
    expect(body(await call(admin, 'GET', cases)).next_cursor).toBeNull();

    // Filters: readable ids, priority, latest version status, suite (and the suites below it).
    expect(body(await call(admin, 'GET', `${cases}?external_id=SHOP-101,SHOP-103`)).cases.map((c: any) => c.external_id).sort()).toEqual(['SHOP-101', 'SHOP-103']);
    await call(admin, 'PATCH', '/api/v1/cases/SHOP-102', { priority: 'CRITICAL' });
    expect(body(await call(admin, 'GET', `${cases}?priority=critical`)).cases.map((c: any) => c.external_id)).toEqual(['SHOP-102']);
    await call(admin, 'POST', '/api/v1/cases/SHOP-104/versions');
    expect(body(await call(admin, 'GET', `${cases}?version_status=DRAFT`)).cases.map((c: any) => c.external_id)).toEqual(['SHOP-104']);

    const child = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Child', parent_suite_id: seed.suiteId })).suite;
    await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/move`, { case_ids: ['SHOP-105'], target_suite_id: child.id });
    expect(body(await call(admin, 'GET', `${cases}?test_suite_id=${seed.suiteId}`)).cases).toHaveLength(9);
    expect(body(await call(admin, 'GET', `${cases}?test_suite_id=${seed.suiteId}&include_sub_suites=true`)).cases).toHaveLength(10);
    expect(body(await call(admin, 'GET', `${cases}?test_suite_id=${child.id}`)).cases.map((c: any) => c.external_id)).toEqual(['SHOP-105']);

    // Bad input names the field.
    const badStatus = await call(admin, 'GET', `${cases}?version_status=IN_REVIEW`);
    expect([badStatus.statusCode, body(badStatus).invalid_params[0].name]).toEqual([400, 'version_status']);
    expect((await call(admin, 'GET', `${cases}?limit=501`)).statusCode).toBe(400);
    const badCursor = await call(admin, 'GET', `${cases}?cursor=nonsense`);
    expect([badCursor.statusCode, body(badCursor).code]).toEqual([400, 'INVALID_CURSOR']);
  });

  it("pages through a run's results, with filters, latest_only and one result by id", async () => {
    const run = `/api/v1/runs/${seed.buildId}`;
    // SHOP-101 fails then passes; SHOP-102 and SHOP-103 come from a CI batch.
    const planCases = body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`));
    const planCaseFor = (externalId: string) => (planCases.cases ?? planCases.plan_cases).find((c: any) => c.external_id === externalId).test_plan_case_id;
    const first = await call(admin, 'POST', `${run}/results`, { test_plan_case_id: planCaseFor('SHOP-101'), verdict: 'FAILED', notes: 'broken' });
    expect(first.statusCode, first.payload).toBe(201);
    await call(admin, 'POST', `${run}/results`, { test_plan_case_id: planCaseFor('SHOP-101'), verdict: 'PASSED' });
    const batch = await call(admin, 'POST', `${run}/results/batch`, {
      environment: 'staging',
      results: [
        { case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED', duration_ms: 1200 },
        { case_identifier: { external_id: 'SHOP-103' }, verdict: 'FAILED', duration_ms: 300, failure_message: 'timeout' },
      ],
    });
    expect(batch.statusCode, batch.payload).toBe(201);

    const { items, pages } = await all(`${run}/results`, 'results', 1);
    expect(pages).toBe(4);
    expect(new Set(items.map((r) => r.id)).size).toBe(4);
    // Newest first; results from one batch share executed_at and keep the order they were sent in.
    expect(items.map((r) => `${r.external_id} ${r.verdict}`)).toEqual(['SHOP-103 FAILED', 'SHOP-102 PASSED', 'SHOP-101 PASSED', 'SHOP-101 FAILED']);
    const failed101 = items.find((r) => r.external_id === 'SHOP-101' && r.verdict === 'FAILED');
    expect(failed101).toMatchObject({ notes: 'broken', source: 'UI', tested_by: 'admin', duration_ms: null, test_run_id: seed.buildId });
    const failed103 = items.find((r) => r.external_id === 'SHOP-103');
    expect(failed103).toMatchObject({ source: 'API', duration_ms: 300, failure_message: 'timeout', environment: { environment: 'staging' } });

    const ids = (res: any) => body(res).results.map((r: any) => `${r.external_id} ${r.verdict}`).sort();
    expect(ids(await call(admin, 'GET', `${run}/results?latest_only=true`))).toEqual(['SHOP-101 PASSED', 'SHOP-102 PASSED', 'SHOP-103 FAILED']);
    expect(ids(await call(admin, 'GET', `${run}/results?verdict=failed`))).toEqual(['SHOP-101 FAILED', 'SHOP-103 FAILED']);
    expect(ids(await call(admin, 'GET', `${run}/results?verdict=FAILED&latest_only=true`))).toEqual(['SHOP-103 FAILED']);
    expect(ids(await call(admin, 'GET', `${run}/results?test_case_id=SHOP-101`))).toEqual(['SHOP-101 FAILED', 'SHOP-101 PASSED']);
    expect(ids(await call(admin, 'GET', `${run}/results?source=API`))).toEqual(['SHOP-102 PASSED', 'SHOP-103 FAILED']);
    expect((await call(admin, 'GET', `${run}/results?verdict=GREAT`)).statusCode).toBe(400);
    expect(body(await call(admin, 'GET', `${run}/results?cursor=abc`)).code).toBe('INVALID_CURSOR');

    const one = await call(admin, 'GET', `/api/v1/results/${failed103.id}`);
    expect(body(one).result).toEqual(failed103);
    expect((await call(admin, 'GET', '/api/v1/results/00000000-0000-0000-0000-000000000000')).statusCode).toBe(404);
    expect((await call(admin, 'GET', '/api/v1/runs/00000000-0000-0000-0000-000000000000/results')).statusCode).toBe(404);

    // An API token reads its own project's results, not another's.
    const token = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['EXECUTE_RUN'] })).plaintext;
    expect(body(await call(token, 'GET', `/api/v1/results/${failed103.id}`)).result.id).toBe(failed103.id);
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const otherToken = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'ci', capabilities: ['EXECUTE_RUN'] })).plaintext;
    for (const url of [`/api/v1/results/${failed103.id}`, `${run}/results`]) {
      expect(body(await call(otherToken, 'GET', url)).code, url).toBe('TOKEN_PROJECT_MISMATCH');
    }
  });

  it('pages through the audit log and filters it by action, actor and time', async () => {
    for (let i = 0; i < 5; i++) await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: `t${i}`, capabilities: ['SPEC_VIEW'] });
    const { items } = await all('/api/v1/admin/audit-logs?action=API_TOKEN_GENERATED', 'audit_logs', 2);
    expect(items).toHaveLength(5);
    expect(new Set(items.map((e) => e.id)).size).toBe(5);
    expect([...items].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((e) => e.id)).toEqual(items.map((e) => e.id));

    const adminId = items[0].actor_id;
    expect(body(await call(admin, 'GET', `/api/v1/admin/audit-logs?action=API_TOKEN_GENERATED&actor_id=${adminId}`)).audit_logs).toHaveLength(5);
    expect(body(await call(admin, 'GET', '/api/v1/admin/audit-logs?action=API_TOKEN_GENERATED&actor_id=someone-else')).audit_logs).toHaveLength(0);
    expect(body(await call(admin, 'GET', '/api/v1/admin/audit-logs?action=API_TOKEN_GENERATED&since=2999-01-01')).audit_logs).toHaveLength(0);
    expect(body(await call(admin, 'GET', '/api/v1/admin/audit-logs?since=2000-01-01')).audit_logs.length).toBeGreaterThanOrEqual(5);
    expect(body(await call(admin, 'GET', '/api/v1/admin/audit-logs?since=yesterday')).invalid_params[0].name).toBe('since');
    expect(body(await call(admin, 'GET', '/api/v1/admin/audit-logs?cursor=x')).code).toBe('INVALID_CURSOR');
  });

  it('the case history report refuses a cursor it never gave out', async () => {
    const res = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/reports/case_history`, { test_case_id: 'SHOP-101', cursor: 'nonsense' });
    expect([res.statusCode, body(res).code]).toEqual([400, 'INVALID_CURSOR']);
  });
});
