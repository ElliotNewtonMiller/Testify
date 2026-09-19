import { describe, it, expect } from 'vitest';
import { inferFieldType } from '../src/custom-fields/inferFieldType.js';

describe('inferFieldType', () => {
  it('infers NUMBER when every sample parses as a finite number', () => {
    expect(inferFieldType(['1', '2', '3.5', '-4'])).toBe('NUMBER');
  });

  it('infers CHECKBOX for boolean-ish tokens, case-insensitively', () => {
    expect(inferFieldType(['true', 'FALSE', 'Yes', 'no'])).toBe('CHECKBOX');
  });

  it('infers CHECKBOX (not NUMBER) for a lone "1"/"0" sample -- checked before NUMBER', () => {
    expect(inferFieldType(['1'])).toBe('CHECKBOX');
    expect(inferFieldType(['0'])).toBe('CHECKBOX');
  });

  it('infers DATE for ISO-shaped date strings', () => {
    expect(inferFieldType(['2024-01-15', '2024-02-20'])).toBe('DATE');
  });

  it('infers DATE for US-style MM/DD/YYYY strings', () => {
    expect(inferFieldType(['01/15/2024', '2/20/2024'])).toBe('DATE');
  });

  it('falls back to TEXT for freeform strings', () => {
    expect(inferFieldType(['Stripe', 'PayPal', 'Chrome'])).toBe('TEXT');
  });

  it('falls back to TEXT for empty/all-blank samples', () => {
    expect(inferFieldType([])).toBe('TEXT');
    expect(inferFieldType(['', '  ', ''])).toBe('TEXT');
  });

  it('falls back to TEXT for a mix of numeric and non-numeric values', () => {
    expect(inferFieldType(['1', 'two', '3'])).toBe('TEXT');
  });

  it('never infers SINGLE_SELECT/MULTI_SELECT, even for a small repeated value set', () => {
    const result = inferFieldType(['High', 'Medium', 'High', 'Low', 'Medium']);
    expect(result).not.toBe('SINGLE_SELECT');
    expect(result).not.toBe('MULTI_SELECT');
    expect(result).toBe('TEXT');
  });

  it('ignores blank entries mixed in with real samples', () => {
    expect(inferFieldType(['5', '', '10', '  '])).toBe('NUMBER');
  });
});
