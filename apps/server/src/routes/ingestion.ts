import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable } from 'node:stream';
import { v4 as uuidv4 } from 'uuid';
import type { Kysely } from 'kysely';
import { CustomFieldRepository, TestCaseRepository, type Database } from '@testify/db';
import {
  SaxXmlParser,
  JsonSchemaParser,
  CsvParser,
  JUnitXmlParser,
  TestRailCsvParser,
  inferFieldType,
  collectImportFieldOptions,
  splitMultiSelectValue,
  MAX_DISTINCT_IMPORT_VALUES,
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
import { authenticateRequest, permissionsInProject } from '../middleware/auth.js';
import { isPublicError, publicErrorMessage, sendError } from '../errors.js';
import { requestOrigin } from '../audit.js';
import { emitImportCompleted, webhookActor } from '../services/webhookEvents.js';
import * as O from '../openapi/areas/other.js';

/**
 * Import size limits. An import file is held in memory while it's parsed (and its parsed tree
 * with it), so these bound how much one request -- and the server as a whole -- can take:
 *
 * - The web wizard uploads the file as multipart/form-data, which Fastify reads as a stream:
 *   up to IMPORT_MAX_FILE_BYTES, one file, small fields (registered in server.ts).
 * - A JSON body with `file_content` (scripts, tests) is buffered and parsed whole, and base64
 *   adds a third, so it's kept small: IMPORT_JSON_BODY_LIMIT_BYTES. Bigger files go multipart.
 * - At most MAX_CONCURRENT_IMPORTS imports (dry-run or execute) run at once per server; more
 *   get 429 IMPORT_BUSY. The slot is taken before the body is read, so a refused request never
 *   buffers its file.
 */
export const IMPORT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const IMPORT_JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
export const IMPORT_FIELD_LIMIT_BYTES = 1024 * 1024;
export const MAX_CONCURRENT_IMPORTS = 2;
const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Turns the body/multipart size errors into a message that says what to do. */
function sendImportTooLarge(reply: FastifyReply, err: any): boolean {
  const code = err?.code;
  if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
    sendError(reply, 413, code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? `A JSON import body can be at most ${mb(IMPORT_JSON_BODY_LIMIT_BYTES)}. Upload larger files as multipart/form-data (a "file" field), up to ${mb(IMPORT_MAX_FILE_BYTES)}.`
          : code === 'FST_REQ_FILE_TOO_LARGE'
            ? `The file is too large to import. The limit is ${mb(IMPORT_MAX_FILE_BYTES)}.`
            : 'Send one file per import.', { code: 'IMPORT_TOO_LARGE', max_file_bytes: IMPORT_MAX_FILE_BYTES });
    return true;
  }
  return false;
}

const PARSER_WARNING_MESSAGES: Record<string, string> = {
  UNSUPPORTED_TESTRAIL_COLUMN_FORMAT:
    "This file uses TestRail's indexed step-column export format (e.g. 'Steps (Step 1)'), which is not yet supported -- only the combined Steps/Expected Result column format is.",
  STEP_EXPECTED_MISALIGNED:
    'The Steps and Expected Result columns have a different number of lines for this case; step/expected pairing may be inaccurate.',
};

