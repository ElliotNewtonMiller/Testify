import type { Kysely } from 'kysely';

// One row per sign-in. A login token names its session, and the server checks the row on every
// request, so signing out (or a password change) really ends a session instead of leaving the
// token valid until it expires.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('sessions')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('expires_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('revoked_at', 'varchar(30)')
    .execute();
  await db.schema.createIndex('idx_sessions_user').on('sessions').column('user_id').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('sessions').execute();
}
