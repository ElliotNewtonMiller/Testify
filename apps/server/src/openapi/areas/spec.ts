import {
  authedErrors,
  wrapped,
  NO_CONTENT,
  FORCE_QUERY,
  idParams,
  handlerValidated,
  oneOf,
  list,
  PRIORITIES,
  EXECUTION_TYPES,
  VERDICTS,
} from '../schemas.js';

/**
 * Route schemas for the specification and plan membership: routes/specEditing.ts,
 * routes/testPlanCases.ts, the value routes in routes/customFields.ts and routes/caseSearch.ts.
 */

const SPEC = ['Specification'];
const VERSIONS = ['Versions'];
const FIELDS = ['Custom field values'];
const SEARCH = ['Search'];
const PLANS = ['Plans'];

const nullableText = { type: ['string', 'null'] };
const NAME_400: [number, string] = [400, '`INVALID_NAME` (blank, not text, or over 255 characters), or an id from elsewhere'];

// ---- Spec tree ----

const specTreeCase = {
  type: 'object',
  required: ['id', 'external_id', 'title', 'priority', 'execution_type', 'test_suite_id', 'latest_version', 'in_plan', 'test_plan_case_id', 'pinned_test_case_version_id', 'is_pinned_version_stale', 'linkable'],
  properties: {
    id: { type: 'string', description: 'The case id (test_case_id)' },
    external_id: { type: 'string' },
    title: { type: 'string' },
    priority: { type: 'string' },
    execution_type: { type: 'string' },
    test_suite_id: { type: 'string' },
    latest_version: {
      type: ['object', 'null'],
      required: ['id', 'version_number', 'status', 'summary', 'preconditions', 'updated_at'],
      properties: {
        id: { type: 'string' },
        version_number: { type: 'integer' },
        status: { type: 'string' },
        summary: nullableText,
        preconditions: nullableText,
        updated_at: { type: 'string' },
      },
    },
    in_plan: { type: 'boolean', description: 'In the plan given as test_plan_id' },
    test_plan_case_id: { ...nullableText, description: "The case's link to that plan" },
    pinned_test_case_version_id: { ...nullableText, description: 'The version the plan runs' },
    is_pinned_version_stale: { type: 'boolean', description: 'The plan runs an older version than the latest' },
    linkable: { type: 'boolean', description: 'Can be added to a plan (approved, or drafts allowed in this project)' },
  },
};

export const specTreeSchema = {
  tags: SPEC,
  summary: "A project's suites and cases",
  description:
    'The whole suite tree and every case (without steps; see `GET /api/v1/cases/{caseId}/versions/latest`), in one request. With `test_plan_id`, each case says whether it is in that plan. ' +
    'Cases whose latest version is DEPRECATED are left out unless `include_deprecated=true`. Needs `SPEC_VIEW`; with only `EXECUTE_RUN`, you see just the plan\'s cases and their suites.',
  params: idParams('projectId'),
  querystring: {
    type: 'object',
    properties: {
      test_plan_id: { type: 'string', description: 'Mark which cases are in this plan' },
      include_deprecated: oneOf(['true', 'false', '1', '0'], 'Include deprecated cases.'),
    },
  },
  response: {
    200: {
      description: 'The tree',
      type: 'object',
      required: ['project', 'suites', 'cases'],
      properties: {
        project: {
          type: 'object',
          required: ['id', 'name', 'prefix', 'settings'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            prefix: { type: 'string' },
            settings: {
              type: 'object',
              required: ['allow_draft_plan_linking'],
              properties: { allow_draft_plan_linking: { type: 'boolean', description: 'Drafts may be added to plans' } },
            },
          },
        },
        suites: { type: 'array', items: { $ref: 'SuiteNode#' }, description: 'Top-level suites, each with its children' },
        cases: { type: 'array', items: specTreeCase },
      },
    },
    ...authedErrors([400, '`PROJECTS_DIFFER`: the plan belongs to another project'], 404),
  },
};

// ---- Suites ----

const suiteFields = {
  name: { type: 'string', description: 'Trimmed; 1-255 characters' },
  description: nullableText,
  parent_suite_id: { ...nullableText, description: 'The suite to put it in; null or left out for the top level' },
  position: { type: 'integer', description: 'Order among its siblings' },
};

