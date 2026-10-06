import type { Kysely } from 'kysely';
import type { Database, TestSuiteNode, FinalResultRow, CustomFieldDefinition } from '@testify/db';
import {
  BuildRepository,
  CustomFieldRepository,
  ExecutionRepository,
  ProjectRepository,
  TestCaseRepository,
  TestPlanRepository,
  TestSuiteRepository,
} from '@testify/db';
import {
  DIFF_BUCKETS,
  computeCaseStats,
  computeCoverageBreakdown,
  computeTrendPoints,
  computeVerdictBreakdown,
  consecutiveFailures,
  daysBetween,
  diffRuns,
  durationStats,
  failingSince,
  flipScore,
  isFailing,
  retryFlakyRuns,
  summarizeVerdicts,
  type BreakdownItem,
  type ListedDiffBucket,
  type ReportCaseRef,
  type ReportDiffCase,
  type ReportFailure,
  type ReportRunRef,
  type RunResult,
  type RunSummaryReport,
} from '@testify/core';
import { CaseFilterService } from './caseFilterService.js';

/** Thrown for a request the report can't serve (unknown/cross-project id, bad param). The
 * route and the MCP tools turn it into a 4xx / a tool error. */
export class ReportError extends Error {
  constructor(
    public status: 400 | 404,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

/** A report's JSON plus, for reports with a CSV form, its table. */
export interface ReportOutput<T extends object = Record<string, unknown>> {
  data: T;
  csv?: { columns: string[]; rows: Array<Record<string, unknown>> };
}

/** How many prior runs of the plan a run summary looks back over for failing-since / flaky. */
const HISTORY_WINDOW = 20;
const FLAKY_WINDOW = 10;
/** Flip score at or above which a case counts as flaky -- in run summaries and test health
 * alike (see REPORT_DEFINITIONS). A break followed later by a fix scores below it. */
const FLAKY_FLAG_THRESHOLD = 0.3;
const SLOWING_THRESHOLD = 1.2;
const ALWAYS_FAILING_MIN_RUNS = 3;

type CaseRow = Awaited<ReturnType<TestCaseRepository['findByProjectWithLatestVersion']>>[number];
type Build = NonNullable<Awaited<ReturnType<BuildRepository['findById']>>>;
type Plan = NonNullable<Awaited<ReturnType<TestPlanRepository['findById']>>>;

interface ProjectContext {
  project: { id: string; name: string };
  cases: CaseRow[];
  caseById: Map<string, CaseRow>;
  suitePath: Map<string, string>;
  suiteParent: Map<string, string | null>;
}

function parseJson(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function byExternalId(a: { external_id: string }, b: { external_id: string }) {
  return a.external_id.localeCompare(b.external_id, undefined, { numeric: true });
}

/**
 * Every report, computed once. Called by the REST routes (routes/reports.ts) and the MCP
 * tools alike, so people, scripts and agents always see the same numbers. Each method checks
 * that every id it's given belongs to the project (ReportError 404 otherwise) and runs a
 * fixed number of queries regardless of how many cases or results there are.
 */
export class ReportService {
  private projectRepo: ProjectRepository;
  private planRepo: TestPlanRepository;
  private buildRepo: BuildRepository;
  private executionRepo: ExecutionRepository;
  private caseRepo: TestCaseRepository;
  private suiteRepo: TestSuiteRepository;
  private customFieldRepo: CustomFieldRepository;
  private caseFilter: CaseFilterService;

  constructor(private db: Kysely<Database>) {
    this.projectRepo = new ProjectRepository(db);
    this.planRepo = new TestPlanRepository(db);
    this.buildRepo = new BuildRepository(db);
    this.executionRepo = new ExecutionRepository(db);
    this.caseRepo = new TestCaseRepository(db);
    this.suiteRepo = new TestSuiteRepository(db);
    this.customFieldRepo = new CustomFieldRepository(db);
    this.caseFilter = new CaseFilterService(db);
  }

  async run(projectId: string, reportId: string, params: Record<string, unknown>): Promise<ReportOutput<object>> {
    switch (reportId) {
      case 'overview':
        return this.overview(projectId, params as { days: number });
      case 'run_summary':
        return this.runSummary(projectId, params as { run_id: string; compare_to?: string | null; filter?: unknown; limit: number });
      case 'case_history':
        return this.caseHistory(projectId, params as { case_id: string; limit: number; cursor?: string });
      case 'plan_trend':
        return this.planTrend(projectId, params as { plan_id: string; runs: number; filter?: unknown });
      case 'test_health':
        return this.testHealth(projectId, params as { plan_id: string; runs: number; stale_days: number; filter?: unknown; limit: number });
      case 'breakdown':
        return this.breakdown(projectId, params as { plan_id: string; run_id?: string | null; group_by: string; filter?: unknown });
      default:
        throw new ReportError(404, 'REPORT_NOT_FOUND', `Unknown report '${reportId}'`);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Shared lookups

  private async projectContext(projectId: string): Promise<ProjectContext> {
    const project = await this.projectRepo.findById(projectId);
    if (!project) throw new ReportError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const [cases, tree] = await Promise.all([this.caseRepo.findByProjectWithLatestVersion(projectId), this.suiteRepo.getTree(projectId)]);
    const suitePath = new Map<string, string>();
    const suiteParent = new Map<string, string | null>();
    const walk = (nodes: TestSuiteNode[], prefix: string) => {
      for (const n of nodes) {
        const path = prefix ? `${prefix} / ${n.name}` : n.name;
        suitePath.set(n.id, path);
        suiteParent.set(n.id, n.parent_suite_id);
        walk(n.children, path);
      }
    };
    walk(tree, '');
    return {
      project: { id: project.id, name: project.name },
      cases,
      caseById: new Map(cases.map((c) => [c.id, c])),
      suitePath,
      suiteParent,
    };
  }

  private caseRef(ctx: ProjectContext, testCaseId: string): ReportCaseRef {
    const c = ctx.caseById.get(testCaseId);
    return {
      test_case_id: testCaseId,
      external_id: c?.external_id ?? '',
      title: c?.title ?? '',
      suite_path: c ? ctx.suitePath.get(c.test_suite_id) ?? null : null,
    };
  }

  private async resolvePlan(projectId: string, planId: string, param = 'plan_id'): Promise<Plan> {
    const plan = await this.planRepo.findById(planId);
    if (!plan || plan.project_id !== projectId) {
      throw new ReportError(404, 'PLAN_NOT_FOUND', `Test plan '${planId}' not found in this project`, { param });
    }
    return plan;
  }

  private async resolveRun(projectId: string, runId: string, param = 'run_id'): Promise<{ run: Build; plan: Plan }> {
    const run = await this.buildRepo.findById(runId);
    const plan = run ? await this.planRepo.findById(run.test_plan_id) : undefined;
    if (!run || !plan || plan.project_id !== projectId) {
      throw new ReportError(404, 'RUN_NOT_FOUND', `Test run '${runId}' not found in this project`, { param });
    }
    return { run, plan };
  }

  private runRef(run: Build, plan: Plan): ReportRunRef {
    return {
      id: run.id,
      name: run.name,
      status: run.status,
      created_at: run.created_at,
      release_date: run.release_date,
      plan_id: plan.id,
      plan_name: plan.name,
    };
  }

  /** Display names for testers: users by username, machine API tokens by token name. */
  private async actorNames(ids: Iterable<string | null>): Promise<Map<string, string>> {
    const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
    if (unique.length === 0) return new Map();
    const [users, tokens] = await Promise.all([
      this.db.selectFrom('users').select(['id', 'username']).where('id', 'in', unique).execute(),
      this.db.selectFrom('api_tokens').select(['id', 'name']).where('id', 'in', unique).execute(),
    ]);
    const names = new Map<string, string>();
    for (const u of users) names.set(u.id, u.username);
    for (const t of tokens) names.set(t.id, `${t.name} (API token)`);
    return names;
  }

  /** The set of case ids a report `filter` selects, or null when there's no filter. */
  private async applyFilter(projectId: string, filter: unknown, planId: string | null, runId: string | null): Promise<Set<string> | null> {
    if (filter === undefined || filter === null) return null;
    const f = filter as { q?: unknown; filters?: unknown };
    const hasQ = typeof f.q === 'string' && f.q.trim() !== '';
    const hasFilters = Array.isArray(f.filters) && f.filters.length > 0;
    if (!hasQ && !hasFilters) return null;
    const outcome = await this.caseFilter.evaluate(projectId, { q: f.q, filters: f.filters, plan_id: planId ?? undefined, build_id: runId ?? undefined });
    if (!outcome.ok) throw new ReportError(outcome.status === 404 ? 404 : 400, 'INVALID_FILTER', outcome.error, outcome.details);
    return new Set(outcome.case_ids);
  }

  private static groupByRun(rows: FinalResultRow[]): Map<string, FinalResultRow[]> {
    const map = new Map<string, FinalResultRow[]>();
    for (const r of rows) {
      const list = map.get(r.run_id) ?? [];
      list.push(r);
      map.set(r.run_id, list);
    }
    return map;
  }

  /** Per case, its final results across `runIds` in that order (null verdict = no result). */
  private static seriesByCase(rows: FinalResultRow[], runIds: string[]): Map<string, RunResult[]> {
    const byKey = new Map(rows.map((r) => [`${r.run_id}|${r.test_case_id}`, r]));
    const caseIds = [...new Set(rows.map((r) => r.test_case_id))];
    const series = new Map<string, RunResult[]>();
    for (const caseId of caseIds) {
      series.set(
        caseId,
        runIds.map((runId) => {
          const r = byKey.get(`${runId}|${caseId}`);
          return {
            verdict: r?.verdict ?? null,
            duration_ms: r?.execution_duration_ms ?? null,
            attempts: r?.attempts ?? 0,
            had_pass: r?.had_pass ?? false,
            had_fail: r?.had_fail ?? false,
          };
        })
      );
    }
    return series;
  }

  // ---------------------------------------------------------------------------------------
  // Reports

  async runSummary(
    projectId: string,
    p: { run_id: string; compare_to?: string | null; filter?: unknown; limit: number }
  ): Promise<ReportOutput<RunSummaryReport>> {
    const ctx = await this.projectContext(projectId);
    const { run, plan } = await this.resolveRun(projectId, p.run_id);

    const planRuns = await this.buildRepo.findByTestPlan(plan.id); // newest first
    const idx = planRuns.findIndex((r) => r.id === run.id);
    const historyRuns = planRuns.slice(idx, idx + HISTORY_WINDOW).reverse(); // oldest -> this run
    const historyIds = historyRuns.map((r) => r.id);

    let compare: { run: Build; plan: Plan } | null = null;
    if (typeof p.compare_to === 'string') {
      if (p.compare_to === run.id) throw new ReportError(400, 'INVALID_PARAMS', 'compare_to must be a different run', { param: 'compare_to' });
      compare = await this.resolveRun(projectId, p.compare_to, 'compare_to');
    } else if (p.compare_to === undefined && planRuns[idx + 1]) {
      compare = { run: planRuns[idx + 1], plan };
    }

    const history = await this.executionRepo.getFinalResultsForRuns(plan.id, historyIds);
    const byRun = ReportService.groupByRun(history);
    let baseRows: FinalResultRow[] = [];
    if (compare) {
      baseRows =
        compare.plan.id === plan.id && byRun.has(compare.run.id)
          ? byRun.get(compare.run.id)!
          : await this.executionRepo.getFinalResultsForRuns(compare.plan.id, [compare.run.id]);
    }

    const filterSet = await this.applyFilter(projectId, p.filter, plan.id, run.id);
    const keep = (r: FinalResultRow) => !filterSet || filterSet.has(r.test_case_id);
    const headRows = (byRun.get(run.id) ?? []).filter(keep);
    baseRows = baseRows.filter(keep);

    const verdictSummary = summarizeVerdicts(headRows.map((r) => r.verdict));
    const durations = headRows.map((r) => r.execution_duration_ms).filter((d): d is number => typeof d === 'number');
    const summary = {
      ...verdictSummary,
      attempts: headRows.reduce((n, r) => n + r.attempts, 0),
      automated_duration_ms: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : null,
    };

    const headVerdict = new Map(headRows.map((r) => [r.test_case_id, r.verdict]));
    const baseVerdict = new Map(baseRows.map((r) => [r.test_case_id, r.verdict]));
    const diff = compare
      ? diffRuns(
          baseRows.map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict })),
          headRows.map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict }))
        )
      : { counts: Object.fromEntries(DIFF_BUCKETS.map((b) => [b, 0])) as RunSummaryReport['diff']['counts'], bucketByCase: new Map() };

