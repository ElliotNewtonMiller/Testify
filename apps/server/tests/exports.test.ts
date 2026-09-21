import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { CustomFieldRepository, ProjectRepository } from '@testify/db';

describe('Data export: definitions and execution results', () => {
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
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'SecurePass123!' },
    });
    expect(loginRes.statusCode).toBe(200);
    return { token: JSON.parse(loginRes.payload).token as string, userId: JSON.parse(createRes.payload).user.id };
  }

  describe('permission gating', () => {
    it('a Viewer (holds EXPORT_DATA) can export; an Automation Service account (lacks it) gets 403; no token gets 401', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');
      const { token: automationToken } = await createAndLoginAs(app, adminToken, 'Automation Service');

      const noAuthRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });
      expect(noAuthRes.statusCode).toBe(401);

      const viewerRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${viewerToken}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });
      expect(viewerRes.statusCode).toBe(200);

      const automationRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${automationToken}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });
      expect(automationRes.statusCode).toBe(403);
      expect(JSON.parse(automationRes.payload).requiredPermission).toBe('EXPORT_DATA');
    });
  });

  describe('POST .../exports/definitions', () => {
    it('PROJECT scope, NATIVE_JSON: returns the full suite/case/step tree with correct headers', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain('.json');

      const body = JSON.parse(res.payload);
      expect(body.object).toBe('definitions_export_bundle');
      expect(body.scope).toEqual({ type: 'PROJECT' });
      expect(body.record_count.case_count).toBe(10);
      expect(body.suites).toHaveLength(1);
      expect(body.suites[0].cases).toHaveLength(10);
      const firstCase = body.suites[0].cases.find((c: any) => c.external_id === 'SHOP-101');
      expect(firstCase.steps).toHaveLength(2);
      expect(firstCase.version.status).toBe('APPROVED');
    });

    it('PROJECT scope, STANDARD_CSV: correct header row and one row per step', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'STANDARD_CSV', scope: { type: 'PROJECT' } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('.csv');

      const lines = res.payload.split('\r\n').filter((l: string) => l.length > 0);
      expect(lines[0]).toBe('Suite Path,External ID,Title,Summary,Preconditions,Importance,Execution Type,Step Number,Action,Expected Result');
      // 10 cases * 2 steps each = 20 data rows + 1 header
      expect(lines).toHaveLength(21);
    });

    it('SUITE scope: only that subtree is exported', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const childSuiteId = 'export-test-child-suite-000001';
      await db
        .insertInto('test_suites')
        .values({
          id: childSuiteId,
          project_id: seed.projectId,
          parent_suite_id: seed.suiteId,
          name: 'Child Suite',
          description: null,
          position: 99,
          path: `/${seed.suiteId}/${childSuiteId}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'SUITE', suite_id: childSuiteId } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.scope).toEqual({ type: 'SUITE', suite_id: childSuiteId, suite_name: 'Child Suite' });
      expect(body.suites).toHaveLength(1);
      expect(body.suites[0].id).toBe(childSuiteId);
      expect(body.record_count.case_count).toBe(0);
    });

    it('PLAN scope exports the PINNED version, not the latest, even after the case is re-versioned', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const caseId = seed.caseIds[0];
      const newVersionId = 'export-test-new-version-0000001';
      await db
        .insertInto('test_case_versions')
        .values({
          id: newVersionId,
          test_case_id: caseId,
          version_number: 2,
          status: 'APPROVED',
          summary: 'THIS IS THE NEW LATEST VERSION, NOT WHAT THE PLAN PINNED',
          preconditions: null,
          author_id: 'usr_qa_lead_01',
          reviewer_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PLAN', plan_id: seed.planId } },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.scope.type).toBe('PLAN');
      expect(body.record_count.case_count).toBe(10);

      const exportedCase = body.suites[0].cases.find((c: any) => c.id === caseId);
      expect(exportedCase.version.version_number).toBe(1);
      expect(exportedCase.version.summary).not.toContain('THIS IS THE NEW LATEST VERSION');
    });

    it('status_filter APPROVED_ONLY excludes DRAFT cases but keeps the (now-empty) suite', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const draftCaseId = 'export-test-draft-case-00000001';
      const draftVersionId = 'export-test-draft-version-000001';
      await db
        .insertInto('test_cases')
        .values({
          id: draftCaseId,
          project_id: seed.projectId,
          test_suite_id: seed.suiteId,
          external_id: 'SHOP-DRAFT-1',
          title: 'A draft case',
          priority: 'LOW',
          execution_type: 'MANUAL',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();
      await db
        .insertInto('test_case_versions')
        .values({
          id: draftVersionId,
          test_case_id: draftCaseId,
          version_number: 1,
          status: 'DRAFT',
          summary: null,
          preconditions: null,
          author_id: 'usr_qa_lead_01',
          reviewer_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' }, status_filter: 'APPROVED_ONLY' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status_filter).toBe('APPROVED_ONLY');
      expect(body.record_count.case_count).toBe(10); // the 10 seeded APPROVED cases, draft excluded
      expect(body.suites[0].cases.some((c: any) => c.id === draftCaseId)).toBe(false);
    });

    it('includes custom field values, and the definitions catalog names/types them', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const field = await new CustomFieldRepository(db).createDefinition({
        project_id: seed.projectId,
        entity_type: 'TestCase',
        name: 'export_test_field',
        field_label: 'Export Test Field',
        field_type: 'TEXT',
      });
      await new CustomFieldRepository(db).setValue(field.id, 'TestCase', seed.caseIds[0], 'hello export', seed.projectId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });

      const body = JSON.parse(res.payload);
      const def = body.custom_field_definitions.find((d: any) => d.id === field.id);
      expect(def).toMatchObject({ name: 'export_test_field', field_label: 'Export Test Field', field_type: 'TEXT' });

      const exportedCase = body.suites[0].cases.find((c: any) => c.id === seed.caseIds[0]);
      const cfv = exportedCase.custom_field_values.find((v: any) => v.definition_id === field.id);
      expect(cfv.value).toBe('hello export');
    });

    it('writes a DATA_EXPORTED audit row visible through GET /api/v1/admin/audit-logs (not just the raw table)', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', scope: { type: 'PROJECT' } },
      });

      const auditRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(auditRes.statusCode).toBe(200);
      const entry = JSON.parse(auditRes.payload).audit_logs.find(
        (l: any) => l.action === 'DATA_EXPORTED' && l.resource_id === seed.projectId
      );
      expect(entry).toBeDefined();
      const diff = JSON.parse(entry.diff);
      expect(diff.export_kind).toBe('DEFINITIONS');
      expect(diff.record_count.case_count).toBe(10);
    });
  });

  describe('CSV definitions export round-trips through the existing importer', () => {
    it('re-imports the exported CSV into a fresh project, modulo the documented Importance->MEDIUM folding', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const exportRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/definitions`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'STANDARD_CSV', scope: { type: 'PROJECT' } },
      });
      expect(exportRes.statusCode).toBe(200);
      const csv = exportRes.payload;

      const otherProject = await new ProjectRepository(db).create({ name: 'Reimport Target', prefix: 'REIM' });

      const execRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: csv,
          filename: 'export.csv',
          format: 'STANDARD_CSV',
          target_project_id: otherProject.id,
          configuration: { duplicate_resolution: { default_action: 'CREATE_NEW' } },
        },
      });
      expect(execRes.statusCode).toBe(200);
      const execBody = JSON.parse(execRes.payload);
      expect(execBody.summary.imported_cases_count).toBe(10);

      // The seeded cases 1-3 are HIGH priority -- HIGH survives the CSV round-trip exactly
      // (only non-HIGH/MEDIUM/LOW values get folded to MEDIUM on reimport).
      const reimportedHighCase = await db
        .selectFrom('test_cases')
        .selectAll()
        .where('project_id', '=', otherProject.id)
        .where('external_id', '=', 'SHOP-101')
        .executeTakeFirst();
      expect(reimportedHighCase?.priority).toBe('HIGH');

      const reimportedSteps = await db
        .selectFrom('test_case_versions')
        .innerJoin('test_steps', 'test_steps.test_case_version_id', 'test_case_versions.id')
        .selectAll()
        .where('test_case_versions.test_case_id', '=', reimportedHighCase!.id)
        .execute();
      expect(reimportedSteps).toHaveLength(2);
    });
  });

  describe('POST .../exports/execution-results', () => {
    async function recordAnExecution(app: any, token: string, seed: any) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED', notes: 'looks good' }] },
      });
      expect(res.statusCode).toBe(201);
    }

    it('NATIVE_JSON and STANDARD_CSV both return the build\'s executions with step results', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      await recordAnExecution(app, token, seed);

      const jsonRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/execution-results`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', plan_id: seed.planId, build_id: seed.buildId },
      });
      expect(jsonRes.statusCode).toBe(200);
      const jsonBody = JSON.parse(jsonRes.payload);
      expect(jsonBody.object).toBe('execution_results_export_bundle');
      expect(jsonBody.executions.length).toBeGreaterThanOrEqual(1);
      const ex = jsonBody.executions.find((e: any) => e.test_case_external_id === 'SHOP-101');
      expect(ex.verdict).toBe('PASSED');
      expect(ex.notes).toBe('looks good');

      const csvRes = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${seed.projectId}/exports/execution-results`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'STANDARD_CSV', plan_id: seed.planId, build_id: seed.buildId },
      });
      expect(csvRes.statusCode).toBe(200);
      expect(csvRes.payload.split('\r\n')[0]).toContain('Test Case External ID');
      expect(csvRes.payload).toContain('SHOP-101');
    });

    it('404s when the build does not belong to the given plan/project', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);
      const otherProject = await new ProjectRepository(db).create({ name: 'Other', prefix: 'OTHR' });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/projects/${otherProject.id}/exports/execution-results`,
        headers: { authorization: `Bearer ${token}` },
        payload: { format: 'NATIVE_JSON', plan_id: seed.planId, build_id: seed.buildId },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET .../plans/:planId/builds', () => {
    it('lists the plan\'s builds for the Export modal\'s picker', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/projects/${seed.projectId}/plans/${seed.planId}/builds`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.builds.some((b: any) => b.id === seed.buildId)).toBe(true);
    });
  });
});
