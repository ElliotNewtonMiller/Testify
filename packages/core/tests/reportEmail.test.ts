import { describe, it, expect } from 'vitest';
import { nextRunAt, validateScheduleTiming, parseRecipients, renderReportEmail, escapeHtml, MAX_RECIPIENTS } from '../src/reporting/index.js';

describe('nextRunAt', () => {
  it('daily: later today if the time is still ahead, otherwise tomorrow', () => {
    const t = { frequency: 'DAILY' as const, weekday: null, time_of_day: '09:00', timezone: 'UTC' };
    expect(nextRunAt(t, new Date('2026-03-10T08:00:00Z')).toISOString()).toBe('2026-03-10T09:00:00.000Z');
    expect(nextRunAt(t, new Date('2026-03-10T09:00:00Z')).toISOString()).toBe('2026-03-11T09:00:00.000Z'); // strictly after
  });

  it('weekly: the next matching weekday', () => {
    // 2026-03-10 is a Tuesday; weekday 1 = Monday.
    const t = { frequency: 'WEEKLY' as const, weekday: 1, time_of_day: '07:30', timezone: 'UTC' };
    expect(nextRunAt(t, new Date('2026-03-10T12:00:00Z')).toISOString()).toBe('2026-03-16T07:30:00.000Z');
  });

  it('keeps the wall-clock time across DST in America/New_York (EST -5 -> EDT -4 on 2026-03-08)', () => {
    const t = { frequency: 'DAILY' as const, weekday: null, time_of_day: '09:00', timezone: 'America/New_York' };
    expect(nextRunAt(t, new Date('2026-03-07T15:00:00Z')).toISOString()).toBe('2026-03-08T13:00:00.000Z'); // 09:00 EDT
    expect(nextRunAt(t, new Date('2026-03-06T15:00:00Z')).toISOString()).toBe('2026-03-07T14:00:00.000Z'); // 09:00 EST
  });

  it('keeps the wall-clock time across DST in Europe/London (BST ends 2026-10-25)', () => {
    const t = { frequency: 'WEEKLY' as const, weekday: 1, time_of_day: '08:00', timezone: 'Europe/London' };
    expect(nextRunAt(t, new Date('2026-10-14T00:00:00Z')).toISOString()).toBe('2026-10-19T07:00:00.000Z'); // BST, UTC+1
    expect(nextRunAt(t, new Date('2026-10-20T00:00:00Z')).toISOString()).toBe('2026-10-26T08:00:00.000Z'); // GMT
  });

  it('validates timings by field', () => {
    expect(validateScheduleTiming({ frequency: 'DAILY', time_of_day: '09:00', timezone: 'Europe/London' })).toEqual([]);
    const errors = validateScheduleTiming({ frequency: 'WEEKLY', weekday: 9, time_of_day: '25:00', timezone: 'Mars/Base' }).map((e) => e.field);
    expect(errors).toEqual(['weekday', 'time_of_day', 'timezone']);
  });
});

describe('parseRecipients', () => {
  it('splits on commas, semicolons, spaces and new lines; lower-cases and de-duplicates', () => {
    expect(parseRecipients('A@x.com, b@y.org;\nc@z.io  a@X.com')).toEqual({ recipients: ['a@x.com', 'b@y.org', 'c@z.io'], invalid: [], tooMany: false });
  });

  it('reports invalid entries and too many recipients', () => {
    expect(parseRecipients(['ok@x.com', 'nope', 'x@y']).invalid).toEqual(['nope', 'x@y']);
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@x.com`);
    expect(parseRecipients(many).tooMany).toBe(true);
  });
});

describe('renderReportEmail', () => {
  const runSummary = {
    report: 'run_summary',
    run: { id: 'r2', name: 'v2', status: 'OPEN', created_at: '', release_date: null, test_plan_id: 'pl', plan_name: 'Regression' },
    compared_to: { id: 'r1', name: 'v1', status: 'CLOSED', created_at: '', release_date: null, test_plan_id: 'pl', plan_name: 'Regression' },
    filter_applied: false,
    summary: { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0, untested: 0, other: 0, pass_rate: 0.5, completion: 1, attempts: 2, automated_duration_ms: null },
    diff: {
      counts: { new_failure: 1, fixed: 0, still_failing: 0, not_run: 0, added: 0, removed: 0, unchanged: 1 },
      cases: {
        new_failure: [{ test_case_id: 'c1', external_id: 'T-1', title: '<script>alert(1)</script>', suite_path: null, verdict: 'FAILED', previous_verdict: 'PASSED' }],
        fixed: [], still_failing: [], not_run: [], added: [], removed: [],
      },
      truncated: false,
    },
    failures: [
      { test_case_id: 'c1', external_id: 'T-1', title: '<script>alert(1)</script>', suite_path: null, verdict: 'FAILED', failure_message: '<img src=x onerror=alert(2)>', notes: null,
        executed_at: null, tested_by: null, source: 'API', attempts: 1, failing_since: { test_run_id: 'r2', run_name: 'v2', runs: 1 }, flaky: false, runner: null },
    ],
    failures_truncated: false,
    runners: [],
  };

  it('subject summarizes a single run; the link and message appear; user text is escaped', () => {
    const email = renderReportEmail([{ reportId: 'run_summary', data: runSummary, url: 'https://testify.example/#/reports/run?project=p&run=r2' }], {
      projectName: 'Shop & Co',
      message: 'FYI <b>team</b>',
    });
    expect(email.subject).toBe('Testify · Shop & Co · Run v2: 50% pass, 1 new failure');
    expect(email.html).toContain('href="https://testify.example/#/reports/run?project=p&amp;run=r2"');
    expect(email.html).toContain('New failures');
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).toContain('FYI &lt;b&gt;team&lt;/b&gt;');
    expect(email.html).toContain('Shop &amp; Co');
    expect(email.text).toContain('Open in Testify: https://testify.example/');
  });

  it('a title (e.g. a schedule name) becomes the subject; several sections render in order; unknown reports are rejected', () => {
    const overview = { plans: [], spec: { total_cases: 3, drafts_awaiting_approval: 0, never_executed: 1 }, activity: { days: 7, total: 0, api: 0, ui: 0 } };
    const email = renderReportEmail(
      [
        { reportId: 'overview', data: overview, url: null },
        { reportId: 'run_summary', data: runSummary, url: null },
      ],
      { projectName: 'Shop', title: 'Weekly digest' }
    );
    expect(email.subject).toBe('Testify · Shop · Weekly digest');
    expect(email.html.indexOf('Project overview')).toBeLessThan(email.html.indexOf('Run: v2'));
    expect(email.html).not.toContain('Open in Testify'); // no public URL configured
    expect(() => renderReportEmail([{ reportId: 'case_history', data: {}, url: null }], { projectName: 'x' })).toThrow();
  });

  it('escapeHtml covers the five special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
