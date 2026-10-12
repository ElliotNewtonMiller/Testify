import type { Kysely } from 'kysely';
import type { Database, TestSuiteNode } from '@testify/db';
import {
  TestRunRepository,
  CustomFieldRepository,
  TestResultRepository,
  TestCaseRepository,
  TestPlanRepository,
  TestSuiteRepository,
} from '@testify/db';
import {
  matchesCase,
  validateCaseFilterRequest,
  type CaseFilterFieldDescriptor,
  type CaseFilterRecord,
} from '@testify/core';

const PRIORITY_VALUES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const EXECUTION_TYPE_VALUES = ['MANUAL', 'AUTOMATED'];
const VERSION_STATUS_VALUES = ['DRAFT', 'APPROVED', 'DEPRECATED'];
const VERDICT_VALUES = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'UNTESTED'];

function toOptions(values: string[]) {
  return values.map((v) => ({ value: v, label: v }));
}

/** Known values first, then any other value actually stored in this project (imports can
 * write priorities/execution types outside the standard set). */
function mergeValues(known: string[], present: Iterable<string>) {
  const result = [...known];
  for (const v of present) if (v && !result.includes(v)) result.push(v);
  return result;
}

export type CaseFilterOutcome =
  | { ok: true; case_ids: string[]; suite_ids: string[]; total_cases: number }
  | { ok: false; status: 400 | 404; error: string; details?: unknown };

/**
 * Case search & filter -- the single place a search/filter is ever evaluated. Used by the
 * case-search routes (which the web UI calls to narrow its lists) and by every report that
 * accepts a `filter`, so a filter means exactly the same thing everywhere.
 *
 * Fixed number of queries per call regardless of project size -- each optional data source
 * is only loaded when a filter actually needs it.
 */
export class CaseFilterService {
  private suiteRepo: TestSuiteRepository;
  private caseRepo: TestCaseRepository;
  private planRepo: TestPlanRepository;
  private runRepo: TestRunRepository;
  private resultRepo: TestResultRepository;
  private customFieldRepo: CustomFieldRepository;

  constructor(db: Kysely<Database>) {
    this.suiteRepo = new TestSuiteRepository(db);
    this.caseRepo = new TestCaseRepository(db);
    this.planRepo = new TestPlanRepository(db);
    this.runRepo = new TestRunRepository(db);
    this.resultRepo = new TestResultRepository(db);
    this.customFieldRepo = new CustomFieldRepository(db);
  }

  /** Every filterable property of the project's cases (built-ins + visible custom fields). */
  async fieldCatalog(projectId: string, cases?: Array<{ priority: string; execution_type: string }>): Promise<CaseFilterFieldDescriptor[]> {
    const [caseDefs, suiteDefs, projectCases] = await Promise.all([
      this.customFieldRepo.listVisibleToProject(projectId, 'TestCase'),
      this.customFieldRepo.listVisibleToProject(projectId, 'TestSuite'),
      cases ? Promise.resolve(cases) : this.caseRepo.findByProject(projectId),
    ]);

    const fields: CaseFilterFieldDescriptor[] = [
      {
        key: 'priority',
        label: 'Priority',
        kind: 'ENUM',
        source: 'builtin',
        options: toOptions(mergeValues(PRIORITY_VALUES, projectCases.map((c) => c.priority))),
        strict_options: false,
      },
      {
        key: 'execution_type',
        label: 'Execution Type',
        kind: 'ENUM',
        source: 'builtin',
        options: toOptions(mergeValues(EXECUTION_TYPE_VALUES, projectCases.map((c) => c.execution_type))),
        strict_options: false,
      },
      {
        key: 'version_status',
        label: 'Status',
        kind: 'ENUM',
        source: 'builtin',
        options: toOptions(VERSION_STATUS_VALUES),
        strict_options: true,
      },
      { key: 'in_plan', label: 'In Plan', kind: 'BOOLEAN', source: 'builtin', requires: 'test_plan_id' },
      {
        key: 'verdict',
        label: 'Verdict',
        kind: 'ENUM',
        source: 'builtin',
        options: toOptions(VERDICT_VALUES),
        strict_options: false,
        requires: 'test_run_id',
      },
    ];

    for (const def of caseDefs) {
      fields.push({
        key: `cf:${def.id}`,
        label: def.field_label,
        kind: def.field_type,
        source: 'case_custom_field',
        ...(def.options.length > 0
          ? { options: def.options.map((o) => ({ value: o.option_value, label: o.option_label })), strict_options: true }
          : {}),
      });
    }
    for (const def of suiteDefs) {
      fields.push({
        key: `suite_cf:${def.id}`,
        label: def.field_label, // `source` already says it's a suite field (the UI groups by it)
        kind: def.field_type,
        source: 'suite_custom_field',
        ...(def.options.length > 0
          ? { options: def.options.map((o) => ({ value: o.option_value, label: o.option_label })), strict_options: true }
          : {}),
      });
    }
    return fields;
  }

