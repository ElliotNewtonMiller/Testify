import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database, TestSuiteNode } from '@testify/db';
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
  matchesCase,
  validateCaseFilterRequest,
  type CaseFilterFieldDescriptor,
  type CaseFilterRecord,
} from '@testify/core';
import { requirePermission } from '../middleware/auth.js';

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

/**
 * Case search & filter -- the single place a search/filter is ever evaluated. The web UI
 * calls exactly these routes (it narrows its already-loaded spec-tree / plan-cases data to
 * the returned ids), so anything the UI can filter, an API caller can too.
 *
 * GET  /api/v1/projects/:projectId/case-search/fields -- catalog of filterable properties.
 * POST /api/v1/projects/:projectId/case-search        -- { q?, filters?, plan_id?, build_id? }
 *      -> { case_ids, suite_ids, total_cases }. suite_ids is every suite containing a match
 *      plus all of its ancestors (what a tree view needs to stay navigable); when only suite
 *      filters are active, suites that match on their own values are included too, even if
 *      they hold no cases.
 *
 * Nested under :projectId and gated on SPEC_VIEW, same as reports.ts, so project-scoped
 * overrides and machine API tokens resolve correctly. Fixed number of queries per request
 * regardless of project size -- each optional data source is only loaded when a filter
 * actually needs it.
 */
