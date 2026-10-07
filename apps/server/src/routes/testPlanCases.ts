import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import {
  TestSuiteRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
  ProjectRepository,
  ExecutionRepository,
  BuildRepository,
  type TestSuiteNode,
  type TestCaseVersionWithSteps,
} from '@testify/db';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import {
  sendPlanLockedError,
  sendCaseVersionNotApprovedError,
  sendCaseHasResultsError,
} from '../errors.js';

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
 * Shared by the explicit toggle/cascade routes below and batchExecution.ts's auto-link path,
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
  const executionRepo = new ExecutionRepository(db);
  const buildRepo = new BuildRepository(db);

  // GET /api/v1/projects/:projectId/spec-tree?plan_id=...&include_deprecated=true -- drives
  // Specification mode's whole 3-pane view in one fetch: nested suite tree (with
  // plan-inclusion counts) + a lightweight case list (no steps -- see the latest-version
  // endpoint below for detail). Cases whose latest version is DEPRECATED are omitted (from
  // both the list and the tree counts) unless include_deprecated=true.
  app.get('/api/v1/projects/:projectId/spec-tree', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { projectId } = request.params as { projectId: string };
    const { plan_id: planId, include_deprecated: includeDeprecatedParam } = request.query as {
      plan_id?: string;
      include_deprecated?: string;
    };
    const includeDeprecated = includeDeprecatedParam === 'true' || includeDeprecatedParam === '1';

    const project = await projectRepo.findById(projectId);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
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
      const pinnedCases = await planRepo.getPinnedCases(planId);
      planCaseByCaseId = new Map(pinnedCases.map((pc) => [pc.test_case_id, pc]));
    }

    const caseCountBySuite = new Map<string, number>();
    const inPlanCountBySuite = new Map<string, number>();

    const cases = casesWithVersions.map((c) => {
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
        plan_case_id: planCase?.id ?? null,
        plan_version_id: planCase?.test_case_version_id ?? null,
        is_pinned_version_stale: Boolean(
          planCase && latestVersion && planCase.test_case_version_id !== latestVersion.id
        ),
        linkable,
      };
    });

    const suites = annotateTreeCounts(tree, caseCountBySuite, inPlanCountBySuite);

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

  // GET /api/v1/test-cases/:caseId/latest-version -- lazy per-case detail (summary,
  // preconditions, steps), fetched only when a case row is opened in Specification mode.
  app.get('/api/v1/test-cases/:caseId/latest-version', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { caseId } = request.params as { caseId: string };
    const testCase = await caseRepo.findById(caseId);
    if (!testCase) {
      return reply.status(404).send({ error: 'Test case not found' });
    }

    const latestVersion = await versionRepo.findLatestVersion(caseId);
    if (!latestVersion) {
      return reply.status(404).send({ error: 'Test case has no versions' });
    }

    return { test_case: testCase, version: latestVersion };
  });

  // GET /api/v1/test-plans/:planId/cases?build_id=... -- Execution-mode listing,
  // parameterized by plan instead of hardcoded to the seed plan (unlike GET /api/v1/workspace).
  // When build_id is given (or defaulted to the plan's most recent build), each case is
  // annotated with its latest execution verdict for that build, same as the old endpoint did.
  app.get('/api/v1/test-plans/:planId/cases', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { planId } = request.params as { planId: string };
    const { build_id: requestedBuildId } = request.query as { build_id?: string };

    const plan = await planRepo.findById(planId);
    if (!plan) {
      return reply.status(404).send({ error: 'Test plan not found' });
    }

    const builds = await buildRepo.findByTestPlan(planId);
    const buildId = requestedBuildId || builds[0]?.id;

    // Which cases this run contains, and each one's latest result in it -- the shared rule in
    // ExecutionRepository.getFinalResultsForRuns: active links, plus cases removed from the
    // plan that have a result in this run (shown read-only). With no run yet: active links.
    const finals = buildId ? await executionRepo.getFinalResultsForRuns(planId, [buildId]) : [];
    const finalByLink = new Map(finals.map((f) => [f.plan_case_id, f]));

    let caseQuery = db
      .selectFrom('test_plan_cases as tpc')
      .innerJoin('test_cases as tc', 'tc.id', 'tpc.test_case_id')
      .innerJoin('test_case_versions as tcv', 'tcv.id', 'tpc.test_case_version_id')
      .select([
        'tpc.id as plan_case_id',
        'tpc.position',
        'tc.id as case_id',
        'tc.test_suite_id',
        'tc.external_id',
        'tc.title',
        'tc.priority',
        'tc.execution_type',
        'tcv.id as version_id',
        'tcv.version_number',
        'tcv.status as version_status',
        'tcv.summary',
        'tcv.preconditions',
      ])
      .where('tpc.test_plan_id', '=', planId);
    if (buildId && finals.length === 0) return { plan, builds, cases: [] }; // the plan has no cases
    caseQuery = buildId ? caseQuery.where('tpc.id', 'in', finals.map((f) => f.plan_case_id)) : caseQuery.where('tpc.removed_at', 'is', null);
    const rawCases = await caseQuery.orderBy('tpc.position', 'asc').execute();

    const cases = await Promise.all(
      rawCases.map(async (c) => {
        const steps = await versionRepo.getSteps(c.version_id);
        const final = finalByLink.get(c.plan_case_id);
        return {
          ...c,
          steps,
          latest_verdict: final?.verdict || 'UNTESTED',
          latest_execution_id: final?.execution_id ?? null,
          latest_notes: final?.notes ?? null,
          removed_from_plan: final?.removed_from_plan ?? false,
        };
      })
    );

    return { plan, builds, cases };
  });

  // POST /api/v1/test-plans/:planId/cases -- per-case plan-inclusion toggle, ON.
  app.post(
    '/api/v1/test-plans/:planId/cases',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { planId } = request.params as { planId: string };
      const { test_case_id: testCaseId } = (request.body as { test_case_id?: string }) || {};

      if (!testCaseId) {
        return reply.status(400).send({ error: 'test_case_id is required' });
      }

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return reply.status(404).send({ error: 'Test plan not found' });
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const testCase = await caseRepo.findById(testCaseId);
      if (!testCase) {
        return reply.status(404).send({ error: 'Test case not found' });
      }

      // Idempotent: re-toggling an already-included case just returns the existing row.
      const existing = await planRepo.getPinnedCase(planId, testCaseId);
      if (existing) {
        return reply.status(200).send(existing);
      }

      const { linkable, latestVersion } = await resolveCaseLinkability(db, plan.project_id, testCaseId);
      if (!latestVersion) {
        return reply.status(422).send({ error: 'Test case has no versions to link' });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyPlanCurationService',
          created_at: now,
        })
        .execute();

      return reply.status(201).send(planCase);
    }
  );

  // DELETE /api/v1/test-plans/:planId/cases/:caseId[?force=true] -- per-case plan-inclusion
  // toggle, OFF. A case with results needs force=true (409 CASE_HAS_RESULTS otherwise, with
  // counts for a confirmation) and is then retired rather than deleted: its results stay in
  // the runs that recorded them; future runs don't include it.
  app.delete(
    '/api/v1/test-plans/:planId/cases/:caseId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { planId, caseId } = request.params as { planId: string; caseId: string };

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return reply.status(404).send({ error: 'Test plan not found' });
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const planCase = await planRepo.getPinnedCase(planId, caseId);
      if (!planCase) {
        return reply.status(404).send({ error: 'Test case is not in this plan' });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyPlanCurationService',
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );

  // POST /api/v1/test-plans/:planId/suites/:suiteId/cascade -- suite-level toggle, cascading
  // to every case in the subtree in one call. ADD skips (and reports) cases that fail the
  // Approved-only rule. REMOVE: if any case has results, nothing changes without
  // force: true (409 CASE_HAS_RESULTS with counts); with it, those cases are retired (their
  // results stay in old runs) and the rest unlinked.
  app.post(
    '/api/v1/test-plans/:planId/suites/:suiteId/cascade',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { planId, suiteId } = request.params as { planId: string; suiteId: string };
      const { action, force } = (request.body as { action?: 'ADD' | 'REMOVE'; force?: boolean }) || {};

      if (action !== 'ADD' && action !== 'REMOVE') {
        return reply.status(400).send({ error: 'action must be ADD or REMOVE' });
      }

      const plan = await planRepo.findById(planId);
      if (!plan) {
        return reply.status(404).send({ error: 'Test plan not found' });
      }
      if (isPlanLockedOrArchived(plan.status)) {
        return sendPlanLockedError(reply, planId, request.url);
      }

      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return reply.status(404).send({ error: 'Test suite not found' });
      }

      const descendants = await suiteRepo.findDescendants(suiteId);
      const suiteIds = [suiteId, ...descendants.map((s) => s.id)];
      const cases = await caseRepo.findBySuiteIds(suiteIds);

      const skipped: Array<{ case_id: string; external_id: string; reason: string }> = [];
      let added = 0;
      let removed = 0;
      let retired = 0;

      if (action === 'ADD') {
        const entries: Array<{ test_case_id: string; test_case_version_id: string }> = [];
        for (const c of cases) {
          const { linkable, latestVersion } = await resolveCaseLinkability(db, plan.project_id, c.id);
          if (!latestVersion) {
            skipped.push({ case_id: c.id, external_id: c.external_id, reason: 'NO_VERSION' });
            continue;
          }
          if (!linkable) {
            skipped.push({ case_id: c.id, external_id: c.external_id, reason: 'NOT_APPROVED' });
            continue;
          }
          entries.push({ test_case_id: c.id, test_case_version_id: latestVersion.id });
        }

        const before = await planRepo.getPinnedCases(planId);
        const beforeIds = new Set(before.map((pc) => pc.test_case_id));
        await planRepo.addCasesBulk(planId, entries);
        added = entries.filter((e) => !beforeIds.has(e.test_case_id)).length;
      } else {
        const outcome = await planRepo.removeCases(planId, cases.map((c) => c.id), actor.id, { force: force === true });
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
          ip_address: '127.0.0.1',
          user_agent: 'TestifyPlanCurationService',
          created_at: now,
        })
        .execute();

      return reply.status(200).send({ added, removed, retired, skipped });
    }
  );
}
