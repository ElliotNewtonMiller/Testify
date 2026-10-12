import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

/** CI results as JUnit XML, and recording into a run by name (API roadmap step 5). */
describe('JUnit results and runs by name', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload !== undefined ? { payload } : {}) });
  const upload = (token: string, url: string, xml: string, contentType = 'application/xml') => call(token, 'POST', url, xml, { 'content-type': contentType });

  // The seed's suite is "Authentication & OAuth2 Engine"; SHOP-101's title is "OAuth2 PKCE Code Exchange Flow".
  const report = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="auth" tests="5">
    <testcase classname="tests.auth" name="[SHOP-102] rotates refresh tokens" time="0.25"/>
    <testcase classname="Authentication &amp; OAuth2 Engine" name="OAuth2 PKCE Code Exchange Flow" time="1.5">
      <failure message="expected 302, got 500">AssertionError: expected 302, got 500
  at pkce.spec.ts:42</failure>
    </testcase>
    <testcase classname="tests.auth" name="checks password rules"><properties><property name="testify_id" value="SHOP-103"/></properties><error message="boom"/></testcase>
    <testcase classname="tests.auth" name="SHOP-104 single sign-on"><skipped message="IdP is down"/></testcase>
    <testcase classname="tests.misc" name="not tracked in Testify"/>
  </testsuite>
