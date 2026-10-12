/**
 * Shared JSON schemas for the OpenAPI spec (`/docs/json`). Each one is registered with
 * `app.addSchema` and becomes `#/components/schemas/<$id>` in the spec; route schemas refer
 * to them as `{ $ref: '<$id>#' }`. Helpers at the bottom build the parts every route repeats
 * (wrapped items, error responses, `force`).
 *
 * Response schemas describe what the server sends; they never change it (see openapi/index.ts:
 * responses are serialized with plain JSON.stringify). In tests every response is checked
 * against them, with undocumented fields counted as mismatches.
 */

type Schema = Record<string, unknown>;

const str = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) });
const nullableStr = (description?: string): Schema => ({ type: ['string', 'null'], ...(description ? { description } : {}) });
const timestamp = (description = 'ISO 8601 date-time'): Schema => ({ type: 'string', description });

/**
 * A text field limited to `values`, with the values also written into its description:
 * Swagger UI's "Example Value" view shows only one of them, the "Schema" view all.
 */
export function oneOf(values: readonly string[], description?: string, nullable = false): Schema {
  const list = `One of: ${values.join(', ')}.`;
  return {
    type: nullable ? ['string', 'null'] : 'string',
    enum: nullable ? [...values, null] : [...values],
    description: description ? `${description} ${list}` : list,
  };
}

