import { describe, it, expect } from 'vitest';
import { computeFlakinessScores } from '../src/reporting/flakiness.js';
import { computeTrendPoints } from '../src/reporting/trend.js';

describe('computeFlakinessScores', () => {
  it('computes flakiness_rate as verdict_changes / (total_executions - 1)', () => {
    const result = computeFlakinessScores([
      { plan_case_id: 'a', test_case_id: 'tc-a', total_executions: 3, verdict_changes: 2 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].flakiness_rate).toBeCloseTo(1); // 2 / (3-1) = 1
  });

  it('excludes a case with fewer than minExecutions (default 2) -- no prior verdict to diverge from', () => {
    const result = computeFlakinessScores([
      { plan_case_id: 'a', test_case_id: 'tc-a', total_executions: 1, verdict_changes: 0 },
      { plan_case_id: 'b', test_case_id: 'tc-b', total_executions: 2, verdict_changes: 1 },
    ]);
    expect(result.map((r) => r.plan_case_id)).toEqual(['b']);
  });

  it('respects a custom minExecutions threshold', () => {
    const rows = [
      { plan_case_id: 'a', test_case_id: 'tc-a', total_executions: 2, verdict_changes: 1 },
      { plan_case_id: 'b', test_case_id: 'tc-b', total_executions: 5, verdict_changes: 2 },
    ];
    expect(computeFlakinessScores(rows, { minExecutions: 5 }).map((r) => r.plan_case_id)).toEqual(['b']);
  });

  it('never divides by zero -- total_executions of exactly 1 would otherwise be (1-1)=0', () => {
    // minExecutions defaults to 2, so this row is filtered out entirely, but the
    // Math.max(...,1) guard means even a hypothetical 1-execution row wouldn't NaN.
    const result = computeFlakinessScores([{ plan_case_id: 'a', test_case_id: 'tc-a', total_executions: 1, verdict_changes: 0 }], {
      minExecutions: 0,
    });
    expect(result[0].flakiness_rate).toBe(0);
    expect(Number.isFinite(result[0].flakiness_rate)).toBe(true);
  });

  it('sorts by flakiness_rate descending, ties broken by total_executions descending', () => {
    const result = computeFlakinessScores([
      { plan_case_id: 'low', test_case_id: 'tc-low', total_executions: 3, verdict_changes: 0 }, // rate 0
      { plan_case_id: 'high', test_case_id: 'tc-high', total_executions: 3, verdict_changes: 2 }, // rate 1
      { plan_case_id: 'tied-more-data', test_case_id: 'tc-t2', total_executions: 5, verdict_changes: 2 }, // rate 0.5, 5 executions
      { plan_case_id: 'tied-less-data', test_case_id: 'tc-t1', total_executions: 3, verdict_changes: 1 }, // rate 0.5, 3 executions
    ]);
    expect(result.map((r) => r.plan_case_id)).toEqual(['high', 'tied-more-data', 'tied-less-data', 'low']);
  });
});

describe('computeTrendPoints', () => {
  const builds = [
    { build_id: 'b1', build_name: 'Build 1', release_date: '2026-01-01T00:00:00.000Z' },
    { build_id: 'b2', build_name: 'Build 2', release_date: '2026-02-01T00:00:00.000Z' },
  ];

  it('buckets verdicts per build and computes pass_rate correctly', () => {
    const rows = [
      { build_id: 'b1', verdict: 'PASSED' },
      { build_id: 'b1', verdict: 'PASSED' },
      { build_id: 'b1', verdict: 'FAILED' },
      { build_id: 'b1', verdict: null },
      { build_id: 'b2', verdict: 'PASSED' },
      { build_id: 'b2', verdict: 'BLOCKED' },
    ];
    const points = computeTrendPoints(rows, builds);
    expect(points).toHaveLength(2);
    expect(points[0]).toMatchObject({ build_id: 'b1', total_cases: 4, passed: 2, failed: 1, untested: 1, pass_rate: 0.5 });
    expect(points[1]).toMatchObject({ build_id: 'b2', total_cases: 2, passed: 1, blocked: 1, pass_rate: 0.5 });
  });

  it('preserves the order of the `builds` array, not insertion order of rows', () => {
    const rows = [
      { build_id: 'b2', verdict: 'PASSED' },
      { build_id: 'b1', verdict: 'PASSED' },
    ];
    const points = computeTrendPoints(rows, builds);
    expect(points.map((p) => p.build_id)).toEqual(['b1', 'b2']);
  });

  it('a build with zero rows produces pass_rate: 0, never NaN', () => {
    const points = computeTrendPoints([], builds);
    expect(points).toHaveLength(2);
    for (const p of points) {
      expect(p.total_cases).toBe(0);
      expect(p.pass_rate).toBe(0);
      expect(Number.isFinite(p.pass_rate)).toBe(true);
    }
  });

  it('buckets an unrecognized verdict (e.g. RETEST_REQUIRED) into "other"', () => {
    const points = computeTrendPoints([{ build_id: 'b1', verdict: 'RETEST_REQUIRED' }], builds);
    expect(points[0].other).toBe(1);
    expect(points[0].total_cases).toBe(1);
  });
});
