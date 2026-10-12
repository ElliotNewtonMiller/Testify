import type { Kysely } from 'kysely';

/**
 * The API accepts a case's readable id (e.g. SHOP-12) wherever it takes a case id, so cases are
 * looked up by external_id alone. The existing unique index is (project_id, external_id), which
 * doesn't help a lookup without the project.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createIndex('idx_test_cases_external_id').on('test_cases').column('external_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('idx_test_cases_external_id').execute();
}
