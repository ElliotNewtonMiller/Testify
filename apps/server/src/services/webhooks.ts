import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database, WebhookDelivery } from '@testify/db';
import { ProjectRepository, WebhookRepository } from '@testify/db';
import { renderSlackMessage, signWebhook, type WebhookEnvelope } from '@testify/core';
import { getSecretBox } from './secrets.js';
import { loadEmailSettings } from './mailer.js';
import { actorNames } from './actorNames.js';
import { postWebhook } from './webhookTargets.js';

/**
 * Webhook delivery (API roadmap step 7; RFC 03 §7.3). An event becomes one PENDING row per
 * subscribed webhook in `webhook_deliveries` (the outbox). The worker claims due rows with a
 * compare-and-set lease (as scheduled report emails are claimed), so several server instances
 * never send one twice, then POSTs them, signed, and retries failures with backoff. Deliveries
 * are kicked at once when an event is queued; a poller (startServer) picks up retries.
 *
 * Emitting never fails the request that caused the event: problems are only logged.
 */

/** Waits before attempts 2..6 (after attempt 6 fails, the delivery is FAILED). About 11 hours in all. */
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 8 * 3_600_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const LEASE_MS = 2 * 60_000;
const BATCH = 200;
const PARALLEL_WEBHOOKS = 10;
const RETENTION_MS = 30 * 24 * 3_600_000;

/** Set by createServer: may webhooks reach local addresses, are deliveries sent at once, and how long to wait for an answer. */
let settings = { allowLocal: false, deliverImmediately: true, timeoutMs: 10_000 };

export function configureWebhooks(next: { allowLocal: boolean; deliverImmediately: boolean; timeoutMs?: number }): void {
  settings = { ...next, timeoutMs: next.timeoutMs ?? 10_000 };
}

export function webhooksAllowLocal(): boolean {
  return settings.allowLocal;
}

export type WebhookActor = { id: string; type: 'USER' | 'SERVICE_ACCOUNT' } | null;

/** A link into the web app (a Reports hash link), made absolute with the server's public URL. */
export type WebhookLink = { tab: 'run' | 'overview'; plan?: string; run?: string; case?: string } | null;

async function absoluteLink(db: Kysely<Database>, projectId: string, link: WebhookLink): Promise<string | null> {
  if (!link) return null;
  const { public_url } = await loadEmailSettings(db);
  if (!public_url) return null;
  const q = new URLSearchParams({ project: projectId });
  if (link.plan) q.set('plan', link.plan);
  if (link.run) q.set('run', link.run);
  if (link.case) q.set('case', link.case);
  return `${public_url.replace(/\/+$/, '')}/#/reports/${link.tab}?${q.toString()}`;
}

export async function buildEnvelope(
  db: Kysely<Database>,
  e: { projectId: string; event: string; actor: WebhookActor; data: Record<string, unknown>; link?: WebhookLink; eventId?: string }
): Promise<WebhookEnvelope | null> {
  const project = await new ProjectRepository(db).findById(e.projectId);
  if (!project) return null;
  const actor = e.actor ? { type: e.actor.type, name: (await actorNames(db, [e.actor.id])).get(e.actor.id) ?? e.actor.id } : { type: 'SYSTEM' as const, name: 'Testify' };
  return {
    id: e.eventId ?? uuidv4(),
    event: e.event,
    created_at: new Date().toISOString(),
    project: { id: project.id, name: project.name, prefix: project.prefix },
    actor,
    url: await absoluteLink(db, e.projectId, e.link ?? null),
    data: e.data,
  };
}

/**
 * Queues an event for every enabled webhook of the project subscribed to it. `data` may be a
 * function, run only when someone is subscribed (e.g. the run summary for run.closed).
 */
export async function emitWebhookEvent(
  db: Kysely<Database>,
  e: { projectId: string; event: string; actor: WebhookActor; data: Record<string, unknown> | (() => Promise<Record<string, unknown>>); link?: WebhookLink }
): Promise<void> {
  try {
    const repo = new WebhookRepository(db);
    const hooks = await repo.subscribers(e.projectId, e.event);
    if (!hooks.length) return;
    const data = typeof e.data === 'function' ? await e.data() : e.data;
    const envelope = await buildEnvelope(db, { ...e, data });
    if (!envelope) return;
    const now = new Date().toISOString();
    const payload = JSON.stringify(envelope);
    await repo.insertDeliveries(
      hooks.map((h) => ({ id: uuidv4(), webhook_id: h.id, event_id: envelope.id, event: e.event, payload, next_attempt_at: now, created_at: now }))
    );
    if (settings.deliverImmediately) kick(db);
  } catch (err) {
    console.error(`[webhooks] Couldn't queue ${e.event}:`, err);
  }
}

// ---- The worker ----

/** Webhooks this process is sending to right now, per database: one sender per webhook. */
const sending = new WeakMap<object, Set<string>>();

/** Sends what's due soon after the current request. Passes may overlap: see runDueWebhookDeliveries. */
function kick(db: Kysely<Database>): void {
  setImmediate(() => {
    runDueWebhookDeliveries(db).catch((err) => console.error('[webhooks] Delivery failed:', err));
  });
}

let lastPrune = 0;

/**
 * Sends every due delivery (new ones and retries). Each webhook gets one sender at a time in this
 * process, which sends its due deliveries in order until there are none left; webhooks are sent
 * to in parallel (up to PARALLEL_WEBHOOKS per pass). A webhook whose receiver can't be reached
 * is left for later after one attempt, so a dead receiver holds up only itself. Every delivery is
 * claimed first (a compare-and-set lease), so overlapping passes and other server instances never
 * send one twice. Returns what happened to each delivery, for tests.
 */
