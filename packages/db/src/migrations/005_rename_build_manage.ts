import { sql, type Kysely } from 'kysely';

// The UI calls them test runs, so the permission is RUN_MANAGE, not BUILD_MANAGE. Role bundles
// and overrides point at the permission's id, so only the key (and API tokens' capability lists,
// which store keys) need renaming.
export async function up(db: Kysely<any>): Promise<void> {
  await db
    .updateTable('permissions')
    .set({ permission_key: 'RUN_MANAGE', description: 'Create, edit, close and delete test runs in a test plan.' })
    .where('permission_key', '=', 'BUILD_MANAGE')
    .execute();
  await sql`UPDATE api_tokens SET capabilities = REPLACE(capabilities, '"BUILD_MANAGE"', '"RUN_MANAGE"')`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await db
    .updateTable('permissions')
    .set({ permission_key: 'BUILD_MANAGE', description: 'Create and close builds within a test plan.' })
    .where('permission_key', '=', 'RUN_MANAGE')
    .execute();
  await sql`UPDATE api_tokens SET capabilities = REPLACE(capabilities, '"RUN_MANAGE"', '"BUILD_MANAGE"')`.execute(db);
}
