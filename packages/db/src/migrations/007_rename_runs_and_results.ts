import { sql, type Kysely } from 'kysely';

/**
 * The app calls them test runs and results; the schema still said builds and executions.
 * Renames the tables, their columns, constraints and indexes so there's one word per idea
 * everywhere:
 *
 *   builds          -> test_runs
 *   executions      -> test_results       (build_id -> test_run_id,
 *                                          execution_duration_ms -> duration_ms,
 *                                          execution_timestamp -> executed_at)
 *   execution_steps -> test_step_results  (execution_id -> test_result_id)
 *
 * Renames keep every row, foreign key and index; only names change. (Audit log rows that say
 * "build" or "execution" stay as they are: the table is append-only.)
 */

/** [table, old constraint name, new constraint name], named for the tables after renaming. */
const CONSTRAINTS: Array<[string, string, string]> = [
  ['test_runs', 'builds_pkey', 'test_runs_pkey'],
  ['test_runs', 'builds_test_plan_id_fkey', 'test_runs_test_plan_id_fkey'],
  ['test_runs', 'uq_build_plan_name', 'uq_test_run_plan_name'],
  ['test_results', 'executions_pkey', 'test_results_pkey'],
  ['test_results', 'executions_build_id_fkey', 'test_results_test_run_id_fkey'],
  ['test_results', 'executions_test_plan_case_id_fkey', 'test_results_test_plan_case_id_fkey'],
  ['test_step_results', 'execution_steps_pkey', 'test_step_results_pkey'],
  ['test_step_results', 'execution_steps_execution_id_fkey', 'test_step_results_test_result_id_fkey'],
  ['test_step_results', 'execution_steps_test_step_id_fkey', 'test_step_results_test_step_id_fkey'],
];

/** [old index name, new index name] (indexes that don't belong to a constraint). */
const INDEXES: Array<[string, string]> = [
  ['idx_executions_build_case', 'idx_test_results_run_case'],
  ['idx_executions_case_time', 'idx_test_results_case_time'],
  ['idx_executions_timestamp', 'idx_test_results_executed_at'],
  ['idx_executions_verdict', 'idx_test_results_verdict'],
];

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('builds').renameTo('test_runs').execute();
  await db.schema.alterTable('executions').renameTo('test_results').execute();
  await db.schema.alterTable('execution_steps').renameTo('test_step_results').execute();

  await db.schema.alterTable('test_results').renameColumn('build_id', 'test_run_id').execute();
  await db.schema.alterTable('test_results').renameColumn('execution_duration_ms', 'duration_ms').execute();
  await db.schema.alterTable('test_results').renameColumn('execution_timestamp', 'executed_at').execute();
  await db.schema.alterTable('test_step_results').renameColumn('execution_id', 'test_result_id').execute();

  for (const [table, from, to] of CONSTRAINTS) {
    await sql`ALTER TABLE ${sql.table(table)} RENAME CONSTRAINT ${sql.ref(from)} TO ${sql.ref(to)}`.execute(db);
  }
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX ${sql.ref(from)} RENAME TO ${sql.ref(to)}`.execute(db);
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const [from, to] of INDEXES) {
    await sql`ALTER INDEX ${sql.ref(to)} RENAME TO ${sql.ref(from)}`.execute(db);
  }
  for (const [table, from, to] of CONSTRAINTS) {
    await sql`ALTER TABLE ${sql.table(table)} RENAME CONSTRAINT ${sql.ref(to)} TO ${sql.ref(from)}`.execute(db);
  }

  await db.schema.alterTable('test_step_results').renameColumn('test_result_id', 'execution_id').execute();
  await db.schema.alterTable('test_results').renameColumn('executed_at', 'execution_timestamp').execute();
  await db.schema.alterTable('test_results').renameColumn('duration_ms', 'execution_duration_ms').execute();
  await db.schema.alterTable('test_results').renameColumn('test_run_id', 'build_id').execute();

  await db.schema.alterTable('test_step_results').renameTo('execution_steps').execute();
  await db.schema.alterTable('test_results').renameTo('executions').execute();
  await db.schema.alterTable('test_runs').renameTo('builds').execute();
}
