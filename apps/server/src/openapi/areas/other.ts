import { REPORT_CATALOG } from '@testify/core';
import { authedErrors, wrapped, list, NO_CONTENT, idParams, oneOf, handlerValidated, PERMISSIONS_LIST, errors } from '../schemas.js';

/**
 * Route schemas for API tokens (routes/apiTokens.ts), reports (routes/reports.ts), report
 * email (routes/reportEmail.ts), import (routes/ingestion.ts), export (routes/exports.ts), the
 * health check (observability.ts) and the MCP endpoint (mcp/mcpServer.ts).
 */

const TOKENS = ['API tokens'];
const REPORTS = ['Reports'];
const REPORT_EMAIL = ['Report email'];
const IMPORT = ['Import'];
const EXPORT = ['Export'];
const OPS = ['Operations'];

// ---- API tokens ----

export const listTokensSchema = {
  tags: TOKENS,
  summary: "List a project's API tokens",
  description:
    "Every token in the project (revoked ones included), without secrets, with whether it still works and what it can do now. `issuer_capability_ceiling` is what you may give a new token. Needs `API_TOKEN_MANAGE`; not available to API tokens.",
  params: idParams('projectId'),
  response: {
    200: {
      description: 'The tokens',
      type: 'object',
      required: ['tokens', 'issuer_capability_ceiling'],
      properties: {
        tokens: { type: 'array', items: { $ref: 'ApiToken#' } },
        issuer_capability_ceiling: { ...PERMISSIONS_LIST, description: 'The capabilities you may give a token here' },
      },
    },
    ...authedErrors(404),
  },
};

export const createTokenSchema = {
  tags: TOKENS,
  summary: 'Create an API token',
  description:
    'A token for CI or scripts, bound to this project, sent as `Authorization: Bearer tf_ci_…`. The secret (`plaintext`) is in this response only. ' +
    "Capabilities can't exceed your own permissions here, and system-wide ones (SYSTEM_ADMIN, USER_MANAGE, CUSTOM_FIELD_MANAGE, PROJECT_CREATE, API_TOKEN_MANAGE) are never allowed. " +
    'The token works as long as you could still issue it: it stops if you are disabled or lose `API_TOKEN_MANAGE`. Needs `API_TOKEN_MANAGE`; not available to API tokens.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    required: ['name', 'capabilities'],
    properties: {
      name: { type: 'string', description: '1-255 characters' },
      capabilities: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'Permission keys, e.g. ["SPEC_VIEW", "EXECUTE_RUN"]' },
      expires_at: { type: ['string', 'null'], description: 'Optional ISO date in the future; none by default' },
    },
  }),
  response: {
    201: {
      description: 'Created',
      type: 'object',
      required: ['token', 'plaintext'],
      properties: { token: { $ref: 'ApiToken#' }, plaintext: { type: 'string', description: 'tf_ci_…: shown only now; store it as a secret' } },
    },
    ...authedErrors([400, 'A missing field, an unknown permission, or `CAPABILITY_NOT_GRANTABLE`'], [403, 'Missing permission, or `CAPABILITY_CEILING_EXCEEDED`'], 404),
  },
};

export const revokeTokenSchema = {
  tags: TOKENS,
  summary: 'Revoke an API token',
  description: 'It stops working at once. It stays in the list, marked revoked. Needs `API_TOKEN_MANAGE`; not available to API tokens.',
  params: idParams('tokenId'),
  response: { 204: NO_CONTENT, ...authedErrors(404) },
};

// ---- Reports ----

const reportIds = REPORT_CATALOG.map((r) => r.id);
const reportList = REPORT_CATALOG.map((r) => {
  const params = Object.keys(r.params.properties)
    .map((p) => (r.params.required.includes(p) ? `\`${p}\` (required)` : `\`${p}\``))
    .join(', ');
  return `- **${r.id}** (${r.formats.join(', ')}): ${r.title}. Params: ${params || 'none'}.`;
}).join('\n');