export const createSuiteSchema = {
  tags: SPEC,
  summary: 'Create a suite',
  description: 'Needs `SPEC_CREATE`.',
  params: idParams('projectId'),
  body: handlerValidated({ type: 'object', required: ['name'], properties: suiteFields }),
  response: { 201: wrapped('suite', 'Suite', 'Created'), ...authedErrors(NAME_400, 404) },
};

export const updateSuiteSchema = {
  tags: SPEC,
  summary: 'Change or move a suite',
  description: 'Changes only the fields sent. A new `parent_suite_id` moves it (and everything in it); `null` moves it to the top level. Needs `SPEC_EDIT`.',
  params: idParams('suiteId'),
  body: handlerValidated({ type: 'object', properties: suiteFields }),
  response: { 200: wrapped('suite', 'Suite', 'Changed'), ...authedErrors([400, '`INVALID_NAME`, or a move into itself or its own sub-suite'], 404) },
};

export const deleteSuiteSchema = {
  tags: SPEC,
  summary: 'Delete a suite',
  description:
    'Needs `SPEC_DELETE`. A suite with sub-suites, cases, plan links or results answers 409 `SUITE_IN_USE`; `?force=true` deletes it with everything in it, results included.',
  params: idParams('suiteId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`SUITE_IN_USE`: it still contains things']) },
};

// ---- Cases ----

const stepInput = {
  type: 'object',
  properties: {
    step_number: { type: 'integer', minimum: 1, description: 'Optional: steps without one are numbered in order. Unique within the case.' },
    action: { type: 'string', maxLength: 20000, description: 'Missing means empty' },
    expected_result: { type: 'string', maxLength: 20000, description: 'Missing means empty' },
    execution_type: oneOf(EXECUTION_TYPES),
  },
};
const stepsInput = { type: 'array', maxItems: 500, items: stepInput, description: 'Up to 500 steps. Ids are assigned by the server.' };

export const createCaseSchema = {
  tags: SPEC,
  summary: 'Create a test case',
  description:
    'Creates the case and its version 1. The readable id (PREFIX-n) is assigned by the server. The version starts DRAFT, or APPROVED when you hold `SPEC_AUTO_APPROVE` and no required custom field is left empty. Needs `SPEC_CREATE`.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    required: ['test_suite_id', 'title'],
    properties: {
      test_suite_id: { type: 'string' },
      title: { type: 'string', description: 'Trimmed; 1-255 characters' },
      priority: oneOf(PRIORITIES, 'Default MEDIUM.'),
      execution_type: oneOf(EXECUTION_TYPES, 'Default MANUAL.'),
      summary: nullableText,
      preconditions: nullableText,
      steps: stepsInput,
    },
  }),
  response: {
    201: {
      description: 'Created',
      type: 'object',
      required: ['test_case', 'version'],
      properties: { test_case: { $ref: 'TestCase#' }, version: { $ref: 'Version#' } },
    },
    ...authedErrors([400, '`INVALID_NAME`, `INVALID_STEPS` or `INVALID_REQUEST` (`invalid_params` names each problem), or a suite from elsewhere'], 404),
  },
};

export const updateCaseSchema = {
  tags: SPEC,
  summary: 'Change or move a test case',
  description:
    "Changes only the fields sent; these aren't versioned, so they can change at any time. A new `test_suite_id` moves the case. Content (summary, preconditions, steps) is changed on a draft version: `POST /api/v1/cases/{caseId}/versions`, then `PATCH /api/v1/versions/{versionId}`. Needs `SPEC_EDIT`.",
  params: idParams('caseId'),
  body: handlerValidated({
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Trimmed; 1-255 characters' },
      priority: oneOf(PRIORITIES),
      execution_type: oneOf(EXECUTION_TYPES),
      test_suite_id: { type: 'string' },
    },
  }),
  response: { 200: wrapped('test_case', 'TestCase', 'Changed'), ...authedErrors([400, '`INVALID_NAME` or `INVALID_REQUEST`, or a suite from elsewhere'], 404) },
};

export const deleteCaseSchema = {
  tags: SPEC,
  summary: 'Delete a test case',
  description: 'Needs `SPEC_DELETE`. A case in a plan or with results answers 409 `CASE_IN_USE`; `?force=true` deletes it with its results.',
  params: idParams('caseId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`CASE_IN_USE`: it is in a plan or has results']) },
};

