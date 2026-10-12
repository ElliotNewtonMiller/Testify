import { authedErrors, wrapped, list, NO_CONTENT, FORCE_QUERY, idParams, handlerValidated, oneOf, VERDICTS, STEP_VERDICTS, RESULT_STATUSES, PLAN_STATUSES, RUN_STATUSES, pageQuery, NEXT_CURSOR } from '../schemas.js';

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

function batchResponse(options: { run?: boolean; junit?: boolean } = {}) {
  return {
  type: 'object',
  required: ['object', 'summary', 'results', ...(options.run ? ['run'] : [])],
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
          ...(options.junit ? { test_name: { type: 'string', description: 'The JUnit test: `classname.name`, or its name' } } : {}),
        },
      },
    },
    run_status: oneOf(RUN_STATUSES, 'CLOSED when `close_run=true` closed it; otherwise OPEN.'),
    ...(options.run
      ? {
          run: {
            type: 'object',
            description: 'The run the results went into',
            required: ['id', 'name', 'created'],
            properties: { id: { type: 'string' }, name: { type: 'string' }, created: { type: 'boolean', description: 'true when this request created it' } },
          },
        }
      : {}),
  },
  };
}
const batchResultsResponse = batchResponse();

const CLOSE_RUN =
  'Close the run after recording (needs `RUN_MANAGE`), e.g. from the last step of a build. CI results never close a run by themselves, since a build may send several files or be re-run.';

