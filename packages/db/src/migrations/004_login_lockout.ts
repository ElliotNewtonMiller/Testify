import type { Kysely } from 'kysely';

// Counts consecutive failed sign-ins per account and locks the account for a while after too
// many (see apps/server/src/services/loginThrottle.ts).
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('users')
    .addColumn('failed_login_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('locked_until', 'varchar(30)')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('users').dropColumn('failed_login_count').dropColumn('locked_until').execute();
}
