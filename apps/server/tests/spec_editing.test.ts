import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CustomFieldRepository, TestPlanRepository, ProjectRepository } from '@testify/db';

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

  it('create a case auto-generates a sequential external_id and creates an APPROVED v1 for a SPEC_AUTO_APPROVE holder (Admin, by default)', async () => {
    const { app, seed } = serverInstance;
    const { token, userId } = await loginAsAdmin(app);

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
    expect(body.version.status).toBe('APPROVED');
    expect(body.version.reviewer_id).toBe(userId);
    expect(body.version.steps).toHaveLength(1);
  });

  it('create a case creates a DRAFT v1 for a role without SPEC_AUTO_APPROVE (Tester, by default)', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token } = await createAndLoginAs(app, adminToken, 'Tester');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_suite_id: seed.suiteId, title: 'Tester Case' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.version.status).toBe('DRAFT');
    expect(body.version.reviewer_id).toBeNull();
  });

  it('a required TestCase custom field with no default blocks SPEC_AUTO_APPROVE until a value is set', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    // The admin API now refuses to create a required field without a default, so build this
    // (legacy/defense-in-depth) state directly through the repository.
    const definition = await new CustomFieldRepository(serverInstance.db).createDefinition({
      entity_type: 'TestCase',
      name: 'severity',
      field_label: 'Severity',
      field_type: 'TEXT',
      is_required: true,
    });
    const definitionId = definition.id;

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_suite_id: seed.suiteId, title: 'Case missing a required field' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    // Admin holds SPEC_AUTO_APPROVE by default, but the required "Severity" field has no
    // value yet and no default_value -- auto-approve must not fire past that.
    expect(created.version.status).toBe('DRAFT');

    const approveAttempt = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${created.version.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approveAttempt.statusCode).toBe(422);
    const approveBody = JSON.parse(approveAttempt.payload);
    expect(approveBody.code).toBe('REQUIRED_CUSTOM_FIELDS_MISSING');
    expect(approveBody.detail).toContain('Severity');

    const setValueRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-cases/${created.test_case.id}/custom-field-values/${definitionId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'HIGH' },
    });
    expect(setValueRes.statusCode).toBe(200);

    const approveAfterValue = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-case-versions/${created.version.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(approveAfterValue.statusCode).toBe(200);
    expect(JSON.parse(approveAfterValue.payload).version.status).toBe('APPROVED');
  });

  it('a required TestCase custom field WITH a default_value does not block SPEC_AUTO_APPROVE or approve', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const fieldRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        entity_type: 'TestCase',
        name: 'owner_team',
        field_label: 'Owner Team',
        field_type: 'TEXT',
        is_required: true,
        default_value: 'QA',
      },
    });
    expect(fieldRes.statusCode).toBe(201);

    const createRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: { authorization: `Bearer ${token}` },
      payload: { test_suite_id: seed.suiteId, title: 'Case with a defaulted required field' },
    });
    expect(createRes.statusCode).toBe(201);
    // A default_value counts as satisfying the requirement, even with no value row yet.
    expect(JSON.parse(createRes.payload).version.status).toBe('APPROVED');
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

  it('approving a draft re-pins ACTIVE plans to it (Execute mode shows the last approved version); LOCKED plans keep theirs', async () => {
    const { app, seed, db } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const h = { authorization: `Bearer ${token}` };
    const P = seed.projectId;

    // Admin holds SPEC_AUTO_APPROVE, so v1 is created APPROVED.
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${P}/test-cases`,
      headers: h,
      payload: { test_suite_id: seed.suiteId, title: 'Repin', summary: 'v1 summary', steps: [{ step_number: 1, action: 'v1 action', expected_result: 'ok' }] },
    });
    expect(created.statusCode).toBe(201);
    const caseId = JSON.parse(created.payload).test_case.id;

    const planRepo = new TestPlanRepository(db);
    const lockedPlan = await planRepo.create({ project_id: P, name: 'Frozen plan' });
    for (const planId of [seed.planId, lockedPlan.id]) {
      const add = await app.inject({ method: 'POST', url: `/api/v1/test-plans/${planId}/cases`, headers: h, payload: { test_case_id: caseId } });
      expect(add.statusCode).toBe(201);
    }
    await planRepo.update(lockedPlan.id, { status: 'LOCKED' });

    const execView = async (planId: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/v1/test-plans/${planId}/cases`, headers: h });
      return JSON.parse(res.payload).cases.find((c: any) => c.case_id === caseId);
    };

    const draft = await app.inject({ method: 'POST', url: `/api/v1/projects/${P}/test-cases/${caseId}/versions/draft`, headers: h, payload: {} });
    const draftId = JSON.parse(draft.payload).version.id;
    await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${P}/test-case-versions/${draftId}`,
      headers: h,
      payload: { summary: 'v2 summary', steps: [{ step_number: 1, action: 'v2 action', expected_result: 'ok' }] },
    });

    // While v2 is a draft, Execute mode still shows approved v1.
    const during = await execView(seed.planId);
    expect(during.version_number).toBe(1);
    expect(during.summary).toBe('v1 summary');

    const approve = await app.inject({ method: 'POST', url: `/api/v1/projects/${P}/test-case-versions/${draftId}/approve`, headers: h });
    expect(approve.statusCode).toBe(200);
    expect(JSON.parse(approve.payload).repinned_plan_count).toBe(1);

    const after = await execView(seed.planId);
    expect(after.version_number).toBe(2);
    expect(after.summary).toBe('v2 summary');
    expect(after.steps.map((s: any) => s.action)).toEqual(['v2 action']);

    const frozen = await execView(lockedPlan.id);
    expect(frozen.version_number).toBe(1);
  });

  describe('deprecate / restore', () => {
    async function setup() {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const h = { authorization: `Bearer ${token}` };
      const P = seed.projectId;
      const created = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${P}/test-cases`,
        headers: h,
        payload: { test_suite_id: seed.suiteId, title: 'Lifecycle', steps: [{ step_number: 1, action: 'a', expected_result: 'b' }] },
      });
      const body = JSON.parse(created.payload);
      return { app, seed, token, h, P, caseId: body.test_case.id as string, v1Id: body.version.id as string };
    }
    const post = (app: any, h: any, url: string) => app.inject({ method: 'POST', url, headers: h, payload: {} });

    it('round-trips APPROVED -> DEPRECATED -> APPROVED, blocks editing while deprecated, and hides it from spec-tree by default', async () => {
      const { app, h, P, caseId, v1Id, seed } = await setup();

      const dep = await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/deprecate`);
      expect(dep.statusCode).toBe(200);
      expect(JSON.parse(dep.payload).version.status).toBe('DEPRECATED');

      const draft = await post(app, h, `/api/v1/projects/${P}/test-cases/${caseId}/versions/draft`);
      expect(draft.statusCode).toBe(409);

      const treeDefault = JSON.parse((await app.inject({ method: 'GET', url: `/api/v1/projects/${P}/spec-tree`, headers: h })).payload);
      expect(treeDefault.cases.map((c: any) => c.id)).not.toContain(caseId);
      const treeAll = JSON.parse(
        (await app.inject({ method: 'GET', url: `/api/v1/projects/${P}/spec-tree?include_deprecated=true`, headers: h })).payload
      );
      expect(treeAll.cases.map((c: any) => c.id)).toContain(caseId);
      const countOf = (tree: any) => tree.suites.find((s: any) => s.id === seed.suiteId).total_case_count;
      expect(countOf(treeAll)).toBe(countOf(treeDefault) + 1);

      // Not restorable twice / not deprecatable twice.
      expect((await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/deprecate`)).statusCode).toBe(422);
      const restore = await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/restore`);
      expect(restore.statusCode).toBe(200);
      expect(JSON.parse(restore.payload).version.status).toBe('APPROVED');
      expect((await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/restore`)).statusCode).toBe(422);
    });

    it('rejects deprecating a draft or a non-latest version, and requires SPEC_APPROVE', async () => {
      const { app, h, P, caseId, v1Id, token } = await setup();

      const draft = await post(app, h, `/api/v1/projects/${P}/test-cases/${caseId}/versions/draft`);
      const v2Id = JSON.parse(draft.payload).version.id;
      const depDraft = await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v2Id}/deprecate`);
      expect(depDraft.statusCode).toBe(422);
      expect(JSON.parse(depDraft.payload).code).toBe('VERSION_NOT_APPROVED');
      const depOld = await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/deprecate`);
      expect(depOld.statusCode).toBe(422);
      expect(JSON.parse(depOld.payload).code).toBe('VERSION_NOT_LATEST');

      const tester = await createAndLoginAs(app, token, 'Tester');
      const forbidden = await post(app, { authorization: `Bearer ${tester.token}` }, `/api/v1/projects/${P}/test-case-versions/${v1Id}/deprecate`);
      expect(forbidden.statusCode).toBe(403);
    });

    it('a deprecated case cannot be linked to a plan, even when draft linking is allowed', async () => {
      const { app, h, P, caseId, v1Id, seed } = await setup();
      await new ProjectRepository(serverInstance.db).update(P, { settings: JSON.stringify({ allow_draft_plan_linking: true }) });
      await post(app, h, `/api/v1/projects/${P}/test-case-versions/${v1Id}/deprecate`);
      const add = await app.inject({ method: 'POST', url: `/api/v1/test-plans/${seed.planId}/cases`, headers: h, payload: { test_case_id: caseId } });
      expect(add.statusCode).toBe(422);
    });
  });

  describe('POST .../spec-move (drag-and-drop moves)', () => {
    async function setup() {
      const { app, seed, db } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const h = { authorization: `Bearer ${token}` };
      const P = seed.projectId;
      const mkSuite = async (name: string, parent: string | null = null) =>
        JSON.parse(
          (await app.inject({ method: 'POST', url: `/api/v1/projects/${P}/test-suites`, headers: h, payload: { name, parent_suite_id: parent } })).payload
        ).suite;
      const move = (payload: unknown, headers = h) =>
        app.inject({ method: 'POST', url: `/api/v1/projects/${P}/spec-move`, headers, payload });
      const suiteOf = async (caseId: string) =>
        (await db.selectFrom('test_cases').select('test_suite_id').where('id', '=', caseId).executeTakeFirstOrThrow()).test_suite_id;
      const suiteRow = async (id: string) => db.selectFrom('test_suites').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      return { app, seed, db, token, h, P, mkSuite, move, suiteOf, suiteRow };
    }

    it('moves several cases into another suite in one call', async () => {
      const { seed, mkSuite, move, suiteOf } = await setup();
      const dest = await mkSuite('Destination');
      const res = await move({ case_ids: seed.caseIds.slice(0, 3), target_suite_id: dest.id });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({ moved_suite_count: 0, moved_case_count: 3 });
      for (const id of seed.caseIds.slice(0, 3)) expect(await suiteOf(id)).toBe(dest.id);
      expect(await suiteOf(seed.caseIds[3])).toBe(seed.suiteId);
    });

    it('moves a suite (with its child) under a new parent and to the top level; nested selections travel with their ancestor', async () => {
      const { mkSuite, move, suiteRow } = await setup();
      const parent = await mkSuite('Parent');
      const child = await mkSuite('Child', parent.id);
      const dest = await mkSuite('Dest');

      // Selecting both parent and child moves only the parent; the child comes along.
      const res = await move({ suite_ids: [parent.id, child.id], target_suite_id: dest.id });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).moved_suite_count).toBe(1);
      const movedParent = await suiteRow(parent.id);
      const movedChild = await suiteRow(child.id);
      expect(movedParent.parent_suite_id).toBe(dest.id);
      expect(movedChild.parent_suite_id).toBe(parent.id);
      expect(movedChild.path.startsWith(`${movedParent.path}/`)).toBe(true);

      const top = await move({ suite_ids: [parent.id], target_suite_id: null });
      expect(top.statusCode).toBe(200);
      expect((await suiteRow(parent.id)).parent_suite_id).toBeNull();
    });

    it('rejects cycles, cases to the top level, cross-project targets, unknown ids (moving nothing), and a Viewer', async () => {
      const { app, seed, h, mkSuite, move, suiteOf, token } = await setup();
      const parent = await mkSuite('P');
      const child = await mkSuite('C', parent.id);

      expect((await move({ suite_ids: [parent.id], target_suite_id: child.id })).statusCode).toBe(400);
      expect((await move({ case_ids: [seed.caseIds[0]], target_suite_id: null })).statusCode).toBe(400);
      expect((await move({ case_ids: [seed.caseIds[0]], target_suite_id: 'no-such-suite' })).statusCode).toBe(400);

      const unknown = await move({ case_ids: [seed.caseIds[0], 'no-such-case'], target_suite_id: parent.id });
      expect(unknown.statusCode).toBe(404);
      expect(await suiteOf(seed.caseIds[0])).toBe(seed.suiteId);

      const viewer = await createAndLoginAs(app, token, 'Viewer');
      const denied = await move({ case_ids: [seed.caseIds[0]], target_suite_id: parent.id }, { authorization: `Bearer ${viewer.token}` });
      expect(denied.statusCode).toBe(403);
      void h;
    });
  });

  it('checks steps when a case is created or a draft is saved: numbers by position, 400 for bad input, nothing half-saved', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const headers = { authorization: `Bearer ${token}` };
    const body = (res: any) => JSON.parse(res.payload);
    const create = (steps: unknown) =>
      app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-cases`, headers, payload: { test_suite_id: seed.suiteId, title: 'Steps check', steps } });
    const caseCount = async () => Number((await db.selectFrom('test_cases').select(db.fn.countAll().as('n')).executeTakeFirst()).n);

    // Steps without numbers (this used to be a 500) are numbered by position; a missing text is empty.
    const ok = await create([{ action: 'Open the page', expected_result: 'It loads' }, { action: 'Click Save' }]);
    expect(ok.statusCode).toBe(201);
    expect(body(ok).version.steps.map((s: any) => [s.step_number, s.action, s.expected_result])).toEqual([
      [1, 'Open the page', 'It loads'],
      [2, 'Click Save', ''],
    ]);

    const before = await caseCount();
    const cases: Array<[unknown, string]> = [
      ['three steps', 'steps'],
      [['not an object'], 'steps[0]'],
      [[{ action: 5, expected_result: 'x' }], 'steps[0].action'],
      [[{ step_number: 0, action: 'a', expected_result: 'b' }], 'steps[0].step_number'],
      [[{ step_number: 1.5, action: 'a', expected_result: 'b' }], 'steps[0].step_number'],
      [[{ action: 'a' }, { step_number: 1, action: 'b' }], 'steps[1].step_number'],
      [[{ action: 'a', execution_type: 'ROBOT' }], 'steps[0].execution_type'],
    ];
    for (const [steps, field] of cases) {
      const res = await create(steps);
      expect(res.statusCode, field).toBe(400);
      expect(body(res).code).toBe('INVALID_STEPS');
      expect(body(res).invalid_params[0].name).toBe(field);
    }
    expect(await caseCount()).toBe(before);

    // Saving a draft: the same check, and the existing steps stay as they were.
    const draft = body(
      await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/test-cases/${seed.caseIds[0]}/versions/draft`, headers })
    ).version;
    const stepsBefore = draft.steps.map((s: any) => s.action);
    const put = (steps: unknown) =>
      app.inject({ method: 'PUT', url: `/api/v1/projects/${seed.projectId}/test-case-versions/${draft.id}`, headers, payload: { summary: 'changed', steps } });
    const bad = await put([{ step_number: 2, action: 'a' }, { step_number: 2, action: 'b' }]);
    expect(bad.statusCode).toBe(400);
    expect(body(bad).invalid_params[0].reason).toBe('2 is already used by steps[0]');
    const after = body(await app.inject({ method: 'GET', url: `/api/v1/test-cases/${seed.caseIds[0]}/latest-version`, headers }));
    expect(after.version.steps.map((s: any) => s.action)).toEqual(stepsBefore);
    expect(after.version.summary).toBe(draft.summary); // refused as a whole

    const good = await put([{ action: 'Only step' }]);
    expect(good.statusCode).toBe(200);
    expect(body(good).version.steps.map((s: any) => [s.step_number, s.action])).toEqual([[1, 'Only step']]);
  });

  it('refuses blank or over-long suite names and case titles, on create and edit, and trims them', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const headers = { authorization: `Bearer ${token}` };
    const body = (res: any) => JSON.parse(res.payload);
    const send = (method: string, url: string, payload: unknown) => app.inject({ method, url, headers, payload });
    const base = `/api/v1/projects/${seed.projectId}`;
    const tooLong = 'x'.repeat(256);

    for (const name of ['', '   ', 42, tooLong]) {
      const suite = await send('POST', `${base}/test-suites`, { name });
      expect(suite.statusCode).toBe(400);
      expect(body(suite).code).toBe('INVALID_NAME');
      const testCase = await send('POST', `${base}/test-cases`, { test_suite_id: seed.suiteId, title: name });
      expect(testCase.statusCode).toBe(400);
      expect(body(testCase).code).toBe('INVALID_NAME');
      expect((await send('PUT', `${base}/test-suites/${seed.suiteId}`, { name })).statusCode).toBe(400);
      expect((await send('PUT', `${base}/test-cases/${seed.caseIds[0]}`, { title: name })).statusCode).toBe(400);
    }
    expect(body(await send('PUT', `${base}/test-cases/${seed.caseIds[0]}`, { title: '' })).detail).toBe("title can't be blank");
    expect(body(await send('POST', `${base}/test-suites`, { name: tooLong })).detail).toBe('name can be at most 255 characters');

    // Nothing was changed by the refusals; valid names are trimmed; other fields still edit alone.
    const renamed = await send('PUT', `${base}/test-cases/${seed.caseIds[0]}`, { title: '  Trimmed title  ' });
    expect(body(renamed).test_case.title).toBe('Trimmed title');
    expect((await send('PUT', `${base}/test-cases/${seed.caseIds[0]}`, { priority: 'LOW' })).statusCode).toBe(200);
    const suite = await send('POST', `${base}/test-suites`, { name: ` ${'y'.repeat(255)} ` });
    expect(suite.statusCode).toBe(201);
    expect(body(suite).suite.name).toHaveLength(255);
  });
});
