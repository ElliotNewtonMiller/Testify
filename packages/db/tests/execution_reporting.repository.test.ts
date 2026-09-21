import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';
import {
  ProjectRepository,
  TestSuiteRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
  BuildRepository,
  ExecutionRepository,
} from '../src/repositories/index.js';

// This is the first aggregation code (window functions, groupBy/avg/sum) in this
// repository -- these tests hand-seed small, fully-known datasets so the aggregation
// math itself is provably correct, not just "doesn't throw".
describe('ExecutionRepository reporting aggregates', () => {
  let db: Kysely<Database>;
  let projectRepo: ProjectRepository;
  let suiteRepo: TestSuiteRepository;
  let caseRepo: TestCaseRepository;
  let versionRepo: TestCaseVersionRepository;
  let planRepo: TestPlanRepository;
  let buildRepo: BuildRepository;
  let executionRepo: ExecutionRepository;

  beforeEach(async () => {
    db = createDbClient();
    await initialSchema.up(db);

    projectRepo = new ProjectRepository(db);
    suiteRepo = new TestSuiteRepository(db);
    caseRepo = new TestCaseRepository(db);
    versionRepo = new TestCaseVersionRepository(db);
    planRepo = new TestPlanRepository(db);
    buildRepo = new BuildRepository(db);
    executionRepo = new ExecutionRepository(db);
  });

  afterEach(async () => {
    try {
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  async function makePlanWithTwoCases() {
    const project = await projectRepo.create({ name: 'Report Proj', prefix: 'REP' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'Suite A' });
    const caseA = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'REP-A', title: 'Case A' });
    const caseB = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'REP-B', title: 'Case B' });
    const versionA = await versionRepo.create({ test_case_id: caseA.id, version_number: 1, author_id: 'a1' });
    const versionB = await versionRepo.create({ test_case_id: caseB.id, version_number: 1, author_id: 'a1' });
    const plan = await planRepo.create({ project_id: project.id, name: 'Plan 1' });
    const planCaseA = await planRepo.addCase({ test_plan_id: plan.id, test_case_id: caseA.id, test_case_version_id: versionA.id });
    const planCaseB = await planRepo.addCase({ test_plan_id: plan.id, test_case_id: caseB.id, test_case_version_id: versionB.id });
    return { project, suite, caseA, caseB, plan, planCaseA, planCaseB };
  }

  describe('getLatestExecutionsForPlanAcrossBuilds', () => {
    it('returns the latest execution per (build, plan_case), and an untested row when none exists', async () => {
      const { plan, caseA, caseB, planCaseA, planCaseB } = await makePlanWithTwoCases();
      const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });

      // caseA: two executions in this build -- the later one (by execution_timestamp) must win.
      await executionRepo.create({
        build_id: build.id,
        test_plan_case_id: planCaseA.id,
        tester_id: 'tester1',
        verdict: 'FAILED',
        execution_timestamp: '2026-01-01T00:00:00.000Z',
      });
      await executionRepo.create({
        build_id: build.id,
        test_plan_case_id: planCaseA.id,
        tester_id: 'tester1',
        verdict: 'PASSED',
        execution_timestamp: '2026-01-02T00:00:00.000Z',
      });
      // caseB: no executions in this build at all -- must come back UNTESTED (all-null).

      const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(plan.id, [build.id]);
      expect(rows).toHaveLength(2);

      const rowA = rows.find((r) => r.plan_case_id === planCaseA.id)!;
      expect(rowA.verdict).toBe('PASSED');
      expect(rowA.test_case_id).toBe(caseA.id);
      expect(rowA.build_id).toBe(build.id);

      const rowB = rows.find((r) => r.plan_case_id === planCaseB.id)!;
      expect(rowB.verdict).toBeNull();
      expect(rowB.execution_id).toBeNull();
      expect(rowB.test_case_id).toBe(caseB.id);
    });

    it('tie-breaks on created_at when two executions share the same execution_timestamp', async () => {
      const { plan, planCaseA } = await makePlanWithTwoCases();
      const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });
      const sameTimestamp = '2026-01-01T00:00:00.000Z';

      // created_at is server-generated at insert time, so inserting sequentially gives the
      // second insert a later created_at even with an identical execution_timestamp.
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'FAILED', execution_timestamp: sameTimestamp });
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED', execution_timestamp: sameTimestamp });

      const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(plan.id, [build.id]);
      const rowA = rows.find((r) => r.plan_case_id === planCaseA.id)!;
      expect(rowA.verdict).toBe('PASSED');
    });

    it('scopes correctly across multiple builds and returns [] for an empty buildIds array', async () => {
      const { plan, planCaseA } = await makePlanWithTwoCases();
      const build1 = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });
      const build2 = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 2' });

      await executionRepo.create({ build_id: build1.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'FAILED' });
      await executionRepo.create({ build_id: build2.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED' });

      const rows = await executionRepo.getLatestExecutionsForPlanAcrossBuilds(plan.id, [build1.id, build2.id]);
      expect(rows.find((r) => r.build_id === build1.id && r.plan_case_id === planCaseA.id)?.verdict).toBe('FAILED');
      expect(rows.find((r) => r.build_id === build2.id && r.plan_case_id === planCaseA.id)?.verdict).toBe('PASSED');

      expect(await executionRepo.getLatestExecutionsForPlanAcrossBuilds(plan.id, [])).toEqual([]);
    });
  });

  describe('getAverageDurationByPlanCase', () => {
    it('averages only non-null durations, excluding a null-duration execution from both the average and the sample count', async () => {
      const { plan, planCaseA } = await makePlanWithTwoCases();
      const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });

      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED', execution_duration_ms: 100 });
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED', execution_duration_ms: 300 });
      // No execution_duration_ms supplied -- stored as null, must not drag the average down.
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED' });

      const rows = await executionRepo.getAverageDurationByPlanCase(plan.id);
      const rowA = rows.find((r) => r.plan_case_id === planCaseA.id)!;
      expect(rowA.sample_count).toBe(2);
      expect(rowA.avg_duration_ms).toBe(200);
    });

    it('a plan case with zero executions produces no row at all', async () => {
      const { plan } = await makePlanWithTwoCases();
      const rows = await executionRepo.getAverageDurationByPlanCase(plan.id);
      expect(rows).toEqual([]);
    });
  });

  describe('getVerdictVolatility', () => {
    it('counts verdict changes across a known sequence, scoped to a build', async () => {
      const { plan, planCaseA, planCaseB } = await makePlanWithTwoCases();
      const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });

      // caseA: FAILED -> PASSED -> FAILED = 2 changes across 3 executions.
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'FAILED', execution_timestamp: '2026-01-01T00:00:00.000Z' });
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED', execution_timestamp: '2026-01-02T00:00:00.000Z' });
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'FAILED', execution_timestamp: '2026-01-03T00:00:00.000Z' });

      // caseB: PASSED -> PASSED = 0 changes across 2 executions (stable).
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseB.id, tester_id: 't1', verdict: 'PASSED', execution_timestamp: '2026-01-01T00:00:00.000Z' });
      await executionRepo.create({ build_id: build.id, test_plan_case_id: planCaseB.id, tester_id: 't1', verdict: 'PASSED', execution_timestamp: '2026-01-02T00:00:00.000Z' });

      const rows = await executionRepo.getVerdictVolatility({ type: 'BUILD', buildId: build.id });

      const rowA = rows.find((r) => r.plan_case_id === planCaseA.id)!;
      expect(rowA.total_executions).toBe(3);
      expect(rowA.verdict_changes).toBe(2);

      const rowB = rows.find((r) => r.plan_case_id === planCaseB.id)!;
      expect(rowB.total_executions).toBe(2);
      expect(rowB.verdict_changes).toBe(0);
    });

    it('PLAN scope aggregates volatility across every build in the plan', async () => {
      const { plan, planCaseA } = await makePlanWithTwoCases();
      const build1 = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });
      const build2 = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 2' });

      await executionRepo.create({ build_id: build1.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'FAILED', execution_timestamp: '2026-01-01T00:00:00.000Z' });
      await executionRepo.create({ build_id: build2.id, test_plan_case_id: planCaseA.id, tester_id: 't1', verdict: 'PASSED', execution_timestamp: '2026-01-02T00:00:00.000Z' });

      const rows = await executionRepo.getVerdictVolatility({ type: 'PLAN', planId: plan.id });
      const rowA = rows.find((r) => r.plan_case_id === planCaseA.id)!;
      expect(rowA.total_executions).toBe(2);
      expect(rowA.verdict_changes).toBe(1);
    });
  });
});
