import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import {
  SaxXmlParser,
  JsonSchemaParser,
  CsvParser,
  type IFileParser,
  type ParsedSuite,
  type ParsedCase,
  type ImportConfiguration,
  type DryRunResult,
  type UnmappedCustomField,
  type DryRunWarning,
  type HierarchyPreviewNode,
} from '@testify/core';

export async function registerIngestionRoutes(app: FastifyInstance, db: Kysely<Database>) {
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

    if (!targetProjectId) {
      // Fallback: pick first project from DB
      const proj = await db.selectFrom('projects').select('id').executeTakeFirst();
      if (!proj) throw new Error('No target project found.');
      targetProjectId = proj.id;
    }

    // Select parser
    const parsers: IFileParser[] = [new SaxXmlParser(), new JsonSchemaParser(), new CsvParser()];
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
  app.post('/api/v1/imports/dry-run', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { fileBuffer, filename, selectedParser, targetProjectId, configuration } = await parseImportRequest(req);

      // Verify project exists
      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return reply.status(404).send({ error: `Project ID ${targetProjectId} not found` });
      }

      // Fetch existing project custom field definitions
      const existingCfs = await db
        .selectFrom('custom_field_definitions')
        .selectAll()
        .where((eb) => eb.or([eb('project_id', '=', targetProjectId), eb('project_id', 'is', null)]))
        .execute();

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

          // Check unmapped custom fields
          for (const [cfKey, cfVal] of Object.entries(tc.custom_fields || {})) {
            const lowerKey = cfKey.toLowerCase();
            if (!existingCfNames.has(lowerKey) && !mappedIncomingKeys.has(lowerKey)) {
              if (!unmappedCfsMap.has(lowerKey)) {
                unmappedCfsMap.set(lowerKey, {
                  incoming_key: cfKey,
                  sample_value: String(cfVal || ''),
                  detected_type: 'STRING',
                });
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
  app.post('/api/v1/imports/execute', async (req: FastifyRequest, reply: FastifyReply) => {
    const startTime = Date.now();
    try {
      const { fileBuffer, filename, selectedParser, targetProjectId, configuration } = await parseImportRequest(req);

      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return reply.status(404).send({ error: `Project ID ${targetProjectId} not found` });
      }

      const now = new Date().toISOString();

      // 1. Process custom field auto-creation
      let autoCreatedCfCount = 0;
      const configuredMappings = configuration.field_mappings || [];
      const customFieldIdMap = new Map<string, string>(); // incomingKey -> cfDefId

      // Load existing CFs
      const existingCfs = await db
        .selectFrom('custom_field_definitions')
        .selectAll()
        .where((eb) => eb.or([eb('project_id', '=', targetProjectId), eb('project_id', 'is', null)]))
        .execute();

      for (const cf of existingCfs) {
        customFieldIdMap.set(cf.name.toLowerCase(), cf.id);
      }

      for (const mapping of configuredMappings) {
        if (mapping.action === 'AUTO_CREATE') {
          const lower = mapping.incoming_key.toLowerCase();
          if (!customFieldIdMap.has(lower)) {
            const newCfId = uuidv4();
            await db
              .insertInto('custom_field_definitions')
              .values({
                id: newCfId,
                project_id: targetProjectId,
                entity_type: 'TestCaseVersion',
                name: mapping.incoming_key,
                field_label: mapping.field_name || mapping.incoming_key,
                field_type: mapping.field_type || 'STRING',
                is_required: 0,
                default_value: null,
                validation_regex: null,
                created_at: now,
                updated_at: now,
              })
              .execute();
            customFieldIdMap.set(lower, newCfId);
            autoCreatedCfCount++;
          }
        } else if (mapping.action === 'ROUTE_TO_EXISTING' && mapping.target_field_id) {
          customFieldIdMap.set(mapping.incoming_key.toLowerCase(), mapping.target_field_id);
        }
      }

      // Parse file
      const stream = Readable.from([fileBuffer]);
      const parsedSuites: ParsedSuite[] = [];
      for await (const suite of selectedParser.parseStream(stream)) {
        parsedSuites.push(suite);
      }

      const dupConfig = configuration.duplicate_resolution || { default_action: 'VERSION_UP' };

      let importedSuitesCount = 0;
      let importedCasesCount = 0;
      let createdVersionsCount = 0;
      let overwrittenCasesCount = 0;
      let skippedCasesCount = 0;

      // Recursive helper to import suites & cases
      async function importSuiteRecursive(suite: ParsedSuite, parentSuiteId: string | null, parentPath: string) {
        importedSuitesCount++;

        // Check if suite exists
        let existingSuite = await db
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
          await db
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
          let existingCase = await db
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

            await db
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
            await db
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
            const maxVerRow = await db
              .selectFrom('test_case_versions')
              .select(db.fn.max('version_number').as('max_ver'))
              .where('test_case_id', '=', caseId)
              .executeTakeFirst();

            versionNumber = Number(maxVerRow?.max_ver || 1) + 1;
            caseVersionId = uuidv4();

            await db
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
            const latestVer = await db
              .selectFrom('test_case_versions')
              .selectAll()
              .where('test_case_id', '=', caseId)
              .orderBy('version_number', 'desc')
              .executeTakeFirst();

            if (latestVer) {
              caseVersionId = latestVer.id;
              await db
                .updateTable('test_case_versions')
                .set({
                  summary: tc.summary || latestVer.summary,
                  preconditions: tc.preconditions || latestVer.preconditions,
                  updated_at: now,
                })
                .where('id', '=', caseVersionId)
                .execute();

              // Delete old steps to replace
              await db.deleteFrom('test_steps').where('test_case_version_id', '=', caseVersionId).execute();
            } else {
              caseVersionId = uuidv4();
              await db
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
              await db
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

          // Insert custom field values
          if (tc.custom_fields) {
            for (const [k, v] of Object.entries(tc.custom_fields)) {
              const defId = customFieldIdMap.get(k.toLowerCase());
              if (defId && v) {
                await db
                  .insertInto('custom_field_values')
                  .values({
                    id: uuidv4(),
                    custom_field_definition_id: defId,
                    entity_type: 'TestCaseVersion',
                    entity_id: caseVersionId,
                    string_value: String(v),
                    number_value: null,
                    boolean_value: null,
                    date_value: null,
                    json_value: null,
                    created_at: now,
                    updated_at: now,
                  })
                  .execute();
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
      return reply.status(200).send({
        object: 'import_execute_result',
        summary: {
          imported_suites_count: importedSuitesCount,
          imported_cases_count: importedCasesCount,
          created_versions_count: createdVersionsCount,
          overwritten_cases_count: overwrittenCasesCount,
          skipped_cases_count: skippedCasesCount,
          auto_created_custom_fields_count: autoCreatedCfCount,
          duration_ms: durationMs,
        },
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });
}
