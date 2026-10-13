/**
 * The canonical permission-key registry for Testify's RBAC system. This is the single
 * source of truth for what permission keys exist, replacing the doc-only list in
 * docs/rfc_04_rbac_security_matrix.md and the copy that used to live hardcoded inline in
 * packages/db/src/repositories/role.repository.ts. Both packages/db's seed data and its
 * RoleRepository import from here so the registry, the seeded `permissions` table, and the
 * evaluator can never drift apart.
 */

export interface PermissionDefinition {
  key: string;
  description: string;
  /** UI grouping label -- lets the Admin Panel render permission toggles by module instead
   * of as one flat list of 16 checkboxes. */
  module: string;
}

export const PERMISSION_REGISTRY: PermissionDefinition[] = [
  { key: 'SYSTEM_ADMIN', description: 'Unconditional access to every permission and every project.', module: 'Administration' },
  { key: 'USER_MANAGE', description: 'Create users, assign roles, and view the security audit log.', module: 'Administration' },
  { key: 'API_TOKEN_MANAGE', description: 'Create and revoke machine API tokens.', module: 'Administration' },
  { key: 'CUSTOM_FIELD_MANAGE', description: 'Create, edit, and delete global custom field definitions for test cases and suites.', module: 'Administration' },
  { key: 'PROJECT_CREATE', description: 'Create new projects.', module: 'Projects' },
  { key: 'PROJECT_DELETE', description: 'Delete existing projects.', module: 'Projects' },
  { key: 'SPEC_VIEW', description: 'View test suites, test cases, and their steps.', module: 'Specifications' },
  { key: 'SPEC_CREATE', description: 'Create new test suites and test cases.', module: 'Specifications' },
  { key: 'SPEC_EDIT', description: 'Edit draft test case versions and steps.', module: 'Specifications' },
  { key: 'SPEC_APPROVE', description: 'Approve a test case version, locking it for execution.', module: 'Specifications' },
  { key: 'SPEC_DELETE', description: 'Delete test suites and test cases.', module: 'Specifications' },
  { key: 'SPEC_AUTO_APPROVE', description: 'New test cases this user creates are approved immediately instead of starting as a draft.', module: 'Specifications' },
  { key: 'PLAN_MANAGE', description: 'Create test plans and manage which test cases are in one.', module: 'Planning' },
  { key: 'RUN_MANAGE', description: 'Create, edit, close and delete test runs in a test plan.', module: 'Planning' },
  { key: 'EXECUTE_RUN', description: 'Record a Pass/Fail/Blocked/Skipped verdict for a test case.', module: 'Execution' },
  { key: 'EXECUTE_OVERWRITE', description: 'Re-record a verdict for a test case that already has one.', module: 'Execution' },
  { key: 'IMPORT_DATA', description: 'Bulk-import test suites and cases from XML/CSV/JSON.', module: 'Data' },
  { key: 'EXPORT_DATA', description: 'Export test data out of the project.', module: 'Data' },
  { key: 'REPORT_EMAIL', description: 'Email reports to anyone and manage scheduled report emails.', module: 'Data' },
  { key: 'WEBHOOK_MANAGE', description: "Set up webhooks that send the project's events (runs, results, test cases, imports) to other systems.", module: 'Data' },
];

export const PERMISSION_KEYS: string[] = PERMISSION_REGISTRY.map((p) => p.key);

/**
 * Permissions an API token can never hold, with why. A token works only inside its one
 * project, so it can't hold permissions whose routes reach the whole system (users and roles,
 * global custom fields, creating projects), nor issue tokens (a token's tokens would never
 * work: their issuer isn't a user), nor set up webhooks (a way to send project data anywhere). Refused when a token is created, and dropped from existing
 * tokens on every use (middleware/auth.ts). The API Tokens tab never offers them.
 */
export const TOKEN_EXCLUDED_PERMISSIONS: Readonly<Record<string, string>> = {
  SYSTEM_ADMIN: 'it passes every check in every project',
  USER_MANAGE: 'it manages users, roles and the audit log of the whole system',
  CUSTOM_FIELD_MANAGE: 'custom field definitions apply to every project',
  PROJECT_CREATE: 'creating projects happens outside any one project',
  API_TOKEN_MANAGE: "a token can't issue or revoke tokens",
  WEBHOOK_MANAGE: 'a webhook sends project data to any address, so only people set them up',
};

/** Whether a permission can be given to an API token (see TOKEN_EXCLUDED_PERMISSIONS). */
export function isTokenGrantable(key: string): boolean {
  return !Object.prototype.hasOwnProperty.call(TOKEN_EXCLUDED_PERMISSIONS, key);
}

/**
 * The built-in roles and their permission bundles. Used only to seed `roles`/`role_permissions`
 * (packages/db/src/seeds/seed_rbac_registry.ts, idempotent, run on every start) -- once seeded,
 * the database rows are authoritative and these roles are editable/deletable like any other
 * template. New built-ins go at the end: the seed derives each role's id from its position.
 *
 * "No Access" grants nothing. As a user's global role it limits them to the projects where
 * they're given a project role (Admin Panel -> Matrix), including none at all.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  Admin: [
    'SYSTEM_ADMIN',
    'PROJECT_CREATE',
    'PROJECT_DELETE',
    'USER_MANAGE',
    'SPEC_VIEW',
    'SPEC_CREATE',
    'SPEC_EDIT',
    'SPEC_APPROVE',
    'SPEC_DELETE',
    'SPEC_AUTO_APPROVE',
    'PLAN_MANAGE',
    'RUN_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
    'CUSTOM_FIELD_MANAGE',
    'REPORT_EMAIL',
    'WEBHOOK_MANAGE',
  ],
  'Test Lead': [
    'SPEC_VIEW',
    'SPEC_CREATE',
    'SPEC_EDIT',
    'SPEC_APPROVE',
    'SPEC_DELETE',
    'SPEC_AUTO_APPROVE',
    'PLAN_MANAGE',
    'RUN_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
    'REPORT_EMAIL',
    'WEBHOOK_MANAGE',
  ],
  Tester: ['SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT', 'EXECUTE_RUN', 'EXPORT_DATA'],
  Viewer: ['SPEC_VIEW', 'EXPORT_DATA'],
  'Automation Service': ['SPEC_VIEW', 'RUN_MANAGE', 'EXECUTE_RUN'],
  'No Access': [],
};

export const DEFAULT_ROLE_NAMES: string[] = Object.keys(DEFAULT_ROLE_PERMISSIONS);

/** The role that grants nothing (see DEFAULT_ROLE_PERMISSIONS). */
export const NO_ACCESS_ROLE = 'No Access';

/** Descriptions seeded with the built-in roles (the others have none). */
export const DEFAULT_ROLE_DESCRIPTIONS: Record<string, string> = {
  [NO_ACCESS_ROLE]: 'Sees no projects. As a global role, the user only has access to projects where they have a project role.',
};
