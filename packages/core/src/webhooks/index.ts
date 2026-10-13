import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Webhooks (API roadmap step 7): the events Testify sends, how a delivery is signed, the
 * Slack-style message for webhooks that want one, and which addresses a webhook may not reach.
 * The server's delivery worker is apps/server/src/services/webhooks.ts.
 */

export interface WebhookEventDefinition {
  key: string;
  group: 'Runs' | 'Results' | 'Test cases' | 'Imports';
  description: string;
}

/** Every event a webhook can subscribe to (`ping` is sent only by "Send test"). */
export const WEBHOOK_EVENTS: WebhookEventDefinition[] = [
  { key: 'run.created', group: 'Runs', description: 'A test run was started (in the web app, through the API, or by CI naming a new run).' },
  { key: 'run.closed', group: 'Runs', description: 'A test run was closed (by hand, by CI with close_run, or automatically once every case had a result), with its summary.' },
  { key: 'results.failed', group: 'Results', description: 'Results were recorded and at least one is FAILED or BLOCKED: one event per request (a CI upload, a hotkey), listing the failures.' },
  { key: 'results.recorded', group: 'Results', description: 'Results were recorded: one event per request, with counts by verdict.' },
  { key: 'test_case.created', group: 'Test cases', description: 'A test case was created (not by an import), e.g. a DRAFT for review.' },
  { key: 'test_case.approved', group: 'Test cases', description: "A test case's version was approved." },
  { key: 'test_case.deprecated', group: 'Test cases', description: 'A test case was deprecated.' },
  { key: 'test_case.restored', group: 'Test cases', description: 'A deprecated test case was restored.' },
  { key: 'import.completed', group: 'Imports', description: 'An import finished, with its counts.' },
];

export const WEBHOOK_EVENT_KEYS: string[] = WEBHOOK_EVENTS.map((e) => e.key);

export const WEBHOOK_FORMATS = ['json', 'slack'] as const;
export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

/** What every delivery carries (the body of a `json` webhook). */
export interface WebhookEnvelope {
  /** The event's id: the same for every webhook and every retry or redelivery of it. */
  id: string;
  event: string;
  created_at: string;
  project: { id: string; name: string; prefix: string };
  actor: { type: 'USER' | 'SERVICE_ACCOUNT' | 'SYSTEM'; name: string } | null;
  /** A link into the web app, when the server's public URL is set. */
  url: string | null;
  data: Record<string, any>;
}

/**
 * The signature: hex HMAC-SHA256 of `${timestamp}.${body}` with the webhook's secret. Sent as
 * X-Signature-SHA256, with the Unix-seconds timestamp in X-Signature-Timestamp; a receiver
 * recomputes it and rejects stale timestamps (replays).
 */
export function signWebhook(secret: string, timestamp: number | string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// ---- Addresses ----

function ipv4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 127 || // loopback
    a === 0 || // "this network"
    (a === 169 && b === 254) || // link-local, incl. cloud metadata (169.254.169.254)
    a >= 224 // multicast, reserved, broadcast
  );
}

/**
 * Whether a webhook may not connect to this address (unless the server allows local targets):
 * loopback, unspecified, link-local (cloud metadata lives there) and multicast, in IPv4, IPv6 and
 * IPv4-mapped IPv6. Private networks (10/8, 172.16/12, 192.168/16, fc00::/7) are allowed: on a
 * self-hosted server they're where Jenkins or Jira live. Anything that isn't an IP is blocked.
 */