export const moveSchema = {
  tags: SPEC,
  summary: 'Move suites and cases',
  description:
    'Moves suites and/or cases into a suite (or suites to the top level with `target_suite_id: null`), all or nothing. A selected item inside another selected suite moves with it. Needs `SPEC_EDIT`.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    required: ['target_suite_id'],
    properties: {
      suite_ids: { type: 'array', items: { type: 'string' } },
      case_ids: { type: 'array', items: { type: 'string' } },
      target_suite_id: { ...nullableText, description: 'The suite to move into; null for the top level (suites only)' },
    },
  }),
  response: {
    200: {
      description: 'Moved',
      type: 'object',
      required: ['moved_suite_count', 'moved_case_count'],
      properties: { moved_suite_count: { type: 'integer' }, moved_case_count: { type: 'integer' } },
    },
    ...authedErrors([400, 'Nothing to move, cases to the top level, a suite into itself, or an unknown target'], [404, 'A suite or case not in this project']),
  },
};

// ---- Versions ----

const versionResponse = wrapped('version', 'Version', 'The version');

export const latestVersionSchema = {
  tags: VERSIONS,
  summary: "A case's latest version",
  description: 'The case with its latest version: summary, preconditions and steps. Needs `SPEC_VIEW`.',
  params: idParams('caseId'),
  response: {
    200: {
      description: 'The case and its latest version',
      type: 'object',
      required: ['test_case', 'version'],
      properties: { test_case: { $ref: 'TestCase#' }, version: { $ref: 'Version#' } },
    },
    ...authedErrors([404, 'No such case, or it has no versions']),
  },
};

export const createDraftSchema = {
  tags: VERSIONS,
  summary: 'Start a new draft',
  description:
    "Copies the latest version's content into a new DRAFT version, to edit with `PATCH /api/v1/versions/{versionId}`. The approved version stays what plans run until the draft is approved. Needs `SPEC_EDIT`.",
  params: idParams('caseId'),
  response: {
    201: { ...versionResponse, description: 'The new draft' },
    ...authedErrors(404, [409, 'The latest version is already a draft, or the case is deprecated (restore it first)']),
  },
};

export const updateVersionSchema = {
  tags: VERSIONS,
  summary: 'Edit a draft',
  description: 'Changes the fields sent; `steps` replaces all the steps. Only a DRAFT can be edited (otherwise 422 `CASE_VERSION_LOCKED`). Needs `SPEC_EDIT`.',
  params: idParams('versionId'),
  body: handlerValidated({
    type: 'object',
    properties: { summary: nullableText, preconditions: nullableText, steps: stepsInput },
  }),
  response: {
    200: { ...versionResponse, description: 'Changed' },
    ...authedErrors([400, '`INVALID_STEPS`: `invalid_params` names each problem'], 404, [422, '`CASE_VERSION_LOCKED`: not a draft']),
  },
};

export const approveVersionSchema = {
  tags: VERSIONS,
  summary: 'Approve a draft',
  description:
    'DRAFT → APPROVED. Every ACTIVE plan with the case then runs this version (LOCKED and ARCHIVED plans keep theirs); `repinned_plan_count` says how many. Refused while a required custom field is empty. Needs `SPEC_APPROVE`.',
  params: idParams('versionId'),
  response: {
    200: {
      description: 'Approved',
      type: 'object',
      required: ['version', 'repinned_plan_count'],
      properties: { version: { $ref: 'Version#' }, repinned_plan_count: { type: 'integer' } },
    },
    ...authedErrors(404, [422, '`VERSION_NOT_DRAFT` or `REQUIRED_CUSTOM_FIELDS_MISSING`']),
  },
};

export const deprecateVersionSchema = {
  tags: VERSIONS,
  summary: 'Deprecate a case',
  description:
    "APPROVED → DEPRECATED, on the case's latest version. A deprecated case can't be edited or added to plans and is hidden from the spec tree by default; plans that have it keep it. Needs `SPEC_APPROVE`.",
  params: idParams('versionId'),
  response: { 200: { ...versionResponse, description: 'Deprecated' }, ...authedErrors(404, [422, '`VERSION_NOT_LATEST` or `VERSION_NOT_APPROVED`']) },
};

