import { WEBHOOK_EVENT_KEYS, WEBHOOK_FORMATS } from '@testify/core';
import { authedErrors, NO_CONTENT, idParams, oneOf, handlerValidated, pageQuery, NEXT_CURSOR } from '../schemas.js';

/** Route schemas for routes/webhooks.ts (API roadmap step 7; RFC 03 §7.3). */

const TAGS = ['Webhooks'];
const NEEDS = ' Needs `WEBHOOK_MANAGE` in the project (never available to API tokens).';
const DELIVERY_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED'] as const;

export const WEBHOOK_PAGE = { defaultLimit: 50, maxLimit: 200 };

const nullableText = { type: ['string', 'null'] };

const deliverySummaryProperties = {
  id: { type: 'string', description: 'The delivery id (X-Testify-Delivery)' },
  webhook_id: { type: 'string' },
  event_id: { type: 'string', description: 'The event id (X-Testify-Event-Id, and `id` in the body): the same for every retry and redelivery' },
  event: { type: 'string' },
  status: oneOf(DELIVERY_STATUSES, 'PENDING: waiting for its first attempt or a retry; FAILED: gave up after 6 attempts (or the webhook was turned off or deleted).'),
  attempts: { type: 'integer' },
  next_attempt_at: { type: 'string', description: 'For PENDING: when it is tried next' },
  last_attempt_at: nullableText,
  response_status: { type: ['integer', 'null'], description: "The receiver's HTTP status" },
  error: { type: ['string', 'null'], description: 'Why the last attempt failed' },
  duration_ms: { type: ['integer', 'null'] },
  created_at: { type: 'string' },
};

const deliverySummary = { type: 'object', required: Object.keys(deliverySummaryProperties), properties: deliverySummaryProperties };

const delivery = {
  type: 'object',
  required: [...Object.keys(deliverySummaryProperties), 'payload', 'response_body'],
  properties: {
    ...deliverySummaryProperties,
    payload: { type: 'object', additionalProperties: true, description: 'The event envelope sent (for a Slack-format webhook, the message was rendered from it)' },
    response_body: { type: ['string', 'null'], description: "The start of the receiver's answer (up to 2 KB)" },
  },
};

const webhook = {
  type: 'object',
  required: ['id', 'project_id', 'name', 'url', 'format', 'events', 'enabled', 'secret_hint', 'created_by', 'created_at', 'updated_at', 'last_delivery'],
  properties: {
    id: { type: 'string' },
    project_id: { type: 'string' },
    name: { type: 'string' },
    url: { type: 'string' },
    format: oneOf(WEBHOOK_FORMATS, 'json: the signed event envelope; slack: a Slack-style message ({text, blocks}).'),
    events: { type: 'array', items: oneOf(WEBHOOK_EVENT_KEYS) },
    enabled: { type: 'boolean' },
    secret_hint: { type: ['string', 'null'], description: 'The last 4 characters of the signing secret (null if it can no longer be read: SECRETS_KEY changed)' },
    created_by: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    last_delivery: { anyOf: [deliverySummary, { type: 'null' }] },
  },
};

const webhookFields = {
  name: { type: 'string', description: '1-255 characters' },
  url: { type: 'string', description: 'http(s), at most 2,000 characters, no user name or password. Local addresses (localhost, 127.x, 169.254.x) are refused unless the server sets WEBHOOK_ALLOW_LOCAL.' },
  format: oneOf(WEBHOOK_FORMATS, 'Default json.'),
  events: { type: 'array', minItems: 1, items: oneOf(WEBHOOK_EVENT_KEYS), description: 'The events to send (GET /api/v1/webhook-events lists them)' },
  enabled: { type: 'boolean', description: 'Default true' },
};

const withSecret = (description: string) => ({
  description,
  type: 'object',
  required: ['webhook', 'secret'],
  properties: {
    webhook,
    secret: { type: 'string', description: 'The signing secret (whsec_...). Shown only now: store it where the receiver can check signatures.' },
  },
});

const wrappedWebhook = (description: string) => ({ description, type: 'object', required: ['webhook'], properties: { webhook } });
const wrappedDelivery = (description: string) => ({ description, type: 'object', required: ['delivery'], properties: { delivery } });

const URL_400: [number, string] = [400, '`INVALID_WEBHOOK_URL`, `INVALID_NAME`, `INVALID_REQUEST` (`invalid_params` names each problem), or `SECRETS_KEY_REQUIRED`'];

export const webhookEventsSchema = {
  tags: TAGS,
  summary: 'Webhook events',
  description: 'Every event a webhook can subscribe to, grouped, with what it means. Any signed-in user.',
  response: {
    200: {
      description: 'The events',
      type: 'object',
      required: ['events', 'formats'],
      properties: {
        events: {
          type: 'array',
          items: { type: 'object', required: ['key', 'group', 'description'], properties: { key: { type: 'string' }, group: { type: 'string' }, description: { type: 'string' } } },
        },
        formats: { type: 'array', items: { type: 'string' } },
      },
    },
    ...authedErrors(),
  },
};