export async function runDueWebhookDeliveries(db: Kysely<Database>, now: Date = new Date()): Promise<Array<{ id: string; status: string }>> {
  const repo = new WebhookRepository(db);
  if (now.getTime() - lastPrune > 3_600_000) {
    lastPrune = now.getTime();
    await repo.pruneDeliveries(new Date(now.getTime() - RETENTION_MS).toISOString());
  }
  const busy = sending.get(db) ?? new Set<string>();
  sending.set(db, busy);
  const out: Array<{ id: string; status: string }> = [];

  // Due by now -- the real now, not the pass's start: deliveries queued while this pass runs are
  // its to send too (a newer pass skips a webhook that's already being sent to).
  const dueBy = () => new Date(Math.max(now.getTime(), Date.now())).toISOString();
  const sendDueFor = async (webhookId: string) => {
    for (;;) {
      const due = await repo.findDue(dueBy(), BATCH, webhookId);
      if (!due.length) return false;
      for (const d of due) {
        if (!(await repo.claim(d.id, d.next_attempt_at, new Date(Math.max(now.getTime(), Date.now()) + LEASE_MS).toISOString()))) continue;
        const result = await attempt(db, d, now);
        out.push({ id: d.id, status: result.status });
        if (result.unreachable) return true;
      }
    }
  };

  const queue = [...new Set((await repo.findDue(dueBy(), BATCH)).map((d) => d.webhook_id))];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL_WEBHOOKS, queue.length) }, async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        if (busy.has(id)) continue; // another pass is sending to it, and will send these too
        busy.add(id);
        let unreachable = false;
        try {
          unreachable = await sendDueFor(id);
        } finally {
          busy.delete(id);
        }
        // A delivery queued as this sender was finishing was skipped by other passes: take it.
        if (!unreachable && (await repo.findDue(dueBy(), 1, id)).length) queue.push(id);
      }
    })
  );
  return out;
}

/** Sends one delivery now, whatever its schedule (Send test, Redeliver). */
export async function deliverNow(db: Kysely<Database>, deliveryId: string): Promise<WebhookDelivery | undefined> {
  const repo = new WebhookRepository(db);
  const d = await repo.findDelivery(deliveryId);
  if (!d) return undefined;
  if (d.status === 'PENDING' && (await repo.claim(d.id, d.next_attempt_at, new Date(Date.now() + LEASE_MS).toISOString()))) await attempt(db, d, new Date());
  return repo.findDelivery(deliveryId);
}

/** One attempt: sign, POST, record. Returns the delivery's new status, and whether the receiver couldn't be reached. Retries are scheduled from `now`. */
async function attempt(db: Kysely<Database>, d: WebhookDelivery, now: Date): Promise<{ status: string; unreachable: boolean }> {
  const repo = new WebhookRepository(db);
  const hook = await repo.findById(d.webhook_id);
  const attempts = d.attempts + 1;
  const startedAt = new Date();
  const finish = async (outcome: { ok: boolean; status?: number; body?: string; error?: string; duration_ms?: number }, retry = true, unreachable = false) => {
    const status = outcome.ok ? 'SUCCEEDED' : retry && attempts < MAX_ATTEMPTS ? 'PENDING' : 'FAILED';
    await repo.recordAttempt(d.id, {
      status,
      attempts,
      next_attempt_at: status === 'PENDING' ? new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]).toISOString() : d.next_attempt_at,
      last_attempt_at: startedAt.toISOString(),
      response_status: outcome.status ?? null,
      response_body: outcome.body ?? null,
      error: outcome.error ?? null,
      duration_ms: outcome.duration_ms ?? null,
    });
    return { status, unreachable };
  };

  if (!hook) return finish({ ok: false, error: 'The webhook was deleted' }, false);
  if (!hook.enabled) return finish({ ok: false, error: 'The webhook is turned off' }, false);
  const box = getSecretBox();
  let secret: string;
  try {
    if (!box) throw new Error('SECRETS_KEY is not set, so the signing secret is unavailable');
    secret = box.decrypt(hook.secret);
  } catch (err) {
    return finish({ ok: false, error: `Can't sign the delivery: ${(err as Error).message}` });
  }

  const envelope = JSON.parse(d.payload) as WebhookEnvelope;
  const body = hook.format === 'slack' ? JSON.stringify(renderSlackMessage(envelope)) : d.payload;
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Testify-Webhooks/1',
    'x-testify-event': d.event,
    'x-testify-event-id': d.event_id,
    'x-testify-delivery': d.id,
    'x-signature-timestamp': String(timestamp),
    'x-signature-sha256': signWebhook(secret, timestamp, body),
  };
  try {
    const res = await postWebhook(hook.url, body, headers, { allowLocal: settings.allowLocal, timeoutMs: settings.timeoutMs });
    const ok = res.status >= 200 && res.status < 300;
    const redirect = res.status >= 300 && res.status < 400;
    return finish({
      ok,
      status: res.status,
      body: res.body,
      duration_ms: res.duration_ms,
      error: ok ? undefined : redirect ? `HTTP ${res.status}: redirects aren't followed; use the final URL` : `HTTP ${res.status}`,
    });
  } catch (err) {
    return finish({ ok: false, error: (err as Error).message, duration_ms: Date.now() - startedAt.getTime() }, true, true);
  }
}
