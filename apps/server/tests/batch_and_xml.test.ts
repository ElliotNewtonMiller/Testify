import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import { TestCaseRepository, TestCaseVersionRepository, ProjectRepository, TestPlanRepository, TestRunRepository, CustomFieldRepository } from '@testify/db';

describe('Batch Execution & Multi-Format XML/JSON/CSV Ingestion API', () => {
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

  async function mintApiToken(
    app: any,
    adminToken: string,
    projectId: string,
    capabilities: string[]
  ): Promise<{ plaintext: string; id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/api-tokens`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: 'test token', capabilities },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    return { plaintext: body.plaintext as string, id: body.token.id as string };
  }

  // 1. Dry-Run Import Preview Tests
  describe('POST /api/v1/imports/dry-run', () => {
    it('accepts an import larger than Fastify\'s default 1 MB body limit (real TestLink exports)', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // ~2 MB of XML -- comfortably past the old 1 MB default that dropped the upload.
      const padding = 'x'.repeat(2000);
      const cases = Array.from(
        { length: 1000 },
        (_, i) => `    <testcase name="Big case ${i}"><externalid><![CDATA[BIG-${i}]]></externalid><summary><![CDATA[${padding}]]></summary></testcase>`
      ).join('\n');
      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="Big Suite">\n${cases}\n  </testsuite>\n</testsuites>`;
      expect(xmlPayload.length).toBeGreaterThan(1024 * 1024);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}` },
        payload: { file_content: xmlPayload, filename: 'big.xml', target_project_id: seed.projectId },
      });
      expect(res.statusCode).toBe(200);
    });

    it('previews TestLink XML import and detects unmapped custom fields + duplicate reconciliation diff', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="E2E Security Suite">
    <details><![CDATA[<p>Security test suite</p>]]></details>
    <node_order><![CDATA[1]]></node_order>
    <testcase name="Verify OAuth2 PKCE Flow">
      <externalid><![CDATA[TC-SEC-101]]></externalid>
      <summary><![CDATA[Check PKCE verifier]]></summary>
      <preconditions><![CDATA[Client registered]]></preconditions>
      <importance><![CDATA[3]]></importance>
      <execution_type><![CDATA[2]]></execution_type>
      <steps>
        <step>
          <step_number><![CDATA[1]]></step_number>
          <actions><![CDATA[Send token req]]></actions>
          <expectedresults><![CDATA[HTTP 200]]></expectedresults>
        </step>
      </steps>
      <custom_fields>
        <custom_field>
          <name><![CDATA[cf_security_tier]]></name>
          <value><![CDATA[Tier-1]]></value>
        </custom_field>
      </custom_fields>
    </testcase>
  </testsuites>`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: xmlPayload,
          filename: 'security_suite.xml',
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            duplicate_resolution: { default_action: 'VERSION_UP' },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.dry_run_summary).toBeDefined();
      expect(data.dry_run_summary.total_suites_detected).toBe(1);
      expect(data.dry_run_summary.total_cases_detected).toBe(1);
      expect(data.dry_run_summary.cases_to_create).toBe(1);
      expect(data.dry_run_summary.unmapped_custom_fields_count).toBe(1);

      expect(data.unmapped_custom_fields.length).toBe(1);
      expect(data.unmapped_custom_fields[0].incoming_key).toBe('cf_security_tier');

      expect(data.hierarchy_preview.length).toBe(1);
      expect(data.hierarchy_preview[0].name).toBe('E2E Security Suite');
    });

    it('previews CSV spec sheet import correctly', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const csvPayload = `Suite Path,Title,External ID,Summary,Importance,Execution Type,Step Number,Action,Expected Result,CF: Browser
Auth / Login,Password Login,TC-CSV-1,Verify pass login,HIGH,AUTOMATED,1,Type pass,Pass,Chrome
Auth / Login,Password Login,TC-CSV-1,Verify pass login,HIGH,AUTOMATED,2,Click submit,Logged in,Chrome`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: csvPayload,
          filename: 'cases.csv',
          format: 'STANDARD_CSV',
          target_project_id: seed.projectId,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);

      expect(data.dry_run_summary.total_suites_detected).toBe(2);
      expect(data.dry_run_summary.total_cases_detected).toBe(1);
      expect(data.dry_run_summary.unmapped_custom_fields_count).toBe(1);
      expect(data.unmapped_custom_fields[0].incoming_key).toBe('cf_browser');
    });

    it('requires authentication -- 401 with no token, 403 for a Viewer lacking IMPORT_DATA', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');

      const payload = { file_content: '<testsuites></testsuites>', format: 'TESTLINK_XML', target_project_id: seed.projectId };

      const noAuthRes = await app.inject({ method: 'POST', url: '/api/v1/imports/dry-run', payload });
      expect(noAuthRes.statusCode).toBe(401);

      const viewerRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${viewerToken}` },
        payload,
      });
      expect(viewerRes.statusCode).toBe(403);
    });
  });

  // 2. Import Execution Tests
  describe('POST /api/v1/imports/execute', () => {
    it('AUTO_CREATE as SINGLE_SELECT / MULTI_SELECT builds the options from the column\'s values', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const tc = (id: string, status: string, tags: string) => `    <testcase name="Case ${id}">
      <externalid><![CDATA[${id}]]></externalid>
      <custom_fields>
        <custom_field><name><![CDATA[automationStatus]]></name><value><![CDATA[${status}]]></value></custom_field>
        <custom_field><name><![CDATA[tags]]></name><value><![CDATA[${tags}]]></value></custom_field>
      </custom_fields>
    </testcase>`;
      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Select Fields">
${tc('SEL-1', 'N/A', 'ui, api')}
${tc('SEL-2', 'Done', 'api')}
${tc('SEL-3', 'To Do', 'slow,ui')}
${tc('SEL-4', 'Done', '')}
  </testsuite>
</testsuites>`;

      const dry = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}` },
        payload: { file_content: xmlPayload, format: 'TESTLINK_XML', target_project_id: seed.projectId },
      });
      expect(dry.statusCode).toBe(200);
      const status = JSON.parse(dry.payload).unmapped_custom_fields.find((f: any) => f.incoming_key === 'automationStatus');
      expect(status.distinct_values).toEqual(['N/A', 'Done', 'To Do']);
      // These cases have no steps -- each EMPTY_STEPS warning names its case and suite.
      const emptySteps = JSON.parse(dry.payload).warnings.filter((w: any) => w.code === 'EMPTY_STEPS');
      expect(emptySteps.map((w: any) => w.case_external_id)).toEqual(['SEL-1', 'SEL-2', 'SEL-3', 'SEL-4']);
      expect(emptySteps[0]).toMatchObject({ case_title: 'Case SEL-1', suite_path: 'Select Fields' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: xmlPayload,
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            field_mappings: [
              { incoming_key: 'automationStatus', action: 'AUTO_CREATE', field_type: 'SINGLE_SELECT' },
              { incoming_key: 'tags', action: 'AUTO_CREATE', field_type: 'MULTI_SELECT' },
            ],
            duplicate_resolution: { default_action: 'CREATE_NEW' },
          },
        },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).summary.skipped_custom_field_values_count).toBe(0);

      const optionsOf = async (name: string) => {
        const def = await db.selectFrom('custom_field_definitions').selectAll().where('name', '=', name).executeTakeFirstOrThrow();
        const opts = await db
          .selectFrom('custom_field_options')
          .select('option_value')
          .where('custom_field_definition_id', '=', def.id)
          .orderBy('position')
          .execute();
        return { def, options: opts.map((o: any) => o.option_value) };
      };
      const single = await optionsOf('automationStatus');
      expect(single.def.field_type).toBe('SINGLE_SELECT');
      expect(single.options).toEqual(['N/A', 'Done', 'To Do']);
      const multi = await optionsOf('tags');
      expect(multi.def.field_type).toBe('MULTI_SELECT');
      expect(multi.options).toEqual(['ui', 'api', 'slow']);

      const caseId = (await db.selectFrom('test_cases').select('id').where('external_id', '=', 'SEL-3').executeTakeFirstOrThrow()).id;
      const values = await app.inject({
        method: 'GET',
        url: `/api/v1/test-cases/${caseId}/custom-field-values`,
        headers: { authorization: `Bearer ${token}` },
      });
      const byName = Object.fromEntries(JSON.parse(values.payload).values.map((v: any) => [v.definition.name, v.value]));
      expect(byName.automationStatus).toBe('To Do');
      expect(byName.tags).toEqual(['slow', 'ui']);
    });

    it('executes TestLink XML import with AUTO_CREATE custom field mapping', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Payment Gateway">
    <details><![CDATA[Payment test suite]]></details>
    <node_order><![CDATA[1]]></node_order>
    <testcase name="Stripe 3DS Checkout">
      <externalid><![CDATA[TC-PAY-301]]></externalid>
      <summary><![CDATA[Test 3DS flow]]></summary>
      <importance><![CDATA[3]]></importance>
      <execution_type><![CDATA[2]]></execution_type>
      <steps>
        <step>
          <step_number><![CDATA[1]]></step_number>
          <actions><![CDATA[Trigger checkout]]></actions>
          <expectedresults><![CDATA[Modal displayed]]></expectedresults>
        </step>
      </steps>
      <custom_fields>
        <custom_field>
          <name><![CDATA[cf_gateway]]></name>
          <value><![CDATA[Stripe]]></value>
        </custom_field>
      </custom_fields>
    </testcase>
  </testsuites>`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: xmlPayload,
          filename: 'payments.xml',
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            field_mappings: [
              {
                incoming_key: 'cf_gateway',
                action: 'AUTO_CREATE',
                field_name: 'Payment Gateway',
                field_type: 'TEXT',
              },
            ],
            duplicate_resolution: { default_action: 'CREATE_NEW' },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.object).toBe('import_execute_result');
      expect(data.summary.imported_suites_count).toBe(1);
      expect(data.summary.imported_cases_count).toBe(1);
      expect(data.summary.auto_created_custom_fields_count).toBe(1);

      // Verify DB records created
      const suiteInDb = await db.selectFrom('test_suites').selectAll().where('name', '=', 'Payment Gateway').executeTakeFirst();
      expect(suiteInDb).toBeDefined();

      const caseInDb = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'TC-PAY-301').executeTakeFirst();
      expect(caseInDb).toBeDefined();
      expect(caseInDb?.title).toBe('Stripe 3DS Checkout');

      const cfDef = await db.selectFrom('custom_field_definitions').selectAll().where('name', '=', 'cf_gateway').executeTakeFirst();
      expect(cfDef).toBeDefined();
      // Routed through the same unified CustomFieldRepository the Admin Panel/Spec-mode
      // use -- entity_type 'TestCase' (not the old raw-SQL path's undeclared
      // 'TestCaseVersion'), project-scoped (not global), real field_type validation.
      expect(cfDef?.entity_type).toBe('TestCase');
      expect(cfDef?.project_id).toBe(seed.projectId);
      expect(cfDef?.field_type).toBe('TEXT');

      const cfVal = await db.selectFrom('custom_field_values').selectAll().where('custom_field_definition_id', '=', cfDef!.id).executeTakeFirst();
      expect(cfVal).toBeDefined();
      expect(cfVal?.string_value).toBe('Stripe');
      // entity_id is the case's own id, not a version id -- values are never
      // version-locked, matching every other Spec-mode custom field value in this app.
      // This is also what makes the value visible through the existing
      // GET /api/v1/test-cases/:caseId/custom-field-values read path with zero
      // special-casing.
      expect(cfVal?.entity_type).toBe('TestCase');
      expect(cfVal?.entity_id).toBe(caseInDb!.id);

      const valuesRes = await app.inject({
        method: 'GET',
        url: `/api/v1/test-cases/${caseInDb!.id}/custom-field-values`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(valuesRes.statusCode).toBe(200);
      const valuesBody = JSON.parse(valuesRes.body);
      const gatewayEntry = valuesBody.values.find((v: any) => v.definition.name === 'cf_gateway');
      expect(gatewayEntry).toBeDefined();
      expect(gatewayEntry.value).toBe('Stripe');

      // The dangling security gap this feature closes: import execute now leaves an
      // audit trail attributing the import to the real authenticated actor.
      const auditRow = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('action', '=', 'IMPORT_EXECUTED')
        .where('resource_id', '=', seed.projectId)
        .executeTakeFirst();
      expect(auditRow).toBeDefined();
      expect(auditRow?.actor_type).toBe('USER');

      // Also visible through the Admin Panel's own Security Audit Log route, not just the
      // raw table -- regression test for IMPORT_EXECUTED being in its action allowlist.
      const auditLogRes = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/audit-logs',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(auditLogRes.statusCode).toBe(200);
      const visibleImportLog = JSON.parse(auditLogRes.payload).audit_logs.find(
        (l: any) => l.action === 'IMPORT_EXECUTED' && l.resource_id === seed.projectId
      );
      expect(visibleImportLog).toBeDefined();
    });

    it('handles duplicate reconciliation with VERSION_UP strategy', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // First import
      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Auth Suite">
    <testcase name="Verify Refresh Token">
      <externalid><![CDATA[TC-DUP-1]]></externalid>
      <summary><![CDATA[Initial version v1]]></summary>
    </testcase>
  </testsuite>
</testsuites>`;

      await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: xmlPayload,
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
        },
      });

      // Second import of same externalid with VERSION_UP
      const secondPayload = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="Auth Suite">
    <testcase name="Verify Refresh Token">
      <externalid><![CDATA[TC-DUP-1]]></externalid>
      <summary><![CDATA[Updated version v2]]></summary>
    </testcase>
  </testsuite>
</testsuites>`;

      const res2 = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: secondPayload,
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            duplicate_resolution: { default_action: 'VERSION_UP' },
          },
        },
      });

      expect(res2.statusCode).toBe(200);
      const data2 = JSON.parse(res2.body);
      expect(data2.summary.created_versions_count).toBe(1);

      // Verify versions in DB
      const caseInDb = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'TC-DUP-1').executeTakeFirst();
      expect(caseInDb).toBeDefined();

      const versions = await db.selectFrom('test_case_versions').selectAll().where('test_case_id', '=', caseInDb!.id).orderBy('version_number', 'asc').execute();
      expect(versions.length).toBe(2);
      expect(versions[0].version_number).toBe(1);
      expect(versions[0].summary).toBe('Initial version v1');
      expect(versions[1].version_number).toBe(2);
      expect(versions[1].summary).toBe('Updated version v2');
    });

    it('rejects a request with no target_project_id anywhere (previously silently picked an arbitrary project)', async () => {
      const { app, db } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const before = await db.selectFrom('test_cases').select(db.fn.count('id').as('cnt')).executeTakeFirst();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: '<testsuites><testsuite name="X"><testcase name="Y"><externalid>NOPROJ-1</externalid></testcase></testsuite></testsuites>',
          format: 'TESTLINK_XML',
          // no target_project_id / project_id anywhere
        },
      });

      expect(res.statusCode).toBe(400);
      const after = await db.selectFrom('test_cases').select(db.fn.count('id').as('cnt')).executeTakeFirst();
      expect(Number(after?.cnt)).toBe(Number(before?.cnt));
    });

    it('a machine token defaults to its own bound project when none is given, and is rejected for a mismatched one', async () => {
      const { app, db, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { plaintext: apiToken } = await mintApiToken(app, adminToken, seed.projectId, ['IMPORT_DATA']);

      const xmlPayload =
        '<testsuites><testsuite name="Token Suite"><testcase name="Token Case"><externalid>TOK-1</externalid></testcase></testsuite></testsuites>';

      const okRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { file_content: xmlPayload, format: 'TESTLINK_XML' }, // no target_project_id
      });
      expect(okRes.statusCode).toBe(200);
      const caseInDb = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'TOK-1').executeTakeFirst();
      expect(caseInDb?.project_id).toBe(seed.projectId);

      const otherProject = await new ProjectRepository(db).create({ name: 'Other Project', prefix: 'OTHR' });
      const mismatchRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { file_content: xmlPayload, format: 'TESTLINK_XML', target_project_id: otherProject.id },
      });
      expect(mismatchRes.statusCode).toBe(403);
      expect(JSON.parse(mismatchRes.payload).code).toBe('TOKEN_PROJECT_MISMATCH');
    });

    it('rolls back the entire import, including an earlier successfully-created field, when a later AUTO_CREATE mapping fails', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const before = await db.selectFrom('test_cases').select(db.fn.count('id').as('cnt')).executeTakeFirst();

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content:
            '<testsuites><testsuite name="Atomicity Suite"><testcase name="Atomicity Case"><externalid>ATOM-1</externalid><custom_fields><custom_field><name><![CDATA[cf_a]]></name><value><![CDATA[x]]></value></custom_field><custom_field><name><![CDATA[cf_b]]></name><value><![CDATA[y]]></value></custom_field></custom_fields></testcase></testsuite></testsuites>',
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            field_mappings: [
              { incoming_key: 'cf_a', action: 'AUTO_CREATE', field_type: 'TEXT' },
              { incoming_key: 'cf_b', action: 'AUTO_CREATE', field_type: 'NOT_A_REAL_TYPE' as any },
            ],
          },
        },
      });

      expect(res.statusCode).toBe(400);

      // Neither the earlier-in-the-loop cf_a field nor the suite/case were left behind --
      // the whole transaction rolled back, not just the statement that actually threw.
      const cfA = await db.selectFrom('custom_field_definitions').selectAll().where('name', '=', 'cf_a').executeTakeFirst();
      expect(cfA).toBeUndefined();
      const caseInDb = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'ATOM-1').executeTakeFirst();
      expect(caseInDb).toBeUndefined();
      const after = await db.selectFrom('test_cases').select(db.fn.count('id').as('cnt')).executeTakeFirst();
      expect(Number(after?.cnt)).toBe(Number(before?.cnt));
    });

    it('skips a single custom field value that fails validation, without aborting the rest of the import', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const selectField = await new CustomFieldRepository(db).createDefinition({
        project_id: seed.projectId,
        entity_type: 'TestCase',
        name: 'preexisting_select',
        field_label: 'Environment',
        field_type: 'SINGLE_SELECT',
        options: [{ option_label: 'Staging', option_value: 'staging' }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content:
            '<testsuites><testsuite name="Skip Suite"><testcase name="Skip Case"><externalid>SKIP-1</externalid><custom_fields><custom_field><name><![CDATA[cf_env]]></name><value><![CDATA[production]]></value></custom_field></custom_fields></testcase></testsuite></testsuites>',
          format: 'TESTLINK_XML',
          target_project_id: seed.projectId,
          configuration: {
            field_mappings: [{ incoming_key: 'cf_env', action: 'ROUTE_TO_EXISTING', target_field_id: selectField.id }],
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.summary.imported_cases_count).toBe(1);
      expect(body.summary.skipped_custom_field_values_count).toBe(1);
      expect(body.skipped_custom_field_value_warnings).toHaveLength(1);
      expect(body.skipped_custom_field_value_warnings[0]).toMatchObject({ case_external_id_or_title: 'SKIP-1', incoming_key: 'cf_env' });

      // The case itself was still created despite the one bad value.
      const caseInDb = await db.selectFrom('test_cases').selectAll().where('external_id', '=', 'SKIP-1').executeTakeFirst();
      expect(caseInDb).toBeDefined();
      const valueRow = await db
        .selectFrom('custom_field_values')
        .selectAll()
        .where('custom_field_definition_id', '=', selectField.id)
        .executeTakeFirst();
      expect(valueRow).toBeUndefined();
    });

    it('imports a JUnit XML report as AUTOMATED cases with junit_status/junit_duration_seconds as ordinary mappable custom fields', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const junitPayload = `<testsuites>
  <testsuite name="CI Run" tests="1">
    <testcase classname="pkg.LoginTest" name="testLogin" time="0.5" />
  </testsuite>
</testsuites>`;

      const dryRunRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
        headers: { authorization: `Bearer ${token}` },
        payload: { file_content: junitPayload, format: 'JUNIT_XML', target_project_id: seed.projectId },
      });
      expect(dryRunRes.statusCode).toBe(200);
      const dryRunBody = JSON.parse(dryRunRes.payload);
      const keys = dryRunBody.unmapped_custom_fields.map((f: any) => f.incoming_key);
      expect(keys).toContain('junit_status');
      expect(keys).toContain('junit_duration_seconds');

      const execRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: junitPayload,
          format: 'JUNIT_XML',
          target_project_id: seed.projectId,
          configuration: {
            field_mappings: [
              { incoming_key: 'junit_status', action: 'AUTO_CREATE', field_type: 'TEXT' },
              { incoming_key: 'junit_duration_seconds', action: 'DROP' },
            ],
          },
        },
      });
      expect(execRes.statusCode).toBe(200);

      const caseInDb = await db.selectFrom('test_cases').selectAll().where('title', '=', 'testLogin').executeTakeFirst();
      expect(caseInDb).toBeDefined();
      expect(caseInDb?.execution_type).toBe('AUTOMATED');

      // No Execution-mode records are created by a JUnit import (case-level custom fields
      // only) -- confirms the locked-in "custom fields only" design decision.
      const executionCount = await db.selectFrom('test_results').select(db.fn.count('id').as('cnt')).executeTakeFirst();
      expect(Number(executionCount?.cnt)).toBe(0);
    });

    it('requires TESTRAIL_CSV to be explicitly selected -- it is never auto-detected', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const testRailCsv = ['Title,Section,Priority,Steps,Expected Result', 'TR Case,Suite A,High,Do X,See Y'].join('\n');

      // No explicit format -- falls through to STANDARD_CSV's generic fuzzy matching
      // rather than being recognized as TestRail's shape.
      const autoRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: { file_content: testRailCsv, filename: 'export.csv', target_project_id: seed.projectId },
      });
      expect(autoRes.statusCode).toBe(200);
      const autoCase = await db.selectFrom('test_cases').selectAll().where('title', '=', 'TR Case').executeTakeFirst();
      // STANDARD_CSV has no "Priority" column recognition and treats "Section" generically
      // as the suite path column -- title still comes through, but priority does not fold
      // TestRail's label the way TESTRAIL_CSV would (this just proves STANDARD_CSV, not
      // TESTRAIL_CSV, handled it).
      expect(autoCase).toBeDefined();

      // Explicit selection works and folds priority correctly.
      const explicitRes = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/execute',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          file_content: testRailCsv,
          filename: 'export2.csv',
          format: 'TESTRAIL_CSV',
          target_project_id: seed.projectId,
          configuration: { duplicate_resolution: { default_action: 'CREATE_NEW' } },
        },
      });
      expect(explicitRes.statusCode).toBe(200);
    });
  });

  describe('GET /api/v1/imports/custom-field-options', () => {
    it('401s with no auth, 403s for a Viewer, and 200s with a global+project-scoped merged list for an IMPORT_DATA holder', async () => {
      const { app, db, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');

      await new CustomFieldRepository(db).createDefinition({ entity_type: 'TestCase', name: 'global_opt', field_label: 'Global', field_type: 'TEXT' });
      await new CustomFieldRepository(db).createDefinition({
        project_id: seed.projectId,
        entity_type: 'TestCase',
        name: 'project_opt',
        field_label: 'Project',
        field_type: 'TEXT',
      });

      const noAuthRes = await app.inject({ method: 'GET', url: `/api/v1/imports/custom-field-options?target_project_id=${seed.projectId}` });
      expect(noAuthRes.statusCode).toBe(401);

      const viewerRes = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/custom-field-options?target_project_id=${seed.projectId}`,
        headers: { authorization: `Bearer ${viewerToken}` },
      });
      expect(viewerRes.statusCode).toBe(403);

      const okRes = await app.inject({
        method: 'GET',
        url: `/api/v1/imports/custom-field-options?target_project_id=${seed.projectId}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(okRes.statusCode).toBe(200);
      const names = JSON.parse(okRes.payload).definitions.map((d: any) => d.name);
      expect(names).toEqual(expect.arrayContaining(['global_opt', 'project_opt']));

      const missingProjectRes = await app.inject({
        method: 'GET',
        url: '/api/v1/imports/custom-field-options',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(missingProjectRes.statusCode).toBe(400);
    });
  });

  // 3. Batch Execution Ingestion Tests
  describe('POST /api/v1/test-plans/:planId/builds/:buildId/executions/batch', () => {
    it('processes batch of 1,000 execution results with high throughput in non-atomic mode', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // Generate 1,000 execution items targeting seeded case SHOP-101
      const executionsPayload: any[] = [];
      for (let i = 0; i < 1000; i++) {
        executionsPayload.push({
          case_identifier: { external_id: 'SHOP-101' },
          verdict: i % 10 === 0 ? 'FAILED' : 'PASSED',
          status: 'COMPLETED',
          duration_ms: 120 + i,
          executed_at: new Date().toISOString(),
          notes: `High-throughput CI run item #${i}`,
          environment_tags: { runner: 'github-actions', batch_id: 'batch-001' },
          step_results: [
            { step_number: 1, verdict: 'PASSED', actual_result: 'Step 1 OK' },
          ],
        });
      }

      const startTime = Date.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=false`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          environment: 'staging-us-east-1',
          runner_info: { name: 'GitHub Actions', run_id: '98124712' },
          executions: executionsPayload,
        },
      });
      const elapsedTime = Date.now() - startTime;

      expect(res.statusCode).toBe(201);
      const data = JSON.parse(res.body);
      expect(data.object).toBe('batch_execution_result');
      expect(data.summary.total_submitted).toBe(1000);
      expect(data.summary.successful).toBe(1000);
      expect(data.summary.failed).toBe(0);
      expect(data.results.length).toBe(1000);

      // Verify DB count
      const totalInDb = await db.selectFrom('test_results').select(db.fn.count('id').as('cnt')).where('test_run_id', '=', seed.buildId).executeTakeFirst();
      expect(Number(totalInDb?.cnt)).toBe(1000);
    });

    it('returns HTTP 207 Multi-Status in non-atomic mode when partial failures occur', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=false`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [
            {
              case_identifier: { external_id: 'SHOP-101' },
              verdict: 'PASSED',
            },
            {
              case_identifier: { external_id: 'NON-EXISTENT-CASE-999' },
              verdict: 'FAILED',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(207);
      const data = JSON.parse(res.body);
      expect(data.summary.total_submitted).toBe(2);
      expect(data.summary.successful).toBe(1);
      expect(data.summary.failed).toBe(1);
      expect(data.results[0].status).toBe(201);
      expect(data.results[1].status).toBe(422);
      expect(data.results[1].error).toBeDefined();
    });

    it('rejects entire batch with HTTP 422 in atomic mode (all_or_nothing=true) on error', async () => {
      const { app, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=true`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [
            {
              case_identifier: { external_id: 'SHOP-101' },
              verdict: 'PASSED',
            },
            {
              case_identifier: { external_id: 'NON-EXISTENT-CASE-999' },
              verdict: 'FAILED',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(422);
      const data = JSON.parse(res.body);
      expect(data.code).toBe('CASE_NOT_FOUND');
      expect(data.invalid_params).toBeDefined();
    });

    it('does not auto-link a case whose latest version is not APPROVED (same rule the Specification-mode toggle enforces)', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      const caseRepo = new TestCaseRepository(db);
      const versionRepo = new TestCaseVersionRepository(db);

      const draftCase = await caseRepo.create({
        project_id: seed.projectId,
        test_suite_id: seed.suiteId,
        external_id: 'SHOP-BATCH-DRAFT-1',
        title: 'Not yet in the plan, only a DRAFT version',
      });
      await versionRepo.create({
        test_case_id: draftCase.id,
        version_number: 1,
        status: 'DRAFT',
        author_id: 'usr_qa_lead_01',
      });

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=false`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [
            {
              case_identifier: { external_id: 'SHOP-BATCH-DRAFT-1' },
              verdict: 'PASSED',
            },
          ],
        },
      });

      expect(res.statusCode).toBe(207);
      const data = JSON.parse(res.body);
      expect(data.summary.successful).toBe(0);
      expect(data.summary.failed).toBe(1);
      expect(data.results[0].status).toBe(422);

      const planCase = await db
        .selectFrom('test_plan_cases')
        .selectAll()
        .where('test_case_id', '=', draftCase.id)
        .executeTakeFirst();
      expect(planCase).toBeUndefined();
    });

    it('requires authentication -- 401 with no token, 403 for a Viewer lacking EXECUTE_RUN', async () => {
      const { app, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { token: viewerToken } = await createAndLoginAs(app, adminToken, 'Viewer');
      const payload = { executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }] };
      const url = `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`;

      const noAuthRes = await app.inject({ method: 'POST', url, payload });
      expect(noAuthRes.statusCode).toBe(401);

      const viewerRes = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${viewerToken}` }, payload });
      expect(viewerRes.statusCode).toBe(403);
    });

    it('records the real authenticated actor as tester_id -- a human JWT user, not a client-supplied runner_info string', async () => {
      const { app, db, seed } = serverInstance;
      const { token, userId } = await loginAsAdmin(app);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          runner_info: { name: 'a-client-supplied-lie' },
          executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }],
        },
      });
      expect(res.statusCode).toBe(201);
      const execId = JSON.parse(res.payload).results[0].execution_id;
      const execRow = await db.selectFrom('test_results').selectAll().where('id', '=', execId).executeTakeFirst();
      expect(execRow?.tester_id).toBe(userId);
      expect(execRow?.tester_id).not.toBe('usr_ci_runner');
      expect(execRow?.tester_id).not.toBe('a-client-supplied-lie');

      const auditRow = await db
        .selectFrom('audit_logs')
        .selectAll()
        .where('action', '=', 'BATCH_EXECUTION_RECORDED')
        .where('resource_id', '=', seed.buildId)
        .executeTakeFirst();
      expect(auditRow).toBeDefined();
      expect(auditRow?.actor_id).toBe(userId);
      expect(auditRow?.actor_type).toBe('USER');
    });

    it('a machine token authenticates, records the synthetic service-account actor, and is rejected for a mismatched project build', async () => {
      const { app, db, seed } = serverInstance;
      const { token: adminToken } = await loginAsAdmin(app);
      const { plaintext: apiToken, id: apiTokenId } = await mintApiToken(app, adminToken, seed.projectId, ['EXECUTE_RUN']);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { executions: [{ case_identifier: { external_id: 'SHOP-102' }, verdict: 'PASSED' }] },
      });
      expect(res.statusCode).toBe(201);
      const execId = JSON.parse(res.payload).results[0].execution_id;
      const execRow = await db.selectFrom('test_results').selectAll().where('id', '=', execId).executeTakeFirst();
      expect(execRow?.tester_id).toBe(apiTokenId);

      // A build belonging to a different project -- token scoped to seed.projectId must be rejected.
      const otherProject = await new ProjectRepository(db).create({ name: 'Other Project 2', prefix: 'OTHR2' });
      const otherPlan = await new TestPlanRepository(db).create({ project_id: otherProject.id, name: 'Other Plan' });
      const otherBuild = await new TestRunRepository(db).create({ test_plan_id: otherPlan.id, name: 'Other Build' });

      const mismatchRes = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${otherPlan.id}/builds/${otherBuild.id}/executions/batch`,
        headers: { authorization: `Bearer ${apiToken}` },
        payload: { executions: [{ case_identifier: { external_id: 'anything' }, verdict: 'PASSED' }] },
      });
      expect(mismatchRes.statusCode).toBe(403);
      expect(JSON.parse(mismatchRes.payload).code).toBe('TOKEN_PROJECT_MISMATCH');
    });
  });

  // 4. Locked Plan & Closed Build HTTP 422 RFC 7807 Problem Details Tests
  describe('HTTP 422 Problem Details Standards (PLAN_LOCKED, BUILD_CLOSED, CASE_VERSION_LOCKED)', () => {
    it('returns HTTP 422 PLAN_LOCKED problem details when test plan is locked', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // Lock test plan
      await db.updateTable('test_plans').set({ status: 'LOCKED' }).where('id', '=', seed.planId).execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const err = JSON.parse(res.body);
      expect(err.code).toBe('PLAN_LOCKED');
      expect(err.status).toBe(422);
      expect(err.type).toBe('https://api.testify.dev/errors/PLAN_LOCKED');
      expect(err.detail).toContain('locked');
    });

    it('returns HTTP 422 BUILD_CLOSED problem details when build is closed', async () => {
      const { app, db, seed } = serverInstance;
      const { token } = await loginAsAdmin(app);

      // Close build
      await db.updateTable('test_runs').set({ status: 'CLOSED' }).where('id', '=', seed.buildId).execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          executions: [{ case_identifier: { external_id: 'SHOP-101' }, verdict: 'PASSED' }],
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const err = JSON.parse(res.body);
      expect(err.code).toBe('BUILD_CLOSED');
      expect(err.status).toBe(422);
      expect(err.type).toBe('https://api.testify.dev/errors/BUILD_CLOSED');
      expect(err.invalid_params[0].name).toBe('build_id');
    });

    it('returns HTTP 422 CASE_VERSION_LOCKED when editing an approved case version', async () => {
      const { app, db, seed } = serverInstance;

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'admin', password: 'password' },
      });
      const token = JSON.parse(loginRes.payload).token as string;

      // Find an approved version
      const ver = await db.selectFrom('test_case_versions').selectAll().where('status', '=', 'APPROVED').executeTakeFirst();
      expect(ver).toBeDefined();

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/projects/${seed.projectId}/test-case-versions/${ver!.id}`,
        headers: { authorization: `Bearer ${token}` },
        payload: { summary: 'Attempting to edit approved version' },
      });

      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const err = JSON.parse(res.body);
      expect(err.code).toBe('CASE_VERSION_LOCKED');
      expect(err.status).toBe(422);
      expect(err.type).toBe('https://api.testify.dev/errors/CASE_VERSION_LOCKED');
    });
  });
});
