import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import {
  TestSuiteRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
  ProjectRepository,
  TestResultRepository,
  TestRunRepository,
  type TestSuiteNode,
  type TestCaseVersionWithSteps,
} from '@testify/db';
import { authenticateRequest, requirePermission, requireAnyPermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { sendPlanLockedError,
  sendCaseVersionNotApprovedError,
  sendCaseHasResultsError, sendError } from '../errors.js';
import { requestOrigin } from '../audit.js';
import * as S from '../openapi/areas/spec.js';

export interface CaseLinkability {
  linkable: boolean;
  latestVersion: TestCaseVersionWithSteps | undefined;
}

function parseAllowDraftPlanLinking(settings: string | null | undefined): boolean {
  if (!settings) return false;
  try {
    const parsed = JSON.parse(settings);
    return parsed?.allow_draft_plan_linking === true;
  } catch {
    return false;
  }
}

/**
 * Whether a test case can be linked to a project's test plans right now: its latest
 * version must be APPROVED, unless the project's `allow_draft_plan_linking` setting is on.
 * Shared by the explicit toggle/whole-suite routes below and batchExecution.ts's auto-link path,
 * so "must be Approved" means the same thing everywhere plan membership can be created.
 */
export async function resolveCaseLinkability(
  db: Kysely<Database>,
  projectId: string,
  testCaseId: string
): Promise<CaseLinkability> {
  const versionRepo = new TestCaseVersionRepository(db);
  const latestVersion = await versionRepo.findLatestVersion(testCaseId);
  if (!latestVersion) {
    return { linkable: false, latestVersion: undefined };
  }
  if (latestVersion.status === 'APPROVED') {
    return { linkable: true, latestVersion };
  }
  // A deprecated case is retired -- never newly linkable, even when the project allows
  // linking drafts (that setting is about unreviewed work, not retired cases).
  if (latestVersion.status === 'DEPRECATED') {
    return { linkable: false, latestVersion };
  }

  const projectRepo = new ProjectRepository(db);
  const project = await projectRepo.findById(projectId);
  const allowDraft = parseAllowDraftPlanLinking(project?.settings);

  return { linkable: allowDraft, latestVersion };
}

function isPlanLockedOrArchived(status: string): boolean {
  return status === 'LOCKED' || status === 'ARCHIVED';
}

interface SuiteCounts {
  in_plan_count: number;
  total_case_count: number;
}

/**
 * Bottom-up pass computing (in_plan_count, total_case_count) per suite, summed over its
 * whole subtree. Drives the tri-state cascade indicator in the Specification-mode tree.
 */
function annotateTreeCounts(
  nodes: TestSuiteNode[],
  caseCountBySuite: Map<string, number>,
  inPlanCountBySuite: Map<string, number>
): Array<TestSuiteNode & SuiteCounts> {
  return nodes.map((node) => {
    const children = annotateTreeCounts(node.children, caseCountBySuite, inPlanCountBySuite);
    let total = caseCountBySuite.get(node.id) ?? 0;
    let inPlan = inPlanCountBySuite.get(node.id) ?? 0;
    for (const child of children) {
      total += child.total_case_count;
      inPlan += child.in_plan_count;
    }
    return { ...node, children, total_case_count: total, in_plan_count: inPlan };
  });
}

export async function registerTestPlanCaseRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  jwtSecret: string
) {
  const suiteRepo = new TestSuiteRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const versionRepo = new TestCaseVersionRepository(db);
  const planRepo = new TestPlanRepository(db);
  const projectRepo = new ProjectRepository(db);
  const resultRepo = new TestResultRepository(db);
  const runRepo = new TestRunRepository(db);

  // GET /api/v1/projects/:projectId/spec-tree?test_plan_id=...&include_deprecated=true -- drives
  // Specification mode's whole 3-pane view in one fetch: nested suite tree (with
  // plan-inclusion counts) + a lightweight case list (no steps -- see the latest-version
  // endpoint below for detail). Cases whose latest version is DEPRECATED are omitted (from
  // both the list and the tree counts) unless include_deprecated=true.
  app.get('/api/v1/projects/:projectId/spec-tree', { schema: S.specTreeSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) }, async (request, reply) => {

    const { projectId } = request.params as { projectId: string };
    const { test_plan_id: planId, include_deprecated: includeDeprecatedParam } = request.query as {
      test_plan_id?: string;
      include_deprecated?: string;
    };
    const includeDeprecated = includeDeprecatedParam === 'true' || includeDeprecatedParam === '1';

    const project = await projectRepo.findById(projectId);
    if (!project) {
      return sendError(reply, 404, 'Project not found');
    }

    const [tree, allCasesWithVersions] = await Promise.all([
      suiteRepo.getTree(projectId),
      caseRepo.findByProjectWithLatestVersion(projectId),
    ]);
    const casesWithVersions = includeDeprecated
      ? allCasesWithVersions
      : allCasesWithVersions.filter((c) => c.latest_version?.status !== 'DEPRECATED');

    const allowDraft = parseAllowDraftPlanLinking(project.settings);

    let planCaseByCaseId = new Map<string, { id: string; test_case_version_id: string }>();
    if (planId) {
      const plan = await planRepo.findById(planId);
      if (!plan || plan.project_id !== projectId) {
        return sendError(reply, 404, 'Test plan not found in this project');
      }
      const pinnedCases = await planRepo.getPinnedCases(planId);
      planCaseByCaseId = new Map(pinnedCases.map((pc) => [pc.test_case_id, pc]));
    }

    // Someone who can execute but not view the spec (EXECUTE_RUN without SPEC_VIEW) sees only the
    // selected plan's cases and the folders they sit in -- enough to find their way through a run.
    const perms = request.user!.permissions;
    const fullSpec = perms.includes('SPEC_VIEW') || perms.includes('SYSTEM_ADMIN');
    const visibleCases = fullSpec ? casesWithVersions : casesWithVersions.filter((c) => planCaseByCaseId.has(c.id));

    const caseCountBySuite = new Map<string, number>();
    const inPlanCountBySuite = new Map<string, number>();

    const cases = visibleCases.map((c) => {
      caseCountBySuite.set(c.test_suite_id, (caseCountBySuite.get(c.test_suite_id) ?? 0) + 1);

      const planCase = planCaseByCaseId.get(c.id);
      const inPlan = Boolean(planCase);
      if (inPlan) {
        inPlanCountBySuite.set(c.test_suite_id, (inPlanCountBySuite.get(c.test_suite_id) ?? 0) + 1);
      }

      const latestVersion = c.latest_version;
      const linkable = latestVersion ? latestVersion.status === 'APPROVED' || allowDraft : false;

      return {
        id: c.id,
        external_id: c.external_id,
        title: c.title,
        priority: c.priority,
        execution_type: c.execution_type,
        test_suite_id: c.test_suite_id,
        latest_version: latestVersion,
        in_plan: inPlan,
        test_plan_case_id: planCase?.id ?? null,
        pinned_test_case_version_id: planCase?.test_case_version_id ?? null,
        is_pinned_version_stale: Boolean(
          planCase && latestVersion && planCase.test_case_version_id !== latestVersion.id
        ),
        linkable,
      };
    });

    const annotated = annotateTreeCounts(tree, caseCountBySuite, inPlanCountBySuite);
    const pruneEmpty = (nodes: typeof annotated): typeof annotated =>
      nodes.filter((n) => n.total_case_count > 0).map((n) => ({ ...n, children: pruneEmpty(n.children as typeof annotated) }));
    const suites = fullSpec ? annotated : pruneEmpty(annotated);

    return {
      project: {
        id: project.id,
        name: project.name,
        prefix: project.prefix,
        settings: { allow_draft_plan_linking: allowDraft },
      },
      suites,
      cases,
    };
  });

  // GET /api/v1/cases/:caseId/versions/latest -- lazy per-case detail (summary,
  // preconditions, steps), fetched only when a case row is opened in Specification mode.
  app.get('/api/v1/cases/:caseId/versions/latest', { schema: S.latestVersionSchema, preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) }, async (request, reply) => {

    const { caseId } = request.params as { caseId: string };
    const testCase = await caseRepo.findById(caseId);
    if (!testCase) {
      return sendError(reply, 404, 'Test case not found');
    }

    const latestVersion = await versionRepo.findLatestVersion(caseId);
    if (!latestVersion) {
      return sendError(reply, 404, 'Test case has no versions');
    }

    return { test_case: testCase, version: latestVersion };
  });

  // GET /api/v1/plans/:planId/cases?test_run_id=... -- Execution mode's case queue for a
  // plan. With test_run_id (or defaulting to the plan's most recent run), each case carries
  // its latest result in that run.
  app.get('/api/v1/plans/:planId/cases', { schema: S.planCasesSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) }, async (request, reply) => {

    const { planId } = request.params as { planId: string };
    const { test_run_id: requestedRunId } = request.query as { test_run_id?: string };

    const plan = await planRepo.findById(planId);
    if (!plan) {
      return sendError(reply, 404, 'Test plan not found');
    }

    const runs = await runRepo.findByTestPlan(planId);
    const runId = requestedRunId || runs[0]?.id;

    // Which cases this run contains, and each one's latest result in it -- the shared rule in
    // TestResultRepository.getFinalResultsForRuns: active links, plus cases removed from the
    // plan that have a result in this run (shown read-only). With no run yet: active links.
    const finals = runId ? await resultRepo.getFinalResultsForRuns(planId, [runId]) : [];
    const finalByLink = new Map(finals.map((f) => [f.plan_case_id, f]));

    let caseQuery = db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .innerJoin('test_case_versions as tcv', 'tcv.id', 'tpc.test_case_version_id')
      .select([
        'tpc.id as test_plan_case_id',
        'tpc.position',
        'tc.id as test_case_id',
        'tc.test_suite_id',
        'tc.external_id',
        'tc.title',
        'tc.priority',
        'tc.execution_type',
        'tcv.id as test_case_version_id',
        'tcv.version_number',
        'tcv.status as version_status',
        'tcv.summary',
        'tcv.preconditions',
      ])
      .where('tpc.test_plan_id', '=', planId);
    if (runId && finals.length === 0) return { plan, runs, cases: [] }; // the plan has no cases
    caseQuery = runId ? caseQuery.where('tpc.id', 'in', finals.map((f) => f.plan_case_id)) : caseQuery.where('tpc.removed_at', 'is', null);
    const rawCases = await caseQuery.orderBy('tpc.position', 'asc').execute();

    const cases = await Promise.all(
      rawCases.map(async (c) => {
        const steps = await versionRepo.getSteps(c.test_case_version_id);
        const final = finalByLink.get(c.test_plan_case_id);
        return {
          ...c,
          steps,
          latest_verdict: final?.verdict || 'UNTESTED',
          latest_test_result_id: final?.test_result_id ?? null,
          latest_notes: final?.notes ?? null,
          removed_from_plan: final?.removed_from_plan ?? false,
        };
      })
    );

    return { plan, runs, cases };
  });

  // POST /api/v1/plans/:planId/cases -- per-case plan-inclusion toggle, ON.
  app.post(
    '/api/v1/plans/:planId/cases',
    { schema: S.addPlanCaseSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { planId } = request.params as { planId: string };
      const { test_case_id: testCaseId } = (request.body as { test_case_id?: string }) || {};

      if (!testCaseId) {
        return sendError(reply, 400, 'test_case_id is required');
      }

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return sendError(reply, 404, 'Test plan not found');
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const testCase = await caseRepo.findById(testCaseId);
      if (!testCase) {
        return sendError(reply, 404, 'Test case not found');
      }

      // Idempotent: re-toggling an already-included case just returns the existing row.
      const existing = await planRepo.getPinnedCase(planId, testCaseId);
      if (existing) {
        return reply.status(200).send({ plan_case: existing });
      }

      const { linkable, latestVersion } = await resolveCaseLinkability(db, plan.project_id, testCaseId);
      if (!latestVersion) {
        return sendError(reply, 422, 'Test case has no versions to link');
      }
      if (!linkable) {
        return sendCaseVersionNotApprovedError(reply, testCaseId, request.url);
      }

      const pinnedCases = await planRepo.getPinnedCases(planId);
      const planCase = await planRepo.addCase({
        test_plan_id: planId,
        test_case_id: testCaseId,
        test_case_version_id: latestVersion.id,
        position: pinnedCases.length + 1,
      });

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: 'USER',
          action: 'PLAN_CASE_ADDED',
          resource_type: 'test_plan_case',
          resource_id: planCase.id,
          project_id: plan.project_id,
          diff: JSON.stringify({ test_plan_id: planId, test_case_id: testCaseId }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(201).send({ plan_case: planCase });
    }
  );

  // DELETE /api/v1/plans/:planId/cases/:caseId[?force=true] -- per-case plan-inclusion
  // toggle, OFF. A case with results needs force=true (409 CASE_HAS_RESULTS otherwise, with
  // counts for a confirmation) and is then retired rather than deleted: its results stay in
  // the runs that recorded them; future runs don't include it.
  app.delete(
    '/api/v1/plans/:planId/cases/:caseId',
    { schema: S.removePlanCaseSchema, preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { planId, caseId } = request.params as { planId: string; caseId: string };

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return sendError(reply, 404, 'Test plan not found');
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const planCase = await planRepo.getPinnedCase(planId, caseId);
      if (!planCase) {
        return sendError(reply, 404, 'Test case is not in this plan');
      }
      const force = (request.query as { force?: string }).force === 'true';

      const outcome = await planRepo.removeCases(planId, [caseId], actor.id, { force });
      if (outcome.blocked) {
        const testCase = await caseRepo.findById(caseId);
        return sendCaseHasResultsError(reply, { label: testCase?.external_id ?? caseId, scope: 'case', ...outcome }, request.url);
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: 'USER',
          action: outcome.retired ? 'PLAN_CASE_RETIRED' : 'PLAN_CASE_REMOVED',
          resource_type: 'test_plan_case',
          resource_id: planCase.id,
          project_id: plan.project_id,
          diff: JSON.stringify({ test_plan_id: planId, test_case_id: caseId, kept_results: outcome.retired > 0 }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );

  // POST /api/v1/plans/:planId/suites/:suiteId/cases -- adds every case in the suite's subtree
  // to the plan in one call, skipping (and reporting) cases that fail the Approved-only rule.
  // DELETE /api/v1/plans/:planId/suites/:suiteId/cases[?force=true] -- removes them. If any case
  // has results, nothing changes without force=true (409 CASE_HAS_RESULTS with counts); with it,
  // those cases are retired (their results stay in old runs) and the rest unlinked.
  const suiteCases = (action: 'ADD' | 'REMOVE') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const actor = request.user!;
      const { planId, suiteId } = request.params as { planId: string; suiteId: string };
      const force = (request.query as { force?: string }).force === 'true';

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return sendError(reply, 404, 'Test plan not found');
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return sendError(reply, 404, 'Test suite not found');
      }

      const descendants = await suiteRepo.findDescendants(suiteId);
      const suiteIds = [suiteId, ...descendants.map((s) => s.id)];
      const cases = await caseRepo.findBySuiteIds(suiteIds);

      const skipped: Array<{ test_case_id: string; external_id: string; reason: string }> = [];
      let added = 0;
      let removed = 0;
      let retired = 0;

      if (action === 'ADD') {
        const entries: Array<{ test_case_id: string; test_case_version_id: string }> = [];
        for (const c of cases) {
          const { linkable, latestVersion } = await resolveCaseLinkability(db, plan.project_id, c.id);
          if (!latestVersion) {
            skipped.push({ test_case_id: c.id, external_id: c.external_id, reason: 'NO_VERSION' });
            continue;
          }
          if (!linkable) {
            skipped.push({ test_case_id: c.id, external_id: c.external_id, reason: 'NOT_APPROVED' });
            continue;
          }
          entries.push({ test_case_id: c.id, test_case_version_id: latestVersion.id });
        }

        const before = await planRepo.getPinnedCases(planId);
        const beforeIds = new Set(before.map((pc) => pc.test_case_id));
        await planRepo.addCasesBulk(planId, entries);
        added = entries.filter((e) => !beforeIds.has(e.test_case_id)).length;
      } else {
        const outcome = await planRepo.removeCases(planId, cases.map((c) => c.id), actor.id, { force });
        if (outcome.blocked) {
          return sendCaseHasResultsError(reply, { label: `suite ${suite.name}`, scope: 'suite', ...outcome }, request.url);
        }
        removed = outcome.removed;
        retired = outcome.retired;
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: 'USER',
          action: action === 'ADD' ? 'PLAN_CASE_CASCADE_ADD' : 'PLAN_CASE_CASCADE_REMOVE',
          resource_type: 'test_suite',
          resource_id: suiteId,
          project_id: plan.project_id,
          diff: JSON.stringify({
            test_plan_id: planId,
            suite_id: suiteId,
            added,
            removed,
            retired,
            skipped_count: skipped.length,
          }),
          ...requestOrigin(request),
          created_at: now,
        })
        .execute();

      return reply.status(200).send({ added, removed, retired, skipped });
    };
  const planManage = requirePermission('PLAN_MANAGE', db, jwtSecret);
  app.post('/api/v1/plans/:planId/suites/:suiteId/cases', { schema: S.addSuiteCasesSchema, preHandler: planManage }, suiteCases('ADD'));
  app.delete('/api/v1/plans/:planId/suites/:suiteId/cases', { schema: S.removeSuiteCasesSchema, preHandler: planManage }, suiteCases('REMOVE'));
}
