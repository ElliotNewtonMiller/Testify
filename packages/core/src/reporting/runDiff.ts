import { isFailing } from './verdicts.js';

export const DIFF_BUCKETS = ['new_failure', 'fixed', 'still_failing', 'not_run', 'added', 'removed', 'unchanged'] as const;
export type DiffBucket = (typeof DIFF_BUCKETS)[number];

/**
 * How one case changed between a base run and a head run. `undefined` = the case isn't in
 * that run at all; `null` = it's in the run but has no result (UNTESTED).
 *  - added / removed: only in head / only in base (only happens across plans).
 *  - new_failure: failing now, and wasn't failing before (passed, skipped, untested...).
 *  - still_failing: failing in both. fixed: failing before, PASSED now.
 *  - not_run: had a result before, untested now.
 *  - unchanged: everything else (incl. a failing case that is now SKIPPED or OTHER).
 */
export function classifyChange(base: string | null | undefined, head: string | null | undefined): DiffBucket {
  if (base === undefined && head === undefined) return 'unchanged';
  if (base === undefined) return 'added';
  if (head === undefined) return 'removed';
  const baseHasResult = base !== null && base !== 'UNTESTED';
  const headHasResult = head !== null && head !== 'UNTESTED';
  if (isFailing(head)) return isFailing(base) ? 'still_failing' : 'new_failure';
  if (head === 'PASSED') return isFailing(base) ? 'fixed' : 'unchanged';
  if (!headHasResult && baseHasResult) return 'not_run';
  return 'unchanged';
}

export interface DiffEntry {
  test_case_id: string;
  verdict: string | null;
}

export interface RunDiffResult {
  counts: Record<DiffBucket, number>;
  /** test_case_id -> bucket, for every case in either run. */
  bucketByCase: Map<string, DiffBucket>;
}

export function diffRuns(base: DiffEntry[], head: DiffEntry[]): RunDiffResult {
  const baseMap = new Map(base.map((e) => [e.test_case_id, e.verdict]));
  const headMap = new Map(head.map((e) => [e.test_case_id, e.verdict]));
  const counts = Object.fromEntries(DIFF_BUCKETS.map((b) => [b, 0])) as Record<DiffBucket, number>;
  const bucketByCase = new Map<string, DiffBucket>();
  for (const id of new Set([...headMap.keys(), ...baseMap.keys()])) {
    const bucket = classifyChange(baseMap.has(id) ? baseMap.get(id) : undefined, headMap.has(id) ? headMap.get(id) : undefined);
    counts[bucket]++;
    bucketByCase.set(id, bucket);
  }
  return { counts, bucketByCase };
}

/**
 * For a case's final results across consecutive runs (oldest first, the last entry being
 * the run of interest): if it's failing in that last run, the earliest run of the current
 * unbroken failing streak. Runs where the case had no result are skipped over (they neither
 * break nor extend the streak). Null when the last run isn't failing.
 */
export function failingSince(history: Array<{ test_run_id: string; verdict: string | null }>): { test_run_id: string; runs: number } | null {
  if (history.length === 0 || !isFailing(history[history.length - 1].verdict)) return null;
  let since = history[history.length - 1].test_run_id;
  let runs = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const v = history[i].verdict;
    if (v === null || v === 'UNTESTED') continue;
    if (!isFailing(v)) break;
    since = history[i].test_run_id;
    runs++;
  }
  return { test_run_id: since, runs };
}
