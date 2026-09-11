import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // 1. Projects Table
  await db.schema
    .createTable('projects')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('prefix', 'varchar(50)', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('settings', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 2. Test Suites Table
  await db.schema
    .createTable('test_suites')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('restrict'))
    .addColumn('parent_suite_id', 'varchar(36)', (col) => col.references('test_suites.id').onDelete('restrict'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('path', 'varchar(1000)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('idx_test_suites_project').on('test_suites').column('project_id').execute();
  await db.schema.createIndex('idx_test_suites_parent').on('test_suites').column('parent_suite_id').execute();

  // 3. Test Cases Table
  await db.schema
    .createTable('test_cases')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('restrict'))
    .addColumn('test_suite_id', 'varchar(36)', (col) => col.notNull().references('test_suites.id').onDelete('restrict'))
    .addColumn('external_id', 'varchar(100)', (col) => col.notNull())
    .addColumn('title', 'varchar(255)', (col) => col.notNull())
    .addColumn('priority', 'varchar(10)', (col) => col.notNull().defaultTo('HIGH'))
    .addColumn('execution_type', 'varchar(20)', (col) => col.notNull().defaultTo('MANUAL'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_test_case_external', ['project_id', 'external_id'])
    .execute();

  await db.schema.createIndex('idx_test_cases_suite').on('test_cases').column('test_suite_id').execute();

  // 4. Test Case Versions Table
  await db.schema
    .createTable('test_case_versions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('test_case_id', 'varchar(36)', (col) => col.notNull().references('test_cases.id').onDelete('cascade'))
    .addColumn('version_number', 'integer', (col) => col.notNull())
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('DRAFT'))
    .addColumn('summary', 'text')
    .addColumn('preconditions', 'text')
    .addColumn('author_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('reviewer_id', 'varchar(36)')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_case_version', ['test_case_id', 'version_number'])
    .execute();

  await db.schema.createIndex('idx_case_versions_lookup').on('test_case_versions').columns(['test_case_id', 'status']).execute();

  // 5. Test Steps Table
  await db.schema
    .createTable('test_steps')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('test_case_version_id', 'varchar(36)', (col) => col.notNull().references('test_case_versions.id').onDelete('cascade'))
    .addColumn('step_number', 'integer', (col) => col.notNull())
    .addColumn('action', 'text', (col) => col.notNull())
    .addColumn('expected_result', 'text', (col) => col.notNull())
    .addColumn('execution_type', 'varchar(20)', (col) => col.notNull().defaultTo('MANUAL'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_step_order', ['test_case_version_id', 'step_number'])
    .execute();

  // 6. Test Plans Table
  await db.schema
    .createTable('test_plans')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('restrict'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('ACTIVE'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('idx_test_plans_project').on('test_plans').columns(['project_id', 'status']).execute();

  // 7. Builds Table
  await db.schema
    .createTable('builds')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('test_plan_id', 'varchar(36)', (col) => col.notNull().references('test_plans.id').onDelete('restrict'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('OPEN'))
    .addColumn('release_date', 'varchar(30)')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_build_plan_name', ['test_plan_id', 'name'])
    .execute();

  // 8. Test Plan Cases Table
  await db.schema
    .createTable('test_plan_cases')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('test_plan_id', 'varchar(36)', (col) => col.notNull().references('test_plans.id').onDelete('restrict'))
    .addColumn('test_case_id', 'varchar(36)', (col) => col.notNull().references('test_cases.id').onDelete('restrict'))
    .addColumn('test_case_version_id', 'varchar(36)', (col) => col.notNull().references('test_case_versions.id').onDelete('restrict'))
    .addColumn('assigned_user_id', 'varchar(36)')
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('custom_fields_snapshot', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .addUniqueConstraint('uq_plan_case', ['test_plan_id', 'test_case_id'])
    .execute();

  await db.schema.createIndex('idx_plan_cases_assigned').on('test_plan_cases').columns(['test_plan_id', 'assigned_user_id']).execute();

  // 9. Executions Table
  await db.schema
    .createTable('executions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('build_id', 'varchar(36)', (col) => col.notNull().references('builds.id').onDelete('restrict'))
    .addColumn('test_plan_case_id', 'varchar(36)', (col) => col.notNull().references('test_plan_cases.id').onDelete('restrict'))
    .addColumn('tester_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('COMPLETED'))
    .addColumn('verdict', 'varchar(50)', (col) => col.notNull())
    .addColumn('execution_duration_ms', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('notes', 'text')
    .addColumn('custom_fields_snapshot', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('execution_timestamp', 'varchar(30)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('idx_executions_build_case').on('executions').columns(['build_id', 'test_plan_case_id']).execute();
  await db.schema.createIndex('idx_executions_verdict').on('executions').column('verdict').execute();

  // 10. Execution Steps Table
  await db.schema
    .createTable('execution_steps')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('execution_id', 'varchar(36)', (col) => col.notNull().references('executions.id').onDelete('cascade'))
    .addColumn('test_step_id', 'varchar(36)', (col) => col.notNull().references('test_steps.id').onDelete('restrict'))
    .addColumn('step_number', 'integer', (col) => col.notNull())
    .addColumn('verdict', 'varchar(50)', (col) => col.notNull())
    .addColumn('actual_result', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 11. Audit Logs Table
  await db.schema
    .createTable('audit_logs')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('actor_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('actor_type', 'varchar(32)', (col) => col.notNull())
    .addColumn('action', 'varchar(64)', (col) => col.notNull())
    .addColumn('resource_type', 'varchar(64)', (col) => col.notNull())
    .addColumn('resource_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('project_id', 'varchar(36)')
    .addColumn('diff', 'text', (col) => col.notNull().defaultTo('{}'))
    .addColumn('ip_address', 'varchar(45)')
    .addColumn('user_agent', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema.createIndex('idx_audit_logs_actor').on('audit_logs').columns(['actor_id', 'created_at']).execute();
  await db.schema.createIndex('idx_audit_logs_resource').on('audit_logs').columns(['resource_type', 'resource_id']).execute();

  // 12. Custom Field Definitions
  await db.schema
    .createTable('custom_field_definitions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('restrict'))
    .addColumn('entity_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('name', 'varchar(100)', (col) => col.notNull())
    .addColumn('field_label', 'varchar(255)', (col) => col.notNull())
    .addColumn('field_type', 'varchar(30)', (col) => col.notNull())
    .addColumn('is_required', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('default_value', 'text')
    .addColumn('validation_regex', 'varchar(255)')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 13. Custom Field Options
  await db.schema
    .createTable('custom_field_options')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('custom_field_definition_id', 'varchar(36)', (col) => col.notNull().references('custom_field_definitions.id').onDelete('cascade'))
    .addColumn('option_label', 'varchar(255)', (col) => col.notNull())
    .addColumn('option_value', 'varchar(255)', (col) => col.notNull())
    .addColumn('position', 'integer', (col) => col.notNull().defaultTo(0))
    .execute();

  // 14. Custom Field Values
  await db.schema
    .createTable('custom_field_values')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('custom_field_definition_id', 'varchar(36)', (col) => col.notNull().references('custom_field_definitions.id').onDelete('restrict'))
    .addColumn('entity_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('entity_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('string_value', 'text')
    .addColumn('number_value', 'real')
    .addColumn('boolean_value', 'integer')
    .addColumn('date_value', 'varchar(30)')
    .addColumn('json_value', 'text')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 15. Roles Table
  await db.schema
    .createTable('roles')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('name', 'varchar(100)', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('is_system_role', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 16. Permissions Register
  await db.schema
    .createTable('permissions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('permission_key', 'varchar(100)', (col) => col.notNull().unique())
    .addColumn('description', 'text')
    .addColumn('module', 'varchar(50)', (col) => col.notNull())
    .execute();

  // 17. Role Permissions Junction
  await db.schema
    .createTable('role_permissions')
    .addColumn('role_id', 'varchar(36)', (col) => col.notNull().references('roles.id').onDelete('cascade'))
    .addColumn('permission_id', 'varchar(36)', (col) => col.notNull().references('permissions.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('pk_role_permissions', ['role_id', 'permission_id'])
    .execute();

  // 18. User Project Roles
  await db.schema
    .createTable('user_project_roles')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('cascade'))
    .addColumn('role', 'varchar(50)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 19. Direct User Permission Overrides
  await db.schema
    .createTable('user_permission_overrides')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('cascade'))
    .addColumn('permission_id', 'varchar(36)', (col) => col.notNull().references('permissions.id').onDelete('cascade'))
    .addColumn('is_granted', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 20. Machine API Tokens
  await db.schema
    .createTable('api_tokens')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('token_prefix', 'varchar(20)', (col) => col.notNull())
    .addColumn('token_hash', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('capabilities', 'text', (col) => col.notNull().defaultTo('[]'))
    .addColumn('created_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('expires_at', 'varchar(30)')
    .addColumn('is_revoked', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_used_at', 'varchar(30)')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 21. Users Table
  await db.schema
    .createTable('users')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('username', 'varchar(100)', (col) => col.notNull().unique())
    .addColumn('email', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('password_hash', 'varchar(255)', (col) => col.notNull())
    .addColumn('status', 'varchar(20)', (col) => col.notNull().defaultTo('ACTIVE'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 22. User Global Roles Table
  await db.schema
    .createTable('user_roles')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'varchar(50)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 23. System Settings
  await db.schema
    .createTable('system_settings')
    .addColumn('key', 'varchar(100)', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // Install the audit_logs append-only immutability trigger. Testify only targets
  // Postgres-compatible SQL (PGlite locally, real Postgres in production), so there's a
  // single trigger implementation here rather than a per-dialect branch.
  await sql`
    CREATE OR REPLACE FUNCTION suppress_audit_log_mutation()
    RETURNS TRIGGER AS $$
    BEGIN
        RAISE EXCEPTION 'MUTATION_DENIED: audit_logs table is append-only.';
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_prevent_audit_update
    BEFORE UPDATE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION suppress_audit_log_mutation();
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_prevent_audit_delete
    BEFORE DELETE ON audit_logs
    FOR EACH ROW EXECUTE FUNCTION suppress_audit_log_mutation();
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('system_settings').ifExists().execute();
  await db.schema.dropTable('user_roles').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
  await db.schema.dropTable('api_tokens').ifExists().execute();
  await db.schema.dropTable('user_permission_overrides').ifExists().execute();
  await db.schema.dropTable('user_project_roles').ifExists().execute();
  await db.schema.dropTable('role_permissions').ifExists().execute();
  await db.schema.dropTable('permissions').ifExists().execute();
  await db.schema.dropTable('roles').ifExists().execute();
  await db.schema.dropTable('custom_field_values').ifExists().execute();
  await db.schema.dropTable('custom_field_options').ifExists().execute();
  await db.schema.dropTable('custom_field_definitions').ifExists().execute();
  await db.schema.dropTable('audit_logs').ifExists().execute();
  await db.schema.dropTable('execution_steps').ifExists().execute();
  await db.schema.dropTable('executions').ifExists().execute();
  await db.schema.dropTable('test_plan_cases').ifExists().execute();
  await db.schema.dropTable('builds').ifExists().execute();
  await db.schema.dropTable('test_plans').ifExists().execute();
  await db.schema.dropTable('test_steps').ifExists().execute();
  await db.schema.dropTable('test_case_versions').ifExists().execute();
  await db.schema.dropTable('test_cases').ifExists().execute();
  await db.schema.dropTable('test_suites').ifExists().execute();
  await db.schema.dropTable('projects').ifExists().execute();
}
