import { Migrator, NO_MIGRATIONS, sql, type Kysely, type Migration } from 'kysely';
import * as m001 from './001_initial_schema.js';
import * as m002 from './002_password_change_required.js';
import * as m003 from './003_sessions.js';
import * as m004 from './004_login_lockout.js';
import * as m005 from './005_rename_build_manage.js';
import * as m006 from './006_drop_unused_columns.js';

/**
 * Every schema migration, in the order they run. The keys are permanent names, recorded in
 * the `kysely_migration` table once applied.
 *
 * To change the schema, add a NEW migration (e.g. `002_add_widgets.ts`, with `up` and `down`)
 * and register it here. Never edit a migration that has already shipped: databases that
 * already ran it won't run it again, so the edit would never reach them.
 */
export const MIGRATIONS: Record<string, Migration> = {
  '001_initial_schema': m001,
  '002_password_change_required': m002,
  '003_sessions': m003,
  '004_login_lockout': m004,
  '005_rename_build_manage': m005,
  '006_drop_unused_columns': m006,
};

const MIGRATION_TABLE = 'kysely_migration';

/**
 * Brings the database schema up to date: runs every migration that hasn't run yet, in order,
 * and records each one. Safe to call on every server start -- against a database that's
 * already current it does nothing. Concurrent callers (several server instances starting at
 * once) are serialised by a Postgres advisory lock taken by Kysely's Migrator.
 *
 * Returns the names of the migrations applied by this call.
 */
export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  await adoptPreMigratorDatabase(db);
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    const failed = results?.find((r) => r.status === 'Error')?.migrationName;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Database migration${failed ? ` ${failed}` : ''} failed: ${reason}`);
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Rolls back every applied migration, newest first, via each one's `down`. For tests that
 * tear a schema down again; never called by the server.
 */
export async function migrateDownAll(db: Kysely<any>): Promise<void> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error } = await migrator.migrateTo(NO_MIGRATIONS);
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Databases created before migrations were tracked (the server used to run the initial schema
 * directly) have every table but no `kysely_migration` record, so the runner would try to
 * create them again and fail. If such a database matches the initial schema, record
 * 001_initial_schema as already applied. If it's an older, incomplete version of it, stop with
 * a clear message instead of starting against a schema the code doesn't match.
 */
async function adoptPreMigratorDatabase(db: Kysely<any>): Promise<void> {
  const tables = await db.introspection.getTables({ withInternalKyselyTables: true });
  const names = new Set(tables.map((t) => t.name));
  if (names.has(MIGRATION_TABLE) || !names.has('projects')) return; // already tracked, or a fresh database

  // Spot-check things added late to the initial schema; a database missing them predates it.
  const planCases = tables.find((t) => t.name === 'test_plan_cases');
  const complete = names.has('last_email') && names.has('report_schedules') && planCases?.columns.some((c) => c.name === 'removed_at');
  if (!complete) {
    throw new Error(
      'This database was created by an older Testify build and is missing parts of the current schema. ' +
        'Recreate it (or point DATABASE_URL at an empty database) and start the server again.'
    );
  }

  await db.schema
    .createTable(MIGRATION_TABLE)
    .ifNotExists()
    .addColumn('name', 'varchar(255)', (col) => col.notNull().primaryKey())
    .addColumn('timestamp', 'varchar(255)', (col) => col.notNull())
    .execute();
  await sql`INSERT INTO ${sql.table(MIGRATION_TABLE)} (name, timestamp) VALUES ('001_initial_schema', ${new Date().toISOString()}) ON CONFLICT (name) DO NOTHING`.execute(db);
}
