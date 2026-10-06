import type { VerdictSummary } from './verdicts.js';
import type { DiffBucket } from './runDiff.js';

/** Every case row in every report identifies the case the same way. */
export interface ReportCaseRef {
  test_case_id: string;
  external_id: string;
  title: string;
  suite_path: string | null;
}

export interface ReportRunRef {
  id: string;
  name: string;
  status: string;
  created_at: string;
  release_date: string | null;
  plan_id: string;
  plan_name: string;
}

export interface ReportDiffCase extends ReportCaseRef {
  verdict: string | null;
  previous_verdict: string | null;
}

export interface ReportFailure extends ReportCaseRef {
  verdict: string;
  failure_message: string | null;
  notes: string | null;
  executed_at: string | null;
  tested_by: string | null;
  source: string | null;
  attempts: number;
  failing_since: { run_id: string; run_name: string; runs: number } | null;
  flaky: boolean;
  runner: Record<string, string> | null;
}

export type ListedDiffBucket = Exclude<DiffBucket, 'unchanged'>;

export interface RunSummaryReport {
  report: 'run_summary';
  generated_at: string;
  project: { id: string; name: string };
  run: ReportRunRef;
  compared_to: ReportRunRef | null;
  filter_applied: boolean;
  summary: VerdictSummary & { attempts: number; automated_duration_ms: number | null };
  diff: {
    counts: Record<DiffBucket, number>;
    cases: Record<ListedDiffBucket, ReportDiffCase[]>;
    truncated: boolean;
  };
  failures: ReportFailure[];
  failures_truncated: boolean;
  /** Distinct CI runner metadata reported by automated results in this run. */
  runners: Array<Record<string, string>>;
}
