import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { ProjectRepository, TestSuiteRepository, TestPlanRepository, BuildRepository, ExecutionRepository } from '@testify/db';
import { computeFlakinessScores, computeTrendPoints, KNOWN_VERDICTS } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';

const DEFAULT_TREND_LIMIT = 10;
const MAX_TREND_LIMIT = 50;
const DEFAULT_TEST_HEALTH_LIMIT = 10;

/**
 * Read-only aggregate reporting over a project's execution/coverage data -- verdict
 * breakdown, execution trend across builds, per-suite coverage, and slowest/flakiest
 * tests. Nested under /api/v1/projects/:projectId/reports/... (matching apiTokens.ts/
 * exports.ts's convention) so requirePermission resolves project-scoped overrides.
 * Gated on SPEC_VIEW -- already the broadest "can see this project's data" permission,
 * held by all 5 default roles including Viewer -- deliberately a stricter, real
 * enforcement than Spec mode's own still-open read routes, not a retrofit onto them.
 */
export async function registerReportRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const suiteRepo = new TestSuiteRepository(db);
  const planRepo = new TestPlanRepository(db);
  const buildRepo = new BuildRepository(db);
  const executionRepo = new ExecutionRepository(db);

  async function resolveBuild(projectId: string, buildId: string) {
    const build = await buildRepo.findById(buildId);
    if (!build) return null;
    const plan = await planRepo.findById(build.test_plan_id);
    if (!plan || plan.project_id !== projectId) return null;
    return { build, plan };
  }

  async function resolvePlan(projectId: string, planId: string) {
    const plan = await planRepo.findById(planId);
    if (!plan || plan.project_id !== projectId) return null;
    return plan;
  }

  async function resolveCaseLabels(testCaseIds: string[]): Promise<Map<string, { external_id: string; title: string }>> {
    if (testCaseIds.length === 0) return new Map();
    const rows = await db.selectFrom('test_cases').select(['id', 'external_id', 'title']).where('id', 'in', testCaseIds).execute();
    return new Map(rows.map((r) => [r.id, { external_id: r.external_id, title: r.title }]));
  }

  // GET .../reports/verdict-breakdown?build_id=
  app.get(
    '/api/v1/projects/:projectId/reports/verdict-breakdown',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { build_id: buildId } = request.query as { build_id?: string };
      if (!buildId) return reply.status(400).send({ error: 'build_id is required' });

      const resolved = await resolveBuild(projectId, buildId);
      if (!resolved) return reply.status(404).send({ error: `Build ${buildId} not found in project ${projectId}` });

      const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(resolved.plan.id, [buildId]);
      const breakdown: Record<string, number> = { PASSED: 0, FAILED: 0, BLOCKED: 0, SKIPPED: 0, UNTESTED: 0, OTHER: 0 };
      for (const row of rows) {
        if (row.verdict === null) breakdown.UNTESTED++;
        else if (KNOWN_VERDICTS.has(row.verdict)) breakdown[row.verdict]++;
        else breakdown.OTHER++;
      }

      return reply.status(200).send({
        build: { id: resolved.build.id, name: resolved.build.name, plan_id: resolved.plan.id, plan_name: resolved.plan.name },
        total_cases: rows.length,
        breakdown,
      });
    }
  );

  // GET .../reports/trend?plan_id=&limit=
  app.get(
    '/api/v1/projects/:projectId/reports/trend',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { plan_id: planId, limit: limitRaw } = request.query as { plan_id?: string; limit?: string };
      if (!planId) return reply.status(400).send({ error: 'plan_id is required' });

      const plan = await resolvePlan(projectId, planId);
      if (!plan) return reply.status(404).send({ error: `Plan ${planId} not found in project ${projectId}` });

      const limit = Math.min(Math.max(parseInt(limitRaw || '', 10) || DEFAULT_TREND_LIMIT, 1), MAX_TREND_LIMIT);

      const recentBuilds = (await buildRepo.findByTestPlan(planId)).slice(0, limit).reverse(); // oldest first for the chart's x-axis
      const buildIds = recentBuilds.map((b) => b.id);

      const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(planId, buildIds);
      const trendRows = rows.map((r) => ({ build_id: r.build_id, verdict: r.verdict }));
      const buildMeta = recentBuilds.map((b) => ({ build_id: b.id, build_name: b.name, release_date: b.release_date }));

      const points = computeTrendPoints(trendRows, buildMeta);

      return reply.status(200).send({ plan: { id: plan.id, name: plan.name }, builds: points });
    }
  );

  // GET .../reports/coverage?plan_id=
  app.get(
    '/api/v1/projects/:projectId/reports/coverage',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { plan_id: planId } = request.query as { plan_id?: string };
      if (!planId) return reply.status(400).send({ error: 'plan_id is required' });

      const plan = await resolvePlan(projectId, planId);
      if (!plan) return reply.status(404).send({ error: `Plan ${planId} not found in project ${projectId}` });

      const suites = await suiteRepo.getCoverageByPlan(projectId, planId);

      return reply.status(200).send({ plan: { id: plan.id, name: plan.name }, suites });
    }
  );

  // GET .../reports/test-health?scope_type=BUILD|PLAN&scope_id=&limit=
  app.get(
    '/api/v1/projects/:projectId/reports/test-health',
    { preHandler: requirePermission('SPEC_VIEW', db, jwtSecret) },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { scope_type: scopeType, scope_id: scopeId, limit: limitRaw } = request.query as {
        scope_type?: string;
        scope_id?: string;
        limit?: string;
      };
      if (scopeType !== 'BUILD' && scopeType !== 'PLAN') {
        return reply.status(400).send({ error: "scope_type must be 'BUILD' or 'PLAN'" });
      }
      if (!scopeId) return reply.status(400).send({ error: 'scope_id is required' });

      const limit = Math.max(parseInt(limitRaw || '', 10) || DEFAULT_TEST_HEALTH_LIMIT, 1);

      let planId: string;
      let slowest: Array<{ test_case_id: string; duration_ms: number }>;
      let volatilityRows: Awaited<ReturnType<typeof executionRepo.getVerdictVolatility>>;

      if (scopeType === 'BUILD') {
        const resolved = await resolveBuild(projectId, scopeId);
        if (!resolved) return reply.status(404).send({ error: `Build ${scopeId} not found in project ${projectId}` });
        planId = resolved.plan.id;

        const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(planId, [scopeId]);
        slowest = rows
          .filter((r) => r.execution_duration_ms !== null)
          .map((r) => ({ test_case_id: r.test_case_id, duration_ms: r.execution_duration_ms as number }))
          .sort((a, b) => b.duration_ms - a.duration_ms)
          .slice(0, limit);

        volatilityRows = await executionRepo.getVerdictVolatility({ type: 'BUILD', buildId: scopeId });
      } else {
        const plan = await resolvePlan(projectId, scopeId);
        if (!plan) return reply.status(404).send({ error: `Plan ${scopeId} not found in project ${projectId}` });
        planId = plan.id;

        const avgRows = await executionRepo.getAverageDurationByPlanCase(planId);
        slowest = avgRows
          .map((r) => ({ test_case_id: r.test_case_id, duration_ms: Math.round(r.avg_duration_ms) }))
          .sort((a, b) => b.duration_ms - a.duration_ms)
          .slice(0, limit);

        volatilityRows = await executionRepo.getVerdictVolatility({ type: 'PLAN', planId });
      }

      const flakiest = computeFlakinessScores(volatilityRows).slice(0, limit);

      const caseIds = Array.from(new Set([...slowest.map((s) => s.test_case_id), ...flakiest.map((f) => f.test_case_id)]));
      const labels = await resolveCaseLabels(caseIds);

      return reply.status(200).send({
        scope: { type: scopeType, id: scopeId },
        slowest_tests: slowest.map((s) => ({
          test_case_id: s.test_case_id,
          external_id: labels.get(s.test_case_id)?.external_id ?? '',
          title: labels.get(s.test_case_id)?.title ?? '',
          duration_ms: s.duration_ms,
        })),
        flakiest_tests: flakiest.map((f) => ({
          test_case_id: f.test_case_id,
          external_id: labels.get(f.test_case_id)?.external_id ?? '',
          title: labels.get(f.test_case_id)?.title ?? '',
          total_executions: f.total_executions,
          verdict_changes: f.verdict_changes,
          flakiness_rate: f.flakiness_rate,
        })),
      });
    }
  );
}