export const restoreVersionSchema = {
  tags: VERSIONS,
  summary: 'Restore a deprecated case',
  description: 'DEPRECATED → APPROVED, on the latest version; ACTIVE plans run it again. Needs `SPEC_APPROVE`.',
  params: idParams('versionId'),
  response: { 200: { ...versionResponse, description: 'Restored' }, ...authedErrors(404, [422, '`VERSION_NOT_LATEST` or `VERSION_NOT_DEPRECATED`']) },
};

// ---- Custom field values ----

function fieldValueSchemas(entity: 'case' | 'suite') {
  const param = entity === 'case' ? 'caseId' : 'suiteId';
  const what = entity === 'case' ? 'test case' : 'suite';
  return {
    list: {
      tags: FIELDS,
      summary: `A ${what}'s custom field values`,
      description: `Every custom field for ${what}s, with its definition and the value (its default when none is stored). Needs ${entity === 'case' ? '`SPEC_VIEW` or `EXECUTE_RUN`' : '`SPEC_VIEW`'}.`,
      params: idParams(param),
      response: { 200: list('values', 'CustomFieldValue', 'The values'), ...authedErrors(404) },
    },
    set: {
      tags: FIELDS,
      summary: `Set a ${what}'s custom field value`,
      description:
        'Replaces the value. Its shape depends on the field type (see `value` in the response of the list route); it is checked against the field\'s options, validation pattern and whether it is required. ' +
        'Values aren\'t versioned. Needs `PLAN_MANAGE`.',
      params: idParams(param, 'definitionId'),
      body: handlerValidated({
        type: 'object',
        properties: { value: { description: 'The value, shaped by the field type; null or "" to clear it' } },
      }),
      response: {
        200: { description: 'Saved', type: 'object', required: ['value'], properties: { value: { description: 'The value as stored' } } },
        ...authedErrors([404, `No such ${what}, or \`UNKNOWN_FIELD\``], [422, '`INVALID_FIELD_VALUE` or `REQUIRED_FIELD_MISSING`']),
      },
    },
    clear: {
      tags: FIELDS,
      summary: `Clear a ${what}'s custom field value`,
      description: "Removes the stored value, so the field shows its default again. Needs `PLAN_MANAGE`.",
      params: idParams(param, 'definitionId'),
      response: { 204: NO_CONTENT, ...authedErrors(404) },
    },
  };
}
export const caseFieldSchemas = fieldValueSchemas('case');
export const suiteFieldSchemas = fieldValueSchemas('suite');

// ---- Search ----

export const searchFieldsSchema = {
  tags: SEARCH,
  summary: 'Fields you can search and filter on',
  description:
    'The built-in properties and every custom field, each with its `key` (use it as a filter\'s `field`), its kind and its options. Reports take the same filters, and `group_by` takes the same keys.',
  params: idParams('projectId'),
  response: {
    200: {
      description: 'The fields',
      type: 'object',
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['key', 'label', 'kind', 'source'],
            properties: {
              key: { type: 'string', description: '`priority`, `execution_type`, `version_status`, `in_plan`, `verdict`, `cf:<definitionId>` or `suite_cf:<definitionId>`' },
              label: { type: 'string' },
              kind: oneOf(['ENUM', 'BOOLEAN', 'TEXT', 'NUMBER', 'DATE', 'CHECKBOX', 'SINGLE_SELECT', 'MULTI_SELECT']),
              source: oneOf(['builtin', 'case_custom_field', 'suite_custom_field']),
              options: {
                type: 'array',
                items: { type: 'object', required: ['value', 'label'], properties: { value: { type: 'string' }, label: { type: 'string' } } },
              },
              strict_options: { type: 'boolean', description: 'Values must be one of `options`' },
              requires: oneOf(['test_plan_id', 'test_run_id'], 'The search needs this too.'),
            },
          },
        },
      },
    },
    ...authedErrors(404),
  },
};

