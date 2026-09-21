import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { TestPlanRepository, BuildRepository, ExecutionRepository, ProjectRepository } from '@testify/db';

describe('Reporting: verdict breakdown, trend, coverage, test-health', () => {
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

  describe('permission gating', () => {
    it('a Viewer (holds SPEC_VIEW) gets 200; a custom role without SPEC_VIEW gets 403; no token gets 401', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);

      const noAuthRes = await app.inject({ method: 'GET', url: `/api/v1/projects/${seed.projectId}/reports/coverage?plan_id=${seed.planId}` });
      expect(noAuthRes.statusCode).toBe(401);

      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');
      const viewerRes = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/coverage?plan_id=${seed.planId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(viewerRes.statusCode).toBe(200);

      const createRoleRes = await app.inject({
        method: 'POST',
        url: '/api/v1/admin/roles',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: `No Spec View ${Date.now()}`, description: null, permission_keys: ['EXECUTE_RUN'] },
      });
      expect(createRoleRes.statusCode).toBe(201);
      const restrictedRoleName = JSON.parse(createRoleRes.payload).role.name;
      const { token: restrictedToken } = await createAndLoginAs(app, adminToken, restrictedRoleName);
      const restrictedRes = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/coverage?plan_id=${seed.planId}`,
        headers: { authorization: `Bearer ${restrictedToken}` },
      });
      expect(restrictedRes.statusCode).toBe(403);
      expect(JSON.parse(restrictedRes.payload).requiredPermission).toBe('SPEC_VIEW');
    });
  });

  describe('GET .../reports/verdict-breakdown', () => {
    it('buckets each plan case\'s latest execution in the build by verdict, including untested', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // seed.caseIds has 10 cases; record verdicts for the first 3, leave the rest untested.
      const execRes = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [
            { case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' },
            { case_identifier: { external_id: 'SHOP-102' }, verdict: 'FAILED' },
            { case_identifier: { external_id: 'SHOP-103' }, verdict: 'BLOCKED' },
          ],
        },
      });
      expect(execRes.statusCode).toBe(201);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/verdict-breakdown?build_id=${seed.buildId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.total_cases).toBe(10);
      expect(body.breakdown).toEqual({ PASSED: 1, FAILED: 1, BLOCKED: 1, SKIPPED: 0, UNTESTED: 7, OTHER: 0 });
      expect(body.build.id).toBe(seed.buildId);
    });

    it('404s for a build that does not belong to the project', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const otherProject = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTHR' });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${otherProject.id}/reports/verdict-breakdown?build_id=${seed.buildId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET .../reports/trend', () => {
    it('returns one point per build, in chronological order, with a correct pass_rate', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const buildRepo = new BuildRepository(db);

      const build2 = await buildRepo.create({ test_plan_id: seed.planId, name: 'Build 2' });

      await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] },
      });
      await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${build2.id}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [
            { case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' },
            { case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED' },
          ],
        },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/trend?plan_id=${seed.planId}&limit=10`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.builds.map((b: any) => b.build_id)).toEqual([seed.buildId, build2.id]); // chronological (seed build first)
      expect(body.builds[0].passed).toBe(1);
      expect(body.builds[1].passed).toBe(2);
    });
  });

  describe('GET .../reports/coverage', () => {
    it('returns per-suite total/in-plan case counts', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/coverage?plan_id=${seed.planId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      const seedSuite = body.suites.find((s: any) => s.suite_id === seed.suiteId);
      expect(seedSuite.total_case_count).toBe(10);
      expect(seedSuite.in_plan_count).toBe(10); // seed_core_loop links all 10 cases into the plan
    });
  });

  describe('GET .../reports/test-health', () => {
    it('BUILD scope: excludes null-duration executions from slowest_tests, and surfaces flaky cases', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // SHOP-101: explicit duration, should appear in slowest_tests.
      await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', duration_ms: 5000 }] },
      });
      // SHOP-102: no duration supplied -- must NOT appear in slowest_tests with a fake value.
      await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED' }] },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/test-health?scope_type=BUILD&scope_id=${seed.buildId}&limit=10`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.slowest_tests.some((t: any) => t.external_id === 'SHOP-101')).toBe(true);
      expect(body.slowest_tests.some((t: any) => t.external_id === 'SHOP-102')).toBe(false);
      expect(body.slowest_tests[0].duration_ms).toBe(5000);
    });

    it('rejects an invalid scope_type', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/reports/test-health?scope_type=BOGUS&scope_id=${seed.buildId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(400);
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
      const row = await db.selectFrom('executions').selectAll().where('id', '=', execId).executeTakeFirstOrThrow();
      expect(row.execution_duration_ms).toBeNull();
      expect(row.execution_duration_ms).not.toBe(450);
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
        .selectFrom('executions')
        .selectAll()
        .where('test_plan_case_id', '=', planCaseRow.id)
        .where('build_id', '=', seed.buildId)
        .executeTakeFirstOrThrow();
      expect(execRow.execution_duration_ms).toBeNull();
      expect(execRow.execution_duration_ms).not.toBe(0);
    });
  });
});
