import { describe, it, expect } from 'vitest';
import {
  summarizeVerdicts,
  bucketVerdict,
  classifyChange,
  diffRuns,
  failingSince,
  flipScore,
  retryFlakyRuns,
  durationStats,
  consecutiveFailures,
  daysBetween,
  computeCaseStats,
  computeCoverageBreakdown,
  computeVerdictBreakdown,
  computeTrendPoints,
  toCsv,
  renderRunSummaryMarkdown,
  validateReportParams,
  findReport,
  REPORT_CATALOG,
  type RunResult,
  type RunSummaryReport,
} from '../src/reporting/index.js';

const r = (verdict: string | null, extra: Partial<RunResult> = {}): RunResult => ({
  verdict,
  duration_ms: null,
  attempts: verdict ? 1 : 0,
  had_pass: verdict === 'PASSED',
  had_fail: verdict === 'FAILED' || verdict === 'BLOCKED',
  ...extra,
});

describe('verdicts', () => {
  it('buckets verdicts, with RETEST_REQUIRED/KNOWN_ISSUE as OTHER and null as UNTESTED', () => {
    expect(bucketVerdict(null)).toBe('UNTESTED');
    expect(bucketVerdict('KNOWN_ISSUE')).toBe('OTHER');
    expect(bucketVerdict('BLOCKED')).toBe('BLOCKED');
  });

  it('pass rate excludes untested and skipped; completion excludes untested only', () => {
    const s = summarizeVerdicts(['PASSED', 'PASSED', 'FAILED', 'SKIPPED', null, 'RETEST_REQUIRED']);
    expect(s).toMatchObject({ total: 6, passed: 2, failed: 1, skipped: 1, untested: 1, other: 1 });
    expect(s.pass_rate).toBe(0.5); // 2 / (6 - 1 - 1)
    expect(s.completion).toBe(0.8333);
  });

  it('never produces NaN: all untested and empty both give 0', () => {
    expect(summarizeVerdicts([null, null])).toMatchObject({ pass_rate: 0, completion: 0 });
    expect(summarizeVerdicts([])).toMatchObject({ total: 0, pass_rate: 0, completion: 0 });
  });
});

describe('run diff', () => {
  it('classifies every kind of change', () => {
    expect(classifyChange('PASSED', 'FAILED')).toBe('new_failure');
    expect(classifyChange(null, 'BLOCKED')).toBe('new_failure');
    expect(classifyChange('FAILED', 'BLOCKED')).toBe('still_failing');
    expect(classifyChange('FAILED', 'PASSED')).toBe('fixed');
    expect(classifyChange('PASSED', null)).toBe('not_run');
    expect(classifyChange(undefined, 'PASSED')).toBe('added');
    expect(classifyChange('PASSED', undefined)).toBe('removed');
    expect(classifyChange('PASSED', 'PASSED')).toBe('unchanged');
    expect(classifyChange(null, null)).toBe('unchanged');
    expect(classifyChange('FAILED', 'SKIPPED')).toBe('unchanged');
  });

  it('diffs two runs keyed by case id, counting added/removed across plans', () => {
    const d = diffRuns(
      [
        { test_case_id: 'a', verdict: 'PASSED' },
        { test_case_id: 'b', verdict: 'FAILED' },
        { test_case_id: 'gone', verdict: 'PASSED' },
      ],
      [
        { test_case_id: 'a', verdict: 'FAILED' },
        { test_case_id: 'b', verdict: 'PASSED' },
        { test_case_id: 'new', verdict: null },
      ]
    );
    expect(d.counts).toMatchObject({ new_failure: 1, fixed: 1, added: 1, removed: 1, unchanged: 0 });
    expect(d.bucketByCase.get('gone')).toBe('removed');
  });

  it('failing since: earliest run of the unbroken failing streak, skipping runs with no result', () => {
    const since = failingSince([
      { test_run_id: 'r1', verdict: 'PASSED' },
      { test_run_id: 'r2', verdict: 'FAILED' },
      { test_run_id: 'r3', verdict: null },
      { test_run_id: 'r4', verdict: 'BLOCKED' },
    ]);
    expect(since).toEqual({ test_run_id: 'r2', runs: 2 });
    expect(failingSince([{ test_run_id: 'r1', verdict: 'FAILED' }, { test_run_id: 'r2', verdict: 'PASSED' }])).toBeNull();
  });
});

