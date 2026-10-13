import type { Kysely } from 'kysely';

/**
 * Webhooks (API roadmap step 7): `webhooks` holds each project's targets; `webhook_deliveries` is
 * the outbox, one row per event per webhook, which the delivery worker claims, sends and retries
 * (apps/server/src/services/webhooks.ts). Both go when their project (or webhook) is deleted.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('webhooks')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('project_id', 'varchar(36)', (col) => col.notNull().references('projects.id').onDelete('cascade'))
    .addColumn('name', 'varchar(255)', (col) => col.notNull())
    .addColumn('url', 'text', (col) => col.notNull())
    .addColumn('format', 'varchar(20)', (col) => col.notNull()) // json | slack
    .addColumn('events', 'text', (col) => col.notNull()) // JSON: string[]
    .addColumn('secret', 'text', (col) => col.notNull()) // encrypted (services/secrets.ts)
    .addColumn('enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('created_by', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('updated_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_webhooks_project').on('webhooks').column('project_id').execute();

  await db.schema
    .createTable('webhook_deliveries')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('webhook_id', 'varchar(36)', (col) => col.notNull().references('webhooks.id').onDelete('cascade'))
    .addColumn('event_id', 'varchar(36)', (col) => col.notNull()) // the same for every delivery of one event
    .addColumn('event', 'varchar(64)', (col) => col.notNull())
    .addColumn('payload', 'text', (col) => col.notNull()) // the JSON envelope
    .addColumn('status', 'varchar(20)', (col) => col.notNull()) // PENDING | SUCCEEDED | FAILED
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('next_attempt_at', 'varchar(30)', (col) => col.notNull())
    .addColumn('last_attempt_at', 'varchar(30)')
    .addColumn('response_status', 'integer')
    .addColumn('response_body', 'text')
    .addColumn('error', 'text')
    .addColumn('duration_ms', 'integer')
    .addColumn('created_at', 'varchar(30)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('idx_webhook_deliveries_due').on('webhook_deliveries').columns(['status', 'next_attempt_at']).execute();
  await db.schema.createIndex('idx_webhook_deliveries_webhook').on('webhook_deliveries').columns(['webhook_id', 'created_at']).execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('webhook_deliveries').execute();
  await db.schema.dropTable('webhooks').execute();
}