  /**
   * Evaluates { q?, filters?, test_plan_id?, test_run_id? } against a project's cases (the project
   * must exist -- callers check). suite_ids is every suite containing a match plus all of its
   * ancestors (what a tree view needs to stay navigable); when only suite filters are active,
   * suites that match on their own values are included too, even if they hold no cases.
   */
  async evaluate(projectId: string, body: { q?: unknown; filters?: unknown; test_plan_id?: unknown; test_run_id?: unknown }): Promise<CaseFilterOutcome> {
    const cases = await this.caseRepo.findByProjectWithLatestVersion(projectId);
    const catalog = await this.fieldCatalog(projectId, cases);
    const validation = validateCaseFilterRequest(body, new Map(catalog.map((f) => [f.key, f])));
    if (!validation.ok) {
      return { ok: false, status: 400, error: 'INVALID_FILTER', details: validation.errors };
    }
    const { request: filterRequest } = validation;
    const usedFields = new Set(filterRequest.filters.map((f) => f.field));

    // Resolve plan/run, rejecting ids that belong to a different project.
    let planId = typeof body.test_plan_id === 'string' && body.test_plan_id ? body.test_plan_id : null;
    const runId = typeof body.test_run_id === 'string' && body.test_run_id ? body.test_run_id : null;
    if (planId) {
      const plan = await this.planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return { ok: false, status: 404, error: 'Test plan not found in this project' };
      }
    }
    if (runId) {
      const run = await this.runRepo.findById(runId);
      const runPlan = run ? await this.planRepo.findById(run.test_plan_id) : null;
      if (!run || !runPlan || runPlan.project_id !== projectId || (planId && run.test_plan_id !== planId)) {
        return { ok: false, status: 404, error: 'Test run not found in this project or plan' };
      }
      planId = planId ?? run.test_plan_id;
    }
    if (usedFields.has('in_plan') && !planId) {
      return { ok: false, status: 400, error: 'INVALID_FILTER', details: ["'in_plan' requires test_plan_id"] };
    }
    if (usedFields.has('verdict') && !runId) {
      return { ok: false, status: 400, error: 'INVALID_FILTER', details: ["'verdict' requires test_run_id"] };
    }

