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
  build_id: string;
  test_plan_case_id: string;
  verdict: ExecutionVerdict;
  status: ExecutionStatus;
  notes: string | null;
  step_results: Array<{ test_step_id: string; step_number?: number; verdict: StepVerdict; actual_result: string | null }>;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Checks the shape of a POST /api/v1/executions body. Every problem is reported at once, by
 * field name. Whether the ids exist (and the steps belong to the case) is checked against the
 * database by the route.
 */
export function validateManualResult(raw: unknown): { result: ManualResult } | { invalid: InvalidParam[] } {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const invalid: InvalidParam[] = [];

  if (!isNonEmptyString(body.build_id)) invalid.push({ name: 'build_id', reason: 'is required' });
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
      build_id: body.build_id,
      test_plan_case_id: body.test_plan_case_id,
      verdict: body.verdict,
      status: body.status ?? 'COMPLETED',
      notes: body.notes || null,
      step_results: steps,
    },
  };
}
