import { summarizeVerdicts, roundRate, type VerdictSummary } from './verdicts.js';

export interface BreakdownItem {
  /** Group keys this case falls in -- a multi-select field can put one case in several. */
  groups: string[];
  in_plan: boolean;
  /** Final verdict in the run (verdict mode only); null = untested. */
  verdict?: string | null;
}

export interface CoverageGroup {
  key: string;
  total_cases: number;
  in_plan: number;
  not_in_plan: number;
  coverage: number; // in_plan / total_cases
}

export interface VerdictGroup extends VerdictSummary {
  key: string;
}

/** Coverage per group: how many of the group's cases are in the plan. */
export function computeCoverageBreakdown(items: BreakdownItem[]): CoverageGroup[] {
  const groups = new Map<string, { total: number; inPlan: number }>();
  for (const item of items) {
    for (const key of item.groups) {
      const g = groups.get(key) ?? { total: 0, inPlan: 0 };
      g.total++;
      if (item.in_plan) g.inPlan++;
      groups.set(key, g);
    }
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    total_cases: g.total,
    in_plan: g.inPlan,
    not_in_plan: g.total - g.inPlan,
    coverage: g.total > 0 ? roundRate(g.inPlan / g.total) : 0,
  }));
}

/** Verdict counts and rates per group, over the plan's cases only. */
export function computeVerdictBreakdown(items: BreakdownItem[]): VerdictGroup[] {
  const groups = new Map<string, Array<string | null>>();
  for (const item of items) {
    if (!item.in_plan) continue;
    for (const key of item.groups) {
      const list = groups.get(key) ?? [];
      list.push(item.verdict ?? null);
      groups.set(key, list);
    }
  }
  return [...groups.entries()].map(([key, verdicts]) => ({ key, ...summarizeVerdicts(verdicts) }));
}