export const listWebhooksSchema = {
  tags: TAGS,
  summary: "A project's webhooks",
  description: 'With each one\'s latest delivery.' + NEEDS,
  params: idParams('projectId'),
  response: { 200: { description: 'The webhooks', type: 'object', required: ['webhooks'], properties: { webhooks: { type: 'array', items: webhook } } }, ...authedErrors(404) },
};

export const createWebhookSchema = {
  tags: TAGS,
  summary: 'Create a webhook',
  description:
    'Every delivery is POSTed as JSON and signed: `X-Signature-Timestamp` (Unix seconds) and `X-Signature-SHA256`, the hex HMAC-SHA256 of `{timestamp}.{body}` with the secret answered here (only now). ' +
    'Failed deliveries (no answer within 10 s, or not 2xx; redirects are not followed) are retried after 1 min, 5 min, 30 min, 2 h and 8 h. At most 20 webhooks per project.' +
    NEEDS,
  params: idParams('projectId'),
  body: handlerValidated({ type: 'object', required: ['name', 'url', 'events'], properties: webhookFields }),
  response: { 201: withSecret('Created'), ...authedErrors(URL_400, 404, [409, '`WEBHOOK_LIMIT`: the project already has 20']) },
};

export const getWebhookSchema = {
  tags: TAGS,
  summary: 'A webhook',
  description: NEEDS.trim(),
  params: idParams('webhookId'),
  response: { 200: wrappedWebhook('The webhook'), ...authedErrors(404) },
};

export const updateWebhookSchema = {
  tags: TAGS,
  summary: 'Change a webhook',
  description: 'Any of name, url, format, events and enabled. Turning a webhook off fails its pending deliveries.' + NEEDS,
  params: idParams('webhookId'),
  body: handlerValidated({ type: 'object', properties: webhookFields }),
  response: { 200: wrappedWebhook('Changed'), ...authedErrors(URL_400, 404) },
};

export const deleteWebhookSchema = {
  tags: TAGS,
  summary: 'Delete a webhook',
  description: 'With its delivery log.' + NEEDS,
  params: idParams('webhookId'),
  response: { 204: NO_CONTENT, ...authedErrors(404) },
};

export const rotateWebhookSecretSchema = {
  tags: TAGS,
  summary: "Replace a webhook's signing secret",
  description: 'The old secret stops working at once; deliveries still waiting are signed with the new one.' + NEEDS,
  params: idParams('webhookId'),
  response: { 200: withSecret('The new secret'), ...authedErrors([400, '`SECRETS_KEY_REQUIRED`'], 404) },
};

export const pingWebhookSchema = {
  tags: TAGS,
  summary: 'Send a test event',
  description: 'Sends a `ping` event now (even if the webhook is not subscribed to anything else) and answers how it went.' + NEEDS,
  params: idParams('webhookId'),
  response: { 201: wrappedDelivery('Sent (see `status`, `response_status` and `error`)'), ...authedErrors(404, [422, 'The webhook is turned off']) },
};

export const listDeliveriesSchema = {
  tags: TAGS,
  summary: "A webhook's deliveries",
  description: 'Newest first, a page at a time (`limit`, then `cursor` = the previous `next_cursor` until it is null). Deliveries are kept 30 days.' + NEEDS,
  params: idParams('webhookId'),
  querystring: {
    type: 'object',
    properties: { status: oneOf(DELIVERY_STATUSES), ...pageQuery(WEBHOOK_PAGE.defaultLimit, WEBHOOK_PAGE.maxLimit) },
  },
  response: {
    200: { description: 'A page of deliveries', type: 'object', required: ['deliveries', 'next_cursor'], properties: { deliveries: { type: 'array', items: deliverySummary }, next_cursor: NEXT_CURSOR } },
    ...authedErrors([400, '`INVALID_CURSOR`'], 404),
  },
};

export const getDeliverySchema = {
  tags: TAGS,
  summary: 'A delivery',
  description: 'With what was sent and the start of the answer.' + NEEDS,
  params: idParams('deliveryId'),
  response: { 200: wrappedDelivery('The delivery'), ...authedErrors(404) },
};

export const redeliverSchema = {
  tags: TAGS,
  summary: 'Send a delivery again',
  description: 'A new delivery of the same event (same event id, so receivers can recognise it), sent now.' + NEEDS,
  params: idParams('deliveryId'),
  response: { 201: wrappedDelivery('Sent (see `status`)'), ...authedErrors(404, [422, 'The webhook is turned off']) },
};
