import type { CaseFilterRecord, NormalizedCaseFilter, NormalizedCaseFilterRequest } from './types.js';

/** Same "nothing here" semantics as customFieldValidator's isEmpty (an explicit `false`
 * CHECKBOX is a real value, not empty). */
function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function matchesValue(filter: NormalizedCaseFilter, v: unknown): boolean {
  switch (filter.op) {
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'is_empty':
      return isEmptyValue(v);
    case 'any_of': {
      const wanted = filter.value as string[];
      if (Array.isArray(v)) return v.some((x) => wanted.includes(String(x)));
      return typeof v === 'string' && wanted.includes(v);
    }
    case 'all_of': {
      const wanted = filter.value as string[];
      return Array.isArray(v) && wanted.every((w) => v.includes(w));
    }
    case 'contains':
      return typeof v === 'string' && v.toLowerCase().includes(filter.value as string);
    case 'is':
      return v === filter.value;
    case 'eq':
      return !isEmptyValue(v) && v === filter.value;
    case 'gte':
      return !isEmptyValue(v) && (v as number | string) >= (filter.value as number | string);
    case 'lte':
      return !isEmptyValue(v) && (v as number | string) <= (filter.value as number | string);
    case 'between': {
      if (isEmptyValue(v)) return false;
      const [lo, hi] = filter.value as [number | string, number | string];
      return (v as number | string) >= lo && (v as number | string) <= hi;
    }
    default:
      return false;
  }
}

function matchesFilter(record: CaseFilterRecord, filter: NormalizedCaseFilter): boolean {
  const v = record.values[filter.field];
  if (!filter.inherited) return matchesValue(filter, v);

  // suite_cf: -- the value is the suite ancestor chain (own suite first). A case matches if
  // its own suite OR any ancestor satisfies the filter, so a value set on a parent folder
  // applies to everything under it; "is empty" means no suite in the chain has a value.
  const chain = Array.isArray(v) ? v : [];
  if (filter.op === 'is_empty') return chain.every(isEmptyValue);
  return chain.some((sv) => matchesValue(filter, sv));
}

/** AND across every filter; `q` is a case-insensitive substring match on external id or
 * title. Pure and synchronous -- the route loads everything first, then runs this per case. */
export function matchesCase(record: CaseFilterRecord, request: NormalizedCaseFilterRequest): boolean {
  if (request.q) {
    const q = request.q.toLowerCase();
    if (!record.external_id.toLowerCase().includes(q) && !record.title.toLowerCase().includes(q)) {
      return false;
    }
  }
  return request.filters.every((f) => matchesFilter(record, f));
}
