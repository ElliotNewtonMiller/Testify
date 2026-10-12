import { authedErrors, wrapped, list, NO_CONTENT, FORCE_QUERY, idParams, handlerValidated, oneOf, VERDICTS, STEP_VERDICTS, RESULT_STATUSES, PLAN_STATUSES, RUN_STATUSES } from '../schemas.js';

/** Route schemas for routes/projects.ts, the run list in routes/exports.ts, routes/results.ts and routes/batchExecution.ts. */

const nullableText = { type: ['string', 'null'] };

// ---- Projects ----

export const listProjectsSchema = {
  tags: ['Projects'],
  summary: 'List projects',
  description: 'Projects the caller can view or run tests in, each with `permissions`: what the caller may do there. An API token sees only its own project.',
  response: { 200: list('projects', 'Project', 'The projects'), ...authedErrors() },
};

const projectFields = {
  name: { type: 'string', description: 'Trimmed; must not be blank' },
  prefix: { type: 'string', description: 'A letter, then letters or digits, at most 10; stored in upper case. Locked once the project has cases.' },
  description: nullableText,
};

export const createProjectSchema = {
  tags: ['Projects'],
  summary: 'Create a project',
  description: 'Needs `PROJECT_CREATE`. Not available to API tokens (`TOKEN_NOT_ALLOWED`), which work only inside their own project.',
  body: { type: 'object', required: ['name', 'prefix'], properties: projectFields },
  response: { 201: wrapped('project', 'Project', 'Created'), ...authedErrors(400, [409, 'The prefix is already used']) },
};

export const updateProjectSchema = {
  tags: ['Projects'],
  summary: 'Change a project',
  description: 'Changes only the fields sent. Needs `PROJECT_CREATE`.',
  params: idParams('projectId'),
  body: { type: 'object', properties: projectFields },
  response: {
    200: wrapped('project', 'Project', 'Changed'),
    ...authedErrors(400, 404, [409, 'The prefix is taken, or the project already has cases']),
  },
};

export const deleteProjectSchema = {
  tags: ['Projects'],
  summary: 'Delete a project',
  description:
    'Needs `PROJECT_DELETE`. A project that still has suites, cases, plans, runs or results answers 409 `PROJECT_IN_USE` naming them; `?force=true` deletes it with everything in it. Audit rows are kept.',
  params: idParams('projectId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`PROJECT_IN_USE`: it still contains things']) },
};

// ---- Plans ----

const planFields = {
  name: { type: 'string', description: 'Trimmed; must not be blank' },
  description: nullableText,
  status: oneOf(PLAN_STATUSES, 'Default ACTIVE.'),
};

export const listPlansSchema = {
  tags: ['Plans'],
  summary: "List a project's test plans",
  description: 'Needs `SPEC_VIEW` or `EXECUTE_RUN` in the project.',
  params: idParams('projectId'),
  response: { 200: list('plans', 'Plan', 'The plans, archived ones included'), ...authedErrors(404) },
};

export const createPlanSchema = {
  tags: ['Plans'],
  summary: 'Create a test plan',
  description: 'Needs `PLAN_MANAGE`. Add cases with `POST /api/v1/plans/{planId}/cases`.',
  params: idParams('projectId'),
  body: { type: 'object', required: ['name'], properties: planFields },
  response: { 201: wrapped('plan', 'Plan', 'Created'), ...authedErrors(400, 404) },
};

export const updatePlanSchema = {
  tags: ['Plans'],
  summary: 'Change a test plan',
  description: 'Changes only the fields sent, e.g. `{ "status": "LOCKED" }`. Needs `PLAN_MANAGE`.',
  params: idParams('planId'),
  body: { type: 'object', properties: planFields },
  response: { 200: wrapped('plan', 'Plan', 'Changed'), ...authedErrors(400, 404) },
};

export const deletePlanSchema = {
  tags: ['Plans'],
  summary: 'Delete a test plan',
  description: 'Needs `PLAN_MANAGE`. A plan with runs or cases answers 409 `PLAN_IN_USE`; `?force=true` deletes it with its runs and their results.',
  params: idParams('planId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`PLAN_IN_USE`: it still has runs or cases']) },
};

// ---- Runs ----

const runFields = {
  name: { type: 'string', description: 'Trimmed; must not be blank; unique within the plan' },
  description: nullableText,
  status: oneOf(RUN_STATUSES, 'Default OPEN. A CLOSED run takes no results.'),
  release_date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
};

export const listRunsSchema = {
  tags: ['Runs and results'],
  summary: "List a plan's test runs",
  description: 'Newest first. Needs `SPEC_VIEW` or `EXECUTE_RUN`.',
  params: idParams('planId'),
  response: { 200: list('runs', 'Run', 'The runs'), ...authedErrors(404) },
};

