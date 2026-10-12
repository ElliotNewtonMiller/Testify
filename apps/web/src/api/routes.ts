/**
 * Every API address the web app calls, in one place. Lists and creation live under the parent
 * (`/projects/:id/plans`); each item is addressed by its own id (`/plans/:id`). See
 * docs/rfc_03_api_and_xml_contracts.md for the conventions.
 */
const V1 = "/api/v1";

type QueryValue = string | number | boolean | null | undefined;

/** Appends the query parameters that have a value (`false`, `null`, `undefined` and "" are left out). */
export function withQuery(path: string, params: Record<string, QueryValue>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

const enc = encodeURIComponent;
const force = (path: string, forced?: boolean) => withQuery(path, { force: forced });

export const api = {
  // Sign-in
  login: `${V1}/auth/login`,
  logout: `${V1}/auth/logout`,
  me: `${V1}/auth/me`,

  // Projects, plans, runs
  projects: `${V1}/projects`,
  project: (projectId: string, forced?: boolean) => force(`${V1}/projects/${enc(projectId)}`, forced),
  projectPlans: (projectId: string) => `${V1}/projects/${enc(projectId)}/plans`,
  plan: (planId: string, forced?: boolean) => force(`${V1}/plans/${enc(planId)}`, forced),
  planRuns: (planId: string) => `${V1}/plans/${enc(planId)}/runs`,
  run: (runId: string, forced?: boolean) => force(`${V1}/runs/${enc(runId)}`, forced),
  runResults: (runId: string) => `${V1}/runs/${enc(runId)}/results`,

  // Plan membership and the Execute queue
  planCases: (planId: string, params: { test_run_id?: string } = {}) => withQuery(`${V1}/plans/${enc(planId)}/cases`, params),
  planCase: (planId: string, caseId: string, forced?: boolean) => force(`${V1}/plans/${enc(planId)}/cases/${enc(caseId)}`, forced),
  planSuiteCases: (planId: string, suiteId: string, forced?: boolean) =>
    force(`${V1}/plans/${enc(planId)}/suites/${enc(suiteId)}/cases`, forced),

  // Specification
  specTree: (projectId: string, params: { test_plan_id?: string; include_deprecated?: boolean } = {}) =>
    withQuery(`${V1}/projects/${enc(projectId)}/spec-tree`, params),
  move: (projectId: string) => `${V1}/projects/${enc(projectId)}/move`,
  projectSuites: (projectId: string) => `${V1}/projects/${enc(projectId)}/suites`,
  suite: (suiteId: string, forced?: boolean) => force(`${V1}/suites/${enc(suiteId)}`, forced),
  projectCases: (projectId: string) => `${V1}/projects/${enc(projectId)}/cases`,
  testCase: (caseId: string, forced?: boolean) => force(`${V1}/cases/${enc(caseId)}`, forced),
  caseVersions: (caseId: string) => `${V1}/cases/${enc(caseId)}/versions`,
  latestVersion: (caseId: string) => `${V1}/cases/${enc(caseId)}/versions/latest`,
  version: (versionId: string) => `${V1}/versions/${enc(versionId)}`,
  versionAction: (versionId: string, action: "approve" | "deprecate" | "restore") => `${V1}/versions/${enc(versionId)}/${action}`,

  // Custom field values
  caseCustomFields: (caseId: string) => `${V1}/cases/${enc(caseId)}/custom-fields`,
  caseCustomField: (caseId: string, definitionId: string) => `${V1}/cases/${enc(caseId)}/custom-fields/${enc(definitionId)}`,
  suiteCustomFields: (suiteId: string) => `${V1}/suites/${enc(suiteId)}/custom-fields`,
  suiteCustomField: (suiteId: string, definitionId: string) => `${V1}/suites/${enc(suiteId)}/custom-fields/${enc(definitionId)}`,

  // Search
  caseSearch: (projectId: string) => `${V1}/projects/${enc(projectId)}/case-search`,
  caseSearchFields: (projectId: string) => `${V1}/projects/${enc(projectId)}/case-search/fields`,

  // Reports and report email
  reports: (projectId: string) => `${V1}/projects/${enc(projectId)}/reports`,
  report: (projectId: string, reportId: string, format?: "markdown" | "csv") =>
    withQuery(`${V1}/projects/${enc(projectId)}/reports/${enc(reportId)}`, { format }),
  reportEmails: (projectId: string) => `${V1}/projects/${enc(projectId)}/report-emails`,
  reportSchedules: (projectId: string) => `${V1}/projects/${enc(projectId)}/report-schedules`,
  reportSchedule: (scheduleId: string) => `${V1}/report-schedules/${enc(scheduleId)}`,
  reportScheduleSendNow: (scheduleId: string) => `${V1}/report-schedules/${enc(scheduleId)}/send-now`,

  // Import and export
  importDryRun: (projectId: string) => `${V1}/projects/${enc(projectId)}/imports/dry-run`,
  importExecute: (projectId: string) => `${V1}/projects/${enc(projectId)}/imports/execute`,
  importFieldOptions: (projectId: string) => `${V1}/projects/${enc(projectId)}/imports/custom-field-options`,
  exportDefinitions: (projectId: string) => `${V1}/projects/${enc(projectId)}/exports/definitions`,
  exportResults: (projectId: string) => `${V1}/projects/${enc(projectId)}/exports/results`,

  // API tokens
  projectApiTokens: (projectId: string) => `${V1}/projects/${enc(projectId)}/api-tokens`,
  apiToken: (tokenId: string) => `${V1}/api-tokens/${enc(tokenId)}`,

  // Administration
  admin: {
    users: `${V1}/admin/users`,
    user: (userId: string) => `${V1}/admin/users/${enc(userId)}`,
    userRoles: (userId: string) => `${V1}/admin/users/${enc(userId)}/roles`,
    userOverrides: (userId: string, projectId?: string | null) =>
      withQuery(`${V1}/admin/users/${enc(userId)}/permission-overrides`, { project_id: projectId }),
    userResetPassword: (userId: string) => `${V1}/admin/users/${enc(userId)}/reset-password`,
    roles: `${V1}/admin/roles`,
    role: (roleId: string) => `${V1}/admin/roles/${enc(roleId)}`,
    permissions: `${V1}/admin/permissions`,
    auditLogs: `${V1}/admin/audit-logs`,
    customFields: `${V1}/admin/custom-fields`,
    customField: (fieldId: string, forced?: boolean) => force(`${V1}/admin/custom-fields/${enc(fieldId)}`, forced),
    emailSettings: `${V1}/admin/email-settings`,
    emailSettingsTest: `${V1}/admin/email-settings/test`,
    lastEmail: `${V1}/admin/last-email`,
  },
};
