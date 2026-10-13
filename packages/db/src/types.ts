import type { ColumnType } from 'kysely';

export type Generated<T> = ColumnType<T, T | undefined, T> | T;

export interface ProjectsTable {
  id: string; // UUIDv7
  name: string;
  prefix: string;
  description: string | null;
  settings: Generated<string>;
  created_at: string;
  updated_at: string;
}

export interface TestSuitesTable {
  id: string;
  project_id: string;
  parent_suite_id: string | null;
  name: string;
  description: string | null;
  position: Generated<number>;
  path: string;
  created_at: string;
  updated_at: string;
}

export interface TestCasesTable {
  id: string;
  project_id: string;
  test_suite_id: string;
  external_id: string;
  title: string;
  priority: Generated<string>; // 'HIGH' | 'MEDIUM' | 'LOW' | 'CRITICAL' | 'P1' | 'P2' | 'P3' | 'P4'
  execution_type: Generated<string>; // 'MANUAL' | 'AUTOMATED'
  created_at: string;
  updated_at: string;
}

export interface TestCaseVersionsTable {
  id: string;
  test_case_id: string;
  version_number: number;
  status: Generated<string>; // 'DRAFT' | 'APPROVED' | 'DEPRECATED' (IN_REVIEW was dropped 2026-10-01 -- never written)
  summary: string | null;
  preconditions: string | null;
  author_id: string;
  reviewer_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestStepsTable {
  id: string;
  test_case_version_id: string;
  step_number: number;
  action: string;
  expected_result: string;
  execution_type: Generated<string>;
  created_at: string;
  updated_at: string;
}

export interface TestPlansTable {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: Generated<string>; // 'ACTIVE' | 'LOCKED' | 'ARCHIVED'
  created_at: string;
  updated_at: string;
}

export interface TestRunsTable {
  id: string;
  test_plan_id: string;
  name: string;
  description: string | null;
  status: Generated<string>; // 'OPEN' | 'CLOSED'
  release_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestPlanCasesTable {
  id: string;
  test_plan_id: string;
  test_case_id: string;
  test_case_version_id: string;
  position: Generated<number>;
  created_at: string;
  updated_at: string;
  /** Set when a case that already had results was removed from the plan (the link is
   * retired, not deleted, so its results stay in the runs that recorded them). */
  removed_at: string | null;
  removed_by: string | null;
}

export interface TestResultsTable {
  id: string;
  test_run_id: string;
  test_plan_case_id: string;
  tester_id: string;
  status: Generated<string>; // 'UNTESTED' | 'IN_PROGRESS' | 'COMPLETED' | 'ABORTED'
  verdict: string; // 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'RETEST_REQUIRED' | 'KNOWN_ISSUE'
  duration_ms: number | null; // null = not measured/not supplied, never fabricated
  notes: string | null;
  failure_message: string | null;
  stack_trace: string | null;
  environment: string | null; // JSON object of environment tags
  runner: string | null; // JSON: { name?, run_id?, job_name?, commit_sha?, url? }
  source: string | null; // 'UI' | 'API'
  executed_at: string;
  created_at: string;
  updated_at: string;
}

export interface TestStepResultsTable {
  id: string;
  test_result_id: string;
  test_step_id: string;
  step_number: number;
  verdict: string; // 'PASSED' | 'FAILED' | 'BLOCKED' | 'SKIPPED' | 'UNTESTED'
  actual_result: string | null;
  created_at: string;
}

export interface AuditLogsTable {
  id: string;
  actor_id: string;
  actor_type: string; // 'USER' | 'SERVICE_ACCOUNT' | 'SYSTEM'
  action: string;
  resource_type: string;
  resource_id: string;
  project_id: string | null;
  diff: Generated<string>;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface CustomFieldDefinitionsTable {
  id: string;
  project_id: string | null;
  entity_type: string; // 'TestCase' | 'TestSuite'
  name: string;
  field_label: string;
  field_type: string; // 'TEXT' | 'NUMBER' | 'CHECKBOX' | 'DATE' | 'SINGLE_SELECT' | 'MULTI_SELECT'
  is_required: Generated<number>; // 0 or 1
  default_value: string | null;
  validation_regex: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomFieldOptionsTable {
  id: string;
  custom_field_definition_id: string;
  option_label: string;
  option_value: string;
  position: Generated<number>;
}

export interface CustomFieldValuesTable {
  id: string;
  custom_field_definition_id: string;
  entity_type: string;
  entity_id: string;
  string_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
  date_value: string | null;
  json_value: string | null;
  created_at: string;
  updated_at: string;
}

export interface RolesTable {
  id: string;
  name: string;
  description: string | null;
  is_system_role: Generated<number>;
  created_at: string;
  updated_at: string;
}

export interface PermissionsTable {
  id: string;
  permission_key: string;
  description: string | null;
  module: string;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_id: string;
}

export interface UsersTable {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  status: Generated<string>;
  /** Set when the user must choose a new password before using the app (migration 002). */
  must_change_password: Generated<boolean>;
  /** Consecutive failed sign-ins (or wrong current passwords); reset on success (migration 004). */
  failed_login_count: Generated<number>;
  /** While in the future, sign-in is refused even with the right password (migration 004). */
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserRolesTable {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
}

export interface UserProjectRolesTable {
  id: string;
  user_id: string;
  project_id: string;
  role: string;
  created_at: string;
}

export interface UserPermissionOverridesTable {
  id: string;
  user_id: string;
  project_id: string | null;
  permission_id: string;
  is_granted: number;
  created_at: string;
}

export interface ApiTokensTable {
  id: string;
  project_id: string;
  name: string;
  token_prefix: string;
  token_hash: string;
  capabilities: Generated<string>;
  created_by: string;
  expires_at: string | null;
  is_revoked: Generated<number>;
  last_used_at: string | null;
  created_at: string;
}

export interface SystemSettingsTable {
  key: string;
  value: string;
  description: string | null;
  updated_at: string;
}

export interface ReportSchedulesTable {
  id: string;
  project_id: string;
  name: string;
  sections: string; // JSON
  recipients: string; // JSON string[]
  message: string | null;
  frequency: string; // DAILY | WEEKLY
  weekday: number | null;
  time_of_day: string;
  timezone: string;
  only_when_new_run: Generated<boolean>;
  enabled: Generated<boolean>;
  next_run_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_sent_run_ids: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LastEmailTable {
  id: string;
  project_id: string | null;
  schedule_id: string | null;
  subject: string;
  recipients: string; // JSON string[]
  html: string;
  text_body: string;
  status: string; // SENT | CAPTURED | FAILED
  error: string | null;
  sent_by: string | null;
  created_at: string;
}

export interface Database {
  projects: ProjectsTable;
  test_suites: TestSuitesTable;
  test_cases: TestCasesTable;
  test_case_versions: TestCaseVersionsTable;
  test_steps: TestStepsTable;
  test_plans: TestPlansTable;
  test_runs: TestRunsTable;
  test_plan_cases: TestPlanCasesTable;
  test_results: TestResultsTable;
  test_step_results: TestStepResultsTable;
  audit_logs: AuditLogsTable;
  custom_field_definitions: CustomFieldDefinitionsTable;
  custom_field_options: CustomFieldOptionsTable;
  custom_field_values: CustomFieldValuesTable;
  users: UsersTable;
  user_roles: UserRolesTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  user_project_roles: UserProjectRolesTable;
  user_permission_overrides: UserPermissionOverridesTable;
  api_tokens: ApiTokensTable;
  system_settings: SystemSettingsTable;
  report_schedules: ReportSchedulesTable;
  last_email: LastEmailTable;
  sessions: SessionsTable;
  webhooks: WebhooksTable;
  webhook_deliveries: WebhookDeliveriesTable;
}

/** One row per sign-in (migration 003). The login token carries the id as `sid`. */
export interface SessionsTable {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

/** A project's webhook (migration 010). `events` is a JSON list; `secret` is encrypted. */
export interface WebhooksTable {
  id: string;
  project_id: string;
  name: string;
  url: string;
  format: string; // 'json' | 'slack'
  events: string;
  secret: string;
  enabled: Generated<boolean>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** One event for one webhook: the outbox the delivery worker sends and retries (migration 010). */
export interface WebhookDeliveriesTable {
  id: string;
  webhook_id: string;
  event_id: string;
  event: string;
  payload: string;
  status: string; // 'PENDING' | 'SUCCEEDED' | 'FAILED'
  attempts: Generated<number>;
  next_attempt_at: string;
  last_attempt_at: string | null;
  response_status: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}
