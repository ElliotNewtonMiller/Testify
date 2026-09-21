import type { TrendBuildInput, TrendExecutionRow, TrendPoint } from './types.js';

const KNOWN_VERDICTS = new Set(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED']);

/**
 * Turns a flat list of (build_id, verdict) rows -- one per test_plan_case per build,
 * verdict null meaning untested -- into one TrendPoint per build, in the order `builds`
 * is given (the caller controls chronological ordering). Every bucket is always present
 * (zero-filled), and pass_rate is always a finite number: a build with zero plan-cases
 * produces pass_rate: 0, never NaN or a division by zero.
 */
export function computeTrendPoints(rows: TrendExecutionRow[], builds: TrendBuildInput[]): TrendPoint[] {
  const rowsByBuild = new Map<string, TrendExecutionRow[]>();
  for (const row of rows) {
    const list = rowsByBuild.get(row.build_id) ?? [];
    list.push(row);
    rowsByBuild.set(row.build_id, list);
  }

  return builds.map((build) => {
    const buildRows = rowsByBuild.get(build.build_id) ?? [];
    let passed = 0;
    let failed = 0;
    let blocked = 0;
    let skipped = 0;
    let untested = 0;
    let other = 0;

    for (const row of buildRows) {
      if (row.verdict === null) untested++;
      else if (row.verdict === 'PASSED') passed++;
      else if (row.verdict === 'FAILED') failed++;
      else if (row.verdict === 'BLOCKED') blocked++;
      else if (row.verdict === 'SKIPPED') skipped++;
      else other++; // e.g. RETEST_REQUIRED, KNOWN_ISSUE -- see KNOWN_VERDICTS below
    }

    const totalCases = buildRows.length;
    return {
      build_id: build.build_id,
      build_name: build.build_name,
      release_date: build.release_date,
      total_cases: totalCases,
      passed,
      failed,
      blocked,
      skipped,
      untested,
      other,
      pass_rate: totalCases > 0 ? passed / totalCases : 0,
    };
  });
}

export { KNOWN_VERDICTS };
