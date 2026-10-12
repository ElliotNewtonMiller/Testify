import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** Bulk changes (API roadmap step 9): many cases in one call, each through its single-item route. */
describe('Bulk changes', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'user-agent': 'bulk-test' }, ...(payload !== undefined ? { payload } : {}) });
  const bulk = (token: string, payload: unknown) => call(token, 'POST', `/api/v1/projects/${seed.projectId}/cases/bulk`, payload);
  const latestStatus = async (ref: string) => body(await call(admin, 'GET', `/api/v1/cases/${ref}`)).latest_version.status;

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('updates priority, suite and custom fields of many cases; reports each case', async () => {
    const field = body(
      await call(admin, 'POST', '/api/v1/admin/custom-fields', { entity_type: 'TestCase', name: 'component', field_label: 'Component', field_type: 'TEXT' })
    );
    expect(field.definition?.id ?? field.field?.id ?? field.custom_field?.id, JSON.stringify(field)).toBeTruthy();
    const suite = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Moved' })).suite;

    const res = await bulk(admin, {
      action: 'update',
      case_ids: ['SHOP-101', seed.caseIds[1], 'SHOP-9999'],
      changes: { priority: 'HIGH', test_suite_id: suite.id, custom_fields: { Component: 'auth' } },
    });
    expect(res.statusCode, res.payload).toBe(207);
    const out = body(res);
    expect(out.summary).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(out.results.map((r: any) => [r.external_id, r.status, r.code])).toEqual([
      ['SHOP-101', 200, undefined],
      ['SHOP-102', 200, undefined],
      [null, 404, 'NOT_FOUND'],
    ]);
    const one = body(await call(admin, 'GET', '/api/v1/cases/SHOP-102')).test_case;
    expect(one).toMatchObject({ priority: 'HIGH', test_suite_id: suite.id });
    const values = body(await call(admin, 'GET', '/api/v1/cases/SHOP-102/custom-fields')).values;
    expect(values.find((v: any) => v.definition.name === 'component').value).toBe('auth');

    // Every change has its own audit row, as through the single routes.
    const audit = body(await call(admin, 'GET', '/api/v1/admin/audit-logs?action=CASE_UPDATED')).audit_logs;
    expect(audit).toHaveLength(2);
    expect(audit[0].user_agent).toBe('bulk-test');

    // Refused up front: nothing to change, an unknown field, a repeated case.
    expect((await bulk(admin, { action: 'update', case_ids: ['SHOP-101'], changes: {} })).statusCode).toBe(400);
    const unknown = await bulk(admin, { action: 'update', case_ids: ['SHOP-101'], changes: { custom_fields: { nope: 1 } } });
    expect([unknown.statusCode, body(unknown).code]).toEqual([400, 'UNKNOWN_FIELD']);
    expect((await bulk(admin, { action: 'deprecate', case_ids: ['SHOP-101', 'SHOP-101'] })).statusCode).toBe(400);
    expect((await bulk(admin, { action: 'explode', case_ids: ['SHOP-101'] })).statusCode).toBe(400);
  });

  it('deprecates, restores and approves the latest versions; wrong states fail per case', async () => {
    const dep = body(await bulk(admin, { action: 'deprecate', case_ids: ['SHOP-101', 'SHOP-102'] }));
    expect(dep.summary.succeeded).toBe(2);
    expect(await latestStatus('SHOP-101')).toBe('DEPRECATED');

    const again = body(await bulk(admin, { action: 'deprecate', case_ids: ['SHOP-101', 'SHOP-103'] }));
    expect(again.results.map((r: any) => [r.external_id, r.status, r.code])).toEqual([
      ['SHOP-101', 422, 'VERSION_NOT_APPROVED'],
      ['SHOP-103', 200, undefined],
    ]);

    expect(body(await bulk(admin, { action: 'restore', case_ids: ['SHOP-101', 'SHOP-102', 'SHOP-103'] })).summary.succeeded).toBe(3);
    expect(await latestStatus('SHOP-103')).toBe('APPROVED');

    await call(admin, 'POST', '/api/v1/cases/SHOP-104/versions');
    await call(admin, 'POST', '/api/v1/cases/SHOP-105/versions');
    const approved = body(await bulk(admin, { action: 'approve', case_ids: ['SHOP-104', 'SHOP-105', 'SHOP-106'] }));
    expect(approved.results.map((r: any) => r.status)).toEqual([200, 200, 422]);
    expect(approved.results[0].test_case_version_id).toBeTruthy();
    expect(await latestStatus('SHOP-104')).toBe('APPROVED');
  });

  it('needs the permission of the action; a token stays in its project', async () => {
    const viewer = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'v', capabilities: ['SPEC_VIEW', 'SPEC_EDIT'] })).plaintext;
    const res = await bulk(viewer, { action: 'deprecate', case_ids: ['SHOP-101'] });
    expect([res.statusCode, body(res).required_permission]).toEqual([403, 'SPEC_APPROVE']);
    const fields = await bulk(viewer, { action: 'update', case_ids: ['SHOP-101'], changes: { custom_fields: { x: 1 } } });
    expect([fields.statusCode, body(fields).required_permission]).toEqual([403, 'PLAN_MANAGE']);
    expect((await bulk(viewer, { action: 'update', case_ids: ['SHOP-101'], changes: { priority: 'LOW' } })).statusCode).toBe(200);

    // Another project's case is simply not found here.
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const otherSuite = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/suites`, { name: 'S' })).suite;
    const otherCase = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/cases`, { test_suite_id: otherSuite.id, title: 'T' })).test_case;
    const cross = body(await bulk(admin, { action: 'update', case_ids: [otherCase.id], changes: { priority: 'LOW' } }));
    expect(cross.results[0]).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(body(await call(admin, 'GET', `/api/v1/cases/${otherCase.id}`)).test_case.priority).not.toBe('LOW');
  });

  it('adds and removes many cases in a plan; cases with results are retired only when asked', async () => {
    const plan = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/plans`, { name: 'Bulk plan' })).plan;
    const url = `/api/v1/plans/${plan.id}/cases/bulk`;
    await call(admin, 'POST', '/api/v1/cases/SHOP-103/versions'); // a DRAFT can't be added
    const added = body(await call(admin, 'POST', url, { action: 'add', case_ids: ['SHOP-101', 'SHOP-102', 'SHOP-103'] }));
    expect(added.results.map((r: any) => [r.external_id, r.status])).toEqual([
      ['SHOP-101', 201],
      ['SHOP-102', 201],
      ['SHOP-103', 422],
    ]);
    expect(added.results[0].test_plan_case_id).toBeTruthy();
    // Adding again is fine.
    expect(body(await call(admin, 'POST', url, { action: 'add', case_ids: ['SHOP-101'] })).results[0].status).toBe(200);

    const run = body(await call(admin, 'POST', `/api/v1/plans/${plan.id}/runs`, { name: 'r' })).run;
    await call(admin, 'POST', `/api/v1/runs/${run.id}/results/batch`, { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] });

    const refused = body(await call(admin, 'POST', url, { action: 'remove', case_ids: ['SHOP-101', 'SHOP-102'] }));
    expect(refused.results.map((r: any) => [r.status, r.code])).toEqual([
      [409, 'CASE_HAS_RESULTS'],
      [204, undefined],
    ]);
    const retired = body(await call(admin, 'POST', url, { action: 'remove', case_ids: ['SHOP-101'], retire_if_has_results: true }));
    expect(retired.results[0].status).toBe(204);
    const planCases = body(await call(admin, 'GET', `/api/v1/plans/${plan.id}/cases`));
    const left = planCases.cases ?? planCases.plan_cases;
    expect(left.map((c: any) => [c.external_id, c.removed_from_plan])).toEqual([['SHOP-101', true]]);

    await call(admin, 'PATCH', `/api/v1/plans/${plan.id}`, { status: 'LOCKED' });
    expect(body(await call(admin, 'POST', url, { action: 'add', case_ids: ['SHOP-104'] })).code).toBe('PLAN_LOCKED');
  });
});
