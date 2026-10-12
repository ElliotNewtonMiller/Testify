import {
  EXECUTION_STATUSES,
  EXECUTION_VERDICTS,
  MAX_RESULT_NOTES_LENGTH,
  STEP_VERDICTS,
  isExecutionStatus,
  isExecutionVerdict,
  isStepVerdict,
  type ExecutionStatus,
  type ExecutionVerdict,
  type StepVerdict,
} from '@testify/core';

export interface InvalidParam {
  name: string;
  reason: string;
}

export interface ManualResult {
  test_plan_case_id: string;
  verdict: ExecutionVerdict;
  status: ExecutionStatus;
  notes: string | null;
  step_results: Array<{ test_step_id: string; step_number?: number; verdict: StepVerdict; actual_result: string | null }>;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Checks the shape of a POST /api/v1/runs/:runId/results body (the run comes from the address). Every problem is reported at once, by
 * field name. Whether the ids exist (and the steps belong to the case) is checked against the
 * database by the route.
 */
export function validateManualResult(raw: unknown): { result: ManualResult } | { invalid: InvalidParam[] } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const invalid: InvalidParam[] = [];

  if (!isNonEmptyString(body.test_plan_case_id)) invalid.push({ name: 'test_plan_case_id', reason: 'is required' });
  if (!isExecutionVerdict(body.verdict)) {
    invalid.push({ name: 'verdict', reason: `must be one of ${EXECUTION_VERDICTS.join(', ')}` });
  }
  if (body.status !== undefined && body.status !== null && !isExecutionStatus(body.status)) {
    invalid.push({ name: 'status', reason: `must be one of ${EXECUTION_STATUSES.join(', ')}` });
  }
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') invalid.push({ name: 'notes', reason: 'must be text' });
    else if (body.notes.length > MAX_RESULT_NOTES_LENGTH) {
      invalid.push({ name: 'notes', reason: `can be at most ${MAX_RESULT_NOTES_LENGTH} characters` });
    }
  }

  const steps: ManualResult['step_results'] = [];
  if (body.step_results !== undefined && body.step_results !== null) {
    if (!Array.isArray(body.step_results)) {
      invalid.push({ name: 'step_results', reason: 'must be a list' });
    } else {
      const seen = new Set<string>();
      body.step_results.forEach((s: any, i: number) => {
        const at = `step_results[${i}]`;
        if (!s || typeof s !== 'object') {
          invalid.push({ name: at, reason: 'must be an object' });
          return;
        }
        if (!isNonEmptyString(s.test_step_id)) invalid.push({ name: `${at}.test_step_id`, reason: 'is required' });
        else if (seen.has(s.test_step_id)) invalid.push({ name: `${at}.test_step_id`, reason: 'appears more than once' });
        else seen.add(s.test_step_id);
        if (s.step_number !== undefined && s.step_number !== null && !(Number.isInteger(s.step_number) && s.step_number > 0)) {
          invalid.push({ name: `${at}.step_number`, reason: 'must be a positive whole number' });
        }
        if (!isStepVerdict(s.verdict)) {
          invalid.push({ name: `${at}.verdict`, reason: `must be one of ${STEP_VERDICTS.join(', ')}` });
        }
        if (s.actual_result !== undefined && s.actual_result !== null && typeof s.actual_result !== 'string') {
          invalid.push({ name: `${at}.actual_result`, reason: 'must be text' });
        }
        steps.push({
          test_step_id: s.test_step_id,
          step_number: s.step_number ?? undefined,
          verdict: s.verdict,
          actual_result: typeof s.actual_result === 'string' ? s.actual_result : null,
        });
      });
    }
  }

  if (invalid.length > 0) return { invalid };
  return {
    result: {
      test_plan_case_id: body.test_plan_case_id,
      verdict: body.verdict,
      status: body.status ?? 'COMPLETED',
      notes: body.notes || null,
      step_results: steps,
    },
  };
}

/** The most results one batch request may carry. */
export const MAX_BATCH_RESULTS = 5000;
const MAX_FAILURE_MESSAGE_LENGTH = 2000;
const MAX_STACK_TRACE_LENGTH = 100_000;
const MAX_ENVIRONMENT_TAGS = 50;

export interface BatchItemShape {
  case_identifier: { external_id?: string; by_uuid?: string; by_path_title?: { suite_path: string; title: string } };
  verdict: ExecutionVerdict;
  status: ExecutionStatus;
  duration_ms: number | null;
  executed_at: string | null;
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment_tags: Record<string, string> | null;
  step_results: Array<{ test_step_id?: string; step_number?: number; verdict: StepVerdict; actual_result: string | null }>;
}

const optionalText = (
  invalid: InvalidParam[],
  name: string,
  value: unknown,
  max: number
): string | null => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    invalid.push({ name, reason: 'must be text' });
    return null;
  }
  if (value.length > max) invalid.push({ name, reason: `can be at most ${max} characters` });
  return value;
};

/**
 * Checks one item of a batch results request (results[i]). Whether its case and steps
 * exist is checked by the route, against the plan.
 */
