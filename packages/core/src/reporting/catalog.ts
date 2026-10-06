/**
 * The report catalog -- the single definition of every report: what it answers, its
 * parameters (as JSON Schema) and output formats. The REST API (GET .../reports), the
 * MCP tools and the web UI are all driven by it, so they can't drift apart.
 */

export type ReportFormat = 'json' | 'markdown' | 'csv';

export interface ReportParamSchema {
  type: 'string' | 'integer' | 'object';
  description: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  nullable?: boolean;
}

export interface ReportDefinition {
  id: string;
  title: string;
  /** What question it answers -- written for both people and agents. */
  description: string;
  params: {
    type: 'object';
    properties: Record<string, ReportParamSchema>;
    required: string[];
    additionalProperties: false;
  };
  formats: ReportFormat[];
}

const FILTER_PARAM: ReportParamSchema = {
  type: 'object',
  description:
    'Optional case filter, same shape as the case-search API: { "q"?: string (matches external id or title), "filters"?: [{ "field", "op", "value" }] }. ' +
    'Field keys and operators come from GET /api/v1/projects/:projectId/case-search/fields. Limits the report to matching cases.',
};

function def(
  id: string,
  title: string,
  description: string,
  properties: Record<string, ReportParamSchema>,
  required: string[],
  formats: ReportFormat[]
): ReportDefinition {
  return { id, title, description, params: { type: 'object', properties, required, additionalProperties: false }, formats };
}

export const REPORT_CATALOG: ReportDefinition[] = [
  def(
    'overview',
    'Project overview',
    'Status at a glance for stakeholders: for every ACTIVE test plan, its latest run (pass rate, completion, new failures versus the run before); ' +
      'spec health (cases by status, drafts waiting for approval, cases never executed); and results recorded per day, split by UI (people) and API (automation).',
    { days: { type: 'integer', minimum: 1, maximum: 365, default: 30, description: 'Days of activity history to include.' } },
    [],
    ['json']
  ),
  def(
    'run_summary',
    'Run summary',
    'Everything about one test run: verdict counts, pass rate, completion, and a diff against another run (by default the previous run of the same plan) -- ' +
      'which cases are new failures, fixed, still failing, or no longer run. Lists every failing case with its error message, how long it has been failing, and whether it looks flaky. ' +
      'Start here to find out what broke.',
    {
      run_id: { type: 'string', description: 'The test run (build) to summarize.' },
      compare_to: {
        type: 'string',
        nullable: true,
        description: 'Run to compare against. Defaults to the previous run of the same plan; any run in the project is allowed. Pass null for no comparison.',
      },
      filter: FILTER_PARAM,
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Max cases listed per diff bucket and in the failures list.' },
    },
    ['run_id'],
    ['json', 'markdown', 'csv']
  ),
  def(
    'case_history',
    'Case history',
    'Every result one test case ever got, across all plans and runs, newest first: verdict, run, plan, version, who or which CI runner, duration, notes, error message, stack trace, environment. ' +
      'Plus stats: pass rate, current streak, last pass and last failure. Use it to troubleshoot a specific case.',
    {
      case_id: { type: 'string', description: 'Test case id (UUID) or external id such as "SHOP-12".' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25, description: 'Executions per page.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    ['case_id'],
    ['json', 'csv']
  ),
  def(
    'plan_trend',
    'Plan trend',
    "How a plan's results move across its recent runs (oldest first): counts, pass rate, completion and new failures per run.",
    {
      plan_id: { type: 'string', description: 'The test plan.' },
      runs: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'How many recent runs to include.' },
      filter: FILTER_PARAM,
    },
    ['plan_id'],
    ['json', 'csv']
  ),
  def(
    'test_health',
    'Test health',
    "Problem cases across a plan's recent runs: flaky (pass/fail flip-flopping between runs, or passing only after a retry within a run), " +
      'slowest and getting slower (automated results only -- manual results are not timed), always failing, and stale (not executed anywhere for N days, or never).',
    {
      plan_id: { type: 'string', description: 'The test plan.' },
      runs: { type: 'integer', minimum: 2, maximum: 50, default: 10, description: 'How many recent runs to analyse.' },
      stale_days: { type: 'integer', minimum: 1, maximum: 3650, default: 30, description: 'A case not executed for this many days is stale.' },
      filter: FILTER_PARAM,
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 20, description: 'Max cases per list.' },
    },
    ['plan_id'],
    ['json', 'csv']
  ),
  def(
    'breakdown',
    'Breakdown',
    'Group cases by a property and compare the groups. Without run_id: plan coverage per group (cases in the plan vs not). ' +
      'With run_id: verdict counts and pass rate per group for that run. group_by is suite, priority, execution_type, version_status, tester (needs run_id), ' +
      'or a custom field key (cf:<id> for case fields, suite_cf:<id> for suite fields) from GET .../case-search/fields.',
    {
      plan_id: { type: 'string', description: 'The test plan.' },
      run_id: { type: 'string', nullable: true, description: 'A run of that plan, for verdicts per group. Omit for coverage.' },
      group_by: { type: 'string', default: 'suite', description: 'Property to group by.' },
      filter: FILTER_PARAM,
    },
    ['plan_id'],
    ['json', 'csv']
  ),
];

