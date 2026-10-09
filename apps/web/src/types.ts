// Shared data shapes for the web app (what the API returns, as the app uses it).
import type { TestCaseGridItem } from "./components/TestCaseQueueGrid";
import type { SpecCaseGridItem } from "./components/SpecCaseListGrid";

export interface Step {
  id: string;
  step_number: number;
  action: string;
  expected_result: string;
}

export interface TestCase extends TestCaseGridItem {
  execution_type: string;
  version_number: number;
  summary: string;
  preconditions: string;
  steps: Step[];
  latest_execution_id: string | null;
  latest_notes?: string | null;
  test_suite_id?: string;
}

export interface WorkspaceData {
  project: { id: string; name: string; prefix: string };
  suites: Array<{ id: string; name: string; path: string }>;
  plan: { id: string; name: string; status: string };
  build: { id: string; name: string; status: string };
  cases: TestCase[];
}

/** Why Execute mode has (or hasn't) cases to show. */
export type ExecWorkspaceStatus = "NO_PLAN" | "LOADING" | "READY" | "ERROR";

// --- Specification mode: types for GET /api/v1/projects/:id/spec-tree and
// GET /api/v1/test-cases/:id/latest-version. Curation-only -- read-only case/step detail,
// plus per-case/suite plan-inclusion toggles. See docs/rfc_01_domain_model.md §2.3.
export interface SpecSuiteNode {
  id: string;
  name: string;
  path: string;
  parent_suite_id: string | null;
  children: SpecSuiteNode[];
  total_case_count: number;
  in_plan_count: number;
}

export interface SpecTreeData {
  project: { id: string; name: string; prefix: string; settings: { allow_draft_plan_linking: boolean } };
  suites: SpecSuiteNode[];
  cases: SpecCaseGridItem[];
}

export interface SpecCaseDetail {
  test_case: { id: string; external_id: string; title: string; priority: string; execution_type: string };
  version: {
    id: string;
    version_number: number;
    status: string;
    summary: string | null;
    preconditions: string | null;
    steps: Step[];
  };
}

export type CustomFieldType = "TEXT" | "NUMBER" | "CHECKBOX" | "DATE" | "SINGLE_SELECT" | "MULTI_SELECT";

export interface CustomFieldDefinition {
  id: string;
  entity_type: "TestCase" | "TestSuite";
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  is_required: boolean;
  default_value: string | null;
  validation_regex: string | null;
  options: Array<{ option_label: string; option_value: string }>;
}

export interface CustomFieldValueEntry {
  definition: CustomFieldDefinition;
  value: unknown;
}
