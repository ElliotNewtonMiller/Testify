import { summarizeVerdicts, type VerdictSummary } from './verdicts.js';

export interface TrendRunInput {
  run_id: string;
  run_name: string;
  status: string;
  created_at: string;
  release_date: string | null;
}

export interface TrendPoint extends VerdictSummary {
  run_id: string;
  run_name: string;
  status: string;
  created_at: string;
  release_date: string | null;
}

/**
 * One point per run, in the order `runs` is given (the caller passes oldest first). `rows`
 * holds one final result per plan case per run (verdict null = untested). Every count is
 * present and zero-filled; rates are never NaN.
 */
export function computeTrendPoints(rows: Array<{ run_id: string; verdict: string | null }>, runs: TrendRunInput[]): TrendPoint[] {
  const byRun = new Map<string, Array<string | null>>();
  for (const row of rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(row.verdict);
    byRun.set(row.run_id, list);
  }
  return runs.map((run) => ({ ...run, ...summarizeVerdicts(byRun.get(run.run_id) ?? []) }));
}
