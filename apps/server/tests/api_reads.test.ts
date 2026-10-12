import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { TestCaseRepository, TestSuiteRepository, TestCaseVersionRepository } from '@testify/db';

/** Reading single items, version history, and readable case ids (SHOP-101) wherever a case id is taken. */
describe('API reads: single items and readable case ids', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string | null, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload } : {}) });

  beforeEach(async () => {
    ({ app, db, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('reads a project, plan, run, suite, case, its versions and one version by id', async () => {
    const project = body(await call(admin, 'GET', `/api/v1/projects/${seed.projectId}`)).project;
    expect(project).toMatchObject({ id: seed.projectId, prefix: 'SHOP' });
    expect(project.permissions).toContain('SYSTEM_ADMIN');
    expect(body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}`)).plan.id).toBe(seed.planId);
    expect(body(await call(admin, 'GET', `/api/v1/runs/${seed.buildId}`)).run).toMatchObject({ id: seed.buildId, test_plan_id: seed.planId });
    expect(body(await call(admin, 'GET', `/api/v1/suites/${seed.suiteId}`)).suite.id).toBe(seed.suiteId);

    const one = body(await call(admin, 'GET', `/api/v1/cases/${seed.caseIds[0]}`));
    expect(one.test_case.id).toBe(seed.caseIds[0]);
    expect(one.latest_version.version_number).toBe(1);
    expect(Array.isArray(one.latest_version.steps)).toBe(true);

    // A second version: the history lists both, newest first, each with steps.
    const draft = body(await call(admin, 'POST', `/api/v1/cases/${seed.caseIds[0]}/versions`)).version;
    const versions = body(await call(admin, 'GET', `/api/v1/cases/${seed.caseIds[0]}/versions`)).versions;
    expect(versions.map((v: any) => v.version_number)).toEqual([2, 1]);
    expect(versions[0].steps.length).toBe(versions[1].steps.length);
    expect(body(await call(admin, 'GET', `/api/v1/versions/${draft.id}`)).version).toMatchObject({ id: draft.id, status: 'DRAFT' });

    for (const url of ['/api/v1/projects/', '/api/v1/plans/', '/api/v1/runs/', '/api/v1/suites/', '/api/v1/cases/', '/api/v1/versions/']) {
      expect((await call(admin, 'GET', `${url}00000000-0000-0000-0000-000000000000`)).statusCode, url).toBe(404);
    }
  });

  it('takes a readable case id wherever it takes a case id', async () => {
    const caseId = seed.caseIds[0];
    expect(body(await call(admin, 'GET', '/api/v1/cases/SHOP-101')).test_case.id).toBe(caseId);
    expect(body(await call(admin, 'PATCH', '/api/v1/cases/SHOP-101', { priority: 'LOW' })).test_case).toMatchObject({ id: caseId, priority: 'LOW' });
    expect(body(await call(admin, 'GET', '/api/v1/cases/SHOP-101/versions/latest')).test_case.id).toBe(caseId);
    expect((await call(admin, 'GET', '/api/v1/cases/SHOP-101/custom-fields')).statusCode).toBe(200);

    // Plan membership, by path and by body.
    expect((await call(admin, 'DELETE', `/api/v1/plans/${seed.planId}/cases/SHOP-101`)).statusCode).toBe(204);
    const added = await call(admin, 'POST', `/api/v1/plans/${seed.planId}/cases`, { test_case_id: 'SHOP-101' });
    expect(added.statusCode).toBe(201);
    expect(body(added).plan_case.test_case_id).toBe(caseId);

    // Moving, and a report.
    const target = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/suites`, { name: 'Target' })).suite;
    const moved = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/move`, { case_ids: ['SHOP-101', 'SHOP-102'], target_suite_id: target.id });
    expect(body(moved).moved_case_count).toBe(2);
    const history = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/reports/case_history`, { test_case_id: 'SHOP-101' });
    expect(body(history).case.test_case_id).toBe(caseId);

    // An unknown readable id is just not found.
    expect((await call(admin, 'GET', '/api/v1/cases/SHOP-99999')).statusCode).toBe(404);
  });

  it('a readable id shared by two projects needs the project to tell them apart', async () => {
    // Another project with an imported case that kept the id SHOP-101.
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const suite = await new TestSuiteRepository(db).create({ project_id: other.id, name: 'Imported' });
    const twin = await new TestCaseRepository(db).create({ project_id: other.id, test_suite_id: suite.id, external_id: 'SHOP-101', title: 'Twin' });
    await new TestCaseVersionRepository(db).create({ test_case_id: twin.id, version_number: 1, status: 'APPROVED', author_id: 'u' });

    const ambiguous = await call(admin, 'GET', '/api/v1/cases/SHOP-101');
    expect(ambiguous.statusCode).toBe(400);
    expect(body(ambiguous)).toMatchObject({ code: 'AMBIGUOUS_CASE_ID', invalid_params: [{ name: 'caseId', reason: 'matches cases in 2 projects' }] });

    // The plan names the project, so this one is clear.
    expect((await call(admin, 'DELETE', `/api/v1/plans/${seed.planId}/cases/SHOP-101`)).statusCode).toBe(204);
    // So does an API token's own project.
    const token = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW'] })).plaintext;
    expect(body(await call(token, 'GET', '/api/v1/cases/SHOP-101')).test_case.id).toBe(twin.id);
    // The internal id always works.
    expect(body(await call(admin, 'GET', `/api/v1/cases/${twin.id}`)).test_case.title).toBe('Twin');
    // Without a sign-in, nothing is said about readable ids.
    expect((await call(null, 'GET', '/api/v1/cases/SHOP-101')).statusCode).toBe(401);
  });

  it("an API token can't read another project's items by id or readable id", async () => {
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const token = body(await call(admin, 'POST', `/api/v1/projects/${other.id}/api-tokens`, { name: 'ci', capabilities: ['SPEC_VIEW'] })).plaintext;
    for (const url of [`/api/v1/projects/${seed.projectId}`, `/api/v1/plans/${seed.planId}`, `/api/v1/runs/${seed.buildId}`, `/api/v1/suites/${seed.suiteId}`, '/api/v1/cases/SHOP-101']) {
      const res = await call(token, 'GET', url);
      expect([url, res.statusCode, body(res).code]).toEqual([url, 403, 'TOKEN_PROJECT_MISMATCH']);
    }
  });
});
