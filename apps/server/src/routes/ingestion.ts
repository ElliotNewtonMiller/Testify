import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import { CustomFieldRepository, type Database } from '@testify/db';
import {
  SaxXmlParser,
  JsonSchemaParser,
  CsvParser,
  JUnitXmlParser,
  TestRailCsvParser,
  inferFieldType,
  type IFileParser,
  type ParsedSuite,
  type ParsedCase,
  type ImportConfiguration,
  type DryRunResult,
  type UnmappedCustomField,
  type DryRunWarning,
  type HierarchyPreviewNode,
  type SkippedCustomFieldValueWarning,
} from '@testify/core';
import { authenticateRequest, type AuthenticatedUser } from '../middleware/auth.js';
import { sendTokenProjectMismatchError } from '../errors.js';

// The web wizard sends the file base64-encoded inside a JSON body (~1.33x the file size).
// Fastify's default 1 MB body limit cut real TestLink exports off mid-upload -- the request
// was dropped with no response, which reached the browser as an empty 500. Sized to match
// the 100 MB multipart file limit in server.ts once base64 overhead is included.
const IMPORT_BODY_LIMIT_BYTES = 140 * 1024 * 1024;

/**
 * Resolves the project a request should import into, given the caller's identity and
 * whatever project id (if any) parseImportRequest found in the body/multipart fields.
 * A machine token's own bound project always wins (a mismatched body field is rejected
 * outright, closing the "token scoped to project A imports into project B" hole);
 * a human JWT caller must be explicit -- there is deliberately no fallback to an
 * arbitrary project anymore (see the removed fallback in parseImportRequest below).
 */
function resolveImportProjectId(
  user: AuthenticatedUser,
  bodyProjectId: string | undefined,
  reply: FastifyReply,
  instance: string
): string | null {
  if (user.api_token) {
    if (bodyProjectId && bodyProjectId !== user.api_token.project_id) {
      sendTokenProjectMismatchError(reply, user.api_token.project_id, bodyProjectId, instance);
      return null;
    }
    return user.api_token.project_id;
  }

  if (!bodyProjectId) {
    reply.status(400).send({ error: 'target_project_id is required' });
    return null;
  }
  return bodyProjectId;
}

const PARSER_WARNING_MESSAGES: Record<string, string> = {
  UNSUPPORTED_TESTRAIL_COLUMN_FORMAT:
    "This file uses TestRail's indexed step-column export format (e.g. 'Steps (Step 1)'), which is not yet supported -- only the combined Steps/Expected Result column format is.",
  STEP_EXPECTED_MISALIGNED:
    'The Steps and Expected Result columns have a different number of lines for this case; step/expected pairing may be inaccurate.',
};

