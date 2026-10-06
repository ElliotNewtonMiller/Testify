/**
 * Verdict buckets and the rate definitions every report shares. Results come from people
 * (Execute mode) and from automation (batch API), which can also send RETEST_REQUIRED and
 * KNOWN_ISSUE -- those land in OTHER rather than being dropped.
 */
export const VERDICT_BUCKETS = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNTESTED', 'OTHER'] as const;
export type VerdictBucket = (typeof VERDICT_BUCKETS)[number];

/** null/undefined = no result yet. */
export function bucketVerdict(verdict: string | null | undefined): VerdictBucket {
  if (verdict === null || verdict === undefined || verdict === 'UNTESTED') return 'UNTESTED';
  if (verdict === 'PASSED' || verdict === 'FAILED' || verdict === 'BLOCKED' || verdict === 'SKIPPED') return verdict;
  return 'OTHER';
}

/** FAILED and BLOCKED both count as failing (the case did not pass and needs attention). */
export function isFailing(verdict: string | null | undefined): boolean {
  return verdict === 'FAILED' || verdict === 'BLOCKED';
}

export interface VerdictCounts {
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  other: number;
}

export interface VerdictSummary extends VerdictCounts {
  /** passed / (total - untested - skipped). 0 when nothing counted was executed. */
  pass_rate: number;
  /** (total - untested) / total. 0 when total is 0. */
  completion: number;
}

export function countVerdicts(verdicts: Array<string | null | undefined>): VerdictCounts {
  const counts: VerdictCounts = { total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: 0, other: 0 };
  for (const v of verdicts) {
    counts.total++;
    switch (bucketVerdict(v)) {
      case 'PASSED': counts.passed++; break;
      case 'FAILED': counts.failed++; break;
      case 'BLOCKED': counts.blocked++; break;
      case 'SKIPPED': counts.skipped++; break;
      case 'UNTESTED': counts.untested++; break;
      default: counts.other++;
    }
  }
  return counts;
}

/** Rates are rounded to 4 decimals (0.8333) -- precise enough, and compact for API/agent output. */
export function roundRate(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function passRate(c: VerdictCounts): number {
  const denominator = c.total - c.untested - c.skipped;
  return denominator > 0 ? roundRate(c.passed / denominator) : 0;
}

export function completion(c: VerdictCounts): number {
  return c.total > 0 ? roundRate((c.total - c.untested) / c.total) : 0;
}

export function summarizeVerdicts(verdicts: Array<string | null | undefined>): VerdictSummary {
  const counts = countVerdicts(verdicts);
  return { ...counts, pass_rate: passRate(counts), completion: completion(counts) };
}