    const listed = DIFF_BUCKETS.filter((b): b is ListedDiffBucket => b !== 'unchanged');
    const diffCases = Object.fromEntries(listed.map((b) => [b, [] as ReportDiffCase[]])) as Record<ListedDiffBucket, ReportDiffCase[]>;
    for (const [caseId, bucket] of diff.bucketByCase) {
      if (bucket === 'unchanged') continue;
      diffCases[bucket as ListedDiffBucket].push({
        ...this.caseRef(ctx, caseId),
        verdict: headVerdict.get(caseId) ?? null,
        previous_verdict: baseVerdict.get(caseId) ?? null,
      });
    }
    let diffTruncated = false;
    for (const b of listed) {
      diffCases[b].sort(byExternalId);
      if (diffCases[b].length > p.limit) {
        diffCases[b] = diffCases[b].slice(0, p.limit);
        diffTruncated = true;
      }
    }

    const series = ReportService.seriesByCase(history, historyIds);
    const runName = new Map(historyRuns.map((r) => [r.id, r.name]));
    const names = await this.actorNames(headRows.map((r) => r.tester_id));
    const allFailures: ReportFailure[] = headRows
      .filter((r) => isFailing(r.verdict))
      .map((r) => {
        const caseSeries = series.get(r.test_case_id) ?? [];
        const since = failingSince(historyIds.map((runId, i) => ({ run_id: runId, verdict: caseSeries[i]?.verdict ?? null })));
        const flaky = flipScore(caseSeries.slice(-FLAKY_WINDOW)).score >= FLAKY_FLAG_THRESHOLD || (r.had_pass && r.had_fail);
        return {
          ...this.caseRef(ctx, r.test_case_id),
          verdict: r.verdict!,
          failure_message: r.failure_message,
          notes: r.notes,
          executed_at: r.execution_timestamp,
          tested_by: r.tester_id ? names.get(r.tester_id) ?? r.tester_id : null,
          source: r.source,
          attempts: r.attempts,
          failing_since: since ? { run_id: since.run_id, run_name: runName.get(since.run_id) ?? '', runs: since.runs } : null,
          flaky,
          runner: parseJson(r.runner),
        };
      });
    const rank = (id: string) => ({ new_failure: 0, still_failing: 1 } as Record<string, number>)[diff.bucketByCase.get(id) ?? ''] ?? 2;
    allFailures.sort((a, b) => rank(a.test_case_id) - rank(b.test_case_id) || byExternalId(a, b));

