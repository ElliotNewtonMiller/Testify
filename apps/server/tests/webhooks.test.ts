import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { signWebhook, WEBHOOK_EVENT_KEYS } from '@testify/core';
import { createServer } from '../src/server.js';
import { configureWebhooks, runDueWebhookDeliveries } from '../src/services/webhooks.js';

/** Webhooks (API roadmap step 7): settings, events, signed delivery, retries, address rules. */

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
  json: any;
}

/** A local HTTP receiver that records every request and answers with `respond`. */
async function startReceiver() {
  const got: Received[] = [];
  let respond: (res: http.ServerResponse) => void = (res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('thanks');
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      got.push({ headers: req.headers, body, json });
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    port,
    got,
    events: () => got.map((g) => g.json?.event),
    answer(fn: (res: http.ServerResponse) => void) {
      respond = fn;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('Webhooks', () => {
  let app: any;
  let db: any;
  let seed: any;
  let admin: string;
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  const body = (res: any) => JSON.parse(res.payload || '{}');
  const call = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload } : {}) });
  const createHook = (payload: Record<string, unknown>) =>
    call(admin, 'POST', `/api/v1/projects/${seed.projectId}/webhooks`, { name: 'Team chat', url: receiver.url, events: WEBHOOK_EVENT_KEYS, ...payload });
  const deliver = (offsetMs = 0) => runDueWebhookDeliveries(db, new Date(Date.now() + offsetMs));

  beforeEach(async () => {
    ({ app, db, seed } = await createServer(undefined, { webhooks: { allowLocal: true, deliverImmediately: false, timeoutMs: 500 } }));
    admin = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'password' } })).token;
    receiver = await startReceiver();
  });
  afterEach(async () => {
    await receiver.close();
    await app.close();
  });

  it('creates, lists, changes, rotates and deletes webhooks; only WEBHOOK_MANAGE may, never a token', async () => {
    const created = await createHook({ events: ['run.created'] });
    expect(created.statusCode, created.payload).toBe(201);
    const { webhook, secret } = body(created);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    expect(webhook).toMatchObject({ name: 'Team chat', format: 'json', events: ['run.created'], enabled: true, secret_hint: secret.slice(-4), last_delivery: null });
    expect(JSON.stringify(webhook)).not.toContain(secret);

    const listed = body(await call(admin, 'GET', `/api/v1/projects/${seed.projectId}/webhooks`)).webhooks;
    expect(listed.map((w: any) => w.id)).toEqual([webhook.id]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    const patched = body(await call(admin, 'PATCH', `/api/v1/webhooks/${webhook.id}`, { format: 'slack', events: ['run.closed', 'run.closed'], name: 'Slack' })).webhook;
    expect(patched).toMatchObject({ format: 'slack', events: ['run.closed'], name: 'Slack' });

    for (const [payload, name] of [
      [{ url: 'ftp://x.example/hook' }, 'url'],
      [{ url: 'https://user:pw@x.example/hook' }, 'url'],
      [{ events: [] }, 'events'],
      [{ events: ['run.exploded'] }, 'events'],
      [{ format: 'xml' }, 'format'],
      [{ name: ' ' }, 'name'],
    ] as const) {
      const res = await call(admin, 'PATCH', `/api/v1/webhooks/${webhook.id}`, payload);
      expect([res.statusCode, body(res).invalid_params?.[0]?.name], JSON.stringify(payload)).toEqual([400, name]);
    }

    const rotated = body(await call(admin, 'POST', `/api/v1/webhooks/${webhook.id}/rotate-secret`));
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.webhook.secret_hint).toBe(rotated.secret.slice(-4));

    // Tokens can't hold WEBHOOK_MANAGE; a Tester doesn't have it.
    const tokenRes = await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'x', capabilities: ['SPEC_VIEW', 'WEBHOOK_MANAGE'] });
    expect(tokenRes.statusCode).toBe(400);
    const viewer = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'v', capabilities: ['SPEC_VIEW'] })).plaintext;
    expect((await call(viewer, 'GET', `/api/v1/projects/${seed.projectId}/webhooks`)).statusCode).toBe(403);
    expect((await call(viewer, 'GET', `/api/v1/webhooks/${webhook.id}`)).statusCode).toBe(403);
    const username = `tester_${Date.now()}`;
    await call(admin, 'POST', '/api/v1/admin/users', { username, email: `${username}@x.test`, password: 'SecurePass123!', global_role: 'Tester' });
    const tester = body(await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SecurePass123!' } })).token;
    expect((await call(tester, 'GET', `/api/v1/projects/${seed.projectId}/webhooks`)).statusCode).toBe(403);
    expect(body(await call(tester, 'GET', '/api/v1/webhook-events')).events.map((e: any) => e.key)).toEqual(WEBHOOK_EVENT_KEYS);

    expect((await call(admin, 'DELETE', `/api/v1/webhooks/${webhook.id}`)).statusCode).toBe(204);
    expect((await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}`)).statusCode).toBe(404);

    const audit = body(await call(admin, 'GET', '/api/v1/admin/audit-logs')).audit_logs.map((r: any) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['WEBHOOK_CREATED', 'WEBHOOK_UPDATED', 'WEBHOOK_SECRET_ROTATED', 'WEBHOOK_DELETED']));
  });

  it('delivers a signed JSON envelope; ping, redeliver, the Slack format and the delivery log', async () => {
    await call(admin, 'PUT', '/api/v1/admin/email-settings', { public_url: 'https://testify.example' });
    const { webhook, secret } = body(await createHook({ events: ['run.created'] }));
    const run = body(await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Nightly 1' })).run;
    expect(receiver.got).toHaveLength(0); // queued, not sent yet (deliverImmediately is off here)
    expect((await deliver()).map((d) => d.status)).toEqual(['SUCCEEDED']);

    const [hit] = receiver.got;
    expect(hit.headers['content-type']).toBe('application/json');
    expect(hit.headers['x-testify-event']).toBe('run.created');
    expect(hit.headers['user-agent']).toBe('Testify-Webhooks/1');
    const ts = hit.headers['x-signature-timestamp'] as string;
    expect(Math.abs(Number(ts) - Date.now() / 1000)).toBeLessThan(60);
    expect(hit.headers['x-signature-sha256']).toBe(signWebhook(secret, ts, hit.body));
    expect(hit.json).toMatchObject({
      event: 'run.created',
      id: hit.headers['x-testify-event-id'],
      project: { id: seed.projectId, prefix: 'SHOP' },
      actor: { type: 'USER', name: 'admin' },
      url: `https://testify.example/#/reports/run?project=${seed.projectId}&plan=${seed.planId}&run=${run.id}`,
      data: { run: { id: run.id, name: 'Nightly 1', status: 'OPEN' }, plan: { id: seed.planId } },
    });

    // Ping: sent at once, answered with how it went.
    const ping = body(await call(admin, 'POST', `/api/v1/webhooks/${webhook.id}/ping`)).delivery;
    expect(ping).toMatchObject({ event: 'ping', status: 'SUCCEEDED', attempts: 1, response_status: 200, response_body: 'thanks' });
    expect(receiver.got[1].json.data.webhook).toEqual({ id: webhook.id, name: 'Team chat' });

    // Redeliver: a new delivery of the same event.
    const first = body(await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}/deliveries?status=SUCCEEDED`)).deliveries.find((d: any) => d.event === 'run.created');
    const again = body(await call(admin, 'POST', `/api/v1/webhook-deliveries/${first.id}/redeliver`)).delivery;
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ event_id: first.event_id, status: 'SUCCEEDED' });
    expect(receiver.got[2].json.id).toBe(receiver.got[0].json.id);

    // The log, a page at a time, and one delivery in full.
    const page1 = body(await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}/deliveries?limit=2`));
    expect(page1.deliveries).toHaveLength(2);
    const page2 = body(await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}/deliveries?limit=2&cursor=${page1.next_cursor}`));
    expect(page2.deliveries).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
    const full = body(await call(admin, 'GET', `/api/v1/webhook-deliveries/${first.id}`)).delivery;
    expect(full.payload.data.run.name).toBe('Nightly 1');
    expect(body(await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}`)).webhook.last_delivery.status).toBe('SUCCEEDED');

    // Slack format: a message, still signed.
    await call(admin, 'PATCH', `/api/v1/webhooks/${webhook.id}`, { format: 'slack' });
    await call(admin, 'POST', `/api/v1/webhooks/${webhook.id}/ping`);
    const slack = receiver.got[3];
    expect(slack.json.text).toContain('Testify webhook *Team chat* works.');
    expect(Array.isArray(slack.json.blocks)).toBe(true);
    expect(slack.headers['x-signature-sha256']).toBe(signWebhook(secret, slack.headers['x-signature-timestamp'] as string, slack.body));

    // A turned-off webhook gets nothing.
    await call(admin, 'PATCH', `/api/v1/webhooks/${webhook.id}`, { enabled: false });
    await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Nightly 2' });
    await deliver();
    expect(receiver.got).toHaveLength(4);
    expect((await call(admin, 'POST', `/api/v1/webhooks/${webhook.id}/ping`)).statusCode).toBe(422);
  });

  it('sends every event from where it happens, only to subscribed webhooks of the project', async () => {
    const { webhook } = body(await createHook({}));
    const onlyClosed = await startReceiver();
    await createHook({ name: 'Runs only', url: onlyClosed.url, events: ['run.closed'] });
    const other = body(await call(admin, 'POST', '/api/v1/projects', { name: 'Other', prefix: 'OTH' })).project;
    const elsewhere = await startReceiver();
    await call(admin, 'POST', `/api/v1/projects/${other.id}/webhooks`, { name: 'x', url: elsewhere.url, events: WEBHOOK_EVENT_KEYS });

    // Results one at a time, until the run closes itself.
    const planCases = body(await call(admin, 'GET', `/api/v1/plans/${seed.planId}/cases?test_run_id=${seed.buildId}`)).cases;
    for (const [i, pc] of planCases.entries()) {
      await call(admin, 'POST', `/api/v1/runs/${seed.buildId}/results`, { test_plan_case_id: pc.test_plan_case_id, verdict: i === 0 ? 'FAILED' : 'PASSED' });
    }
    // CI: a JUnit upload into a new run, closed by CI.
    await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${seed.planId}/results/junit?run_name=CI%201&close_run=true`,
      headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/xml' },
      payload: '<testsuite name="x"><testcase name="SHOP-101 a"/><testcase name="SHOP-102 b"><failure message="boom"/></testcase></testsuite>',
    });
    // A run closed by a person.
    const manual = body(await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'Manual' })).run;
    await call(admin, 'PATCH', `/api/v1/runs/${manual.id}`, { status: 'CLOSED' });
    // Test cases: created, a draft approved, deprecated, restored; and one made by an agent through MCP.
    const created = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/cases`, { test_suite_id: seed.suiteId, title: 'New one' })).test_case;
    const draft = body(await call(admin, 'POST', '/api/v1/cases/SHOP-103/versions')).version;
    await call(admin, 'POST', `/api/v1/versions/${draft.id}/approve`);
    await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/cases/bulk`, { action: 'deprecate', case_ids: ['SHOP-104'] });
    await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/cases/bulk`, { action: 'restore', case_ids: ['SHOP-104'] });
    const agent = body(await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/api-tokens`, { name: 'agent', capabilities: ['SPEC_VIEW', 'SPEC_CREATE'] })).plaintext;
    await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${agent}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_case', arguments: { project_id: seed.projectId, test_suite_id: seed.suiteId, title: 'Agent case' } } },
    });
    // An import.
    await call(admin, 'POST', `/api/v1/projects/${seed.projectId}/imports/execute`, {
      file_content: '<testsuite name="Imported"><testcase classname="a.B" name="c"/></testsuite>',
      format: 'JUNIT_XML',
      configuration: { field_mappings: [], duplicate_resolution: { default_action: 'CREATE_NEW' } },
    });

    await deliver();
    const events = receiver.events();
    const count = (e: string) => events.filter((x) => x === e).length;
    expect(count('results.recorded')).toBe(planCases.length + 1); // one per result, one for the JUnit file
    expect(count('results.failed')).toBe(2);
    expect(count('run.created')).toBe(2); // the CI run, the manual run
    expect(count('run.closed')).toBe(3); // auto, ci, person
    expect(['test_case.created', 'test_case.approved', 'test_case.deprecated', 'test_case.restored', 'import.completed'].map(count)).toEqual([2, 1, 1, 1, 1]);
    expect(onlyClosed.events()).toEqual(['run.closed', 'run.closed', 'run.closed']);
    expect(elsewhere.got).toHaveLength(0);

    const find = (event: string, pred: (j: any) => boolean = () => true) => receiver.got.map((g) => g.json).find((j) => j.event === event && pred(j));
    const closed = receiver.got.map((g) => g.json).filter((j) => j.event === 'run.closed');
    expect(closed.map((j) => j.data.closed_by)).toEqual(['auto', 'ci', 'person']);
    expect(closed[0].data.summary).toMatchObject({ total: planCases.length, passed: planCases.length - 1, failed: 1, failure_count: 1 });
    expect(closed[0].data.summary.failures[0]).toMatchObject({ external_id: planCases[0].external_id, verdict: 'FAILED' });
    expect(closed[1].data.summary.compared_to.id).toBe(seed.buildId);
    const failedCi = find('results.failed', (j) => j.data.source === 'API');
    expect(failedCi.data).toMatchObject({ recorded: 2, counts: { passed: 1, failed: 1 }, failed_count: 1, failures: [{ external_id: 'SHOP-102', failure_message: 'boom' }] });
    expect(find('test_case.created', (j) => j.data.test_case.id === created.id).data).toMatchObject({ via: null, version: { status: 'APPROVED' } });
    const byAgent = find('test_case.created', (j) => j.data.via === 'mcp');
    expect(byAgent).toMatchObject({ actor: { type: 'SERVICE_ACCOUNT', name: 'agent (API token)' }, data: { test_case: { title: 'Agent case' }, version: { status: 'DRAFT' } } });
    expect(find('test_case.approved').data).toMatchObject({ test_case: { external_id: 'SHOP-103' }, version: { version_number: 2, status: 'APPROVED' } });
    expect(find('import.completed').data).toMatchObject({ format: 'JUNIT_XML', counts: { imported_cases_count: 1 } });
    expect(body(await call(admin, 'GET', `/api/v1/webhooks/${webhook.id}/deliveries?status=FAILED`)).deliveries).toHaveLength(0);
    await onlyClosed.close();
    await elsewhere.close();
  });

  it('retries failures with backoff, then gives up; never sends one delivery twice', async () => {
    await createHook({ events: ['run.created'] });
    receiver.answer((res) => {
      res.writeHead(500);
      res.end('down');
    });
    await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'R' });
    // Two workers at once (e.g. two server instances): one sends it.
    const [a, b] = await Promise.all([deliver(), deliver()]);
    expect(a.length + b.length).toBe(1);
    expect(receiver.got).toHaveLength(1);

    const hookId = body(await call(admin, 'GET', `/api/v1/projects/${seed.projectId}/webhooks`)).webhooks[0].id;
    const status = async () => body(await call(admin, 'GET', `/api/v1/webhooks/${hookId}/deliveries`)).deliveries[0];
    let d = await status();
    expect(d).toMatchObject({ status: 'PENDING', attempts: 1, response_status: 500, error: 'HTTP 500' });
    // Not due again until a minute has passed.
    expect(await deliver()).toHaveLength(0);
    // Then 5 more attempts, the last one gives up.
    const waits = [61_000, 5 * 60_000 + 61_000, 35 * 60_000 + 61_000, 155 * 60_000 + 61_000, 635 * 60_000 + 61_000];
    for (const wait of waits) await deliver(wait);
    d = await status();
    expect(d).toMatchObject({ status: 'FAILED', attempts: 6 });
    expect(receiver.got).toHaveLength(6);

    // A redirect isn't followed, and a receiver that doesn't answer times out.
    receiver.answer((res) => {
      res.writeHead(302, { location: 'http://example.com/' });
      res.end();
    });
    await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'R2' });
    await deliver();
    expect((await status()).error).toMatch(/redirects aren't followed/);
    receiver.answer(() => undefined);
    await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'R3' });
    await deliver();
    expect((await status()).error).toMatch(/No answer within 0.5 s/);
  });

  it("a receiver that doesn't answer holds up neither other webhooks nor its own later events for long", async () => {
    receiver.answer(() => undefined); // never answers
    await createHook({ name: 'Dead', events: ['run.created'] });
    const healthy = await startReceiver();
    await createHook({ name: 'Healthy', url: healthy.url, events: ['run.created'] });
    for (const name of ['A', 'B', 'C', 'D']) await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name });
    const started = Date.now();
    await deliver();
    // The healthy webhook got all four; the dead one was tried once (0.5 s), the rest left for the next pass.
    expect(healthy.events()).toEqual(['run.created', 'run.created', 'run.created', 'run.created']);
    expect(receiver.got).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1500);
    await healthy.close();
  });

  it("refuses local addresses unless allowed, also after DNS; a project's webhooks go with it", async () => {
    const hook = body(await createHook({ url: `http://localhost:${receiver.port}/hook`, events: ['run.created'] })).webhook;
    configureWebhooks({ allowLocal: false, deliverImmediately: false, timeoutMs: 500 });
    for (const url of [`http://127.0.0.1:${receiver.port}/x`, 'http://localhost/x', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x']) {
      const res = await createHook({ url });
      expect([res.statusCode, body(res).code], url).toEqual([400, 'INVALID_WEBHOOK_URL']);
    }
    // Public and private-network addresses are fine (subscribed to an event this test never causes, so nothing is sent).
    expect((await createHook({ url: 'https://hooks.slack.com/services/T0/B0/x', events: ['import.completed'] })).statusCode).toBe(201);
    expect((await createHook({ url: 'http://10.1.2.3:8080/jenkins', events: ['import.completed'] })).statusCode).toBe(201);

    // Saved while allowed; now refused when connecting (localhost resolves to a loopback address).
    await call(admin, 'POST', `/api/v1/plans/${seed.planId}/runs`, { name: 'R' });
    await deliver();
    const d = body(await call(admin, 'GET', `/api/v1/webhooks/${hook.id}/deliveries`)).deliveries[0];
    expect(d.error).toMatch(/Refused: localhost resolves to a local address/);
    expect(receiver.got).toHaveLength(0);

    // Deleting the project (force) removes its webhooks and their deliveries.
    configureWebhooks({ allowLocal: true, deliverImmediately: false, timeoutMs: 500 });
    expect((await call(admin, 'DELETE', `/api/v1/projects/${seed.projectId}?force=true`)).statusCode).toBe(204);
    expect(await db.selectFrom('webhooks').selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom('webhook_deliveries').selectAll().execute()).toHaveLength(0);
  });
});
