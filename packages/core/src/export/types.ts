import type { CustomFieldType } from '../custom-fields/customFieldValidator.js';

export interface ExportableCustomFieldValue {
  definition_id: string;
  name: string; // the raw definition name -- also the CSV column key (already cf_<slug>-shaped)
  field_label: string;
  field_type: CustomFieldType;
  value: unknown; // already typed via readCustomFieldValue -- null if unset
}

export interface ExportableStep {
  id: string;
  step_number: number;
  action: string;
  expected_result: string;
  execution_type: string; // free string per TestStepsTable, not a closed enum
}

export interface ExportableCaseVersion {
  id: string;
  version_number: number;
  status: string; // 'DRAFT' | 'APPROVED' | 'DEPRECATED'
  summary: string | null;
  preconditions: string | null;
}

export interface ExportableCase {
  id: string;
  external_id: string;
  title: string;
  priority: string; // free string -- do not assume HIGH/MEDIUM/LOW only
  execution_type: string;
  version: ExportableCaseVersion;
  steps: ExportableStep[];
  custom_field_values: ExportableCustomFieldValue[];
}

export interface ExportableSuite {
  id: string;
  name: string;
  description: string | null;
  position: number;
  cases: ExportableCase[];
  sub_suites: ExportableSuite[];
}

export interface ExportableCustomFieldOption {
  option_label: string;
  option_value: string;
}

export interface ExportableCustomFieldDefinition {
  id: string;
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  options: ExportableCustomFieldOption[];
}

export type DefinitionsExportScope =
  | { type: 'PROJECT' }
  | { type: 'SUITE'; suite_id: string; suite_name: string }
  | { type: 'PLAN'; plan_id: string; plan_name: string };

export interface DefinitionsExportBundle {
  object: 'definitions_export_bundle';
  exported_at: string;
  project: { id: string; name: string; prefix: string };
  scope: DefinitionsExportScope;
  status_filter: 'ALL' | 'APPROVED_ONLY';
  // Full catalog of every custom field definition referenced by any case in this bundle --
  // gives a JSON export enough schema to be genuinely re-importable later, not just
  // per-value blobs with no type context.
  custom_field_definitions: ExportableCustomFieldDefinition[];
  suites: ExportableSuite[];
  record_count: { suite_count: number; case_count: number };
}

export interface ExportableExecutionStepResult {
  test_step_id: string;
  step_number: number;
  verdict: string;
  actual_result: string | null;
}

export interface ExportableExecution {
  id: string;
  test_case_id: string;
  test_case_external_id: string;
  test_case_title: string;
  test_case_version_id: string;
  test_case_version_number: number;
  tester_id: string;
  tester_username: string | null; // best-effort resolved; null if the user record is gone
  status: string;
  verdict: string;
  execution_duration_ms: number | null; // null = not measured/not supplied, never fabricated
  notes: string | null;
  execution_timestamp: string;
  // Parsed from test_results.environment -- the environment tags a batch-API caller reported
  // (see batchExecution.ts). Null for results recorded in the UI.
  environment_tags: Record<string, unknown> | null;
  step_results: ExportableExecutionStepResult[];
}

export interface ExecutionResultsExportBundle {
  object: 'execution_results_export_bundle';
  exported_at: string;
  project: { id: string; name: string; prefix: string };
  plan: { id: string; name: string };
  build: { id: string; name: string; status: string; release_date: string | null };
  executions: ExportableExecution[];
  record_count: { execution_count: number };
}

export interface IFileSerializer {
  formatId: 'NATIVE_JSON' | 'STANDARD_CSV';
  contentType: string;
  fileExtension: string;
  serializeDefinitions(bundle: DefinitionsExportBundle): string;
  serializeExecutionResults(bundle: ExecutionResultsExportBundle): string;
}