    const runners = new Map<string, Record<string, string>>();
    for (const r of headRows) {
      const parsed = parseJson(r.runner);
      if (parsed) runners.set(JSON.stringify(parsed), parsed);
    }

    const data: RunSummaryReport = {
      report: 'run_summary',
      generated_at: new Date().toISOString(),
      project: ctx.project,
      run: this.runRef(run, plan),
      compared_to: compare ? this.runRef(compare.run, compare.plan) : null,
      filter_applied: filterSet !== null,
      summary,
      diff: { counts: diff.counts, cases: diffCases, truncated: diffTruncated },
      failures: allFailures.slice(0, p.limit),
      failures_truncated: allFailures.length > p.limit,
      runners: [...runners.values()],
    };

    const failureById = new Map(allFailures.map((f) => [f.test_case_id, f]));
    const csvRows = headRows
      .map((r) => {
        const f = failureById.get(r.test_case_id);
        return {
          ...this.caseRef(ctx, r.test_case_id),
          verdict: r.verdict ?? 'UNTESTED',
          previous_verdict: compare ? baseVerdict.get(r.test_case_id) ?? 'UNTESTED' : '',
          change: diff.bucketByCase.get(r.test_case_id) ?? '',
          failure_message: r.failure_message ?? '',
          notes: r.notes ?? '',
          failing_since: f?.failing_since?.run_name ?? '',
          flaky: f ? (f.flaky ? 'yes' : 'no') : '',
          attempts: r.attempts,
          executed_at: r.execution_timestamp ?? '',
          tested_by: r.tester_id ? names.get(r.tester_id) ?? r.tester_id : '',
        };
      })
      .sort(byExternalId);
    return {
      data,
      csv: {
        columns: ['external_id', 'title', 'suite_path', 'verdict', 'previous_verdict', 'change', 'failure_message', 'notes', 'failing_since', 'flaky', 'attempts', 'executed_at', 'tested_by', 'test_case_id'],
        rows: csvRows,
      },
    };
  }

  async caseHistory(projectId: string, p: { case_id: string; limit: number; cursor?: string }): Promise<ReportOutput> {
    const ctx = await this.projectContext(projectId);
    const testCase =
      ctx.caseById.get(p.case_id) ?? ctx.cases.find((c) => c.external_id.toLowerCase() === p.case_id.toLowerCase());
    if (!testCase) throw new ReportError(404, 'CASE_NOT_FOUND', `Test case '${p.case_id}' not found in this project`, { param: 'case_id' });

    const [page, timeline] = await Promise.all([
      this.executionRepo.getCaseHistory(testCase.id, { limit: p.limit, cursor: p.cursor }),
      this.executionRepo.getCaseVerdictTimeline(testCase.id),
    ]);
    const names = await this.actorNames(page.rows.map((r) => r.tester_id));
    const executions = page.rows.map((r) => ({
      execution_id: r.execution_id,
      executed_at: r.execution_timestamp,
      verdict: r.verdict,
      status: r.status,
      run: { id: r.run_id, name: r.run_name },
      plan: { id: r.plan_id, name: r.plan_name },
      version_number: r.version_number,
      duration_ms: r.execution_duration_ms,
      tested_by: names.get(r.tester_id) ?? r.tester_id,
      source: r.source,
      notes: r.notes,
      failure_message: r.failure_message,
      stack_trace: r.stack_trace,
      environment: parseJson(r.environment),
      runner: parseJson(r.runner),
    }));

    const data = {
      report: 'case_history',
      generated_at: new Date().toISOString(),
      project: ctx.project,
      case: {
        ...this.caseRef(ctx, testCase.id),
        priority: testCase.priority,
        execution_type: testCase.execution_type,
        version_status: testCase.latest_version?.status ?? null,
      },
      stats: computeCaseStats(timeline),
      executions,
      next_cursor: page.next_cursor,
    };
    return {
      data,
      csv: {
        columns: ['executed_at', 'verdict', 'run', 'plan', 'version_number', 'duration_ms', 'tested_by', 'source', 'failure_message', 'notes', 'runner', 'environment'],
        rows: executions.map((e) => ({ ...e, run: e.run.name, plan: e.plan.name })),
      },
    };
  }

  async planTrend(projectId: string, p: { plan_id: string; runs: number; filter?: unknown }): Promise<ReportOutput> {
    const ctx = await this.projectContext(projectId);
    const plan = await this.resolvePlan(projectId, p.plan_id);
    const planRuns = await this.buildRepo.findByTestPlan(plan.id);
    // One extra (older) run so the first point also gets a "new failures" count.
    const window = planRuns.slice(0, p.runs + 1).reverse();
    const shown = window.slice(window.length > p.runs ? 1 : 0);
    const rows = await this.executionRepo.getFinalResultsForRuns(plan.id, window.map((r) => r.id));
    const filterSet = await this.applyFilter(projectId, p.filter, plan.id, null);
    const kept = filterSet ? rows.filter((r) => filterSet.has(r.test_case_id)) : rows;
    const byRun = ReportService.groupByRun(kept);

    const points = computeTrendPoints(
      kept,
      shown.map((r) => ({ run_id: r.id, run_name: r.name, status: r.status, created_at: r.created_at, release_date: r.release_date }))
    ).map((point) => {
      const i = window.findIndex((r) => r.id === point.run_id);
      const prev = i > 0 ? window[i - 1] : null;
      const counts = prev
        ? diffRuns(
            (byRun.get(prev.id) ?? []).map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict })),
            (byRun.get(point.run_id) ?? []).map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict }))
          ).counts
        : null;
      return { ...point, new_failures: counts ? counts.new_failure : null, fixed: counts ? counts.fixed : null };
    });

    return {
      data: {
        report: 'plan_trend',
        generated_at: new Date().toISOString(),
        project: ctx.project,
        plan: { id: plan.id, name: plan.name, status: plan.status },
        filter_applied: filterSet !== null,
        points,
      },
      csv: {
        columns: ['run_name', 'created_at', 'status', 'total', 'passed', 'failed', 'blocked', 'skipped', 'untested', 'other', 'pass_rate', 'completion', 'new_failures', 'fixed', 'run_id'],
        rows: points,
      },
    };
  }

  async testHealth(
    projectId: string,
    p: { plan_id: string; runs: number; stale_days: number; filter?: unknown; limit: number }
  ): Promise<ReportOutput> {
    const ctx = await this.projectContext(projectId);
    const plan = await this.resolvePlan(projectId, p.plan_id);
    const runs = (await this.buildRepo.findByTestPlan(plan.id)).slice(0, p.runs).reverse();
    const runIds = runs.map((r) => r.id);
    const [rows, pinned, lastExecuted] = await Promise.all([
      this.executionRepo.getFinalResultsForRuns(plan.id, runIds),
      this.planRepo.getPinnedCases(plan.id),
      this.executionRepo.getLastExecutedAtByCase(projectId),
    ]);
    const filterSet = await this.applyFilter(projectId, p.filter, plan.id, null);
    const planCaseIds = pinned.map((pc) => pc.test_case_id).filter((id) => !filterSet || filterSet.has(id));
    const series = ReportService.seriesByCase(rows, runIds);
    const runName = new Map(runs.map((r) => [r.id, r.name]));
    const lastFailure = new Map<string, string | null>();
    for (const r of rows) if (isFailing(r.verdict)) lastFailure.set(r.test_case_id, r.failure_message ?? r.notes);
    const now = new Date().toISOString();

    const flaky: Array<Record<string, unknown>> = [];
    const slowest: Array<Record<string, unknown>> = [];
    const slowing: Array<Record<string, unknown>> = [];
    const alwaysFailing: Array<Record<string, unknown>> = [];
    const stale: Array<Record<string, unknown>> = [];

    for (const caseId of planCaseIds) {
      const s = series.get(caseId) ?? runIds.map(() => ({ verdict: null, duration_ms: null, attempts: 0, had_pass: false, had_fail: false }));
      const ref = this.caseRef(ctx, caseId);
      const lastVerdict = [...s].reverse().find((r) => r.verdict !== null)?.verdict ?? null;

      const flip = flipScore(s);
      const retries = retryFlakyRuns(s);
      if (flip.score >= FLAKY_FLAG_THRESHOLD || retries > 0) {
        flaky.push({ ...ref, flip_score: flip.score, flips: flip.transitions, runs_with_result: flip.outcomes, passed_on_retry_runs: retries, last_verdict: lastVerdict });
      }

      const d = durationStats(s);
      if (d.median_ms !== null) {
        slowest.push({ ...ref, median_ms: d.median_ms, samples: d.samples, last_ms: [...s].reverse().find((r) => r.duration_ms !== null)?.duration_ms ?? null });
      }
      if (d.slowdown !== null && d.slowdown >= SLOWING_THRESHOLD) {
        slowing.push({ ...ref, slowdown: d.slowdown, older_median_ms: d.older_median_ms, recent_median_ms: d.recent_median_ms, samples: d.samples });
      }

      const failing = consecutiveFailures(s);
      if (failing >= ALWAYS_FAILING_MIN_RUNS) {
        const since = failingSince(runIds.map((runId, i) => ({ run_id: runId, verdict: s[i].verdict })));
        alwaysFailing.push({
          ...ref,
          consecutive_failures: failing,
          failing_since: since ? { run_id: since.run_id, run_name: runName.get(since.run_id) ?? '' } : null,
          last_failure_message: lastFailure.get(caseId) ?? null,
        });
      }

      const last = lastExecuted.get(caseId) ?? null;
      const days = daysBetween(last, now);
      if (days === null || days >= p.stale_days) stale.push({ ...ref, last_executed_at: last, days_since: days });
    }

    flaky.sort((a, b) => (b.flip_score as number) - (a.flip_score as number) || (b.passed_on_retry_runs as number) - (a.passed_on_retry_runs as number));
    slowest.sort((a, b) => (b.median_ms as number) - (a.median_ms as number));
    slowing.sort((a, b) => (b.slowdown as number) - (a.slowdown as number));
    alwaysFailing.sort((a, b) => (b.consecutive_failures as number) - (a.consecutive_failures as number));
    stale.sort((a, b) => (a.days_since === null ? -1 : b.days_since === null ? 1 : (b.days_since as number) - (a.days_since as number)));

    const lists = { flaky, slowest, slowing, always_failing: alwaysFailing, stale };
    const counts = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length]));
    const capped = Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.slice(0, p.limit)])) as typeof lists;

    return {
      data: {
        report: 'test_health',
        generated_at: now,
        project: ctx.project,
        plan: { id: plan.id, name: plan.name, status: plan.status },
        runs_analysed: runs.map((r) => ({ id: r.id, name: r.name })),
        window: { runs: p.runs, stale_days: p.stale_days },
        filter_applied: filterSet !== null,
        counts,
        ...capped,
      },
      csv: {
        columns: ['list', 'external_id', 'title', 'suite_path', 'flip_score', 'passed_on_retry_runs', 'median_ms', 'slowdown', 'consecutive_failures', 'days_since', 'last_executed_at', 'test_case_id'],
        rows: Object.entries(capped).flatMap(([list, items]) => items.map((item) => ({ list, ...item }))),
      },
    };
  }

  async breakdown(projectId: string, p: { plan_id: string; run_id?: string | null; group_by: string; filter?: unknown }): Promise<ReportOutput> {
    const ctx = await this.projectContext(projectId);
    const plan = await this.resolvePlan(projectId, p.plan_id);
    let run: Build | null = null;
    if (p.run_id) {
      const resolved = await this.resolveRun(projectId, p.run_id);
      if (resolved.plan.id !== plan.id) throw new ReportError(400, 'INVALID_PARAMS', 'run_id must be a run of plan_id', { param: 'run_id' });
      run = resolved.run;
    }

    const groupBy = p.group_by;
    const builtins: Record<string, string> = {
      suite: 'Suite',
      priority: 'Priority',
      execution_type: 'Execution Type',
      version_status: 'Status',
      tester: 'Tester',
    };
    let label = builtins[groupBy];
    let fieldDef: CustomFieldDefinition | undefined;
    if (!label) {
      const match = /^(cf|suite_cf):(.+)$/.exec(groupBy);
      if (match) {
        const defs = await this.customFieldRepo.listVisibleToProject(projectId, match[1] === 'cf' ? 'TestCase' : 'TestSuite');
        fieldDef = defs.find((d) => d.id === match[2]);
      }
      if (!fieldDef) throw new ReportError(400, 'INVALID_PARAMS', `Unknown group_by '${groupBy}'`, { param: 'group_by' });
      label = fieldDef.field_label;
    }
    if (groupBy === 'tester' && !run) throw new ReportError(400, 'INVALID_PARAMS', "group_by 'tester' needs run_id", { param: 'group_by' });

    const [pinned, finals] = await Promise.all([
      this.planRepo.getPinnedCases(plan.id),
      run ? this.executionRepo.getFinalResultsForRuns(plan.id, [run.id]) : Promise.resolve([] as FinalResultRow[]),
    ]);
    const inPlan = new Set(pinned.map((pc) => pc.test_case_id));
    const finalByCase = new Map(finals.map((r) => [r.test_case_id, r]));
    const filterSet = await this.applyFilter(projectId, p.filter, plan.id, run?.id ?? null);

    // Coverage looks at every live case in the project; verdicts only at the plan's cases.
    const universe = ctx.cases.filter(
      (c) =>
        (!filterSet || filterSet.has(c.id)) &&
        (run ? inPlan.has(c.id) : inPlan.has(c.id) || c.latest_version?.status !== 'DEPRECATED')
    );

    const NO_VALUE = '(no value)';
    const optionLabel = (v: unknown) => fieldDef?.options.find((o) => o.option_value === v)?.option_label ?? String(v);
    const valueKeys = (v: unknown): string[] => {
      if (fieldDef?.field_type === 'CHECKBOX') return [v === true ? 'Yes' : 'No'];
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) return [NO_VALUE];
      return Array.isArray(v) ? v.map(optionLabel) : [optionLabel(v)];
    };

    let groupsOf: (c: CaseRow) => string[];
    if (groupBy === 'suite') groupsOf = (c) => [ctx.suitePath.get(c.test_suite_id) ?? NO_VALUE];
    else if (groupBy === 'priority') groupsOf = (c) => [c.priority || NO_VALUE];
    else if (groupBy === 'execution_type') groupsOf = (c) => [c.execution_type || NO_VALUE];
    else if (groupBy === 'version_status') groupsOf = (c) => [c.latest_version?.status ?? NO_VALUE];
    else if (groupBy === 'tester') {
      const names = await this.actorNames(finals.map((r) => r.tester_id));
      groupsOf = (c) => {
        const testerId = finalByCase.get(c.id)?.tester_id;
        return [testerId ? names.get(testerId) ?? testerId : '(not run)'];
      };
    } else if (groupBy.startsWith('cf:')) {
      const values = await this.customFieldRepo.getValuesForEntities('TestCase', universe.map((c) => c.id), projectId);
      groupsOf = (c) => valueKeys(values.get(c.id)?.find((e) => e.definition.id === fieldDef!.id)?.value ?? null);
    } else {
      const values = await this.customFieldRepo.getValuesForEntities('TestSuite', [...ctx.suitePath.keys()], projectId);
      const suiteValue = (suiteId: string) => values.get(suiteId)?.find((e) => e.definition.id === fieldDef!.id)?.value ?? null;
      const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
      groupsOf = (c) => {
        // Same rule as the suite-field filter: a CHECKBOX is the case's own suite only; any
        // other field inherits from the nearest suite up the tree that has a value.
        if (fieldDef!.field_type === 'CHECKBOX') return valueKeys(suiteValue(c.test_suite_id));
        let cur: string | null | undefined = c.test_suite_id;
        const seen = new Set<string>();
        while (cur && !seen.has(cur)) {
          seen.add(cur);
          const v = suiteValue(cur);
          if (!isEmpty(v)) return valueKeys(v);
          cur = ctx.suiteParent.get(cur);
        }
        return [NO_VALUE];
      };
    }

    const items: BreakdownItem[] = universe.map((c) => ({
      groups: groupsOf(c),
      in_plan: inPlan.has(c.id),
      verdict: run ? finalByCase.get(c.id)?.verdict ?? null : undefined,
    }));

    const KNOWN_ORDER: Record<string, string[]> = {
      priority: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
      execution_type: ['MANUAL', 'AUTOMATED'],
      version_status: ['DRAFT', 'APPROVED', 'DEPRECATED'],
    };
    const order = KNOWN_ORDER[groupBy] ?? fieldDef?.options.map((o) => o.option_label) ?? [];
    const sortKey = (key: string) => {
      const i = order.indexOf(key);
      return key === NO_VALUE || key === '(not run)' ? [2, key] : i >= 0 ? [0, String(i).padStart(4, '0')] : [1, key];
    };
    const compare = (a: { key: string }, b: { key: string }) => {
      const [ga, ka] = sortKey(a.key);
      const [gb, kb] = sortKey(b.key);
      return (ga as number) - (gb as number) || String(ka).localeCompare(String(kb), undefined, { numeric: true });
    };

    const groups = run ? computeVerdictBreakdown(items).sort(compare) : computeCoverageBreakdown(items).sort(compare);
    return {
      data: {
        report: 'breakdown',
        generated_at: new Date().toISOString(),
        project: ctx.project,
        plan: { id: plan.id, name: plan.name, status: plan.status },
        run: run ? { id: run.id, name: run.name, status: run.status } : null,
        group_by: { key: groupBy, label },
        mode: run ? 'verdicts' : 'coverage',
        filter_applied: filterSet !== null,
        groups,
      },
      csv: {
        columns: run
          ? ['key', 'total', 'passed', 'failed', 'blocked', 'skipped', 'untested', 'other', 'pass_rate', 'completion']
          : ['key', 'total_cases', 'in_plan', 'not_in_plan', 'coverage'],
        rows: groups as unknown as Array<Record<string, unknown>>,
      },
    };
  }

  async overview(projectId: string, p: { days: number }): Promise<ReportOutput> {
    const ctx = await this.projectContext(projectId);
    const now = new Date();
    const plans = (await this.planRepo.findByProject(projectId)).filter((pl) => pl.status === 'ACTIVE');

    const planSummaries = [];
    for (const plan of plans) {
      const runs = await this.buildRepo.findByTestPlan(plan.id);
      const [latest, previous] = runs;
      if (!latest) {
        planSummaries.push({ plan: { id: plan.id, name: plan.name }, latest_run: null, previous_run: null, summary: null, new_failures: null, fixed: null });
        continue;
      }
      const rows = await this.executionRepo.getFinalResultsForRuns(plan.id, previous ? [latest.id, previous.id] : [latest.id]);
      const byRun = ReportService.groupByRun(rows);
      const head = byRun.get(latest.id) ?? [];
      const counts = previous
        ? diffRuns(
            (byRun.get(previous.id) ?? []).map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict })),
            head.map((r) => ({ test_case_id: r.test_case_id, verdict: r.verdict }))
          ).counts
        : null;
      planSummaries.push({
        plan: { id: plan.id, name: plan.name },
        latest_run: this.runRef(latest, plan),
        previous_run: previous ? { id: previous.id, name: previous.name } : null,
        summary: summarizeVerdicts(head.map((r) => r.verdict)),
        new_failures: counts ? counts.new_failure : null,
        fixed: counts ? counts.fixed : null,
      });
    }

    const byStatus: Record<string, number> = { DRAFT: 0, APPROVED: 0, DEPRECATED: 0, NONE: 0 };
    for (const c of ctx.cases) {
      const status = c.latest_version?.status ?? 'NONE';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
    const nowIso = now.toISOString();
    const drafts = ctx.cases
      .filter((c) => c.latest_version?.status === 'DRAFT')
      .map((c) => ({ ...this.caseRef(ctx, c.id), version_number: c.latest_version!.version_number, waiting_days: daysBetween(c.latest_version!.updated_at, nowIso) ?? 0 }))
      .sort((a, b) => b.waiting_days - a.waiting_days);
    const lastExecuted = await this.executionRepo.getLastExecutedAtByCase(projectId);
    const neverExecuted = ctx.cases.filter((c) => c.latest_version?.status !== 'DEPRECATED' && !lastExecuted.has(c.id)).length;

    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (p.days - 1)));
    const activityRows = await this.executionRepo.getActivity(projectId, start.toISOString());
    const byDay = new Map<string, { day: string; ui: number; api: number; total: number }>();
    for (let i = 0; i < p.days; i++) {
      const day = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(day, { day, ui: 0, api: 0, total: 0 });
    }
    for (const r of activityRows) {
      const entry = byDay.get(r.day);
      if (!entry) continue;
      if (r.source === 'API') entry.api += r.count;
      else entry.ui += r.count;
      entry.total += r.count;
    }
    const daysList = [...byDay.values()];

    return {
      data: {
        report: 'overview',
        generated_at: nowIso,
        project: ctx.project,
        plans: planSummaries,
        spec: {
          total_cases: ctx.cases.length,
          by_status: byStatus,
          drafts_awaiting_approval: drafts.length,
          oldest_drafts: drafts.slice(0, 10),
          never_executed: neverExecuted,
        },
        activity: {
          days: p.days,
          total: daysList.reduce((n, d) => n + d.total, 0),
          ui: daysList.reduce((n, d) => n + d.ui, 0),
          api: daysList.reduce((n, d) => n + d.api, 0),
          by_day: daysList,
        },
      },
    };
  }
}
