import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CustomFieldRepository } from '@testify/db';

describe('Custom Fields: admin definition CRUD & Spec-mode value CRUD', () => {
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

  async function createAndLoginViewer(app: any, adminToken: string): Promise<{ token: string; userId: string }> {
    const username = `viewer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { username, email: `${username}@testify.local`, password: 'SecurePass123!', global_role: 'Viewer' },
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

  it('every admin custom-fields route requires CUSTOM_FIELD_MANAGE -- a Viewer gets 403 on all of them', async () => {
    const { app } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginViewer(app, adminToken);

    const attempts = [
      { method: 'GET', url: '/api/v1/admin/custom-fields' },
      { method: 'POST', url: '/api/v1/admin/custom-fields', payload: { entity_type: 'TestCase', name: 'x', field_label: 'X', field_type: 'TEXT' } },
      { method: 'PUT', url: '/api/v1/admin/custom-fields/nonexistent', payload: { field_label: 'X' } },
      { method: 'DELETE', url: '/api/v1/admin/custom-fields/nonexistent' },
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

  it('POST/PUT/DELETE definition CRUD happy path', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'story_points', field_label: 'Story Points', field_type: 'NUMBER' },
    });
    expect(createRes.statusCode).toBe(201);
    const definition = JSON.parse(createRes.payload).definition;
    expect(definition.field_type).toBe('NUMBER');

    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { field_label: 'Story Points (Fibonacci)' },
    });
    expect(updateRes.statusCode).toBe(200);
    expect(JSON.parse(updateRes.payload).definition.field_label).toBe('Story Points (Fibonacci)');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/custom-fields?entity_type=TestCase',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.payload).definitions.map((d: any) => d.id)).toContain(definition.id);

    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleteRes.statusCode).toBe(204);
  });

  it('POST rejects an unknown field_type (400) and a duplicate name (409)', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const badType = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'x', field_label: 'X', field_type: 'WEIRD' },
    });
    expect(badType.statusCode).toBe(400);

    await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner', field_label: 'Owner', field_type: 'TEXT' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner', field_label: 'Owner Again', field_type: 'TEXT' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('DELETE with recorded values returns 409 with a count and leaves data untouched, then force=true actually deletes it', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes CF', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;
    const caseId = seed.caseIds[0];

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-cases/${caseId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'hello' },
    });
    expect(setRes.statusCode).toBe(200);

    const blockedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedDelete.statusCode).toBe(409);
    expect(JSON.parse(blockedDelete.payload).blockedByValueCount ?? JSON.parse(blockedDelete.payload).invalid_params).toBeTruthy();

    // Still there.
    const getValuesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${caseId}/custom-field-values`,
      headers: { authorization: `Bearer ${token}` },
    });
    const values = JSON.parse(getValuesRes.payload).values;
    expect(values.find((v: any) => v.definition.id === definition.id).value).toBe('hello');

    const forcedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/custom-fields/${definition.id}?force=true`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(forcedDelete.statusCode).toBe(204);
  });

  it('value routes require PLAN_MANAGE for PUT/DELETE, but GET is open to any authenticated user', async () => {
    const { app, seed } = serverInstance;
    const { token: adminToken } = await loginAsAdmin(app);
    const { token: viewerToken } = await createAndLoginViewer(app, adminToken);
    const caseId = seed.caseIds[0];

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes CF', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const getAsViewer = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${caseId}/custom-field-values`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(getAsViewer.statusCode).toBe(200);

    const putAsViewer = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-cases/${caseId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { value: 'nope' },
    });
    expect(putAsViewer.statusCode).toBe(403);

    const deleteAsViewer = await app.inject({
      method: 'DELETE',
      url: `/api/v1/test-cases/${caseId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${viewerToken}` },
    });
    expect(deleteAsViewer.statusCode).toBe(403);
  });

  it('PUT with an invalid value returns 422', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'points', field_label: 'Points', field_type: 'NUMBER' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-cases/${caseId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'not-a-number' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('editing a custom field value on a case whose latest version is APPROVED (locked) still succeeds', async () => {
    const { app, seed, db } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const caseId = seed.caseIds[0];

    const versionRow = await db
      .selectFrom('test_case_versions')
      .selectAll()
      .where('test_case_id', '=', caseId)
      .executeTakeFirstOrThrow();
    expect(versionRow.status).toBe('APPROVED');

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestCase', name: 'owner_cf', field_label: 'Owner', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-cases/${caseId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'Platform Team' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).value).toBe('Platform Team');
  });

  it('value routes work identically for test suites', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const suiteId = seed.suiteId;

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: { authorization: `Bearer ${token}` },
      payload: { entity_type: 'TestSuite', name: 'owner_team', field_label: 'Owner Team', field_type: 'TEXT' },
    });
    const definition = JSON.parse(createRes.payload).definition;

    const setRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/test-suites/${suiteId}/custom-field-values/${definition.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { value: 'Platform Team' },
    });
    expect(setRes.statusCode).toBe(200);

    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/test-suites/${suiteId}/custom-field-values`,
      headers: { authorization: `Bearer ${token}` },
    });
    const values = JSON.parse(getRes.payload).values;
    expect(values.find((v: any) => v.definition.id === definition.id).value).toBe('Platform Team');
  });

  it('a project-scoped definition (e.g. one created by the import wizard) never leaks into the Admin Panel\'s global-only listing', async () => {
    const { app, db, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);

    await new CustomFieldRepository(db).createDefinition({
      project_id: seed.projectId,
      entity_type: 'TestCase',
      name: 'imported_only_field',
      field_label: 'Imported Only',
      field_type: 'TEXT',
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/custom-fields?entity_type=TestCase',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const names = JSON.parse(listRes.payload).definitions.map((d: any) => d.name);
    expect(names).not.toContain('imported_only_field');
  });
  it('refuses to CREATE a required field without a usable default value, but never blocks an UPDATE', async () => {
    const { app } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const noDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'sev', field_label: 'Severity', field_type: 'TEXT', is_required: true },
    });
    expect(noDefault.statusCode).toBe(422);
    expect(JSON.parse(noDefault.payload).error).toContain('Creating a required custom field');

    const badNumberDefault = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'n', field_label: 'N', field_type: 'NUMBER', is_required: true, default_value: 'abc' },
    });
    expect(badNumberDefault.statusCode).toBe(422);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'sev', field_label: 'Severity', field_type: 'TEXT', is_required: true, default_value: 'Medium' },
    });
    expect(ok.statusCode).toBe(201);
    const requiredId = JSON.parse(ok.payload).definition.id;

    const optional = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'opt', field_label: 'Optional', field_type: 'TEXT' },
    });
    expect(optional.statusCode).toBe(201);
    const optionalId = JSON.parse(optional.payload).definition.id;

    // Unlike creation, an UPDATE never blocks on the required/default combination: making an
    // existing optional field required with no default succeeds, and so does clearing an
    // already-required field's default afterward -- the create-time-only check exists purely
    // to stop a *brand-new* required field from instantly leaving every existing record with
    // an empty value; an update can't cause that kind of gap.
    const makeRequired = await app.inject({ method: 'PUT', url: `/api/v1/admin/custom-fields/${optionalId}`, headers: auth, payload: { is_required: true } });
    expect(makeRequired.statusCode).toBe(200);
    const clearDefault = await app.inject({ method: 'PUT', url: `/api/v1/admin/custom-fields/${requiredId}`, headers: auth, payload: { default_value: null } });
    expect(clearDefault.statusCode).toBe(200);
  });

  it('creating a field with a default seeds a real value for every pre-existing case, frozen against later default edits', async () => {
    const { app, seed } = serverInstance;
    const { token } = await loginAsAdmin(app);
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/custom-fields',
      headers: auth,
      payload: { entity_type: 'TestCase', name: 'severity', field_label: 'Severity', field_type: 'TEXT', is_required: true, default_value: 'Medium' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.payload);
    expect(created.seeded_count).toBe(seed.caseIds.length);

    const caseId = seed.caseIds[0];
    const valuesRes = await app.inject({
      method: 'GET',
      url: `/api/v1/test-cases/${caseId}/custom-field-values`,
      headers: auth,
    });
    const values = JSON.parse(valuesRes.payload).values;
    expect(values.find((v: any) => v.definition.id === created.definition.id).value).toBe('Medium');

    // Editing the field's default afterward must not retroactively change the case's already-
    // frozen value -- the whole point of seeding real rows at creation time.
    const updateRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/custom-fields/${created.definition.id}`,
      headers: auth,
      payload: { default_value: 'High' },
    });
    expect(updateRes.statusCode).toBe(200);

    const valuesAfter = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/test-cases/${caseId}/custom-field-values`,
          headers: auth,
        })
      ).payload,
    ).values;
    expect(valuesAfter.find((v: any) => v.definition.id === created.definition.id).value).toBe('Medium');

    // A brand-new case created AFTER the field exists has no pre-existing value to protect --
    // it still picks up whatever the default is right now (the existing read-time fallback).
    const newCaseRes = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${seed.projectId}/test-cases`,
      headers: auth,
      payload: { test_suite_id: seed.suiteId, title: 'New case after field exists' },
    });
    const newCaseId = JSON.parse(newCaseRes.payload).test_case.id;
    const newCaseValues = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/test-cases/${newCaseId}/custom-field-values`,
          headers: auth,
        })
      ).payload,
    ).values;
    expect(newCaseValues.find((v: any) => v.definition.id === created.definition.id).value).toBe('High');
  });
});
