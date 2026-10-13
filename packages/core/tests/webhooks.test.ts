import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { WEBHOOK_EVENTS, isBlockedAddress, renderSlackMessage, signWebhook, slackEscape, type WebhookEnvelope } from '../src/webhooks/index.js';

describe('webhook signatures', () => {
  it('is the hex HMAC-SHA256 of "timestamp.body"', () => {
    const body = '{"event":"ping"}';
    expect(signWebhook('whsec_test', 1760000000, body)).toBe(createHmac('sha256', 'whsec_test').update(`1760000000.${body}`).digest('hex'));
    // A known vector (also: printf '1760000000.{"event":"ping"}' | openssl dgst -sha256 -hmac whsec_example),
    // so receivers in other languages can check their code against it. RFC 03 §7.3 shows it too.
    expect(signWebhook('whsec_example', 1760000000, '{"event":"ping"}')).toBe('1d37f6891520fb7adc41c64e4abdedd5493ba5989b8bdb31a64f4da1462fdceb');
    expect(signWebhook('other', 1, '{}')).not.toBe(signWebhook('secret', 1, '{}'));
  });
});

describe('blocked webhook addresses', () => {
  it('blocks loopback, unspecified, link-local and multicast; allows public and private networks', () => {
    for (const ip of ['127.0.0.1', '127.8.9.10', '0.0.0.0', '169.254.169.254', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'FE80::abcd%eth0', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '[::1]', 'not-an-ip', '']) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['8.8.8.8', '10.0.0.5', '172.16.4.2', '192.168.1.20', '100.64.0.1', '2001:4860:4860::8888', 'fd12:3456::1', '::ffff:10.0.0.1', '64:ff9b::808:808']) {
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, false]);
    }
  });
});

describe('Slack-style messages', () => {
  const env = (event: string, data: Record<string, unknown>): WebhookEnvelope => ({
    id: 'e1',
    event,
    created_at: '2026-10-12T10:00:00Z',
    project: { id: 'p', name: 'Shop', prefix: 'SHOP' },
    actor: { type: 'USER', name: 'alice' },
    url: 'https://testify.example/#/reports/run?project=p',
    data,
  });
  const run = { id: 'r', name: 'CI build 7', status: 'OPEN' };
  const plan = { id: 'pl', name: 'Regression' };

  it('renders every event with a headline, the project, who did it and a link', () => {
    const samples: Record<string, Record<string, unknown>> = {
      'run.created': { run, plan },
      'run.closed': {
        run,
        plan,
        summary: { total: 10, passed: 7, failed: 2, blocked: 1, skipped: 0, untested: 0, pass_rate: 0.7, compared_to: { id: 'r0', name: 'CI build 6' }, new_failures: 1, fixed: 2, failure_count: 3, failures: [{ external_id: 'SHOP-1', title: 'Logs in', verdict: 'FAILED', failure_message: 'timeout' }] },
      },
      'results.failed': { run, plan, recorded: 3, counts: { passed: 2, failed: 1 }, failed_count: 1, failures: [{ external_id: 'SHOP-2', title: 'Pays', verdict: 'FAILED', failure_message: '500' }] },
      'results.recorded': { run, plan, recorded: 3, counts: { passed: 3 }, failed_count: 0, failures: [] },
      'test_case.created': { test_case: { external_id: 'SHOP-3', title: 'Refunds' }, version: { version_number: 1, status: 'DRAFT' }, via: 'mcp' },
      'test_case.approved': { test_case: { external_id: 'SHOP-3', title: 'Refunds' }, version: { version_number: 2, status: 'APPROVED' } },
      'test_case.deprecated': { test_case: { external_id: 'SHOP-3', title: 'Refunds' } },
      'test_case.restored': { test_case: { external_id: 'SHOP-3', title: 'Refunds' } },
      'import.completed': { format: 'JUNIT_XML', counts: { imported_cases_count: 12, imported_suites_count: 3 } },
      ping: { webhook: { id: 'w', name: 'Team chat' } },
    };
    for (const e of [...WEBHOOK_EVENTS.map((x) => x.key), 'ping']) {
      const msg = renderSlackMessage(env(e, samples[e]));
      expect(msg.text, e).toContain('Shop · by alice');
      expect(msg.text, e).toContain('<https://testify.example/#/reports/run?project=p|Open in Testify>');
      expect((msg.blocks[0] as any).type).toBe('section');
    }
    const closed = renderSlackMessage(env('run.closed', samples['run.closed'])).text;
    expect(closed).toContain('*70% passed*, 10/10 executed. 7 passed · 2 failed · 1 blocked.');
    expect(closed).toContain('Compared with CI build 6: 1 new failure, 2 fixed.');
    expect(closed).toContain('• *SHOP-1* Logs in — timeout');
    expect(renderSlackMessage(env('test_case.created', samples['test_case.created'])).text).toContain('*SHOP-3* Refunds was created by an AI agent as a DRAFT, waiting for review.');
    expect(renderSlackMessage(env('results.failed', samples['results.failed'])).text).toMatch(/^:x: 1 failed in run \*CI build 7\* \(plan Regression\)/);
  });

  it("escapes test content, so it can't mention @channel or make links", () => {
    expect(slackEscape('<!channel> & <https://evil|click>')).toBe('&lt;!channel&gt; &amp; &lt;https://evil|click&gt;');
    const msg = renderSlackMessage(env('test_case.approved', { test_case: { external_id: 'SHOP-9', title: '<!here> hi' }, version: { version_number: 1 } }));
    expect(msg.text).not.toContain('<!here>');
    expect(msg.text).toContain('&lt;!here&gt; hi');
  });

  it('lists at most 10 failures and says how many more', () => {
    const failures = Array.from({ length: 20 }, (_, i) => ({ external_id: `SHOP-${i}`, title: 't', verdict: 'FAILED' }));
    const text = renderSlackMessage(env('results.failed', { run, plan, failed_count: 35, counts: { failed: 35 }, failures, failures_truncated: true })).text;
    expect(text.match(/^• /gm)).toHaveLength(10);
    expect(text).toContain('…and 25 more');
  });
});
