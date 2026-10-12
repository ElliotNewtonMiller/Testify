import { isFailing, roundRate } from './verdicts.js';

export interface CaseTimelineEntry {
  run_id: string;
  verdict: string;
  executed_at: string;
}

export interface CaseStats {
  total_executions: number;
  runs: number;
  /** Over the case's final result in each run it was executed in (retries don't count twice). */
  pass_rate: number;
  last_executed_at: string | null;
  last_passed_at: string | null;
  last_failed_at: string | null;
  /** The most recent final results in a row that share a verdict, e.g. FAILED x3. */
  current_streak: { verdict: string; runs: number } | null;
}

/** Stats for one case from every execution it ever got (oldest first). */
export function computeCaseStats(timeline: CaseTimelineEntry[]): CaseStats {
  let lastPassed: string | null = null;
  let lastFailed: string | null = null;
  const finalByRun = new Map<string, CaseTimelineEntry>();
  for (const e of timeline) {
    if (e.verdict === 'PASSED') lastPassed = e.executed_at;
    if (isFailing(e.verdict)) lastFailed = e.executed_at;
    // Re-inserting moves the run to the end, so the map ends up ordered by each run's
    // final execution -- the run order the streak needs.
    finalByRun.delete(e.run_id);
    finalByRun.set(e.run_id, e);
  }
  const finals = [...finalByRun.values()];
  const counted = finals.filter((f) => f.verdict !== 'SKIPPED' && f.verdict !== 'UNTESTED');
  const passed = counted.filter((f) => f.verdict === 'PASSED').length;

  let streak: CaseStats['current_streak'] = null;
  if (finals.length > 0) {
    const verdict = finals[finals.length - 1].verdict;
    let runs = 0;
    for (let i = finals.length - 1; i >= 0 && finals[i].verdict === verdict; i--) runs++;
    streak = { verdict, runs };
  }

  return {
    total_executions: timeline.length,
    runs: finals.length,
    pass_rate: counted.length > 0 ? roundRate(passed / counted.length) : 0,
    last_executed_at: timeline.length > 0 ? timeline[timeline.length - 1].executed_at : null,
    last_passed_at: lastPassed,
    last_failed_at: lastFailed,
    current_streak: streak,
  };
}
