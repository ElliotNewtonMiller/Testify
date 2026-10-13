import type { Kysely, Selectable } from 'kysely';
import type { Database, WebhookDeliveriesTable, WebhooksTable } from '../types.js';
import { decodeCursor, toPage, type Page } from '../paging.js';

/** A webhook with its event list parsed. `secret` is still encrypted (the server decrypts it to sign). */
export interface Webhook extends Omit<Selectable<WebhooksTable>, 'events' | 'enabled'> {
  events: string[];
  enabled: boolean;
}

export type WebhookDelivery = Selectable<WebhookDeliveriesTable>;

/** A delivery without its payload and response body, for lists. */
export type WebhookDeliverySummary = Omit<WebhookDelivery, 'payload' | 'response_body'>;

export type NewWebhookDelivery = Pick<WebhookDelivery, 'id' | 'webhook_id' | 'event_id' | 'event' | 'payload' | 'next_attempt_at' | 'created_at'>;

function parseEvents(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  } catch {
    return [];
  }
}

function toWebhook(row: Selectable<WebhooksTable>): Webhook {
  return { ...row, events: parseEvents(row.events), enabled: Boolean(row.enabled) };
}

const SUMMARY_COLUMNS = [
  'id',
  'webhook_id',
  'event_id',
  'event',
  'status',
  'attempts',
  'next_attempt_at',
  'last_attempt_at',
  'response_status',
  'error',
  'duration_ms',
  'created_at',
] as const;

/** Webhooks and their deliveries (the outbox). The delivery worker is apps/server/src/services/webhooks.ts. */
export class WebhookRepository {
  constructor(private db: Kysely<Database>) {}

  async listByProject(projectId: string): Promise<Webhook[]> {
    const rows = await this.db.selectFrom('webhooks').selectAll().where('project_id', '=', projectId).orderBy('created_at', 'asc').execute();
    return rows.map(toWebhook);
  }

  async findById(id: string): Promise<Webhook | undefined> {
    const row = await this.db.selectFrom('webhooks').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? toWebhook(row) : undefined;
  }

  async countByProject(projectId: string): Promise<number> {
    const row = await this.db.selectFrom('webhooks').select(this.db.fn.countAll<number>().as('n')).where('project_id', '=', projectId).executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  async create(row: Omit<Webhook, 'enabled'> & { enabled?: boolean }): Promise<Webhook> {
    await this.db
      .insertInto('webhooks')
      .values({ ...row, events: JSON.stringify(row.events), enabled: row.enabled ?? true })
      .execute();
    return (await this.findById(row.id))!;
  }

  async update(id: string, patch: Partial<Pick<Webhook, 'name' | 'url' | 'format' | 'events' | 'enabled' | 'secret'>>): Promise<Webhook | undefined> {
    const { events, ...rest } = patch;
    await this.db
      .updateTable('webhooks')
      .set({ ...rest, ...(events ? { events: JSON.stringify(events) } : {}), updated_at: new Date().toISOString() })
      .where('id', '=', id)
      .execute();
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('webhooks').where('id', '=', id).execute();
  }

  /** The project's enabled webhooks subscribed to this event. */
  async subscribers(projectId: string, event: string): Promise<Webhook[]> {
    const rows = await this.db.selectFrom('webhooks').selectAll().where('project_id', '=', projectId).where('enabled', '=', true).execute();
    return rows.map(toWebhook).filter((w) => w.events.includes(event));
  }

  // ---- Deliveries ----

  async insertDeliveries(rows: NewWebhookDelivery[]): Promise<void> {
    if (!rows.length) return;
    await this.db
      .insertInto('webhook_deliveries')
      .values(rows.map((r) => ({ ...r, status: 'PENDING', attempts: 0 })))
      .execute();
  }

  async findDelivery(id: string): Promise<WebhookDelivery | undefined> {
    return this.db.selectFrom('webhook_deliveries').selectAll().where('id', '=', id).executeTakeFirst();
  }

  /** Deliveries due to be sent (or retried), oldest first; all webhooks', or one's. */
  async findDue(nowIso: string, limit: number, webhookId?: string): Promise<WebhookDelivery[]> {
    let query = this.db.selectFrom('webhook_deliveries').selectAll().where('status', '=', 'PENDING').where('next_attempt_at', '<=', nowIso);
    if (webhookId) query = query.where('webhook_id', '=', webhookId);
    return query.orderBy('next_attempt_at', 'asc').orderBy('created_at', 'asc').limit(limit).execute();
  }

  /**
   * Claims a due delivery by moving next_attempt_at to the end of a lease, but only if it still
   * has the value read: of several workers (or server instances) only one wins. If the winner
   * dies mid-send, the lease runs out and the delivery is due again.
   */
  async claim(id: string, expectedNextAttemptAt: string, leaseUntil: string): Promise<boolean> {
    const result = await this.db
      .updateTable('webhook_deliveries')
      .set({ next_attempt_at: leaseUntil })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .where('next_attempt_at', '=', expectedNextAttemptAt)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async recordAttempt(
    id: string,
    outcome: Pick<WebhookDelivery, 'status' | 'attempts' | 'next_attempt_at' | 'last_attempt_at' | 'response_status' | 'response_body' | 'error' | 'duration_ms'>
  ): Promise<void> {
    await this.db.updateTable('webhook_deliveries').set(outcome).where('id', '=', id).execute();
  }

  /** A webhook's deliveries, newest first, a page at a time (keyset on created_at, id). */
  async listDeliveries(webhookId: string, filters: { status?: string }, page: { limit: number; cursor?: string | null }): Promise<Page<WebhookDeliverySummary>> {
    let query = this.db.selectFrom('webhook_deliveries').select(SUMMARY_COLUMNS).where('webhook_id', '=', webhookId);
    if (filters.status) query = query.where('status', '=', filters.status);
    const cursor = decodeCursor(page.cursor);
    if (cursor) {
      query = query.where((eb) => eb.or([eb('created_at', '<', cursor.ts), eb.and([eb('created_at', '=', cursor.ts), eb('id', '<', cursor.id)])]));
    }
    const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(page.limit + 1).execute();
    return toPage(rows, page.limit, (r) => ({ ts: r.created_at, id: r.id }));
  }

  /** Each webhook's latest delivery (for the webhook list). */
  async latestDeliveries(webhookIds: string[]): Promise<Map<string, WebhookDeliverySummary>> {
    const out = new Map<string, WebhookDeliverySummary>();
    for (const id of webhookIds) {
      const row = await this.db
        .selectFrom('webhook_deliveries')
        .select(SUMMARY_COLUMNS)
        .where('webhook_id', '=', id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row) out.set(id, row);
    }
    return out;
  }

  /** Deletes deliveries created before the cutoff (retention). */
  async pruneDeliveries(beforeIso: string): Promise<number> {
    const result = await this.db.deleteFrom('webhook_deliveries').where('created_at', '<', beforeIso).where('status', '!=', 'PENDING').executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }
}
