import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { isBlockedAddress } from '@testify/core';

/**
 * Where a webhook may send (decided with Elliot, 2026-10-12): public and private-network
 * addresses, but not loopback or link-local ones (cloud metadata at 169.254.169.254 among them),
 * unless WEBHOOK_ALLOW_LOCAL=true. The address is checked when the URL is saved (for literal IPs)
 * and again on every connection, after DNS (so a name that later resolves to 127.0.0.1 can't
 * slip through). Redirects aren't followed.
 */

export const WEBHOOK_URL_MAX_LENGTH = 2000;
const TIMEOUT_MS = 10_000;
const RESPONSE_BODY_LIMIT = 2048;

export class WebhookTargetError extends Error {}

/** The URL's problem, or null when it may be saved. */
export function webhookUrlProblem(raw: unknown, allowLocal: boolean): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'is required: the address to send events to';
  if (raw.length > WEBHOOK_URL_MAX_LENGTH) return `can be at most ${WEBHOOK_URL_MAX_LENGTH} characters`;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'is not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must start with https:// or http://';
  if (url.username || url.password) return "can't contain a user name or password (put a token in the path or query instead)";
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowLocal) {
    if (isIP(host) && isBlockedAddress(host)) return `points at a local address (${host}), which webhooks can't reach`;
    if (host === 'localhost' || host.endsWith('.localhost')) return "points at this server's own machine (localhost), which webhooks can't reach";
  }
  return null;
}

export interface WebhookResponse {
  status: number;
  body: string;
  duration_ms: number;
}

/**
 * POSTs one delivery. Resolves with the response (any status); rejects with WebhookTargetError
 * for a refused address, or another error for timeouts and network failures.
 */
export function postWebhook(rawUrl: string, body: string, headers: Record<string, string>, opts: { allowLocal: boolean; timeoutMs?: number }): Promise<WebhookResponse> {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return reject(new WebhookTargetError('The webhook URL is not valid'));
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // A literal IP skips DNS (and so the lookup below): check it here.
    if (!opts.allowLocal && isIP(host) && isBlockedAddress(host)) {
      return reject(new WebhookTargetError(`Refused: ${host} is a local address`));
    }
    const lookup = (hostname: string, options: any, callback: (...args: any[]) => void) => {
      dnsLookup(hostname, options, (err, address: string | LookupAddress[], family?: number) => {
        if (err) return callback(err, address, family);
        const all = Array.isArray(address) ? address : [{ address, family: family ?? 4 }];
        const blocked = opts.allowLocal ? undefined : all.find((a) => isBlockedAddress(a.address));
        if (blocked) return callback(new WebhookTargetError(`Refused: ${hostname} resolves to a local address (${blocked.address})`), address, family);
        callback(null, address, family);
      });
    };

    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body).toString() }, lookup }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (text.length < RESPONSE_BODY_LIMIT) text += chunk;
      });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, body: text.slice(0, RESPONSE_BODY_LIMIT), duration_ms: Date.now() - started });
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    // The whole delivery, not just an idle socket, gets TIMEOUT_MS.
    const timer = setTimeout(() => req.destroy(new Error(`No answer within ${timeoutMs / 1000} s`)), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