export function validateBatchItem(raw: unknown, index: number): { item: BatchItemShape } | { invalid: InvalidParam[] } {
  const at = `results[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { invalid: [{ name: at, reason: 'must be an object' }] };
  const it = raw as Record<string, any>;
  const invalid: InvalidParam[] = [];

  const cid = it.case_identifier;
  const hasId =
    cid &&
    typeof cid === 'object' &&
    (isNonEmptyString(cid.external_id) ||
      isNonEmptyString(cid.by_uuid) ||
      (cid.by_path_title && typeof cid.by_path_title === 'object' && isNonEmptyString(cid.by_path_title.title)));
  if (!hasId) {
    invalid.push({ name: `${at}.case_identifier`, reason: 'needs an external_id, by_uuid, or by_path_title.title' });
  }
  if (!isExecutionVerdict(it.verdict)) {
    invalid.push({ name: `${at}.verdict`, reason: `must be one of ${EXECUTION_VERDICTS.join(', ')}` });
  }
  if (it.status !== undefined && it.status !== null && !isExecutionStatus(it.status)) {
    invalid.push({ name: `${at}.status`, reason: `must be one of ${EXECUTION_STATUSES.join(', ')}` });
  }
  if (it.duration_ms !== undefined && it.duration_ms !== null && !(Number.isInteger(it.duration_ms) && it.duration_ms >= 0)) {
    invalid.push({ name: `${at}.duration_ms`, reason: 'must be a whole number of milliseconds, 0 or more' });
  }
  if (it.executed_at !== undefined && it.executed_at !== null) {
    if (typeof it.executed_at !== 'string' || Number.isNaN(Date.parse(it.executed_at))) {
      invalid.push({ name: `${at}.executed_at`, reason: 'must be an ISO-8601 date-time' });
    }
  }
  const notes = optionalText(invalid, `${at}.notes`, it.notes, MAX_RESULT_NOTES_LENGTH);
  const failureMessage = optionalText(invalid, `${at}.failure_message`, it.failure_message, MAX_FAILURE_MESSAGE_LENGTH);
  const stackTrace = optionalText(invalid, `${at}.stack_trace`, it.stack_trace, MAX_STACK_TRACE_LENGTH);

  let environmentTags: Record<string, string> | null = null;
  if (it.environment_tags !== undefined && it.environment_tags !== null) {
    const tags = it.environment_tags;
    if (typeof tags !== 'object' || Array.isArray(tags)) {
      invalid.push({ name: `${at}.environment_tags`, reason: 'must be an object of text values' });
    } else {
      const entries = Object.entries(tags);
      if (entries.length > MAX_ENVIRONMENT_TAGS || entries.some(([, v]) => typeof v !== 'string' || v.length > 500)) {
        invalid.push({ name: `${at}.environment_tags`, reason: `must be at most ${MAX_ENVIRONMENT_TAGS} text values of up to 500 characters` });
      } else if (entries.length > 0) {
        environmentTags = Object.fromEntries(entries) as Record<string, string>;
      }
    }
  }

  const steps: BatchItemShape['step_results'] = [];
  if (it.step_results !== undefined && it.step_results !== null) {
    if (!Array.isArray(it.step_results)) {
      invalid.push({ name: `${at}.step_results`, reason: 'must be a list' });
    } else {
      it.step_results.forEach((s: any, j: number) => {
        const sat = `${at}.step_results[${j}]`;
        if (!s || typeof s !== 'object') {
          invalid.push({ name: sat, reason: 'must be an object' });
          return;
        }
        const hasStepId = isNonEmptyString(s.test_step_id);
        const hasNumber = s.step_number !== undefined && s.step_number !== null;
        if (!hasStepId && !hasNumber) invalid.push({ name: sat, reason: 'needs a test_step_id or step_number' });
        if (hasNumber && !(Number.isInteger(s.step_number) && s.step_number > 0)) {
          invalid.push({ name: `${sat}.step_number`, reason: 'must be a positive whole number' });
        }
        if (!isStepVerdict(s.verdict)) {
          invalid.push({ name: `${sat}.verdict`, reason: `must be one of ${STEP_VERDICTS.join(', ')}` });
        }
        const actual = optionalText(invalid, `${sat}.actual_result`, s.actual_result, MAX_RESULT_NOTES_LENGTH);
        steps.push({
          test_step_id: hasStepId ? s.test_step_id : undefined,
          step_number: hasNumber ? s.step_number : undefined,
          verdict: s.verdict,
          actual_result: actual,
        });
      });
    }
  }

  if (invalid.length > 0) return { invalid };
  return {
    item: {
      case_identifier: cid,
      verdict: it.verdict,
      status: it.status ?? 'COMPLETED',
      duration_ms: it.duration_ms ?? null,
      executed_at: it.executed_at ? new Date(it.executed_at).toISOString() : null,
      notes,
      failure_message: failureMessage,
      stack_trace: stackTrace,
      environment_tags: environmentTags,
      step_results: steps,
    },
  };
}
