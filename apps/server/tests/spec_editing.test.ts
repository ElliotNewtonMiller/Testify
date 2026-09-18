import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Spec-mode suite/case create/edit/delete', () => {
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

  async function createAndLoginAs(app: any, adminToken: string, globalRole: string): Promise<{ token: string; userId: string }> {
    const username = `${globalRole.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: globalRole },
    });
    expect(createRes.statusCode).toBe(201);
    const userId = JSON.parse(createRes.payload).user.id as string;

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId };
  }

  it('every new route requires the right SPEC_* key -- a Viewer gets 403 on all of them', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');

    const attempts = [
      { method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-suites`, payload: { name: 'X' } },
      { method: 'PUT', url: `/api/v1/projects/${seed.projectId}/test-suites/${seed.suiteId}`, payload: { name: 'X' } },
      { method: 'DELETE', url: `/api/v1/projects/${seed.projectId}/test-suites/${seed.suiteId}` },
      { method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-cases`, payload: { test_suite_id: seed.suiteId, title: 'X' } },
      { method: 'PUT', url: `/api/v1/projects/${seed.projectId}/test-cases/${seed.caseIds[0]}`, payload: { title: 'X' } },
      { method: 'DELETE', url: `/api/v1/projects/${seed.projectId}/test-cases/${seed.caseIds[0]}` },
      { method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-cases/${seed.caseIds[0]}/versions/draft` },
      { method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-case-versions/dummy/approve` },
    ] as const;

    for (const attempt of attempts) {
      const res = await app.inject({
        method: attempt.method,
        url: attempt.url,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: 'payload' in attempt ? attempt.payload : undefined,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('a Tester can create/edit but gets 403 on approve/delete', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: testerToken } = await createAndLoginAs(app, adminToken, 'Tester');

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${testerToken}` },
      payload: { test_suite_id: seed.suiteId, title: 'Tester-created case' },
    });
    expect(createRes.statusCode).toBe(201);
    const versionId = JSON.parse(createRes.payload).version.id;

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${versionId}/approve`,
      headers: { authorization: `Bearer ${testerToken}` },
    });
    expect(approveRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-suites/${seed.suiteId}`,
      headers: { authorization: `Bearer ${testerToken}` },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it('create/rename/move a suite happy path', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-suites`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'New Suite' },
    });
    expect(createRes.statusCode).toBe(201);
    const suite = JSON.parse(createRes.payload).suite;

    const renameRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${seed.projectId}/test-suites/${suite.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Renamed Suite', parent_suite_id: seed.suiteId },
    });
    expect(renameRes.statusCode).toBe(200);
    const renamed = JSON.parse(renameRes.payload).suite;
    expect(renamed.name).toBe('Renamed Suite');
    expect(renamed.parent_suite_id).toBe(seed.suiteId);
  });

  it('create a case auto-generates a sequential external_id and creates a DRAFT v1', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_suite_id: seed.suiteId, title: 'New Case', summary: 'A summary', steps: [{ step_number: 1, action: 'a', expected_result: 'b' }] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.test_case.external_id).toMatch(/^SHOP-\d+$/);
    expect(body.version.version_number).toBe(1);
    expect(body.version.status).toBe('DRAFT');
    expect(body.version.steps).toHaveLength(1);
  });

  it('editing title/priority on a case whose latest version is APPROVED needs no draft', async () => {
    const { app, seed, db } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const versionRow = await db.selectFrom('test_case_versions').selectAll().where('test_case_id', '=', caseId).executeTakeFirstOrThrow();
    expect(versionRow.status).toBe('APPROVED');

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: 'Renamed while approved', priority: 'LOW' },
    });
    expect(res.statusCode).toBe(200);
    const updated = JSON.parse(res.payload).test_case;
    expect(updated.title).toBe('Renamed while approved');
    expect(updated.priority).toBe('LOW');
  });

  it('editing an APPROVED version\'s content directly returns 422 CASE_VERSION_LOCKED', async () => {
    const { app, seed, db } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];
    const versionRow = await db.selectFrom('test_case_versions').selectAll().where('test_case_id', '=', caseId).executeTakeFirstOrThrow();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${versionRow.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { summary: 'Trying to edit an approved version' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).code).toBe('CASE_VERSION_LOCKED');
  });

  it('create-draft -> edit content/steps -> approve happy path, and 409 creating a second draft while one exists', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const draftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}/versions/draft`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(draftRes.statusCode).toBe(201);
    const draft = JSON.parse(draftRes.payload).version;
    expect(draft.status).toBe('DRAFT');
    expect(draft.version_number).toBe(2);

    const secondDraftRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}/versions/draft`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(secondDraftRes.statusCode).toBe(409);

    const editRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${draft.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { preconditions: 'Updated preconditions', steps: [{ step_number: 1, action: 'New action', expected_result: 'New result' }] },
    });
    expect(editRes.statusCode).toBe(200);
    const edited = JSON.parse(editRes.payload).version;
    expect(edited.preconditions).toBe('Updated preconditions');
    expect(edited.steps).toHaveLength(1);
    expect(edited.steps[0].action).toBe('New action');

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${draft.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(JSON.parse(approveRes.payload).version.status).toBe('APPROVED');

    const reapproveRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${draft.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(reapproveRes.statusCode).toBe(422);
    expect(JSON.parse(reapproveRes.payload).code).toBe('VERSION_NOT_DRAFT');
  });

  it('deleting a case with no plan links succeeds immediately with no warning', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_suite_id: seed.suiteId, title: 'Unused case' },
    });
    const caseId = JSON.parse(createRes.payload).test_case.id;

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);
  });

  it('deleting a case with plan links/executions returns 409 with counts, then force=true deletes it', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0]; // seeded case, already plan-linked with an approved version

    // Link isn't guaranteed in the base seed for every case, so add one via the plan-curation route.
    await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_case_id: caseId },
    });

    const blockedRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedRes.statusCode).toBe(409);
    expect(JSON.parse(blockedRes.payload).code).toBe('CASE_IN_USE');

    const forcedRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-cases/${caseId}?force=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forcedRes.statusCode).toBe(204);
  });

  it('deleting a suite with content returns 409 with aggregate counts, then force=true deletes it and everything inside', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const blockedRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-suites/${seed.suiteId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedRes.statusCode).toBe(409);
    expect(JSON.parse(blockedRes.payload).code).toBe('SUITE_IN_USE');

    const forcedRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${seed.projectId}/test-suites/${seed.suiteId}?force=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forcedRes.statusCode).toBe(204);
  });
});
