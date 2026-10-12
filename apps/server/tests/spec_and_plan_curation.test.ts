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
      url: `/api/v1/projects/${seed.projectId}/spec-tree?test_plan_id=${seed.planId}`,
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
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: newCase.id },
    });
    expect(addRes.statusCode).toBe(201);
    expect(JSON.parse(addRes.payload).plan_case.test_case_id).toBe(newCase.id);

    const reAddRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: newCase.id },
    });
    expect(reAddRes.statusCode).toBe(200);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plans/${seed.planId}/cases/${newCase.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removeRes.statusCode).toBe(204);

    const removeAgainRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plans/${seed.planId}/cases/${newCase.id}`,
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
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: draftCase.id },
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).code).toBe('CASE_VERSION_NOT_APPROVED');
  });

  it('PLAN_MANAGE is required to add/remove cases and whole suites -- a Viewer gets 403, but can still read spec-tree', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const viewerToken = await createAndLoginViewer(app, adminToken);

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { test_case_id: seed.caseIds[0] },
    });
    expect(addRes.statusCode).toBe(403);

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plans/${seed.planId}/cases/${seed.caseIds[0]}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(removeRes.statusCode).toBe(403);

    const cascadeRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${seed.planId}/suites/${seed.suiteId}/cases`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(cascadeRes.statusCode).toBe(403);

    const specRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/spec-tree`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(specRes.statusCode).toBe(200);
  });

  it('a LOCKED plan blocks adding and removing cases and whole suites with 422 PLAN_LOCKED', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const planRepo = new TestPlanRepository(db);
    await planRepo.updateStatus(seed.planId, 'LOCKED');

    const addRes = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: seed.caseIds[0] },
    });
    expect(addRes.statusCode).toBe(422);
    expect(JSON.parse(addRes.payload).code).toBe('PLAN_LOCKED');

    const removeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plans/${seed.planId}/cases/${seed.caseIds[0]}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(removeRes.statusCode).toBe(422);

    const cascadeRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/plans/${seed.planId}/suites/${seed.suiteId}/cases`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(cascadeRes.statusCode).toBe(422);
  });

  it('adding a whole suite reports partial success when some cases in the subtree are not Approved', async () => {
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
      url: `/api/v1/plans/${plan.id}/suites/${suite.id}/cases`,
      headers: { authorization: `Bearer ${token}` },
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

  it('removing a case that has results asks to confirm, then retires it: old runs keep its result, new runs drop it', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const queue = async (buildId: string) =>
      JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/plans/${seed.planId}/cases?test_run_id=${buildId}`, headers: auth })).payload).cases;

    const caseId = seed.caseIds[0];
    const linkId = (await queue(seed.buildId)).find((c: any) => c.test_case_id === caseId).test_plan_case_id;
    const execRes = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results`, headers: auth, payload: { test_plan_case_id: linkId, verdict: 'FAILED' } });
    expect(execRes.statusCode).toBe(201);

    // Without force: nothing changes, and the counts come back for a confirmation.
    const ask = await app.inject({ method: 'DELETE', url: `/api/v1/plans/${seed.planId}/cases/${caseId}`, headers: auth });
    expect(ask.statusCode).toBe(409);
    const askBody = JSON.parse(ask.payload);
    expect(askBody.code).toBe('CASE_HAS_RESULTS');
    expect(askBody.detail).toContain('has 1 result in 1 run');
    expect((await queue(seed.buildId)).some((c: any) => c.test_case_id === caseId)).toBe(true);

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/plans/${seed.planId}/cases/${caseId}?force=true`, headers: auth });
    expect(removed.statusCode).toBe(204);
    const link = await db.selectFrom('test_plan_cases').selectAll().where('id', '=', linkId).executeTakeFirstOrThrow();
    expect(link.removed_at).toBeTruthy();
    const audit = JSON.parse((await app.inject({ method: 'GET', url: '/api/v1/admin/audit-logs', headers: auth })).payload).audit_logs;
    expect(audit.some((a: any) => a.action === 'PLAN_CASE_RETIRED')).toBe(true);

    // Gone from the plan (Spec mode's In Plan)...
    expect((await new TestPlanRepository(db).getPinnedCases(seed.planId)).some((pc) => pc.test_case_id === caseId)).toBe(false);
    // ...still in the old run with its result, flagged; recording more is refused.
    const old = (await queue(seed.buildId)).find((c: any) => c.test_case_id === caseId);
    expect(old).toMatchObject({ removed_from_plan: true, latest_verdict: 'FAILED' });
    const again = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results`, headers: auth, payload: { test_plan_case_id: linkId, verdict: 'PASSED' } });
    expect(again.statusCode).toBe(422);
    expect(JSON.parse(again.payload).code).toBe('CASE_REMOVED_FROM_PLAN');
    const extId = (await db.selectFrom('test_cases').select('external_id').where('id', '=', caseId).executeTakeFirstOrThrow()).external_id;
    const batch = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results/batch`,
      headers: auth,
      payload: { results: [{ case_identifier: { external_id: extId }, verdict: 'PASSED' }] },
    });
    expect(JSON.parse(batch.payload).results[0]).toMatchObject({ status: 422, detail: expect.stringContaining('removed from this test plan') });
    expect((await new TestPlanRepository(db).getPinnedCases(seed.planId)).some((pc) => pc.test_case_id === caseId)).toBe(false); // not re-linked

    // The old run's report still counts it; a new run doesn't contain it.
    const summary = JSON.parse(
      (await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/reports/run_summary`, headers: auth, payload: { test_run_id: seed.buildId } })).payload
    );
    expect(summary.summary).toMatchObject({ total: seed.caseIds.length, failed: 1 });
    const newRun = await app.inject({ method: 'POST', url: `/api/v1/plans/${seed.planId}/runs`, headers: auth, payload: { name: 'After removal' } });
    const newRunId = JSON.parse(newRun.payload).run.id;
    const newQueue = await queue(newRunId);
    expect(newQueue).toHaveLength(seed.caseIds.length - 1);
    expect(newQueue.some((c: any) => c.test_case_id === caseId)).toBe(false);

    // Adding it back creates a fresh link that new runs pick up; the old run keeps the old one.
    const readd = await app.inject({ method: 'POST', url: `/api/v1/plans/${seed.planId}/cases`, headers: auth, payload: { test_case_id: caseId } });
    expect(readd.statusCode).toBe(201);
    const fresh = (await queue(newRunId)).find((c: any) => c.test_case_id === caseId);
    expect(fresh).toMatchObject({ removed_from_plan: false, latest_verdict: 'UNTESTED' });
    expect(fresh.test_plan_case_id).not.toBe(linkId);
    // The old run shows its earlier result once, and -- now that the case is back in the plan --
    // accepts new results, recorded against the fresh link.
    const oldAgain = (await queue(seed.buildId)).filter((c: any) => c.test_case_id === caseId);
    expect(oldAgain).toHaveLength(1);
    expect(oldAgain[0]).toMatchObject({ test_plan_case_id: fresh.test_plan_case_id, removed_from_plan: false, latest_verdict: 'FAILED' });
    const rerecord = await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results`, headers: auth, payload: { test_plan_case_id: fresh.test_plan_case_id, verdict: 'PASSED' } });
    expect(rerecord.statusCode).toBe(201);
    expect((await queue(seed.buildId)).find((c: any) => c.test_case_id === caseId)).toMatchObject({ latest_verdict: 'PASSED', removed_from_plan: false });
    const history = JSON.parse(
      (await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/reports/case_history`, headers: auth, payload: { test_case_id: caseId } })).payload
    );
    expect(history.results.map((e: any) => e.verdict)).toEqual(['PASSED', 'FAILED']); // both links' results
  });

  it('removing a whole suite asks to confirm when cases have results, then retires those and unlinks the rest', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };
    const cases = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`, headers: auth })).payload).cases;
    await app.inject({ method: 'POST', url: `/api/v1/runs/${seed.buildId}/results`, headers: auth, payload: { test_plan_case_id: cases[0].test_plan_case_id, verdict: 'PASSED' } });

    const url = `/api/v1/plans/${seed.planId}/suites/${seed.suiteId}/cases`;
    const ask = await app.inject({ method: 'DELETE', url, headers: auth });
    expect(ask.statusCode).toBe(409);
    expect(JSON.parse(ask.payload).detail).toMatch(/^1 case in suite .* has 1 result in 1 run\. Remove it/);

    const done = await app.inject({ method: 'DELETE', url: `${url}?force=true`, headers: auth });
    expect(done.statusCode).toBe(200);
    expect(JSON.parse(done.payload)).toMatchObject({ removed: seed.caseIds.length - 1, retired: 1 });
    const after = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`, headers: auth })).payload).cases;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ removed_from_plan: true, latest_verdict: 'PASSED' });
  });

  it('GET /api/v1/plans/:planId/cases surfaces the latest execution notes, not just the verdict', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const beforeRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
    });
    const beforeCase = JSON.parse(beforeRes.payload).cases.find(
      (c: any) => c.test_case_id === seed.caseIds[0]
    );
    expect(beforeCase.latest_notes).toBeNull();

    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${seed.buildId}/results`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        test_plan_case_id: beforeCase.test_plan_case_id,
        verdict: 'FAILED',
        notes: 'Timed out waiting for the auth callback',
      },
    });

    const afterRes = await app.inject({
      method: 'GET',
      url: `/api/v1/plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
    });
    const afterCase = JSON.parse(afterRes.payload).cases.find(
      (c: any) => c.test_case_id === seed.caseIds[0]
    );
    expect(afterCase.latest_verdict).toBe('FAILED');
    expect(afterCase.latest_notes).toBe('Timed out waiting for the auth callback');
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

  describe('Test Plan CRUD (POST /projects/:projectId/plans, PATCH/DELETE /plans/:planId)', () => {
    it('requires PLAN_MANAGE -- a Viewer gets 403 on create/update/delete', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const viewerToken = await createAndLoginViewer(app, adminToken);

      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Should Not Exist' },
      });
      expect(createRes.statusCode).toBe(403);

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/plans/${seed.planId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Renamed' },
      });
      expect(updateRes.statusCode).toBe(403);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${seed.planId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(deleteRes.statusCode).toBe(403);
    });

    it('creates a plan, and it is immediately listed for the project', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Regression Sweep 2', status: 'ACTIVE' },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.payload).plan;
      expect(created.name).toBe('Regression Sweep 2');
      expect(created.project_id).toBe(seed.projectId);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(listRes.payload).plans.some((p: any) => p.id === created.id)).toBe(true);
    });

    it('rejects a create with a missing name, and an update/create with an invalid status', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const noName = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(noName.statusCode).toBe(400);

      const badStatus = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'X', status: 'DRAFT' },
      });
      expect(badStatus.statusCode).toBe(400);
    });

    it('updates a plan\'s name and status', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/plans/${seed.planId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Renamed Plan', status: 'LOCKED' },
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.payload).plan;
      expect(updated.name).toBe('Renamed Plan');
      expect(updated.status).toBe('LOCKED');
    });

    it('404s updating/deleting a plan that does not exist', async () => {
      const { app } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const missing = '/api/v1/plans/00000000-0000-0000-0000-000000000000';
      const updateRes = await app.inject({ method: 'PATCH', url: missing, headers: { authorization: `Bearer ${token}` }, payload: { name: 'Nope' } });
      expect(updateRes.statusCode).toBe(404);
      const deleteRes = await app.inject({ method: 'DELETE', url: missing, headers: { authorization: `Bearer ${token}` } });
      expect(deleteRes.statusCode).toBe(404);
    });

    it('deleting a plan with content returns 409 with counts, then force=true deletes it and everything inside', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // The seeded plan/build already has 10 pinned cases (see seed_core_loop.ts); record one
      // execution too so blockedResultCount is also exercised, not just build/case-link counts.
      await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${seed.buildId}/results/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] },
      });

      const blockedRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${seed.planId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(blockedRes.statusCode).toBe(409);
      const blockedBody = JSON.parse(blockedRes.payload);
      expect(blockedBody.code).toBe('PLAN_IN_USE');
      expect(blockedBody.detail).toContain('Sprint 42 Regression Plan');

      const forcedRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${seed.planId}?force=true`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(forcedRes.statusCode).toBe(204);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(listRes.payload).plans.some((p: any) => p.id === seed.planId)).toBe(false);
    });

    it('an empty plan (no builds/pinned cases) deletes immediately with no force needed', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/plans`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Throwaway Empty Plan' },
      });
      const planId = JSON.parse(createRes.payload).plan.id;

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${planId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleteRes.statusCode).toBe(204);
    });
  });

  describe('Test Run CRUD (POST /plans/:planId/runs, PATCH/DELETE /runs/:runId)', () => {
    it('requires RUN_MANAGE -- a Viewer gets 403 on create/update/delete', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const viewerToken = await createAndLoginViewer(app, adminToken);

      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Should Not Exist' },
      });
      expect(createRes.statusCode).toBe(403);

      const updateRes = await app.inject({
        method: 'PATCH',
        url: `/api/v1/runs/${seed.buildId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { name: 'Renamed' },
      });
      expect(updateRes.statusCode).toBe(403);

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/runs/${seed.buildId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(deleteRes.statusCode).toBe(403);
    });

    it('creates a run, and it is immediately listed for the plan', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'v1.0.1-rc1', status: 'OPEN' },
      });
      expect(res.statusCode).toBe(201);
      const created = JSON.parse(res.payload).run;
      expect(created.name).toBe('v1.0.1-rc1');
      expect(created.test_plan_id).toBe(seed.planId);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(JSON.parse(listRes.payload).runs.some((b: any) => b.id === created.id)).toBe(true);
    });

    it('rejects a create with a missing name, an invalid status, and a duplicate name within the same plan', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const noName = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(noName.statusCode).toBe(400);

      const badStatus = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'X', status: 'IN_PROGRESS' },
      });
      expect(badStatus.statusCode).toBe(400);

      const dupe = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'v1.0.0-rc1' }, // matches the seeded build's name in this same plan
      });
      expect(dupe.statusCode).toBe(409);
    });

    it("updates a run's name and status", async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/runs/${seed.buildId}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Renamed Run', status: 'CLOSED' },
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.payload).run;
      expect(updated.name).toBe('Renamed Run');
      expect(updated.status).toBe('CLOSED');
    });

    it('404s updating/deleting a run that does not exist', async () => {
      const { app } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const missing = '/api/v1/runs/00000000-0000-0000-0000-000000000000';
      const updateRes = await app.inject({ method: 'PATCH', url: missing, headers: { authorization: `Bearer ${token}` }, payload: { name: 'Nope' } });
      expect(updateRes.statusCode).toBe(404);
      const deleteRes = await app.inject({ method: 'DELETE', url: missing, headers: { authorization: `Bearer ${token}` } });
      expect(deleteRes.statusCode).toBe(404);
    });

    it('deleting a run with recorded executions returns 409 with the count, then force=true deletes it', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${seed.buildId}/results/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { results: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] },
      });

      const blockedRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/runs/${seed.buildId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(blockedRes.statusCode).toBe(409);
      const blockedBody = JSON.parse(blockedRes.payload);
      expect(blockedBody.code).toBe('RUN_IN_USE');
      expect(blockedBody.detail).toContain('v1.0.0-rc1');

      const forcedRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/runs/${seed.buildId}?force=true`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(forcedRes.statusCode).toBe(204);
    });

    it('an empty run (no executions) deletes immediately with no force needed', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const createRes = await app.inject({
        method: 'POST',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
        payload: { name: 'Throwaway Empty Run' },
      });
      const runId = JSON.parse(createRes.payload).run.id;

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/runs/${runId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deleteRes.statusCode).toBe(204);
    });

    it('deleting a plan cascades to delete its runs too', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const forcedRes = await app.inject({
        method: 'DELETE',
        url: `/api/v1/plans/${seed.planId}?force=true`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(forcedRes.statusCode).toBe(204);

      const listRes = await app.inject({
        method: 'GET',
        url: `/api/v1/plans/${seed.planId}/runs`,
        headers: { authorization: `Bearer ${token}` },
      });
      // The plan is gone, so listing its runs 404s; and the run rows really are deleted.
      expect(listRes.statusCode).toBe(404);
      expect(await db.selectFrom('test_runs').select('id').where('test_plan_id', '=', seed.planId).execute()).toEqual([]);
    });
  });
});