export const batchResultsSchema = {
  tags: ['Runs and results'],
  summary: 'Record results from CI (batch)',
  description:
    'Up to 5,000 results in one request, saved in one transaction (RFC 03 §3). Needs `EXECUTE_RUN` (and `EXECUTE_OVERWRITE` to change an existing result). ' +
    'A case not yet in the plan is added if it is approved. By default valid results are saved and refused ones reported per item (207 when any were refused); ' +
    'with `all_or_nothing=true` one refusal saves nothing and fails the request. The run stays open (CI results don\'t auto-close it) unless `close_run=true`.',
  params: idParams('runId'),
  querystring: {
    type: 'object',
    properties: {
      all_or_nothing: oneOf(['true', 'false', '1', '0'], 'Save everything or nothing.'),
      close_run: oneOf(['true', 'false', '1', '0'], CLOSE_RUN),
    },
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

const RUN_NAME_QUERY = {
  run_name: {
    type: 'string',
    description:
      'The run to record in, by name: one CI build is one run, e.g. `CI build 1234`. Created if the plan has no run with this name (needs `RUN_MANAGE`), reused otherwise, so a re-run job adds to the same run.',
  },
};

const ALL_OR_NOTHING = {
  all_or_nothing: oneOf(['true', 'false', '1', '0'], 'Save everything or nothing.'),
  close_run: oneOf(['true', 'false', '1', '0'], CLOSE_RUN),
};

export const planBatchResultsSchema = {
  tags: ['Runs and results'],
  summary: 'Record results from CI into a run by name (batch)',
  description:
    'The same as `POST /api/v1/runs/{runId}/results/batch`, into the plan\'s run named `run_name`, which is created if there is none yet (needs `RUN_MANAGE` then). ' +
    'So CI needs no step to create or look up the run. The response says which run (`run`). Needs `EXECUTE_RUN`.',
  params: idParams('planId'),
  querystring: { type: 'object', required: ['run_name'], properties: { ...RUN_NAME_QUERY, ...ALL_OR_NOTHING } },
  body: batchResultsSchema.body,
  response: {
    201: { description: 'Every result was saved', ...batchResponse({ run: true }) },
    207: { description: 'Some results were refused; see `results[].status`', ...batchResponse({ run: true }) },
    ...authedErrors(
      [400, '`INVALID_RESULT`, or no `run_name`'],
      [403, 'Missing `EXECUTE_RUN`, or `RUN_MANAGE` to create the run'],
      404,
      [422, '`RUN_CLOSED` or `PLAN_LOCKED`; with all-or-nothing, also an item\'s refusal']
    ),
  },
};

export const JUNIT_MAX_TESTS = 20_000;
export const JUNIT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

const JUNIT_QUERY = {
  environment: { type: 'string', description: 'e.g. staging; stored with every result' },
  ci_name: { type: 'string', description: 'Your CI system, e.g. GitHub Actions (shown in reports)' },
  ci_run_id: { type: 'string', description: "Your CI system's id for this build (not a Testify id)" },
  ci_job_name: { type: 'string' },
  ci_url: { type: 'string', description: 'A link back to the build' },
  commit_sha: { type: 'string' },
  ...ALL_OR_NOTHING,
};

const JUNIT_DESCRIPTION =
  'The body is a JUnit XML report, as most test runners write it (pytest `--junitxml`, Maven Surefire, Gradle, Jest and Vitest junit reporters, go-junit-report, ...), sent as is: `curl --data-binary @report.xml`. Up to 20,000 tests and 50 MB. ' +
  'Each `<testcase>` is matched to a case of the project: by readable id (a `testify_id` property, or an id such as SHOP-101 in the test name), otherwise by suite and title, which is how a JUnit import of the same file names cases. ' +
  'failure and error are FAILED, skipped is SKIPPED, everything else PASSED; `time` becomes the duration, the failure message and text the error and stack trace. ' +
  'A matched case not yet in the plan is added if it is approved. Tests that match no case are listed as refused (`CASE_NOT_FOUND`, 207) and not recorded. Needs `EXECUTE_RUN`.';

const junitBody = { type: 'string', description: 'The JUnit XML file' };

const junitErrors = (more: Array<number | [number, string]>) =>
  authedErrors(
    [400, '`INVALID_JUNIT` (not a JUnit XML report, no tests, or too many), or `INVALID_RESULT` with all-or-nothing'],
    ...more,
    404,
    [413, 'Over 50 MB'],
    [422, '`RUN_CLOSED` or `PLAN_LOCKED`; with all-or-nothing, also a test\'s refusal']
  );

export const junitResultsSchema = {
  tags: ['Runs and results'],
  summary: 'Record results from a JUnit XML file',
  description: JUNIT_DESCRIPTION,
  consumes: ['application/xml'],
  params: idParams('runId'),
  querystring: { type: 'object', properties: JUNIT_QUERY },
  body: junitBody,
  response: {
    201: { description: 'Every test was recorded', ...batchResponse({ junit: true }) },
    207: { description: 'Some tests were refused (usually: no matching case); see `results[]`', ...batchResponse({ junit: true }) },
    ...junitErrors([]),
  },
};

export const planJunitResultsSchema = {
  tags: ['Runs and results'],
  summary: 'Record results from a JUnit XML file into a run by name',
  description: `Into the plan's run named \`run_name\`, created if there is none yet (needs \`RUN_MANAGE\` then). ${JUNIT_DESCRIPTION}`,
  consumes: ['application/xml'],
  params: idParams('planId'),
  querystring: { type: 'object', required: ['run_name'], properties: { ...RUN_NAME_QUERY, ...JUNIT_QUERY } },
  body: junitBody,
  response: {
    201: { description: 'Every test was recorded', ...batchResponse({ run: true, junit: true }) },
    207: { description: 'Some tests were refused (usually: no matching case); see `results[]`', ...batchResponse({ run: true, junit: true }) },
    ...junitErrors([[403, 'Missing `EXECUTE_RUN`, or `RUN_MANAGE` to create the run']]),
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

// ---- Reading results ----

export const RESULT_PAGE = { defaultLimit: 100, maxLimit: 1000 };

export const listRunResultsSchema = {
  tags: ['Runs and results'],
  summary: "A run's results",
  description:
    'Every result recorded in the run, newest first, a page at a time (`limit`, then `cursor` = the previous `next_cursor` until it is null). ' +
    "A case re-run several times has several results; `latest_only=true` keeps only each case's latest, which is what reports count. " +
    'Cases without a result have none here: for the whole plan with each case\'s state, use the `run_summary` report or `GET /api/v1/plans/{planId}/cases?test_run_id=`. Needs `SPEC_VIEW` or `EXECUTE_RUN`.',
  params: idParams('runId'),
  querystring: {
    type: 'object',
    properties: {
      verdict: { type: 'string', description: `Comma-separated: ${VERDICTS.join(', ')}` },
      test_case_id: { type: 'string', description: 'One case: its id or readable id (SHOP-12)' },
      source: oneOf(['UI', 'API'], 'UI: recorded one at a time (Execute mode, or `POST /runs/{runId}/results`); API: a CI batch'),
      latest_only: { type: 'boolean', description: "Only each case's latest result" },
      ...pageQuery(RESULT_PAGE.defaultLimit, RESULT_PAGE.maxLimit),
    },
  },
  response: {
    200: {
      description: 'A page of results',
      type: 'object',
      required: ['results', 'next_cursor'],
      properties: { results: { type: 'array', items: { $ref: 'RunResult#' } }, next_cursor: NEXT_CURSOR },
    },
    ...authedErrors([400, '`INVALID_CURSOR`, `AMBIGUOUS_CASE_ID`, or an invalid filter (`invalid_params` names it)'], 404),
  },
};

export const getResultSchema = {
  tags: ['Runs and results'],
  summary: 'A result',
  description: 'One result, in the same shape as the run\'s result list. Needs `SPEC_VIEW` or `EXECUTE_RUN`.',
  params: idParams('resultId'),
  response: { 200: wrapped('result', 'RunResult', 'The result'), ...authedErrors(404) },
};
