import { isFailing, roundRate } from './verdicts.js';

/** One case's final result in one run. null verdict = no result in that run. */
export interface RunResult {
  verdict: string | null;
  duration_ms: number | null;
  attempts: number;
  had_pass: boolean;
  had_fail: boolean;
}

/**
 * Flip score over a case's final results across runs (oldest first). Only pass/fail
 * outcomes count (PASSED vs FAILED/BLOCKED); untested/skipped/other runs are ignored. A
 * single sustained change -- a real break or a real fix -- is NOT flakiness and scores 0;
 * each extra flip adds to it: score = (transitions - 1) / (outcomes - 2), in [0, 1].
 * Alternating P F P F scores 1. Needs at least 3 outcomes.
 */
export function flipScore(series: RunResult[]): { score: number; transitions: number; outcomes: number } {
  const outcomes = series
    .map((r) => (r.verdict === 'PASSED' ? 'P' : isFailing(r.verdict) ? 'F' : null))
    .filter((o): o is 'P' | 'F' => o !== null);
  let transitions = 0;
  for (let i = 1; i < outcomes.length; i++) if (outcomes[i] !== outcomes[i - 1]) transitions++;
  const score = outcomes.length >= 3 && transitions >= 2 ? roundRate((transitions - 1) / (outcomes.length - 2)) : 0;
  return { score, transitions, outcomes: outcomes.length };
}

/** Runs in which the case both passed and failed (e.g. failed, then passed on retry). */
export function retryFlakyRuns(series: RunResult[]): number {
  return series.filter((r) => r.had_pass && r.had_fail).length;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Durations of the final results (oldest first), automated results only (manual results
 * carry no duration). `slowdown` compares the median of the recent half with the older
 * half; null with fewer than 4 timed runs.
 */
export function durationStats(series: RunResult[]): { median_ms: number | null; samples: number; slowdown: number | null; older_median_ms: number | null; recent_median_ms: number | null } {
  const durations = series.map((r) => r.duration_ms).filter((d): d is number => typeof d === 'number');
  const med = median(durations);
  if (durations.length < 4) {
    return { median_ms: med, samples: durations.length, slowdown: null, older_median_ms: null, recent_median_ms: null };
  }
  const half = Math.floor(durations.length / 2);
  const older = median(durations.slice(0, half))!;
  const recent = median(durations.slice(durations.length - half))!;
  return {
    median_ms: med,
    samples: durations.length,
    slowdown: older > 0 ? roundRate(recent / older) : null,
    older_median_ms: older,
    recent_median_ms: recent,
  };
}

/** How many of the most recent runs (that had a result) the case failed in a row. */
export function consecutiveFailures(series: RunResult[]): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i].verdict;
    if (v === null || v === 'UNTESTED') continue;
    if (!isFailing(v)) break;
    n++;
  }
  return n;
}

/** Whole days between two ISO timestamps (floor), or null when `from` is missing. */
export function daysBetween(fromIso: string | null | undefined, toIso: string): number | null {
  if (!fromIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null;
}
