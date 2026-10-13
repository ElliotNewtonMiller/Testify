import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database, Webhook, WebhookDelivery } from '@testify/db';
import { WebhookRepository } from '@testify/db';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_KEYS, WEBHOOK_FORMATS } from '@testify/core';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendError } from '../errors.js';
import { actorType, requestOrigin } from '../audit.js';
import { getSecretBox } from '../services/secrets.js';
import { webhookUrlProblem } from '../services/webhookTargets.js';
import { buildEnvelope, deliverNow, webhooksAllowLocal } from '../services/webhooks.js';
import { readPage } from '../paging.js';
import * as W from '../openapi/areas/webhooks.js';

/**
 * Webhooks (API roadmap step 7): a project's targets for its events, their signing secrets, and
 * the delivery log. Managing them needs WEBHOOK_MANAGE in the project, which API tokens can never
 * hold (a webhook sends project data to any address). Delivery itself is services/webhooks.ts.
 */

const MAX_WEBHOOKS_PER_PROJECT = 20;
const MAX_NAME_LENGTH = 255;

const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

interface WebhookBody {
  name?: unknown;
  url?: unknown;
  format?: unknown;
  events?: unknown;
  enabled?: unknown;
}

export async function registerWebhookRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const repo = new WebhookRepository(db);
  const manage = requirePermission('WEBHOOK_MANAGE', db, jwtSecret);

  /** The webhook as the API shows it: no secret, only its last 4 characters. */
  async function present(hook: Webhook, last?: Awaited<ReturnType<WebhookRepository['latestDeliveries']>>) {
    let hint: string | null = null;
    try {
      hint = getSecretBox()?.decrypt(hook.secret).slice(-4) ?? null;
    } catch {
      hint = null;
    }
    const { secret: _secret, ...rest } = hook;
    const latest = last ? last.get(hook.id) : (await repo.latestDeliveries([hook.id])).get(hook.id);
    return { ...rest, secret_hint: hint, last_delivery: latest ?? null };
  }

  const presentDelivery = (d: WebhookDelivery) => ({ ...d, payload: JSON.parse(d.payload) });

  /** Checks a create (all fields) or change (some); answers 400 and returns null on a problem. */
  function readBody(body: WebhookBody, reply: FastifyReply, creating: boolean) {
    const invalid: Array<{ name: string; reason: string }> = [];
    const out: { name?: string; url?: string; format?: string; events?: string[]; enabled?: boolean } = {};
    if (creating || body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) invalid.push({ name: 'name', reason: "can't be blank" });
      else if (body.name.trim().length > MAX_NAME_LENGTH) invalid.push({ name: 'name', reason: `can be at most ${MAX_NAME_LENGTH} characters` });
      else out.name = body.name.trim();
    }
    if (creating || body.url !== undefined) {
      const problem = webhookUrlProblem(body.url, webhooksAllowLocal());
      if (problem) {
        sendError(reply, 400, `url ${problem}`, { code: 'INVALID_WEBHOOK_URL', invalid_params: [{ name: 'url', reason: problem }] });
        return null;
      }
      out.url = (body.url as string).trim();
    }
    if (body.format !== undefined) {
      if (!(WEBHOOK_FORMATS as readonly unknown[]).includes(body.format)) invalid.push({ name: 'format', reason: `must be one of: ${WEBHOOK_FORMATS.join(', ')}` });
      else out.format = body.format as string;
    } else if (creating) out.format = 'json';
    if (creating || body.events !== undefined) {
      const events = Array.isArray(body.events) ? body.events : null;
      const unknown = events?.filter((e) => !WEBHOOK_EVENT_KEYS.includes(e as string)) ?? [];
      if (!events || events.length === 0) invalid.push({ name: 'events', reason: 'needs at least one event (see GET /api/v1/webhook-events)' });
      else if (unknown.length) invalid.push({ name: 'events', reason: `has unknown events: ${unknown.join(', ')}` });
      else out.events = [...new Set(events as string[])];
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') invalid.push({ name: 'enabled', reason: 'must be true or false' });
      else out.enabled = body.enabled;
    }
    if (invalid.length) {
      sendError(reply, 400, invalid.map((p) => `${p.name} ${p.reason}`).join('; '), { code: invalid.some((p) => p.name === 'name') ? 'INVALID_NAME' : 'INVALID_REQUEST', invalid_params: invalid });
      return null;
    }
    return out;
  }

  /** The secret, encrypted for storage; null after answering 400 when the server can't store it. */
  function sealSecret(reply: FastifyReply, plain: string): string | null {
    const box = getSecretBox();
    if (!box) {
      sendError(reply, 400, "The server can't store a webhook's signing secret securely: set SECRETS_KEY (32+ characters) in its environment and restart it.", {
        code: 'SECRETS_KEY_REQUIRED',
      });
      return null;
    }
    return box.encrypt(plain);
  }

  async function audit(request: FastifyRequest, action: string, hook: { id: string; project_id: string }, diff: Record<string, unknown>) {
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: request.user!.id,
        actor_type: actorType(request.user!),
        action,
        resource_type: 'webhook',
        resource_id: hook.id,
        project_id: hook.project_id,
        diff: JSON.stringify(diff),
        ...requestOrigin(request),
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  async function webhookInProject(request: FastifyRequest): Promise<Webhook | null> {
    const { webhookId } = request.params as { webhookId: string };
    const hook = await repo.findById(webhookId);
    return hook && hook.project_id === request.projectId ? hook : null;
  }

  /** Queues a delivery of this envelope to the webhook and sends it now. */
  async function sendNow(hook: Webhook, payload: string, event: string, eventId: string) {
    const now = new Date().toISOString();
    const id = uuidv4();
    await repo.insertDeliveries([{ id, webhook_id: hook.id, event_id: eventId, event, payload, next_attempt_at: now, created_at: now }]);
    return (await deliverNow(db, id))!;
  }

  app.get('/api/v1/webhook-events', { schema: W.webhookEventsSchema }, async (request, reply) => {
    if (!(await authenticateRequest(request, reply, db, jwtSecret))) return reply;
    return { events: WEBHOOK_EVENTS, formats: [...WEBHOOK_FORMATS] };
  });

  app.get('/api/v1/projects/:projectId/webhooks', { schema: W.listWebhooksSchema, preHandler: manage }, async (request) => {
    const hooks = await repo.listByProject(request.projectId!);
    const last = await repo.latestDeliveries(hooks.map((h) => h.id));
    return { webhooks: await Promise.all(hooks.map((h) => present(h, last))) };
  });

  app.post('/api/v1/projects/:projectId/webhooks', { schema: W.createWebhookSchema, preHandler: manage }, async (request, reply) => {
    const projectId = request.projectId!;
    const fields = readBody((request.body ?? {}) as WebhookBody, reply, true);
    if (!fields) return reply;
    if ((await repo.countByProject(projectId)) >= MAX_WEBHOOKS_PER_PROJECT) {
      return sendError(reply, 409, `A project can have at most ${MAX_WEBHOOKS_PER_PROJECT} webhooks`, { code: 'WEBHOOK_LIMIT' });
    }
    const secret = newSecret();
    const sealed = sealSecret(reply, secret);
    if (!sealed) return reply;
    const now = new Date().toISOString();
    const hook = await repo.create({
      id: uuidv4(),
      project_id: projectId,
      name: fields.name!,
      url: fields.url!,
      format: fields.format!,
      events: fields.events!,
      enabled: fields.enabled ?? true,
      secret: sealed,
      created_by: request.user!.id,
      created_at: now,
      updated_at: now,
    });
    await audit(request, 'WEBHOOK_CREATED', hook, { name: hook.name, host: new URL(hook.url).host, format: hook.format, events: hook.events });
    return reply.status(201).send({ webhook: await present(hook), secret });
  });

  app.get('/api/v1/webhooks/:webhookId', { schema: W.getWebhookSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    return { webhook: await present(hook) };
  });

  app.patch('/api/v1/webhooks/:webhookId', { schema: W.updateWebhookSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    const fields = readBody((request.body ?? {}) as WebhookBody, reply, false);
    if (!fields) return reply;
    const updated = (await repo.update(hook.id, fields))!;
    await audit(request, 'WEBHOOK_UPDATED', hook, {
      ...fields,
      ...(fields.url ? { url: undefined, host: new URL(fields.url).host } : {}),
    });
    return { webhook: await present(updated) };
  });

  app.delete('/api/v1/webhooks/:webhookId', { schema: W.deleteWebhookSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    await repo.delete(hook.id);
    await audit(request, 'WEBHOOK_DELETED', hook, { name: hook.name });
    return reply.status(204).send();
  });

  app.post('/api/v1/webhooks/:webhookId/rotate-secret', { schema: W.rotateWebhookSecretSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    const secret = newSecret();
    const sealed = sealSecret(reply, secret);
    if (!sealed) return reply;
    const updated = (await repo.update(hook.id, { secret: sealed }))!;
    await audit(request, 'WEBHOOK_SECRET_ROTATED', hook, { name: hook.name });
    return { webhook: await present(updated), secret };
  });

  app.post('/api/v1/webhooks/:webhookId/ping', { schema: W.pingWebhookSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    if (!hook.enabled) return sendError(reply, 422, 'The webhook is turned off: turn it on to send a test event', { code: 'WEBHOOK_DISABLED' });
    const envelope = await buildEnvelope(db, {
      projectId: hook.project_id,
      event: 'ping',
      actor: { id: request.user!.id, type: actorType(request.user!) },
      data: { webhook: { id: hook.id, name: hook.name } },
    });
    const delivery = await sendNow(hook, JSON.stringify(envelope), 'ping', envelope!.id);
    return reply.status(201).send({ delivery: presentDelivery(delivery) });
  });

  app.get('/api/v1/webhooks/:webhookId/deliveries', { schema: W.listDeliveriesSchema, preHandler: manage }, async (request, reply) => {
    const hook = await webhookInProject(request);
    if (!hook) return sendError(reply, 404, 'Webhook not found');
    const page = readPage(request, reply, W.WEBHOOK_PAGE.defaultLimit);
    if (!page) return reply;
    const { status } = request.query as { status?: string };
    const { rows, next_cursor } = await repo.listDeliveries(hook.id, { status }, page);
    return { deliveries: rows, next_cursor };
  });

  /** The delivery, if its webhook is in the request's project. */
  async function deliveryInProject(request: FastifyRequest): Promise<{ delivery: WebhookDelivery; hook: Webhook } | null> {
    const { deliveryId } = request.params as { deliveryId: string };
    const delivery = await repo.findDelivery(deliveryId);
    const hook = delivery ? await repo.findById(delivery.webhook_id) : undefined;
    return delivery && hook && hook.project_id === request.projectId ? { delivery, hook } : null;
  }

  app.get('/api/v1/webhook-deliveries/:deliveryId', { schema: W.getDeliverySchema, preHandler: manage }, async (request, reply) => {
    const found = await deliveryInProject(request);
    if (!found) return sendError(reply, 404, 'Delivery not found');
    return { delivery: presentDelivery(found.delivery) };
  });

  app.post('/api/v1/webhook-deliveries/:deliveryId/redeliver', { schema: W.redeliverSchema, preHandler: manage }, async (request, reply) => {
    const found = await deliveryInProject(request);
    if (!found) return sendError(reply, 404, 'Delivery not found');
    if (!found.hook.enabled) return sendError(reply, 422, 'The webhook is turned off: turn it on to send again', { code: 'WEBHOOK_DISABLED' });
    const delivery = await sendNow(found.hook, found.delivery.payload, found.delivery.event, found.delivery.event_id);
    return reply.status(201).send({ delivery: presentDelivery(delivery) });
  });
}