export const reportCatalogSchema = {
  tags: REPORTS,
  summary: 'The report catalog',
  description:
    'Every report: what it answers, its parameters as JSON Schema, and its formats; plus `definitions`, how every number (pass rate, flaky, ...) is worked out. Needs `SPEC_VIEW`.',
  params: idParams('projectId'),
  response: {
    200: {
      description: 'The catalog',
      type: 'object',
      required: ['reports', 'definitions'],
      properties: {
        reports: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'title', 'description', 'params', 'formats'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              description: { type: 'string' },
              params: { type: 'object', description: 'JSON Schema of the request body', additionalProperties: true },
              formats: { type: 'array', items: oneOf(['json', 'markdown', 'csv']) },
            },
          },
        },
        definitions: { type: 'object', additionalProperties: { type: 'string' }, description: 'Term → how it is worked out' },
      },
    },
    ...authedErrors(),
  },
};

export const runReportSchema = {
  tags: REPORTS,
  summary: 'Run a report',
  description:
    `The body is the report's parameters (the catalog has each one's JSON Schema). Most take \`filter\` ({ q, filters }, as in case search) to limit them to some cases. Needs \`SPEC_VIEW\`. See docs/reports_api_and_mcp.md for what each report contains.\n\n${reportList}`,
  params: {
    type: 'object',
    required: ['projectId', 'reportId'],
    properties: { projectId: { type: 'string' }, reportId: { type: 'string', description: `One of: ${reportIds.join(', ')}.` } },
  },
  querystring: { type: 'object', properties: { format: oneOf(['json', 'markdown', 'csv'], 'Default json; markdown and csv where the report offers them.') } },
  body: handlerValidated({ type: 'object', description: "The report's parameters (see the catalog)", additionalProperties: true }),
  response: {
    200: {
      description: 'The report: JSON (always with `report`, `generated_at` and `project`), or Markdown or CSV text',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['report', 'generated_at', 'project'],
            properties: {
              report: { type: 'string', description: 'The report id' },
              generated_at: { type: 'string' },
              project: { type: 'object', additionalProperties: true },
            },
            additionalProperties: true,
          },
        },
        'text/markdown': { schema: { type: 'string' } },
        'text/csv': { schema: { type: 'string' } },
      },
    },
    ...authedErrors([400, '`INVALID_PARAMS` (`invalid_params` names each), or `PROJECTS_DIFFER`'], [404, '`REPORT_NOT_FOUND`, `RUN_NOT_FOUND`, `PLAN_NOT_FOUND` or `CASE_NOT_FOUND`']),
  },
};

// ---- Report email ----

const sectionsBody = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  description: 'The reports to put in the email',
  items: {
    type: 'object',
    required: ['report_id'],
    properties: { report_id: { type: 'string', description: 'overview, run_summary, test_health, plan_trend or breakdown' }, params: { type: 'object', additionalProperties: true } },
  },
};
const recipients = {
  type: ['string', 'array'],
  items: { type: 'string' },
  description: 'Addresses, as a list or one text separated by commas or spaces; at most 50. Recipients need no account.',
};

