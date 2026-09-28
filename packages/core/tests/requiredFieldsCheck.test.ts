import { describe, it, expect } from 'vitest';
import { findUnsatisfiedRequiredFields } from '../src/custom-fields/requiredFieldsCheck.js';

function def(overrides: Partial<{ id: string; is_required: boolean; default_value: string | null; field_label: string }> = {}) {
  return {
    id: overrides.id ?? 'def_1',
    is_required: overrides.is_required ?? true,
    default_value: overrides.default_value ?? null,
    field_label: overrides.field_label ?? 'Field',
  };
}

describe('findUnsatisfiedRequiredFields', () => {
  it('flags a required field with no default and no value as unsatisfied', () => {
    const result = findUnsatisfiedRequiredFields([def()], []);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('def_1');
  });

  it('does not flag a non-required field, regardless of value', () => {
    const result = findUnsatisfiedRequiredFields([def({ is_required: false })], []);
    expect(result).toHaveLength(0);
  });

  it('does not flag a required field that has a default_value, even with no recorded value', () => {
    const result = findUnsatisfiedRequiredFields([def({ default_value: 'fallback' })], []);
    expect(result).toHaveLength(0);
  });

  it('does not flag a required field once a real value is recorded', () => {
    const values = [{ definition: { id: 'def_1' }, value: 'hello' }];
    const result = findUnsatisfiedRequiredFields([def()], values);
    expect(result).toHaveLength(0);
  });

  it('treats null/undefined/empty-string values as not provided', () => {
    for (const v of [null, undefined, '']) {
      const values = [{ definition: { id: 'def_1' }, value: v }];
      const result = findUnsatisfiedRequiredFields([def()], values);
      expect(result).toHaveLength(1);
    }
  });

  it('treats an explicit `false` (an unchecked CHECKBOX someone actually touched) as provided, not missing', () => {
    const values = [{ definition: { id: 'def_1' }, value: false }];
    const result = findUnsatisfiedRequiredFields([def()], values);
    expect(result).toHaveLength(0);
  });

  it('treats a numeric 0 as provided, not missing', () => {
    const values = [{ definition: { id: 'def_1' }, value: 0 }];
    const result = findUnsatisfiedRequiredFields([def()], values);
    expect(result).toHaveLength(0);
  });

  it('handles a mix of satisfied and unsatisfied definitions, returning only the unsatisfied ones', () => {
    const definitions = [
      def({ id: 'a', is_required: true, default_value: null }), // unsatisfied: no value, no default
      def({ id: 'b', is_required: true, default_value: 'x' }), // satisfied: has default
      def({ id: 'c', is_required: false, default_value: null }), // satisfied: not required
      def({ id: 'd', is_required: true, default_value: null }), // satisfied: has a value
    ];
    const values = [{ definition: { id: 'd' }, value: 'provided' }];
    const result = findUnsatisfiedRequiredFields(definitions, values);
    expect(result.map((d) => d.id)).toEqual(['a']);
  });

  it('an empty definitions list (brand-new case, no fields at all) is always satisfied', () => {
    expect(findUnsatisfiedRequiredFields([], [])).toHaveLength(0);
  });
});
