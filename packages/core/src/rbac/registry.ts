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
  { key: 'PLAN_MANAGE', description: 'Create test plans and manage which test cases are in one.', module: 'Planning' },
  { key: 'BUILD_MANAGE', description: 'Create and close builds within a test plan.', module: 'Planning' },
  { key: 'EXECUTE_RUN', description: 'Record a Pass/Fail/Blocked/Skipped verdict for a test case.', module: 'Execution' },
  { key: 'EXECUTE_OVERWRITE', description: 'Re-record a verdict for a test case that already has one.', module: 'Execution' },
  { key: 'IMPORT_DATA', description: 'Bulk-import test suites and cases from XML/CSV/JSON.', module: 'Data' },
  { key: 'EXPORT_DATA', description: 'Export test data out of the project.', module: 'Data' },
];

export const PERMISSION_KEYS: string[] = PERMISSION_REGISTRY.map((p) => p.key);

/**
 * The permission bundle each of the 5 built-in roles held before roles became
 * database-backed. Used only to seed `roles`/`role_permissions` on a fresh install
 * (packages/db/src/seeds/seed_rbac_registry.ts) -- once seeded, the database rows are
 * authoritative and these roles are editable/deletable like any other template.
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
    'PLAN_MANAGE',
    'BUILD_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
    'CUSTOM_FIELD_MANAGE',
  ],
  'Test Lead': [
    'SPEC_VIEW',
    'SPEC_CREATE',
    'SPEC_EDIT',
    'SPEC_APPROVE',
    'SPEC_DELETE',
    'PLAN_MANAGE',
    'BUILD_MANAGE',
    'EXECUTE_RUN',
    'EXECUTE_OVERWRITE',
    'IMPORT_DATA',
    'EXPORT_DATA',
    'API_TOKEN_MANAGE',
  ],
  Tester: ['SPEC_VIEW', 'SPEC_CREATE', 'SPEC_EDIT', 'EXECUTE_RUN', 'EXPORT_DATA'],
  Viewer: ['SPEC_VIEW', 'EXPORT_DATA'],
  'Automation Service': ['SPEC_VIEW', 'BUILD_MANAGE', 'EXECUTE_RUN'],
};

export const DEFAULT_ROLE_NAMES: string[] = Object.keys(DEFAULT_ROLE_PERMISSIONS);