export async function registerCaseSearchRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const suiteRepo = new TestSuiteRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const planRepo = new TestPlanRepository(db);
  const buildRepo = new BuildRepository(db);
  const executionRepo = new ExecutionRepository(db);
  const customFieldRepo = new CustomFieldRepository(db);

  async function buildCatalog(projectId: string, cases?: Array<{ priority: string; execution_type: string }>) {
    const [caseDefs, suiteDefs, projectCases] = await Promise.all([
      customFieldRepo.listVisibleToProject(projectId, 'TestCase'),
      customFieldRepo.listVisibleToProject(projectId, 'TestSuite'),
      cases ? Promise.resolve(cases) : caseRepo.findByProject(projectId),
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
      { key: 'in_plan', label: 'In Plan', kind: 'BOOLEAN', source: 'builtin', requires: 'plan_id' },
      {
        key: 'verdict',
        label: 'Verdict',
        kind: 'ENUM',
        source: 'builtin',
        options: toOptions(VERDICT_VALUES),
        strict_options: false,
        requires: 'build_id',
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

  app.get(
    '/api/v1/projects/:projectId/case-search/fields',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      if (!(await projectRepo.findById(projectId))) {
        return reply.status(404).send({ error: 'Project not found' });
      }
      return { fields: await buildCatalog(projectId) };
    }
  );

  app.post(
    '/api/v1/projects/:projectId/case-search',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = (request.body ?? {}) as { q?: unknown; filters?: unknown; plan_id?: unknown; build_id?: unknown };

      if (!(await projectRepo.findById(projectId))) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const cases = await caseRepo.findByProjectWithLatestVersion(projectId);
      const catalog = await buildCatalog(projectId, cases);
      const validation = validateCaseFilterRequest(body, new Map(catalog.map((f) => [f.key, f])));
      if (!validation.ok) {
        return reply.status(400).send({ error: 'INVALID_FILTER', details: validation.errors });
      }
      const { request: filterRequest } = validation;
      const usedFields = new Set(filterRequest.filters.map((f) => f.field));

      // Resolve plan/build, rejecting ids that belong to a different project.
      let planId = typeof body.plan_id === 'string' && body.plan_id ? body.plan_id : null;
      const buildId = typeof body.build_id === 'string' && body.build_id ? body.build_id : null;
      if (planId) {
        const plan = await planRepo.findById(planId);
        if (!plan || plan.project_id !== projectId) {
          return reply.status(404).send({ error: 'Test plan not found in this project' });
        }
      }
      if (buildId) {
        const build = await buildRepo.findById(buildId);
        const buildPlan = build ? await planRepo.findById(build.test_plan_id) : null;
        if (!build || !buildPlan || buildPlan.project_id !== projectId || (planId && build.test_plan_id !== planId)) {
          return reply.status(404).send({ error: 'Build not found in this project/plan' });
        }
        planId = planId ?? build.test_plan_id;
      }
      if (usedFields.has('in_plan') && !planId) {
        return reply.status(400).send({ error: 'INVALID_FILTER', details: ["'in_plan' requires plan_id"] });
      }
      if (usedFields.has('verdict') && !buildId) {
        return reply.status(400).send({ error: 'INVALID_FILTER', details: ["'verdict' requires build_id"] });
      }

      // Suite parent map (for suite_cf: inheritance and suite_ids ancestry).
      const tree = await suiteRepo.getTree(projectId);
      const parentBySuite = new Map<string, string | null>();
      const walk = (nodes: TestSuiteNode[]) => {
        for (const n of nodes) {
          parentBySuite.set(n.id, n.parent_suite_id);
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

      const needsCaseCf = [...usedFields].some((f) => f.startsWith('cf:'));
      const needsSuiteCf = [...usedFields].some((f) => f.startsWith('suite_cf:'));
      const [caseValues, suiteValues, pinned, latestExecs] = await Promise.all([
        needsCaseCf
          ? customFieldRepo.getValuesForEntities('TestCase', cases.map((c) => c.id), projectId)
          : Promise.resolve(new Map()),
        needsSuiteCf
          ? customFieldRepo.getValuesForEntities('TestSuite', [...parentBySuite.keys()], projectId)
          : Promise.resolve(new Map()),
        usedFields.has('in_plan') || usedFields.has('verdict')
          ? planRepo.getPinnedCases(planId!)
          : Promise.resolve([]),
        usedFields.has('verdict')
          ? executionRepo.getLatestExecutionsForPlanAcrossBuilds(planId!, [buildId!])
          : Promise.resolve([]),
      ]);

      const inPlanCaseIds = new Set(pinned.map((pc) => pc.test_case_id));
      const verdictByCaseId = new Map(latestExecs.map((e) => [e.test_case_id, e.verdict]));
      const suiteValueMaps = new Map<string, Map<string, unknown>>();
      for (const [suiteId, entries] of suiteValues as Map<string, Array<{ definition: { id: string }; value: unknown }>>) {
        suiteValueMaps.set(suiteId, new Map(entries.map((e) => [e.definition.id, e.value])));
      }

      const matchedCaseIds: string[] = [];
      const matchedSuiteIds = new Set<string>();
      for (const c of cases) {
        const values: Record<string, unknown> = {
          priority: c.priority,
          execution_type: c.execution_type,
          version_status: c.latest_version?.status ?? null,
          in_plan: inPlanCaseIds.has(c.id),
          verdict: inPlanCaseIds.has(c.id) ? verdictByCaseId.get(c.id) ?? 'UNTESTED' : null,
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
        if (matchesCase(record, filterRequest)) {
          matchedCaseIds.push(c.id);
          for (const sid of chain) matchedSuiteIds.add(sid);
        }
      }

      // When every filter is a suite filter (and there's no text search), a suite that itself
      // satisfies them is shown even if it has no cases -- otherwise e.g. an empty suite with
      // its box unticked would vanish under "No" just because the tree is built from cases.
      const suiteOnly = !filterRequest.q && filterRequest.filters.length > 0 && filterRequest.filters.every((f) => f.inherited);
      if (suiteOnly) {
        for (const suiteId of parentBySuite.keys()) {
          if (matchedSuiteIds.has(suiteId)) continue;
          const chain = ancestry(suiteId);
          const values: Record<string, unknown> = {};
          for (const f of filterRequest.filters) {
            const defId = f.field.slice('suite_cf:'.length);
            values[f.field] = chain.map((sid) => suiteValueMaps.get(sid)?.get(defId) ?? null);
          }
          if (matchesCase({ external_id: '', title: '', values }, filterRequest)) {
            for (const sid of chain) matchedSuiteIds.add(sid);
          }
        }
      }

      return {
        case_ids: matchedCaseIds,
        suite_ids: [...matchedSuiteIds],
        total_cases: cases.length,
      };
    }
  );
}