export async function registerIngestionRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  // Import slots (see MAX_CONCURRENT_IMPORTS). Taken in onRequest -- before the body is read --
  // and only for an authenticated caller, so anonymous requests can't hold them; given back
  // once when the response is sent or the client goes away.
  let importsRunning = 0;
  const holdsSlot = new WeakSet<FastifyRequest>();
  async function takeImportSlot(req: FastifyRequest, reply: FastifyReply) {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return reply;
    if (importsRunning >= MAX_CONCURRENT_IMPORTS) {
      return sendError(reply
        .header('Retry-After', '10'), 429, 'Other imports are running. Try again in a moment.', { code: 'IMPORT_BUSY' });
    }
    importsRunning++;
    holdsSlot.add(req);
  }
  async function releaseImportSlot(req: FastifyRequest) {
    if (holdsSlot.delete(req)) importsRunning--;
  }
  function importErrorHandler(err: any, _req: FastifyRequest, reply: FastifyReply) {
    if (!sendImportTooLarge(reply, err)) throw err;
  }
  // Helper to extract file buffer and configuration from request
  async function parseImportRequest(req: FastifyRequest) {
    let fileBuffer: Buffer | null = null;
    let filename = 'import_file';
    let format: string | undefined = undefined;
    let configuration: ImportConfiguration = {};

    if (req.isMultipart()) {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          if (fileBuffer) throw Object.assign(new Error('Send one file per import.'), { code: 'FST_FILES_LIMIT' });
          fileBuffer = await part.toBuffer();
          filename = part.filename;
        } else if (part.type === 'field') {
          if (part.fieldname === 'format') format = part.value as string;
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
      if (body.configuration) {
        configuration = typeof body.configuration === 'string' ? JSON.parse(body.configuration) : body.configuration;
      }
    }

    if (!fileBuffer) {
      throw new Error('No import file provided in request.');
    }

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

    return { fileBuffer, filename, selectedParser, configuration };
  }

  // POST /api/v1/projects/:projectId/imports/dry-run
  app.post('/api/v1/projects/:projectId/imports/dry-run', { schema: O.importDryRunSchema, bodyLimit: IMPORT_JSON_BODY_LIMIT_BYTES,
    onRequest: takeImportSlot,
    onResponse: releaseImportSlot,
    onRequestAbort: releaseImportSlot,
    // A JSON body over the limit fails before the handler runs; explain the limit instead of
    // Fastify's bare "body is too large". Anything else goes on to the app's error handler.
    errorHandler: importErrorHandler,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;

    try {
      const { fileBuffer, filename, selectedParser, configuration } = await parseImportRequest(req);
      // The project is in the address; authenticateRequest has already checked a token's project.
      const targetProjectId: string | null = (req.params as { projectId: string }).projectId;
      if (!targetProjectId) return;
      // Checked in the target project, so per-project roles and overrides apply (a multipart
      // upload's project field is only known once the body has been read).
      const importPerms = await permissionsInProject(user, targetProjectId, db);
      if (!importPerms.includes('IMPORT_DATA') && !importPerms.includes('SYSTEM_ADMIN')) {
        return sendError(reply, 403, 'Forbidden: Insufficient privileges', { required_permission: 'IMPORT_DATA' });
      }

      // Verify project exists
      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return sendError(reply, 404, `Project ID ${targetProjectId} not found`);
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

      function processSuite(suite: ParsedSuite, parentPath = ''): HierarchyPreviewNode {
        totalSuitesDetected++;
        const suitePath = parentPath ? `${parentPath} / ${suite.name}` : suite.name;
        suitesToCreate++;

        let suiteCasesCount = suite.test_cases.length;

        for (const tc of suite.test_cases) {
          totalCasesDetected++;
          // Identifies the case on every case-level warning below.
          const caseRef = {
            ...(tc.external_id ? { case_external_id: tc.external_id } : {}),
            case_title: tc.title,
            suite_path: suitePath,
          };

          // Check warnings
          if (tc.title.length >= 255) {
            warnings.push({
              line_or_node: `testcase[name='${tc.title.substring(0, 30)}...']`,
              code: 'TITLE_TRUNCATED',
              message: 'Title exceeds 255 characters; automatically trimmed.',
              ...caseRef,
            });
          }
          if (!tc.steps || tc.steps.length === 0) {
            warnings.push({
              line_or_node: `testcase[title='${tc.title}']`,
              code: 'EMPTY_STEPS',
              message: 'Test case contains no execution steps.',
              ...caseRef,
            });
          }
          for (const code of tc.parser_warnings || []) {
            warnings.push({
              line_or_node: `testcase[title='${tc.title}']`,
              code,
              message: PARSER_WARNING_MESSAGES[code] || code,
              ...caseRef,
            });
          }

          // Check unmapped custom fields -- collect up to 5 distinct samples per key so
          // inferFieldType() has something real to work with (a final pass below runs it
          // once the whole tree has been walked).
          for (const [cfKey, cfVal] of Object.entries(tc.custom_fields || {})) {
            const lowerKey = cfKey.toLowerCase();
            if (!existingCfNames.has(lowerKey) && !mappedIncomingKeys.has(lowerKey)) {
              if (!unmappedCfsMap.has(lowerKey)) {
                unmappedCfsMap.set(lowerKey, {
                  incoming_key: cfKey,
                  sample_value: String(cfVal || ''),
                  sample_values: [],
                  distinct_values: [],
                  distinct_values_truncated: false,
                  detected_type: 'TEXT',
                });
              }
              const field = unmappedCfsMap.get(lowerKey)!;
              const strVal = String(cfVal || '').trim();
              if (strVal && field.sample_values!.length < 5 && !field.sample_values!.includes(strVal)) {
                field.sample_values!.push(strVal);
              }
              // Every distinct value (capped) -- previews the options a new single-/multi-
              // select field would get. The real options are recomputed from the whole file
              // at execute time (collectImportFieldOptions), so the cap only limits the preview.
              if (strVal && !field.distinct_values!.includes(strVal)) {
                if (field.distinct_values!.length < MAX_DISTINCT_IMPORT_VALUES) field.distinct_values!.push(strVal);
                else field.distinct_values_truncated = true;
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
          childrenNodes.push(processSuite(sub, suitePath));
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
      // A problem with the file (too large, parse errors, missing file) is the user's to fix;
      // anything else is unexpected and answered by the global error handler.
      if (sendImportTooLarge(reply, err)) return;
      if (!isPublicError(err)) throw err;
      return sendError(reply, 400, err.message);
    }
  });

  // POST /api/v1/projects/:projectId/imports/execute
  app.post('/api/v1/projects/:projectId/imports/execute', { schema: O.importExecuteSchema, bodyLimit: IMPORT_JSON_BODY_LIMIT_BYTES,
    onRequest: takeImportSlot,
    onResponse: releaseImportSlot,
    onRequestAbort: releaseImportSlot,
    // A JSON body over the limit fails before the handler runs; explain the limit instead of
    // Fastify's bare "body is too large". Anything else goes on to the app's error handler.
    errorHandler: importErrorHandler,
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;

    const startTime = Date.now();
    try {
      const { fileBuffer, filename, selectedParser, configuration } = await parseImportRequest(req);
      // The project is in the address; authenticateRequest has already checked a token's project.
      const targetProjectId: string | null = (req.params as { projectId: string }).projectId;
      if (!targetProjectId) return;
      // Checked in the target project, so per-project roles and overrides apply (a multipart
      // upload's project field is only known once the body has been read).
      const importPerms = await permissionsInProject(user, targetProjectId, db);
      if (!importPerms.includes('IMPORT_DATA') && !importPerms.includes('SYSTEM_ADMIN')) {
        return sendError(reply, 403, 'Forbidden: Insufficient privileges', { required_permission: 'IMPORT_DATA' });
      }

      const project = await db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', targetProjectId)
        .executeTakeFirst();

      if (!project) {
        return sendError(reply, 404, `Project ID ${targetProjectId} not found`);
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

        // External ids for new cases. The project's id lock is held for the whole import, so
        // a case created at the same time (Spec mode, another import) can't take the same id.
        // A case without an id -- or whose id is already taken, e.g. a "create new" copy of a
        // duplicate -- gets the next PREFIX-n after the highest in the project, skipping ids
        // the file itself uses. (This used to be a random PREFIX-1000..9999, which clashed
        // often enough in a file of a few hundred unnumbered cases to fail the whole import.)
        const trxCases = new TestCaseRepository(trx);
        await trxCases.lockExternalIds(targetProjectId!);
        const idsInFile = new Set<string>();
        const collectIds = (suites: ParsedSuite[]) => {
          for (const su of suites) {
            for (const c of su.test_cases) if (c.external_id) idsInFile.add(c.external_id.toLowerCase());
            collectIds(su.sub_suites);
          }
        };
        collectIds(parsedSuites);
        const usedIds = new Set(
          (await trx.selectFrom('test_cases').select('external_id').where('project_id', '=', targetProjectId!).execute()).map((r) =>
            r.external_id.toLowerCase()
          )
        );
        const prefix = project!.prefix;
        let nextNumber = Number((await trxCases.getNextExternalId(targetProjectId!, prefix)).slice(prefix.length + 1));
        const externalIdFor = (wanted: string | undefined): string => {
          let id = wanted && !usedIds.has(wanted.toLowerCase()) ? wanted : '';
          while (!id) {
            const candidate = `${prefix}-${nextNumber++}`;
            if (!usedIds.has(candidate.toLowerCase()) && !idsInFile.has(candidate.toLowerCase())) id = candidate;
          }
          usedIds.add(id.toLowerCase());
          return id;
        };

        const existingCfs = await customFieldRepo.listVisibleToProject(targetProjectId!, 'TestCase');
        for (const cf of existingCfs) {
          customFieldIdMap.set(cf.name.toLowerCase(), cf.id);
        }

        for (const mapping of configuredMappings) {
          if (mapping.action === 'AUTO_CREATE') {
            const lower = mapping.incoming_key.toLowerCase();
            if (!customFieldIdMap.has(lower)) {
              try {
                const fieldType = mapping.field_type || 'TEXT';
                // A new single-/multi-select field gets one option per distinct value the
                // file holds for this column (multi-select splits comma-separated values).
                const options =
                  fieldType === 'SINGLE_SELECT' || fieldType === 'MULTI_SELECT'
                    ? collectImportFieldOptions(parsedSuites, mapping.incoming_key, fieldType).map((v) => ({
                        option_label: v,
                        option_value: v,
                      }))
                    : undefined;
                const created = await customFieldRepo.createDefinition({
                  project_id: targetProjectId!,
                  entity_type: 'TestCase',
                  name: mapping.incoming_key,
                  field_label: mapping.field_name || mapping.incoming_key,
                  field_type: fieldType,
                  ...(options ? { options } : {}),
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

        // Field types of every mapped definition, so a multi-select column's text can be split
        // into an array before validation (whether the field was just created or already existed).
        const fieldTypeByDefId = new Map(
          (await customFieldRepo.listVisibleToProject(targetProjectId!, 'TestCase')).map((d) => [d.id, d.field_type])
        );

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
              const extId = externalIdFor(tc.external_id);
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
                    const value =
                      fieldTypeByDefId.get(defId) === 'MULTI_SELECT' && typeof v === 'string'
                        ? splitMultiSelectValue(v)
                        : typeof v === 'string' && fieldTypeByDefId.get(defId) === 'SINGLE_SELECT'
                          ? v.trim()
                          : v;
                    await customFieldRepo.setValue(defId, 'TestCase', caseId, value, targetProjectId!);
                  } catch (err: any) {
                    skippedCustomFieldValuesCount++;
                    skippedCustomFieldValueWarnings.push({
                      case_external_id_or_title: tc.external_id || tc.title,
                      incoming_key: k,
                      reason: publicErrorMessage(err, 'Could not save this value', req),
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
            ...requestOrigin(req),
            created_at: new Date().toISOString(),
          })
          .execute();
      });

      const durationMs = Date.now() - startTime;
      await emitImportCompleted(db, webhookActor(user), targetProjectId!, selectedParser.formatId, {
        imported_suites_count: importedSuitesCount,
        imported_cases_count: importedCasesCount,
        created_versions_count: createdVersionsCount,
        overwritten_cases_count: overwrittenCasesCount,
        skipped_cases_count: skippedCasesCount,
      });
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
      // A problem with the file (too large, parse errors, missing file) is the user's to fix;
      // anything else is unexpected and answered by the global error handler.
      if (sendImportTooLarge(reply, err)) return;
      if (!isPublicError(err)) throw err;
      return sendError(reply, 400, err.message);
    }
  });

  // GET /api/v1/projects/:projectId/imports/custom-field-options -- lists the custom field definitions
  // (global ∪ the given project's own) visible for mapping an unmapped import column
  // against. Gated more permissively than /api/v1/admin/custom-fields: an importer needs
  // read access to the field catalog without needing full CUSTOM_FIELD_MANAGE rights.
  app.get('/api/v1/projects/:projectId/imports/custom-field-options', { schema: O.importFieldOptionsSchema }, async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(req, reply, db, jwtSecret);
    if (!user) return;
    if (
      !user.permissions.includes('IMPORT_DATA') &&
      !user.permissions.includes('CUSTOM_FIELD_MANAGE') &&
      !user.permissions.includes('SYSTEM_ADMIN')
    ) {
      return sendError(reply, 403, 'Forbidden: Insufficient privileges', { required_permission: 'IMPORT_DATA' });
    }

    const targetProjectId = (req.params as { projectId: string }).projectId;
    const { entity_type: entityTypeRaw } = req.query as { entity_type?: string };
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
