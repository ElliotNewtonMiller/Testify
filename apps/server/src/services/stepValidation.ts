import type { CreateTestStepInput } from '@testify/db';
import type { InvalidParam } from './resultValidation.js';

/** Limits for a test case's steps, as sent when creating a case or saving a draft. */
export const MAX_STEPS_PER_CASE = 500;
export const MAX_STEP_TEXT_LENGTH = 20_000;
const STEP_EXECUTION_TYPES = ['MANUAL', 'AUTOMATED'];

/**
 * Checks the `steps` of a case being created or a draft being saved. Each step needs text for
 * `action` and `expected_result` (empty is fine; missing counts as empty). `step_number` is
 * optional: a step without one is numbered by its position in the list. Numbers must be
 * positive whole numbers and unique. Step ids are always assigned by the server. Returns the
 * steps ready to store, or every problem by field name.
 */
export function validateStepsInput(raw: unknown): { steps: CreateTestStepInput[] } | { invalid: InvalidParam[] } {
  if (!Array.isArray(raw)) return { invalid: [{ name: 'steps', reason: 'must be a list' }] };
  if (raw.length > MAX_STEPS_PER_CASE) {
    return { invalid: [{ name: 'steps', reason: `can have at most ${MAX_STEPS_PER_CASE} steps` }] };
  }

  const invalid: InvalidParam[] = [];
  const steps: CreateTestStepInput[] = [];
  const numbersSeen = new Map<number, number>();

  raw.forEach((s: any, i: number) => {
    const at = `steps[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      invalid.push({ name: at, reason: 'must be an object' });
      return;
    }

    let stepNumber = i + 1;
    if (s.step_number !== undefined && s.step_number !== null) {
      if (!Number.isInteger(s.step_number) || s.step_number < 1) {
        invalid.push({ name: `${at}.step_number`, reason: 'must be a positive whole number' });
      } else {
        stepNumber = s.step_number;
      }
    }
    if (numbersSeen.has(stepNumber)) {
      invalid.push({ name: `${at}.step_number`, reason: `${stepNumber} is already used by steps[${numbersSeen.get(stepNumber)}]` });
    } else {
      numbersSeen.set(stepNumber, i);
    }

    const text = (field: 'action' | 'expected_result'): string => {
      const v = s[field];
      if (v === undefined || v === null) return '';
      if (typeof v !== 'string') {
        invalid.push({ name: `${at}.${field}`, reason: 'must be text' });
        return '';
      }
      if (v.length > MAX_STEP_TEXT_LENGTH) invalid.push({ name: `${at}.${field}`, reason: `can be at most ${MAX_STEP_TEXT_LENGTH} characters` });
      return v;
    };
    const action = text('action');
    const expectedResult = text('expected_result');

    let executionType: string | undefined;
    if (s.execution_type !== undefined && s.execution_type !== null) {
      if (!STEP_EXECUTION_TYPES.includes(s.execution_type)) {
        invalid.push({ name: `${at}.execution_type`, reason: `must be one of ${STEP_EXECUTION_TYPES.join(', ')}` });
      } else {
        executionType = s.execution_type;
      }
    }

    steps.push({ step_number: stepNumber, action, expected_result: expectedResult, execution_type: executionType });
  });

  return invalid.length > 0 ? { invalid } : { steps };
}
