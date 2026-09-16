import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.ts';
import {
  TestSuiteRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
} from '@testify/db';

describe('Specification / Plan Curation Routes', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<{ token: string; userId: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'admin', password: 'password' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    return { token: body.token as string, userId: body.user.id as string };
  }

  async function createAndLoginViewer(app: any, adminToken: string): Promise<string> {
    const username = `viewer_${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        username,
        email: `${username}@testify.local`,
        password: 'SecurePass123!',
        global_role: 'Viewer',
      },
    });
    expect(createRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return JSON.parse(loginRes.payload).token as string;
  }

  it('spec-tree lists all cases with correct linkable + in_plan flags, and per-suite counts', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const caseRepo = new TestCaseRepository(db);
    const versionRepo = new TestCaseVersionRepository(db);

    const draftCase = await caseRepo.create({
      project_id: seed.projectId,
      test_suite_id: seed.suiteId,
      external_id: 'SHOP-DRAFT-1',
      title: 'Draft-only case',
    });
    await versionRepo.create({
      test_case_id: draftCase.id,
      version_number: 1,
      status: 'DRAFT',
      author_id: 'usr_qa_lead_01',
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/spec-tree?plan_id=${seed.planId}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.cases).toHaveLength(11);

    const approvedResult = body.cases.find((c: any) => c.external_id === 'SHOP-101');
    expect(approvedResult.in_plan).toBe(true);
    expect(approvedResult.linkable).toBe(true);

    const draftResult = body.cases.find((c: any) => c.external_id === 'SHOP-DRAFT-1');
    expect(draftResult.in_plan).toBe(false);
    expect(draftResult.linkable).toBe(false);

    expect(body.suites).toHaveLength(1);
    expect(body.suites[0].total_case_count).toBe(11);
    expect(body.suites[0].in_plan_count).toBe(10);
  });

  it('unauthenticated request to spec-tree is rejected with 401', async () => {
    const { app, seed } = serverInstance;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/spec-tree`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('add/remove toggle happy path, including idempotent re-add and 404 on re-remove', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const caseRepo = new TestCaseRepository(db);
    const versionRepo = new TestCaseVersionRepository(db);
    const newCase = await caseRepo.create({
      project_id: seed.projectId,
      test_suite_id: seed.suiteId,
      external_id: 'SHOP-NEW-1',
      title: 'New approved case',
    });
    await versionRepo.create({
      test_case_id: newCase.id,
      version_number: 1,
      status: 'APPROVED',
      author_id: 'usr_qa_lead_01',
    });

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: newCase.id },
    });
    expect(addRes.statusCode).toBe(201);
    expect(JSON.parse(addRes.payload).test_case_id).toBe(newCase.id);

    const reAddRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: newCase.id },
    });
    expect(reAddRes.statusCode).toBe(200);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-plans/${seed.planId}/cases/${newCase.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removeRes.statusCode).toBe(204);

    const removeAgainRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-plans/${seed.planId}/cases/${newCase.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removeAgainRes.statusCode).toBe(404);
  });

  it('adding a DRAFT-only case is rejected with 422 CASE_VERSION_NOT_APPROVED', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const caseRepo = new TestCaseRepository(db);
    const versionRepo = new TestCaseVersionRepository(db);
    const draftCase = await caseRepo.create({
      project_id: seed.projectId,
      test_suite_id: seed.suiteId,
      external_id: 'SHOP-DRAFT-2',
      title: 'Another draft case',
    });
    await versionRepo.create({
      test_case_id: draftCase.id,
      version_number: 1,
      status: 'DRAFT',
      author_id: 'usr_qa_lead_01',
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: draftCase.id },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).code).toBe('CASE_VERSION_NOT_APPROVED');
  });

  it('PLAN_MANAGE is required to add/remove/cascade -- a Viewer gets 403, but can still read spec-tree', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const viewerToken = await createAndLoginViewer(app, adminToken);

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { test_case_id: seed.caseIds[0] },
    });
    expect(addRes.statusCode).toBe(403);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-plans/${seed.planId}/cases/${seed.caseIds[0]}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(removeRes.statusCode).toBe(403);

    const cascadeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/suites/${seed.suiteId}/cascade`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { action: 'ADD' },
    });
    expect(cascadeRes.statusCode).toBe(403);

    const specRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/spec-tree`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(specRes.statusCode).toBe(200);
  });

  it('a LOCKED plan blocks add, remove, and cascade with 422 PLAN_LOCKED', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const planRepo = new TestPlanRepository(db);
    await planRepo.updateStatus(seed.planId, 'LOCKED');

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: seed.caseIds[0] },
    });
    expect(addRes.statusCode).toBe(422);
    expect(JSON.parse(addRes.payload).code).toBe('PLAN_LOCKED');

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-plans/${seed.planId}/cases/${seed.caseIds[0]}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removeRes.statusCode).toBe(422);

    const cascadeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/suites/${seed.suiteId}/cascade`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'REMOVE' },
    });
    expect(cascadeRes.statusCode).toBe(422);
  });

  it('cascade ADD reports partial success when some cases in the subtree are not Approved', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const suiteRepo = new TestSuiteRepository(db);
    const caseRepo = new TestCaseRepository(db);
    const versionRepo = new TestCaseVersionRepository(db);
    const planRepo = new TestPlanRepository(db);

    const suite = await suiteRepo.create({ project_id: seed.projectId, name: 'Cascade Test Suite' });
    const plan = await planRepo.create({ project_id: seed.projectId, name: 'Cascade Test Plan' });

    const approvedCase = await caseRepo.create({
      project_id: seed.projectId,
      test_suite_id: suite.id,
      external_id: 'CASC-A',
      title: 'Approved',
    });
    await versionRepo.create({ test_case_id: approvedCase.id, version_number: 1, status: 'APPROVED', author_id: 'u1' });

    const draftCase = await caseRepo.create({
      project_id: seed.projectId,
      test_suite_id: suite.id,
      external_id: 'CASC-B',
      title: 'Draft',
    });
    await versionRepo.create({ test_case_id: draftCase.id, version_number: 1, status: 'DRAFT', author_id: 'u1' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${plan.id}/suites/${suite.id}/cascade`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'ADD' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.added).toBe(1);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].external_id).toBe('CASC-B');
    expect(body.skipped[0].reason).toBe('NOT_APPROVED');

    const pinned = await planRepo.getPinnedCases(plan.id);
    expect(pinned).toHaveLength(1);
    expect(pinned[0].test_case_id).toBe(approvedCase.id);
  });

  it('removing a plan-case with recorded executions is rejected with 422 CASE_HAS_EXECUTIONS', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const planCasesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
    });
    const planCases = JSON.parse(planCasesRes.payload).cases;
    const firstPlanCase = planCases.find((c: any) => c.case_id === seed.caseIds[0]);

    const execRes = await app.inject({
      method: 'POST',
      url: '/api/v1/executions',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        build_id: seed.buildId,
        test_plan_case_id: firstPlanCase.plan_case_id,
        verdict: 'PASSED',
      },
    });
    expect(execRes.statusCode).toBe(201);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-plans/${seed.planId}/cases/${seed.caseIds[0]}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(removeRes.statusCode).toBe(422);
    expect(JSON.parse(removeRes.payload).code).toBe('CASE_HAS_EXECUTIONS');
  });

  it('GET /api/v1/projects and /api/v1/projects/:id/plans return the real seeded data', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const projectsRes = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(projectsRes.statusCode).toBe(200);
    const projects = JSON.parse(projectsRes.payload).projects;
    expect(projects.some((p: any) => p.id === seed.projectId)).toBe(true);

    const plansRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/plans`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(plansRes.statusCode).toBe(200);
    const plans = JSON.parse(plansRes.payload).plans;
    expect(plans.some((p: any) => p.id === seed.planId)).toBe(true);
  });
});