export const sendReportEmailSchema = {
  tags: REPORT_EMAIL,
  summary: 'Email reports now',
  description:
    'Builds an email from one or more reports and sends it (or, with no mail server set up, captures it). With `preview: true` it returns the email without sending. Counts toward 60 emails an hour (previews don\'t). Needs `REPORT_EMAIL`.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    required: ['sections'],
    properties: { sections: sectionsBody, recipients, message: { type: ['string', 'null'], maxLength: 2000 }, preview: { type: 'boolean' } },
  }),
  response: {
    201: {
      description: 'Sent (or captured, or failed: see `status`)',
      type: 'object',
      required: ['email'],
      properties: {
        email: {
          type: 'object',
          required: ['status', 'error', 'subject', 'recipients'],
          properties: {
            status: oneOf(['SENT', 'CAPTURED', 'FAILED']),
            error: { type: ['string', 'null'] },
            subject: { type: 'string' },
            recipients: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
    200: {
      description: 'With `preview`: the email, not sent',
      type: 'object',
      required: ['subject', 'html'],
      properties: { subject: { type: 'string' }, html: { type: 'string' } },
    },
    ...authedErrors([400, '`INVALID_PARAMS` (`invalid_params` names the field), or a report parameter problem'], 404),
  },
};

const scheduleBody = handlerValidated({
  type: 'object',
  required: ['name', 'sections', 'recipients', 'frequency', 'time_of_day', 'timezone'],
  properties: {
    name: { type: 'string', description: 'Also the subject; at most 255 characters' },
    sections: { type: 'array', minItems: 1, items: { $ref: 'ScheduleSection#' } },
    recipients,
    message: { type: ['string', 'null'], maxLength: 2000 },
    frequency: oneOf(['DAILY', 'WEEKLY']),
    weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'WEEKLY: 0 = Sunday … 6 = Saturday' },
    time_of_day: { type: 'string', description: 'HH:MM' },
    timezone: { type: 'string', description: 'IANA name, e.g. Europe/London' },
    only_when_new_run: { type: 'boolean' },
    enabled: { type: 'boolean', description: 'Default true' },
  },
});

export const listSchedulesSchema = {
  tags: REPORT_EMAIL,
  summary: "List a project's scheduled report emails",
  description: 'Needs `REPORT_EMAIL`.',
  params: idParams('projectId'),
  response: { 200: list('schedules', 'ReportSchedule', 'The schedules'), ...authedErrors(404) },
};

export const createScheduleSchema = {
  tags: REPORT_EMAIL,
  summary: 'Schedule a report email',
  description: 'Sends the sections daily or weekly at `time_of_day` in `timezone`. Needs `REPORT_EMAIL`; the email stops if the person who made it loses that permission.',
  params: idParams('projectId'),
  body: scheduleBody,
  response: { 201: wrapped('schedule', 'ReportSchedule', 'Created'), ...authedErrors([400, '`INVALID_PARAMS`: `invalid_params` names the field'], 404) },
};

export const replaceScheduleSchema = {
  tags: REPORT_EMAIL,
  summary: 'Replace a scheduled report email',
  description:
    'Replaces the whole schedule (send every field, as when creating it); to add one recipient, send the current list plus the new address. Needs `REPORT_EMAIL`.',
  params: idParams('scheduleId'),
  body: scheduleBody,
  response: { 200: wrapped('schedule', 'ReportSchedule', 'Replaced'), ...authedErrors([400, '`INVALID_PARAMS`'], 404) },
};

export const deleteScheduleSchema = {
  tags: REPORT_EMAIL,
  summary: 'Delete a scheduled report email',
  description: 'Needs `REPORT_EMAIL`.',
  params: idParams('scheduleId'),
  response: { 204: NO_CONTENT, ...authedErrors(404) },
};

export const sendScheduleNowSchema = {
  tags: REPORT_EMAIL,
  summary: 'Send a scheduled report email now',
  description: 'Sends it once, now, without changing when it next goes out. Counts toward 60 emails an hour. Needs `REPORT_EMAIL`.',
  params: idParams('scheduleId'),
  response: {
    200: {
      description: 'What happened',
      type: 'object',
      required: ['status', 'error', 'email', 'schedule'],
      properties: {
        status: oneOf(['SENT', 'CAPTURED', 'FAILED', 'SKIPPED']),
        error: { type: ['string', 'null'] },
        email: { type: ['object', 'null'], required: ['status', 'subject'], properties: { status: { type: 'string' }, subject: { type: 'string' } } },
        schedule: { $ref: 'ReportSchedule#' },
      },
    },
    ...authedErrors(404),
  },
};

// ---- Import ----

const IMPORT_FORMATS = ['TESTLINK_XML', 'JUNIT_XML', 'NATIVE_JSON', 'STANDARD_CSV', 'TESTRAIL_CSV'];
const configuration = {
  description: 'JSON (as text in a multipart form): `{ field_mappings: [{ incoming_key, action: DROP | AUTO_CREATE | ROUTE_TO_EXISTING, field_type?, field_name?, target_field_id? }], duplicate_resolution: { default_action: VERSION_UP | OVERWRITE | CREATE_NEW | SKIP, overrides? } }` (RFC 03 §6.4)',
};
const importBody = {
  content: {
    'multipart/form-data': {
      schema: handlerValidated({
        type: 'object',
        required: ['file'],
        properties: {
          file: { type: 'string', format: 'binary', description: 'Up to 50 MB' },
          format: oneOf(IMPORT_FORMATS, 'Leave out to detect it (TESTRAIL_CSV must be given).'),
          configuration: { type: 'string', ...configuration },
        },
      }),
    },
    'application/json': {
      schema: handlerValidated({
        type: 'object',
        required: ['file_content'],
        properties: {
          file_content: { type: 'string', description: 'The file as text (or base64 with `is_base64`); bodies up to 5 MB, so use multipart for larger files' },
          is_base64: { type: 'boolean' },
          filename: { type: 'string' },
          format: oneOf(IMPORT_FORMATS, 'Leave out to detect it (TESTRAIL_CSV must be given).'),
          configuration: { type: 'object', ...configuration },
        },
      }),
    },
  },
};
const importErrors = authedErrors(
  [400, 'An unreadable file or configuration, or an unknown format'],
  404,
  [413, '`IMPORT_TOO_LARGE`'],
  [429, '`IMPORT_BUSY` (2 imports at a time), or a rate limit']
);

export const importDryRunSchema = {
  tags: IMPORT,
  summary: 'Preview an import',
  description:
    'Reads the file and says what an import would do, writing nothing: counts, warnings, the columns that are not custom fields yet (with an inferred type and their values) and the suite tree. Needs `IMPORT_DATA`.',
  params: idParams('projectId'),
  body: importBody,
  response: {
    200: {
      description: 'What would happen',
      type: 'object',
      required: ['dry_run_summary', 'warnings', 'unmapped_custom_fields', 'hierarchy_preview'],
      properties: {
        dry_run_summary: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Counts: suites and cases found, to create, to version up, to overwrite, skipped, unmapped fields, warnings' },
        warnings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['line_or_node', 'code', 'message'],
            properties: {
              line_or_node: { type: 'string' },
              code: { type: 'string', description: 'e.g. TITLE_TRUNCATED, EMPTY_STEPS' },
              message: { type: 'string' },
              case_external_id: { type: 'string' },
              case_title: { type: 'string' },
              suite_path: { type: 'string' },
            },
          },
        },
        unmapped_custom_fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['incoming_key', 'sample_value', 'detected_type'],
            properties: {
              incoming_key: { type: 'string' },
              sample_value: { type: 'string' },
              sample_values: { type: 'array', items: { type: 'string' } },
              distinct_values: { type: 'array', items: { type: 'string' }, description: 'Up to 200' },
              distinct_values_truncated: { type: 'boolean' },
              detected_type: { type: 'string', description: 'TEXT, NUMBER, CHECKBOX or DATE' },
            },
          },
        },
        hierarchy_preview: { type: 'array', items: { $ref: 'ImportPreviewNode#' } },
      },
    },
    ...importErrors,
  },
};