export const searchSchema = {
  tags: SEARCH,
  summary: 'Search test cases',
  description:
    '`q` matches a case\'s readable id, its title, or the name of any suite it is in. `filters` are all applied (AND); get their keys from the fields route. Operators: ' +
    '`any_of` (a list of values), `all_of` (MULTI_SELECT), `contains` (TEXT), `eq`/`gte`/`lte` and `between` ([min, max]) for NUMBER and DATE, `is` (true/false) for CHECKBOX and BOOLEAN, `is_empty`/`is_not_empty` for any field. ' +
    'The `in_plan` filter needs `test_plan_id`, `verdict` needs `test_run_id`. Returns the matching case ids and the suites containing them.',
  params: idParams('projectId'),
  body: handlerValidated({
    type: 'object',
    properties: {
      q: { type: 'string' },
      filters: {
        type: 'array',
        items: {
          type: 'object',
          required: ['field', 'op'],
          properties: {
            field: { type: 'string', description: 'A key from the fields route' },
            op: oneOf(['any_of', 'all_of', 'contains', 'eq', 'gte', 'lte', 'between', 'is', 'is_empty', 'is_not_empty']),
            value: { description: 'Shaped by the operator; e.g. `["HIGH"]` for any_of, `[1, 5]` for between' },
          },
        },
      },
      test_plan_id: { type: 'string' },
      test_run_id: { type: 'string' },
    },
  }),
  response: {
    200: {
      description: 'Matches',
      type: 'object',
      required: ['case_ids', 'suite_ids', 'total_cases'],
      properties: {
        case_ids: { type: 'array', items: { type: 'string' } },
        suite_ids: { type: 'array', items: { type: 'string' }, description: 'Suites containing a match, and the suites above them' },
        total_cases: { type: 'integer', description: 'How many cases were searched' },
      },
    },
    ...authedErrors([400, '`INVALID_FILTER` (`invalid_params` names each problem), or `PROJECTS_DIFFER`'], 404),
  },
};

// ---- Plan membership and the Execute queue ----

const queueCase = {
  type: 'object',
  required: [
    'test_plan_case_id', 'position', 'test_case_id', 'test_suite_id', 'external_id', 'title', 'priority', 'execution_type',
    'test_case_version_id', 'version_number', 'version_status', 'summary', 'preconditions', 'steps',
    'latest_verdict', 'latest_test_result_id', 'latest_notes', 'removed_from_plan',
  ],
  properties: {
    test_plan_case_id: { type: 'string', description: 'Use this to record a result' },
    position: { type: 'integer' },
    test_case_id: { type: 'string' },
    test_suite_id: { type: 'string' },
    external_id: { type: 'string' },
    title: { type: 'string' },
    priority: { type: 'string' },
    execution_type: { type: 'string' },
    test_case_version_id: { type: 'string', description: 'The pinned version' },
    version_number: { type: 'integer' },
    version_status: { type: 'string' },
    summary: nullableText,
    preconditions: nullableText,
    steps: { type: 'array', items: { $ref: 'Step#' } },
    latest_verdict: oneOf(['UNTESTED', ...VERDICTS], "The case's latest result in the run."),
    latest_test_result_id: nullableText,
    latest_notes: nullableText,
    removed_from_plan: { type: 'boolean', description: 'Removed from the plan after this run recorded it: shown read-only' },
  },
};

export const planCasesSchema = {
  tags: PLANS,
  summary: "A plan's cases, with results from a run",
  description:
    "Every case in the plan at its pinned version, with steps and its latest result in the run (`test_run_id`, default the newest run): Execute mode's queue. A case removed from the plan after the run recorded it is included, marked `removed_from_plan`. Needs `SPEC_VIEW` or `EXECUTE_RUN`.",
  params: idParams('planId'),
  querystring: { type: 'object', properties: { test_run_id: { type: 'string', description: 'Default: the newest run' } } },
  response: {
    200: {
      description: 'The plan, its runs and its cases',
      type: 'object',
      required: ['plan', 'runs', 'cases'],
      properties: { plan: { $ref: 'Plan#' }, runs: { type: 'array', items: { $ref: 'Run#' } }, cases: { type: 'array', items: queueCase } },
    },
    ...authedErrors([400, '`PROJECTS_DIFFER`: the run belongs to another project'], 404),
  },
};

export const addPlanCaseSchema = {
  tags: PLANS,
  summary: 'Add a case to a plan',
  description:
    'Pins the case at its latest version. Only an APPROVED case can be added, unless the project allows drafts. Adding one already there answers 200 with the existing link. Needs `PLAN_MANAGE`.',
  params: idParams('planId'),
  body: { type: 'object', required: ['test_case_id'], properties: { test_case_id: { type: 'string' } } },
  response: {
    201: wrapped('plan_case', 'PlanCase', 'Added'),
    200: wrapped('plan_case', 'PlanCase', 'Already in the plan'),
    ...authedErrors(400, 404, [422, '`PLAN_LOCKED`, `CASE_VERSION_NOT_APPROVED`, or the case has no versions']),
  },
};

