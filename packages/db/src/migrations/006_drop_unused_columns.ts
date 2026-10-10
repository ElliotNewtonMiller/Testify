import type { Kysely } from 'kysely';

// Columns from the first schema that nothing ever used: results never recorded custom field
// values (custom_fields_snapshot was always '{}'), and test plan cases were never assigned to
// anyone (assigned_user_id was always null). Custom field values are deliberately not recorded
// with results.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_plan_cases_assigned').ifExists().execute();
  await db.schema.alterTable('test_plan_cases').dropColumn('assigned_user_id').execute();
  await db.schema.alterTable('test_plan_cases').dropColumn('custom_fields_snapshot').execute();
  await db.schema.alterTable('executions').dropColumn('custom_fields_snapshot').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('executions')
    .addColumn('custom_fields_snapshot', 'text', (col) => col.notNull().defaultTo('{}'))
    .execute();
  await db.schema
    .alterTable('test_plan_cases')
    .addColumn('custom_fields_snapshot', 'text', (col) => col.notNull().defaultTo('{}'))
    .execute();
  await db.schema.alterTable('test_plan_cases').addColumn('assigned_user_id', 'varchar(36)').execute();
  await db.schema
    .createIndex('idx_plan_cases_assigned')
    .on('test_plan_cases')
    .columns(['test_plan_id', 'assigned_user_id'])
    .execute();
}