export const createRunSchema = {
  tags: ['Runs and results'],
  summary: 'Create a test run',
  description: 'Needs `RUN_MANAGE`.',
  params: idParams('planId'),
  body: { type: 'object', required: ['name'], properties: runFields },
  response: { 201: wrapped('run', 'Run', 'Created'), ...authedErrors(400, 404, [409, 'A run with this name already exists in the plan']) },
};

export const updateRunSchema = {
  tags: ['Runs and results'],
  summary: 'Change a test run',
  description: 'Changes only the fields sent; `{ "status": "CLOSED" }` closes the run and `"OPEN"` reopens it. Needs `RUN_MANAGE`.',
  params: idParams('runId'),
  body: { type: 'object', properties: runFields },
  response: { 200: wrapped('run', 'Run', 'Changed'), ...authedErrors(400, 404, [409, 'A run with this name already exists in the plan']) },
};

export const deleteRunSchema = {
  tags: ['Runs and results'],
  summary: 'Delete a test run',
  description: 'Needs `RUN_MANAGE`. A run with results answers 409 `RUN_IN_USE`; `?force=true` deletes it with its results.',
  params: idParams('runId'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`RUN_IN_USE`: it has results']) },
};

// ---- Results ----


export const recordResultSchema = {
  tags: ['Runs and results'],
  summary: 'Record one result',
  description:
    'What Execute mode\'s verdict buttons and hotkeys call. Needs `EXECUTE_RUN`; changing a case\'s existing result in the run (a different verdict, or someone else\'s) needs `EXECUTE_OVERWRITE` too. ' +
    'Results are never edited: a new one becomes the latest. Manual results are never timed. The run closes itself the first time every case in the plan has a result (`run_status`).',
  params: idParams('runId'),
  body: handlerValidated({
    type: 'object',
    required: ['test_plan_case_id', 'verdict'],
    properties: {
      test_plan_case_id: { type: 'string', description: "The case's link to the run's plan (`test_plan_case_id` from `GET /api/v1/plans/{planId}/cases`)" },
      verdict: oneOf(VERDICTS),
      status: oneOf(RESULT_STATUSES, 'Default COMPLETED.'),
      notes: { type: ['string', 'null'], maxLength: 20000 },
      step_results: {
        type: 'array',
        description: 'Steps of the version the case is pinned to in the plan',
        items: {
          type: 'object',
          required: ['test_step_id', 'verdict'],
          properties: {
            test_step_id: { type: 'string' },
            step_number: { type: 'integer', minimum: 1, description: "Optional; must match the step's number" },
            verdict: oneOf(STEP_VERDICTS),
            actual_result: { type: ['string', 'null'] },
          },
        },
      },
    },
  }),
  response: {
    201: {
      description: 'Recorded',
      type: 'object',
      required: ['result', 'run_status'],
      properties: {
        result: { $ref: 'RecordedResult#' },
        run_status: oneOf(RUN_STATUSES, 'CLOSED if this result just closed the run.'),
      },
    },
    ...authedErrors(
      [400, '`INVALID_RESULT`: `invalid_params` names each problem'],
      [403, 'Missing `EXECUTE_RUN`, or `RESULT_OVERWRITE_NOT_PERMITTED`'],
      404,
      [422, '`RUN_CLOSED`, `PLAN_LOCKED` or `CASE_REMOVED_FROM_PLAN`']
    ),
  },
};

const caseIdentifier = {
  type: 'object',
  description: 'Which case: one of `external_id` (e.g. SHOP-101), `by_uuid` (the case id) or `by_path_title`',
  properties: {
    external_id: { type: 'string' },
    by_uuid: { type: 'string' },
    by_path_title: {
      type: 'object',
      required: ['suite_path', 'title'],
      properties: { suite_path: { type: 'string', description: 'e.g. "Payments / Checkout"' }, title: { type: 'string' } },
    },
  },
};

const batchResultsResponse = {
  type: 'object',
  required: ['object', 'summary', 'results'],
  properties: {
    object: { type: 'string', enum: ['batch_results'] },
    summary: {
      type: 'object',
      required: ['total_submitted', 'successful', 'failed', 'duration_ms'],
      properties: {
        total_submitted: { type: 'integer' },
        successful: { type: 'integer' },
        failed: { type: 'integer' },
        duration_ms: { type: 'integer', description: 'How long the server took' },
      },
    },
    results: {
      type: 'array',
      description: 'One per submitted result, in order',
      items: {
        type: 'object',
        required: ['index', 'status'],
        properties: {
          index: { type: 'integer' },
          status: { type: 'integer', description: '201 saved; otherwise why it was refused (400, 403, 422)' },
          test_result_id: { type: 'string' },
          test_case_id: { type: 'string' },
          verdict: { type: 'string' },
          code: { type: 'string', description: 'For a refused item: INVALID_RESULT, CASE_NOT_FOUND, CASE_REMOVED_FROM_PLAN, RESULT_OVERWRITE_NOT_PERMITTED or UNKNOWN_STEP' },
          detail: { type: 'string' },
          invalid_params: {
            type: 'array',
            items: { type: 'object', required: ['name', 'reason'], properties: { name: { type: 'string' }, reason: { type: 'string' } } },
          },
        },
      },
    },
    run_status: oneOf(RUN_STATUSES, 'CLOSED if this batch just closed the run.'),
  },
};

export const batchResultsSchema = {
  tags: ['Runs and results'],
  summary: 'Record results from CI (batch)',
  description:
    'Up to 5,000 results in one request, saved in one transaction (RFC 03 §3). Needs `EXECUTE_RUN` (and `EXECUTE_OVERWRITE` to change an existing result). ' +
    'A case not yet in the plan is added if it is approved. By default valid results are saved and refused ones reported per item (207 when any were refused); ' +
    'with `all_or_nothing=true` one refusal saves nothing and fails the request.',
  params: idParams('runId'),
  querystring: {
    type: 'object',
    properties: { all_or_nothing: oneOf(['true', 'false', '1', '0'], 'Save everything or nothing.') },
  },
  body: handlerValidated({
    type: 'object',
    required: ['results'],
    properties: {
      environment: { type: 'string', description: 'e.g. staging' },
      runner_info: {
        type: 'object',
        description: 'Shown in reports. `run_id` is your CI system\'s run id, not a Testify id.',
        properties: {
          name: { type: 'string' },
          run_id: { type: 'string' },
          job_name: { type: 'string' },
          commit_sha: { type: 'string' },
          url: { type: 'string' },
        },
      },
      results: {
        type: 'array',
        minItems: 1,
        maxItems: 5000,
        items: {
          type: 'object',
          required: ['case_identifier', 'verdict'],
          properties: {
            case_identifier: caseIdentifier,
            verdict: oneOf(VERDICTS),
            status: oneOf(RESULT_STATUSES, 'Default COMPLETED.'),
            duration_ms: { type: 'integer', minimum: 0 },
            executed_at: { type: 'string', description: 'ISO 8601; default now' },
            notes: { type: 'string', maxLength: 20000 },
            failure_message: { type: 'string', maxLength: 2000, description: 'The short error, shown in reports' },
            stack_trace: { type: 'string', maxLength: 100000 },
            environment_tags: { type: 'object', additionalProperties: { type: 'string' }, description: 'Up to 50 text values' },
            step_results: {
              type: 'array',
              items: {
                type: 'object',
                required: ['verdict'],
                properties: {
                  test_step_id: { type: 'string' },
                  step_number: { type: 'integer', minimum: 1, description: 'Either this or `test_step_id`' },
                  verdict: oneOf(STEP_VERDICTS),
                  actual_result: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }),
  response: {
    201: { description: 'Every result was saved', ...batchResultsResponse },
    207: { description: 'Some results were refused; see `results[].status`', ...batchResultsResponse },
    ...authedErrors(
      [400, '`INVALID_RESULT` (all-or-nothing, or a malformed request)'],
      404,
      [422, '`RUN_CLOSED` or `PLAN_LOCKED`; with all-or-nothing, also an item\'s refusal']
    ),
  },
};

// ---- Single items ----

export const getProjectSchema = {
  tags: ['Projects'],
  summary: 'A project',
  description: 'With `permissions`: what the caller may do in it. Needs `SPEC_VIEW` or `EXECUTE_RUN` in the project.',
  params: idParams('projectId'),
  response: { 200: wrapped('project', 'Project', 'The project'), ...authedErrors(404) },
};

export const getPlanSchema = {
  tags: ['Plans'],
  summary: 'A test plan',
  description: 'Needs `SPEC_VIEW` or `EXECUTE_RUN`. Its cases: `GET /api/v1/plans/{planId}/cases`.',
  params: idParams('planId'),
  response: { 200: wrapped('plan', 'Plan', 'The plan'), ...authedErrors(404) },
};

export const getRunSchema = {
  tags: ['Runs and results'],
  summary: 'A test run',
  description: 'Needs `SPEC_VIEW` or `EXECUTE_RUN`. Its results: `GET /api/v1/runs/{runId}/results`; a summary: the `run_summary` report.',
  params: idParams('runId'),
  response: { 200: wrapped('run', 'Run', 'The run'), ...authedErrors(404) },
};
