import type { Kysely } from 'kysely';

// Lets the server make a user set a new password before doing anything else -- used for the
// first admin when Testify generates its password (see apps/server/src/config.ts).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('must_change_password', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('must_change_password').execute();
}