describe('test health', () => {
  it('flip score: a single sustained change is 0, alternating results are 1', () => {
    expect(flipScore([r('PASSED'), r('PASSED'), r('FAILED'), r('FAILED')]).score).toBe(0); // a real break
    expect(flipScore([r('FAILED'), r('PASSED'), r('PASSED')]).score).toBe(0); // a real fix
    expect(flipScore([r('PASSED'), r('FAILED'), r('PASSED'), r('FAILED')]).score).toBe(1);
    expect(flipScore([r('PASSED'), r('FAILED'), r('PASSED')]).score).toBe(1);
    // untested/skipped runs are ignored, and fewer than 3 outcomes never score
    expect(flipScore([r('PASSED'), r(null), r('SKIPPED'), r('FAILED')]).score).toBe(0);
  });

  it('counts runs where the case both passed and failed (passed on retry)', () => {
    expect(retryFlakyRuns([r('PASSED', { had_fail: true, attempts: 2 }), r('PASSED'), r('FAILED', { had_pass: true })])).toBe(2);
  });

  it('duration stats: median, and slowdown of the recent half vs the older half', () => {
    const series = [100, 110, 90, 100, 200, 210, null, 190].map((d) => r('PASSED', { duration_ms: d }));
    const d = durationStats(series);
    expect(d.samples).toBe(7);
    expect(d.older_median_ms).toBe(100); // 100, 110, 90
    expect(d.recent_median_ms).toBe(200); // 200, 210, 190
    expect(d.slowdown).toBe(2);
    expect(durationStats([r('PASSED', { duration_ms: 5 })]).slowdown).toBeNull();
  });

  it('consecutive failures count back from the latest run, skipping untested', () => {
    expect(consecutiveFailures([r('PASSED'), r('FAILED'), r(null), r('BLOCKED'), r('FAILED')])).toBe(3);
    expect(consecutiveFailures([r('FAILED'), r('PASSED')])).toBe(0);
  });

  it('days between timestamps, null when never', () => {
    expect(daysBetween('2026-01-01T00:00:00.000Z', '2026-01-31T12:00:00.000Z')).toBe(30);
    expect(daysBetween(null, '2026-01-01T00:00:00.000Z')).toBeNull();
  });
});

describe('case stats', () => {
  it('uses the final result per run for pass rate and streak, but every execution for last pass/fail', () => {
    const stats = computeCaseStats([
      { test_run_id: 'r1', verdict: 'PASSED', executed_at: '2026-01-01T00:00:00Z' },
      { test_run_id: 'r2', verdict: 'PASSED', executed_at: '2026-01-02T00:00:00Z' },
      { test_run_id: 'r2', verdict: 'FAILED', executed_at: '2026-01-02T01:00:00Z' }, // final for r2
      { test_run_id: 'r3', verdict: 'FAILED', executed_at: '2026-01-03T00:00:00Z' },
    ]);
    expect(stats).toMatchObject({
      total_results: 4,
      runs: 3,
      pass_rate: 0.3333,
      last_passed_at: '2026-01-02T00:00:00Z',
      last_failed_at: '2026-01-03T00:00:00Z',
      current_streak: { verdict: 'FAILED', runs: 2 },
    });
    expect(computeCaseStats([])).toMatchObject({ runs: 0, pass_rate: 0, current_streak: null });
  });
});

describe('breakdown and trend', () => {
  it('coverage counts every case per group; verdict mode only counts plan cases; multi-value cases land in each group', () => {
    const items = [
      { groups: ['ui'], in_plan: true, verdict: 'PASSED' },
      { groups: ['ui', 'api'], in_plan: true, verdict: 'FAILED' },
      { groups: ['api'], in_plan: false, verdict: null },
    ];
    expect(computeCoverageBreakdown(items)).toEqual([
      { key: 'ui', total_cases: 2, in_plan: 2, not_in_plan: 0, coverage: 1 },
      { key: 'api', total_cases: 2, in_plan: 1, not_in_plan: 1, coverage: 0.5 },
    ]);
    const verdicts = computeVerdictBreakdown(items);
    expect(verdicts.find((g) => g.key === 'ui')).toMatchObject({ total: 2, passed: 1, failed: 1, pass_rate: 0.5 });
    expect(verdicts.find((g) => g.key === 'api')).toMatchObject({ total: 1, failed: 1 });
  });

  it('one zero-filled trend point per run, in the given order', () => {
    const points = computeTrendPoints(
      [
        { test_run_id: 'b', verdict: 'PASSED' },
        { test_run_id: 'b', verdict: null },
      ],
      [
        { test_run_id: 'a', run_name: 'A', status: 'CLOSED', created_at: '1', release_date: null },
        { test_run_id: 'b', run_name: 'B', status: 'OPEN', created_at: '2', release_date: null },
      ]
    );
    expect(points.map((p) => p.test_run_id)).toEqual(['a', 'b']);
    expect(points[0]).toMatchObject({ total: 0, pass_rate: 0 });
    expect(points[1]).toMatchObject({ total: 2, passed: 1, untested: 1, pass_rate: 1, completion: 0.5 });
  });
});