    // Suite parent map (for suite_cf: inheritance and suite_ids ancestry).
    const tree = await this.suiteRepo.getTree(projectId);
    const parentBySuite = new Map<string, string | null>();
    const nameBySuite = new Map<string, string>();
    const walk = (nodes: TestSuiteNode[]) => {
      for (const n of nodes) {
        parentBySuite.set(n.id, n.parent_suite_id);
        nameBySuite.set(n.id, n.name);
        walk(n.children);
      }
    };
    walk(tree);
    const ancestry = (suiteId: string): string[] => {
      const chain: string[] = [];
      const seen = new Set<string>();
      let cur: string | null | undefined = suiteId;
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        chain.push(cur);
        cur = parentBySuite.get(cur);
      }
      return chain;
    };

    const hasQ = Boolean(filterRequest.q);
    const needsCaseCf = [...usedFields].some((f) => f.startsWith('cf:'));
    const needsSuiteCf = [...usedFields].some((f) => f.startsWith('suite_cf:'));
    const [caseValues, suiteValues, pinned, latestExecs] = await Promise.all([
      needsCaseCf
        ? this.customFieldRepo.getValuesForEntities('TestCase', cases.map((c) => c.id), projectId)
        : Promise.resolve(new Map()),
      needsSuiteCf
        ? this.customFieldRepo.getValuesForEntities('TestSuite', [...parentBySuite.keys()], projectId)
        : Promise.resolve(new Map()),
      usedFields.has('in_plan') || usedFields.has('verdict')
        ? this.planRepo.getPinnedCases(planId!)
        : Promise.resolve([]),
      usedFields.has('verdict')
        ? this.resultRepo.getFinalResultsForRuns(planId!, [runId!])
        : Promise.resolve([]),
    ]);

    const inPlanCaseIds = new Set(pinned.map((pc) => pc.test_case_id));
    const verdictByCaseId = new Map(latestExecs.map((e) => [e.test_case_id, e.verdict]));
    const suiteValueMaps = new Map<string, Map<string, unknown>>();
    for (const [suiteId, entries] of suiteValues as Map<string, Array<{ definition: { id: string }; value: unknown }>>) {
      suiteValueMaps.set(suiteId, new Map(entries.map((e) => [e.definition.id, e.value])));
    }

    // Besides a case's id and title, the free-text search matches the name of its suite and of
    // every suite above it -- searching a suite's name finds everything inside it.
    const chainSearchText = (chain: string[]) => chain.map((sid) => nameBySuite.get(sid) ?? '');

    const matchedCaseIds: string[] = [];
    const matchedSuiteIds = new Set<string>();
    for (const c of cases) {
      const values: Record<string, unknown> = {
        priority: c.priority,
        execution_type: c.execution_type,
        version_status: c.latest_version?.status ?? null,
        in_plan: inPlanCaseIds.has(c.id),
        // Every case the run contains (incl. one removed from the plan that has a result here).
        verdict: verdictByCaseId.has(c.id) ? verdictByCaseId.get(c.id) ?? 'UNTESTED' : null,
      };
      if (needsCaseCf) {
        for (const e of (caseValues.get(c.id) ?? []) as Array<{ definition: { id: string }; value: unknown }>) {
          values[`cf:${e.definition.id}`] = e.value;
        }
      }
      const chain = ancestry(c.test_suite_id);
      if (needsSuiteCf) {
        for (const field of usedFields) {
          if (!field.startsWith('suite_cf:')) continue;
          const defId = field.slice('suite_cf:'.length);
          values[field] = chain.map((sid) => suiteValueMaps.get(sid)?.get(defId) ?? null);
        }
      }

      const record: CaseFilterRecord = { external_id: c.external_id, title: c.title, values };
      if (hasQ) record.search_text = chainSearchText(chain);
      if (matchesCase(record, filterRequest)) {
        matchedCaseIds.push(c.id);
        for (const sid of chain) matchedSuiteIds.add(sid);
      }
    }

    // When every filter is a suite filter, a suite that itself satisfies them -- and the text
    // search, matched against its own and its parents' names -- is shown even
    // if it has no cases. Otherwise e.g. an empty suite with its box unticked would vanish under
    // "No", or searching a suite's name wouldn't show that suite when it's empty.
    const suiteOnly = (hasQ || filterRequest.filters.length > 0) && filterRequest.filters.every((f) => f.inherited);
    if (suiteOnly) {
      for (const suiteId of parentBySuite.keys()) {
        if (matchedSuiteIds.has(suiteId)) continue;
        const chain = ancestry(suiteId);
        const values: Record<string, unknown> = {};
        for (const f of filterRequest.filters) {
          const defId = f.field.slice('suite_cf:'.length);
          values[f.field] = chain.map((sid) => suiteValueMaps.get(sid)?.get(defId) ?? null);
        }
        if (matchesCase({ external_id: '', title: '', values, search_text: hasQ ? chainSearchText(chain) : undefined }, filterRequest)) {
          for (const sid of chain) matchedSuiteIds.add(sid);
        }
      }
    }

    return { ok: true, case_ids: matchedCaseIds, suite_ids: [...matchedSuiteIds], total_cases: cases.length };
  }
}