/** How every number in the reports is defined -- returned with the catalog. */
export const REPORT_DEFINITIONS: Record<string, string> = {
  final_result: "A case's final result in a run is its latest execution in that run (re-running adds a new execution; nothing is overwritten).",
  verdicts: 'PASSED, FAILED, BLOCKED, SKIPPED, UNTESTED (no result yet), OTHER (RETEST_REQUIRED, KNOWN_ISSUE). FAILED and BLOCKED count as failing.',
  pass_rate: 'passed / (total - untested - skipped). 0 when nothing counted was executed. Rates are fractions between 0 and 1.',
  completion: '(total - untested) / total.',
  totals: "A run's totals use the plan's current case list, so a case added to a plan later shows as untested in earlier runs.",
  diff: 'new_failure: failing now, not failing before. fixed: failing before, passed now. still_failing: failing in both. not_run: had a result before, untested now. added/removed: only in one of the runs (only across plans).',
  failing_since: 'The earliest run of the current unbroken failing streak in that plan (runs where the case was not executed are skipped over).',
  flaky:
    "Flip score: pass/fail outcomes across runs; (transitions - 1) / (outcomes - 2), so a single real break or fix scores 0 and alternating results score 1. " +
    'A case counts as flaky when its flip score is at least 0.3 (a break later followed by a fix stays below that), or when within one run it both passed and failed (e.g. passed on retry). Run summaries use the last 10 runs; test health uses its runs window.',
  slowing: 'Median duration of the recent half of the timed runs divided by the median of the older half (needs 4+ timed runs). Listed when 1.2 or more.',
  always_failing: 'Failing in each of the last 3 or more runs it was executed in.',
  stale: 'No execution in any plan for stale_days days, or never executed.',
  durations: 'Only automated results (batch API) carry durations; results recorded by people in Execute mode are not timed.',
};

export function findReport(id: string): ReportDefinition | undefined {
  return REPORT_CATALOG.find((r) => r.id === id);
}

export type ReportParamValidation =
  | { ok: true; params: Record<string, unknown> }
  | { ok: false; errors: Array<{ param: string; reason: string }> };

/** Validates a request body against a report's params schema and applies defaults. */
export function validateReportParams(report: ReportDefinition, body: unknown): ReportParamValidation {
  const errors: Array<{ param: string; reason: string }> = [];
  if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
    return { ok: false, errors: [{ param: '(body)', reason: 'must be a JSON object' }] };
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const params: Record<string, unknown> = {};

  for (const key of Object.keys(input)) {
    if (!(key in report.params.properties)) errors.push({ param: key, reason: 'unknown parameter' });
  }

  for (const [key, schema] of Object.entries(report.params.properties)) {
    const value = input[key];
    if (value === undefined || (value === null && !schema.nullable) || value === '') {
      if (report.params.required.includes(key)) errors.push({ param: key, reason: 'is required' });
      else if (schema.default !== undefined) params[key] = schema.default;
      continue;
    }
    if (value === null) {
      params[key] = null;
      continue;
    }
    if (schema.type === 'string') {
      if (typeof value !== 'string') errors.push({ param: key, reason: 'must be a string' });
      else params[key] = value.trim();
    } else if (schema.type === 'integer') {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isInteger(n)) errors.push({ param: key, reason: 'must be an integer' });
      else if (schema.minimum !== undefined && n < schema.minimum) errors.push({ param: key, reason: `must be at least ${schema.minimum}` });
      else if (schema.maximum !== undefined && n > schema.maximum) errors.push({ param: key, reason: `must be at most ${schema.maximum}` });
      else params[key] = n;
    } else if (schema.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) errors.push({ param: key, reason: 'must be an object' });
      else params[key] = value;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, params };
}
