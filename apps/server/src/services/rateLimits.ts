import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../middleware/auth.js';
import { sendProblemDetails } from '../errors.js';

/**
 * Rate limits for the expensive or outward-facing parts of the API. They're deliberately
 * generous -- CI runners, scripts and MCP agents can make many more calls than a person
 * clicking around -- and exist to stop runaway loops and abuse, not normal use.
 *
 * - Every request made with an API token: API_TOKEN_REQUESTS_PER_MINUTE per token.
 * - Exports (definitions and execution results): EXPORTS_PER_HOUR per user or token.
 * - Sending report emails (Email this report, a schedule's Send now, the admin's test email):
 *   REPORT_EMAILS_PER_HOUR per user or token. Each send is already capped at 50 recipients.
 *   Previews aren't counted, and neither are scheduled sends (at most one a day each).
 *
 * Each limit is a token bucket: a caller may use the whole allowance at once, and it refills
 * evenly over the window. The counts are kept in memory per server process, so with several
 * instances each keeps its own.
 */
export const API_TOKEN_REQUESTS_PER_MINUTE = 1200;
export const EXPORTS_PER_HOUR = 120;
export const REPORT_EMAILS_PER_HOUR = 60;

export interface RateLimitResult {
  allowed: boolean;
  /** Whole seconds until the next call would be allowed (0 when allowed). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number
  ) {}

  /** Uses one call of `key`'s allowance, if there's one left. */
  take(key: string, now = Date.now()): RateLimitResult {
    const refillPerMs = this.limit / this.windowMs;
    const bucket = this.buckets.get(key) ?? { tokens: this.limit, updatedAt: now };
    const tokens = Math.min(this.limit, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    if (this.buckets.size > 10_000) this.prune(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drops callers whose allowance has fully refilled (they look the same as new ones). */
  private prune(now: number): void {
    const refillPerMs = this.limit / this.windowMs;
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.updatedAt) * refillPerMs >= this.limit) this.buckets.delete(key);
    }
  }
}

export interface RateLimits {
  apiToken: RateLimiter;
  exports: RateLimiter;
  reportEmails: RateLimiter;
}

export function createRateLimits(): RateLimits {
  return {
    apiToken: new RateLimiter(API_TOKEN_REQUESTS_PER_MINUTE, 60_000),
    exports: new RateLimiter(EXPORTS_PER_HOUR, 60 * 60_000),
    reportEmails: new RateLimiter(REPORT_EMAILS_PER_HOUR, 60 * 60_000),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    rateLimits: RateLimits;
  }
}

/** Whose allowance a call uses: an API token's own, or the signed-in user's. */
export function callerKey(user: AuthenticatedUser): string {
  return user.api_token ? `token:${user.api_token.id}` : `user:${user.id}`;
}

function describeRetry(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function describeLimit(limiter: RateLimiter): string {
  return limiter.windowMs === 60_000 ? `${limiter.limit} per minute` : `${limiter.limit} per hour`;
}

/** 429 with Retry-After, saying what was limited and when to try again. */
export function sendRateLimitedError(
  reply: FastifyReply,
  what: string,
  limiter: RateLimiter,
  retryAfterSeconds: number,
  instance?: string
) {
  reply.header('Retry-After', String(retryAfterSeconds));
  return sendProblemDetails(reply, {
    code: 'RATE_LIMITED',
    status: 429,
    title: 'Too Many Requests',
    detail: `Too many ${what}: the limit is ${describeLimit(limiter)}. Try again in ${describeRetry(retryAfterSeconds)}.`,
    instance,
  });
}

/**
 * Counts one call against `limiter` for the signed-in caller. Returns true when the call may go
 * ahead; otherwise the 429 has been sent and the route should return.
 */
export function withinRateLimit(request: FastifyRequest, reply: FastifyReply, limiter: RateLimiter, what: string): boolean {
  const user = request.user;
  if (!user) return true;
  const result = limiter.take(callerKey(user));
  if (result.allowed) return true;
  sendRateLimitedError(reply, what, limiter, result.retryAfterSeconds, request.url);
  return false;
}