export const importExecuteSchema = {
  tags: IMPORT,
  summary: 'Import',
  description:
    'Imports the file (the same request as the preview) in one transaction: everything or nothing. A custom-field value that does not fit its field is skipped and listed rather than failing the import. Needs `IMPORT_DATA`.',
  params: idParams('projectId'),
  body: importBody,
  response: {
    200: {
      description: 'Imported',
      type: 'object',
      required: ['object', 'summary'],
      properties: {
        object: { type: 'string', enum: ['import_execute_result'] },
        summary: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Counts: suites and cases imported, versions created, cases overwritten and skipped, custom fields created, values skipped, duration_ms' },
        skipped_custom_field_value_warnings: {
          type: 'array',
          items: {
            type: 'object',
            required: ['case_external_id_or_title', 'incoming_key', 'reason'],
            properties: { case_external_id_or_title: { type: 'string' }, incoming_key: { type: 'string' }, reason: { type: 'string' } },
          },
        },
      },
    },
    ...importErrors,
  },
};

export const importFieldOptionsSchema = {
  tags: IMPORT,
  summary: 'Custom fields an import can map to',
  description: "Global fields and this project's own, for `ROUTE_TO_EXISTING`. Needs `IMPORT_DATA` (or `CUSTOM_FIELD_MANAGE`).",
  params: idParams('projectId'),
  querystring: { type: 'object', properties: { entity_type: oneOf(['TestCase', 'TestSuite'], 'Default TestCase.') } },
  response: {
    200: {
      description: 'The fields',
      type: 'object',
      required: ['definitions'],
      properties: {
        definitions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'name', 'field_label', 'field_type', 'project_id'],
            properties: { id: { type: 'string' }, name: { type: 'string' }, field_label: { type: 'string' }, field_type: { type: 'string' }, project_id: { type: ['string', 'null'] } },
          },
        },
      },
    },
    ...authedErrors(404),
  },
};