</testsuites>`;

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('records a JUnit file in a run: by readable id, property, or suite and title; unmatched tests are listed', async () => {
    const res = await upload(admin, `/api/v1/runs/${seed.buildId}/results/junit?environment=ci&ci_name=GitHub%20Actions&commit_sha=abc123`, report);
    expect(res.statusCode, res.payload).toBe(207);
    const out = body(res);
    expect(out.summary).toMatchObject({ total_submitted: 5, successful: 4, failed: 1 });
    expect(out.results.map((r: any) => [r.test_name, r.status, r.code ?? r.verdict])).toEqual([
      ['tests.auth.[SHOP-102] rotates refresh tokens', 201, 'PASSED'],
      ['Authentication & OAuth2 Engine.OAuth2 PKCE Code Exchange Flow', 201, 'FAILED'],
      ['tests.auth.checks password rules', 201, 'FAILED'],
      ['tests.auth.SHOP-104 single sign-on', 201, 'SKIPPED'],
      ['tests.misc.not tracked in Testify', 422, 'CASE_NOT_FOUND'],
    ]);

    const results = body(await call(admin, 'GET', `/api/v1/runs/${seed.buildId}/results`)).results;
    const byCase = Object.fromEntries(results.map((r: any) => [r.external_id, r]));
    expect(byCase['SHOP-102']).toMatchObject({ verdict: 'PASSED', duration_ms: 250, source: 'API', environment: { environment: 'ci' }, runner: { name: 'GitHub Actions', commit_sha: 'abc123' } });
    expect(byCase['SHOP-101']).toMatchObject({ verdict: 'FAILED', duration_ms: 1500, failure_message: 'expected 302, got 500' });
    expect(byCase['SHOP-101'].stack_trace).toContain('pkce.spec.ts:42');
    expect(byCase['SHOP-103']).toMatchObject({ verdict: 'FAILED', failure_message: 'boom' });
    expect(byCase['SHOP-103'].notes).toMatch(/errored/);
    expect(byCase['SHOP-104']).toMatchObject({ verdict: 'SKIPPED', notes: 'IdP is down', failure_message: null });

    // With all_or_nothing, the unmatched test stops everything.
    const atomic = await upload(admin, `/api/v1/runs/${seed.buildId}/results/junit?all_or_nothing=true`, report);
    expect([atomic.statusCode, body(atomic).code]).toEqual([422, 'CASE_NOT_FOUND']);
    expect(body(await call(admin, 'GET', `/api/v1/runs/${seed.buildId}/results`)).results).toHaveLength(4);
  });

  it('refuses what is not a usable JUnit file', async () => {
    const url = `/api/v1/runs/${seed.buildId}/results/junit`;
    for (const [payload, contentType] of [
      ['', 'application/xml'],
      ['<html><body>hi</body></html>', 'text/html'],
      ['{"results": []}', 'application/json'],
      ['<testsuite name="x"><testcase name="a">', 'text/xml'],
      ['<testsuites><testsuite name="empty"/></testsuites>', 'application/xml'],
    ]) {
      const res = await upload(admin, url, payload, contentType);
      expect([res.statusCode, body(res).code], payload).toEqual([400, 'INVALID_JUNIT']);
    }
    // Any content type works, including curl's default for --data-binary.
    const plain = await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-105 x"/></testsuite>', 'application/x-www-form-urlencoded');
    expect(plain.statusCode, plain.payload).toBe(201);
  });

  it('creates the run named in run_name once, then reuses it; creating needs RUN_MANAGE', async () => {
    const url = `/api/v1/plans/${seed.planId}/results/junit?run_name=${encodeURIComponent('CI build 77')}`;
    const first = body(await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-105 a"/></testsuite>'));
    expect(first.run).toMatchObject({ name: 'CI build 77', created: true });
    const again = body(await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-106 b"/></testsuite>'));
    expect(again.run).toEqual({ ...first.run, created: false });
    expect(body(await call(admin, 'GET', `/api/v1/runs/${first.run.id}/results`)).results).toHaveLength(2);

    // Parallel jobs naming the same new run all end up in one run.
    const parallel = await Promise.all(
      [1, 2, 3].map((i) => upload(admin, `/api/v1/plans/${seed.planId}/results/junit?run_name=parallel`, `<testsuite name="x"><testcase name="SHOP-10${i} t"/></testsuite>`))
    );
    expect(parallel.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(parallel.map((r) => body(r).run.id)).size).toBe(1);
    expect(parallel.filter((r) => body(r).run.created)).toHaveLength(1);

    // A token with EXECUTE_RUN only: reuses a run, can't create one.
    const token = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['EXECUTE_RUN'] })).plaintext;
    const reuse = await upload(token, url, '<testsuite name="x"><testcase name="SHOP-107 c"/></testsuite>');
    expect([reuse.statusCode, body(reuse).run.created]).toEqual([201, false]);
    const create = await upload(token, `/api/v1/plans/${seed.planId}/results/junit?run_name=new`, '<testsuite name="x"><testcase name="SHOP-107 c"/></testsuite>');
    expect([create.statusCode, body(create).required_permission]).toEqual([403, 'RUN_MANAGE']);

    // run_name is required; a closed run refuses results.
    const noName = await upload(admin, `/api/v1/plans/${seed.planId}/results/junit`, '<testsuite name="x"><testcase name="SHOP-105 a"/></testsuite>');
    expect(noName.statusCode).toBe(400);
    await call(admin, 'PATCH', `/api/v1/runs/${first.run.id}`, { status: 'CLOSED' });
    const closed = await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-105 a"/></testsuite>');
    expect([closed.statusCode, body(closed).code]).toEqual([422, 'RUN_CLOSED']);
  });

  it("CI results never auto-close the run; close_run closes it and needs RUN_MANAGE", async () => {
    // Every case in the plan gets a result, in two files: the run stays open for the second.
    const all = (from: number, to: number) =>
      `<testsuite name="x">${Array.from({ length: to - from + 1 }, (_, i) => `<testcase name="SHOP-10${from + i} t"/>`).join('')}</testsuite>`;
    const url = `/api/v1/plans/${seed.planId}/results/junit?run_name=build-9`;
    const first = await upload(admin, url, all(1, 9));
    expect(body(first).run_status).toBe('OPEN');
    const everything = await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-1010 t"/><testcase name="SHOP-101 retry"/></testsuite>');
    expect([everything.statusCode, body(everything).run_status]).toEqual([201, 'OPEN']);
    // A re-run of the job still records.
    expect((await upload(admin, url, '<testsuite name="x"><testcase name="SHOP-101 t"/></testsuite>')).statusCode).toBe(201);

    const token = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'ci', capabilities: ['EXECUTE_RUN'] })).plaintext;
    const refused = await upload(token, `${url}&close_run=true`, '<testsuite name="x"><testcase name="SHOP-102 t"/></testsuite>');
    expect([refused.statusCode, body(refused).required_permission]).toEqual([403, 'RUN_MANAGE']);

    const closing = await call(admin, 'POST', `/api/v1/plans/${seed.planId}/results/batch?run_name=build-9&close_run=true`, {
      results: [{ case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED' }],
    });
    expect([closing.statusCode, body(closing).run_status]).toEqual([201, 'CLOSED']);
    expect(body(await call(admin, 'GET', `/api/v1/runs/${body(closing).run.id}`)).run.status).toBe('CLOSED');
  });

  it('the JSON batch also records into a run by name', async () => {
    const url = `/api/v1/plans/${seed.planId}/results/batch?run_name=nightly`;
    const res = await call(admin, 'POST', url, { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] });
    expect(res.statusCode, res.payload).toBe(201);
    expect(body(res).run).toMatchObject({ name: 'nightly', created: true });
    // An empty batch leaves no run behind.
    expect((await call(admin, 'POST', `/api/v1/plans/${seed.planId}/results/batch?run_name=empty`, { results: [] })).statusCode).toBe(400);
    const runs = body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}/runs`)).runs.map((r: any) => r.name);
    expect(runs).toContain('nightly');
    expect(runs).not.toContain('empty');
  });

  it('a JUnit file imported as cases matches the same file uploaded as results', async () => {
    const junit = `<testsuite name="Checkout" tests="2">
      <testcase classname="com.shop.CartTest" name="adds an item" time="0.1"/>
      <testcase classname="com.shop.CartTest" name="removes an item" time="0.2"><failure message="still there"/></testcase>
    </testsuite>`;
    const imported = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/imports/execute`, {
      file_content: junit,
      format: 'JUNIT_XML',
      configuration: { field_mappings: [], duplicate_resolution: { default_action: 'CREATE_NEW' } },
    });
    expect(imported.statusCode, imported.payload).toBeLessThan(300);

    const res = await upload(admin, `/api/v1/plans/${seed.planId}/results/junit?run_name=build-1`, junit);
    expect(res.statusCode, res.payload).toBe(201);
    expect(body(res).results.map((r: any) => r.verdict)).toEqual(['PASSED', 'FAILED']);
    // The imported cases were added to the plan.
    const planCases = body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}/cases`));
    const titles = (planCases.cases ?? planCases.plan_cases).map((c: any) => c.title);
    expect(titles).toEqual(expect.arrayContaining(['adds an item', 'removes an item']));
  });
});