export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().replace(/^\[|\]$/g, '').split('%')[0];
  const family = isIP(ip);
  if (family === 4) return ipv4Blocked(ip);
  if (family !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped: ::ffff:1.2.3.4, or its hex form ::ffff:7f00:1.
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(lower)?.[1];
  if (mapped) {
    if (isIP(mapped) === 4) return ipv4Blocked(mapped);
    const parts = mapped.split(':');
    if (parts.length === 2) {
      const hi = parseInt(parts[0], 16);
      const lo = parseInt(parts[1], 16);
      return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
  }
  const expanded = expandIPv6(lower);
  if (expanded.every((g) => g === 0)) return true; // ::
  if (expanded.slice(0, 7).every((g) => g === 0) && expanded[7] === 1) return true; // ::1
  if ((expanded[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((expanded[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** An IPv6 address as its 8 groups (also with an embedded IPv4 tail, e.g. 64:ff9b::1.2.3.4). */
function expandIPv6(ip: string): number[] {
  let text = ip;
  const v4Groups: string[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (v4) {
    const [a, b, c, d] = v4.split('.').map(Number);
    v4Groups.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
    text = text.slice(0, -v4.length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const hex = (g: string) => parseInt(g || '0', 16);
  if (!text.includes('::')) return [...text.split(':').filter(Boolean), ...v4Groups].map(hex);
  const [head, tail] = text.split('::');
  const h = head ? head.split(':') : [];
  const t = [...(tail ? tail.split(':') : []), ...v4Groups];
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].map(hex);
}

// ---- Slack-style messages ----

/** Slack's mrkdwn escaping: test content can't add links or mentions (<!channel>). */
export function slackEscape(text: unknown): string {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const percent = (rate: unknown) => (typeof rate === 'number' ? `${Math.round(rate * 1000) / 10}%` : '–');

/** Up to 10 failures as bullet lines. */
function failureLines(failures: any[] | undefined, truncated: boolean | undefined, total?: number): string {
  if (!Array.isArray(failures) || failures.length === 0) return '';
  const shown = failures.slice(0, 10);
  const lines = shown.map((f) => {
    const msg = f.failure_message ? ` — ${clip(slackEscape(f.failure_message), 150)}` : '';
    const verdict = f.verdict && f.verdict !== 'FAILED' ? ` (${slackEscape(f.verdict)})` : '';
    return `• *${slackEscape(f.external_id)}* ${clip(slackEscape(f.title), 120)}${verdict}${msg}`;
  });
  const more = (total ?? failures.length) - shown.length;
  if (more > 0) lines.push(`…and ${more} more`);
  else if (truncated) lines.push('…and more');
  return lines.join('\n');
}

function countsLine(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([verdict, n]) => `${n} ${verdict.toLowerCase().replace(/_/g, ' ')}`)
    .join(' · ');
}

/** The headline for each event, in Slack mrkdwn. */
function headline(env: WebhookEnvelope): string {
  const d = env.data ?? {};
  const run = d.run ? `*${slackEscape(d.run.name)}*` : 'a run';
  const plan = d.plan ? ` (plan ${slackEscape(d.plan.name)})` : '';
  const tc = d.test_case ? `*${slackEscape(d.test_case.external_id)}* ${slackEscape(d.test_case.title)}` : 'A test case';
  switch (env.event) {
    case 'ping':
      return `:bell: Testify webhook *${slackEscape(d.webhook?.name)}* works.`;
    case 'run.created':
      return `:arrow_forward: Run ${run} started${plan}.`;
    case 'run.closed': {
      const s = d.summary ?? {};
      const counts = { passed: s.passed, failed: s.failed, blocked: s.blocked, skipped: s.skipped, untested: s.untested };
      const executed = (s.total ?? 0) - (s.untested ?? 0);
      const cmp = s.compared_to ? ` Compared with ${slackEscape(s.compared_to.name)}: ${s.new_failures ?? 0} new failure${s.new_failures === 1 ? '' : 's'}, ${s.fixed ?? 0} fixed.` : '';
      return `:checkered_flag: Run ${run}${plan} closed: *${percent(s.pass_rate)} passed*, ${executed}/${s.total ?? 0} executed. ${countsLine(counts)}.${cmp}`;
    }
    case 'results.failed':
      return `:x: ${d.failed_count} failed in run ${run}${plan}. ${countsLine(d.counts)}.`;
    case 'results.recorded':
      return `:memo: ${d.recorded} result${d.recorded === 1 ? '' : 's'} recorded in run ${run}${plan}: ${countsLine(d.counts)}.`;
    case 'test_case.created': {
      const status = d.version?.status === 'DRAFT' ? ' as a DRAFT, waiting for review' : '';
      const via = d.via === 'mcp' ? ' by an AI agent' : '';
      return `:new: ${tc} was created${via}${status}.`;
    }
    case 'test_case.approved':
      return `:white_check_mark: ${tc} was approved (version ${d.version?.version_number ?? '?'}).`;
    case 'test_case.deprecated':
      return `:file_cabinet: ${tc} was deprecated.`;
    case 'test_case.restored':
      return `:recycle: ${tc} was restored.`;
    case 'import.completed': {
      const c = d.counts ?? {};
      return `:inbox_tray: Import finished: ${c.imported_cases_count ?? 0} cases in ${c.imported_suites_count ?? 0} suites (${slackEscape(d.format)}).`;
    }
    default:
      return `Testify event ${slackEscape(env.event)}.`;
  }
}

/**
 * The event as a Slack-style message: `text` holds everything (Mattermost, Rocket.Chat and
 * Discord's /slack URLs show only it), `blocks` lays it out for Slack.
 */
export function renderSlackMessage(env: WebhookEnvelope): { text: string; blocks: unknown[] } {
  const d = env.data ?? {};
  const main = headline(env);
  const failures =
    env.event === 'run.closed'
      ? failureLines(d.summary?.failures, d.summary?.failures_truncated, d.summary?.failure_count)
      : env.event === 'results.failed' || env.event === 'results.recorded'
        ? failureLines(d.failures, d.failures_truncated, d.failed_count)
        : '';
  const link = env.url ? `<${env.url}|Open in Testify>` : '';
  const who = [`${slackEscape(env.project.name)}`, env.actor ? `by ${slackEscape(env.actor.name)}` : ''].filter(Boolean).join(' · ');

  const text = clip([main, failures, [who, link].filter(Boolean).join(' · ')].filter(Boolean).join('\n'), 3900);
  const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: clip(main, 2900) } }];
  if (failures) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clip(failures, 2900) } });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: clip([who, link].filter(Boolean).join(' · '), 2900) }] });
  return { text, blocks };
}
