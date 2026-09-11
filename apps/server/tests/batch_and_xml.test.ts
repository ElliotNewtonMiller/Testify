import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';

describe('Batch Execution & Multi-Format XML/JSON/CSV Ingestion API', () => {
  let serverInstance: any;

  beforeEach(async () => {
    serverInstance = await createServer();
  });

  afterEach(async () => {
    await serverInstance.db.destroy();
  });

  // 1. Dry-Run Import Preview Tests
  describe('POST /api/v1/imports/dry-run', () => {
    it('previews TestLink XML import and detects unmapped custom fields + duplicate reconciliation diff', async () => {
      const { app, seed } = serverInstance;

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

      const csvPayload = `Suite Path,Title,External ID,Summary,Importance,Execution Type,Step Number,Action,Expected Result,CF: Browser
Auth / Login,Password Login,TC-CSV-1,Verify pass login,HIGH,AUTOMATED,1,Type pass,Pass,Chrome
Auth / Login,Password Login,TC-CSV-1,Verify pass login,HIGH,AUTOMATED,2,Click submit,Logged in,Chrome`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/imports/dry-run',
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
  });

  // 2. Import Execution Tests
  describe('POST /api/v1/imports/execute', () => {
    it('executes TestLink XML import with AUTO_CREATE custom field mapping', async () => {
      const { app, db, seed } = serverInstance;

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
                field_type: 'STRING',
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

      const cfVal = await db.selectFrom('custom_field_values').selectAll().where('custom_field_definition_id', '=', cfDef!.id).executeTakeFirst();
      expect(cfVal).toBeDefined();
      expect(cfVal?.string_value).toBe('Stripe');
    });

    it('handles duplicate reconciliation with VERSION_UP strategy', async () => {
      const { app, db, seed } = serverInstance;

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
  });

  // 3. Batch Execution Ingestion Tests
  describe('POST /api/v1/test-plans/:planId/builds/:buildId/executions/batch', () => {
    it('processes batch of 1,000 execution results with high throughput in non-atomic mode', async () => {
      const { app, db, seed } = serverInstance;

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
      const totalInDb = await db.selectFrom('executions').select(db.fn.count('id').as('cnt')).where('build_id', '=', seed.buildId).executeTakeFirst();
      expect(Number(totalInDb?.cnt)).toBe(1000);
    });

    it('returns HTTP 207 Multi-Status in non-atomic mode when partial failures occur', async () => {
      const { app, seed } = serverInstance;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=false`,
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

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch?all_or_nothing=true`,
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
      expect(data.code).toBe('VALIDATION_FAILED');
      expect(data.invalid_params).toBeDefined();
    });
  });

  // 4. Locked Plan & Closed Build HTTP 422 RFC 7807 Problem Details Tests
  describe('HTTP 422 Problem Details Standards (PLAN_LOCKED, BUILD_CLOSED, CASE_VERSION_LOCKED)', () => {
    it('returns HTTP 422 PLAN_LOCKED problem details when test plan is locked', async () => {
      const { app, db, seed } = serverInstance;

      // Lock test plan
      await db.updateTable('test_plans').set({ status: 'LOCKED' }).where('id', '=', seed.planId).execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
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

      // Close build
      await db.updateTable('builds').set({ status: 'CLOSED' }).where('id', '=', seed.buildId).execute();

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/test-plans/${seed.planId}/builds/${seed.buildId}/executions/batch`,
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
      const { app, db } = serverInstance;

      // Find an approved version
      const ver = await db.selectFrom('test_case_versions').selectAll().where('status', '=', 'APPROVED').executeTakeFirst();
      expect(ver).toBeDefined();

      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/test-case-versions/${ver!.id}`,
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
