import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Migrator, sql, type Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';
import { migrateToLatest, MIGRATIONS } from '../src/migrations/index.js';

async function appliedMigrations(db: Kysely<Database>): Promise<string[]> {
  const res = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db);
  return res.rows.map((r) => r.name);
}

describe('migrateToLatest', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = createDbClient();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('builds a fresh database, records it, and does nothing when run again (a restart)', async () => {
    const all = Object.keys(MIGRATIONS);
    expect(await migrateToLatest(db)).toEqual(all);
    expect(await appliedMigrations(db)).toEqual(all);

    // The second run used to crash ("relation already exists"); now it's a no-op.
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual(all);

    // The schema is really there.
    await db.insertInto('projects').values({ id: 'p1', name: 'P', prefix: 'P', description: null, settings: '{}', created_at: 'x', updated_at: 'x' }).execute();
    expect(await db.selectFrom('projects').select('id').execute()).toEqual([{ id: 'p1' }]);
  }, 30_000); // builds the whole schema; slow under full-suite load

  it('adopts a database created before migrations were tracked, keeping its data', async () => {
    await initialSchema.up(db); // what the server used to do on every start
    await db.insertInto('projects').values({ id: 'p1', name: 'Kept', prefix: 'K', description: null, settings: '{}', created_at: 'x', updated_at: 'x' }).execute();

    // 001 is recorded as already applied; only the later migrations run.
    expect(await migrateToLatest(db)).toEqual(Object.keys(MIGRATIONS).slice(1));
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
    expect(await db.selectFrom('projects').select('name').execute()).toEqual([{ name: 'Kept' }]);
  });

  it('refuses, with a clear message, a pre-tracking database from an older build that lacks part of the schema', async () => {
    await initialSchema.up(db);
    await db.schema.dropTable('last_email').execute();
    await expect(migrateToLatest(db)).rejects.toThrow(/created by an older Testify build/);
  });

  it('migrations are registered in run order, each with up and down', () => {
    const names = Object.keys(MIGRATIONS);
    expect(names).toEqual([...names].sort());
    for (const m of Object.values(MIGRATIONS)) {
      expect(typeof m.up).toBe('function');
      expect(typeof m.down).toBe('function');
    }
  });

  it('005 renames BUILD_MANAGE to RUN_MANAGE in an existing database, including API token capabilities', async () => {
    const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
    expect((await migrator.migrateTo('004_login_lockout')).error).toBeUndefined();
    await db.insertInto('permissions').values({ id: 'perm-1', permission_key: 'BUILD_MANAGE', description: 'old', module: 'Planning' }).execute();
    await db.insertInto('projects').values({ id: 'p1', name: 'P', prefix: 'P', description: null, settings: '{}', created_at: 'x', updated_at: 'x' }).execute();
    await db.insertInto('api_tokens').values({
      id: 't1', project_id: 'p1', name: 'ci', token_prefix: 'abc', token_hash: 'h', capabilities: '["SPEC_VIEW","BUILD_MANAGE"]',
      created_by: 'u1', expires_at: null, is_revoked: 0, last_used_at: null, created_at: 'x',
    } as any).execute();

    await migrateToLatest(db);
    expect(await db.selectFrom('permissions').select('permission_key').where('id', '=', 'perm-1').executeTakeFirst()).toEqual({ permission_key: 'RUN_MANAGE' });
    expect((await db.selectFrom('api_tokens').select('capabilities').executeTakeFirst())?.capabilities).toBe('["SPEC_VIEW","RUN_MANAGE"]');
  });

  it('006 drops the unused snapshot and assignee columns, and rolling back restores them', async () => {
    const columns = async (table: string) => {
      const res = await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`.execute(db);
      return res.rows.map((r) => r.column_name);
    };
    await migrateToLatest(db);
    expect(await columns('test_plan_cases')).not.toContain('assigned_user_id');
    expect(await columns('test_plan_cases')).not.toContain('custom_fields_snapshot');
    expect(await columns('test_results')).not.toContain('custom_fields_snapshot');

    const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
    expect((await migrator.migrateTo('005_rename_build_manage')).error).toBeUndefined();
    expect(await columns('test_plan_cases')).toEqual(expect.arrayContaining(['assigned_user_id', 'custom_fields_snapshot']));
    expect(await columns('executions')).toContain('custom_fields_snapshot');
  }, 30_000);

  it('007 renames builds/executions/execution_steps to test_runs/test_results/test_step_results, keeping data; rolling back restores them', async () => {
    const tables = async () =>
      (await sql<{ table_name: string }>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`.execute(db)).rows.map(
        (r) => r.table_name
      );
    const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
    expect((await migrator.migrateTo('006_drop_unused_columns')).error).toBeUndefined();

    // A run with one result and one step result, written with the old names.
    const t = '2026-10-11T00:00:00.000Z';
    await sql`INSERT INTO projects (id, name, prefix, settings, created_at, updated_at) VALUES ('p1', 'P', 'P', '{}', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_suites (id, project_id, name, position, path, created_at, updated_at) VALUES ('s1', 'p1', 'S', 0, '/s1', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_cases (id, project_id, test_suite_id, external_id, title, created_at, updated_at) VALUES ('c1', 'p1', 's1', 'P-1', 'C', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_case_versions (id, test_case_id, version_number, status, author_id, created_at, updated_at) VALUES ('v1', 'c1', 1, 'APPROVED', 'u', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_steps (id, test_case_version_id, step_number, action, expected_result, created_at, updated_at) VALUES ('st1', 'v1', 1, 'a', 'b', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_plans (id, project_id, name, created_at, updated_at) VALUES ('pl1', 'p1', 'Plan', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO test_plan_cases (id, test_plan_id, test_case_id, test_case_version_id, created_at, updated_at) VALUES ('pc1', 'pl1', 'c1', 'v1', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO builds (id, test_plan_id, name, created_at, updated_at) VALUES ('r1', 'pl1', 'Run 1', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO executions (id, build_id, test_plan_case_id, tester_id, verdict, execution_duration_ms, execution_timestamp, created_at, updated_at)
              VALUES ('e1', 'r1', 'pc1', 'u', 'FAILED', 1200, ${t}, ${t}, ${t})`.execute(db);
    await sql`INSERT INTO execution_steps (id, execution_id, test_step_id, step_number, verdict, created_at) VALUES ('es1', 'e1', 'st1', 1, 'FAILED', ${t})`.execute(db);

    expect(await migrateToLatest(db)).toContain('007_rename_runs_and_results');
    expect(await tables()).toEqual(expect.arrayContaining(['test_runs', 'test_results', 'test_step_results']));
    expect(await tables()).not.toEqual(expect.arrayContaining(['builds']));
    const result = (await sql<any>`SELECT * FROM test_results`.execute(db)).rows[0];
    expect(result).toMatchObject({ id: 'e1', test_run_id: 'r1', duration_ms: 1200, executed_at: t, verdict: 'FAILED' });
    expect((await sql<any>`SELECT * FROM test_step_results`.execute(db)).rows[0]).toMatchObject({ id: 'es1', test_result_id: 'e1' });
    expect((await sql<any>`SELECT name FROM test_runs`.execute(db)).rows).toEqual([{ name: 'Run 1' }]);
    // The foreign keys survived: a run with results can't be deleted, and the constraints carry the new names.
    await expect(sql`DELETE FROM test_runs WHERE id = 'r1'`.execute(db)).rejects.toThrow(/test_results_test_run_id_fkey/);
    const indexes = (await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'test_results'`.execute(db)).rows.map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(['test_results_pkey', 'idx_test_results_run_case', 'idx_test_results_executed_at']));

    expect((await migrator.migrateTo('006_drop_unused_columns')).error).toBeUndefined();
    expect(await tables()).toEqual(expect.arrayContaining(['builds', 'executions', 'execution_steps']));
    expect((await sql<any>`SELECT build_id, execution_duration_ms FROM executions`.execute(db)).rows).toEqual([{ build_id: 'r1', execution_duration_ms: 1200 }]);
  }, 30_000);
  it('008 renames plan_id to test_plan_id in stored report schedule sections; rolling back restores it', async () => {
    const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
    expect((await migrator.migrateTo('007_rename_runs_and_results')).error).toBeUndefined();
    const t = '2026-10-12T00:00:00.000Z';
    await sql`INSERT INTO projects (id, name, prefix, settings, created_at, updated_at) VALUES ('p1', 'P', 'P', '{}', ${t}, ${t})`.execute(db);
    const sections = JSON.stringify([{ kind: 'overview' }, { kind: 'latest_run', plan_id: 'pl1', filter: { q: 'x' } }]);
    await sql`INSERT INTO report_schedules (id, project_id, name, sections, recipients, frequency, time_of_day, timezone, next_run_at, created_by, created_at, updated_at)
              VALUES ('rs1', 'p1', 'Weekly', ${sections}, '[]', 'DAILY', '09:00', 'UTC', ${t}, 'u', ${t}, ${t})`.execute(db);
    await sql`INSERT INTO report_schedules (id, project_id, name, sections, recipients, frequency, time_of_day, timezone, next_run_at, created_by, created_at, updated_at)
              VALUES ('rs2', 'p1', 'Broken', 'not json', '[]', 'DAILY', '09:00', 'UTC', ${t}, 'u', ${t}, ${t})`.execute(db);
    const stored = async (id: string) => (await sql<{ sections: string }>`SELECT sections FROM report_schedules WHERE id = ${id}`.execute(db)).rows[0].sections;

    expect(await migrateToLatest(db)).toContain('008_rename_report_schedule_fields');
    expect(JSON.parse(await stored('rs1'))).toEqual([{ kind: 'overview' }, { kind: 'latest_run', filter: { q: 'x' }, test_plan_id: 'pl1' }]);
    expect(await stored('rs2')).toBe('not json'); // unreadable sections are left alone

    expect((await migrator.migrateTo('007_rename_runs_and_results')).error).toBeUndefined();
    expect(JSON.parse(await stored('rs1'))).toEqual([{ kind: 'overview' }, { kind: 'latest_run', filter: { q: 'x' }, plan_id: 'pl1' }]);
  }, 30_000);
  it('009 adds an index for looking cases up by readable id; rolling back removes it', async () => {
    const indexes = async () =>
      (await sql<{ indexname: string }>`SELECT indexname FROM pg_indexes WHERE tablename = 'test_cases'`.execute(db)).rows.map((r) => r.indexname);
    expect(await migrateToLatest(db)).toContain('009_index_case_external_id');
    expect(await indexes()).toContain('idx_test_cases_external_id');
    const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
    expect((await migrator.migrateTo('008_rename_report_schedule_fields')).error).toBeUndefined();
    expect(await indexes()).not.toContain('idx_test_cases_external_id');
  }, 30_000);
});