describe('formats', () => {
  it('writes RFC 4180 CSV, quoting commas/quotes/newlines and JSON-encoding objects', () => {
    const csv = toCsv(['a', 'b', 'c'], [{ a: 'x,y', b: 'say "hi"', c: { k: 1 } }, { a: null, b: 'line\nbreak' }]);
    expect(csv).toBe('a,b,c\r\n"x,y","say ""hi""","{""k"":1}"\r\n,"line\nbreak",\r\n');
  });

  it('renders a run summary as Markdown with the diff and failures', () => {
    const report: RunSummaryReport = {
      report: 'run_summary',
      generated_at: '2026-01-01T00:00:00Z',
      project: { id: 'p', name: 'P' },
      run: { id: 'r2', name: 'v2', status: 'OPEN', created_at: '', release_date: null, test_plan_id: 'pl', plan_name: 'Regression' },
      compared_to: { id: 'r1', name: 'v1', status: 'CLOSED', created_at: '', release_date: null, test_plan_id: 'pl', plan_name: 'Regression' },
      filter_applied: false,
      summary: { total: 3, passed: 1, failed: 1, blocked: 0, skipped: 0, untested: 1, other: 0, pass_rate: 0.5, completion: 0.6667, attempts: 2, automated_duration_ms: null },
      diff: {
        counts: { new_failure: 1, fixed: 1, still_failing: 0, not_run: 0, added: 0, removed: 0, unchanged: 1 },
        cases: {
          new_failure: [{ test_case_id: 'c1', external_id: 'T-1', title: 'Login', suite_path: null, verdict: 'FAILED', previous_verdict: 'PASSED' }],
          fixed: [{ test_case_id: 'c2', external_id: 'T-2', title: 'Logout', suite_path: null, verdict: 'PASSED', previous_verdict: 'FAILED' }],
          still_failing: [],
          not_run: [],
          added: [],
          removed: [],
        },
        truncated: false,
      },
      failures: [
        {
          test_case_id: 'c1', external_id: 'T-1', title: 'Login', suite_path: null, verdict: 'FAILED', failure_message: 'Expected 200 | got 500',
          notes: null, executed_at: null, tested_by: null, source: 'API', attempts: 1, failing_since: { test_run_id: 'r2', run_name: 'v2', runs: 1 }, flaky: true, runner: null,
        },
      ],
      failures_truncated: false,
      runners: [{ commit_sha: 'abcdef1234567890' }],
    };
    const md = renderRunSummaryMarkdown(report);
    expect(md).toContain('## Test run "v2" (plan "Regression")');
    expect(md).toContain('**Pass rate 50%**');
    expect(md).toContain('**1 new failure**');
    expect(md).toContain('### New failures');
    expect(md).toContain('| T-1 | Login ⚠️ flaky | FAILED | v2 (1 run) | Expected 200 \\| got 500 |');
    expect(md).toContain('### Fixed');
    expect(md).toContain('`abcdef123456`');
  });
});

describe('report catalog', () => {
  it('every report declares a JSON-Schema object of params and at least JSON output', () => {
    for (const report of REPORT_CATALOG) {
      expect(report.params.type).toBe('object');
      expect(report.formats).toContain('json');
      for (const req of report.params.required) expect(report.params.properties[req]).toBeDefined();
    }
  });

  it('validates params: required, unknown, types, bounds, and applies defaults', () => {
    const health = findReport('test_health')!;
    expect(validateReportParams(health, { test_plan_id: 'p1' })).toEqual({
      ok: true,
      params: { test_plan_id: 'p1', runs: 10, stale_days: 30, limit: 20 },
    });
    const bad = validateReportParams(health, { runs: 99, nope: 1, filter: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          { param: 'nope', reason: 'unknown parameter' },
          { param: 'test_plan_id', reason: 'is required' },
          { param: 'runs', reason: 'must be at most 50' },
          { param: 'filter', reason: 'must be an object' },
        ])
      );
    }
    // nullable params accept an explicit null (run_summary's "no comparison")
    const summary = validateReportParams(findReport('run_summary')!, { test_run_id: 'r', compare_to: null });
    expect(summary.ok && summary.params.compare_to).toBeNull();
    expect(validateReportParams(findReport('overview')!, [1]).ok).toBe(false);
  });
});
