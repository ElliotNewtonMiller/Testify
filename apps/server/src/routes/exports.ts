import type { FastifyInstance } from 'fastify';
import { withinRateLimit } from '../services/rateLimits.js';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database, TestSuiteNode } from '@testify/db';
import {
  ProjectRepository,
  TestSuiteRepository,
  TestCaseRepository,
  TestCaseVersionRepository,
  TestPlanRepository,
  TestRunRepository,
  TestResultRepository,
  CustomFieldRepository,
  UserRepository,
} from '@testify/db';
import {
  JsonExportSerializer,
  CsvExportSerializer,
  type IFileSerializer,
  type DefinitionsExportBundle,
  type DefinitionsExportScope,
  type ExportableSuite,
  type ExportableCase,
  type TestResultsExportBundle,
  type ExportableTestResult,
} from '@testify/core';
import { requirePermission, authenticateRequest, requireAnyPermission, EXECUTION_READ_PERMISSIONS } from '../middleware/auth.js';
import { requestOrigin } from '../audit.js';

import { sendError } from '../errors.js';
import { listRunsSchema } from '../openapi/areas/projects.js';
function pickSerializer(format: unknown): IFileSerializer {
  return format === 'STANDARD_CSV' ? new CsvExportSerializer() : new JsonExportSerializer();
}

/**
 * Data export -- suite/case definitions and Run execution results, in JSON or CSV.
 * Nested under /api/v1/projects/:projectId/exports/... (not a flat /api/v1/exports/...)
 * so requirePermission resolves the caller's project-scoped EXPORT_DATA the same way
 * apiTokens.ts/specEditing.ts already do, rather than ingestion.ts's ad hoc manual check.
 */
