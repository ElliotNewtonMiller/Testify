import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from '@testify/db';
import { TestSuiteRepository, TestCaseRepository, TestCaseVersionRepository, ProjectRepository, CustomFieldRepository, TestPlanRepository } from '@testify/db';
import { findUnsatisfiedRequiredFields } from '@testify/core';
import { requirePermission } from '../middleware/auth.js';
import {
  sendCaseVersionLockedError,
  sendSuiteInUseError,
  sendCaseInUseError,
  sendProblemDetails,
  sendRequiredCustomFieldsMissingError,
} from '../errors.js';

/**
 * Create/edit/delete for Test Suites and Test Cases (including versioned content:
 * summary/preconditions/steps) in Specification mode -- the last major "curation-only"
 * limitation, closed by finally wiring up SPEC_CREATE/SPEC_EDIT/SPEC_APPROVE/SPEC_DELETE,
 * which have sat fully defined and seeded into every default role's bundle since RBAC
 * was built, deliberately unwired until now (see CLAUDE.md).
 *
 * Every mutating route is nested under /api/v1/projects/:projectId/... rather than a
 * flatter path -- authenticateRequest (middleware/auth.ts) resolves project-scoped role
 * overrides from `request.params.projectId`, so a flat path would silently fall back to
 * the caller's global role. Nesting here also lets every handler cheaply verify the
 * target suite/case actually belongs to the URL's project before mutating it.
 */
