import {
  EMPTINESS_OPS,
  MAX_CASE_FILTERS,
  MAX_CASE_SEARCH_QUERY_LENGTH,
  OPS_BY_KIND,
  type CaseFilterFieldDescriptor,
  type CaseFilterOp,
  type NormalizedCaseFilter,
  type NormalizedCaseFilterRequest,
} from './types.js';

export type CaseFilterValidationResult =
  | { ok: true; request: NormalizedCaseFilterRequest }
  | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceScalar(kind: 'NUMBER' | 'DATE', raw: unknown): number | string | null {
  if (kind === 'NUMBER') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return typeof raw === 'string' && DATE_RE.test(raw) ? raw : null;
}

/** Validates a raw request body against the catalog of filterable fields and returns it
 * normalized (values coerced to each op's shape), or every problem found -- each error
 * names the offending filter's index so an API caller can tell which one to fix. */
export function validateCaseFilterRequest(
  raw: unknown,
  fields: Map<string, CaseFilterFieldDescriptor>
): CaseFilterValidationResult {
  const errors: string[] = [];
  const body = (raw && typeof raw === 'object' ? raw : {}) as { q?: unknown; filters?: unknown };

  let q = '';
  if (body.q !== undefined && body.q !== null) {
    if (typeof body.q !== 'string') errors.push('q must be a string');
    else if (body.q.length > MAX_CASE_SEARCH_QUERY_LENGTH) {
      errors.push(`q must be at most ${MAX_CASE_SEARCH_QUERY_LENGTH} characters`);
    } else q = body.q.trim();
  }

  const rawFilters = body.filters ?? [];
  if (!Array.isArray(rawFilters)) {
    return { ok: false, errors: [...errors, 'filters must be an array'] };
  }
  if (rawFilters.length > MAX_CASE_FILTERS) {
    return { ok: false, errors: [...errors, `at most ${MAX_CASE_FILTERS} filters are allowed`] };
  }

  const filters: NormalizedCaseFilter[] = [];
  rawFilters.forEach((f: any, i: number) => {
    const at = `filters[${i}]`;
    if (!f || typeof f !== 'object' || typeof f.field !== 'string' || typeof f.op !== 'string') {
      errors.push(`${at}: each filter needs a string "field" and "op"`);
      return;
    }
    const descriptor = fields.get(f.field);
    if (!descriptor) {
      errors.push(`${at}: unknown field '${f.field}'`);
      return;
    }
    const op = f.op as CaseFilterOp;
    const kind = descriptor.kind;
    const inherited = descriptor.source === 'suite_custom_field';
    const push = (value: unknown) => filters.push({ field: f.field, kind, op, inherited, value });

    if (EMPTINESS_OPS.includes(op)) {
      push(null);
      return;
    }
    if (!OPS_BY_KIND[kind].includes(op)) {
      errors.push(
        `${at}: op '${f.op}' is not valid for '${f.field}' (allowed: ${[...OPS_BY_KIND[kind], ...EMPTINESS_OPS].join(', ')})`
      );
      return;
    }

    switch (op) {
      case 'any_of':
      case 'all_of': {
        const v = f.value;
        if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string')) {
          errors.push(`${at}: value must be a non-empty array of strings`);
          return;
        }
        if (descriptor.strict_options && descriptor.options) {
          const allowed = new Set(descriptor.options.map((o) => o.value));
          const bad = v.filter((x: string) => !allowed.has(x));
          if (bad.length > 0) {
            errors.push(`${at}: ${bad.map((b: string) => `'${b}'`).join(', ')} not an option of '${f.field}'`);
            return;
          }
        }
        push([...new Set(v as string[])]);
        return;
      }
      case 'contains': {
        if (typeof f.value !== 'string' || f.value.trim() === '') {
          errors.push(`${at}: value must be a non-empty string`);
          return;
        }
        push(f.value.trim().toLowerCase());
        return;
      }
      case 'is': {
        if (typeof f.value !== 'boolean') {
          errors.push(`${at}: value must be true or false`);
          return;
        }
        push(f.value);
        return;
      }
      case 'eq':
      case 'gte':
      case 'lte': {
        const v = coerceScalar(kind as 'NUMBER' | 'DATE', f.value);
        if (v === null) {
          errors.push(`${at}: value must be a ${kind === 'NUMBER' ? 'number' : 'YYYY-MM-DD date'}`);
          return;
        }
        push(v);
        return;
      }
      case 'between': {
        const pair = Array.isArray(f.value) && f.value.length === 2 ? f.value : null;
        const lo = pair ? coerceScalar(kind as 'NUMBER' | 'DATE', pair[0]) : null;
        const hi = pair ? coerceScalar(kind as 'NUMBER' | 'DATE', pair[1]) : null;
        if (lo === null || hi === null) {
          errors.push(`${at}: value must be a [min, max] pair of ${kind === 'NUMBER' ? 'numbers' : 'YYYY-MM-DD dates'}`);
          return;
        }
        push(lo <= hi ? [lo, hi] : [hi, lo]);
        return;
      }
    }
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, request: { q, filters } };
}