export async function registerExportRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const projectRepo = new ProjectRepository(db);
  const suiteRepo = new TestSuiteRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const versionRepo = new TestCaseVersionRepository(db);
  const planRepo = new TestPlanRepository(db);
  const runRepo = new TestRunRepository(db);
  const resultRepo = new TestResultRepository(db);
  const customFieldRepo = new CustomFieldRepository(db);
  const userRepo = new UserRepository(db);

  // GET /api/v1/plans/:planId/runs -- lightweight listing of a plan's runs (the header's Run
  // picker, the Export modal). No other route returns just a plan's runs (TestRunRepository.findByTestPlan
  // is otherwise only ever called from inside the much heavier GET /api/v1/plans/:planId/cases,
  // which also joins every case + step + latest execution -- too expensive just for a
  // dropdown). Needs SPEC_VIEW on the project, like every other read.
  app.get('/api/v1/plans/:planId/runs', { schema: listRunsSchema, preHandler: requireAnyPermission(EXECUTION_READ_PERMISSIONS, db, jwtSecret) }, async (request, reply) => {
    const { planId } = request.params as { planId: string };
    const projectId = request.projectId ?? '';
    const plan = await db.selectFrom('test_plans').select('project_id').where('id', '=', planId).executeTakeFirst();
    if (!plan || plan.project_id !== projectId) {
      return sendError(reply, 404, 'Test plan not found in this project');
    }
    const runs = await runRepo.findByTestPlan(planId);
    return reply.status(200).send({ runs });
  });

  app.post(
    '/api/v1/projects/:projectId/exports/definitions',
    { preHandler: requirePermission('EXPORT_DATA', db, jwtSecret) },
    async (request, reply) => {
      if (!withinRateLimit(request, reply, app.rateLimits.exports, 'exports')) return reply;
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const { format, scope, status_filter: statusFilterRaw } = (request.body as any) || {};
      const statusFilter: 'ALL' | 'APPROVED_ONLY' = statusFilterRaw === 'APPROVED_ONLY' ? 'APPROVED_ONLY' : 'ALL';

      const project = await projectRepo.findById(projectId);
      if (!project) return sendError(reply, 404, 'Project not found');

      const scopeType = scope?.type === 'SUITE' || scope?.type === 'PLAN' ? scope.type : 'PROJECT';

      let suiteTree: TestSuiteNode[];
      let exportScope: DefinitionsExportScope;
      let caseIdToVersionId: Map<string, string> | null = null; // set only for PLAN scope (pinned versions)

      if (scopeType === 'SUITE') {
        const suiteId = scope.test_suite_id as string;
        const rootSuite = await suiteRepo.findById(suiteId);
        if (!rootSuite || rootSuite.project_id !== projectId) {
          return sendError(reply, 404, `Suite ${suiteId} not found in project ${projectId}`);
        }
        suiteTree = await suiteRepo.getTree(projectId, suiteId);
        exportScope = { type: 'SUITE', test_suite_id: suiteId, suite_name: rootSuite.name };
      } else if (scopeType === 'PLAN') {
        const planId = scope.test_plan_id as string;
        const plan = await planRepo.findById(planId);
        if (!plan || plan.project_id !== projectId) {
          return sendError(reply, 404, `Plan ${planId} not found in project ${projectId}`);
        }
        suiteTree = await suiteRepo.getTree(projectId);
        exportScope = { type: 'PLAN', test_plan_id: planId, plan_name: plan.name };
        const pinned = await planRepo.getPinnedCases(planId);
        caseIdToVersionId = new Map(pinned.map((p) => [p.test_case_id, p.test_case_version_id]));
      } else {
        suiteTree = await suiteRepo.getTree(projectId);
        exportScope = { type: 'PROJECT' };
      }

      // Resolve which cases belong to this scope, and which version of each to export.
      const allCases = await caseRepo.findByProjectWithLatestVersion(projectId);
      let suiteIdsInScope: Set<string> | null = null;
      if (scopeType === 'SUITE') {
        suiteIdsInScope = new Set<string>();
        const collect = (nodes: TestSuiteNode[]) => {
          for (const n of nodes) {
            suiteIdsInScope!.add(n.id);
            collect(n.children);
          }
        };
        collect(suiteTree);
      }

      const scopedCases = allCases.filter((c) => {
        if (suiteIdsInScope && !suiteIdsInScope.has(c.test_suite_id)) return false;
        if (caseIdToVersionId && !caseIdToVersionId.has(c.id)) return false;
        return true;
      });

      // Which version id to actually export per case: pinned (PLAN scope) or latest.
      const versionIdByCaseId = new Map<string, string>();
      for (const c of scopedCases) {
        const pinnedVersionId = caseIdToVersionId?.get(c.id);
        const versionId = pinnedVersionId || c.latest_version?.id;
        if (versionId) versionIdByCaseId.set(c.id, versionId);
      }
      const versionIds = Array.from(new Set(versionIdByCaseId.values()));

      const [versionRows, stepsByVersion, cfValuesByCase] = await Promise.all([
        versionRepo.findByIds(versionIds),
        versionRepo.getStepsForVersions(versionIds),
        customFieldRepo.getValuesForEntities(
          'TestCase',
          scopedCases.map((c) => c.id),
          projectId
        ),
      ]);
      const versionById = new Map(versionRows.map((v) => [v.id, v]));

      const exportableCaseByCaseId = new Map<string, ExportableCase>();
      for (const c of scopedCases) {
        const versionId = versionIdByCaseId.get(c.id);
        const version = versionId ? versionById.get(versionId) : undefined;
        if (!version) continue; // no resolvable version -- skip (shouldn't happen in practice)
        if (statusFilter === 'APPROVED_ONLY' && version.status !== 'APPROVED') continue;

        const steps = (stepsByVersion.get(version.id) || []).map((s) => ({
          id: s.id,
          step_number: s.step_number,
          action: s.action,
          expected_result: s.expected_result,
          execution_type: s.execution_type,
        }));
        const cfValues = (cfValuesByCase.get(c.id) || []).map((entry) => ({
          definition_id: entry.definition.id,
          name: entry.definition.name,
          field_label: entry.definition.field_label,
          field_type: entry.definition.field_type,
          value: entry.value,
        }));

        exportableCaseByCaseId.set(c.id, {
          id: c.id,
          external_id: c.external_id,
          title: c.title,
          priority: c.priority,
          execution_type: c.execution_type,
          version: {
            id: version.id,
            version_number: version.version_number,
            status: version.status,
            summary: version.summary,
            preconditions: version.preconditions,
          },
          steps,
          custom_field_values: cfValues,
        });
      }

      // Run the exportable suite tree, attaching each suite's own cases.
      const casesBySuiteId = new Map<string, ExportableCase[]>();
      for (const c of scopedCases) {
        const exportable = exportableCaseByCaseId.get(c.id);
        if (!exportable) continue;
        const list = casesBySuiteId.get(c.test_suite_id) ?? [];
        list.push(exportable);
        casesBySuiteId.set(c.test_suite_id, list);
      }

      let caseCount = 0;
      let suiteCount = 0;
      const buildExportableSuite = (node: TestSuiteNode): ExportableSuite => {
        suiteCount++;
        const cases = casesBySuiteId.get(node.id) || [];
        caseCount += cases.length;
        return {
          id: node.id,
          name: node.name,
          description: node.description,
          position: node.position,
          cases,
          sub_suites: node.children.map(buildExportableSuite),
        };
      };
      const exportableSuites = suiteTree.map(buildExportableSuite);

      // Full catalog of every custom field definition referenced by any exported case.
      const referencedDefIds = new Set<string>();
      for (const entries of cfValuesByCase.values()) {
        for (const entry of entries) referencedDefIds.add(entry.definition.id);
      }
      const allVisibleDefs = await customFieldRepo.listVisibleToProject(projectId, 'TestCase');
      const customFieldDefinitions = allVisibleDefs
        .filter((d) => referencedDefIds.has(d.id))
        .map((d) => ({
          id: d.id,
          name: d.name,
          field_label: d.field_label,
          field_type: d.field_type,
          options: d.options.map((o) => ({ option_label: o.option_label, option_value: o.option_value })),
        }));

      const bundle: DefinitionsExportBundle = {
        object: 'definitions_export_bundle',
        exported_at: new Date().toISOString(),
        project: { id: project.id, name: project.name, prefix: project.prefix },
        scope: exportScope,
        status_filter: statusFilter,
        custom_field_definitions: customFieldDefinitions,
        suites: exportableSuites,
        record_count: { suite_count: suiteCount, case_count: caseCount },
      };

      const serializer = pickSerializer(format);
      const body = serializer.serializeDefinitions(bundle);

      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: actor.api_token ? 'SERVICE_ACCOUNT' : 'USER',
          action: 'DATA_EXPORTED',
          resource_type: 'project',
          resource_id: projectId,
          project_id: projectId,
          diff: JSON.stringify({ export_kind: 'DEFINITIONS', format: serializer.formatId, scope: exportScope, record_count: bundle.record_count }),
          ...requestOrigin(request),
          created_at: new Date().toISOString(),
        })
        .execute();

      const filename = `testify_definitions_export_${projectId}_${Date.now()}.${serializer.fileExtension}`;
      return reply
        .header('Content-Type', serializer.contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .status(200)
        .send(body);
    }
  );

  app.post(
    '/api/v1/projects/:projectId/exports/results',
    { preHandler: requirePermission('EXPORT_DATA', db, jwtSecret) },
    async (request, reply) => {
      if (!withinRateLimit(request, reply, app.rateLimits.exports, 'exports')) return reply;
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const { format, test_run_id: runId } = (request.body as any) || {};

      const runPlanInfo = await db
        .selectFrom('test_runs')
        .innerJoin('test_plans', 'test_plans.id', 'test_runs.test_plan_id')
        .select([
          'test_runs.id as test_run_id',
          'test_runs.name as run_name',
          'test_runs.status as run_status',
          'test_runs.release_date',
          'test_plans.id as plan_id',
          'test_plans.name as plan_name',
          'test_plans.project_id',
        ])
        .where('test_runs.id', '=', typeof runId === 'string' ? runId : '')
        .executeTakeFirst();

      if (!runPlanInfo || runPlanInfo.project_id !== projectId) {
        return sendError(reply, 404, 'Test run not found in this project', { invalid_params: [{ name: 'test_run_id', reason: 'is not a test run in this project' }] });
      }

      const project = await projectRepo.findById(projectId);
      if (!project) return sendError(reply, 404, 'Project not found');

      const executions = await resultRepo.findByRun(runId);
      const executionIds = executions.map((e) => e.id);
      const stepsByExecution = await resultRepo.getStepResultsForResults(executionIds);

      const planCaseIds = Array.from(new Set(executions.map((e) => e.test_plan_case_id)));
      const planCaseRows =
        planCaseIds.length > 0
          ? await db.selectFrom('test_plan_cases').selectAll().where('id', 'in', planCaseIds).execute()
          : [];
      const planCaseById = new Map(planCaseRows.map((r) => [r.id, r]));

      const caseIds = Array.from(new Set(planCaseRows.map((r) => r.test_case_id)));
      const caseRows = caseIds.length > 0 ? await db.selectFrom('test_cases').selectAll().where('id', 'in', caseIds).execute() : [];
      const caseById = new Map(caseRows.map((r) => [r.id, r]));

      const versionIds = Array.from(new Set(planCaseRows.map((r) => r.test_case_version_id)));
      const versionRows = await versionRepo.findByIds(versionIds);
      const versionById = new Map(versionRows.map((v) => [v.id, v]));

      const allUsers = await userRepo.findAll();
      const usernameById = new Map(allUsers.map((u) => [u.id, u.username]));

      const exportableExecutions: ExportableTestResult[] = executions.map((ex) => {
        const planCase = planCaseById.get(ex.test_plan_case_id);
        const testCase = planCase ? caseById.get(planCase.test_case_id) : undefined;
        const version = planCase ? versionById.get(planCase.test_case_version_id) : undefined;

        let environmentTags: Record<string, unknown> | null = null;
        try {
          const parsed = JSON.parse(ex.environment || '{}');
          environmentTags = parsed && Object.keys(parsed).length > 0 ? parsed : null;
        } catch {
          environmentTags = null;
        }

        const steps = (stepsByExecution.get(ex.id) || []).map((s) => ({
          test_step_id: s.test_step_id,
          step_number: s.step_number,
          verdict: s.verdict,
          actual_result: s.actual_result,
        }));

        return {
          id: ex.id,
          test_case_id: testCase?.id || '',
          test_case_external_id: testCase?.external_id || '',
          test_case_title: testCase?.title || '',
          test_case_version_id: version?.id || '',
          test_case_version_number: version?.version_number || 0,
          tester_id: ex.tester_id,
          tester_username: usernameById.get(ex.tester_id) || null,
          status: ex.status,
          verdict: ex.verdict,
          duration_ms: ex.duration_ms,
          notes: ex.notes,
          executed_at: ex.executed_at,
          environment_tags: environmentTags,
          step_results: steps,
        };
      });

      const bundle: TestResultsExportBundle = {
        object: 'test_results_export_bundle',
        exported_at: new Date().toISOString(),
        project: { id: project.id, name: project.name, prefix: project.prefix },
        plan: { id: runPlanInfo.plan_id, name: runPlanInfo.plan_name },
        run: {
          id: runPlanInfo.test_run_id,
          name: runPlanInfo.run_name,
          status: runPlanInfo.run_status,
          release_date: runPlanInfo.release_date,
        },
        results: exportableExecutions,
        record_count: { result_count: exportableExecutions.length },
      };

      const serializer = pickSerializer(format);
      const body = serializer.serializeTestResults(bundle);

      await db
        .insertInto('audit_logs')
        .values({
          id: uuidv4(),
          actor_id: actor.id,
          actor_type: actor.api_token ? 'SERVICE_ACCOUNT' : 'USER',
          action: 'DATA_EXPORTED',
          resource_type: 'run',
          resource_id: runId,
          project_id: projectId,
          diff: JSON.stringify({
            export_kind: 'TEST_RESULTS',
            format: serializer.formatId,
            test_plan_id: runPlanInfo.plan_id,
            test_run_id: runId,
            record_count: bundle.record_count,
          }),
          ...requestOrigin(request),
          created_at: new Date().toISOString(),
        })
        .execute();

      const filename = `testify_execution_results_${runId}_${Date.now()}.${serializer.fileExtension}`;
      return reply
        .header('Content-Type', serializer.contentType)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .status(200)
        .send(body);
    }
  );
}
