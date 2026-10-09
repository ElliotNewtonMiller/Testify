import { Script, createContext } from 'node:vm';

/**
 * Validation patterns on TEXT custom fields are regular expressions an admin types in. A badly
 * written one (e.g. `(a+)+$`) can backtrack for seconds or hours on the right input, and
 * JavaScript regexes can't be interrupted -- a match like that would freeze the whole server.
 *
 * So:
 * - A pattern is checked when it's saved (checkValidationPattern): it must compile and be at
 *   most MAX_VALIDATION_PATTERN_LENGTH characters.
 * - Every match runs with a time limit (matchesValidationPattern): inside a node:vm context,
 *   whose timeout can stop a running regex. A match that runs out of time is refused, not
 *   treated as a match.
 *
 * Heuristic "is this regex safe?" checks were tried and left out: they both miss dangerous
 * patterns and reject useful safe ones, while the time limit always holds.
 */
export const MAX_VALIDATION_PATTERN_LENGTH = 500;
export const VALIDATION_PATTERN_TIME_LIMIT_MS = 50;

/** Why a pattern can't be saved, or null if it can. */
export function checkValidationPattern(pattern: string): string | null {
  if (pattern.length > MAX_VALIDATION_PATTERN_LENGTH) {
    return `The validation pattern can be at most ${MAX_VALIDATION_PATTERN_LENGTH} characters.`;
  }
  try {
    new RegExp(pattern);
  } catch (err: any) {
    return `The validation pattern isn't a valid regular expression: ${String(err?.message ?? err).replace(/^Invalid regular expression: /, '')}`;
  }
  return null;
}

// A plain Error on purpose: the server shows plain Errors' messages to the user (isPublicError).
export const VALIDATION_PATTERN_TIMEOUT_MESSAGE =
  "INVALID_FIELD_VALUE: checking this value against the field's validation pattern took too long, so it was refused. Ask an administrator to simplify the pattern.";

const sandbox = createContext({ pattern: '', value: '' });
const matchScript = new Script('new RegExp(pattern).test(value)');

/** Whether `value` matches `pattern`, stopping after VALIDATION_PATTERN_TIME_LIMIT_MS. */
export function matchesValidationPattern(pattern: string, value: string, timeLimitMs = VALIDATION_PATTERN_TIME_LIMIT_MS): boolean {
  sandbox.pattern = pattern;
  sandbox.value = value;
  try {
    return matchScript.runInContext(sandbox, { timeout: timeLimitMs }) === true;
  } catch (err: any) {
    if (err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new Error(VALIDATION_PATTERN_TIMEOUT_MESSAGE);
    // A pattern saved before patterns were checked may not compile (the error comes from the
    // sandbox's realm, so it isn't `instanceof SyntaxError` here).
    if (err?.name === 'SyntaxError') {
      throw new Error("INVALID_FIELD_VALUE: this field's validation pattern isn't a valid regular expression. Ask an administrator to fix it.");
    }
    throw err;
  } finally {
    sandbox.value = '';
  }
}
