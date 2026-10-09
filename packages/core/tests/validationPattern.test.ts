import { describe, it, expect } from 'vitest';
import {
  checkValidationPattern,
  matchesValidationPattern,
  MAX_VALIDATION_PATTERN_LENGTH,
  VALIDATION_PATTERN_TIMEOUT_MESSAGE,
} from '../src/custom-fields/validationPattern';
import { parseCustomFieldValue } from '../src/custom-fields/customFieldValidator';

describe('custom-field validation patterns', () => {
  it('checks a pattern before it is saved', () => {
    expect(checkValidationPattern('^[A-Z]+-\\d+$')).toBeNull();
    expect(checkValidationPattern('(')).toMatch(/isn't a valid regular expression/);
    expect(checkValidationPattern('a'.repeat(MAX_VALIDATION_PATTERN_LENGTH))).toBeNull();
    expect(checkValidationPattern('a'.repeat(MAX_VALIDATION_PATTERN_LENGTH + 1))).toMatch(/at most 500 characters/);
  });

  it('matches normally', () => {
    expect(matchesValidationPattern('^[A-Z]+-\\d+$', 'ABC-12')).toBe(true);
    expect(matchesValidationPattern('^[A-Z]+-\\d+$', 'abc')).toBe(false);
  });

  it('stops a catastrophic pattern instead of freezing, and refuses the value', () => {
    const started = Date.now();
    expect(() => matchesValidationPattern('^(a+)+$', 'a'.repeat(40) + '!')).toThrow(VALIDATION_PATTERN_TIMEOUT_MESSAGE);
    expect(Date.now() - started).toBeLessThan(2000);
    // ...and the next check still works.
    expect(matchesValidationPattern('^a+$', 'aaa')).toBe(true);
  });

  it('is what a TEXT field value is checked with', () => {
    expect(parseCustomFieldValue('TEXT', 'ABC-1', { validationRegex: '^[A-Z]+-\\d+$' }).string_value).toBe('ABC-1');
    expect(() => parseCustomFieldValue('TEXT', 'nope', { validationRegex: '^[A-Z]+-\\d+$' })).toThrow(/does not match/);
    expect(() => parseCustomFieldValue('TEXT', 'a'.repeat(40) + '!', { validationRegex: '^(a|a)*$' })).toThrow(/took too long/);
    // A pattern saved before patterns were checked, that doesn't compile, refuses with a clear message.
    expect(() => parseCustomFieldValue('TEXT', 'x', { validationRegex: '(' })).toThrow(/INVALID_FIELD_VALUE: .*isn't a valid regular expression/);
  });
});
