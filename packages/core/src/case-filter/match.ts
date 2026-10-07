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
      // A CHECKBOX that was never set -- including every entity created while the field's
      // default is unchecked, since an unchecked default is stored as no default -- reads back
      // as null and shows as an empty box, so it counts as "No" here, matching what the user
      // sees. (Explicitly unticking in the editor stores a real false.)
      if (filter.kind === 'CHECKBOX') return (v === true) === filter.value;
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
  // CHECKBOX is the exception: only the case's own suite counts. Every suite shows a definite
  // ticked/unticked box (never-set displays unticked), so inheriting would make a suite that
  // visibly shows unticked still match "Yes" through a ticked parent.
  if (filter.kind === 'CHECKBOX') return matchesValue(filter, chain[0] ?? null);
  if (filter.op === 'is_empty') return chain.every(isEmptyValue);
  return chain.some((sv) => matchesValue(filter, sv));
}

/** AND across every filter; `q` is a case-insensitive substring match on the external id,
 * title, or any of the record's `search_text` (suite names). Pure and
 * synchronous -- the caller loads everything first, then runs this per case. */
export function matchesCase(record: CaseFilterRecord, request: NormalizedCaseFilterRequest): boolean {
  if (request.q) {
    const q = request.q.toLowerCase();
    const hit =
      record.external_id.toLowerCase().includes(q) ||
      record.title.toLowerCase().includes(q) ||
      (record.search_text ?? []).some((t) => t.toLowerCase().includes(q));
    if (!hit) return false;
  }
  return request.filters.every((f) => matchesFilter(record, f));
}