export const VERDICTS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'RETEST_REQUIRED', 'KNOWN_ISSUE'] as const;
export const STEP_VERDICTS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNTESTED'] as const;
export const RESULT_STATUSES = ['COMPLETED', 'IN_PROGRESS', 'ABORTED'] as const;
export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export const EXECUTION_TYPES = ['MANUAL', 'AUTOMATED'] as const;
export const VERSION_STATUSES = ['DRAFT', 'APPROVED', 'DEPRECATED'] as const;
export const PLAN_STATUSES = ['ACTIVE', 'LOCKED', 'ARCHIVED'] as const;
export const RUN_STATUSES = ['OPEN', 'CLOSED'] as const;
export const CUSTOM_FIELD_TYPES = ['TEXT', 'NUMBER', 'CHECKBOX', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT'] as const;

export const PERMISSIONS_LIST: Schema = {
  type: 'array',
  items: { type: 'string' },
  description: 'Permission keys, e.g. SPEC_VIEW, EXECUTE_RUN (RFC 04 §2). SYSTEM_ADMIN passes every check.',
};

export const SHARED_SCHEMAS: Schema[] = [
  {
    $id: 'Problem',
    type: 'object',
    description: 'Every error is RFC 7807 problem details (RFC 03 §4).',
    required: ['type', 'title', 'status', 'code', 'detail'],
    properties: {
      type: str('https://api.testify.dev/errors/{code}'),
      title: str('The HTTP status text'),
      status: { type: 'integer', description: 'The HTTP status' },
      code: str('Machine-readable error code, e.g. NOT_FOUND, RUN_CLOSED'),
      detail: str('What went wrong, meant for people'),
      instance: str('The request path'),
      timestamp: timestamp(),
      invalid_params: {
        type: 'array',
        description: 'One entry per problem field',
        items: {
          type: 'object',
          required: ['name', 'reason'],
          properties: { name: str('The field, e.g. steps[0].action'), reason: str() },
        },
      },
    },
    // Extension members (snake_case) vary by error: required_permission, project_ids,
    // request_id, ...
    additionalProperties: true,
  },
  {
    $id: 'User',
    type: 'object',
    description: 'The signed-in user (or, for an API token, the token).',
    required: ['id', 'username', 'email', 'global_role', 'permissions'],
    properties: {
      id: str(),
      username: str('For an API token: the token name'),
      email: str('Empty for an API token'),
      global_role: str('The global role, e.g. Admin, Tester; "ServiceAccount" for an API token'),
      permissions: { ...PERMISSIONS_LIST, description: 'Global permissions (for an API token: its capabilities, capped by its issuer)' },
      must_change_password: { type: 'boolean', description: 'Until changed (PATCH /auth/me), every other route answers 403 PASSWORD_CHANGE_REQUIRED' },
      session_id: str('The sign-in this request belongs to; absent for API tokens'),
      api_token: {
        type: 'object',
        description: 'Present only for an API token',
        required: ['id', 'project_id'],
        properties: { id: str(), project_id: str('The one project the token works in') },
      },
    },
  },
  {
    $id: 'Project',
    type: 'object',
    required: ['id', 'name', 'prefix', 'description', 'settings', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      name: str(),
      prefix: str('Prefix of every case id in the project, e.g. SHOP for SHOP-101'),
      description: nullableStr(),
      settings: str('JSON text, e.g. {"allow_draft_plan_linking":false}'),
      created_at: timestamp(),
      updated_at: timestamp(),
      permissions: { ...PERMISSIONS_LIST, description: 'In lists only: what the caller may do in this project (a project role can differ from the global one)' },
    },
  },
  {
    $id: 'Plan',
    type: 'object',
    required: ['id', 'project_id', 'name', 'description', 'status', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      project_id: str(),
      name: str(),
      description: nullableStr(),
      status: oneOf(PLAN_STATUSES, 'LOCKED and ARCHIVED plans take no new results and keep their pinned versions.'),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'Run',
    type: 'object',
    required: ['id', 'test_plan_id', 'name', 'description', 'status', 'release_date', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      test_plan_id: str(),
      name: str('Unique within its plan'),
      description: nullableStr(),
      status: oneOf(RUN_STATUSES, 'A CLOSED run takes no results. Runs close themselves the first time every case has a result.'),
      release_date: nullableStr('YYYY-MM-DD'),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'RecordedResult',
    type: 'object',
    required: ['id', 'test_run_id', 'test_plan_case_id', 'verdict', 'status', 'created_at'],
    properties: {
      id: str('The result id (test_result_id)'),
      test_run_id: str(),
      test_plan_case_id: str(),
      verdict: oneOf(VERDICTS),
      status: oneOf(RESULT_STATUSES),
      created_at: timestamp(),
    },
  },
  {
    $id: 'Suite',
    type: 'object',
    required: ['id', 'project_id', 'parent_suite_id', 'name', 'description', 'position', 'path', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      project_id: str(),
      parent_suite_id: nullableStr('null for a top-level suite'),
      name: str(),
      description: nullableStr(),
      position: { type: 'integer', description: 'Order among its siblings' },
      path: str('Ids from the top level down, e.g. /<id>/<id>'),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'SuiteNode',
    type: 'object',
    description: 'A suite with its sub-suites, and how many cases its whole subtree has (and how many of those are in the plan asked about)',
    required: ['id', 'project_id', 'parent_suite_id', 'name', 'description', 'position', 'path', 'created_at', 'updated_at', 'children', 'total_case_count', 'in_plan_count'],
    properties: {
      id: str(),
      project_id: str(),
      parent_suite_id: nullableStr(),
      name: str(),
      description: nullableStr(),
      position: { type: 'integer' },
      path: str(),
      created_at: timestamp(),
      updated_at: timestamp(),
      children: { type: 'array', items: { $ref: 'SuiteNode#' } },
      total_case_count: { type: 'integer' },
      in_plan_count: { type: 'integer', description: '0 without test_plan_id' },
    },
  },
  {
    $id: 'TestCase',
    type: 'object',
    description: "A case's unversioned fields; its content (summary, preconditions, steps) is in its versions.",
    required: ['id', 'project_id', 'test_suite_id', 'external_id', 'title', 'priority', 'execution_type', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      project_id: str(),
      test_suite_id: str(),
      external_id: str('The readable id, e.g. SHOP-101'),
      title: str(),
      priority: str(`Usually one of: ${PRIORITIES.join(', ')} (imports may have stored others).`),
      execution_type: str(`Usually one of: ${EXECUTION_TYPES.join(', ')}.`),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'Step',
    type: 'object',
    required: ['id', 'test_case_version_id', 'step_number', 'action', 'expected_result', 'execution_type', 'created_at', 'updated_at'],
    properties: {
      id: str('The step id (test_step_id in results)'),
      test_case_version_id: str(),
      step_number: { type: 'integer' },
      action: str(),
      expected_result: str(),
      execution_type: str(),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'Version',
    type: 'object',
    description: 'A version of a case: its content, editable only while DRAFT.',
    required: ['id', 'test_case_id', 'version_number', 'status', 'summary', 'preconditions', 'author_id', 'reviewer_id', 'created_at', 'updated_at', 'steps'],
    properties: {
      id: str('The version id (test_case_version_id)'),
      test_case_id: str(),
      version_number: { type: 'integer' },
      status: oneOf(VERSION_STATUSES),
      summary: nullableStr(),
      preconditions: nullableStr(),
      author_id: str(),
      reviewer_id: nullableStr('Who approved it'),
      created_at: timestamp(),
      updated_at: timestamp(),
      steps: { type: 'array', items: { $ref: 'Step#' } },
    },
  },
  {
    $id: 'PlanCase',
    type: 'object',
    description: "A case's link to a plan, pinned at a version (test_plan_case_id).",
    required: ['id', 'test_plan_id', 'test_case_id', 'test_case_version_id', 'position', 'created_at', 'updated_at', 'removed_at', 'removed_by'],
    properties: {
      id: str('test_plan_case_id'),
      test_plan_id: str(),
      test_case_id: str(),
      test_case_version_id: str('The pinned version'),
      position: { type: 'integer' },
      created_at: timestamp(),
      updated_at: timestamp(),
      removed_at: nullableStr('Set when a case with results was removed from the plan (its results stay)'),
      removed_by: nullableStr(),
    },
  },
  {
    $id: 'CustomFieldDefinition',
    type: 'object',
    required: ['id', 'project_id', 'entity_type', 'name', 'field_label', 'field_type', 'is_required', 'default_value', 'validation_regex', 'options', 'created_at', 'updated_at'],
    properties: {
      id: str('The definition id (definitionId)'),
      project_id: nullableStr('null for a global field (made in the Admin Panel); a project id for one made by an import'),
      entity_type: oneOf(['TestCase', 'TestSuite']),
      name: str(),
      field_label: str('Shown in the app'),
      field_type: oneOf(CUSTOM_FIELD_TYPES),
      is_required: { type: 'boolean' },
      default_value: nullableStr('As text; a MULTI_SELECT default is a JSON array'),
      validation_regex: nullableStr('TEXT fields: a JavaScript regular expression values must match'),
      options: {
        type: 'array',
        description: 'SINGLE_SELECT and MULTI_SELECT: the allowed values',
        items: {
          type: 'object',
          required: ['option_label', 'option_value'],
          properties: { id: str(), option_label: str(), option_value: str('What a value stores'), position: { type: 'integer' } },
        },
      },
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'CustomFieldValue',
    type: 'object',
    required: ['definition', 'value'],
    properties: {
      definition: { $ref: 'CustomFieldDefinition#' },
      value: {
        description:
          'Text for TEXT and SINGLE_SELECT, a number for NUMBER, true/false for CHECKBOX, YYYY-MM-DD for DATE, a list of option values for MULTI_SELECT; null when empty. Without a stored value, the field\'s default.',
      },
    },
  },
  {
    $id: 'AdminUser',
    type: 'object',
    description: 'A user as the Admin Panel sees them. The list has every field; other answers have the ones they changed.',
    required: ['id', 'username'],
    properties: {
      id: str(),
      username: str(),
      email: str(),
      status: oneOf(['ACTIVE', 'DISABLED']),
      locked_until: nullableStr('Set while sign-in is locked after too many wrong passwords'),
      global_role: str(),
      project_roles: {
        type: 'array',
        description: 'Roles that replace the global role in one project',
        items: { type: 'object', required: ['project_id', 'role'], properties: { project_id: str(), role: str() } },
      },
      permissions: { ...PERMISSIONS_LIST, description: 'Global permissions' },
      overrides: { type: 'array', items: { $ref: 'PermissionOverride#' }, description: 'Global permission overrides' },
      must_change_password: { type: 'boolean' },
      created_at: timestamp(),
    },
  },
  {
    $id: 'PermissionOverride',
    type: 'object',
    required: ['permission_key', 'is_granted'],
    properties: { permission_key: str(), is_granted: { type: 'boolean', description: 'true grants it, false takes it away, whatever the role says' } },
  },
  {
    $id: 'Role',
    type: 'object',
    required: ['id', 'name', 'description', 'is_system_role', 'permission_keys'],
    properties: {
      id: str(),
      name: str(),
      description: nullableStr(),
      is_system_role: { type: 'boolean', description: 'One of the built-in roles (still editable and deletable)' },
      permission_keys: PERMISSIONS_LIST,
    },
  },
  {
    $id: 'ApiToken',
    type: 'object',
    description: 'An API token, without its secret (shown only once, when created).',
    required: ['id', 'project_id', 'name', 'token_prefix', 'capabilities', 'created_by', 'expires_at', 'is_revoked', 'last_used_at', 'created_at'],
    properties: {
      id: str(),
      project_id: str('The one project it works in'),
      name: str(),
      token_prefix: str('The first characters after tf_ci_, to recognise it'),
      capabilities: { ...PERMISSIONS_LIST, description: 'What it was given' },
      created_by: str('The user who issued it'),
      expires_at: nullableStr(),
      is_revoked: { type: 'boolean' },
      last_used_at: nullableStr(),
      created_at: timestamp(),
      issued_by: nullableStr('List only: the issuer\'s username'),
      issuer_active: { type: 'boolean', description: 'List only: false when the issuer was disabled or lost API_TOKEN_MANAGE, which stops the token' },
      inactive_reason: oneOf(['ISSUER_DISABLED', 'ISSUER_LOST_ACCESS'], 'List only.', true),
      effective_capabilities: { ...PERMISSIONS_LIST, description: 'List only: what it can do now (capped by its issuer\'s current permissions)' },
    },
  },
  {
    $id: 'ReportSchedule',
    type: 'object',
    required: ['id', 'project_id', 'name', 'sections', 'recipients', 'message', 'frequency', 'weekday', 'time_of_day', 'timezone', 'only_when_new_run', 'enabled', 'next_run_at', 'last_run_at', 'last_status', 'last_error', 'last_sent_run_ids', 'created_by', 'created_at', 'updated_at'],
    properties: {
      id: str(),
      project_id: str(),
      name: str('Also the email subject'),
      sections: { type: 'array', items: { $ref: 'ScheduleSection#' } },
      recipients: { type: 'array', items: { type: 'string' } },
      message: nullableStr(),
      frequency: oneOf(['DAILY', 'WEEKLY']),
      weekday: { type: ['integer', 'null'], description: 'WEEKLY only: 0 = Sunday … 6 = Saturday' },
      time_of_day: str('HH:MM, in `timezone`'),
      timezone: str('IANA name, e.g. Europe/London'),
      only_when_new_run: { type: 'boolean', description: "Skip a send when no plan in it has a new run" },
      enabled: { type: 'boolean' },
      next_run_at: timestamp(),
      last_run_at: nullableStr(),
      last_status: oneOf(['SENT', 'CAPTURED', 'FAILED', 'SKIPPED'], 'CAPTURED: no mail server is set up, so it was kept, not sent.', true),
      last_error: nullableStr(),
      last_sent_run_ids: { type: 'array', items: { type: 'string' } },
      created_by: str(),
      created_at: timestamp(),
      updated_at: timestamp(),
    },
  },
  {
    $id: 'ScheduleSection',
    type: 'object',
    required: ['kind'],
    properties: {
      kind: oneOf(['overview', 'latest_run', 'test_health', 'plan_trend'], 'latest_run uses the plan\'s newest run when it is sent.'),
      test_plan_id: str('Every kind but overview'),
      filter: { type: 'object', description: 'Limit to cases, as in case search ({ q, filters })' },
    },
  },
  {
    $id: 'EmailSettings',
    type: 'object',
    required: ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'has_password', 'password_unreadable', 'can_store_password', 'from', 'public_url', 'delivery'],
    properties: {
      smtp_host: nullableStr(),
      smtp_port: { type: ['integer', 'null'] },
      smtp_secure: { type: 'boolean', description: 'TLS from the start (usually port 465)' },
      smtp_user: nullableStr(),
      has_password: { type: 'boolean', description: 'The password itself is never returned' },
      password_unreadable: { type: 'boolean', description: 'A password is stored but SECRETS_KEY changed or is missing: enter it again' },
      can_store_password: { type: 'boolean', description: 'false without SECRETS_KEY on a real database' },
      from: nullableStr(),
      public_url: nullableStr('Where links in emails point'),
      delivery: oneOf(['smtp', 'capture_only'], 'capture_only: no mail server, so emails are kept, not sent.'),
    },
  },
  {
    $id: 'ImportPreviewNode',
    type: 'object',
    description: 'A suite in an import preview, with what the import would do with it',
    required: ['name', 'action', 'cases_count', 'children'],
    properties: {
      name: str(),
      action: str('e.g. CREATE or MERGE'),
      cases_count: { type: 'integer' },
      children: { type: 'array', items: { $ref: 'ImportPreviewNode#' } },
    },
  },
  {
    $id: 'RunResult',
    type: 'object',
    description: 'A result recorded in a run, with its case, the version it was recorded against, who recorded it and its step results.',
    required: ['id', 'test_run_id', 'test_plan_case_id', 'test_case_id', 'external_id', 'title', 'test_case_version_id', 'version_number', 'verdict', 'status', 'duration_ms', 'notes', 'failure_message', 'stack_trace', 'environment', 'runner', 'source', 'tester_id', 'tested_by', 'executed_at', 'created_at', 'step_results'],
    properties: {
      id: str('The result id (test_result_id)'),
      test_run_id: str(),
      test_plan_case_id: str(),
      test_case_id: str(),
      external_id: str('The case\'s readable id, e.g. SHOP-101'),
      title: str("The case's current title"),
      test_case_version_id: str('The version the result was recorded against'),
      version_number: { type: ['integer', 'null'] },
      verdict: oneOf(VERDICTS),
      status: oneOf(RESULT_STATUSES),
      duration_ms: { type: ['integer', 'null'], description: 'Only CI results are timed; manual results are null.' },
      notes: nullableStr(),
      failure_message: nullableStr(),
      stack_trace: nullableStr(),
      environment: { type: ['object', 'null'], description: "CI results: the item's `environment_tags`, or `{ \"environment\": ... }` from the batch's `environment`" },
      runner: { type: ['object', 'null'], description: 'As sent in a CI batch' },
      source: { type: ['string', 'null'], description: 'UI (Execute mode, or one result through the API) or API (a CI batch)' },
      tester_id: str('A user id, or an API token id'),
      tested_by: str('The username, or "<name> (API token)"'),
      executed_at: timestamp(),
      created_at: timestamp(),
      step_results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['test_step_id', 'step_number', 'verdict', 'actual_result'],
          properties: { test_step_id: str(), step_number: { type: 'integer' }, verdict: oneOf(STEP_VERDICTS), actual_result: nullableStr() },
        },
      },
    },
  },
];

// ---- Helpers for route schemas ----

/** The properties of a shared schema, to build a variant of it (e.g. a case plus a summary of its latest version). */
export function sharedProperties(id: string): Record<string, Schema> {
  const shared = SHARED_SCHEMAS.find((s) => s.$id === id);
  if (!shared) throw new Error(`No shared schema ${id}`);
  return { ...(shared.properties as Record<string, Schema>) };
}

/** A shared schema's required fields. */
export function sharedRequired(id: string): string[] {
  return [...((SHARED_SCHEMAS.find((s) => s.$id === id)?.required as string[]) ?? [])];
}

/** A JSON response containing one item wrapped in its name, e.g. `{ "plan": { ... } }`. */
export function wrapped(key: string, ref: string, description: string): Schema {
  return { description, type: 'object', required: [key], properties: { [key]: { $ref: `${ref}#` } } };
}

/** A JSON response containing a list, e.g. `{ "plans": [ ... ] }`. */
export function list(key: string, ref: string, description: string): Schema {
  return { description, type: 'object', required: [key], properties: { [key]: { type: 'array', items: { $ref: `${ref}#` } } } };
}

/** 204: no body. */
export const NO_CONTENT: Schema = { description: 'Done; no body', type: 'null' };

const ERROR_TEXT: Record<number, string> = {
  400: 'Invalid request: `invalid_params` names each problem field. Also `PROJECTS_DIFFER` when ids belong to two projects.',
  401: 'Not signed in, or the sign-in has ended (`SESSION_ENDED`), or the API token is invalid, revoked or expired',
  403: 'Missing permission (`required_permission` names it), or an API token used on another project (`TOKEN_PROJECT_MISMATCH`) or on a system-wide route (`TOKEN_NOT_ALLOWED`)',
  404: 'Not found (or not in a project you can see)',
  409: 'Conflict: e.g. still contains things (retry with `?force=true`), or a name that is taken',
  413: 'Body too large',
  422: 'Not allowed in the current state, e.g. `RUN_CLOSED`, `PLAN_LOCKED`',
  429: 'Too many requests; `Retry-After` says how many seconds to wait',
};

/** Problem-details error responses for the given statuses, with default descriptions. */
export function errors(...statuses: Array<number | [number, string]>): Record<string, Schema> {
  const out: Record<string, Schema> = {};
  for (const s of statuses) {
    const [status, description] = Array.isArray(s) ? s : [s, ERROR_TEXT[s] ?? 'Error'];
    out[String(status)] = { description, content: { 'application/problem+json': { schema: { $ref: 'Problem#' } } } };
  }
  return out;
}

/** Errors every route that needs a sign-in can answer, plus whatever else it lists. */
export function authedErrors(...more: Array<number | [number, string]>): Record<string, Schema> {
  return errors(401, 403, 429, ...more);
}

/** `limit` and `cursor` for a paged list (merge into its querystring `properties`). */
export function pageQuery(defaultLimit: number, maxLimit: number): Record<string, Schema> {
  return {
    limit: { type: 'integer', minimum: 1, maximum: maxLimit, description: `Items per page: default ${defaultLimit}, at most ${maxLimit}.` },
    cursor: { type: 'string', description: "The previous page's `next_cursor`; leave out for the first page." },
  };
}

/** `next_cursor` in a paged list's response. */
export const NEXT_CURSOR: Schema = { type: ['string', 'null'], description: 'Pass as `cursor` for the next page; null on the last page.' };

/** `?force=true` for "delete anyway". */
export const FORCE_QUERY: Schema = {
  type: 'object',
  properties: { force: oneOf(['true', 'false'], 'true deletes it even when it still contains things (otherwise 409 names what would be lost).') },
};

export function idParams(...names: string[]): Schema {
  return {
    type: 'object',
    required: names,
    properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
  };
}

/**
 * Marks a request body schema as documentation only: the route's own validation
 * (e.g. services/resultValidation.ts) checks it and gives more specific errors, so the
 * schema validator lets it through.
 */
export function handlerValidated(schema: Schema): Schema {
  return { ...schema, 'x-validated-by-handler': true };
}
