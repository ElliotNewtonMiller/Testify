import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.js';
import {
  API_TOKEN_REQUESTS_PER_MINUTE,
  EXPORTS_PER_HOUR,
  REPORT_EMAILS_PER_HOUR,
  RateLimiter,
} from '../src/services/rateLimits.js';

/** Generous per-caller limits on API tokens, exports and report emails. */
describe('Rate limits', () => {
  let app: any;
  let seed: any;
  let admin: string;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });

  async function mintToken(capabilities: string[]): Promise<string> {
    const res = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: `t-${Math.random()}`, capabilities });
    expect(res.statusCode).toBe(201);
    return body(res).plaintext;
  }

  function expectRateLimited(res: any, limitText: RegExp) {
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(body(res)).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(body(res).detail).toMatch(limitText);
  }

  beforeEach(async () => {
    ({ app, seed } = await createServer());
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
  });
  afterEach(async () => {
    await app.close();
  });

  it('the limiter allows the whole allowance at once, refills evenly, and keeps callers apart', () => {
    const limiter = new RateLimiter(3, 60_000);
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => limiter.take('a', t0).allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a', t0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(20); // one call refills every 20 s
    expect(limiter.take('b', t0).allowed).toBe(true);
    expect(limiter.take('a', t0 + 19_000).allowed).toBe(false);
    expect(limiter.take('a', t0 + 21_000).allowed).toBe(true);

    // The defaults are generous.
    expect(API_TOKEN_REQUESTS_PER_MINUTE).toBeGreaterThanOrEqual(1000);
    expect(EXPORTS_PER_HOUR).toBeGreaterThanOrEqual(100);
    expect(REPORT_EMAILS_PER_HOUR).toBeGreaterThanOrEqual(50);
  });

  it('limits requests per API token, counts an import once, and leaves other tokens and sign-ins alone', async () => {
    app.rateLimits.apiToken = new RateLimiter(3, 60_000);
    const token = await mintToken(['SPEC_VIEW', 'IMPORT_DATA']);
    const other = await mintToken(['SPEC_VIEW']);
    const plans = `/api/v1/projects/${seed.projectId}/plans`;

    // An import authenticates twice internally; it still counts as one request.
    const xml = `<?xml version="1.0"?><testsuites><testsuite name="S"><testcase name="C"><summary>s</summary></testcase></testsuite></testsuites>`;
    const dry = await call(token, 'POST', `/api/v1/projects/${seed.projectId}/imports/dry-run`, {
      format: 'TESTLINK_XML',
      file_content: Buffer.from(xml).toString('base64'),
    });
    expect(dry.statusCode).toBe(200);
    expect((await call(token, 'GET', plans)).statusCode).toBe(200);
    expect((await call(token, 'GET', plans)).statusCode).toBe(200);
    expectRateLimited(await call(token, 'GET', plans), /requests with this API token: the limit is 3 per minute/);

    // MCP goes through the same token check.
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(mcp.statusCode).toBe(429);

    expect((await call(other, 'GET', plans)).statusCode).toBe(200);
    expect((await call(admin, 'GET', plans)).statusCode).toBe(200);
  });

  it('limits exports per caller, with a message saying when to retry', async () => {
    app.rateLimits.exports = new RateLimiter(2, 60 * 60_000);
    const url = `/api/v1/projects/${seed.projectId}/exports/definitions`;
    const payload = { format: 'JSON', scope: { type: 'PROJECT' } };
    expect((await call(admin, 'POST', url, payload)).statusCode).toBe(200);
    expect((await call(admin, 'POST', url, payload)).statusCode).toBe(200);
    expectRateLimited(await call(admin, 'POST', url, payload), /Too many exports: the limit is 2 per hour\. Try again in \d+ minutes?\./);
    // The other export route shares the allowance.
    expectRateLimited(
      await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/exports/results`, { format: 'JSON', test_run_id: seed.buildId }),
      /exports/
    );

    // A token is its own caller.
    const token = await mintToken(['EXPORT_DATA']);
    expect((await call(token, 'POST', url, payload)).statusCode).toBe(200);
  });

  it('limits sending report emails, but not previews; Send now and the test email share the limit', async () => {
    app.rateLimits.reportEmails = new RateLimiter(2, 60 * 60_000);
    const url = `/api/v1/projects/${seed.projectId}/report-emails`;
    const sections = [{ report_id: 'run_summary', params: { test_run_id: seed.buildId } }];

    for (let i = 0; i < 4; i++) expect((await call(admin, 'POST', url, { sections, preview: true })).statusCode).toBe(200);
    expect((await call(admin, 'POST', url, { sections, recipients: ['qa@example.com'] })).statusCode).toBe(201);

    const schedule = body(
      await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/report-schedules`, {
        name: 'Digest',
        sections: [{ kind: 'overview' }],
        recipients: 'qa@example.com',
        frequency: 'DAILY',
        time_of_day: '09:00',
        timezone: 'UTC',
      })
    ).schedule;
    expect((await call(admin, 'POST', `/api/v1/report-schedules/${schedule.id}/send-now`)).statusCode).toBe(200);

    expectRateLimited(await call(admin, 'POST', url, { sections, recipients: ['qa@example.com'] }), /Too many report emails: the limit is 2 per hour/);
    expectRateLimited(await call(admin, 'POST', `/api/v1/report-schedules/${schedule.id}/send-now`), /report emails/);
    expectRateLimited(await call(admin, 'POST', '/api/v1/admin/email-settings/test', { to: 'qa@example.com' }), /Too many emails/);
    // Previews still work.
    expect((await call(admin, 'POST', url, { sections, preview: true })).statusCode).toBe(200);
  });
});
