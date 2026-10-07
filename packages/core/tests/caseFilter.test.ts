import { describe, it, expect } from 'vitest';
import {
  matchesCase,
  validateCaseFilterRequest,
  type CaseFilterFieldDescriptor,
  type CaseFilterRecord,
} from '../src/index.js';

const fields = new Map<string, CaseFilterFieldDescriptor>(
  (
    [
      { key: 'priority', label: 'Priority', kind: 'ENUM', source: 'builtin', options: [{ value: 'HIGH', label: 'HIGH' }], strict_options: false },
      { key: 'version_status', label: 'Status', kind: 'ENUM', source: 'builtin', options: [{ value: 'DRAFT', label: 'DRAFT' }, { value: 'APPROVED', label: 'APPROVED' }], strict_options: true },
      { key: 'in_plan', label: 'In Plan', kind: 'BOOLEAN', source: 'builtin' },
      { key: 'cf:multi', label: 'Tags', kind: 'MULTI_SELECT', source: 'case_custom_field', options: ['a', 'b', 'c'].map((v) => ({ value: v, label: v })), strict_options: true },
      { key: 'cf:text', label: 'Notes', kind: 'TEXT', source: 'case_custom_field' },
      { key: 'cf:num', label: 'Score', kind: 'NUMBER', source: 'case_custom_field' },
      { key: 'cf:date', label: 'Due', kind: 'DATE', source: 'case_custom_field' },
      { key: 'cf:check', label: 'Automated', kind: 'CHECKBOX', source: 'case_custom_field' },
      { key: 'suite_cf:area', label: 'Suite: Area', kind: 'SINGLE_SELECT', source: 'suite_custom_field', options: ['ui', 'api'].map((v) => ({ value: v, label: v })), strict_options: true },
    ] as CaseFilterFieldDescriptor[]
  ).map((f) => [f.key, f])
);

function record(values: Record<string, unknown>, external_id = 'TFY-1', title = 'Login works'): CaseFilterRecord {
  return { external_id, title, values };
}

function match(body: unknown, rec: CaseFilterRecord): boolean {
  const v = validateCaseFilterRequest(body, fields);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return matchesCase(rec, v.request);
}

describe('validateCaseFilterRequest', () => {
  it('accepts an empty request', () => {
    const v = validateCaseFilterRequest({}, fields);
    expect(v).toEqual({ ok: true, request: { q: '', filters: [] } });
  });

  it('reports unknown fields, invalid ops, bad values and unconfigured options with the filter index', () => {
    const v = validateCaseFilterRequest(
      {
        filters: [
          { field: 'nope', op: 'any_of', value: ['x'] },
          { field: 'cf:num', op: 'contains', value: 'x' },
          { field: 'cf:num', op: 'gte', value: 'abc' },
          { field: 'cf:multi', op: 'any_of', value: ['z'] },
          { field: 'cf:date', op: 'between', value: ['2026-01-01'] },
          { field: 'in_plan', op: 'is', value: 'yes' },
        ],
      },
      fields
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors).toHaveLength(6);
    expect(v.errors[0]).toMatch(/^filters\[0\]: unknown field/);
    expect(v.errors[1]).toMatch(/^filters\[1\]: op 'contains' is not valid/);
    expect(v.errors[2]).toMatch(/^filters\[2\]/);
    expect(v.errors[3]).toMatch(/'z' not an option/);
    expect(v.errors[4]).toMatch(/^filters\[4\]/);
    expect(v.errors[5]).toMatch(/^filters\[5\]/);
  });

  it('does not enforce options on a non-strict enum (imported priorities)', () => {
    expect(validateCaseFilterRequest({ filters: [{ field: 'priority', op: 'any_of', value: ['P1'] }] }, fields).ok).toBe(true);
  });

  it('rejects a non-string q and too many filters', () => {
    expect(validateCaseFilterRequest({ q: 5 }, fields).ok).toBe(false);
    const many = Array.from({ length: 51 }, () => ({ field: 'in_plan', op: 'is', value: true }));
    expect(validateCaseFilterRequest({ filters: many }, fields).ok).toBe(false);
  });
});

