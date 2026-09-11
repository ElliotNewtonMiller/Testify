import type { Readable } from 'node:stream';

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
  custom_fields: Record<string, string>;
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
  formatId: 'TESTLINK_XML' | 'NATIVE_JSON' | 'STANDARD_CSV';
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
  field_type?: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'DATE' | 'SINGLE_SELECT' | 'MULTI_SELECT' | 'MARKDOWN_TEXT';
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
}

export interface DryRunWarning {
  line_or_node: string;
  code: string;
  message: string;
}

export interface UnmappedCustomField {
  incoming_key: string;
  sample_value: string;
  detected_type: string;
}

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

export interface ImportExecuteResult {
  object: 'import_execute_result';
  summary: {
    imported_suites_count: number;
    imported_cases_count: number;
    created_versions_count: number;
    overwritten_cases_count: number;
    skipped_cases_count: number;
    auto_created_custom_fields_count: number;
    duration_ms: number;
  };
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
  status?: 'UNTESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED';
  duration_ms?: number;
  executed_at?: string;
  notes?: string;
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
}
