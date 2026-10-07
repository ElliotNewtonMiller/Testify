import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, type Kysely } from 'kysely';
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
    expect(await migrateToLatest(db)).toEqual(['001_initial_schema']);
    expect(await appliedMigrations(db)).toEqual(['001_initial_schema']);

    // The second run used to crash ("relation already exists"); now it's a no-op.
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await migrateToLatest(db)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual(['001_initial_schema']);

    // The schema is really there.
    await db.insertInto('projects').values({ id: 'p1', name: 'P', prefix: 'P', description: null, settings: '{}', created_at: 'x', updated_at: 'x' }).execute();
    expect(await db.selectFrom('projects').select('id').execute()).toEqual([{ id: 'p1' }]);
  });

  it('adopts a database created before migrations were tracked, keeping its data', async () => {
    await initialSchema.up(db); // what the server used to do on every start
    await db.insertInto('projects').values({ id: 'p1', name: 'Kept', prefix: 'K', description: null, settings: '{}', created_at: 'x', updated_at: 'x' }).execute();

    expect(await migrateToLatest(db)).toEqual([]);
    expect(await appliedMigrations(db)).toEqual(['001_initial_schema']);
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
});