describe('matchesCase', () => {
  it('q matches external id or title, case-insensitively', () => {
    expect(match({ q: 'tfy-1' }, record({}))).toBe(true);
    expect(match({ q: 'LOGIN' }, record({}))).toBe(true);
    expect(match({ q: 'logout' }, record({}))).toBe(false);
  });

  it('q also matches the extra search text (suite names)', () => {
    const rec = { ...record({}), search_text: ['Checkout', 'Payments'] };
    expect(match({ q: 'payme' }, rec)).toBe(true);
    expect(match({ q: 'shipping' }, rec)).toBe(false);
  });

  it('ANDs filters together', () => {
    const rec = record({ priority: 'HIGH', in_plan: false });
    expect(match({ filters: [{ field: 'priority', op: 'any_of', value: ['HIGH'] }] }, rec)).toBe(true);
    expect(
      match({ filters: [{ field: 'priority', op: 'any_of', value: ['HIGH'] }, { field: 'in_plan', op: 'is', value: true }] }, rec)
    ).toBe(false);
  });

  it('MULTI_SELECT any_of / all_of', () => {
    const rec = record({ 'cf:multi': ['a', 'b'] });
    expect(match({ filters: [{ field: 'cf:multi', op: 'any_of', value: ['b', 'c'] }] }, rec)).toBe(true);
    expect(match({ filters: [{ field: 'cf:multi', op: 'all_of', value: ['a', 'b'] }] }, rec)).toBe(true);
    expect(match({ filters: [{ field: 'cf:multi', op: 'all_of', value: ['a', 'c'] }] }, rec)).toBe(false);
    expect(match({ filters: [{ field: 'cf:multi', op: 'any_of', value: ['c'] }] }, rec)).toBe(false);
    expect(match({ filters: [{ field: 'cf:multi', op: 'any_of', value: ['a'] }] }, record({ 'cf:multi': null }))).toBe(false);
  });

  it('TEXT contains is case-insensitive', () => {
    expect(match({ filters: [{ field: 'cf:text', op: 'contains', value: 'FLAKY' }] }, record({ 'cf:text': 'a flaky one' }))).toBe(true);
    expect(match({ filters: [{ field: 'cf:text', op: 'contains', value: 'x' }] }, record({ 'cf:text': null }))).toBe(false);
  });

  it('NUMBER and DATE comparisons, including between and string-number coercion', () => {
    const rec = record({ 'cf:num': 5, 'cf:date': '2026-05-10' });
    expect(match({ filters: [{ field: 'cf:num', op: 'eq', value: '5' }] }, rec)).toBe(true);
    expect(match({ filters: [{ field: 'cf:num', op: 'gte', value: 6 }] }, rec)).toBe(false);
    expect(match({ filters: [{ field: 'cf:num', op: 'lte', value: 5 }] }, rec)).toBe(true);
    expect(match({ filters: [{ field: 'cf:num', op: 'between', value: [10, 1] }] }, rec)).toBe(true); // swapped bounds normalized
    expect(match({ filters: [{ field: 'cf:date', op: 'between', value: ['2026-05-01', '2026-05-31'] }] }, rec)).toBe(true);
    expect(match({ filters: [{ field: 'cf:date', op: 'gte', value: '2026-06-01' }] }, rec)).toBe(false);
    expect(match({ filters: [{ field: 'cf:num', op: 'lte', value: 100 }] }, record({ 'cf:num': null }))).toBe(false);
  });

  it('CHECKBOX is: an unset box counts as "No" (it displays unticked); is_empty still tells them apart', () => {
    expect(match({ filters: [{ field: 'cf:check', op: 'is', value: false }] }, record({ 'cf:check': false }))).toBe(true);
    expect(match({ filters: [{ field: 'cf:check', op: 'is', value: false }] }, record({ 'cf:check': null }))).toBe(true);
    expect(match({ filters: [{ field: 'cf:check', op: 'is', value: true }] }, record({ 'cf:check': null }))).toBe(false);
    expect(match({ filters: [{ field: 'cf:check', op: 'is_empty' }] }, record({ 'cf:check': false }))).toBe(false);
  });

  it('suite_cf: CHECKBOX only looks at the case\'s own suite, not ancestors', () => {
    const fieldsWithSuiteCheck = new Map(fields);
    fieldsWithSuiteCheck.set('suite_cf:flag', { key: 'suite_cf:flag', label: 'Flag', kind: 'CHECKBOX', source: 'suite_custom_field' });
    const run = (value: boolean, chain: unknown[]) => {
      const v = validateCaseFilterRequest({ filters: [{ field: 'suite_cf:flag', op: 'is', value }] }, fieldsWithSuiteCheck);
      if (!v.ok) throw new Error(v.errors.join('; '));
      return matchesCase(record({ 'suite_cf:flag': chain }), v.request);
    };
    // Unticked child under a ticked parent: "No", not "Yes".
    expect(run(false, [null, true])).toBe(true);
    expect(run(true, [null, true])).toBe(false);
    expect(run(true, [true, null])).toBe(true);
  });

  it('is_empty / is_not_empty treat null, "" and [] as empty', () => {
    for (const empty of [null, '', [], undefined]) {
      expect(match({ filters: [{ field: 'cf:multi', op: 'is_empty' }] }, record({ 'cf:multi': empty }))).toBe(true);
      expect(match({ filters: [{ field: 'cf:multi', op: 'is_not_empty' }] }, record({ 'cf:multi': empty }))).toBe(false);
    }
  });

  it('suite_cf: matches if the own suite or any ancestor satisfies it', () => {
    const filter = { filters: [{ field: 'suite_cf:area', op: 'any_of', value: ['api'] }] };
    expect(match(filter, record({ 'suite_cf:area': [null, null, 'api'] }))).toBe(true);
    expect(match(filter, record({ 'suite_cf:area': ['ui', null] }))).toBe(false);
    expect(match({ filters: [{ field: 'suite_cf:area', op: 'is_empty' }] }, record({ 'suite_cf:area': [null, null] }))).toBe(true);
    expect(match({ filters: [{ field: 'suite_cf:area', op: 'is_empty' }] }, record({ 'suite_cf:area': [null, 'ui'] }))).toBe(false);
  });
});