export async function registerSpecEditingRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const suiteRepo = new TestSuiteRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const versionRepo = new TestCaseVersionRepository(db);
  const projectRepo = new ProjectRepository(db);
  const customFieldRepo = new CustomFieldRepository(db);

  async function insertAuditLog(params: {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    projectId: string;
    diff: Record<string, unknown>;
  }) {
    await db
      .insertInto('audit_logs')
      .values({
        id: uuidv4(),
        actor_id: params.actorId,
        actor_type: 'USER',
        action: params.action,
        resource_type: params.resourceType,
        resource_id: params.resourceId,
        project_id: params.projectId,
        diff: JSON.stringify(params.diff),
        ip_address: '127.0.0.1',
        user_agent: 'TestifySpecEditingService',
        created_at: new Date().toISOString(),
      })
      .execute();
  }

  // ---- Test Suites ----

  app.post(
    '/api/v1/projects/:projectId/test-suites',
    { preHandler: requirePermission('SPEC_CREATE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const { name, description, parent_suite_id: parentSuiteId, position } = (request.body as any) || {};

      if (!name || typeof name !== 'string') {
        return reply.status(400).send({ error: 'name (string) is required' });
      }

      if (parentSuiteId) {
        const parent = await suiteRepo.findById(parentSuiteId);
        if (!parent || parent.project_id !== projectId) {
          return reply.status(400).send({ error: `Parent suite '${parentSuiteId}' not found in this project` });
        }
      }

      const suite = await suiteRepo.create({
        project_id: projectId,
        parent_suite_id: parentSuiteId ?? null,
        name,
        description: description ?? null,
        position,
      });

      await insertAuditLog({
        actorId: actor.id,
        action: 'SUITE_CREATED',
        resourceType: 'test_suite',
        resourceId: suite.id,
        projectId,
        diff: { name, parent_suite_id: parentSuiteId ?? null },
      });

      return reply.status(201).send({ suite });
    }
  );

  app.put(
    '/api/v1/projects/:projectId/test-suites/:suiteId',
    { preHandler: requirePermission('SPEC_EDIT', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, suiteId } = request.params as { projectId: string; suiteId: string };
      const { name, description, position, parent_suite_id: parentSuiteId } = (request.body as any) || {};

      const existing = await suiteRepo.findById(suiteId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test suite not found in this project' });
      }

      if (parentSuiteId !== undefined && parentSuiteId !== existing.parent_suite_id) {
        if (parentSuiteId) {
          const newParent = await suiteRepo.findById(parentSuiteId);
          if (!newParent || newParent.project_id !== projectId) {
            return reply.status(400).send({ error: `Parent suite '${parentSuiteId}' not found in this project` });
          }
        }
        try {
          await suiteRepo.move(suiteId, parentSuiteId ?? null);
        } catch (err: any) {
          return reply.status(400).send({ error: err.message || 'Failed to move suite' });
        }
      }

      const suite = await suiteRepo.update(suiteId, {
        name: typeof name === 'string' ? name : undefined,
        description: description !== undefined ? description : undefined,
        position: typeof position === 'number' ? position : undefined,
      });

      await insertAuditLog({
        actorId: actor.id,
        action: 'SUITE_UPDATED',
        resourceType: 'test_suite',
        resourceId: suiteId,
        projectId,
        diff: { name, description, position, parent_suite_id: parentSuiteId },
      });

      return reply.status(200).send({ suite });
    }
  );

  app.delete(
    '/api/v1/projects/:projectId/test-suites/:suiteId',
    { preHandler: requirePermission('SPEC_DELETE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, suiteId } = request.params as { projectId: string; suiteId: string };
      const { force } = request.query as { force?: string };

      const existing = await suiteRepo.findById(suiteId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test suite not found in this project' });
      }

      const result = await suiteRepo.deleteWithForce(suiteId, { force: force === 'true' }, caseRepo);
      if (!result.deleted) {
        return sendSuiteInUseError(
          reply,
          suiteId,
          {
            subSuites: result.blockedSubSuiteCount,
            cases: result.blockedCaseCount,
            planLinks: result.blockedPlanLinkCount,
            executions: result.blockedExecutionCount,
          },
          request.url,
          existing.name
        );
      }

      await insertAuditLog({
        actorId: actor.id,
        action: 'SUITE_DELETED',
        resourceType: 'test_suite',
        resourceId: suiteId,
        projectId,
        diff: { forced: force === 'true' },
      });

      return reply.status(204).send();
    }
  );

  // ---- Test Cases ----

  app.post(
    '/api/v1/projects/:projectId/test-cases',
    { preHandler: requirePermission('SPEC_CREATE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const {
        test_suite_id: testSuiteId,
        title,
        priority,
        execution_type: executionType,
        summary,
        preconditions,
        steps,
      } = (request.body as any) || {};

      if (!testSuiteId || !title || typeof title !== 'string') {
        return reply.status(400).send({ error: 'test_suite_id and title (string) are required' });
      }

      const suite = await suiteRepo.findById(testSuiteId);
      if (!suite || suite.project_id !== projectId) {
        return reply.status(400).send({ error: `Test suite '${testSuiteId}' not found in this project` });
      }

      const project = await projectRepo.findById(projectId);
      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const externalId = await caseRepo.getNextExternalId(projectId, project.prefix);

      // Two sequential calls, not one shared transaction: TestCaseVersionRepository.create
      // already opens its own transaction internally (for the version+steps insert), and
      // Kysely doesn't support nesting a second .transaction() inside an existing one --
      // matching the same not-atomic-across-repos tradeoff already accepted elsewhere in
      // this codebase (e.g. TestSuiteRepository.deleteWithForce's per-case cascade calls).
      const testCase = await caseRepo.create({
        project_id: projectId,
        test_suite_id: testSuiteId,
        external_id: externalId,
        title,
        priority,
        execution_type: executionType,
      });

      // SYSTEM_ADMIN isn't checked explicitly here -- evaluatePermissions already expands it
      // to the full registry (see CLAUDE.md's "machine API tokens" entry), so any SYSTEM_ADMIN
      // holder's permissions array already contains this key.
      let autoApprove = actor.permissions.includes('SPEC_AUTO_APPROVE');
      if (autoApprove) {
        // A brand-new case has no custom field values yet, so any required TestCase field
        // with no default_value is unconditionally unsatisfied -- don't auto-approve past a
        // requirement the case can't possibly meet at creation time. A required field WITH a
        // default is fine (the default effectively provides the value); an empty `values`
        // array is exactly the right input for "nothing's been recorded yet" (see
        // findUnsatisfiedRequiredFields's own comment).
        const definitions = await customFieldRepo.listVisibleToProject(projectId, 'TestCase');
        if (findUnsatisfiedRequiredFields(definitions, []).length > 0) {
          autoApprove = false;
        }
      }
      const version = await versionRepo.create({
        test_case_id: testCase.id,
        version_number: 1,
        status: autoApprove ? 'APPROVED' : 'DRAFT',
        summary: summary ?? null,
        preconditions: preconditions ?? null,
        author_id: actor.id,
        reviewer_id: autoApprove ? actor.id : null,
        steps: Array.isArray(steps) ? steps : [],
      });

      await insertAuditLog({
        actorId: actor.id,
        action: 'CASE_CREATED',
        resourceType: 'test_case',
        resourceId: testCase.id,
        projectId,
        diff: { external_id: externalId, title, test_suite_id: testSuiteId },
      });

      return reply.status(201).send({ test_case: testCase, version });
    }
  );

  app.put(
    '/api/v1/projects/:projectId/test-cases/:caseId',
    { preHandler: requirePermission('SPEC_EDIT', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, caseId } = request.params as { projectId: string; caseId: string };
      const { title, priority, execution_type: executionType, test_suite_id: testSuiteId } = (request.body as any) || {};

      const existing = await caseRepo.findById(caseId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test case not found in this project' });
      }

      if (testSuiteId) {
        const suite = await suiteRepo.findById(testSuiteId);
        if (!suite || suite.project_id !== projectId) {
          return reply.status(400).send({ error: `Test suite '${testSuiteId}' not found in this project` });
        }
      }

      const testCase = await caseRepo.update(caseId, {
        title: typeof title === 'string' ? title : undefined,
        priority: typeof priority === 'string' ? priority : undefined,
        execution_type: typeof executionType === 'string' ? executionType : undefined,
        test_suite_id: typeof testSuiteId === 'string' ? testSuiteId : undefined,
      });

      await insertAuditLog({
        actorId: actor.id,
        action: 'CASE_UPDATED',
        resourceType: 'test_case',
        resourceId: caseId,
        projectId,
        diff: { title, priority, execution_type: executionType, test_suite_id: testSuiteId },
      });

      return reply.status(200).send({ test_case: testCase });
    }
  );

  app.delete(
    '/api/v1/projects/:projectId/test-cases/:caseId',
    { preHandler: requirePermission('SPEC_DELETE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, caseId } = request.params as { projectId: string; caseId: string };
      const { force } = request.query as { force?: string };

      const existing = await caseRepo.findById(caseId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test case not found in this project' });
      }

      const result = await caseRepo.deleteWithForce(caseId, { force: force === 'true' });
      if (!result.deleted) {
        return sendCaseInUseError(
          reply,
          caseId,
          { planLinks: result.blockedPlanLinkCount, executions: result.blockedExecutionCount },
          request.url
        );
      }

      await insertAuditLog({
        actorId: actor.id,
        action: 'CASE_DELETED',
        resourceType: 'test_case',
        resourceId: caseId,
        projectId,
        diff: { forced: force === 'true' },
      });

      return reply.status(204).send();
    }
  );

  // POST /api/v1/projects/:projectId/spec-move -- drag-and-drop move of suites and/or cases
  // into a suite (or suites to the top level with target_suite_id: null), all-or-nothing in
  // one transaction. Backs Spec mode's multi-select drag; equally usable from the API.
  app.post(
    '/api/v1/projects/:projectId/spec-move',
    { preHandler: requirePermission('SPEC_EDIT', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId } = request.params as { projectId: string };
      const body = (request.body as any) || {};
      const uniqueStrings = (v: unknown) =>
        Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
      const suiteIds = uniqueStrings(body.suite_ids);
      const caseIds = uniqueStrings(body.case_ids);

      if (!('target_suite_id' in body) || (body.target_suite_id !== null && typeof body.target_suite_id !== 'string')) {
        return reply.status(400).send({ error: 'target_suite_id is required (a suite id, or null for the top level)' });
      }
      const targetSuiteId: string | null = body.target_suite_id;
      if (suiteIds.length === 0 && caseIds.length === 0) {
        return reply.status(400).send({ error: 'Nothing to move: provide suite_ids and/or case_ids' });
      }
      if (targetSuiteId === null && caseIds.length > 0) {
        return reply.status(400).send({ error: 'Test cases must be moved into a suite, not to the top level' });
      }

      const target = targetSuiteId
        ? await db.selectFrom('test_suites').selectAll().where('id', '=', targetSuiteId).executeTakeFirst()
        : null;
      if (targetSuiteId && (!target || target.project_id !== projectId)) {
        return reply.status(400).send({ error: `Target suite '${targetSuiteId}' not found in this project` });
      }

      const suites = suiteIds.length
        ? await db.selectFrom('test_suites').selectAll().where('id', 'in', suiteIds).execute()
        : [];
      const cases = caseIds.length
        ? await db.selectFrom('test_cases').selectAll().where('id', 'in', caseIds).execute()
        : [];
      if (suites.length !== suiteIds.length || suites.some((su) => su.project_id !== projectId)) {
        return reply.status(404).send({ error: 'One or more suites were not found in this project' });
      }
      if (cases.length !== caseIds.length || cases.some((c) => c.project_id !== projectId)) {
        return reply.status(404).send({ error: 'One or more test cases were not found in this project' });
      }

      const isWithin = (path: string, ancestorPath: string) => path === ancestorPath || path.startsWith(`${ancestorPath}/`);
      // A selected suite inside another selected suite travels with its ancestor.
      const movingSuites = suites.filter(
        (su) => !suites.some((other) => other.id !== su.id && isWithin(su.path, other.path))
      );
      for (const su of movingSuites) {
        if (target && isWithin(target.path, su.path)) {
          return reply
            .status(400)
            .send({ error: `Can't move suite '${su.name}' into itself or one of its own sub-suites` });
        }
      }
      // A selected case whose suite is moving stays inside that suite.
      const caseSuitePaths = new Map(
        (cases.length
          ? await db
              .selectFrom('test_suites')
              .select(['id', 'path'])
              .where('id', 'in', [...new Set(cases.map((c) => c.test_suite_id))])
              .execute()
          : []
        ).map((r) => [r.id, r.path])
      );
      const movingCases = cases.filter((c) => {
        const path = caseSuitePaths.get(c.test_suite_id) ?? '';
        return !movingSuites.some((su) => isWithin(path, su.path));
      });

      const suitesToMove = movingSuites.filter((su) => su.parent_suite_id !== targetSuiteId);
      const casesToMove = movingCases.filter((c) => c.test_suite_id !== targetSuiteId);

      try {
        await db.transaction().execute(async (trx) => {
          const trxSuiteRepo = new TestSuiteRepository(trx);
          for (const su of suitesToMove) {
            await trxSuiteRepo.move(su.id, targetSuiteId);
          }
          if (casesToMove.length > 0) {
            await trx
              .updateTable('test_cases')
              .set({ test_suite_id: targetSuiteId!, updated_at: new Date().toISOString() })
              .where('id', 'in', casesToMove.map((c) => c.id))
              .execute();
          }
        });
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Failed to move' });
      }

      await insertAuditLog({
        actorId: actor.id,
        action: 'SPEC_ITEMS_MOVED',
        resourceType: 'test_suite',
        resourceId: targetSuiteId ?? 'TOP_LEVEL',
        projectId,
        diff: {
          target_suite_id: targetSuiteId,
          suite_ids: suitesToMove.map((su) => su.id),
          case_ids: casesToMove.map((c) => c.id),
        },
      });

      return reply.status(200).send({ moved_suite_count: suitesToMove.length, moved_case_count: casesToMove.length });
    }
  );

  // ---- Test Case Versions ----

  app.post(
    '/api/v1/projects/:projectId/test-cases/:caseId/versions/draft',
    { preHandler: requirePermission('SPEC_EDIT', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, caseId } = request.params as { projectId: string; caseId: string };

      const existing = await caseRepo.findById(caseId);
      if (!existing || existing.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test case not found in this project' });
      }

      const latest = await versionRepo.findLatestVersion(caseId);
      if (latest && latest.status === 'DRAFT') {
        return reply.status(409).send({ error: 'Latest version is already a DRAFT -- nothing to fork' });
      }
      // A new draft would silently un-deprecate the case -- it has to be restored first.
      if (latest && latest.status === 'DEPRECATED') {
        return reply.status(409).send({ error: 'This test case is deprecated -- restore it before editing' });
      }

      try {
        const version = await versionRepo.createDraftFromLatest(caseId, actor.id);

        await insertAuditLog({
          actorId: actor.id,
          action: 'CASE_DRAFT_CREATED',
          resourceType: 'test_case_version',
          resourceId: version.id,
          projectId,
          diff: { test_case_id: caseId, version_number: version.version_number },
        });

        return reply.status(201).send({ version });
      } catch (err: any) {
        if (err.message?.startsWith('NO_EXISTING_VERSION')) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  app.put(
    '/api/v1/projects/:projectId/test-case-versions/:versionId',
    { preHandler: requirePermission('SPEC_EDIT', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, versionId } = request.params as { projectId: string; versionId: string };
      const { summary, preconditions, steps } = (request.body as any) || {};

      const version = await versionRepo.findById(versionId);
      if (!version) {
        return reply.status(404).send({ error: 'Test case version not found' });
      }
      const owningCase = await caseRepo.findById(version.test_case_id);
      if (!owningCase || owningCase.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test case version not found in this project' });
      }
      if (version.status !== 'DRAFT') {
        return sendCaseVersionLockedError(reply, versionId, request.url);
      }

      if (summary !== undefined || preconditions !== undefined) {
        await versionRepo.updateContent(versionId, { summary, preconditions });
      }
      if (Array.isArray(steps)) {
        await versionRepo.updateSteps(versionId, steps);
      }

      const updated = await versionRepo.findById(versionId);

      await insertAuditLog({
        actorId: actor.id,
        action: 'CASE_VERSION_UPDATED',
        resourceType: 'test_case_version',
        resourceId: versionId,
        projectId,
        diff: { summary, preconditions, step_count: Array.isArray(steps) ? steps.length : undefined },
      });

      return reply.status(200).send({ version: updated });
    }
  );

  app.post(
    '/api/v1/projects/:projectId/test-case-versions/:versionId/approve',
    { preHandler: requirePermission('SPEC_APPROVE', db, jwtSecret) },
    async (request, reply) => {
      const actor = request.user!;
      const { projectId, versionId } = request.params as { projectId: string; versionId: string };

      const version = await versionRepo.findById(versionId);
      if (!version) {
        return reply.status(404).send({ error: 'Test case version not found' });
      }
      const owningCase = await caseRepo.findById(version.test_case_id);
      if (!owningCase || owningCase.project_id !== projectId) {
        return reply.status(404).send({ error: 'Test case version not found in this project' });
      }
      if (version.status !== 'DRAFT') {
        return sendProblemDetails(reply, {
          code: 'VERSION_NOT_DRAFT',
          detail: `Test Case Version (ID: ${versionId}) is not DRAFT (current status: ${version.status}) and cannot be approved.`,
          instance: request.url,
          invalid_params: [{ name: 'version_id', reason: `Status is ${version.status}, not DRAFT` }],
        });
      }

      // Same rule as the auto-approve-on-create gate above, applied to an explicit approve:
      // a case can't be approved while a required custom field (no default_value) still has
      // no value recorded. Values are read project-scoped (global ∪ project-specific
      // definitions), matching how the case's own custom-field-values routes resolve them.
      const definitions = await customFieldRepo.listVisibleToProject(projectId, 'TestCase');
      const values = await customFieldRepo.getValuesForEntity('TestCase', owningCase.id, projectId);
      const unsatisfied = findUnsatisfiedRequiredFields(definitions, values);
      if (unsatisfied.length > 0) {
        return sendRequiredCustomFieldsMissingError(
          reply,
          owningCase.id,
          unsatisfied.map((d) => d.field_label),
          request.url
        );
      }

      // Approve and re-pin together: every ACTIVE plan containing this case moves onto the
      // newly approved version, so Execute mode shows the last approved version rather than
      // whichever one the case happened to have when it was linked. LOCKED/ARCHIVED plans
      // keep their pin (see TestPlanRepository.repinCaseInActivePlans).
      const { approved, repinnedPlanCount } = await db.transaction().execute(async (trx) => {
        const approved = await new TestCaseVersionRepository(trx).updateStatus(versionId, 'APPROVED', actor.id);
        const repinnedPlanCount = await new TestPlanRepository(trx).repinCaseInActivePlans(version.test_case_id, versionId);
        return { approved, repinnedPlanCount };
      });

      await insertAuditLog({
        actorId: actor.id,
        action: 'CASE_VERSION_APPROVED',
        resourceType: 'test_case_version',
        resourceId: versionId,
        projectId,
        diff: { test_case_id: version.test_case_id, repinned_plan_count: repinnedPlanCount },
      });

      return reply.status(200).send({ version: approved, repinned_plan_count: repinnedPlanCount });
    }
  );

  // Deprecate (APPROVED -> DEPRECATED) and Restore (DEPRECATED -> APPROVED). Both act only on
  // a case's LATEST version and are gated on SPEC_APPROVE, like approve. A DRAFT can't be
  // deprecated -- otherwise Restore would turn never-reviewed content into APPROVED. Plans
  // that already contain a deprecated case keep it (with its history); it just can't be newly
  // linked (see resolveCaseLinkability) and is hidden from the spec-tree by default.
  for (const transition of [
    { path: 'deprecate', from: 'APPROVED', to: 'DEPRECATED', action: 'CASE_VERSION_DEPRECATED' },
    { path: 'restore', from: 'DEPRECATED', to: 'APPROVED', action: 'CASE_VERSION_RESTORED' },
  ] as const) {
    app.post(
      `/api/v1/projects/:projectId/test-case-versions/:versionId/${transition.path}`,
      { preHandler: requirePermission('SPEC_APPROVE', db, jwtSecret) },
      async (request, reply) => {
        const actor = request.user!;
        const { projectId, versionId } = request.params as { projectId: string; versionId: string };

        const version = await versionRepo.findById(versionId);
        if (!version) {
          return reply.status(404).send({ error: 'Test case version not found' });
        }
        const owningCase = await caseRepo.findById(version.test_case_id);
        if (!owningCase || owningCase.project_id !== projectId) {
          return reply.status(404).send({ error: 'Test case version not found in this project' });
        }
        const latest = await versionRepo.findLatestVersion(owningCase.id);
        if (!latest || latest.id !== versionId) {
          return sendProblemDetails(reply, {
            code: 'VERSION_NOT_LATEST',
            detail: `Test Case Version (ID: ${versionId}) is not the case's latest version; only the latest version can be ${transition.to === 'DEPRECATED' ? 'deprecated' : 'restored'}.`,
            instance: request.url,
            invalid_params: [{ name: 'version_id', reason: 'Not the latest version' }],
          });
        }
        if (version.status !== transition.from) {
          return sendProblemDetails(reply, {
            code: transition.from === 'APPROVED' ? 'VERSION_NOT_APPROVED' : 'VERSION_NOT_DEPRECATED',
            detail: `Test Case Version (ID: ${versionId}) is ${version.status}, not ${transition.from}, so it cannot be ${transition.to === 'DEPRECATED' ? 'deprecated' : 'restored'}.`,
            instance: request.url,
            invalid_params: [{ name: 'version_id', reason: `Status is ${version.status}, not ${transition.from}` }],
          });
        }

        const updated = await db.transaction().execute(async (trx) => {
          const result = await new TestCaseVersionRepository(trx).updateStatus(versionId, transition.to);
          // Restoring makes this the case's approved version again -- keep active plans on it
          // (normally already the case; harmless no-op then).
          if (transition.to === 'APPROVED') {
            await new TestPlanRepository(trx).repinCaseInActivePlans(owningCase.id, versionId);
          }
          return result;
        });

        await insertAuditLog({
          actorId: actor.id,
          action: transition.action,
          resourceType: 'test_case_version',
          resourceId: versionId,
          projectId,
          diff: { test_case_id: owningCase.id, from: transition.from, to: transition.to },
        });

        return reply.status(200).send({ version: updated });
      }
    );
  }
}
