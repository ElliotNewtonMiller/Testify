export interface FlakinessInputRow {
  plan_case_id: string;
  test_case_id: string;
  total_executions: number;
  verdict_changes: number;
}

export interface FlakinessResult {
  plan_case_id: string;
  test_case_id: string;
  total_executions: number;
  verdict_changes: number;
  // verdict_changes / max(total_executions - 1, 1) -- the fraction of consecutive
  // execution pairs where the verdict differed from the previous one.
  flakiness_rate: number;
}

export interface TrendBuildInput {
  build_id: string;
  build_name: string;
  release_date: string | null;
}

export interface TrendExecutionRow {
  build_id: string;
  verdict: string | null; // null = untested
}

export interface TrendPoint {
  build_id: string;
  build_name: string;
  release_date: string | null;
  total_cases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  untested: number;
  other: number;
  pass_rate: number; // 0 when total_cases is 0, never NaN
}
