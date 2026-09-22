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
} from '../src/index.js';

describe('Suite/case CRUD: external-id generation, draft versioning, and force-delete cascades', () => {
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

  describe('TestCaseRepository.getNextExternalId', () => {
    it('starts at 1 when no cases exist yet for the prefix', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'ABC' });
      expect(await caseRepo.getNextExternalId(project.id, 'ABC')).toBe('ABC-1');
    });

    it('returns max + 1, ignoring non-numeric-suffix legacy ids', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'ABC' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'ABC-3', title: 'a' });
      await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'ABC-10', title: 'b' });
      await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'ABC-LEGACY-X', title: 'c' });

      expect(await caseRepo.getNextExternalId(project.id, 'ABC')).toBe('ABC-11');
    });

    it('is scoped per project -- another project with the same prefix pattern is unaffected', async () => {
      const projectA = await projectRepo.create({ name: 'A', prefix: 'SHARE' });
      const projectB = await projectRepo.create({ name: 'B', prefix: 'OTHER' });
      const suiteA = await suiteRepo.create({ project_id: projectA.id, name: 'S' });
      await caseRepo.create({ project_id: projectA.id, test_suite_id: suiteA.id, external_id: 'SHARE-5', title: 'a' });

      expect(await caseRepo.getNextExternalId(projectB.id, 'OTHER')).toBe('OTHER-1');
    });
  });

  describe('TestCaseVersionRepository.createDraftFromLatest', () => {
    it('copies summary/preconditions/steps into a new DRAFT version numbered one higher', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'DRF' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const testCase = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'DRF-1', title: 'Case' });
      await versionRepo.create({
        test_case_id: testCase.id,
        version_number: 1,
        status: 'APPROVED',
        summary: 'Original summary',
        preconditions: 'Original preconditions',
        author_id: 'author_1',
        steps: [{ step_number: 1, action: 'Do X', expected_result: 'X happens' }],
      });

      const draft = await versionRepo.createDraftFromLatest(testCase.id, 'author_2');

      expect(draft.version_number).toBe(2);
      expect(draft.status).toBe('DRAFT');
      expect(draft.summary).toBe('Original summary');
      expect(draft.preconditions).toBe('Original preconditions');
      expect(draft.author_id).toBe('author_2');
      expect(draft.steps).toHaveLength(1);
      expect(draft.steps[0].action).toBe('Do X');
      expect(draft.steps[0].id).not.toBe((await versionRepo.findVersionByNumber(testCase.id, 1))!.steps[0].id);
    });

    it('throws NO_EXISTING_VERSION for a case with zero versions', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'NOV' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const testCase = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'NOV-1', title: 'Case' });

      await expect(versionRepo.createDraftFromLatest(testCase.id, 'author_1')).rejects.toThrow('NO_EXISTING_VERSION');
    });
  });

  describe('TestCaseVersionRepository.findByIds / getStepsForVersions (batched, built for export)', () => {
    it('findByIds matches individual findById calls for a set of version ids', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'BAT' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const caseA = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'BAT-A', title: 'A' });
      const caseB = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'BAT-B', title: 'B' });
      const versionA = await versionRepo.create({ test_case_id: caseA.id, version_number: 1, author_id: 'a1', summary: 'Sum A' });
      const versionB = await versionRepo.create({ test_case_id: caseB.id, version_number: 1, author_id: 'a1', summary: 'Sum B' });

      const batched = await versionRepo.findByIds([versionA.id, versionB.id]);
      expect(batched.map((v) => v.id).sort()).toEqual([versionA.id, versionB.id].sort());
      expect(batched.find((v) => v.id === versionA.id)?.summary).toBe('Sum A');

      expect(await versionRepo.findByIds([])).toEqual([]);
    });

    it('getStepsForVersions groups steps per version, matching individual getSteps calls', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'BAT2' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const caseA = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'BAT2-A', title: 'A' });
      const caseB = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'BAT2-B', title: 'B' });
      const versionA = await versionRepo.create({
        test_case_id: caseA.id,
        version_number: 1,
        author_id: 'a1',
        steps: [{ step_number: 1, action: 'A1', expected_result: 'R1' }, { step_number: 2, action: 'A2', expected_result: 'R2' }],
      });
      const versionB = await versionRepo.create({ test_case_id: caseB.id, version_number: 1, author_id: 'a1', steps: [] });

      const stepsMap = await versionRepo.getStepsForVersions([versionA.id, versionB.id]);
      expect(stepsMap.get(versionA.id)).toEqual(await versionRepo.getSteps(versionA.id));
      expect(stepsMap.get(versionA.id)).toHaveLength(2);
      // A version with zero steps has no map entry (nothing to group), matching the
      // "one query, group what exists" batching pattern used elsewhere in this repo.
      expect(stepsMap.has(versionB.id)).toBe(false);

      expect(await versionRepo.getStepsForVersions([])).toEqual(new Map());
    });
  });

  describe('TestCaseVersionRepository.updateContent', () => {
    it('updates summary/preconditions without touching status or steps', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'UPC' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const testCase = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'UPC-1', title: 'Case' });
      const version = await versionRepo.create({
        test_case_id: testCase.id,
        version_number: 1,
        status: 'DRAFT',
        author_id: 'author_1',
        steps: [{ step_number: 1, action: 'A', expected_result: 'B' }],
      });

      const updated = await versionRepo.updateContent(version.id, { summary: 'New summary' });

      expect(updated!.summary).toBe('New summary');
      expect(updated!.status).toBe('DRAFT');
      expect(updated!.steps).toHaveLength(1);
    });
  });

  async function setupCaseWithPlanLinkAndExecution() {
    const project = await projectRepo.create({ name: 'Exec Proj', prefix: 'DEL' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'Suite' });
    const testCase = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'DEL-1', title: 'Case' });
    const version = await versionRepo.create({
      test_case_id: testCase.id,
      version_number: 1,
      status: 'APPROVED',
      author_id: 'author_1',
      steps: [{ step_number: 1, action: 'A', expected_result: 'B' }],
    });
    const plan = await planRepo.create({ project_id: project.id, name: 'Plan' });
    const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });
    const planCase = await planRepo.addCase({
      test_plan_id: plan.id,
      test_case_id: testCase.id,
      test_case_version_id: version.id,
    });
    const execution = await executionRepo.create({
      build_id: build.id,
      test_plan_case_id: planCase.id,
      tester_id: 'tester_1',
      verdict: 'PASSED',
      execution_duration_ms: 100,
      steps: [{ test_step_id: version.steps[0].id, step_number: 1, verdict: 'PASSED' }],
    });
    return { project, suite, testCase, version, plan, build, planCase, execution };
  }

  describe('TestCaseRepository.deleteWithForce', () => {
    it('a case with no plan links deletes immediately', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'FREE' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'S' });
      const testCase = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'FREE-1', title: 'Case' });

      const result = await caseRepo.deleteWithForce(testCase.id);
      expect(result).toEqual({ deleted: true });
      expect(await caseRepo.findById(testCase.id)).toBeUndefined();
    });

    it('without force, blocks with accurate counts and leaves everything untouched', async () => {
      const { testCase, planCase, execution } = await setupCaseWithPlanLinkAndExecution();

      const result = await caseRepo.deleteWithForce(testCase.id);
      expect(result).toEqual({ deleted: false, blockedPlanLinkCount: 1, blockedExecutionCount: 1 });

      expect(await caseRepo.findById(testCase.id)).toBeDefined();
      const stillThere = await db.selectFrom('test_plan_cases').selectAll().where('id', '=', planCase.id).executeTakeFirst();
      expect(stillThere).toBeDefined();
      const execStillThere = await db.selectFrom('executions').selectAll().where('id', '=', execution.id).executeTakeFirst();
      expect(execStillThere).toBeDefined();
    });

    it('with force, deletes the execution, execution_steps, plan-link, case, version, and steps', async () => {
      const { testCase, version, planCase, execution } = await setupCaseWithPlanLinkAndExecution();

      const result = await caseRepo.deleteWithForce(testCase.id, { force: true });
      expect(result).toEqual({ deleted: true });

      expect(await caseRepo.findById(testCase.id)).toBeUndefined();
      expect(await db.selectFrom('test_plan_cases').selectAll().where('id', '=', planCase.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('executions').selectAll().where('id', '=', execution.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('execution_steps').selectAll().where('execution_id', '=', execution.id).execute()).toHaveLength(0);
      expect(await db.selectFrom('test_case_versions').selectAll().where('id', '=', version.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('test_steps').selectAll().where('test_case_version_id', '=', version.id).execute()).toHaveLength(0);
    });

    it('deleting a missing case returns deleted:false with zero counts', async () => {
      const result = await caseRepo.deleteWithForce('does-not-exist');
      expect(result).toEqual({ deleted: false, blockedPlanLinkCount: 0, blockedExecutionCount: 0 });
    });
  });

  describe('TestSuiteRepository.deleteWithForce', () => {
    it('an empty suite with no sub-suites/cases deletes immediately', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'ES' });
      const suite = await suiteRepo.create({ project_id: project.id, name: 'Empty' });

      const result = await suiteRepo.deleteWithForce(suite.id, {}, caseRepo);
      expect(result).toEqual({ deleted: true });
    });

    it('without force, blocks with aggregate counts across the whole subtree and touches nothing', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'SUB' });
      const parent = await suiteRepo.create({ project_id: project.id, name: 'Parent' });
      const child = await suiteRepo.create({ project_id: project.id, name: 'Child', parent_suite_id: parent.id });
      const caseInParent = await caseRepo.create({ project_id: project.id, test_suite_id: parent.id, external_id: 'SUB-1', title: 'In parent' });
      await caseRepo.create({ project_id: project.id, test_suite_id: child.id, external_id: 'SUB-2', title: 'In child' });
      await versionRepo.create({ test_case_id: caseInParent.id, version_number: 1, status: 'DRAFT', author_id: 'a1' });

      const result = await suiteRepo.deleteWithForce(parent.id, {}, caseRepo);
      expect(result).toEqual({
        deleted: false,
        blockedSubSuiteCount: 1,
        blockedCaseCount: 2,
        blockedPlanLinkCount: 0,
        blockedExecutionCount: 0,
      });

      expect(await suiteRepo.findById(parent.id)).toBeDefined();
      expect(await suiteRepo.findById(child.id)).toBeDefined();
    });

    it('with force, recursively deletes sub-suites, cases, plan-links, and executions leaf-to-root', async () => {
      const { project, suite: leafSuite } = await setupCaseWithPlanLinkAndExecution();
      const parent = await suiteRepo.create({ project_id: project.id, name: 'Parent Wrapper' });
      await suiteRepo.move(leafSuite.id, parent.id);
      const grandchild = await suiteRepo.create({ project_id: project.id, name: 'Grandchild', parent_suite_id: leafSuite.id });
      const caseInGrandchild = await caseRepo.create({
        project_id: project.id,
        test_suite_id: grandchild.id,
        external_id: 'GC-1',
        title: 'Deep case',
      });

      const result = await suiteRepo.deleteWithForce(parent.id, { force: true }, caseRepo);
      expect(result).toEqual({ deleted: true });

      expect(await suiteRepo.findById(parent.id)).toBeUndefined();
      expect(await suiteRepo.findById(leafSuite.id)).toBeUndefined();
      expect(await suiteRepo.findById(grandchild.id)).toBeUndefined();
      expect(await caseRepo.findById(caseInGrandchild.id)).toBeUndefined();
    });

    it('deleting a missing suite returns deleted:false with zero counts', async () => {
      const result = await suiteRepo.deleteWithForce('does-not-exist', {}, caseRepo);
      expect(result).toEqual({ deleted: false, blockedSubSuiteCount: 0, blockedCaseCount: 0, blockedPlanLinkCount: 0, blockedExecutionCount: 0 });
    });
  });

  describe('TestPlanRepository.deleteWithForce', () => {
    it('an empty plan with no builds/plan-links deletes immediately', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'EP' });
      const plan = await planRepo.create({ project_id: project.id, name: 'Empty Plan' });

      const result = await planRepo.deleteWithForce(plan.id);
      expect(result).toEqual({ deleted: true });
      expect(await planRepo.findById(plan.id)).toBeUndefined();
    });

    it('without force, blocks with accurate counts and leaves everything untouched', async () => {
      const { plan, build, planCase, execution } = await setupCaseWithPlanLinkAndExecution();

      const result = await planRepo.deleteWithForce(plan.id);
      expect(result).toEqual({ deleted: false, blockedBuildCount: 1, blockedCaseLinkCount: 1, blockedExecutionCount: 1 });

      expect(await planRepo.findById(plan.id)).toBeDefined();
      expect(await buildRepo.findById(build.id)).toBeDefined();
      const stillThere = await db.selectFrom('test_plan_cases').selectAll().where('id', '=', planCase.id).executeTakeFirst();
      expect(stillThere).toBeDefined();
      const execStillThere = await db.selectFrom('executions').selectAll().where('id', '=', execution.id).executeTakeFirst();
      expect(execStillThere).toBeDefined();
    });

    it('with force, deletes executions, execution_steps, builds, plan-links, and the plan itself', async () => {
      const { plan, build, planCase, execution } = await setupCaseWithPlanLinkAndExecution();

      const result = await planRepo.deleteWithForce(plan.id, { force: true });
      expect(result).toEqual({ deleted: true });

      expect(await planRepo.findById(plan.id)).toBeUndefined();
      expect(await buildRepo.findById(build.id)).toBeUndefined();
      expect(await db.selectFrom('test_plan_cases').selectAll().where('id', '=', planCase.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('executions').selectAll().where('id', '=', execution.id).executeTakeFirst()).toBeUndefined();
      expect(await db.selectFrom('execution_steps').selectAll().where('execution_id', '=', execution.id).execute()).toHaveLength(0);
    });

    it('a plan with a build but no pinned cases still blocks on the build alone', async () => {
      const project = await projectRepo.create({ name: 'P', prefix: 'BLD' });
      const plan = await planRepo.create({ project_id: project.id, name: 'Plan' });
      const build = await buildRepo.create({ test_plan_id: plan.id, name: 'Build 1' });

      const result = await planRepo.deleteWithForce(plan.id);
      expect(result).toEqual({ deleted: false, blockedBuildCount: 1, blockedCaseLinkCount: 0, blockedExecutionCount: 0 });

      const forced = await planRepo.deleteWithForce(plan.id, { force: true });
      expect(forced).toEqual({ deleted: true });
      expect(await buildRepo.findById(build.id)).toBeUndefined();
    });

    it('deleting a missing plan returns deleted:false with zero counts', async () => {
      const result = await planRepo.deleteWithForce('does-not-exist');
      expect(result).toEqual({ deleted: false, blockedBuildCount: 0, blockedCaseLinkCount: 0, blockedExecutionCount: 0 });
    });
  });
});
