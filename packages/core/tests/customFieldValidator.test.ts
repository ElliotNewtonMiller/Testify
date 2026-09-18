import { describe, it, expect } from 'vitest';
import { parseCustomFieldValue, readCustomFieldValue } from '../src/index.js';

describe('parseCustomFieldValue', () => {
  it('TEXT: accepts a string, rejects a non-string', () => {
    expect(parseCustomFieldValue('TEXT', 'hello').string_value).toBe('hello');
    expect(() => parseCustomFieldValue('TEXT', 42)).toThrow('INVALID_FIELD_VALUE');
  });

  it('TEXT: validates against validation_regex', () => {
    expect(parseCustomFieldValue('TEXT', 'ABC-123', { validationRegex: '^[A-Z]+-\\d+$' }).string_value).toBe('ABC-123');
    expect(() => parseCustomFieldValue('TEXT', 'nope', { validationRegex: '^[A-Z]+-\\d+$' })).toThrow('INVALID_FIELD_VALUE');
  });

  it('NUMBER: accepts a finite number, rejects NaN/boolean/array', () => {
    expect(parseCustomFieldValue('NUMBER', 3.5).number_value).toBe(3.5);
    expect(parseCustomFieldValue('NUMBER', '42').number_value).toBe(42);
    expect(() => parseCustomFieldValue('NUMBER', 'not-a-number')).toThrow('INVALID_FIELD_VALUE');
    expect(() => parseCustomFieldValue('NUMBER', true)).toThrow('INVALID_FIELD_VALUE');
    expect(() => parseCustomFieldValue('NUMBER', [1, 2])).toThrow('INVALID_FIELD_VALUE');
  });

  it('CHECKBOX: accepts boolean or 0/1, rejects other values', () => {
    expect(parseCustomFieldValue('CHECKBOX', true).boolean_value).toBe(1);
    expect(parseCustomFieldValue('CHECKBOX', false).boolean_value).toBe(0);
    expect(parseCustomFieldValue('CHECKBOX', 1).boolean_value).toBe(1);
    expect(() => parseCustomFieldValue('CHECKBOX', 'yes')).toThrow('INVALID_FIELD_VALUE');
  });

  it('DATE: accepts an ISO date string, rejects an unparseable one', () => {
    expect(parseCustomFieldValue('DATE', '2026-01-15').date_value).toBe('2026-01-15');
    expect(() => parseCustomFieldValue('DATE', 'not-a-date')).toThrow('INVALID_FIELD_VALUE');
  });

  it('SINGLE_SELECT: accepts a value in the option set, rejects one that is not', () => {
    const options = [{ option_value: 'RED' }, { option_value: 'BLUE' }];
    expect(parseCustomFieldValue('SINGLE_SELECT', 'RED', { options }).string_value).toBe('RED');
    expect(() => parseCustomFieldValue('SINGLE_SELECT', 'GREEN', { options })).toThrow('INVALID_FIELD_VALUE');
  });

  it('MULTI_SELECT: accepts an array of valid option values, rejects a non-array or an invalid element', () => {
    const options = [{ option_value: 'RED' }, { option_value: 'BLUE' }];
    const result = parseCustomFieldValue('MULTI_SELECT', ['RED', 'BLUE'], { options });
    expect(JSON.parse(result.json_value!)).toEqual(['RED', 'BLUE']);
    expect(() => parseCustomFieldValue('MULTI_SELECT', 'RED', { options })).toThrow('INVALID_FIELD_VALUE');
    expect(() => parseCustomFieldValue('MULTI_SELECT', ['GREEN'], { options })).toThrow('INVALID_FIELD_VALUE');
  });

  it('is_required + an empty/missing value throws REQUIRED_FIELD_MISSING', () => {
    expect(() => parseCustomFieldValue('TEXT', null, { isRequired: true })).toThrow('REQUIRED_FIELD_MISSING');
    expect(() => parseCustomFieldValue('TEXT', undefined, { isRequired: true })).toThrow('REQUIRED_FIELD_MISSING');
    expect(() => parseCustomFieldValue('TEXT', '', { isRequired: true })).toThrow('REQUIRED_FIELD_MISSING');
  });

  it('a non-required field accepts an empty/missing value as an all-null typed row', () => {
    const result = parseCustomFieldValue('NUMBER', null, { isRequired: false });
    expect(result).toEqual({ string_value: null, number_value: null, boolean_value: null, date_value: null, json_value: null });
  });
});

describe('readCustomFieldValue round-trips parseCustomFieldValue for every type', () => {
  it('TEXT', () => {
    const typed = parseCustomFieldValue('TEXT', 'hello');
    expect(readCustomFieldValue('TEXT', typed)).toBe('hello');
  });

  it('NUMBER', () => {
    const typed = parseCustomFieldValue('NUMBER', 7);
    expect(readCustomFieldValue('NUMBER', typed)).toBe(7);
  });

  it('CHECKBOX', () => {
    const typed = parseCustomFieldValue('CHECKBOX', true);
    expect(readCustomFieldValue('CHECKBOX', typed)).toBe(true);
  });

  it('DATE', () => {
    const typed = parseCustomFieldValue('DATE', '2026-03-01');
    expect(readCustomFieldValue('DATE', typed)).toBe('2026-03-01');
  });

  it('SINGLE_SELECT', () => {
    const options = [{ option_value: 'RED' }];
    const typed = parseCustomFieldValue('SINGLE_SELECT', 'RED', { options });
    expect(readCustomFieldValue('SINGLE_SELECT', typed)).toBe('RED');
  });

  it('MULTI_SELECT', () => {
    const options = [{ option_value: 'RED' }, { option_value: 'BLUE' }];
    const typed = parseCustomFieldValue('MULTI_SELECT', ['RED', 'BLUE'], { options });
    expect(readCustomFieldValue('MULTI_SELECT', typed)).toEqual(['RED', 'BLUE']);
  });
});
