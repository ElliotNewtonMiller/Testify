import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CustomFieldRepository, TestSuiteRepository, TestCaseRepository, ProjectRepository, TestPlanRepository } from '@testify/db';

describe('Case search & filter: POST /api/v1/projects/:projectId/case-search', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  async function loginAsAdmin(app: any): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.payload).token as string;
  }

  async function search(app: any, token: string, projectId: string, payload: unknown) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/case-search`,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    return { status: res.statusCode, body: JSON.parse(res.payload) };
  }

  async function externalIdOf(db: any, caseId: string): Promise<string> {
    const row = await db.selectFrom('test_cases').select('external_id').where('id', '=', caseId).executeTakeFirstOrThrow();
    return row.external_id;
  }

  it('requires auth (401) and SPEC_VIEW (403)', async () => {
    const { app, seed } = serverInstance;
    const adminToken = await loginAsAdmin(app);

    const noAuth = await app.inject({ method: 'POST', url: `/api/v1/projects/${seed.projectId}/case-search`, payload: {} });
    expect(noAuth.statusCode).toBe(401);

    const roleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/roles',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `No Spec View ${Date.now()}`, description: null, permission_keys: ['EXPORT_DATA'] },
    });
    const roleName = JSON.parse(roleRes.payload).role.name;
    const username = `nospec_${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: roleName },
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } });
    const res = await search(app, JSON.parse(login.payload).token, seed.projectId, {});
    expect(res.status).toBe(403);
  });

  it('with no q/filters returns every case; q matches external id and title', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);

    const all = await search(app, token, seed.projectId, {});
    expect(all.status).toBe(200);
    expect(all.body.case_ids.sort()).toEqual([...seed.caseIds].sort());
    expect(all.body.total_cases).toBe(seed.caseIds.length);
    expect(all.body.suite_ids).toContain(seed.suiteId);

    const extId = await externalIdOf(db, seed.caseIds[0]);
    const byId = await search(app, token, seed.projectId, { q: extId.toLowerCase() });
    expect(byId.body.case_ids).toContain(seed.caseIds[0]);

    const none = await search(app, token, seed.projectId, { q: 'zzz-no-such-case-zzz' });
    expect(none.body.case_ids).toEqual([]);
    expect(none.body.suite_ids).toEqual([]);
  });

  it('q matches the name of a case\'s suite or any suite above it, and shows matching empty suites', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const suiteRepo = new TestSuiteRepository(db);
    const caseRepo = new TestCaseRepository(db);
    const parent = await suiteRepo.create({ project_id: seed.projectId, name: 'Payments Area' });
    const child = await suiteRepo.create({ project_id: seed.projectId, name: 'Refunds', parent_suite_id: parent.id });
    const emptyChild = await suiteRepo.create({ project_id: seed.projectId, name: 'Disputes', parent_suite_id: parent.id });
    const inChild = await caseRepo.create({ project_id: seed.projectId, test_suite_id: child.id, external_id: 'SHOP-900', title: 'Partial refund' });

    const res = await search(app, token, seed.projectId, { q: 'payments area' });
    expect(res.status).toBe(200);
    expect(res.body.case_ids).toEqual([inChild.id]); // via its parent suite's name
    expect(res.body.suite_ids.sort()).toEqual([parent.id, child.id, emptyChild.id].sort());

    const byChild = await search(app, token, seed.projectId, { q: 'refunds' });
    expect(byChild.body.case_ids).toEqual([inChild.id]);
    expect(byChild.body.suite_ids.sort()).toEqual([parent.id, child.id].sort()); // not the sibling

    // A filter on a case property still applies on top of the suite-name match.
    const filtered = await search(app, token, seed.projectId, { q: 'payments area', filters: [{ field: 'priority', op: 'any_of', value: ['LOW'] }] });
    expect(filtered.body.case_ids).toEqual([]);
  });

  it('filters by built-in fields, in_plan and verdict', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const caseRepo = new TestCaseRepository(db);
    await caseRepo.update(seed.caseIds[0], { priority: 'CRITICAL' });

    const byPriority = await search(app, token, seed.projectId, { filters: [{ field: 'priority', op: 'any_of', value: ['CRITICAL'] }] });
    expect(byPriority.body.case_ids).toEqual([seed.caseIds[0]]);

    // Every seeded case is in the seeded plan.
    const inPlan = await search(app, token, seed.projectId, { plan_id: seed.planId, filters: [{ field: 'in_plan', op: 'is', value: false }] });
    expect(inPlan.status).toBe(200);
    expect(inPlan.body.case_ids).toEqual([]);

    const extA = await externalIdOf(db, seed.caseIds[1]);
    const execRes = await app.inject({
      method: 'POST',
      url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
      headers: { authorization: `Bearer ${token}` },
      payload: { executions: [{ case_identifier: { external_id: extA }, verdict: 'FAILED' }] },
    });
    expect(execRes.statusCode).toBe(201);

    const failed = await search(app, token, seed.projectId, { build_id: seed.buildId, filters: [{ field: 'verdict', op: 'any_of', value: ['FAILED'] }] });
    expect(failed.body.case_ids).toEqual([seed.caseIds[1]]);
    const untested = await search(app, token, seed.projectId, { build_id: seed.buildId, filters: [{ field: 'verdict', op: 'any_of', value: ['UNTESTED'] }] });
    expect(untested.body.case_ids).toHaveLength(seed.caseIds.length - 1);
  });

  it('filters by a case MULTI_SELECT custom field (any_of / all_of)', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const cfRepo = new CustomFieldRepository(db);
    const def = await cfRepo.createDefinition({
      entity_type: 'TestCase',
      name: 'tags',
      field_label: 'Tags',
      field_type: 'MULTI_SELECT',
      options: ['ui', 'api', 'slow'].map((v) => ({ option_label: v, option_value: v })),
    });
    await cfRepo.setValue(def.id, 'TestCase', seed.caseIds[0], ['ui', 'slow']);
    await cfRepo.setValue(def.id, 'TestCase', seed.caseIds[1], ['ui']);

    const anyOf = await search(app, token, seed.projectId, { filters: [{ field: `cf:${def.id}`, op: 'any_of', value: ['slow', 'api'] }] });
    expect(anyOf.body.case_ids).toEqual([seed.caseIds[0]]);
    const allOf = await search(app, token, seed.projectId, { filters: [{ field: `cf:${def.id}`, op: 'all_of', value: ['ui'] }] });
    expect(allOf.body.case_ids.sort()).toEqual([seed.caseIds[0], seed.caseIds[1]].sort());

    const bad = await search(app, token, seed.projectId, { filters: [{ field: `cf:${def.id}`, op: 'any_of', value: ['nope'] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_FILTER');
    expect(bad.body.invalid_params[0].reason).toMatch(/filters\[0\]/);
  });

  it('a suite custom field set on a parent suite applies to cases in child suites; suite_ids include ancestors', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const suiteRepo = new TestSuiteRepository(db);
    const caseRepo = new TestCaseRepository(db);
    const cfRepo = new CustomFieldRepository(db);

    const parent = await suiteRepo.create({ project_id: seed.projectId, name: 'Parent' });
    const child = await suiteRepo.create({ project_id: seed.projectId, parent_suite_id: parent.id, name: 'Child' });
    const deepCase = await caseRepo.create({ project_id: seed.projectId, test_suite_id: child.id, external_id: 'DEEP-1', title: 'Deep case' });

    const def = await cfRepo.createDefinition({
      entity_type: 'TestSuite',
      name: 'area',
      field_label: 'Area',
      field_type: 'SINGLE_SELECT',
      options: ['checkout', 'search'].map((v) => ({ option_label: v, option_value: v })),
    });
    await cfRepo.setValue(def.id, 'TestSuite', parent.id, 'checkout');

    const res = await search(app, token, seed.projectId, { filters: [{ field: `suite_cf:${def.id}`, op: 'any_of', value: ['checkout'] }] });
    expect(res.status).toBe(200);
    expect(res.body.case_ids).toEqual([deepCase.id]);
    expect(res.body.suite_ids.sort()).toEqual([parent.id, child.id].sort());
  });

  it('suite CHECKBOX: an unticked (unset) box matches "No", only the own suite counts, and empty suites still appear', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const suiteRepo = new TestSuiteRepository(db);
    const caseRepo = new TestCaseRepository(db);
    const cfRepo = new CustomFieldRepository(db);

    const parent = await suiteRepo.create({ project_id: seed.projectId, name: 'Ticked parent' });
    const child = await suiteRepo.create({ project_id: seed.projectId, parent_suite_id: parent.id, name: 'Unticked child' });
    const empty = await suiteRepo.create({ project_id: seed.projectId, name: 'Empty unticked' });
    const parentCase = await caseRepo.create({ project_id: seed.projectId, test_suite_id: parent.id, external_id: 'CHK-1', title: 'In parent' });
    const childCase = await caseRepo.create({ project_id: seed.projectId, test_suite_id: child.id, external_id: 'CHK-2', title: 'In child' });

    const def = await cfRepo.createDefinition({ entity_type: 'TestSuite', name: 'flag', field_label: 'Flag', field_type: 'CHECKBOX' });
    await cfRepo.setValue(def.id, 'TestSuite', parent.id, true);

    const yes = await search(app, token, seed.projectId, { filters: [{ field: `suite_cf:${def.id}`, op: 'is', value: true }] });
    expect(yes.body.case_ids).toEqual([parentCase.id]);
    expect(yes.body.suite_ids).toEqual([parent.id]);

    const no = await search(app, token, seed.projectId, { filters: [{ field: `suite_cf:${def.id}`, op: 'is', value: false }] });
    expect(no.body.case_ids).toContain(childCase.id);
    expect(no.body.case_ids).not.toContain(parentCase.id);
    // The child's ancestor stays so the tree is navigable; the empty suite appears on its own.
    expect(no.body.suite_ids).toEqual(expect.arrayContaining([child.id, parent.id, empty.id]));

    const catalog = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/case-search/fields`,
      headers: { authorization: `Bearer ${token}` },
    });
    const field = JSON.parse(catalog.payload).fields.find((f: any) => f.key === `suite_cf:${def.id}`);
    expect(field.label).toBe('Flag');
    expect(field.source).toBe('suite_custom_field');
  });

  it('rejects in_plan without plan_id, verdict without build_id, unknown fields, and cross-project plan/build ids', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);

    expect((await search(app, token, seed.projectId, { filters: [{ field: 'in_plan', op: 'is', value: true }] })).status).toBe(400);
    expect((await search(app, token, seed.projectId, { filters: [{ field: 'verdict', op: 'any_of', value: ['PASSED'] }] })).status).toBe(400);
    expect((await search(app, token, seed.projectId, { filters: [{ field: 'nope', op: 'is', value: true }] })).status).toBe(400);

    const other = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTH' });
    expect((await search(app, token, other.id, { plan_id: seed.planId })).status).toBe(404);
    expect((await search(app, token, other.id, { build_id: seed.buildId })).status).toBe(404);

    const otherPlan = await new TestPlanRepository(db).create({ project_id: seed.projectId, name: 'Second plan' });
    expect((await search(app, token, seed.projectId, { plan_id: otherPlan.id, build_id: seed.buildId })).status).toBe(404);
  });

  it('GET .../case-search/fields lists built-ins and visible custom fields', async () => {
    const { app, seed, db } = serverInstance;
    const token = await loginAsAdmin(app);
    const def = await new CustomFieldRepository(db).createDefinition({
      entity_type: 'TestCase',
      name: 'score',
      field_label: 'Score',
      field_type: 'NUMBER',
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${seed.projectId}/case-search/fields`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const keys = JSON.parse(res.payload).fields.map((f: any) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['priority', 'execution_type', 'version_status', 'in_plan', 'verdict', `cf:${def.id}`]));
  });
});
