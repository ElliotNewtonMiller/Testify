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
    // Nullable, no default: null means "not measured/not supplied" by the caller. Never
    // fabricate a number here (a prior version of this column had NOT NULL DEFAULT 0, and
    // two routes independently invented fake numbers -- 450ms and 0ms -- to satisfy it,
    // silently polluting any duration-based report). See reports.ts and its callers.
    .addColumn('execution_duration_ms', 'integer')
    .addColumn('notes', 'text')
    .addColumn('custom_fields_snapshot', 'text', (col) => col.notNull().defaultTo('{}'))
    // Troubleshooting data reported by automated callers (batch API). failure_message is the
    // short error (JUnit's message attribute), stack_trace the full trace; environment and
    // runner are JSON objects (environment tags; CI runner name/run_id/job_name/commit_sha/url).
    .addColumn('failure_message', 'text')
    .addColumn('stack_trace', 'text')
    .addColumn('environment', 'text')
    .addColumn('runner', 'text')
    // Where the result came from: 'UI' (recorded by a person in Execute mode) or 'API' (batch
    // route / machine token). Null for rows written before this column existed.
    .addColumn('source', 'varchar(8)')
    .addColumn('execution_timestamp', 'varchar(30)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // Backs per-case history (every result a case ever got, newest first).
  await db.schema.createIndex('idx_executions_case_time').on('executions').columns(['test_plan_case_id', 'execution_timestamp']).execute();
  await db.schema.createIndex('idx_executions_build_case').on('executions').columns(['build_id', 'test_plan_case_id']).execute();
  await db.schema.createIndex('idx_executions_verdict').on('executions').column('verdict').execute();
  // Backs the reporting feature's "latest execution per plan-case" window functions and
  // trend/slowest-tests ORDER BY execution_timestamp queries.
  await db.schema.createIndex('idx_executions_timestamp').on('executions').column('execution_timestamp').execute();

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

  // Postgres treats NULL as distinct-per-row for a normal UNIQUE constraint, so a plain
  // column-level unique on (project_id, entity_type, name) would not actually stop two
  // global (project_id IS NULL) fields from sharing a name. A partial index scoped to the
  // global case is what enforces global-scope name uniqueness, while leaving ingestion.ts's
  // project-scoped custom field definitions (non-null project_id) completely unaffected.
  await sql`
    CREATE UNIQUE INDEX uq_custom_field_def_global_scope
    ON custom_field_definitions (entity_type, name)
    WHERE project_id IS NULL
  `.execute(db);

  // Companion to uq_custom_field_def_global_scope above: enforces per-project name
  // uniqueness for project-scoped custom field definitions (created by the import wizard's
  // AUTO_CREATE path -- see routes/ingestion.ts and CustomFieldRepository.listVisibleToProject),
  // without constraining global (project_id IS NULL) fields, which the other index already
  // covers. A project-scoped field is free to share a name with a global field or with a
  // same-named field in a *different* project; only same-project collisions are blocked.
  await sql`
    CREATE UNIQUE INDEX uq_custom_field_def_project_scope
    ON custom_field_definitions (project_id, entity_type, name)
    WHERE project_id IS NOT NULL
  `.execute(db);

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
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('role', 'varchar(50)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 19. Machine API Tokens
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

  // 20. Users Table
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

  // 21. User Global Roles Table
  await db.schema
    .createTable('user_roles')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'varchar(50)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 22. Direct User Permission Overrides (created after `users` exists, so its FK is valid)
  await db.schema
    .createTable('user_permission_overrides')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('cascade'))
    .addColumn('permission_id', 'varchar(36)', (col) => col.notNull().references('permissions.id').onDelete('cascade'))
    .addColumn('is_granted', 'integer', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex('idx_user_permission_overrides_user')
    .on('user_permission_overrides')
    .column('user_id')
    .execute();

  // 23. System Settings
  await db.schema
    .createTable('system_settings')
    .addColumn('key', 'varchar(100)', (col) => col.primaryKey())
    .addColumn('value', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();

  // 24. Scheduled report emails. Deleting a project deletes its schedules.
  await db.schema
    .createTable('report_schedules')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('sections', 'text', (col) => col.notNull()) // JSON: [{ kind, plan_id?, filter? }]
    .addColumn('recipients', 'text', (col) => col.notNull()) // JSON: string[]
    .addColumn('message', 'text')
    .addColumn('frequency', 'varchar(10)', (col) => col.notNull()) // DAILY | WEEKLY
    .addColumn('weekday', 'integer') // 0 = Sunday .. 6, WEEKLY only
    .addColumn('time_of_day', 'varchar(5)', (col) => col.notNull()) // HH:MM
    .addColumn('timezone', 'varchar(64)', (col) => col.notNull())
    .addColumn('only_when_new_run', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('next_run_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('last_run_at', 'varchar(30)')
    .addColumn('last_status', 'varchar(10)') // SENT | CAPTURED | FAILED | SKIPPED
    .addColumn('last_error', 'text')
    .addColumn('last_sent_run_ids', 'text') // JSON: run ids the last email reported on
    .addColumn('created_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_report_schedules_due').on('report_schedules').columns(['enabled', 'next_run_at']).execute();

  // 25. Email outbox: every email Testify sends (or, with no SMTP server configured, only
  // captures). Kept when its project or schedule is deleted.
  await db.schema
    .createTable('email_outbox')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.references('projects.id').onDelete('set null'))
    .addColumn('schedule_id', 'varchar(36)', (col) => col.references('report_schedules.id').onDelete('set null'))
    .addColumn('subject', 'text', (col) => col.notNull())
    .addColumn('recipients', 'text', (col) => col.notNull()) // JSON: string[]
    .addColumn('html', 'text', (col) => col.notNull())
    .addColumn('text_body', 'text', (col) => col.notNull())
    .addColumn('status', 'varchar(10)', (col) => col.notNull()) // SENT | CAPTURED | FAILED
    .addColumn('error', 'text')
    .addColumn('sent_by', 'varchar(36)')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_email_outbox_created').on('email_outbox').column('created_at').execute();

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
  await db.schema.dropTable('email_outbox').ifExists().execute();
  await db.schema.dropTable('report_schedules').ifExists().execute();
  await db.schema.dropTable('system_settings').ifExists().execute();
  // user_permission_overrides FKs to users, so it must drop before users does.
  await db.schema.dropTable('user_permission_overrides').ifExists().execute();
  await db.schema.dropTable('user_roles').ifExists().execute();
  await db.schema.dropTable('users').ifExists().execute();
  await db.schema.dropTable('api_tokens').ifExists().execute();
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
