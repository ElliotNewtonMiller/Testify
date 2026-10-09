/**
 * The values a recorded result may use. A result's verdict, status and step verdicts are stored
 * as plain strings, so anything outside these lists used to be saved as-is -- and then counted
 * as "OTHER" or nothing at all by reports.
 */
export const EXECUTION_VERDICTS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'RETEST_REQUIRED', 'KNOWN_ISSUE'] as const;
export type ExecutionVerdict = (typeof EXECUTION_VERDICTS)[number];

/** A result's status (UNTESTED is what a case has before any result, never a result's own). */
export const EXECUTION_STATUSES = ['COMPLETED', 'IN_PROGRESS', 'ABORTED'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** A single step's verdict within a result. */
export const STEP_VERDICTS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNTESTED'] as const;
export type StepVerdict = (typeof STEP_VERDICTS)[number];

export const MAX_RESULT_NOTES_LENGTH = 20_000;

export const isExecutionVerdict = (v: unknown): v is ExecutionVerdict =>
  typeof v === 'string' && (EXECUTION_VERDICTS as readonly string[]).includes(v);
export const isExecutionStatus = (v: unknown): v is ExecutionStatus =>
  typeof v === 'string' && (EXECUTION_STATUSES as readonly string[]).includes(v);
export const isStepVerdict = (v: unknown): v is StepVerdict =>
  typeof v === 'string' && (STEP_VERDICTS as readonly string[]).includes(v);