export async function registerIngestionRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  // Helper to extract file buffer and configuration from request
  async function parseImportRequest(req: FastifyRequest) {
    let fileBuffer: Buffer | null = null;
    let filename = 'import_file';
    let format: string | undefined = undefined;
    let targetProjectId: string | undefined = undefined;
    let configuration: ImportConfiguration = {};

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          fileBuffer = await part.toBuffer();
          filename = part.filename;
        } else if (part.type === 'field') {
          if (part.fieldname === 'format') format = part.value as string;
          if (part.fieldname === 'target_project_id' || part.fieldname === 'project_id') {
            targetProjectId = part.value as string;
          }
          if (part.fieldname === 'configuration') {
            try {
              configuration = typeof part.value === 'string' ? JSON.parse(part.value) : (part.value as any);
            } catch (e) {
              // fallback
            }
          }
        }
      }
    } else {
      const body = (req.body as any) || {};
      if (body.file_content) {
        fileBuffer = Buffer.from(body.file_content, typeof body.file_content === 'string' && body.is_base64 ? 'base64' : 'utf-8');
      }
      filename = body.filename || 'import_file';
      format = body.format;
      targetProjectId = body.target_project_id || body.project_id;
      if (body.configuration) {
        configuration = typeof body.configuration === 'string' ? JSON.parse(body.configuration) : body.configuration;
      }
    }

    if (!fileBuffer) {
      throw new Error('No import file provided in request.');
    }

    // targetProjectId may be undefined here -- this is a pure parser now. Which project
    // to actually import into (and validating that a caller is allowed to use it) is
    // resolved by resolveImportProjectId() in each route handler below, since that
    // decision depends on the caller's authenticated identity (human vs. machine token),
    // not just on what the request body happened to contain.

    // Select parser. JUnitXmlParser must be checked before SaxXmlParser for auto-sniffing --
    // SaxXmlParser's broad <testsuite>/<testsuites> match would otherwise greedily claim
    // JUnit XML files too (explicit `format=` requests are unaffected by array order).
    // TestRailCsvParser.canHandle() always returns false, so it's only ever reachable via
    // an explicit `format` value.
    const parsers: IFileParser[] = [
      new JUnitXmlParser(),
      new SaxXmlParser(),
      new JsonSchemaParser(),
      new CsvParser(),
      new TestRailCsvParser(),
    ];
    let selectedParser: IFileParser | undefined;

    if (format) {
      selectedParser = parsers.find((p) => p.formatId === format.toUpperCase());
    }
    if (!selectedParser) {
      selectedParser = parsers.find((p) => p.canHandle(fileBuffer!, filename));
    }
    if (!selectedParser) {
      selectedParser = new SaxXmlParser(); // Default
    }

    return { fileBuffer, filename, selectedParser, targetProjectId, configuration };
  }

  // POST /api/v1/imports/dry-run
  app.post('/api/v1/imports/dry-run', { bodyLimit: IMPORT_BODY_LIMIT_BYTES }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;
    if (!user.permissions.includes('IMPORT_DATA') && !user.permissions.includes('SYSTEM_ADMIN')) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges', requiredPermission: 'IMPORT_DATA' });
    }

    try {
      const { fileBuffer, filename, selectedParser, targetProjectId: bodyProjectId, configuration } = await parseImportRequest(req);
      const targetProjectId = resolveImportProjectId(user, bodyProjectId, reply, req.url);
      if (!targetProjectId) return;

      // Verify project exists
      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return reply.status(404).send({ error: `Project ID ${targetProjectId} not found` });
      }

      // Fetch existing project + global custom field definitions, through the same
      // validated CustomFieldRepository the Admin Panel / Spec-mode already use -- this is
      // what makes an already-mapped field ("this column matches an existing field") mean
      // the same thing here as it does everywhere else in the app.
      const customFieldRepo = new CustomFieldRepository(db);
      const existingCfs = await customFieldRepo.listVisibleToProject(targetProjectId, 'TestCase');
      const existingCfNames = new Set(existingCfs.map((cf) => cf.name.toLowerCase()));

      // Fetch existing project test cases and suites
      const existingCases = await db
        .selectFrom('test_cases')
        .innerJoin('test_suites', 'test_suites.id', 'test_cases.test_suite_id')
        .select(['test_cases.id', 'test_cases.external_id', 'test_cases.title', 'test_suites.name as suite_name', 'test_suites.path'])
        .where('test_cases.project_id', '=', targetProjectId)
        .execute();

      const existingExternalIds = new Set(existingCases.map((c) => c.external_id.toLowerCase()));

      // Field mapping rules
      const configuredMappings = configuration.field_mappings || [];
      const mappedIncomingKeys = new Set(configuredMappings.map((m) => m.incoming_key.toLowerCase()));

      // Parse Stream
      const stream = Readable.from([fileBuffer]);
      const parsedSuites: ParsedSuite[] = [];
      for await (const suite of selectedParser.parseStream(stream)) {
        parsedSuites.push(suite);
      }

      // Inspection counters and data
      let totalSuitesDetected = 0;
      let totalCasesDetected = 0;
      let suitesToCreate = 0;
      let casesToCreate = 0;
      let casesToVersionUp = 0;
      let casesToOverwrite = 0;
      let casesSkipped = 0;

      const unmappedCfsMap = new Map<string, UnmappedCustomField>();
      const warnings: DryRunWarning[] = [];
      const hierarchyPreview: HierarchyPreviewNode[] = [];

      const dupConfig = configuration.duplicate_resolution || { default_action: 'VERSION_UP' };

      function processSuite(suite: ParsedSuite): HierarchyPreviewNode {
        totalSuitesDetected++;
        suitesToCreate++;

        let suiteCasesCount = suite.test_cases.length;

        for (const tc of suite.test_cases) {
          totalCasesDetected++;

          // Check warnings
          if (tc.title.length >= 255) {
            warnings.push({
              line_or_node: `testcase[name='${tc.title.substring(0, 30)}...']`,
              code: 'TITLE_TRUNCATED',
              message: 'Title exceeds 255 characters; automatically trimmed.',
            });
          }
          if (!tc.steps || tc.steps.length === 0) {
            warnings.push({
              line_or_node: `testcase[title='${tc.title}']`,
              code: 'EMPTY_STEPS',
              message: 'Test case contains no execution steps.',
            });
          }
          for (const code of tc.parser_warnings || []) {
            warnings.push({
              line_or_node: `testcase[title='${tc.title}']`,
              code,
              message: PARSER_WARNING_MESSAGES[code] || code,
            });
          }

          // Check unmapped custom fields -- collect up to 5 distinct samples per key so
          // inferFieldType() has something real to work with (a final pass below runs it
          // once the whole tree has been walked).
          for (const [cfKey, cfVal] of Object.entries(tc.custom_fields || {})) {
            const lowerKey = cfKey.toLowerCase();
            if (!existingCfNames.has(lowerKey) && !mappedIncomingKeys.has(lowerKey)) {
              if (!unmappedCfsMap.has(lowerKey)) {
                unmappedCfsMap.set(lowerKey, { incoming_key: cfKey, sample_value: String(cfVal || ''), sample_values: [], detected_type: 'TEXT' });
              }
              const field = unmappedCfsMap.get(lowerKey)!;
              const strVal = String(cfVal || '');
              if (strVal && field.sample_values!.length < 5 && !field.sample_values!.includes(strVal)) {
                field.sample_values!.push(strVal);
              }
            }
          }

          // Duplicate resolution checking
          const isDupByExtId = tc.external_id ? existingExternalIds.has(tc.external_id.toLowerCase()) : false;
          const isDupByTitle = existingCases.some(
            (ec) => ec.title.toLowerCase() === tc.title.toLowerCase() && ec.suite_name.toLowerCase() === suite.name.toLowerCase()
          );
          const isDuplicate = isDupByExtId || isDupByTitle;

          if (!isDuplicate) {
            casesToCreate++;
          } else {
            // Determine duplicate action
            let action = dupConfig.default_action || 'VERSION_UP';
            if (dupConfig.overrides && dupConfig.overrides.length > 0) {
              const override = dupConfig.overrides.find(
                (o) =>
                  (o.external_id && tc.external_id && o.external_id.toLowerCase() === tc.external_id.toLowerCase()) ||
                  (o.title && o.title.toLowerCase() === tc.title.toLowerCase())
              );
              if (override) action = override.action;
            }

            if (action === 'CREATE_NEW') casesToCreate++;
            else if (action === 'VERSION_UP') casesToVersionUp++;
            else if (action === 'OVERWRITE') casesToOverwrite++;
            else if (action === 'SKIP') casesSkipped++;
          }
        }

        const childrenNodes: HierarchyPreviewNode[] = [];
        for (const sub of suite.sub_suites || []) {
          childrenNodes.push(processSuite(sub));
        }

        return {
          name: suite.name,
          action: 'CREATE_NEW',
          cases_count: suiteCasesCount,
          children: childrenNodes,
        };
      }

      for (const suite of parsedSuites) {
        hierarchyPreview.push(processSuite(suite));
      }

      // Now that every case has been walked and samples collected, run real type
      // inference per unmapped field (replacing the previous hardcoded 'STRING'/'TEXT').
      for (const field of unmappedCfsMap.values()) {
        field.detected_type = inferFieldType(field.sample_values || []);
      }

      const result: DryRunResult = {
        dry_run_summary: {
          total_suites_detected: totalSuitesDetected,
          total_cases_detected: totalCasesDetected,
          suites_to_create: suitesToCreate,
          cases_to_create: casesToCreate,
          cases_to_version_up: casesToVersionUp,
          cases_to_overwrite: casesToOverwrite,
          cases_skipped: casesSkipped,
          unmapped_custom_fields_count: unmappedCfsMap.size,
          validation_warnings_count: warnings.length,
          auto_inferred_field_types_count: unmappedCfsMap.size,
        },
        warnings,
        unmapped_custom_fields: Array.from(unmappedCfsMap.values()),
        hierarchy_preview: hierarchyPreview,
      };

      return reply.status(200).send(result);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // POST /api/v1/imports/execute
  app.post('/api/v1/imports/execute', { bodyLimit: IMPORT_BODY_LIMIT_BYTES }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;
    if (!user.permissions.includes('IMPORT_DATA') && !user.permissions.includes('SYSTEM_ADMIN')) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges', requiredPermission: 'IMPORT_DATA' });
    }

    const startTime = Date.now();
    try {
      const { fileBuffer, filename, selectedParser, targetProjectId: bodyProjectId, configuration } = await parseImportRequest(req);
      const targetProjectId = resolveImportProjectId(user, bodyProjectId, reply, req.url);
      if (!targetProjectId) return;

      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return reply.status(404).send({ error: `Project ID ${targetProjectId} not found` });
      }

      const now = new Date().toISOString();

      // Parse file up front -- AUTO_CREATE mappings need a resolved field_type before the
      // transaction starts, but no re-walk of the tree happens here (the frontend wizard is
      // expected to have already resolved field_type from dry-run's detected_type before
      // sending this request).
      const stream = Readable.from([fileBuffer]);
      const parsedSuites: ParsedSuite[] = [];
      for await (const suite of selectedParser.parseStream(stream)) {
        parsedSuites.push(suite);
      }

      const dupConfig = configuration.duplicate_resolution || { default_action: 'VERSION_UP' };
      const configuredMappings = configuration.field_mappings || [];

      let importedSuitesCount = 0;
      let importedCasesCount = 0;
      let createdVersionsCount = 0;
      let overwrittenCasesCount = 0;
      let skippedCasesCount = 0;
      let autoCreatedCfCount = 0;
      let skippedCustomFieldValuesCount = 0;
      const skippedCustomFieldValueWarnings: SkippedCustomFieldValueWarning[] = [];

      // Everything from here through the audit log insert is one transaction -- a mid-loop
      // error now rolls back the whole import instead of leaving partial writes (previously
      // completely unwrapped).
      await db.transaction().execute(async (trx) => {
        const customFieldRepo = new CustomFieldRepository(trx);
        const customFieldIdMap = new Map<string, string>(); // incomingKey -> cfDefId

        const existingCfs = await customFieldRepo.listVisibleToProject(targetProjectId!, 'TestCase');
        for (const cf of existingCfs) {
          customFieldIdMap.set(cf.name.toLowerCase(), cf.id);
        }

        for (const mapping of configuredMappings) {
          if (mapping.action === 'AUTO_CREATE') {
            const lower = mapping.incoming_key.toLowerCase();
            if (!customFieldIdMap.has(lower)) {
              try {
                const created = await customFieldRepo.createDefinition({
                  project_id: targetProjectId!,
                  entity_type: 'TestCase',
                  name: mapping.incoming_key,
                  field_label: mapping.field_name || mapping.incoming_key,
                  field_type: mapping.field_type || 'TEXT',
                });
                customFieldIdMap.set(lower, created.id);
                autoCreatedCfCount++;
              } catch (err: any) {
                if (String(err.message).startsWith('FIELD_NAME_TAKEN')) {
                  // Someone already created it (e.g. a retried execute) -- reuse it rather
                  // than failing the whole import over an idempotent no-op.
                  const existing = (await customFieldRepo.listVisibleToProject(targetProjectId!, 'TestCase')).find(
                    (d) => d.name.toLowerCase() === lower
                  );
                  if (existing) customFieldIdMap.set(lower, existing.id);
                  else throw err;
                } else {
                  throw err;
                }
              }
            }
          } else if (mapping.action === 'ROUTE_TO_EXISTING' && mapping.target_field_id) {
            customFieldIdMap.set(mapping.incoming_key.toLowerCase(), mapping.target_field_id);
          }
        }

        // Recursive helper to import suites & cases
        async function importSuiteRecursive(suite: ParsedSuite, parentSuiteId: string | null, parentPath: string) {
          importedSuitesCount++;

          // Check if suite exists
          let existingSuite = await trx
            .selectFrom('test_suites')
            .selectAll()
            .where('project_id', '=', targetProjectId!)
            .where('name', '=', suite.name)
            .where('parent_suite_id', parentSuiteId ? '=' : 'is', parentSuiteId || null)
            .executeTakeFirst();

          let suiteId: string;
          let suitePath: string;

          if (existingSuite) {
            suiteId = existingSuite.id;
            suitePath = existingSuite.path;
          } else {
            suiteId = uuidv4();
            suitePath = parentPath ? `${parentPath}/${suiteId}` : `/${suiteId}`;
            await trx
              .insertInto('test_suites')
              .values({
                id: suiteId,
                project_id: targetProjectId!,
                parent_suite_id: parentSuiteId,
                name: suite.name,
                description: suite.details || null,
                position: suite.node_order || 0,
                path: suitePath,
                created_at: now,
                updated_at: now,
              })
              .execute();
          }

          // Import cases in suite
          for (const tc of suite.test_cases) {
            // Check for duplicate test case in project
            let existingCase = await trx
              .selectFrom('test_cases')
              .selectAll()
              .where('project_id', '=', targetProjectId!)
              .where((eb) => {
                const conds = [];
                if (tc.external_id) conds.push(eb('external_id', '=', tc.external_id));
                conds.push(eb.and([eb('title', '=', tc.title), eb('test_suite_id', '=', suiteId)]));
                return eb.or(conds);
              })
              .executeTakeFirst();

            let action = dupConfig.default_action || 'VERSION_UP';
            if (existingCase && dupConfig.overrides && dupConfig.overrides.length > 0) {
              const override = dupConfig.overrides.find(
                (o) =>
                  (o.external_id && tc.external_id && o.external_id.toLowerCase() === tc.external_id.toLowerCase()) ||
                  (o.title && o.title.toLowerCase() === tc.title.toLowerCase())
              );
              if (override) action = override.action;
            }

            if (existingCase && action === 'SKIP') {
              skippedCasesCount++;
              continue;
            }

            let caseId: string;
            let caseVersionId: string;
            let versionNumber = 1;

            if (!existingCase || action === 'CREATE_NEW') {
              caseId = uuidv4();
              const extId = tc.external_id || `${project!.prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
              const finalTitle = existingCase && action === 'CREATE_NEW' ? `${tc.title} (Copy)` : tc.title;

              await trx
                .insertInto('test_cases')
                .values({
                  id: caseId,
                  project_id: targetProjectId!,
                  test_suite_id: suiteId,
                  external_id: extId,
                  title: finalTitle,
                  priority: tc.importance || 'HIGH',
                  execution_type: tc.execution_type || 'MANUAL',
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              caseVersionId = uuidv4();
              versionNumber = 1;
              await trx
                .insertInto('test_case_versions')
                .values({
                  id: caseVersionId,
                  test_case_id: caseId,
                  version_number: versionNumber,
                  status: 'APPROVED',
                  summary: tc.summary || null,
                  preconditions: tc.preconditions || null,
                  author_id: 'usr_importer_01',
                  reviewer_id: 'usr_lead_01',
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              importedCasesCount++;
              createdVersionsCount++;
            } else if (action === 'VERSION_UP') {
              caseId = existingCase.id;

              // Find current max version
              const maxVerRow = await trx
                .selectFrom('test_case_versions')
                .select(trx.fn.max('version_number').as('max_ver'))
                .where('test_case_id', '=', caseId)
                .executeTakeFirst();

              versionNumber = Number(maxVerRow?.max_ver || 1) + 1;
              caseVersionId = uuidv4();

              await trx
                .insertInto('test_case_versions')
                .values({
                  id: caseVersionId,
                  test_case_id: caseId,
                  version_number: versionNumber,
                  status: 'APPROVED',
                  summary: tc.summary || null,
                  preconditions: tc.preconditions || null,
                  author_id: 'usr_importer_01',
                  reviewer_id: 'usr_lead_01',
                  created_at: now,
                  updated_at: now,
                })
                .execute();

              createdVersionsCount++;
            } else {
              // OVERWRITE: Update latest version
              caseId = existingCase.id;
              const latestVer = await trx
                .selectFrom('test_case_versions')
                .selectAll()
                .where('test_case_id', '=', caseId)
                .orderBy('version_number', 'desc')
                .executeTakeFirst();

              if (latestVer) {
                caseVersionId = latestVer.id;
                await trx
                  .updateTable('test_case_versions')
                  .set({
                    summary: tc.summary || latestVer.summary,
                    preconditions: tc.preconditions || latestVer.preconditions,
                    updated_at: now,
                  })
                  .where('id', '=', caseVersionId)
                  .execute();

                // Delete old steps to replace
                await trx.deleteFrom('test_steps').where('test_case_version_id', '=', caseVersionId).execute();
              } else {
                caseVersionId = uuidv4();
                await trx
                  .insertInto('test_case_versions')
                  .values({
                    id: caseVersionId,
                    test_case_id: caseId,
                    version_number: 1,
                    status: 'APPROVED',
                    summary: tc.summary || null,
                    preconditions: tc.preconditions || null,
                    author_id: 'usr_importer_01',
                    created_at: now,
                    updated_at: now,
                  })
                  .execute();
              }
              overwrittenCasesCount++;
            }

            // Insert test steps
            if (tc.steps && tc.steps.length > 0) {
              for (let sIdx = 0; sIdx < tc.steps.length; sIdx++) {
                const st = tc.steps[sIdx];
                await trx
                  .insertInto('test_steps')
                  .values({
                    id: uuidv4(),
                    test_case_version_id: caseVersionId,
                    step_number: st.step_number || sIdx + 1,
                    action: st.actions || '',
                    expected_result: st.expected_results || '',
                    execution_type: st.execution_type || 'MANUAL',
                    created_at: now,
                    updated_at: now,
                  })
                  .execute();
              }
            }

            // Write custom field values through the same validated CustomFieldRepository
            // path admin-managed fields use, entity_id = the case's own id (not the
            // version id) so values are never version-locked, matching every other
            // Spec-mode custom field value in this app. A value that fails validation
            // (e.g. doesn't match a SINGLE_SELECT's configured options) is skipped and
            // reported rather than aborting the whole import.
            if (tc.custom_fields) {
              for (const [k, v] of Object.entries(tc.custom_fields)) {
                const defId = customFieldIdMap.get(k.toLowerCase());
                if (defId && v) {
                  try {
                    await customFieldRepo.setValue(defId, 'TestCase', caseId, v, targetProjectId!);
                  } catch (err: any) {
                    skippedCustomFieldValuesCount++;
                    skippedCustomFieldValueWarnings.push({
                      case_external_id_or_title: tc.external_id || tc.title,
                      incoming_key: k,
                      reason: err.message || 'Validation failed',
                    });
                  }
                }
              }
            }
          }

          // Sub suites
          for (const sub of suite.sub_suites || []) {
            await importSuiteRecursive(sub, suiteId, suitePath);
          }
        }

        for (const rootSuite of parsedSuites) {
          await importSuiteRecursive(rootSuite, null, '');
        }

        const durationMs = Date.now() - startTime;
        const summary = {
          imported_suites_count: importedSuitesCount,
          imported_cases_count: importedCasesCount,
          created_versions_count: createdVersionsCount,
          overwritten_cases_count: overwrittenCasesCount,
          skipped_cases_count: skippedCasesCount,
          auto_created_custom_fields_count: autoCreatedCfCount,
          skipped_custom_field_values_count: skippedCustomFieldValuesCount,
          duration_ms: durationMs,
        };

        await trx
          .insertInto('audit_logs')
          .values({
            id: uuidv4(),
            actor_id: user.id,
            actor_type: user.api_token ? 'SERVICE_ACCOUNT' : 'USER',
            action: 'IMPORT_EXECUTED',
            resource_type: 'project',
            resource_id: targetProjectId!,
            project_id: targetProjectId!,
            diff: JSON.stringify(summary),
            ip_address: '127.0.0.1',
            user_agent: 'TestifyIngestionService',
            created_at: new Date().toISOString(),
          })
          .execute();
      });

      const durationMs = Date.now() - startTime;
      return reply.status(200).send({
        object: 'import_execute_result',
        summary: {
          imported_suites_count: importedSuitesCount,
          imported_cases_count: importedCasesCount,
          created_versions_count: createdVersionsCount,
          overwritten_cases_count: overwrittenCasesCount,
          skipped_cases_count: skippedCasesCount,
          auto_created_custom_fields_count: autoCreatedCfCount,
          skipped_custom_field_values_count: skippedCustomFieldValuesCount,
          duration_ms: durationMs,
        },
        ...(skippedCustomFieldValueWarnings.length > 0
          ? { skipped_custom_field_value_warnings: skippedCustomFieldValueWarnings }
          : {}),
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  // GET /api/v1/imports/custom-field-options -- lists the custom field definitions
  // (global ∪ the given project's own) visible for mapping an unmapped import column
  // against. Gated more permissively than /api/v1/admin/custom-fields: an importer needs
  // read access to the field catalog without needing full CUSTOM_FIELD_MANAGE rights.
  app.get('/api/v1/imports/custom-field-options', async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;
    if (
      !user.permissions.includes('IMPORT_DATA') &&
      !user.permissions.includes('CUSTOM_FIELD_MANAGE') &&
      !user.permissions.includes('SYSTEM_ADMIN')
    ) {
      return reply.status(403).send({ error: 'Forbidden: Insufficient privileges', requiredPermission: 'IMPORT_DATA' });
    }

    const { target_project_id: targetProjectId, entity_type: entityTypeRaw } = req.query as {
      target_project_id?: string;
      entity_type?: string;
    };
    if (!targetProjectId) {
      return reply.status(400).send({ error: 'target_project_id is required' });
    }
    const entityType = entityTypeRaw === 'TestSuite' ? 'TestSuite' : 'TestCase';

    const customFieldRepo = new CustomFieldRepository(db);
    const definitions = await customFieldRepo.listVisibleToProject(targetProjectId, entityType);
    return reply.status(200).send({
      definitions: definitions.map((d) => ({
        id: d.id,
        name: d.name,
        field_label: d.field_label,
        field_type: d.field_type,
        project_id: d.project_id,
      })),
    });
  });
}
