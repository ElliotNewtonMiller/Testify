import type { Readable } from 'node:stream';
import type { CustomFieldType } from '../custom-fields/customFieldValidator.js';

export interface ParsedStep {
  step_number: number;
  actions: string;
  expected_results: string;
  execution_type: 'MANUAL' | 'AUTOMATED';
}

export interface ParsedCase {
  external_id?: string;
  title: string;
  summary?: string;
  preconditions?: string;
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  execution_type: 'MANUAL' | 'AUTOMATED';
  steps: ParsedStep[];
  // Always a flat string map, even for numeric/boolean-ish data (e.g. JUnit's
  // junit_duration_seconds) -- real typing happens downstream via inferFieldType()/
  // parseCustomFieldValue() once a mapping decision is made, not at parse time.
  custom_fields: Record<string, string>;
  // Parser-level warning codes for this specific case (e.g. TestRailCsvParser's
  // STEP_EXPECTED_MISALIGNED/UNSUPPORTED_TESTRAIL_COLUMN_FORMAT) -- surfaced by the
  // dry-run route as ordinary DryRunWarning entries. Deliberately separate from
  // custom_fields so a parser-level warning can never masquerade as a mappable column.
  parser_warnings?: string[];
}

export interface ParsedSuite {
  name: string;
  details?: string;
  node_order: number;
  sub_suites: ParsedSuite[];
  test_cases: ParsedCase[];
}

export interface ParseOptions {
  defaultImportance?: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  defaultExecutionType?: 'MANUAL' | 'AUTOMATED' | string;
}

export interface IFileParser {
  formatId: 'TESTLINK_XML' | 'NATIVE_JSON' | 'STANDARD_CSV' | 'JUNIT_XML' | 'TESTRAIL_CSV';
  canHandle(fileHeader: Buffer, filename: string): boolean;
  parseStream(
    inputStream: Readable | ReadableStream | AsyncIterable<Buffer | string>,
    options?: ParseOptions
  ): AsyncIterable<ParsedSuite>;
}

export interface CustomFieldMappingConfig {
  incoming_key: string;
  action: 'DROP' | 'AUTO_CREATE' | 'ROUTE_TO_EXISTING';
  target_field_id?: string;
  field_name?: string;
  field_type?: CustomFieldType;
}

export type DuplicateAction = 'CREATE_NEW' | 'OVERWRITE' | 'VERSION_UP' | 'SKIP';

export interface DuplicateResolutionConfig {
  default_action: DuplicateAction;
  apply_to_all_future_duplicates?: boolean;
  overrides?: Array<{
    external_id?: string;
    title?: string;
    action: DuplicateAction;
  }>;
}

export interface ImportConfiguration {
  field_mappings?: CustomFieldMappingConfig[];
  duplicate_resolution?: DuplicateResolutionConfig;
}

export interface DryRunSummary {
  total_suites_detected: number;
  total_cases_detected: number;
  suites_to_create: number;
  cases_to_create: number;
  cases_to_version_up: number;
  cases_to_overwrite: number;
  cases_skipped: number;
  unmapped_custom_fields_count: number;
  validation_warnings_count: number;
  // Informational only -- always equal to unmapped_custom_fields_count today, since every
  // unmapped field now gets a real inferred type (see inferFieldType()) rather than the
  // previous hardcoded 'STRING' placeholder.
  auto_inferred_field_types_count?: number;
}

export interface DryRunWarning {
  line_or_node: string;
  code: string;
  message: string;
  /** For case-level warnings: which case, so the user can find it. */
  case_external_id?: string;
  case_title?: string;
  /** "Parent / Child" path of the suite the case is in, as it appears in the file. */
  suite_path?: string;
}

export interface UnmappedCustomField {
  incoming_key: string;
  sample_value: string;
  // Up to 5 distinct, non-empty samples observed during the dry-run walk -- what
  // inferFieldType() bases detected_type on, and shown to the user so they can judge the
  // inference themselves before accepting/overriding it.
  sample_values?: string[];
  /** Every distinct non-empty value in the file for this column (up to
   * MAX_DISTINCT_IMPORT_VALUES), so the wizard can preview the options a new
   * single-/multi-select field would get. distinct_values_truncated is true past the cap. */
  distinct_values?: string[];
  distinct_values_truncated?: boolean;
  detected_type: CustomFieldType;
}

export const MAX_DISTINCT_IMPORT_VALUES = 200;

export interface HierarchyPreviewNode {
  name: string;
  action: string;
  cases_count: number;
  children: HierarchyPreviewNode[];
}

export interface DryRunResult {
  dry_run_summary: DryRunSummary;
  warnings: DryRunWarning[];
  unmapped_custom_fields: UnmappedCustomField[];
  hierarchy_preview: HierarchyPreviewNode[];
}

export interface SkippedCustomFieldValueWarning {
  case_external_id_or_title: string;
  incoming_key: string;
  reason: string;
}

export interface ImportExecuteResult {
  object: 'import_execute_result';
  summary: {
    imported_suites_count: number;
    imported_cases_count: number;
    created_versions_count: number;
    overwritten_cases_count: number;
    skipped_cases_count: number;
    auto_created_custom_fields_count: number;
    // Count of per-value validation failures (e.g. a value that doesn't match a
    // SINGLE_SELECT field's configured options) caught and skipped rather than aborting
    // the whole import -- see apps/server/src/routes/ingestion.ts's execute handler.
    skipped_custom_field_values_count: number;
    duration_ms: number;
  };
  skipped_custom_field_value_warnings?: SkippedCustomFieldValueWarning[];
}

export interface CaseIdentifier {
  external_id?: string;
  by_uuid?: string;
  by_path_title?: {
    suite_path: string;
    title: string;
  };
}

export interface ExecutionStepResult {
  test_step_id?: string;
  step_number?: number;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'UNTESTED';
  actual_result?: string;
}

export interface BatchExecutionItem {
  case_identifier: CaseIdentifier;
  verdict: 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'RETEST_REQUIRED' | 'KNOWN_ISSUE';
  status?: 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED';
  duration_ms?: number;
  executed_at?: string;
  notes?: string;
  /** Short failure reason (e.g. JUnit's failure message attribute). Shown in reports. */
  failure_message?: string;
  stack_trace?: string;
  environment_tags?: Record<string, string>;
  step_results?: ExecutionStepResult[];
}

export interface BatchExecutionRequest {
  environment?: string;
  runner_info?: {
    name?: string;
    run_id?: string;
    job_name?: string;
    commit_sha?: string;
    /** Link back to the CI run, shown in reports. */
    url?: string;
  };
  executions: BatchExecutionItem[];
}

export interface BatchExecutionSingleResult {
  index: number;
  status: number;
  execution_id?: string;
  case_id?: string;
  verdict?: string;
  error?: string;
  /** Why the item was refused, e.g. INVALID_RESULT, CASE_NOT_FOUND, UNKNOWN_STEP. */
  code?: string;
  /** For a refused item: each problem, by field name. */
  invalid_params?: Array<{ name: string; reason: string }>;
}

export interface BatchExecutionResponse {
  object: 'batch_execution_result';
  summary: {
    total_submitted: number;
    successful: number;
    failed: number;
    duration_ms: number;
  };
  results: BatchExecutionSingleResult[];
  /** The run's status after this batch -- CLOSED if it just auto-closed because every case
   * in the plan now has a result. */
  build_status?: 'OPEN' | 'CLOSED';
}
