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

// Hand-seeded, fully-known datasets so the window functions and aggregates behind the
// reports are provably correct, not just "doesn't throw".
describe('ExecutionRepository reporting queries', () => {
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
    return { project, suite, caseA, caseB, versionA, plan, planCaseA, planCaseB };
  }

  /** Inserts an execution row directly, so created_at can be pinned for tie-break tests. */
  async function insertExecution(row: {
    id: string;
    build_id: string;
    test_plan_case_id: string;
    verdict: string;
    ts: string;
    created_at?: string;
    duration?: number | null;
    failure_message?: string | null;
    source?: string | null;
  }) {
    await db
      .insertInto('executions')
      .values({
        id: row.id,
        build_id: row.build_id,
        test_plan_case_id: row.test_plan_case_id,
        tester_id: 'tester-1',
        verdict: row.verdict,
        execution_duration_ms: row.duration ?? null,
        notes: null,
        failure_message: row.failure_message ?? null,
        source: row.source ?? 'API',
        execution_timestamp: row.ts,
        created_at: row.created_at ?? row.ts,
        updated_at: row.ts,
      })
      .execute();
  }

  describe('getFinalResultsForRuns', () => {
    it('returns the final result per (run, case) for several runs, with attempts and pass/fail flags', async () => {
      const { plan, planCaseA, planCaseB, caseA, caseB } = await makePlanWithTwoCases();
      const run1 = await buildRepo.create({ test_plan_id: plan.id, name: 'R1' });
      const run2 = await buildRepo.create({ test_plan_id: plan.id, name: 'R2' });

      // Run 1: A failed, then passed on retry. B passed.
      await insertExecution({ id: 'e1', build_id: run1.id, test_plan_case_id: planCaseA.id, verdict: 'FAILED', ts: '2026-01-01T10:00:00.000Z', failure_message: 'boom' });
      await insertExecution({ id: 'e2', build_id: run1.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts: '2026-01-01T10:05:00.000Z', duration: 120 });
      await insertExecution({ id: 'e3', build_id: run1.id, test_plan_case_id: planCaseB.id, verdict: 'PASSED', ts: '2026-01-01T10:00:00.000Z' });
      // Run 2: A blocked. B untested.
      await insertExecution({ id: 'e4', build_id: run2.id, test_plan_case_id: planCaseA.id, verdict: 'BLOCKED', ts: '2026-01-02T10:00:00.000Z', failure_message: 'env down' });

      const rows = await executionRepo.getFinalResultsForRuns(plan.id, [run1.id, run2.id]);
      expect(rows).toHaveLength(4); // 2 runs x 2 plan cases, in runIds order
      expect(rows.map((r) => r.run_id)).toEqual([run1.id, run1.id, run2.id, run2.id]);

      const r1a = rows.find((r) => r.run_id === run1.id && r.test_case_id === caseA.id)!;
      expect(r1a).toMatchObject({ execution_id: 'e2', verdict: 'PASSED', execution_duration_ms: 120, attempts: 2, had_pass: true, had_fail: true });

      const r2a = rows.find((r) => r.run_id === run2.id && r.test_case_id === caseA.id)!;
      expect(r2a).toMatchObject({ verdict: 'BLOCKED', failure_message: 'env down', attempts: 1, had_pass: false, had_fail: true });

      const r2b = rows.find((r) => r.run_id === run2.id && r.test_case_id === caseB.id)!;
      expect(r2b).toMatchObject({ execution_id: null, verdict: null, attempts: 0, had_pass: false, had_fail: false });
    });

    it('breaks a same-timestamp tie by created_at', async () => {
      const { plan, planCaseA, caseA } = await makePlanWithTwoCases();
      const run = await buildRepo.create({ test_plan_id: plan.id, name: 'R1' });
      const ts = '2026-01-01T10:00:00.000Z';
      await insertExecution({ id: 'later', build_id: run.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts, created_at: '2026-01-01T10:00:02.000Z' });
      await insertExecution({ id: 'earlier', build_id: run.id, test_plan_case_id: planCaseA.id, verdict: 'FAILED', ts, created_at: '2026-01-01T10:00:01.000Z' });

      const rows = await executionRepo.getFinalResultsForRuns(plan.id, [run.id]);
      expect(rows.find((r) => r.test_case_id === caseA.id)).toMatchObject({ execution_id: 'later', verdict: 'PASSED' });
    });

    it('returns nothing for no runs', async () => {
      const { plan } = await makePlanWithTwoCases();
      expect(await executionRepo.getFinalResultsForRuns(plan.id, [])).toEqual([]);
    });
  });

  describe('case history', () => {
    it('lists a case\'s executions across plans newest first, keyset-paginated, plus a whole-history timeline', async () => {
      const { project, plan, planCaseA, caseA, versionA } = await makePlanWithTwoCases();
      const run1 = await buildRepo.create({ test_plan_id: plan.id, name: 'R1' });
      const otherPlan = await planRepo.create({ project_id: project.id, name: 'Plan 2' });
      const otherPlanCase = await planRepo.addCase({ test_plan_id: otherPlan.id, test_case_id: caseA.id, test_case_version_id: versionA.id });
      const run2 = await buildRepo.create({ test_plan_id: otherPlan.id, name: 'Other R1' });

      await insertExecution({ id: 'h1', build_id: run1.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts: '2026-01-01T10:00:00.000Z' });
      await insertExecution({ id: 'h2', build_id: run2.id, test_plan_case_id: otherPlanCase.id, verdict: 'FAILED', ts: '2026-01-02T10:00:00.000Z', failure_message: 'x' });
      await insertExecution({ id: 'h3', build_id: run1.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts: '2026-01-03T10:00:00.000Z', source: 'UI' });

      const page1 = await executionRepo.getCaseHistory(caseA.id, { limit: 2 });
      expect(page1.rows.map((r) => r.execution_id)).toEqual(['h3', 'h2']);
      expect(page1.rows[1]).toMatchObject({ plan_name: 'Plan 2', run_name: 'Other R1', version_number: 1, failure_message: 'x' });
      expect(page1.next_cursor).toBeTruthy();

      const page2 = await executionRepo.getCaseHistory(caseA.id, { limit: 2, cursor: page1.next_cursor });
      expect(page2.rows.map((r) => r.execution_id)).toEqual(['h1']);
      expect(page2.next_cursor).toBeNull();

      const timeline = await executionRepo.getCaseVerdictTimeline(caseA.id);
      expect(timeline.map((t) => t.verdict)).toEqual(['PASSED', 'FAILED', 'PASSED']);
    });
  });

  describe('staleness and activity', () => {
    it('last executed time per case, and results per day by source', async () => {
      const { project, plan, planCaseA, caseA, caseB } = await makePlanWithTwoCases();
      const run = await buildRepo.create({ test_plan_id: plan.id, name: 'R1' });
      await insertExecution({ id: 'a1', build_id: run.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts: '2026-03-01T10:00:00.000Z', source: 'API' });
      await insertExecution({ id: 'a2', build_id: run.id, test_plan_case_id: planCaseA.id, verdict: 'FAILED', ts: '2026-03-02T09:00:00.000Z', source: 'UI' });
      await insertExecution({ id: 'a3', build_id: run.id, test_plan_case_id: planCaseA.id, verdict: 'PASSED', ts: '2026-03-02T11:00:00.000Z', source: 'UI' });

      const last = await executionRepo.getLastExecutedAtByCase(project.id);
      expect(last.get(caseA.id)).toBe('2026-03-02T11:00:00.000Z');
      expect(last.has(caseB.id)).toBe(false);

      const activity = await executionRepo.getActivity(project.id, '2026-03-01T00:00:00.000Z');
      expect(activity).toEqual([
        { day: '2026-03-01', source: 'API', count: 1 },
        { day: '2026-03-02', source: 'UI', count: 2 },
      ]);
      expect(await executionRepo.getActivity(project.id, '2026-03-02T00:00:00.000Z')).toEqual([{ day: '2026-03-02', source: 'UI', count: 2 }]);
    });
  });
});
