/** Shared vocabulary for the case search/filter feature (POST
 * /api/v1/projects/:projectId/case-search). The server is the only place filters are ever
 * evaluated -- the frontend just sends a CaseFilterRequest and narrows what it displays to
 * the returned ids -- so this module is the single source of truth for what a filter means. */

/** How a field's values are compared. ENUM/BOOLEAN cover built-in properties; the rest
 * mirror CustomFieldType exactly, so a custom field's descriptor kind is just its type. */
export type CaseFilterValueKind =
  | 'ENUM'
  | 'BOOLEAN'
  | 'TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'CHECKBOX'
  | 'SINGLE_SELECT'
  | 'MULTI_SELECT';

export type CaseFilterOp =
  | 'any_of'
  | 'all_of'
  | 'contains'
  | 'eq'
  | 'gte'
  | 'lte'
  | 'between'
  | 'is'
  | 'is_empty'
  | 'is_not_empty';

/** One filterable property, as advertised by GET .../case-search/fields. */
export interface CaseFilterFieldDescriptor {
  /** `priority` | `execution_type` | `version_status` | `in_plan` | `verdict` |
   * `cf:<definitionId>` | `suite_cf:<definitionId>` */
  key: string;
  label: string;
  kind: CaseFilterValueKind;
  source: 'builtin' | 'case_custom_field' | 'suite_custom_field';
  /** Known values for ENUM/SINGLE_SELECT/MULTI_SELECT. */
  options?: Array<{ value: string; label: string }>;
  /** When true, any_of/all_of values must be one of `options` (a typo is a 400, not a
   * silent zero-match). False for open-ended built-ins like priority, whose stored values
   * can come from imports. */
  strict_options?: boolean;
  /** Request-level parameter this field needs to be meaningful. */
  requires?: 'plan_id' | 'build_id';
}

export interface CaseFilter {
  field: string;
  op: CaseFilterOp | string;
  value?: unknown;
}

export interface CaseFilterRequest {
  q?: string;
  filters?: CaseFilter[];
}

/** A filter that passed validation -- `value` is already coerced to the op's shape. */
export interface NormalizedCaseFilter {
  field: string;
  kind: CaseFilterValueKind;
  op: CaseFilterOp;
  /** true for suite_cf: fields -- the record's value is the suite ancestor chain. */
  inherited: boolean;
  value: unknown;
}

export interface NormalizedCaseFilterRequest {
  q: string;
  filters: NormalizedCaseFilter[];
}

/** Everything the matcher needs about one case. `values` is keyed by field key; for a
 * `suite_cf:` field the entry is an array of that field's value on the case's own suite
 * followed by each ancestor suite (own suite first). */
export interface CaseFilterRecord {
  external_id: string;
  title: string;
  values: Record<string, unknown>;
  /** Extra text the free-text search `q` also matches -- the names of the case's suite and
   * every suite above it. */
  search_text?: string[];
}

export const OPS_BY_KIND: Record<CaseFilterValueKind, CaseFilterOp[]> = {
  ENUM: ['any_of'],
  SINGLE_SELECT: ['any_of'],
  MULTI_SELECT: ['any_of', 'all_of'],
  TEXT: ['contains'],
  NUMBER: ['eq', 'gte', 'lte', 'between'],
  DATE: ['eq', 'gte', 'lte', 'between'],
  BOOLEAN: ['is'],
  CHECKBOX: ['is'],
};

/** Ops valid for every kind, taking no value. */
export const EMPTINESS_OPS: CaseFilterOp[] = ['is_empty', 'is_not_empty'];

export const MAX_CASE_FILTERS = 50;
export const MAX_CASE_SEARCH_QUERY_LENGTH = 200;
