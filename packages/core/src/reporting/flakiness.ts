import type { FlakinessInputRow, FlakinessResult } from './types.js';

/**
 * Turns raw verdict-volatility rows (from ExecutionRepository.getVerdictVolatility) into
 * a ranked, thresholded result list. A case with fewer than `minExecutions` executions
 * has no meaningful flakiness signal (a single execution has no prior verdict to diverge
 * from) and is excluded rather than showing a spurious 0/0 or divide-by-zero rate.
 * Sorted by flakiness_rate descending, ties broken by total_executions descending (more
 * data backing a tied rate ranks higher).
 */
export function computeFlakinessScores(rows: FlakinessInputRow[], opts: { minExecutions?: number } = {}): FlakinessResult[] {
  const minExecutions = opts.minExecutions ?? 2;

  return rows
    .filter((r) => r.total_executions >= minExecutions)
    .map((r) => ({
      plan_case_id: r.plan_case_id,
      test_case_id: r.test_case_id,
      total_executions: r.total_executions,
      verdict_changes: r.verdict_changes,
      flakiness_rate: r.verdict_changes / Math.max(r.total_executions - 1, 1),
    }))
    .sort((a, b) => b.flakiness_rate - a.flakiness_rate || b.total_executions - a.total_executions);
}
