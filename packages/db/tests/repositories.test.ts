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
  AuditLogRepository,
} from '../src/index.js';

describe('Repositories', () => {
  let db: Kysely<Database>;
  let projectRepo: ProjectRepository;
  let suiteRepo: TestSuiteRepository;
  let caseRepo: TestCaseRepository;
  let versionRepo: TestCaseVersionRepository;
  let planRepo: TestPlanRepository;
  let buildRepo: BuildRepository;
  let executionRepo: ExecutionRepository;
  let auditLogRepo: AuditLogRepository;

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
    auditLogRepo = new AuditLogRepository(db);
  });

  afterEach(async () => {
    try {
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  it('ProjectRepository CRUD operations', async () => {
    // Create
    const project = await projectRepo.create({
      name: 'Auth Platform',
      prefix: 'AUTH',
      description: 'Authentication and Security Services',
      settings: { allow_draft_plan_linking: true },
    });
    expect(project.id).toBeDefined();
    expect(project.name).toBe('Auth Platform');
    expect(project.prefix).toBe('AUTH');
    expect(JSON.parse(project.settings)).toEqual({ allow_draft_plan_linking: true });

    // Find by ID & Prefix
    const foundById = await projectRepo.findById(project.id);
    expect(foundById?.name).toBe('Auth Platform');

    const foundByPrefix = await projectRepo.findByPrefix('AUTH');
    expect(foundByPrefix?.id).toBe(project.id);

    // List All
    const all = await projectRepo.findAll();
    expect(all).toHaveLength(1);

    // Update
    const updated = await projectRepo.update(project.id, {
      name: 'Auth Core Engine',
      settings: { allow_draft_plan_linking: false },
    });
    expect(updated?.name).toBe('Auth Core Engine');
    expect(JSON.parse(updated!.settings)).toEqual({ allow_draft_plan_linking: false });

    // Delete
    const deleted = await projectRepo.delete(project.id);
    expect(deleted).toBe(true);
    expect(await projectRepo.findById(project.id)).toBeUndefined();
  });

  it('TestSuiteRepository materialized path & recursive tree retrieval', async () => {
    const project = await projectRepo.create({ name: 'Suite Test Proj', prefix: 'STP' });

    // Create Root Suites
    const root1 = await suiteRepo.create({
      project_id: project.id,
      name: 'Backend API',
      position: 1,
    });
    expect(root1.path).toBe(`/${root1.id}`);

    const root2 = await suiteRepo.create({
      project_id: project.id,
      name: 'Frontend UI',
      position: 2,
    });
    expect(root2.path).toBe(`/${root2.id}`);

    // Create Nested Subsuites
    const child1 = await suiteRepo.create({
      project_id: project.id,
      parent_suite_id: root1.id,
      name: 'Auth Endpoints',
      position: 1,
    });
    expect(child1.path).toBe(`/${root1.id}/${child1.id}`);

    const grandchild1 = await suiteRepo.create({
      project_id: project.id,
      parent_suite_id: child1.id,
      name: 'OAuth2 Tokens',
      position: 1,
    });
    expect(grandchild1.path).toBe(`/${root1.id}/${child1.id}/${grandchild1.id}`);

    // Test findChildren & findDescendants
    const childrenOfRoot1 = await suiteRepo.findChildren(root1.id);
    expect(childrenOfRoot1).toHaveLength(1);
    expect(childrenOfRoot1[0].name).toBe('Auth Endpoints');

    const descendantsOfRoot1 = await suiteRepo.findDescendants(root1.id);
    expect(descendantsOfRoot1).toHaveLength(2);
    expect(descendantsOfRoot1.map((s) => s.name)).toEqual(['Auth Endpoints', 'OAuth2 Tokens']);

    // Test getTree
    const tree = await suiteRepo.getTree(project.id);
    expect(tree).toHaveLength(2); // root1 and root2
    expect(tree[0].name).toBe('Backend API');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].name).toBe('Auth Endpoints');
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].name).toBe('OAuth2 Tokens');

    // Test Suite Move (Move child1 under root2)
    const movedChild1 = await suiteRepo.move(child1.id, root2.id);
    expect(movedChild1.parent_suite_id).toBe(root2.id);
    expect(movedChild1.path).toBe(`/${root2.id}/${child1.id}`);

    // Verify descendant grandchild1 path updated automatically
    const updatedGrandchild1 = await suiteRepo.findById(grandchild1.id);
    expect(updatedGrandchild1?.path).toBe(`/${root2.id}/${child1.id}/${grandchild1.id}`);

    // Verify tree after move
    const newTree = await suiteRepo.getTree(project.id);
    expect(newTree[0].children).toHaveLength(0); // root1 has no children now
    expect(newTree[1].children).toHaveLength(1); // root2 has child1 now
  });

  it('TestCase & TestCaseVersion repositories with steps', async () => {
    const project = await projectRepo.create({ name: 'Case Proj', prefix: 'CASE' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'Login Suite' });

    // Create Case
    const testCase = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suite.id,
      external_id: 'CASE-101',
      title: 'Valid Login via SSO',
      priority: 'HIGH',
      execution_type: 'MANUAL',
    });
    expect(testCase.external_id).toBe('CASE-101');

    // Create Version 1 (DRAFT) with steps
    const v1 = await versionRepo.create({
      test_case_id: testCase.id,
      version_number: 1,
      status: 'DRAFT',
      summary: 'Basic SSO check',
      author_id: 'user_01',
      steps: [
        { step_number: 1, action: 'Navigate to login', expected_result: 'Login page loads' },
        { step_number: 2, action: 'Click SSO', expected_result: 'Redirected to IDP' },
      ],
    });
    expect(v1.version_number).toBe(1);
    expect(v1.steps).toHaveLength(2);

    // Approve Version 1
    const approvedV1 = await versionRepo.updateStatus(v1.id, 'APPROVED', 'user_lead');
    expect(approvedV1?.status).toBe('APPROVED');
    expect(approvedV1?.reviewer_id).toBe('user_lead');

    // Create Version 2
    await versionRepo.create({
      test_case_id: testCase.id,
      version_number: 2,
      status: 'DRAFT',
      summary: 'Updated SSO check with PKCE',
      author_id: 'user_02',
    });

    const latest = await versionRepo.findLatestVersion(testCase.id);
    expect(latest?.version_number).toBe(2);

    const stepsV1 = await versionRepo.getSteps(v1.id);
    expect(stepsV1).toHaveLength(2);
  });

  it('TestPlan & Build & Execution end-to-end workflow', async () => {
    const project = await projectRepo.create({ name: 'Exec Proj', prefix: 'EXEC' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'Main Suite' });
    const testCase = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suite.id,
      external_id: 'EXEC-1',
      title: 'System Integration Test',
    });

    const version = await versionRepo.create({
      test_case_id: testCase.id,
      version_number: 1,
      status: 'APPROVED',
      author_id: 'lead_01',
      steps: [
        { step_number: 1, action: 'Step A', expected_result: 'Pass A' },
      ],
    });

    // Create Plan & Build
    const plan = await planRepo.create({
      project_id: project.id,
      name: 'Sprint 1 Plan',
    });

    const build = await buildRepo.create({
      test_plan_id: plan.id,
      name: 'v1.0-rc1',
    });

    // Pin Case to Plan
    const planCase = await planRepo.addCase({
      test_plan_id: plan.id,
      test_case_id: testCase.id,
      test_case_version_id: version.id,
      assigned_user_id: 'tester_01',
      custom_fields_snapshot: { env: 'staging' },
    });
    expect(planCase.test_case_version_id).toBe(version.id);

    // Record Single Execution
    const exec = await executionRepo.create({
      build_id: build.id,
      test_plan_case_id: planCase.id,
      tester_id: 'tester_01',
      verdict: 'PASSED',
      execution_duration_ms: 500,
      notes: 'Executed cleanly',
      steps: [
        {
          test_step_id: version.steps[0].id,
          step_number: 1,
          verdict: 'PASSED',
          actual_result: 'Pass A confirmed',
        },
      ],
    });

    expect(exec.verdict).toBe('PASSED');
    expect(exec.steps).toHaveLength(1);

    const latestExec = await executionRepo.getLatestExecutionForPlanCase(build.id, planCase.id);
    expect(latestExec?.id).toBe(exec.id);

    // Record Batch Executions (CI/CD ingestion)
    const batchExecs = await executionRepo.createBatch([
      {
        build_id: build.id,
        test_plan_case_id: planCase.id,
        tester_id: 'ci_bot',
        verdict: 'PASSED',
        execution_duration_ms: 120,
      },
      {
        build_id: build.id,
        test_plan_case_id: planCase.id,
        tester_id: 'ci_bot',
        verdict: 'FAILED',
        execution_duration_ms: 300,
        notes: 'Retry failed',
      },
    ]);

    expect(batchExecs).toHaveLength(2);

    const allExecsForBuild = await executionRepo.findByBuild(build.id);
    expect(allExecsForBuild).toHaveLength(3); // 1 manual + 2 batch
  });

  it('TestCaseRepository.findByProjectWithLatestVersion / findBySuiteIds', async () => {
    const project = await projectRepo.create({ name: 'Spec Proj', prefix: 'SPEC' });
    const suiteA = await suiteRepo.create({ project_id: project.id, name: 'Suite A' });
    const suiteB = await suiteRepo.create({ project_id: project.id, name: 'Suite B' });

    const caseApproved = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suiteA.id,
      external_id: 'SPEC-1',
      title: 'Approved case',
    });
    await versionRepo.create({
      test_case_id: caseApproved.id,
      version_number: 1,
      status: 'APPROVED',
      author_id: 'user_01',
    });

    const caseDraft = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suiteB.id,
      external_id: 'SPEC-2',
      title: 'Draft-only case',
    });
    await versionRepo.create({
      test_case_id: caseDraft.id,
      version_number: 1,
      status: 'DRAFT',
      author_id: 'user_01',
    });
    // A second, later version -- findByProjectWithLatestVersion must pick this one, not v1.
    await versionRepo.create({
      test_case_id: caseDraft.id,
      version_number: 2,
      status: 'IN_REVIEW',
      author_id: 'user_01',
    });

    const withVersions = await caseRepo.findByProjectWithLatestVersion(project.id);
    expect(withVersions).toHaveLength(2);
    const approvedResult = withVersions.find((c) => c.id === caseApproved.id);
    const draftResult = withVersions.find((c) => c.id === caseDraft.id);
    expect(approvedResult?.latest_version?.status).toBe('APPROVED');
    expect(approvedResult?.latest_version?.version_number).toBe(1);
    expect(draftResult?.latest_version?.status).toBe('IN_REVIEW');
    expect(draftResult?.latest_version?.version_number).toBe(2);

    const casesInA = await caseRepo.findBySuiteIds([suiteA.id]);
    expect(casesInA.map((c) => c.id)).toEqual([caseApproved.id]);

    const casesInBoth = await caseRepo.findBySuiteIds([suiteA.id, suiteB.id]);
    expect(casesInBoth).toHaveLength(2);

    expect(await caseRepo.findBySuiteIds([])).toEqual([]);
  });

  it('TestPlanRepository.addCasesBulk / removeCasesBulk', async () => {
    const project = await projectRepo.create({ name: 'Cascade Proj', prefix: 'CASC' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'Cascade Suite' });
    const plan = await planRepo.create({ project_id: project.id, name: 'Cascade Plan' });

    const cases = [];
    for (let i = 0; i < 3; i++) {
      const c = await caseRepo.create({
        project_id: project.id,
        test_suite_id: suite.id,
        external_id: `CASC-${i}`,
        title: `Case ${i}`,
      });
      const v = await versionRepo.create({
        test_case_id: c.id,
        version_number: 1,
        status: 'APPROVED',
        author_id: 'user_01',
      });
      cases.push({ case: c, version: v });
    }

    // Bulk add all 3
    const added = await planRepo.addCasesBulk(
      plan.id,
      cases.map((c) => ({ test_case_id: c.case.id, test_case_version_id: c.version.id }))
    );
    expect(added).toHaveLength(3);
    expect(await planRepo.getPinnedCases(plan.id)).toHaveLength(3);

    // Idempotent: re-adding the same entries + one new one only inserts the new one
    const fourthCase = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suite.id,
      external_id: 'CASC-3',
      title: 'Case 3',
    });
    const fourthVersion = await versionRepo.create({
      test_case_id: fourthCase.id,
      version_number: 1,
      status: 'APPROVED',
      author_id: 'user_01',
    });
    await planRepo.addCasesBulk(plan.id, [
      ...cases.map((c) => ({ test_case_id: c.case.id, test_case_version_id: c.version.id })),
      { test_case_id: fourthCase.id, test_case_version_id: fourthVersion.id },
    ]);
    expect(await planRepo.getPinnedCases(plan.id)).toHaveLength(4);

    // Bulk remove 2 of the 4
    const removedCount = await planRepo.removeCasesBulk(plan.id, [cases[0].case.id, cases[1].case.id]);
    expect(removedCount).toBe(2);
    expect(await planRepo.getPinnedCases(plan.id)).toHaveLength(2);

    // Empty-array calls are no-ops
    expect(await planRepo.addCasesBulk(plan.id, [])).toEqual([]);
    expect(await planRepo.removeCasesBulk(plan.id, [])).toBe(0);
  });

  it('AuditLogRepository append-only logging & query', async () => {
    const project = await projectRepo.create({ name: 'Audit Proj', prefix: 'AUDIT' });

    const log1 = await auditLogRepo.create({
      actor_id: 'user_admin',
      actor_type: 'USER',
      action: 'PROJECT_CREATE',
      resource_type: 'project',
      resource_id: project.id,
      project_id: project.id,
      diff: { name: 'Audit Proj' },
    });
    expect(log1.id).toBeDefined();

    await auditLogRepo.create({
      actor_id: 'user_admin',
      actor_type: 'USER',
      action: 'SPEC_EDIT',
      resource_type: 'test_case',
      resource_id: 'case_123',
      project_id: project.id,
    });

    const logsForProject = await auditLogRepo.findByProject(project.id);
    expect(logsForProject).toHaveLength(2);

    const logsForActor = await auditLogRepo.findByActor('user_admin');
    expect(logsForActor).toHaveLength(2);
  });
});