// ---- Export ----

const exportFile = (what: string) => ({
  description: `${what}, as a file download (\`Content-Disposition: attachment\`)`,
  content: {
    'application/json': { schema: { type: 'object', additionalProperties: true, description: 'NATIVE_JSON: the full export, re-importable' } },
    'text/csv': { schema: { type: 'string', description: 'STANDARD_CSV' } },
  },
});
const EXPORT_FORMAT = oneOf(['NATIVE_JSON', 'STANDARD_CSV'], 'Default NATIVE_JSON.');
const exportErrors = authedErrors([400, 'A missing field, or `PROJECTS_DIFFER`'], 404, [429, '`RATE_LIMITED`: 120 exports an hour']);

export const exportDefinitionsSchema = {
  tags: EXPORT,
  summary: 'Export suites and cases',
  description:
    'The whole project, one suite (with its sub-suites) or one plan (cases at their pinned versions), with steps and custom field values. A CSV export re-imports through the CSV importer. Counts toward 120 exports an hour. Needs `EXPORT_DATA`.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    properties: {
      format: EXPORT_FORMAT,
      scope: {
        type: 'object',
        required: ['type'],
        properties: {
          type: oneOf(['PROJECT', 'SUITE', 'PLAN']),
          test_suite_id: { type: 'string', description: 'With SUITE' },
          test_plan_id: { type: 'string', description: 'With PLAN' },
        },
      },
      status_filter: oneOf(['ALL', 'APPROVED_ONLY'], 'Default ALL.'),
    },
  }),
  response: { 200: exportFile('The definitions'), ...exportErrors },
};

export const exportResultsSchema = {
  tags: EXPORT,
  summary: "Export a run's results",
  description: 'Every result in the run, with step results, notes, errors and environment. Counts toward 120 exports an hour. Needs `EXPORT_DATA`.',
  params: idParams('projectId'),
  body: handlerValidated({ type: 'object', required: ['test_run_id'], properties: { format: EXPORT_FORMAT, test_run_id: { type: 'string' } } }),
  response: { 200: exportFile('The results'), ...exportErrors },
};

// ---- Operations ----

export const healthSchema = {
  tags: OPS,
  summary: 'Health check',
  description: 'For load balancers and uptime monitors. No sign-in. 200 while the server and its database answer, 503 otherwise.',
  security: [],
  response: {
    200: {
      description: 'Up',
      type: 'object',
      required: ['status', 'database', 'uptime_seconds'],
      properties: { status: oneOf(['ok']), database: oneOf(['ok']), uptime_seconds: { type: 'integer' } },
    },
    503: {
      description: 'The database does not answer',
      type: 'object',
      required: ['status', 'database', 'uptime_seconds'],
      properties: { status: oneOf(['unavailable']), database: oneOf(['unreachable']), uptime_seconds: { type: 'integer' } },
    },
  },
};

export const mcpSchema = {
  tags: OPS,
  summary: 'MCP endpoint for AI agents',
  description:
    'The Model Context Protocol (Streamable HTTP, stateless, JSON responses) for agents such as Claude: list projects and runs, search and read cases, and run every report. Every tool is read-only. ' +
    'Authenticate like the REST API (an API token with `SPEC_VIEW` is best). Requests are JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`); send `Accept: application/json, text/event-stream`. See docs/reports_api_and_mcp.md.',
  body: handlerValidated({
    type: 'object',
    required: ['jsonrpc', 'method'],
    properties: { jsonrpc: { type: 'string', enum: ['2.0'] }, id: { type: ['string', 'integer'] }, method: { type: 'string', description: 'e.g. tools/list, tools/call' }, params: { type: 'object', additionalProperties: true } },
  }),
  response: {
    200: { description: 'A JSON-RPC response (tool errors are inside it, as isError)', type: 'object', additionalProperties: true },
    ...errors(401, [403, '`PASSWORD_CHANGE_REQUIRED`'], 429),
  },
};