export const removePlanCaseSchema = {
  tags: PLANS,
  summary: 'Remove a case from a plan',
  description:
    'A case with results answers 409 `CASE_HAS_RESULTS` (with counts); with `?force=true` it is retired instead of deleted: earlier runs keep it with its results, later runs leave it out. Needs `PLAN_MANAGE`.',
  params: idParams('planId', 'caseId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`CASE_HAS_RESULTS`'], [422, '`PLAN_LOCKED`']) },
};

const suiteCasesResult = {
  type: 'object',
  required: ['added', 'removed', 'retired', 'skipped'],
  properties: {
    added: { type: 'integer' },
    removed: { type: 'integer' },
    retired: { type: 'integer', description: 'Removed, but kept in earlier runs because they have results' },
    skipped: {
      type: 'array',
      description: 'Cases that could not be added',
      items: {
        type: 'object',
        required: ['test_case_id', 'external_id', 'reason'],
        properties: { test_case_id: { type: 'string' }, external_id: { type: 'string' }, reason: oneOf(['NO_VERSION', 'NOT_APPROVED']) },
      },
    },
  },
};

export const addSuiteCasesSchema = {
  tags: PLANS,
  summary: 'Add a whole suite to a plan',
  description: 'Adds every case in the suite and its sub-suites, skipping (and listing) cases that can\'t be added. Needs `PLAN_MANAGE`.',
  params: idParams('planId', 'suiteId'),
  response: { 200: { description: 'What changed', ...suiteCasesResult }, ...authedErrors(404, [422, '`PLAN_LOCKED`']) },
};

export const removeSuiteCasesSchema = {
  tags: PLANS,
  summary: 'Remove a whole suite from a plan',
  description:
    'Removes every case in the suite and its sub-suites. If any has results, nothing changes without `?force=true` (409 `CASE_HAS_RESULTS`); with it, those are retired and the rest removed. Answers 200 with counts rather than 204. Needs `PLAN_MANAGE`.',
  params: idParams('planId', 'suiteId'),
  querystring: FORCE_QUERY,
  response: { 200: { description: 'What changed', ...suiteCasesResult }, ...authedErrors(404, [409, '`CASE_HAS_RESULTS`'], [422, '`PLAN_LOCKED`']) },
};

// ---- Single items and version history ----

const CASE_REF = 'A case id, or its readable id (e.g. SHOP-12)';

export const getSuiteSchema = {
  tags: SPEC,
  summary: 'A suite',
  description: 'Needs `SPEC_VIEW`. Its sub-suites and cases: the spec tree.',
  params: idParams('suiteId'),
  response: { 200: wrapped('suite', 'Suite', 'The suite'), ...authedErrors(404) },
};

export const getCaseSchema = {
  tags: SPEC,
  summary: 'A test case',
  description: `The case and its latest version (content and steps). \`caseId\` may be the readable id, e.g. \`GET /api/v1/cases/SHOP-12\`. Needs \`SPEC_VIEW\`.`,
  params: { type: 'object', required: ['caseId'], properties: { caseId: { type: 'string', description: CASE_REF } } },
  response: {
    200: {
      description: 'The case',
      type: 'object',
      required: ['test_case', 'latest_version'],
      properties: { test_case: { $ref: 'TestCase#' }, latest_version: { anyOf: [{ $ref: 'Version#' }, { type: 'null' }] } },
    },
    ...authedErrors([400, '`AMBIGUOUS_CASE_ID`: a readable id shared by cases in several projects'], 404),
  },
};

export const listVersionsSchema = {
  tags: VERSIONS,
  summary: "A case's versions",
  description: 'Every version, newest first, each with its steps. Needs `SPEC_VIEW`.',
  params: { type: 'object', required: ['caseId'], properties: { caseId: { type: 'string', description: CASE_REF } } },
  response: { 200: list('versions', 'Version', 'The versions'), ...authedErrors(404) },
};

export const getVersionSchema = {
  tags: VERSIONS,
  summary: 'A version',
  description: 'Needs `SPEC_VIEW`.',
  params: idParams('versionId'),
  response: { 200: wrapped('version', 'Version', 'The version'), ...authedErrors(404) },
};
